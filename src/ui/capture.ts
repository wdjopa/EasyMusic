// Écoute de l'audio de l'onglet (partage d'onglet) pour analyser une vidéo lue dans le lecteur intégré.

export function tabCaptureSupported(): boolean {
  // pas dans les apps (Tauri) : la vue web n'y capture pas le son d'un onglet, et l'app télécharge elle-même
  if ('__TAURI_INTERNALS__' in window) return false;
  return !!navigator.mediaDevices?.getDisplayMedia && !/Mobi|Android/i.test(navigator.userAgent);
}

const WORKLET = `
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      this.port.postMessage(input.map((ch) => ch.slice(0)));
    }
    return true;
  }
}
registerProcessor('easymusic-recorder', Recorder);
`;

export interface TabRecorder {
  sampleRate: number;
  /** Active/désactive l'enregistrement (on n'enregistre que pendant la lecture). */
  setRecording(on: boolean): void;
  /** Nombre de secondes enregistrées. */
  duration(): number;
  /** Copie des canaux enregistrés jusqu'ici. */
  snapshot(): Float32Array[];
  /** Niveau sonore récent (0..1), pour vérifier que l'audio arrive. */
  level(): number;
  stop(): Float32Array[];
  onEnded?: () => void;
}

/**
 * Demande à l'utilisateur de partager l'onglet (avec son audio) et enregistre le son.
 * L'utilisateur continue d'entendre la vidéo normalement.
 */
export async function startTabRecorder(): Promise<TabRecorder> {
  // certaines options ne sont connues que de Chrome/Edge : on les passe sans vérification de type
  const options = {
    video: true, // obligatoire pour Chrome ; la piste vidéo est arrêtée aussitôt
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false, // continuer à entendre l'onglet
    },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    systemAudio: 'include',
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  const audioTracks = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Aucun son partagé : choisissez cet onglet et cochez « Partager aussi l'audio de l'onglet ».");
  }

  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  const node = new AudioWorkletNode(ctx, 'easymusic-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
  src.connect(node);

  const chunks: Float32Array[][] = [];
  let length = 0;
  let recording = false;
  let lvl = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array[]>) => {
    const chans = e.data;
    let peak = 0;
    for (const v of chans[0]) peak = Math.max(peak, Math.abs(v));
    lvl = Math.max(peak, lvl * 0.97);
    if (!recording) return;
    chunks.push(chans.length === 1 ? [chans[0], chans[0]] : [chans[0], chans[1]]);
    length += chans[0].length;
  };

  const merge = (): Float32Array[] => {
    const out = [new Float32Array(length), new Float32Array(length)];
    let o = 0;
    for (const c of chunks) {
      out[0].set(c[0], o);
      out[1].set(c[1], o);
      o += c[0].length;
    }
    return out;
  };

  const rec: TabRecorder = {
    sampleRate: ctx.sampleRate,
    setRecording: (on) => (recording = on),
    duration: () => length / ctx.sampleRate,
    snapshot: merge,
    level: () => lvl,
    stop() {
      recording = false;
      node.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      return merge();
    },
  };
  // l'utilisateur peut arrêter le partage depuis la barre du navigateur
  audioTracks[0].addEventListener('ended', () => rec.onEnded?.());
  return rec;
}

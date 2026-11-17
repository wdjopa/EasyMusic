import { analyzeLiveFrame, type LiveFrame, type PracticeMode } from '../dsp/live';
import type { Key } from '../music/theory';

export interface PracticeSession {
  stop(): void;
}

/**
 * Écoute le micro (sans traitement : pas d'annulation d'écho ni de réduction de bruit,
 * qui abîment le son des instruments) et analyse un bloc toutes les ~120 ms.
 */
export async function startPractice(
  mode: () => PracticeMode,
  key: () => Key | undefined,
  onFrame: (f: LiveFrame) => void,
): Promise<PracticeSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    const m = mode();
    // la voix n'a besoin que d'un bloc court (réactivité), l'accord d'un bloc long (précision)
    onFrame(analyzeLiveFrame(m === 'voice' ? buf.subarray(buf.length - 4096) : buf, ctx.sampleRate, m, key()));
  }, 120);
  return {
    stop() {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

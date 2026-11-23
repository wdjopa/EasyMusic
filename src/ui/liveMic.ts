// Micro sur le haut-parleur : la voix captée par le micro ressort en direct par la sortie audio (enceinte),
// mélangée à la musique, avec un réglage de volume et une réverbération. Tout se passe sur l'appareil.

/** Mots qui trahissent une sortie sans fil (Bluetooth, AirPlay) : trop de retard pour s'entendre chanter. */
const WIRELESS = /bluetooth|airpods|airplay|\bbt\b|jbl|bose|beats|sony wh|sony wf|soundcore|marshall|ue boom|galaxy buds|pixel buds/i;

/** Réponse impulsionnelle synthétique : bruit qui décroît (salle de taille moyenne). */
function impulse(ctx: AudioContext, seconds = 1.8, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export interface LiveMicInfo {
  /** Retard estimé entre la voix et sa sortie (ms), si le navigateur le donne. */
  latencyMs: number | null;
  /** Sortie audio probablement sans fil (Bluetooth, AirPlay). */
  wireless: boolean;
  /** Nom de la sortie audio, si connu. */
  output: string;
}

export class LiveMic {
  private ctx: AudioContext;
  private stream: MediaStream;
  private voice: GainNode;
  private wet: GainNode;
  private meter: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx;
    this.stream = stream;
    const src = ctx.createMediaStreamSource(stream);
    // grondements et souffle en dessous de 90 Hz retirés (proximité du micro, manipulations)
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    // compresseur doux : la voix garde un niveau régulier, sans saturer l'enceinte
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    this.voice = ctx.createGain();
    this.voice.gain.value = 0.8;
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.25;
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 1024;
    this.buf = new Float32Array(this.meter.fftSize);
    src.connect(hp).connect(comp).connect(this.voice);
    this.voice.connect(ctx.destination); // voix directe
    this.voice.connect(reverb).connect(this.wet).connect(ctx.destination); // réverbération
    this.voice.connect(this.meter);
  }

  /** Ouvre le micro et commence à renvoyer la voix vers la sortie audio. */
  static async start(): Promise<LiveMic> {
    // aucun traitement du navigateur : l'annulation d'écho couperait la voix quand la musique joue,
    // et la latence la plus faible possible est demandée
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } as MediaTrackConstraints,
    });
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return new LiveMic(ctx, stream);
  }

  setVolume(v: number) {
    this.voice.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }
  setReverb(v: number) {
    this.wet.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Niveau de la voix (0..1), pour l'indicateur. */
  level(): number {
    this.meter.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const x of this.buf) s += x * x;
    return Math.min(1, Math.sqrt(s / this.buf.length) * 4);
  }

  async info(): Promise<LiveMicInfo> {
    const lat = (this.ctx.baseLatency ?? 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0);
    let output = '';
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const out = devices.filter((d) => d.kind === 'audiooutput');
      output = (out.find((d) => d.deviceId === 'default') ?? out[0])?.label ?? '';
    } catch {
      /* liste des sorties indisponible */
    }
    const latencyMs = lat > 0 ? Math.round(lat * 1000) : null;
    return { latencyMs, output, wireless: WIRELESS.test(output) || (latencyMs !== null && latencyMs > 120) };
  }

  stop() {
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}

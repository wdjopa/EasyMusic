import { yin } from '../dsp/yin';
import { freqToMidi } from '../music/theory';

export interface MicSession {
  stop: () => number[]; // renvoie les fréquences stables relevées
}

/**
 * Écoute le micro et appelle onPitch à chaque note détectée.
 * Seules les hauteurs stables (tenues ~150 ms) sont conservées.
 */
export async function startMic(onPitch: (freq: number | null) => void): Promise<MicSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const stable: number[] = [];
  const recent: { t: number; m: number; f: number }[] = [];
  let raf = 0;

  const loop = () => {
    analyser.getFloatTimeDomainData(buf);
    const r = yin(buf, ctx.sampleRate, 70, 1100, 0.15);
    const now = performance.now();
    if (r && r.probability > 0.85) {
      const m = freqToMidi(r.freq);
      recent.push({ t: now, m, f: r.freq });
      while (recent.length && now - recent[0].t > 150) recent.shift();
      const spread = Math.max(...recent.map((x) => x.m)) - Math.min(...recent.map((x) => x.m));
      if (recent.length >= 4 && spread < 0.8) stable.push(r.freq);
      onPitch(r.freq);
    } else {
      recent.length = 0;
      onPitch(null);
    }
    raf = requestAnimationFrame(loop);
  };
  loop();

  return {
    stop() {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      return stable;
    },
  };
}

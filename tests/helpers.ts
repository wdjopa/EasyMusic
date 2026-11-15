import { fft, hann } from '../src/dsp/fft';
import { QUALITY_INTERVALS, type ChordQuality, midiToFreq } from '../src/music/theory';

/** Synthétise un son riche en harmoniques (type piano/guitare simplifié). */
export function tone(out: Float32Array, sr: number, freq: number, start: number, dur: number, amp = 0.15) {
  const s0 = Math.floor(start * sr);
  const n = Math.floor(dur * sr);
  for (let i = 0; i < n && s0 + i < out.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t * 50) * Math.exp(-t * 1.2);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * freq * h * t) / (h * h * 0.7 + 0.3);
    out[s0 + i] += amp * env * v;
  }
}

export function synthChords(
  seq: { root: number; quality: ChordQuality }[],
  secondsEach: number,
  sr = 22050,
): Float32Array {
  const out = new Float32Array(Math.ceil(seq.length * secondsEach * sr));
  seq.forEach((c, idx) => {
    const t0 = idx * secondsEach;
    // basse
    tone(out, sr, midiToFreq(36 + c.root), t0, secondsEach, 0.2);
    for (const iv of QUALITY_INTERVALS[c.quality]) tone(out, sr, midiToFreq(48 + c.root + iv), t0, secondsEach);
    // rejouer l'accord à mi-durée (rythme)
    for (const iv of QUALITY_INTERVALS[c.quality]) tone(out, sr, midiToFreq(60 + c.root + iv), t0 + secondsEach / 2, secondsEach / 2, 0.1);
  });
  return out;
}

export function dominantFreq(x: Float32Array, sr: number): number {
  // pic du spectre (FFT) avec interpolation parabolique
  const n = 16384;
  const start = Math.floor(x.length / 2 - n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = x[start + i] * w[i];
  fft(re, im);
  let k = 1;
  for (let j = 1; j < n / 2; j++) if (Math.hypot(re[j], im[j]) > Math.hypot(re[k], im[k])) k = j;
  const m = (j: number) => Math.log(Math.hypot(re[j], im[j]));
  const p = (0.5 * (m(k - 1) - m(k + 1))) / (m(k - 1) - 2 * m(k) + m(k + 1));
  return ((k + p) * sr) / n;
}

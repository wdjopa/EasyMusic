import { fft, hann } from './fft';
import { resampleCubic } from './resample';

const TWO_PI = 2 * Math.PI;
const wrap = (p: number) => p - TWO_PI * Math.round(p / TWO_PI);

/**
 * Étirement temporel par vocodeur de phase avec verrouillage de phase
 * (« identity phase locking », Laroche & Dolson) pour limiter l'effet « phasé ».
 */
export function timeStretch(x: Float32Array, factor: number, fftSize = 4096, analysisHop = 1024): Float32Array {
  const N = fftSize;
  const Ha = analysisHop;
  const Hs = Math.round(Ha * factor);
  const realFactor = Hs / Ha;
  const bins = N / 2 + 1;
  const w = hann(N);
  const nFrames = Math.ceil((x.length + N) / Ha);
  const outLen = Math.ceil(nFrames * Hs + N);
  const out = new Float64Array(outLen);
  const norm = new Float64Array(outLen);

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(bins);
  const phase = new Float64Array(bins);
  const prevPhase = new Float64Array(bins);
  const synthPhase = new Float64Array(bins);
  const omega = new Float64Array(bins);
  for (let k = 0; k < bins; k++) omega[k] = (TWO_PI * k * Ha) / N;
  const isPeak = new Uint8Array(bins);
  const peakOf = new Int32Array(bins);

  for (let f = 0; f < nFrames; f++) {
    const start = f * Ha - N; // pré-remplissage pour couvrir le début
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < x.length ? x[idx] * w[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }
    if (f === 0) {
      synthPhase.set(phase);
    } else {
      // pics spectraux
      isPeak.fill(0);
      for (let k = 2; k < bins - 2; k++) {
        const m = mag[k];
        if (m > mag[k - 1] && m > mag[k - 2] && m >= mag[k + 1] && m >= mag[k + 2]) isPeak[k] = 1;
      }
      // chaque bin est rattaché au pic le plus proche (frontière au minimum entre pics)
      let lastPeak = -1;
      for (let k = 0; k < bins; k++) {
        if (isPeak[k]) {
          if (lastPeak >= 0) {
            let minK = lastPeak;
            for (let j = lastPeak; j <= k; j++) if (mag[j] < mag[minK]) minK = j;
            for (let j = minK; j < k; j++) peakOf[j] = k;
          } else for (let j = 0; j < k; j++) peakOf[j] = k;
          peakOf[k] = k;
          lastPeak = k;
        } else peakOf[k] = lastPeak;
      }
      const prevSynth = Float64Array.from(synthPhase);
      for (let k = 0; k < bins; k++) {
        if (!isPeak[k]) continue;
        const delta = wrap(phase[k] - prevPhase[k] - omega[k]);
        synthPhase[k] = prevSynth[k] + (omega[k] + delta) * realFactor;
      }
      for (let k = 0; k < bins; k++) {
        const p = peakOf[k];
        if (p < 0) {
          const delta = wrap(phase[k] - prevPhase[k] - omega[k]);
          synthPhase[k] = prevSynth[k] + (omega[k] + delta) * realFactor;
        } else if (p !== k) {
          synthPhase[k] = synthPhase[p] + (phase[k] - phase[p]);
        }
      }
    }
    prevPhase.set(phase);
    for (let k = 0; k < bins; k++) {
      re[k] = mag[k] * Math.cos(synthPhase[k]);
      im[k] = mag[k] * Math.sin(synthPhase[k]);
    }
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft(re, im, true);
    const oStart = f * Hs;
    for (let i = 0; i < N; i++) {
      out[oStart + i] += (re[i] / N) * w[i];
      norm[oStart + i] += w[i] * w[i];
    }
  }
  // retirer le pré-remplissage (N échantillons d'entrée -> N*factor en sortie)
  const offset = Math.round(N * realFactor);
  const len = Math.round(x.length * realFactor);
  const res = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const j = i + offset;
    res[i] = j < outLen && norm[j] > 1e-6 ? out[j] / norm[j] : 0;
  }
  return res;
}

/** Transpose de `semitones` demi-tons sans changer la durée. */
export function pitchShift(x: Float32Array, semitones: number): Float32Array {
  if (semitones === 0) return x.slice();
  const ratio = Math.pow(2, semitones / 12);
  const stretched = timeStretch(x, ratio);
  return resampleCubic(stretched, stretched.length / x.length, x.length);
}

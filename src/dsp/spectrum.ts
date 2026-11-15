import { fft, hann } from './fft';

export interface Spectrogram {
  /** Magnitudes, une Float32Array (taille N/2+1) par trame. */
  frames: Float32Array[];
  sampleRate: number;
  fftSize: number;
  hop: number;
}

export function stft(x: Float32Array, sampleRate: number, fftSize = 4096, hop = 2048): Spectrogram {
  const w = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const frames: Float32Array[] = [];
  const bins = fftSize / 2 + 1;
  for (let start = 0; start + fftSize <= x.length || (start === 0 && x.length > 0); start += hop) {
    for (let i = 0; i < fftSize; i++) {
      const s = start + i < x.length ? x[start + i] : 0;
      re[i] = s * w[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]);
    frames.push(mag);
    if (start + fftSize >= x.length) break;
  }
  return { frames, sampleRate, fftSize, hop };
}

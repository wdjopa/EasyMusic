import { freqToMidi } from '../music/theory';
import type { Spectrogram } from './spectrum';

/**
 * Chromagramme : énergie par classe de hauteur (12 valeurs) pour chaque trame.
 * On ne garde que les pics spectraux (réduction du bruit / des percussions)
 * dans la plage fMin–fMax, avec une compression logarithmique.
 */
export function chromagram(spec: Spectrogram, fMin = 55, fMax = 2000): Float32Array[] {
  return pitchClassProfile(spec, fMin, fMax);
}

/** Chroma de la basse (40–220 Hz) : aide à identifier la fondamentale de l'accord. */
export function bassChromagram(spec: Spectrogram): Float32Array[] {
  return pitchClassProfile(spec, 40, 220);
}

function pitchClassProfile(spec: Spectrogram, fMin: number, fMax: number): Float32Array[] {
  const { frames, sampleRate, fftSize } = spec;
  const binHz = sampleRate / fftSize;
  const kMin = Math.max(2, Math.floor(fMin / binHz));
  const kMax = Math.min(fftSize / 2 - 1, Math.ceil(fMax / binHz));
  return frames.map((mag) => {
    const c = new Float32Array(12);
    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k];
      if (m <= mag[k - 1] || m < mag[k + 1]) continue; // pics uniquement
      // interpolation parabolique de la fréquence du pic
      const a = Math.log(mag[k - 1] + 1e-12);
      const b = Math.log(m + 1e-12);
      const g = Math.log(mag[k + 1] + 1e-12);
      const denom = a - 2 * b + g;
      const p = denom !== 0 ? (0.5 * (a - g)) / denom : 0;
      const f = (k + p) * binHz;
      const midi = freqToMidi(f);
      const nearest = Math.round(midi);
      const dev = Math.abs(midi - nearest);
      if (dev > 0.4) continue;
      const weight = Math.cos((dev / 0.4) * (Math.PI / 2)) ** 2;
      c[((nearest % 12) + 12) % 12] += m * m * weight;
    }
    for (let i = 0; i < 12; i++) c[i] = Math.sqrt(c[i]);
    return c;
  });
}

export function frameEnergy(chroma: Float32Array[]): Float32Array {
  return Float32Array.from(chroma, (c) => c.reduce((s, v) => s + v, 0));
}

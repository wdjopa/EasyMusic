import type { Key } from '../music/theory';

// Profils de Krumhansl-Kessler
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** Estime la tonalité à partir de la moyenne du chromagramme. */
export function detectKey(chroma: Float32Array[]): Key & { score: number } {
  const avg = new Array(12).fill(0);
  for (const c of chroma) {
    const s = c.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < 12; i++) avg[i] += c[i] / s;
  }
  let best: Key & { score: number } = { tonic: 0, mode: 'major', score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = avg.map((_, i) => avg[(i + tonic) % 12]);
    const cm = corr(rotated, MAJOR);
    const cn = corr(rotated, MINOR);
    if (cm > best.score) best = { tonic, mode: 'major', score: cm };
    if (cn > best.score) best = { tonic, mode: 'minor', score: cn };
  }
  return best;
}

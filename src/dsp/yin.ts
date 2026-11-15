/**
 * Détection de fréquence fondamentale par l'algorithme YIN (de Cheveigné & Kawahara).
 * Retourne la fréquence (Hz) et une probabilité (0..1), ou null si aucun son voisé.
 */
export function yin(
  buf: Float32Array,
  sampleRate: number,
  fMin = 60,
  fMax = 1200,
  threshold = 0.12,
): { freq: number; probability: number } | null {
  const tauMax = Math.min(Math.floor(sampleRate / fMin), Math.floor(buf.length / 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  const W = buf.length - tauMax;
  if (W <= 0) return null;

  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.01) return null;

  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const diff = buf[i] - buf[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // différence moyenne cumulée normalisée
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // interpolation parabolique
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const den = a - 2 * b + c;
    if (den !== 0) better = tau + (0.5 * (a - c)) / den;
  }
  return { freq: sampleRate / better, probability: 1 - cmnd[tau] };
}

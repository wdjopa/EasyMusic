// Mixage mono et sous-échantillonnage (avec filtre passe-bas sinc fenêtré).

export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Sous-échantillonne d'un facteur entier. */
export function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x;
  const taps = 16 * factor + 1;
  const half = (taps - 1) / 2;
  const fc = 0.45 / factor;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - half;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const outLen = Math.floor(x.length / factor);
  const out = new Float32Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = o * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const idx = c + i - half;
      if (idx >= 0 && idx < x.length) acc += x[idx] * h[i];
    }
    out[o] = acc;
  }
  return out;
}

/** Ré-échantillonnage par interpolation cubique : lit x à la vitesse `rate`, produit `outLen` échantillons. */
export function resampleCubic(x: Float32Array, rate: number, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  const n = x.length;
  const at = (i: number) => (i < 0 ? 0 : i >= n ? 0 : x[i]);
  for (let o = 0; o < outLen; o++) {
    const p = o * rate;
    const i = Math.floor(p);
    const t = p - i;
    const y0 = at(i - 1);
    const y1 = at(i);
    const y2 = at(i + 1);
    const y3 = at(i + 2);
    const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c = -0.5 * y0 + 0.5 * y2;
    out[o] = ((a * t + b) * t + c) * t + y1;
  }
  return out;
}

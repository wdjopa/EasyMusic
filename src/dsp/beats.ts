import { fft, hann } from './fft';

/**
 * Détection des temps (beat tracking).
 * 1. Enveloppe d'attaques : flux spectral (augmentation d'énergie, échelle log).
 * 2. Tempo : autocorrélation de l'enveloppe, avec préférence autour de 110 BPM.
 * 3. Position des temps : programmation dynamique (méthode d'Ellis, 2007) qui
 *    trouve des temps sur les attaques tout en gardant un tempo régulier.
 */
export interface BeatResult {
  bpm: number;
  beats: number[]; // instants des temps (s)
}

export function onsetEnvelope(x: Float32Array, sr: number, hop = 256, n = 1024): { env: Float32Array; rate: number } {
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bins = n / 2;
  let prev = new Float64Array(bins);
  const frames = Math.max(0, Math.floor((x.length - n) / hop) + 1);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const s0 = f * hop;
    for (let i = 0; i < n; i++) {
      re[i] = x[s0 + i] * w[i];
      im[i] = 0;
    }
    fft(re, im);
    const cur = new Float64Array(bins);
    let flux = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = flux;
    prev = cur;
  }
  // retrait de la tendance locale (moyenne glissante ~1 s) et normalisation
  const rate = sr / hop;
  const win = Math.round(rate);
  const out = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += env[i];
    if (i >= win) acc -= env[i - win];
    const mean = acc / Math.min(i + 1, win);
    out[i] = Math.max(0, env[i] - mean);
  }
  let sd = 0;
  for (const v of out) sd += v * v;
  sd = Math.sqrt(sd / (frames || 1)) || 1;
  for (let i = 0; i < frames; i++) out[i] /= sd;
  return { env: out, rate };
}

export function estimateTempo(env: Float32Array, rate: number, harmonicPeriod?: number, minBpm = 60, maxBpm = 180): number {
  const ac = (lag: number) => {
    const L = Math.round(lag);
    if (L < 1 || L >= env.length) return 0;
    let s = 0;
    for (let i = L; i < env.length; i++) s += env[i] * env[i - L];
    return s / (env.length - L);
  };
  const minLag = Math.floor((60 / maxBpm) * rate);
  const maxLag = Math.ceil((60 / minBpm) * rate);
  let best = 120;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // un vrai tempo est aussi soutenu par sa subdivision (croches) et ses multiples (mesure)
    const s = ac(lag) + 0.5 * ac(lag / 2) + 0.5 * ac(lag * 2) + 0.25 * ac(lag * 4);
    const bpm = (60 * rate) / lag;
    // préférence douce pour les tempos courants
    let w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    // règle musicale : le plus souvent, les accords changent toutes les 1 ou 2 mesures (4 ou 8 temps)
    if (harmonicPeriod) {
      const beat = 60 / bpm;
      const fits = [4, 8].some((n) => Math.abs(n * beat - harmonicPeriod) / harmonicPeriod < 0.05);
      if (fits) w *= 1.6;
    }
    if (s * w > bestScore) {
      bestScore = s * w;
      best = bpm;
    }
  }
  return best;
}

/**
 * Période (s) à laquelle l'harmonie change, d'après le chroma (notes + basse) :
 * autocorrélation d'une courbe de « nouveauté harmonique ». Renvoie undefined si peu nette.
 */
export function harmonicPeriod(chroma: Float32Array[], frameDuration: number, bass?: Float32Array[]): number | undefined {
  const nov = harmonicNovelty(chroma, frameDuration, bass);
  const T = nov.length;
  const minLag = Math.round(1.0 / frameDuration);
  const maxLag = Math.round(6.0 / frameDuration);
  let zero = 0;
  for (let f = 0; f < T; f++) zero += nov[f] * nov[f];
  zero /= T || 1;
  const acs: number[] = [];
  for (let lag = minLag; lag <= maxLag && lag < T / 2; lag++) {
    let s = 0;
    for (let f = lag; f < T; f++) s += nov[f] * nov[f - lag];
    acs.push(s / (T - lag));
  }
  const best = Math.max(0, ...acs);
  // seulement si la périodicité est nette
  if (!acs.length || best < 0.3 * zero) return undefined;
  // la plus courte période fortement marquée (ses multiples le sont aussi)
  for (let i = 1; i < acs.length - 1; i++) {
    if (acs[i] >= 0.8 * best && acs[i] >= acs[i - 1] && acs[i] >= acs[i + 1]) return (minLag + i) * frameDuration;
  }
  return (minLag + acs.indexOf(best)) * frameDuration;
}

/** Courbe de « nouveauté harmonique » : forte là où les notes et la basse changent. */
export function harmonicNovelty(chroma: Float32Array[], frameDuration: number, bass?: Float32Array[]): Float64Array {
  const T = chroma.length;
  const k = Math.max(2, Math.round(0.4 / frameDuration));
  const feat = chroma.map((c, f) => {
    const v = new Float64Array(24);
    for (let i = 0; i < 12; i++) {
      v[i] = c[i];
      v[12 + i] = bass?.[f] ? 2 * bass[f][i] : 0;
    }
    return v;
  });
  const nov = new Float64Array(T);
  for (let f = k; f < T - k; f++) {
    const a = new Float64Array(24);
    const b = new Float64Array(24);
    for (let j = 1; j <= k; j++) for (let i = 0; i < 24; i++) {
      a[i] += feat[f - j][i];
      b[i] += feat[f + j - 1][i];
    }
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < 24; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    nov[f] = 1 - dot / (Math.sqrt(na * nb) || 1);
  }
  let mean = 0;
  for (const v of nov) mean += v;
  mean /= T || 1;
  for (let f = 0; f < T; f++) nov[f] = Math.max(0, nov[f] - mean);
  return nov;
}

/**
 * Les accords changent sur les temps forts : entre la grille de temps et la même grille
 * décalée d'un demi-temps, garde celle où les changements d'harmonie tombent le mieux.
 */
export function alignBeatsToHarmony(beats: number[], novelty: Float64Array, frameTime: (t: number) => number): number[] {
  if (beats.length < 4) return beats;
  const at = (t: number) => {
    const f = Math.round(frameTime(t));
    let m = 0;
    for (let d = -1; d <= 1; d++) m = Math.max(m, novelty[f + d] ?? 0);
    return m;
  };
  const half = (beats[beats.length - 1] - beats[0]) / (beats.length - 1) / 2;
  const shifted = beats.map((b) => b + half);
  const score = (g: number[]) => g.reduce((s, t) => s + at(t), 0);
  return score(shifted) > score(beats) * 1.15 ? shifted : beats;
}

export function trackBeats(x: Float32Array, sr: number, harmonic?: number): BeatResult {
  const { env, rate } = onsetEnvelope(x, sr);
  const N = env.length;
  if (N < 10) return { bpm: 0, beats: [] };
  const bpm = estimateTempo(env, rate, harmonic);
  const period = (60 / bpm) * rate; // en trames
  const alpha = 100; // rigidité du tempo
  const score = new Float64Array(N);
  const back = new Int32Array(N).fill(-1);
  for (let t = 0; t < N; t++) {
    let best = 0;
    let bestPrev = -1;
    const from = Math.max(0, Math.round(t - 2 * period));
    const to = Math.round(t - period / 2);
    for (let p = from; p <= to; p++) {
      const c = score[p] - alpha * Math.pow(Math.log((t - p) / period), 2);
      if (c > best || bestPrev < 0) {
        best = c;
        bestPrev = p;
      }
    }
    score[t] = env[t] + (bestPrev >= 0 ? Math.max(0, best) : 0);
    back[t] = bestPrev >= 0 && best > 0 ? bestPrev : -1;
  }
  // dernier temps : meilleur score dans la dernière période
  let t = N - 1;
  for (let i = Math.max(0, Math.round(N - period)); i < N; i++) if (score[i] > score[t]) t = i;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t / rate + 1024 / 2 / sr); // centre de la fenêtre d'analyse
    t = back[t];
  }
  beats.reverse();
  // compléter la grille au début et à la fin du morceau
  const dur = x.length / sr;
  const step = 60 / bpm;
  while (beats.length && beats[0] - step > 0) beats.unshift(beats[0] - step);
  while (beats.length && beats[beats.length - 1] + step < dur) beats.push(beats[beats.length - 1] + step);
  return { bpm, beats };
}

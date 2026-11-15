import { Chord, ChordQuality, QUALITY_INTERVALS, mod12, sameChord } from '../music/theory';

export interface ChordSegment {
  start: number; // secondes
  end: number;
  chord: Chord | null; // null = pas d'accord (silence / bruit)
  confidence: number; // 0..1
}

const QUALITIES = Object.keys(QUALITY_INTERVALS) as ChordQuality[];

/** Pénalité a priori : on favorise les accords majeurs/mineurs, plus fréquents. */
const QUALITY_PRIOR: Record<ChordQuality, number> = {
  maj: 1,
  min: 1,
  '7': 0.955,
  m7: 0.955,
  maj7: 0.95,
  sus2: 0.93,
  sus4: 0.93,
  dim: 0.92,
};

interface Template {
  chord: Chord;
  vec: Float64Array; // normalisé L2
  prior: number;
}

/** Modèle avec harmoniques : chaque note contribue aussi via ses harmoniques 2..4. */
function buildTemplates(): Template[] {
  const out: Template[] = [];
  const harmonics = [0, 12, 19, 24]; // fondamentale, octave, quinte+octave, 2 octaves
  const hw = [1, 0.5, 0.3, 0.2];
  for (const quality of QUALITIES) {
    for (let root = 0; root < 12; root++) {
      const v = new Float64Array(12);
      for (const iv of QUALITY_INTERVALS[quality]) {
        harmonics.forEach((h, i) => (v[mod12(root + iv + h)] += hw[i]));
      }
      // la fondamentale un peu renforcée
      v[root] += 0.3;
      const n = Math.hypot(...v);
      for (let i = 0; i < 12; i++) v[i] /= n;
      out.push({ chord: { root, quality }, vec: v, prior: QUALITY_PRIOR[quality] });
    }
  }
  return out;
}

const TEMPLATES = buildTemplates();
const BASS_WEIGHT = 4;

export interface RecognizeOptions {
  /** Durée d'une trame en secondes. */
  frameDuration: number;
  /** Probabilité de rester sur le même accord d'une trame à l'autre. */
  stayProbability?: number;
  /** Durée minimale d'un accord (s). */
  minDuration?: number;
  /** Permettre les accords enrichis (7, maj7, sus...). */
  extended?: boolean;
  /** Chroma de la basse (même nombre de trames), facultatif. */
  bass?: Float32Array[];
}

/**
 * Reconnaît la suite d'accords à partir d'un chromagramme :
 * score de similarité cosinus avec des gabarits, puis lissage par Viterbi.
 */
export function recognizeChords(chroma: Float32Array[], opts: RecognizeOptions): ChordSegment[] {
  const T = chroma.length;
  if (T === 0) return [];
  const templates = opts.extended === false ? TEMPLATES.filter((t) => t.chord.quality === 'maj' || t.chord.quality === 'min') : TEMPLATES;
  const S = templates.length + 1; // +1 : pas d'accord
  const NC = S - 1;

  // seuil de silence relatif à l'énergie typique du morceau
  const energies = chroma.map((c) => c.reduce((a, b) => a + b, 0));
  const sorted = [...energies].sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.75)] || 1;
  const silence = ref * 0.06;

  const beta = 22; // « netteté » de l'émission
  const scores: Float64Array[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const c = chroma[t];
    // compression log + normalisation
    const v = new Float64Array(12);
    let max = 0;
    for (let i = 0; i < 12; i++) max = Math.max(max, c[i]);
    for (let i = 0; i < 12; i++) v[i] = Math.log1p((c[i] / (max || 1)) * 20);
    const n = Math.hypot(...v) || 1;
    for (let i = 0; i < 12; i++) v[i] /= n;
    const row = new Float64Array(S);
    const e = energies[t];
    const silentness = e < silence ? 1 : 0;
    // basse : bonus pour les accords dont la fondamentale est la note la plus grave
    const bass = new Float64Array(12);
    if (opts.bass?.[t]) {
      const b = opts.bass[t];
      let bmax = 0;
      for (let i = 0; i < 12; i++) bmax = Math.max(bmax, b[i]);
      if (bmax > 0) for (let i = 0; i < 12; i++) bass[i] = b[i] / bmax;
    }
    for (let s = 0; s < NC; s++) {
      const tp = templates[s];
      let dot = 0;
      for (let i = 0; i < 12; i++) dot += v[i] * tp.vec[i];
      const r = tp.chord.root;
      row[s] = beta * dot * tp.prior + BASS_WEIGHT * (bass[r] * bass[r]) - silentness * 10;
    }
    row[NC] = silentness ? beta : beta * 0.55;
    scores[t] = row;
  }

  // Viterbi
  const pStay = opts.stayProbability ?? Math.pow(0.9, opts.frameDuration / 0.17);
  const logStay = Math.log(pStay);
  const logMove = Math.log((1 - pStay) / (S - 1));
  let prev = Float64Array.from(scores[0]);
  const back: Uint16Array[] = new Array(T);
  for (let t = 1; t < T; t++) {
    let bestPrev = 0;
    for (let s = 1; s < S; s++) if (prev[s] > prev[bestPrev]) bestPrev = s;
    const cur = new Float64Array(S);
    const bp = new Uint16Array(S);
    const moveScore = prev[bestPrev] + logMove;
    for (let s = 0; s < S; s++) {
      const stay = prev[s] + logStay;
      if (stay >= moveScore) {
        cur[s] = stay + scores[t][s];
        bp[s] = s;
      } else {
        cur[s] = moveScore + scores[t][s];
        bp[s] = bestPrev;
      }
    }
    back[t] = bp;
    prev = cur;
  }
  const path = new Uint16Array(T);
  let last = 0;
  for (let s = 1; s < S; s++) if (prev[s] > prev[last]) last = s;
  path[T - 1] = last;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t][path[t]];

  // segments
  const fd = opts.frameDuration;
  let segs: ChordSegment[] = [];
  let start = 0;
  for (let t = 1; t <= T; t++) {
    if (t === T || path[t] !== path[start]) {
      const s = path[start];
      // confiance : écart moyen entre l'accord choisi et le meilleur autre
      let conf = 0;
      for (let u = start; u < t; u++) {
        const row = scores[u];
        let other = -Infinity;
        for (let k = 0; k < S; k++) if (k !== s && row[k] > other) other = row[k];
        conf += row[s] - other;
      }
      conf = 1 / (1 + Math.exp(-(conf / (t - start)) * 2));
      segs.push({ start: start * fd, end: t * fd, chord: s === NC ? null : templates[s].chord, confidence: conf });
      start = t;
    }
  }

  return mergeShort(segs, opts.minDuration ?? 0.6);
}

/** Fusionne les segments trop courts avec leur voisin et regroupe les accords identiques consécutifs. */
export function mergeShort(segs: ChordSegment[], minDuration: number): ChordSegment[] {
  let out = segs.slice();
  let changed = true;
  while (changed && out.length > 1) {
    changed = false;
    let idx = -1;
    let shortest = minDuration;
    out.forEach((s, i) => {
      const d = s.end - s.start;
      if (d < shortest) {
        shortest = d;
        idx = i;
      }
    });
    if (idx >= 0) {
      const s = out[idx];
      const prev = out[idx - 1];
      const next = out[idx + 1];
      const target = !prev ? next : !next ? prev : prev.end - prev.start >= next.end - next.start ? prev : next;
      target.start = Math.min(target.start, s.start);
      target.end = Math.max(target.end, s.end);
      out.splice(idx, 1);
      changed = true;
    }
    // regrouper les doublons
    const merged: ChordSegment[] = [];
    for (const s of out) {
      const m = merged[merged.length - 1];
      if (m && sameChord(m.chord, s.chord)) {
        const dm = m.end - m.start;
        const ds = s.end - s.start;
        m.confidence = (m.confidence * dm + s.confidence * ds) / (dm + ds);
        m.end = s.end;
      } else merged.push({ ...s });
    }
    out = merged;
  }
  return out;
}

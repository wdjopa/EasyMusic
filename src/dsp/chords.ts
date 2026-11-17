import { Chord, ChordQuality, type Key, QUALITY_INTERVALS, mod12, sameChord } from '../music/theory';

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
/** Bonus quand la basse joue la fondamentale de l'accord… */
const BASS_ROOT = 3;
/** …ou une autre note de l'accord (renversement, ex. G/B). */
const BASS_TONE = 1.0;
/** Bonus pour les accords qui appartiennent à la gamme de la tonalité. */
const KEY_BONUS = 1.6;

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
  /** Tonalité : favorise les accords de la gamme (seconde passe). */
  key?: Key;
  /**
   * Instants des temps (même repère que les trames : trame i = [i, i+1) × frameDuration).
   * Si fournis, les accords ne changent que sur un temps, de préférence en début de mesure.
   */
  beats?: number[];
  /** Nombre de temps entre deux changements d'accord typiques (2 ou 4), si connu. */
  harmonicBeats?: number;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // mineur naturel + sensible (accord de dominante majeur)

/** Vrai si toutes les notes de l'accord appartiennent à la gamme de la tonalité. */
export function isDiatonic(c: Chord, key: Key): boolean {
  const scale = (key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE).map((d) => mod12(d + key.tonic));
  return QUALITY_INTERVALS[c.quality].every((iv) => scale.includes(mod12(c.root + iv)));
}

/** Estime la tonalité à partir des accords reconnus (durée des accords de chaque gamme). */
export function keyFromChords(segs: ChordSegment[], profileScore?: (key: Key) => number): Key | null {
  let best: Key | null = null;
  let bestScore = 0;
  const total = segs.reduce((a, s) => a + (s.chord ? s.end - s.start : 0), 0) || 1;
  for (const mode of ['major', 'minor'] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const key = { tonic, mode };
      let score = 0;
      for (const s of segs) {
        if (!s.chord) continue;
        const d = s.end - s.start;
        if (isDiatonic(s.chord, key)) score += d;
        // l'accord de tonique départage les tonalités relatives (Do majeur / La mineur)
        if (s.chord.root === tonic && (s.chord.quality === 'min') === (mode === 'minor')) score += 0.35 * d;
      }
      // départage : profil des notes (Krumhansl), puis préférence pour le majeur, plus fréquent
      score = score / total + 0.3 * (profileScore?.(key) ?? 0) + (mode === 'major' ? 0.02 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }
  }
  return best;
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
  const diatonic = templates.map((t) => (opts.key ? isDiatonic(t.chord, opts.key) : false));
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
      let otherTone = 0;
      for (const iv of QUALITY_INTERVALS[tp.chord.quality]) if (iv) otherTone = Math.max(otherTone, bass[mod12(r + iv)]);
      row[s] =
        beta * dot * tp.prior +
        BASS_ROOT * bass[r] * bass[r] +
        BASS_TONE * otherTone * otherTone +
        (diatonic[s] ? KEY_BONUS : 0) -
        silentness * 10;
    }
    row[NC] = silentness ? beta : beta * 0.55;
    scores[t] = row;
  }

  if (opts.beats && opts.beats.length > 4) return decodeOnBeats(scores, chroma, opts, templates, NC);

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

/** Gain minimal (en points de score) pour couper une mesure en deux accords. */
const SPLIT_MARGIN = 6;

/**
 * Décodage « musical » : un accord dure au moins un temps et change surtout
 * au début des mesures (puis à la mi-mesure), comme dans la grande majorité des chansons.
 */
function decodeOnBeats(
  scores: Float64Array[],
  chroma: Float32Array[],
  opts: RecognizeOptions,
  templates: Template[],
  NC: number,
): ChordSegment[] {
  const fd = opts.frameDuration;
  const T = scores.length;
  const S = NC + 1;
  // bornes des temps, en trames
  const bounds = [0];
  for (const b of opts.beats!) {
    const f = Math.round(b / fd);
    if (f > bounds[bounds.length - 1] && f < T) bounds.push(f);
  }
  bounds.push(T);
  const B = bounds.length - 1;

  // score de chaque accord sur chaque temps (moyenne des trames) et chroma moyen (notes + basse)
  const E: Float64Array[] = [];
  const beatChroma: Float64Array[] = [];
  for (let b = 0; b < B; b++) {
    const e = new Float64Array(S);
    const c = new Float64Array(24);
    const n = bounds[b + 1] - bounds[b];
    for (let f = bounds[b]; f < bounds[b + 1]; f++) {
      for (let s = 0; s < S; s++) e[s] += scores[f][s];
      for (let i = 0; i < 12; i++) {
        c[i] += chroma[f][i];
        if (opts.bass?.[f]) c[12 + i] += 2 * opts.bass[f][i];
      }
    }
    for (let s = 0; s < S; s++) e[s] = (e[s] / n) * 4;
    E.push(e);
    beatChroma.push(c);
  }

  // unité harmonique : nombre de temps d'un accord « typique » (mesure à 4 ou 3 temps, ou demi-mesure)
  const hb = opts.harmonicBeats;
  const unitLen = hb === 2 ? 2 : hb === 3 || hb === 6 ? 3 : 4;
  const cycle = unitLen;
  // début des mesures : phase où l'harmonie change le plus
  const novelty = new Float64Array(B);
  for (let b = 1; b < B; b++) {
    const a = beatChroma[b - 1];
    const c = beatChroma[b];
    let dot = 0;
    let na = 0;
    let nc = 0;
    for (let i = 0; i < 24; i++) {
      dot += a[i] * c[i];
      na += a[i] * a[i];
      nc += c[i] * c[i];
    }
    novelty[b] = 1 - dot / (Math.sqrt(na * nc) || 1);
  }
  let phase = 0;
  let bestNov = -1;
  for (let p = 0; p < cycle; p++) {
    let sum = 0;
    for (let b = p; b < B; b += cycle) sum += novelty[b];
    if (sum > bestNov) {
      bestNov = sum;
      phase = p;
    }
  }

  const simple = (s: number) => {
    if (s === NC) return -1;
    const c = templates[s].chord;
    const q = c.quality === 'min' || c.quality === 'm7' ? 1 : c.quality === 'dim' ? 2 : 0;
    return c.root * 3 + q;
  };
  // Unités harmoniques : 1 accord par mesure (ou par demi-mesure si le morceau change tous les 2 temps).
  // L'accord est choisi sur toute l'unité : une note de mélodie sur un seul temps ne peut pas créer un accord.
  const unitStarts: number[] = [];
  for (let b = 0; b < B; b++) if (b === 0 || (((b - phase) % unitLen) + unitLen) % unitLen === 0) unitStarts.push(b);
  unitStarts.push(B);
  const U = unitStarts.length - 1;
  const sumRange = (from: number, to: number) => {
    const e = new Float64Array(S);
    for (let b = from; b < to; b++) for (let s2 = 0; s2 < S; s2++) e[s2] += E[b][s2];
    return e;
  };
  const UE = Array.from({ length: U }, (_, u) => sumRange(unitStarts[u], unitStarts[u + 1]));
  const argmax = (e: Float64Array) => {
    let k = 0;
    for (let s2 = 1; s2 < S; s2++) if (e[s2] > e[k]) k = s2;
    return k;
  };

  // Viterbi sur les unités (changer d'accord d'une unité à l'autre est normal, pas pénalisé lourdement)
  let prev = Float64Array.from(UE[0]);
  const back: Uint16Array[] = new Array(U);
  const logStay = Math.log(0.5);
  const logMove = Math.log(0.5 / (S - 1));
  for (let u = 1; u < U; u++) {
    const bestPrev = argmax(prev);
    const cur = new Float64Array(S);
    const bp = new Uint16Array(S);
    const move = prev[bestPrev] + logMove;
    for (let s2 = 0; s2 < S; s2++) {
      const stay = prev[s2] + logStay;
      if (stay >= move) {
        cur[s2] = stay + UE[u][s2];
        bp[s2] = s2;
      } else {
        cur[s2] = move + UE[u][s2];
        bp[s2] = bestPrev;
      }
    }
    back[u] = bp;
    prev = cur;
  }
  const unitPath = new Uint16Array(U);
  unitPath[U - 1] = argmax(prev);
  for (let u = U - 1; u > 0; u--) unitPath[u - 1] = back[u][unitPath[u]];

  // chemin par temps ; une mesure n'est coupée en deux que si ses deux moitiés sont nettement différentes
  const path = new Uint16Array(B);
  for (let u = 0; u < U; u++) {
    const a0 = unitStarts[u];
    const a1 = unitStarts[u + 1];
    let cut = -1;
    let c1 = unitPath[u];
    let c2 = unitPath[u];
    if (unitLen === 4 && a1 - a0 === 4) {
      const h1 = sumRange(a0, a0 + 2);
      const h2 = sumRange(a0 + 2, a1);
      const b1 = argmax(h1);
      const b2 = argmax(h2);
      const gain = h1[b1] + h2[b2] - UE[u][unitPath[u]];
      // règle musicale : un changement en milieu de mesure s'accompagne d'un changement de basse
      const bassNote = (from: number, to: number) => {
        const acc = new Float64Array(12);
        for (let b = from; b < to; b++) for (let i = 0; i < 12; i++) acc[i] += beatChroma[b][12 + i];
        let k = 0;
        for (let i = 1; i < 12; i++) if (acc[i] > acc[k]) k = i;
        return acc[k] > 0 ? k : -1;
      };
      const bass1 = bassNote(a0, a0 + 2);
      const bass2 = bassNote(a0 + 2, a1);
      const inChord = (st: number, pc: number) =>
        st !== NC && pc >= 0 && QUALITY_INTERVALS[templates[st].chord.quality].some((iv) => mod12(templates[st].chord.root + iv) === pc);
      const bassMoves = bass1 !== bass2 && inChord(b2, bass2) && !inChord(b1, bass2);
      if (b1 !== b2 && simple(b1) !== simple(b2) && gain > SPLIT_MARGIN && bassMoves) {
        cut = a0 + 2;
        c1 = b1;
        c2 = b2;
      }
    }
    for (let b = a0; b < a1; b++) path[b] = cut >= 0 && b >= cut ? c2 : c1;
  }

  // segments ; confiance = part des temps où l'accord choisi est (presque) le meilleur
  const segs: ChordSegment[] = [];
  let start = 0;
  for (let b = 1; b <= B; b++) {
    if (b < B && path[b] === path[start]) continue;
    const s = path[start];
    let agree = 0;
    for (let u = start; u < b; u++) {
      let other = -Infinity;
      for (let k = 0; k < S; k++) if (simple(k) !== simple(s) && E[u][k] > other) other = E[u][k];
      if (E[u][s] >= other - 1) agree++;
    }
    segs.push({
      start: bounds[start] * fd,
      end: bounds[b] * fd,
      chord: s === NC ? null : templates[s].chord,
      confidence: agree / (b - start),
    });
    start = b;
  }
  return mergeShort(segs, 0.25);
}

/**
 * Classement des accords pour UNE trame (écoute en direct au micro) :
 * même calcul que la reconnaissance du morceau (gabarits harmoniques + basse + tonalité).
 */
export function chordCandidates(chroma: Float32Array, bass?: Float32Array, key?: Key): { chord: Chord; score: number }[] {
  const v = new Float64Array(12);
  let max = 0;
  for (let i = 0; i < 12; i++) max = Math.max(max, chroma[i]);
  if (!max) return [];
  for (let i = 0; i < 12; i++) v[i] = Math.log1p((chroma[i] / max) * 20);
  const n = Math.hypot(...v) || 1;
  for (let i = 0; i < 12; i++) v[i] /= n;
  const b = new Float64Array(12);
  if (bass) {
    let bm = 0;
    for (let i = 0; i < 12; i++) bm = Math.max(bm, bass[i]);
    if (bm > 0) for (let i = 0; i < 12; i++) b[i] = bass[i] / bm;
  }
  return TEMPLATES.map((tp) => {
    let dot = 0;
    for (let i = 0; i < 12; i++) dot += v[i] * tp.vec[i];
    const r = tp.chord.root;
    let other = 0;
    for (const iv of QUALITY_INTERVALS[tp.chord.quality]) if (iv) other = Math.max(other, b[mod12(r + iv)]);
    const score = 22 * dot * tp.prior + BASS_ROOT * b[r] * b[r] + BASS_TONE * other * other + (key && isDiatonic(tp.chord, key) ? KEY_BONUS : 0);
    return { chord: tp.chord, score };
  }).sort((x, y) => y.score - x.score);
}

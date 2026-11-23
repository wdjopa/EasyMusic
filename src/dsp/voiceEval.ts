// Évaluation d'une prise de chant, APRÈS coup, sur l'enregistrement complet (pas bloc par bloc) :
//  1. hauteur de la voix toutes les 20 ms (YIN) ;
//  2. nettoyage : seuil de bruit adapté à la pièce, confiance minimale, filtre médian, et suppression
//     des fragments trop courts (< 150 ms : bruits, consonnes, attaques) ;
//  3. comparaison NOTE PAR NOTE avec la mélodie attendue (pas trame par trame) : une note est jugée
//     sur l'ensemble de sa durée, l'octave ne compte pas, et les notes trop brèves ne sont pas jugées.
// C'est l'approche des jeux de chant et des logiciels d'apprentissage (notes, pas instants).

import { yin } from './yin';

export interface PitchFrame {
  t: number; // s depuis le début de l'enregistrement
  midi: number | null;
  prob: number;
  rms: number;
}

/** Hauteur de la voix toutes les `hop` secondes (signal mono). Rend la main régulièrement au navigateur. */
export async function pitchTrack(samples: Float32Array, sampleRate: number, hop = 0.02, onProgress?: (f: number) => void): Promise<PitchFrame[]> {
  // 16 kHz suffisent pour la voix et divisent le calcul par trois
  const factor = Math.max(1, Math.floor(sampleRate / 16000));
  const sr = sampleRate / factor;
  const x = new Float32Array(Math.floor(samples.length / factor));
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    x[i] = s / factor;
  }
  const win = 1024; // 64 ms : deux périodes d'une voix grave (70 Hz)
  const step = Math.round(hop * sr);
  const out: PitchFrame[] = [];
  for (let start = 0, n = 0; start + win <= x.length; start += step, n++) {
    const buf = x.subarray(start, start + win);
    let rms = 0;
    for (let i = 0; i < win; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / win);
    const p = yin(buf, sr, 70, 1100, 0.15, 0.001);
    out.push({ t: (start + win / 2) / sr, midi: p ? 69 + 12 * Math.log2(p.freq / 440) : null, prob: p?.probability ?? 0, rms });
    if (n % 400 === 399) {
      onProgress?.(start / x.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

export interface SungNote {
  start: number;
  end: number;
  midi: number; // médiane
}

/** Durée minimale d'une note chantée retenue (en dessous : bruit, consonne, attaque). */
export const MIN_SUNG = 0.15;

/**
 * Nettoie la piste : ne garde que les trames voisées, assez fortes par rapport au bruit de fond de la pièce,
 * lissées, et regroupées en notes d'au moins MIN_SUNG. Renvoie les notes et les trames retenues.
 */
export function cleanVoice(frames: PitchFrame[], hop = 0.02): { notes: SungNote[]; kept: PitchFrame[] } {
  if (!frames.length) return { notes: [], kept: [] };
  // bruit de fond : niveau des 20 % de trames les plus calmes
  const levels = frames.map((f) => f.rms).sort((a, b) => a - b);
  const floor = levels[Math.floor(levels.length * 0.2)];
  // … mais si l'on chante presque tout le temps, ces 20 % sont de la voix : le seuil reste alors
  // bien en dessous du niveau de la voix (quart du niveau des passages forts)
  const loud = levels[Math.floor(levels.length * 0.9)];
  const gate = Math.max(0.003, Math.min(floor * 2.5, loud * 0.25));
  const voiced = frames.map((f) => (f.midi !== null && f.prob >= 0.75 && f.rms >= gate ? f.midi : null));
  // filtre médian (5 trames) : supprime les sauts d'octave isolés
  const smooth = voiced.map((m, i) => {
    if (m === null) return null;
    const w = voiced.slice(Math.max(0, i - 2), i + 3).filter((v): v is number => v !== null);
    if (w.length < 3) return null; // trame isolée
    w.sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  // regroupement en notes : même hauteur (± 0,7 demi-ton), trous de 60 ms au plus
  const notes: SungNote[] = [];
  const kept: PitchFrame[] = [];
  let cur: { idx: number[]; vals: number[] } | null = null;
  let gap = 0;
  const close = () => {
    if (!cur) return;
    const dur = cur.idx.length * hop;
    if (dur >= MIN_SUNG) {
      const sorted = [...cur.vals].sort((a, b) => a - b);
      notes.push({ start: frames[cur.idx[0]].t - hop / 2, end: frames[cur.idx[cur.idx.length - 1]].t + hop / 2, midi: sorted[Math.floor(sorted.length / 2)] });
      for (const i of cur.idx) kept.push({ ...frames[i], midi: smooth[i] });
    }
    cur = null;
  };
  for (let i = 0; i < smooth.length; i++) {
    const m = smooth[i];
    if (m === null) {
      if (cur && ++gap > 3) close();
      continue;
    }
    gap = 0;
    if (cur) {
      const ref = cur.vals.slice(-8).sort((a, b) => a - b)[Math.floor(Math.min(8, cur.vals.length) / 2)];
      if (Math.abs(m - ref) > 0.7) close();
    }
    if (!cur) cur = { idx: [], vals: [] };
    cur.idx.push(i);
    cur.vals.push(m);
  }
  close();
  return { notes, kept };
}

export type NoteVerdict = 'ok' | 'close' | 'sharp' | 'flat' | 'missed';

export interface NoteResult {
  start: number; // temps du morceau
  end: number;
  midi: number; // attendu
  verdict: NoteVerdict;
  /** Écart moyen en demi-tons (octave ramenée), si chantée. */
  deviation?: number;
  /** Part de la note réellement chantée (0..1). */
  coverage: number;
}

export interface TakeSummary {
  judged: number; // notes de la mélodie dans la prise
  ok: number;
  close: number;
  sharp: number;
  flat: number;
  missed: number;
  /** % de notes justes parmi les notes à chanter. */
  score: number;
  /** Tendance (demi-tons) sur les notes chantées : > 0 trop haut. */
  tendency: number;
}

/** Notes de la mélodie trop brèves pour être jugées (ornements, erreurs de l'estimation). */
export const MIN_EXPECTED = 0.2;
const fold = (d: number) => d - 12 * Math.round(d / 12);

/**
 * Compare la voix (trames retenues, avec leur temps DANS LE MORCEAU) aux notes attendues.
 * Tolérance : ±0,5 demi-ton = juste ; ±1 = presque ; au-delà trop haut / trop bas.
 */
export function evaluateTake(
  expected: { start: number; end: number; midi: number }[],
  sung: { songT: number; midi: number }[],
  range: { start: number; end: number },
): { notes: NoteResult[]; summary: TakeSummary } {
  const frames = [...sung].sort((a, b) => a.songT - b.songT);
  const times = frames.map((f) => f.songT);
  const lower = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const hop = frames.length > 1 ? Math.max(0.005, Math.min(0.05, (times[times.length - 1] - times[0]) / (frames.length - 1))) : 0.02;
  const notes: NoteResult[] = [];
  for (const n of expected) {
    if (n.end - n.start < MIN_EXPECTED || n.start < range.start || n.end > range.end) continue;
    // on accepte un léger retard ou une légère avance (réaction, latence du micro)
    const from = lower(n.start - 0.12);
    const to = lower(n.end + 0.12);
    const devs: number[] = [];
    for (let i = from; i < to; i++) devs.push(fold(frames[i].midi - n.midi));
    const coverage = Math.min(1, (devs.length * hop) / (n.end - n.start));
    if (coverage < 0.35) {
      notes.push({ ...n, verdict: 'missed', coverage });
      continue;
    }
    devs.sort((a, b) => a - b);
    const d = devs[Math.floor(devs.length / 2)];
    const verdict: NoteVerdict = Math.abs(d) <= 0.5 ? 'ok' : Math.abs(d) <= 1 ? 'close' : d > 0 ? 'sharp' : 'flat';
    notes.push({ ...n, verdict, deviation: d, coverage });
  }
  const count = (v: NoteVerdict) => notes.filter((x) => x.verdict === v).length;
  const sungNotes = notes.filter((x) => x.deviation !== undefined);
  const tendency = sungNotes.length ? sungNotes.reduce((s, x) => s + x.deviation!, 0) / sungNotes.length : 0;
  const summary: TakeSummary = {
    judged: notes.length,
    ok: count('ok'),
    close: count('close'),
    sharp: count('sharp'),
    flat: count('flat'),
    missed: count('missed'),
    score: notes.length ? Math.round(((count('ok') + 0.5 * count('close')) / notes.length) * 100) : 0,
    tendency,
  };
  return { notes, summary };
}

// ---------------------------------------------------------------- temps de l'enregistrement -> temps du morceau
export interface TimelinePoint {
  rec: number; // s depuis le début de l'enregistrement
  song: number; // position dans le morceau
  playing: boolean;
  rate: number;
}

/** Position dans le morceau à l'instant `rec` de l'enregistrement (pauses, retours en arrière, vitesse). */
export function songTimeAt(timeline: TimelinePoint[], rec: number): number | null {
  if (!timeline.length || rec < timeline[0].rec) return null;
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid].rec <= rec) lo = mid;
    else hi = mid - 1;
  }
  const p = timeline[lo];
  return p.playing ? p.song + (rec - p.rec) * p.rate : null;
}

// Partition (solfège) de la mélodie : notes calées sur les temps et les mesures, écrites en notation ABC
// (affichée ensuite par abcjs). Fonctions pures, sans dépendance au navigateur.

import type { Key } from './theory';
import { FRENCH_NAMES, mod12 } from './theory';
import type { MelodyNote } from './melody';

/** Subdivisions par temps : 2 = croche (lisible ; la mélodie estimée n'est pas assez précise pour des doubles). */
const SUB = 2;
/** Durées écrivables, en croches : croche, noire, noire pointée, blanche, blanche pointée, ronde. */
const LENGTHS = [8, 6, 4, 3, 2, 1];

export interface ScoreChord {
  start: number; // s
  name: string;
}

export interface ScoreLine {
  start: number; // s (texte des paroles)
  text: string;
}

export interface ScoreSystem {
  /** Corps ABC de la ligne de portée (mesures séparées par |). */
  abc: string;
  /** Début et fin (s) de chaque mesure de la ligne. */
  bars: { start: number; end: number }[];
  start: number;
  end: number;
  /** Paroles chantées pendant cette ligne. */
  text: string;
}

export interface Score {
  header: string; // en-tête ABC commun (mesure, unité, armure, clé)
  meter: number;
  keyLabel: string;
  clef: 'treble' | 'bass';
  systems: ScoreSystem[];
  noteCount: number;
}

export interface ScoreInput {
  notes: MelodyNote[];
  beats?: number[];
  bpm?: number;
  meter?: number;
  duration: number;
  key: Key;
  chords: ScoreChord[];
  lines?: ScoreLine[];
  /** Nom des notes sous la portée (Do, Ré, Mi…). */
  noteNames?: boolean;
  barsPerSystem?: number;
}

// ---------------------------------------------------------------- orthographe des notes
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const NATURAL = [0, 2, 4, 5, 7, 9, 11];
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };

interface Spelled {
  letter: number; // 0..6 (C..B)
  alter: number; // -2..2
  octave: number; // 4 = octave du do central
}

/** Armure : nom usuel de la tonalité et altération de chaque lettre (ex. Sol majeur : F → +1). */
export function keySignature(key: Key): { name: string; alter: number[]; flatSide: boolean } {
  const tonic = (key.mode === 'major' ? MAJOR_KEYS : MINOR_KEYS)[mod12(key.tonic)];
  const tl = LETTERS.indexOf(tonic[0]);
  const alter = new Array(7).fill(0);
  SCALE[key.mode].forEach((iv, deg) => {
    const letter = (tl + deg) % 7;
    alter[letter] = ((mod12(key.tonic + iv - NATURAL[letter]) + 6) % 12) - 6;
  });
  const flatSide = alter.some((a) => a < 0);
  return { name: `${tonic}${key.mode === 'minor' ? 'm' : ''}`, alter, flatSide };
}

/** Écrit une hauteur MIDI selon la tonalité : notes de la gamme comme l'armure, autres notes altérées. */
export function spell(midi: number, sig: { alter: number[]; flatSide: boolean }): Spelled {
  const pc = mod12(midi);
  // note de la gamme ?
  for (let l = 0; l < 7; l++) if (mod12(NATURAL[l] + sig.alter[l]) === pc) return withOctave(midi, l, sig.alter[l]);
  // note étrangère : bécarre si possible, sinon dièse (tonalités à dièses) ou bémol
  const natural = NATURAL.indexOf(pc);
  if (natural >= 0) return withOctave(midi, natural, 0);
  const sharp = NATURAL.indexOf(mod12(pc - 1));
  const flat = NATURAL.indexOf(mod12(pc + 1));
  return sig.flatSide ? withOctave(midi, flat, -1) : withOctave(midi, sharp, 1);
}

function withOctave(midi: number, letter: number, alter: number): Spelled {
  return { letter, alter, octave: Math.floor((midi - alter) / 12) - 1 };
}

function abcPitch(s: Spelled): string {
  const l = LETTERS[s.letter];
  if (s.octave >= 5) return l.toLowerCase() + "'".repeat(s.octave - 5);
  return l + ','.repeat(Math.max(0, 4 - s.octave));
}

const ACC: Record<number, string> = { [-2]: '__', [-1]: '_', 0: '=', 1: '^', 2: '^^' };

/** Nom français de la note écrite (Do, Ré♯, Si♭…). */
export function frenchName(s: Spelled): string {
  const base = FRENCH_NAMES[NATURAL[s.letter]];
  return base + (s.alter > 0 ? '♯'.repeat(s.alter) : s.alter < 0 ? '♭'.repeat(-s.alter) : '');
}

// ---------------------------------------------------------------- temps et mesures
/** Grille des temps couvrant tout le morceau (prolongée au début et à la fin au tempo médian). */
export function beatGrid(beats: number[] | undefined, bpm: number | undefined, duration: number, anchor = 0): number[] {
  let b = (beats ?? []).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (b.length < 4) {
    const p = bpm && bpm > 30 ? 60 / bpm : 0.5;
    b = [];
    for (let t = anchor - Math.ceil(anchor / p) * p; t <= duration + p; t += p) b.push(t);
    return b;
  }
  const gaps = b.slice(1).map((x, i) => x - b[i]).sort((x, y) => x - y);
  const p = gaps[Math.floor(gaps.length / 2)];
  const out = [...b];
  while (out[0] > 0) out.unshift(out[0] - p);
  while (out[out.length - 1] < duration) out.push(out[out.length - 1] + p);
  return out;
}

/** Premier temps des mesures : phase où commencent le plus de changements d'accord. */
export function downbeatPhase(grid: number[], chords: ScoreChord[], meter: number): number {
  const score = new Array(meter).fill(0);
  for (const c of chords) {
    const i = nearestBeat(grid, c.start);
    score[i % meter] += 1;
  }
  return score.indexOf(Math.max(...score));
}

function nearestBeat(grid: number[], t: number): number {
  let lo = 0;
  let hi = grid.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - grid[lo] < grid[hi] - t ? lo : hi;
}

/** Position d'un instant sur la grille, en subdivisions (non arrondie). */
function toSlot(grid: number[], t: number): number {
  let lo = 0;
  let hi = grid.length - 1;
  if (t <= grid[0]) return 0;
  if (t >= grid[hi]) return hi * SUB;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid;
    else hi = mid;
  }
  return (lo + (t - grid[lo]) / (grid[lo + 1] - grid[lo])) * SUB;
}

function slotTime(grid: number[], slot: number): number {
  const i = Math.min(grid.length - 2, Math.floor(slot / SUB));
  return grid[i] + ((slot - i * SUB) / SUB) * (grid[i + 1] - grid[i]);
}

/** Découpe une durée (en croches) en valeurs écrivables, la plus longue d'abord. */
export function splitLength(n: number): number[] {
  const out: number[] = [];
  while (n > 0) {
    const l = LENGTHS.find((x) => x <= n)!;
    out.push(l);
    n -= l;
  }
  return out;
}

// ---------------------------------------------------------------- partition
/**
 * Fausses notes probables de l'estimation : une note brève HORS de la gamme, à un demi-ton de sa voisine,
 * est presque toujours la note voisine mal entendue (accord plaqué par-dessus). Elle est fondue dans la voisine.
 */
export function cleanNotes(notes: MelodyNote[], key: Key, beat: number): MelodyNote[] {
  const scale = new Set(SCALE[key.mode].map((iv) => mod12(key.tonic + iv)));
  const out: MelodyNote[] = [];
  const sorted = [...notes].sort((a, b) => a.start - b.start).map((n) => ({ ...n }));
  let fused = false;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const prev = out[out.length - 1];
    const next = sorted[i + 1];
    const stray = !scale.has(mod12(n.midi)) && n.end - n.start < 0.75 * beat;
    if (stray && prev && Math.abs(prev.midi - n.midi) === 1 && n.start - prev.end < 0.25 * beat) {
      prev.end = n.end;
      fused = true;
      continue;
    }
    if (stray && next && Math.abs(next.midi - n.midi) === 1 && next.start - n.end < 0.25 * beat) {
      next.start = n.start;
      continue;
    }
    // même note coupée en deux par une fausse note fondue : on la réunit
    if (fused && prev && prev.midi === n.midi && n.start - prev.end < 0.05) {
      prev.end = n.end;
      fused = false;
      continue;
    }
    fused = false;
    out.push(n);
  }
  return out;
}

export function buildScore(input: ScoreInput): Score {
  const meter = input.meter === 3 ? 3 : 4;
  const sig = keySignature(input.key);
  const grid = beatGrid(input.beats, input.bpm, input.duration, input.chords[1]?.start ?? 0);
  const phase = downbeatPhase(grid, input.chords, meter);
  const barSlots = meter * SUB;
  const firstBar = phase * SUB; // la mesure 0 commence au temps `phase` (avant : levée ignorée si vide)
  const totalSlots = (grid.length - 1) * SUB;

  // 1. notes -> cases de la grille (monophonique : une note par case)
  const pitch = new Int16Array(totalSlots).fill(-1);
  const onset = new Uint8Array(totalSlots);
  let prevEnd = -1;
  let prevStart = -1;
  let noteCount = 0;
  for (const n of cleanNotes(input.notes, input.key, (grid[grid.length - 1] - grid[0]) / (grid.length - 1))) {
    const rs = toSlot(grid, n.start);
    const re = toSlot(grid, n.end);
    let s = Math.round(rs);
    let e = Math.round(re);
    if (e <= s) {
      if (re - rs < 0.5) continue; // trop brève pour être écrite
      e = s + 1;
    }
    if (s < prevEnd) s = prevEnd;
    if (e <= s || s >= totalSlots) continue;
    // un temps de silence au plus entre deux notes chantées : on prolonge la précédente (chant lié)
    if (prevEnd >= 0 && s - prevEnd <= SUB && prevStart >= 0) for (let k = prevEnd; k < s; k++) pitch[k] = pitch[prevStart];
    for (let k = s; k < Math.min(e, totalSlots); k++) pitch[k] = n.midi;
    onset[s] = 1;
    prevStart = s;
    prevEnd = e;
    noteCount++;
  }

  // 2. accords -> case de début (un seul par case, sans répétition)
  const chordAt = new Map<number, string>();
  let lastName = '';
  for (const c of input.chords) {
    if (c.name === lastName) continue;
    const slot = nearestBeat(grid, c.start) * SUB;
    if (slot < firstBar || slot >= totalSlots) continue;
    chordAt.set(slot, c.name);
    lastName = c.name;
  }

  // 3. mesures
  const bars: { from: number; abc: string; start: number; end: number; empty: boolean }[] = [];
  const half = meter === 4 ? barSlots / 2 : 0;
  for (let from = firstBar; from + barSlots <= totalSlots || from < totalSlots; from += barSlots) {
    const to = Math.min(from + barSlots, totalSlots);
    if (to - from < barSlots) break;
    const state = [...sig.alter].map(() => new Map<number, number>()); // altérations en cours dans la mesure
    let abc = '';
    let k = from;
    let empty = true;
    while (k < to) {
      // fin de l'événement : changement de note, nouvelle attaque, accord, milieu de mesure (sauf note commencée au 1er temps)
      let j = k + 1;
      while (j < to && pitch[j] === pitch[k] && !onset[j] && !chordAt.has(j) && !(j - from === half && k !== from)) j++;
      const chord = chordAt.get(k);
      if (chord) abc += `"${chord.replace(/"/g, '')}"`;
      const parts = splitLength(j - k);
      if (pitch[k] < 0) {
        abc += parts.map((p) => `z${p === 1 ? '' : p}`).join('');
      } else {
        empty = false;
        const s = spell(pitch[k], sig);
        const cur = state[s.letter].get(s.octave) ?? sig.alter[s.letter];
        const acc = cur === s.alter ? '' : ACC[s.alter];
        state[s.letter].set(s.octave, s.alter);
        if (input.noteNames && onset[k]) abc += `"_${frenchName(s)}"`;
        abc += parts.map((p, i) => `${i === 0 ? acc : ''}${abcPitch(s)}${p === 1 ? '' : p}`).join('-');
        // la note continue dans l'événement suivant (accord, demi-mesure ou mesure suivante) : liaison
        if (j < totalSlots && pitch[j] === pitch[k] && !onset[j]) abc += '-';
      }
      // groupes de croches par temps
      if ((j - from) % SUB === 0) abc += ' ';
      k = j;
    }
    bars.push({ from, abc: abc.trim(), start: slotTime(grid, from), end: slotTime(grid, to), empty });
  }
  // pas de mesures vides au tout début ni à la fin
  while (bars.length && bars[0].empty && !chordAt.has(bars[0].from)) bars.shift();
  while (bars.length && bars[bars.length - 1].empty) bars.pop();

  // 4. lignes de portée : une par ligne de paroles quand il y en a, au plus `barsPerSystem` mesures
  const maxBars = input.barsPerSystem ?? 4;
  const lines = (input.lines ?? []).filter((l) => l.text.trim());
  const barLen = bars.length ? bars[0].end - bars[0].start : 2;
  const startsLine = (b: (typeof bars)[number]) => lines.some((l) => l.start >= b.start - barLen / 2 && l.start < b.end - barLen / 2);
  const systems: ScoreSystem[] = [];
  let cur: typeof bars = [];
  const flush = () => {
    if (!cur.length) return;
    const start = cur[0].start;
    const end = cur[cur.length - 1].end;
    const text = lines
      .filter((l) => l.start >= start - barLen / 2 && l.start < end - barLen / 2)
      .map((l) => l.text.trim())
      .join(' / ');
    systems.push({ abc: `${cur.map((b) => b.abc).join(' | ')} |`, bars: cur.map((b) => ({ start: b.start, end: b.end })), start, end, text });
    cur = [];
  };
  for (const b of bars) {
    if (cur.length >= maxBars || (cur.length && startsLine(b))) flush();
    cur.push(b);
  }
  flush();

  const notes = input.notes.map((n) => n.midi).sort((a, b) => a - b);
  const median = notes.length ? notes[Math.floor(notes.length / 2)] : 67;
  const clef = median < 55 ? 'bass' : 'treble';
  return {
    header: `M:${meter}/4\nL:1/8\nK:${sig.name} clef=${clef}\n`,
    meter,
    keyLabel: sig.name,
    clef,
    systems,
    noteCount,
  };
}

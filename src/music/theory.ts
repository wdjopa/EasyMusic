// Notions de base : notes, accords, transposition.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const FRENCH_NAMES = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'm7' | 'dim' | 'sus2' | 'sus4';

/** Intervalles (en demi-tons depuis la fondamentale) de chaque qualité d'accord. */
export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};

export const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  dim: 'dim',
  sus2: 'sus2',
  sus4: 'sus4',
};

export interface Chord {
  root: number; // 0..11, 0 = Do
  quality: ChordQuality;
}

export const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** Tonalités qui s'écrivent de préférence avec des bémols. */
const FLAT_KEYS_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_KEYS_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

export function preferFlats(key?: Key): boolean {
  if (!key) return false;
  return key.mode === 'major' ? FLAT_KEYS_MAJOR.has(key.tonic) : FLAT_KEYS_MINOR.has(key.tonic);
}

export function noteName(pc: number, flats = false, french = false): string {
  const i = mod12(pc);
  if (french) {
    const n = FRENCH_NAMES[i];
    return flats && n.endsWith('#') ? FRENCH_NAMES[mod12(i + 1)] + 'b' : n;
  }
  return (flats ? FLAT_NAMES : SHARP_NAMES)[i];
}

export function chordName(c: Chord | null, flats = false): string {
  if (!c) return 'N.C.';
  return noteName(c.root, flats) + QUALITY_SUFFIX[c.quality];
}

export function transposeChord(c: Chord, semitones: number): Chord {
  return { root: mod12(c.root + semitones), quality: c.quality };
}

export function sameChord(a: Chord | null, b: Chord | null): boolean {
  if (!a || !b) return a === b;
  return a.root === b.root && a.quality === b.quality;
}

// ---- Hauteurs ----------------------------------------------------------

export function freqToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** 60 -> "Do4 (C4)" */
export function midiName(m: number): string {
  const r = Math.round(m);
  const octave = Math.floor(r / 12) - 1;
  return `${FRENCH_NAMES[mod12(r)]}${octave} (${SHARP_NAMES[mod12(r)]}${octave})`;
}

// ---- Tonalité -----------------------------------------------------------

export interface Key {
  tonic: number;
  mode: 'major' | 'minor';
}

export function keyName(k: Key, flats?: boolean): string {
  const f = flats ?? preferFlats(k);
  return `${noteName(k.tonic, f)} ${k.mode === 'major' ? 'majeur' : 'mineur'} (${noteName(k.tonic, f, true)} ${
    k.mode === 'major' ? 'majeur' : 'mineur'
  })`;
}

export function transposeKey(k: Key, semitones: number): Key {
  return { tonic: mod12(k.tonic + semitones), mode: k.mode };
}

// ---- Tessiture ----------------------------------------------------------

export interface Range {
  low: number; // MIDI
  high: number; // MIDI
}

export const VOICE_TYPES: { id: string; label: string; range: Range }[] = [
  { id: 'basse', label: 'Basse', range: { low: 40, high: 64 } }, // E2–E4
  { id: 'baryton', label: 'Baryton', range: { low: 45, high: 67 } }, // A2–G4
  { id: 'tenor', label: 'Ténor', range: { low: 48, high: 72 } }, // C3–C5
  { id: 'alto', label: 'Alto / Contralto', range: { low: 53, high: 77 } }, // F3–F5
  { id: 'mezzo', label: 'Mezzo-soprano', range: { low: 57, high: 81 } }, // A3–A5
  { id: 'soprano', label: 'Soprano', range: { low: 60, high: 84 } }, // C4–C6
];

export interface TranspositionPlan {
  /** Décalage de tonalité (audio et accords), en demi-tons. */
  semitones: number;
  /** Octave dans laquelle le chanteur chante par rapport à l'original (-12, 0 ou +12). */
  octave: number;
}

/**
 * Évalue un placement de la mélodie dans la voix : plus le score est bas, mieux c'est.
 * - débordement hors de la tessiture : très pénalisé ;
 * - notes à moins d'un demi-ton des extrêmes : pénalisé (confort) ;
 * - grand changement de tonalité ou changement d'octave : légèrement pénalisé.
 */
export function placementScore(song: Range, voice: Range, semitones: number, octave = 0): number {
  const lo = song.low + semitones + octave;
  const hi = song.high + semitones + octave;
  const overflow = Math.max(0, voice.low - lo) + Math.max(0, hi - voice.high);
  const tight = Math.max(0, voice.low + 1 - lo) + Math.max(0, hi - (voice.high - 1));
  const centerDist = Math.abs((lo + hi) / 2 - (voice.low + voice.high) / 2);
  return overflow * 100 + tight * 10 + Math.abs(semitones) + (octave ? 2 : 0) + centerDist * 0.25;
}

/**
 * Trouve la transposition qui place le mieux la mélodie dans la voix.
 * Chanter une octave plus bas/haut que l'original (ex. un homme sur une chanson
 * de femme) ne demande pas de changer la tonalité : seul le reste est transposé.
 */
export function planTransposition(song: Range, voice: Range, maxShift = 7, allowOctave = true): TranspositionPlan {
  let best: TranspositionPlan = { semitones: 0, octave: 0 };
  let bestScore = Infinity;
  for (const octave of allowOctave ? [0, -12, 12] : [0]) {
    for (let s = -maxShift; s <= maxShift; s++) {
      const score = placementScore(song, voice, s, octave);
      if (score < bestScore - 1e-9) {
        bestScore = score;
        best = { semitones: s, octave };
      }
    }
  }
  return best;
}

/** Décalage seul (sans changement d'octave), entre -maxShift et +maxShift. */
export function bestTransposition(song: Range, voice: Range, maxShift = 12): number {
  return planTransposition(song, voice, maxShift, false).semitones;
}

/** Choisit l'octave la plus confortable pour un décalage de tonalité donné. */
export function bestOctave(song: Range, voice: Range, semitones: number): number {
  return [0, -12, 12].reduce((b, o) => (placementScore(song, voice, semitones, o) < placementScore(song, voice, semitones, b) ? o : b), 0);
}

/** Simplifie un accord en triade (pour débutants). */
export function simplifyChord(c: Chord): Chord {
  const map: Partial<Record<ChordQuality, ChordQuality>> = { '7': 'maj', maj7: 'maj', m7: 'min', sus2: 'maj', sus4: 'maj' };
  return { root: c.root, quality: map[c.quality] ?? c.quality };
}

// ---- Capodastre ---------------------------------------------------------

/** Accords « faciles » (formes ouvertes) à la guitare. */
const EASY_SHAPES = new Set([
  'C', 'D', 'E', 'G', 'A', 'Am', 'Dm', 'Em', 'A7', 'B7', 'C7', 'D7', 'E7', 'G7',
  'Am7', 'Em7', 'Dm7', 'Cmaj7', 'Dmaj7', 'Fmaj7', 'Amaj7', 'Gmaj7', 'Dsus2', 'Dsus4', 'Asus2', 'Asus4', 'Esus4',
]);
const MEDIUM_SHAPES = new Set(['F', 'Bm', 'Fm', 'B', 'Bm7', 'F#m', 'Bb', 'Cm', 'Gm', 'F7']);

export function chordDifficulty(c: Chord): number {
  const n = chordName(c, false);
  if (EASY_SHAPES.has(n)) return 0;
  if (MEDIUM_SHAPES.has(n)) return 1;
  return 2;
}

export interface CapoSuggestion {
  capo: number;
  shapes: Chord[]; // formes à jouer avec le capo
  difficulty: number;
}

/**
 * Pour une liste d'accords (avec poids = durée), trouve la position de capo
 * (0..7) qui permet de jouer avec les formes les plus simples.
 */
export function suggestCapo(chords: { chord: Chord; weight: number }[], maxCapo = 7): CapoSuggestion[] {
  const out: CapoSuggestion[] = [];
  for (let capo = 0; capo <= maxCapo; capo++) {
    let diff = 0;
    const seen = new Map<string, Chord>();
    for (const { chord, weight } of chords) {
      const shape = transposeChord(chord, -capo);
      diff += chordDifficulty(shape) * weight;
      seen.set(chordName(shape), shape);
    }
    out.push({ capo, shapes: [...seen.values()], difficulty: diff + capo * 0.02 });
  }
  return out.sort((a, b) => a.difficulty - b.difficulty);
}

import type { AnalysisResult } from '../dsp/analyze';

export interface MelodyNote {
  start: number; // s
  end: number;
  midi: number;
}

/**
 * Transforme la mélodie estimée (une note par trame) en notes à chanter : trames identiques regroupées,
 * micro-trous comblés, notes trop brèves écartées. `shift` transpose (tonalité jouée).
 */
export function melodyNotes(a: AnalysisResult, shift = 0, minDur = 0.12): MelodyNote[] {
  const m = a.melody;
  const step = a.melodyStep;
  if (!m?.length || !step) return [];
  const off = (a.melodyOffset ?? 0) - step / 2;
  const out: MelodyNote[] = [];
  let cur: MelodyNote | null = null;
  let gap = 0;
  for (let i = 0; i < m.length; i++) {
    const v = m[i];
    if (cur && v === cur.midi - shift) {
      cur.end = off + (i + 1) * step;
      gap = 0;
      continue;
    }
    // un trou d'une trame dans une note tenue ne la coupe pas
    if (cur && !v && gap === 0 && m[i + 1] === cur.midi - shift) {
      gap = 1;
      continue;
    }
    if (cur && cur.end - cur.start >= minDur) out.push(cur);
    cur = v ? { start: off + i * step, end: off + (i + 1) * step, midi: v + shift } : null;
    gap = 0;
  }
  if (cur && cur.end - cur.start >= minDur) out.push(cur);
  return out;
}

/** Octave d'affichage (en demi-tons, multiple de 12) qui place la mélodie dans la voix du chanteur. */
export function displayOctave(notes: MelodyNote[], voiceLow: number, voiceHigh: number): number {
  if (!notes.length) return 0;
  const sorted = notes.map((n) => n.midi).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  const center = (voiceLow + voiceHigh) / 2;
  return Math.max(-24, Math.min(24, Math.round((center - median) / 12) * 12));
}

/** Ramène une note chantée dans l'octave de la note attendue (l'octave ne compte pas pour la justesse). */
export function foldToOctave(midi: number, reference: number): number {
  return midi + Math.round((reference - midi) / 12) * 12;
}

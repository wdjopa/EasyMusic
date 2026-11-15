import { describe, expect, it } from 'vitest';
import { voicingsFor } from '../src/music/guitar';
import { bestTransposition, chordName, planTransposition, suggestCapo, transposeChord } from '../src/music/theory';

describe('théorie', () => {
  it('transpose les accords', () => {
    expect(chordName(transposeChord({ root: 9, quality: 'min' }, 3))).toBe('Cm');
    expect(chordName(transposeChord({ root: 0, quality: '7' }, -2), true)).toBe('Bb7');
  });

  it('trouve la meilleure transposition', () => {
    // chanson trop aiguë pour une voix de baryton : il faut descendre d'au moins 5 demi-tons
    const s = bestTransposition({ low: 55, high: 72 }, { low: 45, high: 67 });
    expect(s).toBeLessThanOrEqual(-5);
    expect(s).toBeGreaterThanOrEqual(-10); // 55-10 = 45, limite basse
    // déjà dans la tessiture : petit ajustement de centrage au plus
    expect(Math.abs(bestTransposition({ low: 50, high: 62 }, { low: 45, high: 67 }))).toBeLessThanOrEqual(1);
  });

  it('propose de chanter une octave plus bas plutôt que de transposer d’une octave', () => {
    // chanson de soprano (Sol4–La5) pour un baryton (La2–Sol4)
    const plan = planTransposition({ low: 67, high: 81 }, { low: 45, high: 67 });
    expect(plan.octave).toBe(-12);
    expect(Math.abs(plan.semitones)).toBeLessThanOrEqual(7);
    const lo = 67 + plan.semitones + plan.octave;
    const hi = 81 + plan.semitones + plan.octave;
    expect(lo).toBeGreaterThanOrEqual(45);
    expect(hi).toBeLessThanOrEqual(67);
  });

  it('ne change rien quand la chanson convient déjà', () => {
    expect(planTransposition({ low: 50, high: 62 }, { low: 45, high: 67 })).toEqual({ semitones: 0, octave: 0 });
  });

  it('suggère un capo pour jouer des formes simples', () => {
    // Eb Cm Ab Bb -> capo 3 : C Am F G (F reste un barré « moyen »)
    const chords = [
      { root: 3, quality: 'maj' as const },
      { root: 0, quality: 'min' as const },
      { root: 8, quality: 'maj' as const },
      { root: 10, quality: 'maj' as const },
    ].map((chord) => ({ chord, weight: 1 }));
    const best = suggestCapo(chords)[0];
    expect([1, 3]).toContain(best.capo);
  });

  it('fournit un doigté pour tous les accords', () => {
    for (let r = 0; r < 12; r++)
      for (const q of ['maj', 'min', '7', 'm7', 'maj7', 'sus2', 'sus4', 'dim'] as const)
        expect(voicingsFor({ root: r, quality: q }).length).toBeGreaterThan(0);
  });
});

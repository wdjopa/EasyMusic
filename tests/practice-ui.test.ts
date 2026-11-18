import { describe, expect, it } from 'vitest';
import { diagnoseVoicing } from '../src/music/guitar';
import { displayOctave, foldToOctave, melodyNotes } from '../src/music/melody';

describe('doigté : cordes entendues', () => {
  it('repère la corde de Sol à vide muette dans un Do', () => {
    // Do : x 3 2 0 1 0 -> notes Do, Mi, Sol, Do, Mi ; le Sol n'est pas entendu
    const r = diagnoseVoicing([-1, 3, 2, 0, 1, 0], 0, new Set([0, 4]));
    expect(r.status).toEqual([null, 'heard', 'heard', 'missing', 'heard', 'heard']);
    expect(r.missing).toEqual([{ string: 3, fret: 0, pc: 7 }]);
  });

  it('tient compte du capo', () => {
    // forme de Sol (3 2 0 0 0 3) capo 2 -> sonne La : La, Do♯, Mi
    const r = diagnoseVoicing([3, 2, 0, 0, 0, 3], 2, new Set([9, 1, 4]));
    expect(r.missing).toEqual([]);
  });
});

describe('mélodie à chanter', () => {
  const analysis = {
    duration: 3,
    key: { tonic: 0, mode: 'major' as const },
    segments: [],
    melodyRange: null,
    melodyStep: 0.1,
    melodyOffset: 0.05,
    // Mi tenu (avec un trou d'une trame), silence, Sol, puis une note isolée trop brève
    melody: [64, 64, 64, 0, 64, 64, 0, 0, 67, 67, 67, 67, 0, 0, 72],
  };

  it('regroupe les trames en notes et ignore les notes trop brèves', () => {
    const n = melodyNotes(analysis);
    expect(n.map((x) => x.midi)).toEqual([64, 67]);
    expect(n[0].start).toBeCloseTo(0);
    expect(n[0].end).toBeCloseTo(0.6);
    expect(n[1].start).toBeCloseTo(0.8);
  });

  it('transpose et choisit l’octave de la voix', () => {
    const n = melodyNotes(analysis, -3);
    expect(n.map((x) => x.midi)).toEqual([61, 64]);
    expect(displayOctave(n, 45, 67)).toBe(-12); // baryton : une octave plus bas
    expect(foldToOctave(52, 64)).toBe(64);
    expect(foldToOctave(71, 64)).toBe(59);
  });
});

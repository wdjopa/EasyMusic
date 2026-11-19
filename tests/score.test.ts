import { describe, expect, it } from 'vitest';
import { beatGrid, buildScore, keySignature, spell, splitLength } from '../src/music/score';

const beats = Array.from({ length: 40 }, (_, i) => i * 0.5); // 120 BPM

describe('armure et orthographe', () => {
  it('Sol majeur : un dièse (fa)', () => {
    const k = keySignature({ tonic: 7, mode: 'major' });
    expect(k.name).toBe('G');
    expect(k.alter).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });
  it('Fa majeur s’écrit avec si bémol, Ré mineur aussi', () => {
    expect(keySignature({ tonic: 5, mode: 'major' }).alter[6]).toBe(-1);
    const dm = keySignature({ tonic: 2, mode: 'minor' });
    expect(dm.name).toBe('Dm');
    expect(dm.alter[6]).toBe(-1);
  });
  it('notes étrangères : bécarre, sinon dièse ou bémol selon la tonalité', () => {
    const g = keySignature({ tonic: 7, mode: 'major' });
    expect(spell(65, g)).toEqual({ letter: 3, alter: 0, octave: 4 }); // fa bécarre
    expect(spell(61, g)).toEqual({ letter: 0, alter: 1, octave: 4 }); // do dièse
    const f = keySignature({ tonic: 5, mode: 'major' });
    expect(spell(63, f)).toEqual({ letter: 2, alter: -1, octave: 4 }); // mi bémol
  });
  it('durées découpées en valeurs écrivables', () => {
    expect(splitLength(5)).toEqual([4, 1]);
    expect(splitLength(7)).toEqual([6, 1]);
    expect(splitLength(8)).toEqual([8]);
  });
});

describe('partition', () => {
  const chords = [0, 2, 4, 6].map((t, i) => ({ start: t, name: ['C', 'G', 'Am', 'F'][i] }));
  it('cale les notes sur les temps : noires et blanches, accords au-dessus', () => {
    const notes = [
      { start: 0.02, end: 0.48, midi: 60 },
      { start: 0.5, end: 0.97, midi: 62 },
      { start: 1.0, end: 1.98, midi: 64 },
      { start: 2.03, end: 3.95, midi: 67 },
    ];
    const s = buildScore({ notes, beats, duration: 8, key: { tonic: 0, mode: 'major' }, chords });
    expect(s.header).toContain('K:C clef=treble');
    expect(s.systems[0].abc.startsWith('"C"C2 D2 E4 | "G"G8 |')).toBe(true);
  });
  it('liaison quand une note dépasse la mesure, altération écrite une fois par mesure', () => {
    const notes = [
      { start: 1.5, end: 2.5, midi: 61 },
      { start: 2.5, end: 3, midi: 61 },
    ];
    const s = buildScore({ notes, beats, duration: 8, key: { tonic: 0, mode: 'major' }, chords });
    const abc = s.systems[0].abc;
    expect(abc).toContain('^C2- |');
    expect(abc).toContain('"G"^C2 C2');
  });
  it('noms des notes en option', () => {
    const s = buildScore({ notes: [{ start: 0, end: 0.5, midi: 69 }], beats, duration: 8, key: { tonic: 0, mode: 'major' }, chords, noteNames: true });
    expect(s.systems[0].abc).toContain('"_La"A2');
  });
  it('une ligne de portée par ligne de paroles', () => {
    const notes = Array.from({ length: 16 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.45, midi: 60 + (i % 5) }));
    const s = buildScore({ notes, beats, duration: 8, key: { tonic: 0, mode: 'major' }, chords, lines: [{ start: 0, text: 'un' }, { start: 4, text: 'deux' }] });
    expect(s.systems.map((x) => x.text)).toEqual(['un', 'deux']);
    expect(s.systems[0].bars.length).toBe(2);
  });
  it('voix grave : clé de fa', () => {
    const notes = [{ start: 0, end: 1, midi: 48 }];
    expect(buildScore({ notes, beats, duration: 8, key: { tonic: 0, mode: 'major' }, chords }).clef).toBe('bass');
  });
  it('grille de secours à partir du tempo', () => {
    const g = beatGrid(undefined, 120, 4, 0);
    expect(g[1] - g[0]).toBeCloseTo(0.5);
    expect(g[g.length - 1]).toBeGreaterThanOrEqual(4);
  });
});

describe('nettoyage de la mélodie', async () => {
  const { cleanNotes } = await import('../src/music/score');
  it('une note brève hors gamme à un demi-ton est fondue dans la voisine', () => {
    const notes = [
      { start: 0, end: 0.9, midi: 62 },
      { start: 0.9, end: 1.1, midi: 63 },
    ];
    expect(cleanNotes(notes, { tonic: 0, mode: 'major' }, 0.5)).toEqual([{ start: 0, end: 1.1, midi: 62 }]);
  });
  it('une note de la gamme est gardée', () => {
    const notes = [
      { start: 0, end: 0.5, midi: 64 },
      { start: 0.5, end: 0.7, midi: 65 },
    ];
    expect(cleanNotes(notes, { tonic: 0, mode: 'major' }, 0.5)).toHaveLength(2);
  });
});

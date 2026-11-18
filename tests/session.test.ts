import { describe, expect, it } from 'vitest';
import { headline, SessionRecorder } from '../src/ui/session';

const passages = [
  { start: 0, end: 4, label: 'Loving can hurt', chords: 'D Bm' },
  { start: 4, end: 8, label: 'Loving can hurt sometimes', chords: 'Bm A G' },
  { start: 8, end: 12, label: 'But it’s the only thing', chords: 'D Bm' },
];

describe('bilan de séance', () => {
  it('note chaque passage et explique les difficultés', () => {
    const s = new SessionRecorder();
    for (let i = 0; i < 10; i++) s.recordChord(0, 'ok', { expected: 'D', late: false });
    for (let i = 0; i < 10; i++) s.recordVoice(0, true, 2, true);
    // passage 2 : changements d'accord en retard et voix trop haute
    for (let i = 0; i < 6; i++) s.recordChord(1, 'wrong', { expected: 'A', late: true });
    for (let i = 0; i < 4; i++) s.recordChord(1, 'ok', { expected: 'A', late: false });
    for (let i = 0; i < 8; i++) s.recordVoice(1, false, 40, false);
    for (let i = 0; i < 2; i++) s.recordVoice(1, true, 0, true);
    // passage 3 : corde muette
    for (let i = 0; i < 6; i++) s.recordChord(2, 'close', { expected: 'Bm', late: false, mutedString: 'la corde de Sol sur Bm' });
    for (let i = 0; i < 2; i++) s.recordChord(2, 'wrong', { expected: 'Bm', late: false });
    const r = s.report(passages);
    expect(r.map((x) => x.weak)).toEqual([false, true, true]);
    expect(r[0].chordScore).toBe(1);
    expect(r[1].tip).toBe('Changement d’accord en retard · Voix un peu haute');
    expect(r[2].tip).toBe('La corde de Sol sur Bm ne sonne pas');
    expect(s.totals().chords).toBe(Math.round(((10 + 4 + 3) / 28) * 100));
  });

  it('ignore les passages à peine effleurés', () => {
    const s = new SessionRecorder();
    s.recordChord(0, 'ok', { expected: 'D', late: false });
    expect(s.report(passages)).toEqual([]);
  });

  it('résume la séance en une phrase', () => {
    const s = new SessionRecorder();
    for (let i = 0; i < 6; i++) s.recordChord(1, 'wrong', { expected: 'A', late: false });
    const r = s.report(passages);
    expect(headline(r, { chords: 40, voice: null }, { date: '', chords: 20, voice: null, minutes: 3 })).toBe(
      'Vous progressez. Un passage à travailler, à commencer par « Loving can hurt sometimes ».',
    );
    expect(headline([], { chords: null, voice: null })).toMatch(/trop courte/);
  });
});

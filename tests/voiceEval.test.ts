import { describe, expect, it } from 'vitest';
import { cleanVoice, evaluateTake, pitchTrack, songTimeAt, type PitchFrame } from '../src/dsp/voiceEval';

const sr = 16000;
function sing(parts: { midi: number | null; dur: number; amp?: number }[], noise = 0.002): Float32Array {
  const total = parts.reduce((s, p) => s + p.dur, 0);
  const x = new Float32Array(Math.round(total * sr));
  let i = 0;
  let phase = 0;
  let seed = 1;
  for (const p of parts) {
    const n = Math.round(p.dur * sr);
    const f = p.midi ? 440 * 2 ** ((p.midi - 69) / 12) : 0;
    for (let k = 0; k < n; k++, i++) {
      seed = (seed * 16807) % 2147483647;
      const r = (seed / 2147483647 - 0.5) * 2 * noise;
      if (f) {
        phase += (2 * Math.PI * f) / sr;
        const a = p.amp ?? 0.2;
        x[i] = a * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase)) + r;
      } else x[i] = r;
    }
  }
  return x;
}

describe('évaluation d’une prise de chant', () => {
  it('trouve les notes chantées et ignore le bruit et les fragments trop courts', async () => {
    const audio = sing([
      { midi: null, dur: 0.5 },
      { midi: 60, dur: 0.8 },
      { midi: 72, dur: 0.06 }, // éclat bref : ignoré
      { midi: null, dur: 0.3 },
      { midi: 64, dur: 0.8 },
      { midi: null, dur: 0.5 },
    ]);
    const frames = await pitchTrack(audio, sr);
    const { notes } = cleanVoice(frames);
    expect(notes.map((n) => Math.round(n.midi))).toEqual([60, 64]);
    expect(notes[0].end - notes[0].start).toBeGreaterThan(0.6);
  });

  it('juge note par note : juste, trop bas, oubliée, octave libre', () => {
    const expected = [
      { start: 0, end: 1, midi: 60 },
      { start: 1, end: 2, midi: 62 },
      { start: 2, end: 3, midi: 64 },
      { start: 3, end: 4, midi: 65 },
      { start: 4, end: 4.1, midi: 67 }, // trop brève : pas jugée
    ];
    const sung: { songT: number; midi: number }[] = [];
    for (let t = 0; t < 1; t += 0.02) sung.push({ songT: t, midi: 72.2 }); // juste, une octave au-dessus
    for (let t = 1; t < 2; t += 0.02) sung.push({ songT: t, midi: 60.7 }); // trop bas
    for (let t = 3; t < 4; t += 0.02) sung.push({ songT: t, midi: 65.6 }); // presque
    const { notes, summary } = evaluateTake(expected, sung, { start: 0, end: 5 });
    expect(notes.map((n) => n.verdict)).toEqual(['ok', 'flat', 'missed', 'close']);
    expect(summary).toMatchObject({ judged: 4, ok: 1, flat: 1, missed: 1, close: 1 });
    expect(summary.score).toBe(38);
  });

  it('suit pauses et retours en arrière pour placer la voix dans le morceau', () => {
    const tl = [
      { rec: 0, song: 10, playing: true, rate: 1 },
      { rec: 5, song: 15, playing: false, rate: 1 },
      { rec: 8, song: 2, playing: true, rate: 0.75 },
    ];
    expect(songTimeAt(tl, 2)).toBeCloseTo(12);
    expect(songTimeAt(tl, 6)).toBeNull(); // en pause
    expect(songTimeAt(tl, 12)).toBeCloseTo(5);
  });

  it('on chante sans arrêt : la voix n’est pas prise pour du bruit de fond', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 300; i++) frames.push({ t: i * 0.02, midi: i < 150 ? 60 : 62, prob: 0.95, rms: 0.05 });
    expect(cleanVoice(frames).notes.map((n) => Math.round(n.midi))).toEqual([60, 62]);
  });

  it('pièce bruyante : le seuil s’adapte au bruit de fond', () => {
    const frames: PitchFrame[] = [];
    for (let i = 0; i < 200; i++) frames.push({ t: i * 0.02, midi: i % 7 === 0 ? 50 + (i % 13) : null, prob: 0.8, rms: 0.01 }); // bruit
    for (let i = 200; i < 260; i++) frames.push({ t: i * 0.02, midi: 67, prob: 0.95, rms: 0.08 }); // voix
    const { notes } = cleanVoice(frames);
    expect(notes).toHaveLength(1);
    expect(Math.round(notes[0].midi)).toBe(67);
  });
});

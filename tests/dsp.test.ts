import { describe, expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { pitchShift } from '../src/dsp/pitchshift';
import { yin } from '../src/dsp/yin';
import { chordName } from '../src/music/theory';
import { dominantFreq, synthChords } from './helpers';

describe('reconnaissance des accords', () => {
  it('retrouve une progression C – Am – F – G', () => {
    const sr = 22050;
    const seq = [
      { root: 0, quality: 'maj' as const },
      { root: 9, quality: 'min' as const },
      { root: 5, quality: 'maj' as const },
      { root: 7, quality: 'maj' as const },
    ];
    const audio = synthChords([...seq, ...seq], 2, sr);
    const res = analyze([audio], sr);
    const names = res.segments.filter((s) => s.end - s.start > 1).map((s) => chordName(s.chord));
    expect(names).toEqual(['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'G']);
    expect(res.key).toEqual({ tonic: 0, mode: 'major' });
  });

  it('reconnaît accords mineurs et de septième', () => {
    const sr = 22050;
    const seq = [
      { root: 2, quality: 'min' as const },
      { root: 7, quality: '7' as const },
      { root: 0, quality: 'maj7' as const },
      { root: 4, quality: 'min' as const },
    ];
    const res = analyze([synthChords(seq, 2.5, sr)], sr);
    const names = res.segments.filter((s) => s.end - s.start > 1).map((s) => chordName(s.chord));
    expect(names).toEqual(['Dm', 'G7', 'Cmaj7', 'Em']);
  });
});

describe('transposition audio', () => {
  it.each([3, -4, 7])('décale un La 440 de %i demi-tons sans changer la durée', (semi) => {
    const sr = 22050;
    const x = new Float32Array(sr * 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
    const y = pitchShift(x, semi);
    expect(y.length).toBe(x.length);
    const f = dominantFreq(y, sr);
    expect(f).toBeGreaterThan(440 * Math.pow(2, (semi - 0.3) / 12));
    expect(f).toBeLessThan(440 * Math.pow(2, (semi + 0.3) / 12));
  });
});

describe('YIN', () => {
  it('détecte la hauteur d’une voix synthétique', () => {
    const sr = 44100;
    const buf = new Float32Array(2048);
    const f0 = 196; // Sol3
    for (let i = 0; i < buf.length; i++) {
      const t = i / sr;
      buf[i] = 0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.2 * Math.sin(4 * Math.PI * f0 * t) + 0.1 * Math.sin(6 * Math.PI * f0 * t);
    }
    const r = yin(buf, sr);
    expect(r).not.toBeNull();
    expect(Math.abs(r!.freq - f0)).toBeLessThan(1);
  });
});

describe('estimation de la tessiture de la mélodie', () => {
  it('retrouve approximativement la plage d’une mélodie au-dessus des accords', async () => {
    const { tone } = await import('./helpers');
    const { midiToFreq } = await import('../src/music/theory');
    const sr = 22050;
    const seq = [
      { root: 0, quality: 'maj' as const },
      { root: 9, quality: 'min' as const },
      { root: 5, quality: 'maj' as const },
      { root: 7, quality: 'maj' as const },
    ];
    const audio = synthChords([...seq, ...seq], 2, sr);
    const melody = [64, 67, 69, 72, 71, 69, 67, 65, 64, 62, 60, 62, 64, 67, 72, 74];
    melody.forEach((m, i) => tone(audio, sr, midiToFreq(m), i * 1, 1, 0.35));
    const res = analyze([audio], sr);
    expect(res.melodyRange).not.toBeNull();
    expect(Math.abs(res.melodyRange!.low - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(res.melodyRange!.high - 74)).toBeLessThanOrEqual(2);
  });
});

describe('accords avec une mélodie forte par-dessus', () => {
  it('retrouve G – D – Em – C (forme simplifiée) malgré les notes de la mélodie', async () => {
    const { tone } = await import('./helpers');
    const { midiToFreq, simplifyChord, sameChord } = await import('../src/music/theory');
    const sr = 22050;
    const seq = [
      { root: 7, quality: 'maj' as const },
      { root: 2, quality: 'maj' as const },
      { root: 4, quality: 'min' as const },
      { root: 0, quality: 'maj' as const },
    ];
    const a = synthChords([...seq, ...seq, ...seq], 2, sr);
    const mel = [71, 74, 76, 79, 78, 76, 74, 71, 72, 74, 76, 74, 71, 67, 69, 71, 74, 76, 79, 81, 79, 76, 74, 71];
    mel.forEach((m, i) => tone(a, sr, midiToFreq(m), i, 1, 0.35));
    const names: string[] = [];
    let last: ReturnType<typeof simplifyChord> | null = null;
    for (const s of analyze([a], sr).segments) {
      const c = s.chord ? simplifyChord(s.chord) : null;
      if (!sameChord(c, last)) names.push(chordName(c));
      last = c;
    }
    expect(names).toEqual(['G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C', 'G', 'D', 'Em', 'C']);
  });
});

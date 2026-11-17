import { describe, expect, it } from 'vitest';
import { analyzeLiveFrame, judgeChord, judgeVoice } from '../src/dsp/live';
import { chordName, midiToFreq, QUALITY_INTERVALS, type ChordQuality } from '../src/music/theory';

const SR = 48000;

/** Accord de guitare synthétique (6 notes avec harmoniques), éventuellement avec une voix par-dessus. */
function strum(root: number, quality: ChordQuality, voiceMidi?: number, len = 8192): Float32Array {
  const out = new Float32Array(len);
  const notes = [40 + ((root - 4 + 12) % 12), ...QUALITY_INTERVALS[quality].map((iv) => 52 + ((root + iv - 4 + 12) % 12)), ...QUALITY_INTERVALS[quality].map((iv) => 59 + ((root + iv - 11 + 12) % 12))];
  for (const m of notes) {
    const f = midiToFreq(m);
    for (let i = 0; i < len; i++) for (let h = 1; h <= 5; h++) out[i] += (0.04 / h) * Math.sin((2 * Math.PI * f * h * i) / SR);
  }
  if (voiceMidi) {
    const f = midiToFreq(voiceMidi);
    for (let i = 0; i < len; i++) for (let h = 1; h <= 4; h++) out[i] += (0.12 / h) * Math.sin((2 * Math.PI * f * h * i) / SR);
  }
  return out;
}

function sung(freq: number, len = 4096) {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) for (let h = 1; h <= 4; h++) out[i] += (0.2 / h) * Math.sin((2 * Math.PI * freq * h * i) / SR);
  return out;
}

describe('écoute en direct', () => {
  it.each([
    [7, 'maj'],
    [2, 'maj'],
    [4, 'min'],
    [0, 'maj'],
    [9, 'min'],
  ] as const)('reconnaît un accord joué (%i %s)', (root, q) => {
    const f = analyzeLiveFrame(strum(root, q), SR, 'instrument');
    expect(chordName(f.chord)).toBe(chordName({ root, quality: q }));
  });

  it('reconnaît l’accord ET la note chantée en même temps', () => {
    const f = analyzeLiveFrame(strum(7, 'maj', 71), SR, 'both'); // G + voix sur Si4
    expect(chordName(f.chord)).toBe('G');
    expect(Math.round(f.pitch!.midi)).toBe(71);
  });

  it('mesure la justesse de la voix', () => {
    const f = analyzeLiveFrame(sung(midiToFreq(64) * Math.pow(2, 30 / 1200)), SR, 'voice'); // Mi4 + 30 cents
    expect(Math.round(f.pitch!.midi)).toBe(64);
    expect(f.pitch!.cents).toBeGreaterThan(20);
    expect(f.pitch!.cents).toBeLessThan(40);
  });

  it('ne détecte rien dans le silence', () => {
    const f = analyzeLiveFrame(new Float32Array(8192), SR, 'both');
    expect(f.chord).toBeNull();
    expect(f.pitch).toBeNull();
  });

  it('juge l’accord joué', () => {
    expect(judgeChord({ root: 7, quality: '7' }, { root: 7, quality: 'maj' })).toBe('ok'); // G7 pour G : accepté
    expect(judgeChord({ root: 4, quality: 'min' }, { root: 7, quality: 'maj' })).toBe('close'); // Em pour G : 2 notes communes
    expect(judgeChord({ root: 2, quality: 'maj' }, { root: 0, quality: 'maj' })).toBe('wrong');
    expect(judgeChord(null, { root: 0, quality: 'maj' })).toBe('silent');
  });

  it('juge la voix : mélodie (octave libre), accord, gamme, hors tonalité', () => {
    const key = { tonic: 7, mode: 'major' as const }; // Sol majeur
    const G = { root: 7, quality: 'maj' as const };
    expect(judgeVoice(59, 71, G, key).fit).toBe('melody'); // Si3 alors que la mélodie est Si4
    expect(judgeVoice(62, 71, G, key).fit).toBe('chord'); // Ré : dans l'accord de G
    expect(judgeVoice(64, null, G, key).fit).toBe('scale'); // Mi : dans la gamme
    expect(judgeVoice(63, null, G, key).fit).toBe('outside'); // Ré# : hors tonalité
    expect(judgeVoice(64.4, null, G, key).inTune).toBe(false);
  });
});

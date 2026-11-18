import { describe, expect, it } from 'vitest';
import { analyzeLiveFrame, heardChordTones, judgeChord, judgeVoice } from '../src/dsp/live';
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

describe('notes de l’accord entendues', () => {
  const C = { root: 0, quality: 'maj' as const };
  const frame = (levels: Record<number, number>) => Array.from({ length: 12 }, (_, i) => levels[i] ?? 0);
  it('ne prend pas l’harmonique pour la quinte jouée', () => {
    // Do avec la corde de Sol muette : le Sol n'existe que par les harmoniques du Do (≈ 0,5)
    const muted = Array.from({ length: 5 }, () => frame({ 0: 0.62, 4: 1, 7: 0.53 }));
    expect([...heardChordTones(muted, C).heard].sort()).toEqual([0, 4]);
    expect([...heardChordTones(muted, C).uncertain]).toEqual([7]); // jamais déclarée manquante
    const full = Array.from({ length: 5 }, () => frame({ 0: 0.7, 4: 1, 7: 0.85 }));
    expect([...heardChordTones(full, C).heard].sort()).toEqual([0, 4, 7]);
  });
  it('signale une tierce manquante (corde muette)', () => {
    const Em = { root: 4, quality: 'min' as const };
    const f = Array.from({ length: 5 }, () => frame({ 4: 1, 7: 0.12, 11: 0.8 }));
    const r = heardChordTones(f, Em);
    expect(r.heard.has(7)).toBe(false);
    expect(r.uncertain.has(7)).toBe(false); // la tierce est vérifiable : elle est bien manquante
  });

  it('compte une tierce jouée sur une seule corde', () => {
    const Em = { root: 4, quality: 'min' as const };
    const f = Array.from({ length: 5 }, () => frame({ 4: 1, 7: 0.38, 11: 0.73 }));
    expect([...heardChordTones(f, Em).heard].sort((a, b) => a - b)).toEqual([4, 7, 11]);
  });
  it('ignore une note de passage isolée', () => {
    const f = [frame({ 0: 1, 4: 0.9 }), frame({ 0: 1, 4: 0.9 }), frame({ 0: 1, 4: 0.9, 7: 0.9 }), frame({ 0: 1, 4: 0.9 }), frame({ 0: 1, 4: 0.9 })];
    expect(heardChordTones(f, C).heard.has(7)).toBe(false);
  });
});

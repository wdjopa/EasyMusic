import { describe, expect, it } from 'vitest';
import { cleanTranscript, dtwPreset, segmentStart } from '../server/whisper';

const seg = (from: number, text: string, tokens?: { text: string; t_dtw?: number }[]) => ({ offsets: { from, to: from + 1000 }, text, tokens });

describe('transcription par IA', () => {
  it('retire les hallucinations et les bruits', () => {
    const lines = cleanTranscript([
      seg(0, ' [Musique]'),
      seg(1000, ' ♪ Loving can hurt ♪'),
      seg(4000, ' (applaudissements)'),
      seg(6000, ' Merci d’avoir regardé ! Abonnez-vous'),
      seg(8000, ' Sous-titrage ST’ 501'),
      seg(9000, ' Thanks for watching!'),
      seg(12000, ' Loving can hurt sometimes'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Loving can hurt', 'Loving can hurt sometimes']);
  });

  it('coupe les boucles de répétition', () => {
    const lines = cleanTranscript(Array.from({ length: 8 }, (_, i) => seg(i * 1000, ' Na na na')));
    expect(lines.length).toBe(2);
  });

  it('prend l’horodatage précis du premier mot (DTW)', () => {
    expect(segmentStart(seg(0, ' And so', [{ text: '[_BEG_]', t_dtw: 0 }, { text: ' And', t_dtw: 446 }, { text: ' so', t_dtw: 490 }]))).toBeCloseTo(4.46);
    expect(segmentStart(seg(2500, ' Hey'))).toBe(2.5); // sans DTW : début du segment
  });

  it('déduit le réglage DTW du modèle', () => {
    expect(dtwPreset('/x/models/ggml-large-v3-turbo-q5_0.bin')).toBe('large.v3.turbo');
    expect(dtwPreset('models/ggml-small.bin')).toBe('small');
    expect(dtwPreset('ggml-base.en.bin')).toBe('base.en');
  });
});

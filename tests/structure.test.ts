import { expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { chordName, midiToFreq, simplifyChord } from '../src/music/theory';
import { frameAccuracy, realisticSong } from './realistic';
// Des passages perturbateurs (riff fort hors tonalité) ne doivent pas casser la cadence d'un morceau répétitif.
it('reste régulier malgré des passages perturbateurs (répétitions + régularisation des durées)', { timeout: 60000 }, () => {
  const sr = 22050;
  const bar = 2.0;
  const { audio, truth } = realisticSong({ progression: [{ chord: { root: 0, quality: 'maj' } }, { chord: { root: 9, quality: 'min' } }, { chord: { root: 5, quality: 'maj' } }, { chord: { root: 7, quality: 'maj' } }] as never, bars: 32, barSeconds: bar, sr, seed: 11, barsPerChord: 2 });
  // passages perturbateurs forts sur 3 mesures : riff en Si bémol majeur (hors tonalité)
  for (const b of [5, 18, 27]) {
    for (const m of [46, 58, 62, 65, 70]) {
      const f = midiToFreq(m);
      for (let i = 0; i < bar * sr; i++) {
        const t = i / sr;
        audio[Math.floor(b * bar * sr) + i] += 0.3 * Math.exp(-((t % 0.5) * 4)) * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t));
      }
    }
  }
  const r = analyze([audio], sr);
  const acc = frameAccuracy(r.segments, truth, simplifyChord);
  let last = '';
  const out: string[] = [];
  for (const s of r.segments) { const n = chordName(s.chord && simplifyChord(s.chord)); if (n !== last) out.push(`${n}@${s.start.toFixed(0)}`); last = n; }
  console.log(`précision ${(acc * 100).toFixed(1)} % ; ${out.length} accords (vérité ${truth.length})`);
  console.log(out.join(' '));
  expect(acc).toBeGreaterThan(0.95);
  expect(out.filter((x) => x.startsWith('A#'))).toEqual([]); // aucun accord parasite
  expect(out.length).toBeLessThanOrEqual(truth.length + 1); // + le silence final
});

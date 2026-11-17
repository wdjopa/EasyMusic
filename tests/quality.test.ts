import { expect, it } from 'vitest';
import { analyze } from '../src/dsp/analyze';
import { chordName, simplifyChord } from '../src/music/theory';
import { frameAccuracy, offGridChanges, realisticSong } from './realistic';

const songs = [
  // Ré♭ : Db Ab/C Bbm Gb (comme Someone You Loved)
  { name: 'Db I-V/3-vi-IV', prog: [{ chord: { root: 1, quality: 'maj' } }, { chord: { root: 8, quality: 'maj' }, bass: 0 }, { chord: { root: 10, quality: 'min' } }, { chord: { root: 6, quality: 'maj' } }], bar: 2.2, detune: 15 },
  { name: 'Am vi-IV-I-V', prog: [{ chord: { root: 9, quality: 'min' } }, { chord: { root: 5, quality: 'maj' } }, { chord: { root: 0, quality: 'maj' } }, { chord: { root: 7, quality: 'maj' } }], bar: 1.8, detune: -20 },
  { name: 'E I-IV-ii-V', prog: [{ chord: { root: 4, quality: 'maj' } }, { chord: { root: 9, quality: 'maj' } }, { chord: { root: 6, quality: 'min' } }, { chord: { root: 11, quality: 'maj' } }, { chord: { root: 1, quality: 'min' } }, { chord: { root: 9, quality: 'maj' } }, { chord: { root: 11, quality: 'maj' } }, { chord: { root: 4, quality: 'maj' } }], bar: 2.5, detune: 5 },
  { name: 'G rapide (1,2 s/accord)', prog: [{ chord: { root: 7, quality: 'maj' } }, { chord: { root: 2, quality: 'maj' } }, { chord: { root: 4, quality: 'min' } }, { chord: { root: 0, quality: 'maj' } }], bar: 1.2, detune: 0 },
  { name: 'Dm lent (3 s/accord)', prog: [{ chord: { root: 2, quality: 'min' } }, { chord: { root: 10, quality: 'maj' } }, { chord: { root: 5, quality: 'maj' } }, { chord: { root: 9, quality: 'maj' } }], bar: 3.0, detune: 10 },
  { name: 'C chargé (2 guitares + solo)', prog: [{ chord: { root: 0, quality: 'maj' } }, { chord: { root: 7, quality: 'maj' }, bass: 11 }, { chord: { root: 9, quality: 'min' } }, { chord: { root: 5, quality: 'maj' } }], bar: 2.0, detune: 0, busy: true },
  { name: 'Em chargé (2 guitares + solo)', prog: [{ chord: { root: 4, quality: 'min' } }, { chord: { root: 0, quality: 'maj' } }, { chord: { root: 7, quality: 'maj' } }, { chord: { root: 2, quality: 'maj' } }], bar: 2.4, detune: -10, busy: true },
  { name: 'Valse en G (3 temps)', prog: [{ chord: { root: 7, quality: 'maj' } }, { chord: { root: 0, quality: 'maj' } }, { chord: { root: 2, quality: 'maj' } }, { chord: { root: 7, quality: 'maj' } }, { chord: { root: 4, quality: 'min' } }, { chord: { root: 0, quality: 'maj' } }, { chord: { root: 2, quality: 'maj' } }, { chord: { root: 2, quality: 'maj' } }], bar: 1.8, detune: 0, beatsPerBar: 3 },
] as const;

// Qualité de la détection sur des morceaux de synthèse réalistes (batterie, voix, renversements, désaccordage).
it('détecte les accords (≥ 95 % en moyenne) en respectant la cadence des mesures', { timeout: 60000 }, () => {
  let sum = 0;
  let offTotal = 0;
  for (const s of songs) {
    const { audio, truth } = realisticSong({ progression: s.prog as never, bars: 24, barSeconds: s.bar, sr: 22050, detuneCents: s.detune, seed: 7, busy: 'busy' in s && s.busy, beatsPerBar: 'beatsPerBar' in s ? s.beatsPerBar : 4 });
    const res = analyze([audio], 22050);
    const acc = frameAccuracy(res.segments, truth, simplifyChord);
    const off = offGridChanges(res.segments, truth, simplifyChord);
    offTotal += off;
    sum += acc;
    const unsure = res.segments.filter((x) => x.confidence < 0.5).length;
    let simpleCount = 0;
    let last = '';
    for (const x of res.segments) { const n = chordName(x.chord && simplifyChord(x.chord)); if (n !== last) simpleCount++; last = n; }
    expect(acc, s.name).toBeGreaterThan(0.85);
    expect(simpleCount, s.name).toBeLessThanOrEqual(truth.length + 7); // peu d'accords parasites
    console.log(`${s.name} (${res.bpm} BPM): précision ${(acc * 100).toFixed(1)} %, ${simpleCount} accords affichés (vérité ${truth.length}), hors mesure ${off}, « ? » ${unsure}, tonalité ${res.key.tonic}/${res.key.mode}`);
  }
  console.log(`MOYENNE ${(sum / songs.length * 100).toFixed(1)} % — changements hors début de mesure : ${offTotal}`);
  expect(sum / songs.length).toBeGreaterThan(0.95);
  // la cadence est respectée : les accords changent en début de mesure
  expect(offTotal).toBeLessThanOrEqual(2);
});

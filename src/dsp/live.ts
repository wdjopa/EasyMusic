// Écoute en direct au micro : ce que l'on joue (accord) et ce que l'on chante (note), et comparaison.
import { type Chord, type Key, QUALITY_INTERVALS, freqToMidi, mod12, simplifyChord } from '../music/theory';
import { bassChromagram, chromagram } from './chroma';
import { chordCandidates } from './chords';
import { fft, hann } from './fft';
import { yin } from './yin';

export type PracticeMode = 'instrument' | 'voice' | 'both';

/** En dessous de ce niveau (RMS), on considère qu'il n'y a pas de son. */
export const SILENCE_RMS = 0.0025;

export interface LiveFrame {
  level: number; // niveau sonore (RMS)
  chord: Chord | null; // accord reconnu (null : silence ou trop flou)
  notes: number[]; // classes de hauteur les plus présentes
  pitch: { freq: number; midi: number; cents: number } | null; // note chantée
}

const windows = new Map<number, Float64Array>();

/** Analyse un bloc audio du micro (≈ 0,15 à 0,2 s). */
export function analyzeLiveFrame(buf: Float32Array, sr: number, mode: PracticeMode, key?: Key): LiveFrame {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  const out: LiveFrame = { level: rms, chord: null, notes: [], pitch: null };
  // seuil bas : le micro est lu sans contrôle automatique du gain, son niveau brut est souvent faible
  if (rms < SILENCE_RMS) return out;

  // spectre du bloc
  const n = 1 << Math.floor(Math.log2(buf.length));
  let w = windows.get(n);
  if (!w) windows.set(n, (w = hann(n)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const s0 = buf.length - n;
  for (let i = 0; i < n; i++) re[i] = buf[s0 + i] * w[i];
  fft(re, im);
  const mag = new Float32Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  const spec = { frames: [mag], sampleRate: sr, fftSize: n, hop: n };

  if (mode !== 'voice') {
    const chroma = chromagram(spec)[0];
    const bass = bassChromagram(spec)[0];
    const cands = chordCandidates(chroma, bass, key);
    // un accord n'est retenu que s'il ressort nettement (sinon : son trop flou ou une seule note)
    if (cands.length && cands[0].score - (cands.find((c) => simplifyChord(c.chord).root !== simplifyChord(cands[0].chord).root)?.score ?? 0) > 0.6)
      out.chord = cands[0].chord;
    const max = Math.max(...chroma);
    out.notes = [...chroma.keys()].filter((i) => chroma[i] > 0.45 * max);
  }

  if (mode === 'voice') {
    const r = yin(buf, sr, 70, 1100, 0.2);
    if (r && r.probability > 0.7) out.pitch = toPitch(r.freq);
  } else if (mode === 'both') {
    const f = predominantPitch(mag, sr, n);
    if (f) out.pitch = toPitch(f);
  }
  return out;
}

function toPitch(freq: number) {
  const midi = freqToMidi(freq);
  return { freq, midi, cents: Math.round((midi - Math.round(midi)) * 100) };
}

/**
 * Note la plus saillante dans le registre de la voix (sommation harmonique) :
 * utile quand on chante en jouant, la voix dépasse en général l'instrument dans le médium-aigu.
 */
export function predominantPitch(mag: Float32Array, sr: number, n: number): number | null {
  const binHz = sr / n;
  let total = 0;
  for (let k = 1; k < mag.length; k++) total += mag[k];
  const cands: { f0: number; s: number; fund: number }[] = [];
  for (let m = 48; m <= 84; m += 0.25) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    let s = 0;
    for (let h = 1; h <= 6; h++) {
      const k = Math.round((f0 * h) / binHz);
      if (k + 1 >= mag.length) break;
      s += Math.pow(0.8, h - 1) * Math.max(mag[k - 1], mag[k], mag[k + 1]);
    }
    const k0 = Math.round(f0 / binHz);
    cands.push({ f0, s, fund: Math.max(mag[k0 - 1], mag[k0], mag[k0 + 1]) });
  }
  const top = Math.max(...cands.map((c) => c.s));
  // parmi les candidats proches du meilleur, la fondamentale la plus forte (la voix domine le médium)
  let best = 0;
  let bestF = 0;
  let bestFund = -1;
  for (const c of cands) {
    if (c.s >= 0.6 * top && c.fund > bestFund) {
      bestFund = c.fund;
      bestF = c.f0;
      best = c.s;
    }
  }
  if (!bestF || best < 0.05 * total) return null;
  // affinage : pic parabolique autour de la fondamentale
  let k = Math.round(bestF / binHz);
  for (let d = -2; d <= 2; d++) if (mag[k + d] > mag[k]) k += d; // vrai pic le plus proche
  for (let d = -1; d <= 1; d++) if (mag[k + d] > mag[k]) k += d;
  const a = mag[k - 1];
  const b = mag[k];
  const c = mag[k + 1];
  const den = a - 2 * b + c;
  return den ? (k + (0.5 * (a - c)) / den) * binHz : bestF;
}

export type ChordVerdict = 'ok' | 'close' | 'wrong' | 'silent';

/** Compare l'accord joué à l'accord attendu (version simplifiée : on ne pénalise pas un 7 en plus). */
export function judgeChord(played: Chord | null, expected: Chord | null): ChordVerdict {
  if (!played) return 'silent';
  if (!expected) return 'ok';
  const a = simplifyChord(played);
  const b = simplifyChord(expected);
  if (a.root === b.root && a.quality === b.quality) return 'ok';
  const notes = (c: Chord) => new Set(QUALITY_INTERVALS[c.quality].map((iv) => mod12(c.root + iv)));
  const na = notes(a);
  let common = 0;
  for (const x of notes(b)) if (na.has(x)) common++;
  return common >= 2 ? 'close' : 'wrong';
}

export interface VoiceVerdict {
  inTune: boolean; // à moins de 25 cents d'une note
  /** Rapport à la musique : note de la mélodie, note de l'accord, note de la gamme, ou hors tonalité. */
  fit: 'melody' | 'chord' | 'scale' | 'outside';
  /** Note attendue de la mélodie (classe de hauteur), si connue. */
  expected: number | null;
}

export function judgeVoice(midi: number, expectedMelody: number | null, chord: Chord | null, key: Key | null): VoiceVerdict {
  const pc = mod12(Math.round(midi));
  const inTune = Math.abs(midi - Math.round(midi)) <= 0.25;
  const expected = expectedMelody ? mod12(expectedMelody) : null;
  const scale = key ? (key.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10, 11]).map((d) => mod12(d + key.tonic)) : [];
  let fit: VoiceVerdict['fit'] = 'outside';
  if (expected !== null && pc === expected) fit = 'melody'; // l'octave ne compte pas
  else if (chord && QUALITY_INTERVALS[chord.quality].some((iv) => mod12(chord.root + iv) === pc)) fit = 'chord';
  else if (scale.includes(pc)) fit = 'scale';
  return { inTune, fit, expected };
}

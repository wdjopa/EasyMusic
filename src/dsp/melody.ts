import { freqToMidi, type Range } from '../music/theory';
import type { Spectrogram } from './spectrum';

/**
 * Estime la tessiture de la mélodie principale (en général la voix) d'un mix.
 * Méthode : saillance par sommation harmonique sur une grille de demi-tons,
 * suivi de la fondamentale la plus saillante, puis percentiles 5 % / 95 %.
 * C'est une estimation : l'utilisateur peut l'ajuster.
 */
export function estimateMelodyRange(spec: Spectrogram, midiLow = 45, midiHigh = 84, isolatedVoice = false): (Range & { track: Float32Array }) | null {
  const { frames, sampleRate, fftSize } = spec;
  const binHz = sampleRate / fftSize;
  const nyq = sampleRate / 2;
  const cands: number[] = [];
  for (let m = midiLow; m <= midiHigh; m += 1 / 3) cands.push(m);
  const hWeights = [1, 0.8, 0.64, 0.51, 0.41, 0.33, 0.26, 0.21];

  const track = new Float32Array(frames.length).fill(NaN);
  const saliences: number[] = [];
  const raw: { m: number; s: number }[] = [];
  // saillance relative de chaque demi-tône, par trame (pour prolonger les notes tenues, voir plus bas)
  const semis: Float32Array[] = [];
  for (const mag of frames) {
    let best = -1;
    let bestS = 0;
    const candS: number[] = [];
    const candF: number[] = [];
    let total = 0;
    for (let k = 1; k < mag.length; k++) total += mag[k];
    let bandMax = 0;
    const k80 = Math.floor(80 / binHz);
    const k1200 = Math.ceil(1200 / binHz);
    for (let k = k80; k <= k1200; k++) bandMax = Math.max(bandMax, mag[k]);
    for (const m of cands) {
      const f0 = 440 * Math.pow(2, (m - 69) / 12);
      let s = 0;
      for (let h = 0; h < hWeights.length; h++) {
        const f = f0 * (h + 1);
        if (f > nyq * 0.95) break;
        const k = Math.round(f / binHz);
        s += hWeights[h] * Math.max(mag[k - 1], mag[k], mag[k + 1]);
      }
      // la fondamentale doit être présente (évite les erreurs à l'octave inférieure)
      const k0 = Math.round(f0 / binHz);
      const fund = Math.max(mag[k0 - 1], mag[k0], mag[k0 + 1]);
      s *= Math.sqrt(Math.min(1, fund / (0.25 * bandMax + 1e-12)));
      // légère préférence pour le registre vocal central
      s *= 1 - 0.004 * Math.abs(m - 62);
      candS.push(s);
      candF.push(fund);
      if (s > bestS) bestS = s;
    }
    // parmi les candidats proches du meilleur, garder celui dont la fondamentale est la plus forte
    let bestF = -1;
    for (let i = 0; i < cands.length; i++) {
      if (candS[i] >= 0.6 * bestS && candF[i] > bestF) {
        bestF = candF[i];
        best = cands[i];
      }
    }
    const rel = total > 0 ? bestS / total : 0;
    const semi = new Float32Array(midiHigh - midiLow + 1);
    if (total > 0) for (let i = 0; i < cands.length; i++) {
      const j = Math.round(cands[i] - midiLow);
      semi[j] = Math.max(semi[j], candS[i] / total);
    }
    semis.push(semi);
    raw.push({ m: best, s: rel });
    saliences.push(rel);
  }
  if (!raw.length) return null;
  const sortedS = [...saliences].sort((a, b) => a - b);
  const thr = sortedS[Math.floor(sortedS.length * 0.4)];
  // voix isolée : les silences entre les phrases ne sont que du bruit résiduel de la séparation ;
  // on les écarte par leur énergie (l'interprétation relative ci-dessus ne suffit pas)
  if (isolatedVoice) {
    const energy = spec.frames.map((mag) => mag.reduce((a, b) => a + b, 0));
    const loud = [...energy].sort((a, b) => a - b)[Math.floor(energy.length * 0.9)];
    energy.forEach((e, t) => {
      if (e < loud * 0.08) raw[t].s = 0;
    });
  }

  // filtrage médian sur 5 trames pour supprimer les erreurs ponctuelles
  const vals: number[] = [];
  for (let t = 0; t < raw.length; t++) {
    if (raw[t].s < thr || raw[t].m < 0) continue;
    const win: number[] = [];
    for (let u = Math.max(0, t - 2); u <= Math.min(raw.length - 1, t + 2); u++) if (raw[u].s >= thr) win.push(raw[u].m);
    win.sort((a, b) => a - b);
    const med = win[Math.floor(win.length / 2)];
    if (Math.abs(med - raw[t].m) < 1.5) {
      vals.push(raw[t].m);
      track[t] = raw[t].m;
    }
  }
  if (vals.length < 10) return null;
  sustainNotes(track, semis, raw, thr, midiLow, 1.5 / (spec.hop / sampleRate));
  vals.sort((a, b) => a - b);
  const low = Math.round(vals[Math.floor(vals.length * 0.05)]);
  const high = Math.round(vals[Math.floor(vals.length * 0.95)]);
  return { low, high, track };
}

/**
 * Hystérésis : une note chantée ne s'arrête pas dès qu'un accord plaqué la couvre. Tant que sa hauteur
 * reste bien présente (seuil plus bas que pour commencer une note), elle est prolongée (au plus `maxFrames`).
 */
function sustainNotes(track: Float32Array, semis: Float32Array[], raw: { m: number; s: number }[], thr: number, midiLow: number, maxFrames: number) {
  let cur = -1;
  let held = 0;
  for (let t = 0; t < track.length; t++) {
    if (Number.isFinite(track[t])) {
      cur = Math.round(track[t]);
      held = 0;
      continue;
    }
    if (cur < 0) continue;
    const v = semis[t][cur - midiLow] ?? 0;
    if (held < maxFrames && v >= 0.5 * thr && v >= 0.6 * raw[t].s) {
      track[t] = cur;
      held++;
    } else cur = -1;
  }
}

/** Tessiture à partir d'une liste de fréquences chantées (micro). */
export function rangeFromFrequencies(freqs: number[]): Range | null {
  if (freqs.length < 3) return null;
  const m = freqs.map(freqToMidi).sort((a, b) => a - b);
  return { low: Math.round(m[Math.floor(m.length * 0.03)]), high: Math.round(m[Math.floor(m.length * 0.97)]) };
}

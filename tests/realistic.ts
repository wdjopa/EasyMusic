// Morceau de synthèse « réaliste » pour mesurer la qualité de la détection d'accords :
// piano + basse (avec renversements), voix forte avec vibrato, batterie, léger désaccordage.
import { QUALITY_INTERVALS, type Chord, midiToFreq } from '../src/music/theory';

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export interface Truth {
  start: number;
  end: number;
  chord: Chord;
}

export function realisticSong(opts: {
  progression: { chord: Chord; bass?: number }[];
  bars: number;
  barSeconds: number;
  sr: number;
  detuneCents?: number;
  seed?: number;
  /** Arrangement chargé : 2e guitare en arpèges avec notes de passage, mélodie chromatique. */
  busy?: boolean;
  /** Temps par mesure (4 par défaut, 3 pour une valse). */
  beatsPerBar?: number;
  /** Probabilité qu'un accord soit anticipé d'une croche (attaqué avant la barre de mesure). */
  anticipation?: number;
  /** Nombre de mesures par accord (rythme harmonique). */
  barsPerChord?: number;
}): { audio: Float32Array; truth: Truth[] } {
  const bpb = opts.beatsPerBar ?? 4;
  const { progression, bars, barSeconds, sr } = opts;
  const rand = rng(opts.seed ?? 1);
  const tune = Math.pow(2, (opts.detuneCents ?? 0) / 1200);
  const len = Math.ceil(bars * barSeconds * sr) + sr;
  const out = new Float32Array(len);
  const truth: Truth[] = [];

  const note = (midi: number, t0: number, dur: number, amp: number, opt: { vibrato?: number; bright?: number } = {}) => {
    const f = midiToFreq(midi) * tune;
    const s0 = Math.floor(t0 * sr);
    const n = Math.floor(dur * sr);
    const bright = opt.bright ?? 1;
    for (let i = 0; i < n && s0 + i < len; i++) {
      const t = i / sr;
      const env = Math.min(1, t * 80) * Math.exp(-t * 1.5) * Math.min(1, (n - i) / (0.02 * sr));
      const vib = opt.vibrato ? 1 + opt.vibrato * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 2) : 1;
      let v = 0;
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f * vib * h * t) * Math.pow(0.55 * bright, h - 1);
      out[s0 + i] += amp * env * v;
    }
  };

  const bpc = opts.barsPerChord ?? 1;
  for (let b = 0; b < bars; b++) {
    const { chord, bass } = progression[Math.floor(b / bpc) % progression.length];
    const t0 = b * barSeconds;
    if (b % bpc === 0) truth.push({ start: t0, end: t0 + barSeconds * bpc, chord });
    // anticipation : l'accord suivant est attaqué une croche avant la mesure suivante
    const nextBar = b + 1;
    if (opts.anticipation && nextBar % bpc === 0 && nextBar < bars && rand() < opts.anticipation) {
      const nxt = progression[Math.floor(nextBar / bpc) % progression.length].chord;
      const ta = t0 + barSeconds - barSeconds / (2 * bpb);
      for (const iv of QUALITY_INTERVALS[nxt.quality]) note(55 + ((nxt.root + iv - 7 + 12) % 12), ta, barSeconds / (2 * bpb) + 0.3, 0.09);
    }
    const ivs = QUALITY_INTERVALS[chord.quality];
    // piano : accord sur chaque temps (4 temps)
    for (let beat = 0; beat < bpb; beat++) {
      for (const iv of ivs) note(55 + ((chord.root + iv - 7 + 12) % 12) + 0, t0 + (beat * barSeconds) / bpb, barSeconds / bpb, 0.07);
    }
    // basse (éventuellement renversée)
    const bassPc = bass ?? chord.root;
    note(36 + ((bassPc + 12) % 12), t0, barSeconds * 0.95, 0.22, { bright: 0.6 });
    // voix : notes de passage, souvent hors accord
    const scale = [0, 2, 4, 5, 7, 9, 11];
    let t = t0;
    while (t < t0 + barSeconds - 0.2) {
      const d = [0.25, 0.5, 0.5, 0.75][Math.floor(rand() * 4)] * (barSeconds / 2);
      const deg = scale[Math.floor(rand() * 7)];
      note(65 + ((deg + (progression[0].chord.root)) % 12), t, d * 0.95, 0.3, { vibrato: 0.006 });
      t += d;
    }
    if (opts.busy) {
      // 2e guitare : arpèges en croches, avec une note de passage (hors accord) sur certains contretemps
      const tones = ivs.map((iv) => 60 + ((chord.root + iv) % 12));
      for (let k = 0; k < 8; k++) {
        const passing = k % 2 === 1 && rand() < 0.5;
        const m = passing ? tones[0] + [1, 2, 5, -1][Math.floor(rand() * 4)] : tones[k % tones.length];
        note(m, t0 + (k * barSeconds) / 8, barSeconds / 8, 0.12, { bright: 1.2 });
      }
      // phrase de guitare solo sur la 2e moitié d'une mesure sur deux : notes de la gamme, souvent hors accord
      if (b % 2 === 1) {
        for (let k = 0; k < 4; k++) {
          const deg = [0, 2, 4, 5, 7, 9, 11][Math.floor(rand() * 7)];
          note(72 + ((deg + progression[0].chord.root) % 12), t0 + barSeconds / 2 + (k * barSeconds) / 8, barSeconds / 8, 0.2, { vibrato: 0.01 });
        }
      }
    }
    // batterie : grosse caisse (sinus descendant) + caisse claire / charleston (bruit)
    for (let beat = 0; beat < bpb; beat++) {
      const s0 = Math.floor((t0 + (beat * barSeconds) / bpb) * sr);
      for (let i = 0; i < 0.12 * sr && s0 + i < len; i++) {
        const tt = i / sr;
        if (bpb === 3 ? beat === 0 : beat % 2 === 0) out[s0 + i] += 0.5 * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 18);
        else out[s0 + i] += 0.25 * (rand() * 2 - 1) * Math.exp(-tt * 25);
      }
      const h0 = s0 + Math.floor((barSeconds / (2 * bpb)) * sr);
      for (let i = 0; i < 0.04 * sr && h0 + i < len; i++) out[h0 + i] += 0.08 * (rand() * 2 - 1) * Math.exp(-(i / sr) * 80);
    }
  }
  return { audio: out, truth };
}

/** Proportion du temps où l'accord détecté (simplifié en triade) est correct. */
export function frameAccuracy(
  segs: { start: number; end: number; chord: Chord | null }[],
  truth: Truth[],
  simplify: (c: Chord) => Chord,
  step = 0.05,
): number {
  let ok = 0;
  let total = 0;
  const end = truth[truth.length - 1].end;
  for (let t = 0; t < end; t += step) {
    const tr = truth.find((x) => t >= x.start && t < x.end)!;
    const sg = segs.find((x) => t >= x.start && t < x.end);
    total++;
    if (sg?.chord) {
      const a = simplify(sg.chord);
      const b = simplify(tr.chord);
      if (a.root === b.root && a.quality === b.quality) ok++;
    }
  }
  return ok / total;
}

/** Nombre de changements d'accord (vue simplifiée) qui ne tombent pas près d'un début de mesure. */
export function offGridChanges(
  segs: { start: number; chord: Chord | null }[],
  truth: Truth[],
  simplify: (c: Chord) => Chord,
  tolerance = 0.2,
): number {
  let n = 0;
  let last = '';
  for (const s of segs) {
    const c = s.chord ? simplify(s.chord) : null;
    const k = c ? `${c.root}:${c.quality}` : 'N';
    const end = truth[truth.length - 1].end;
    const onBar = truth.some((t) => Math.abs(t.start - s.start) < tolerance) || Math.abs(end - s.start) < tolerance;
    if (last && k !== last && !onBar) n++;
    last = k;
  }
  return n;
}

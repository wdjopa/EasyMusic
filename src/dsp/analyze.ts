import type { Key, Range } from '../music/theory';
import { bassChromagram, chromagram } from './chroma';
import { alignBeatsToHarmony, harmonicNovelty, harmonicPeriod, trackBeats } from './beats';
import { keyFromChords, recognizeChords, type ChordSegment } from './chords';
import { detectKey, keyProfileScorer } from './key';
import { estimateMelodyRange } from './melody';
import { decimate, toMono } from './resample';
import { stft } from './spectrum';

/** À incrémenter quand l'algorithme change : les analyses plus anciennes sont refaites. */
export const ANALYSIS_VERSION = 4;

export interface AnalysisResult {
  version?: number;
  duration: number;
  key: Key;
  segments: ChordSegment[];
  melodyRange: Range | null;
  /** Tempo estimé (battements par minute). */
  bpm?: number;
  /** Mélodie principale estimée : une note MIDI (0 = aucune) toutes les `melodyStep` secondes. */
  melody?: number[];
  melodyStep?: number;
  melodyOffset?: number;
}

export type Progress = (fraction: number, label: string) => void;

export function analyze(channels: Float32Array[], sampleRate: number, onProgress: Progress = () => {}): AnalysisResult {
  onProgress(0.05, 'Mixage et sous-échantillonnage…');
  const mono = toMono(channels);
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const x = decimate(mono, factor);
  const sr = sampleRate / factor;

  onProgress(0.3, 'Analyse spectrale…');
  const fftSize = 4096;
  const hop = 1024;
  const spec = stft(x, sr, fftSize, hop);

  onProgress(0.55, 'Extraction des notes (chromagramme)…');
  const chroma = chromagram(spec);

  onProgress(0.7, 'Reconnaissance des accords…');
  const frameDuration = hop / sr;
  const bass = bassChromagram(spec);
  // 1re passe : accords « bruts » -> tonalité ; 2e passe : accords guidés par la tonalité
  const firstPass = recognizeChords(chroma, { frameDuration, minDuration: 0.7, bass });
  const chordKey = keyFromChords(firstPass, keyProfileScorer(chroma)) ?? detectKey(chroma);
  // décalage entre l'indice des trames et le temps réel (centre de la fenêtre d'analyse)
  const offset = fftSize / 2 / sr - frameDuration / 2;
  onProgress(0.78, 'Détection du tempo et des mesures…');
  const hp = harmonicPeriod(chroma, frameDuration, bass);
  const tracked = trackBeats(x, sr, hp);
  const bpm = tracked.bpm;
  const beats = alignBeatsToHarmony(tracked.beats, harmonicNovelty(chroma, frameDuration, bass), (t) => (t - offset) / frameDuration - 0.5);
  const harmonicBeats = hp && bpm ? Math.round(hp / (60 / bpm)) : undefined;
  const segments = recognizeChords(chroma, {
    frameDuration,
    minDuration: 0.7,
    bass,
    key: chordKey,
    beats: beats.map((b) => b - offset),
    harmonicBeats,
  });
  for (const s of segments) {
    s.start = Math.max(0, s.start + offset);
    s.end = s.end + offset;
  }
  if (segments.length) {
    segments[0].start = 0;
    segments[segments.length - 1].end = mono.length / sampleRate;
  }

  onProgress(0.85, 'Détection de la tonalité et de la mélodie…');
  const key = chordKey;
  const mr = estimateMelodyRange(spec);

  onProgress(1, 'Terminé');
  return {
    version: ANALYSIS_VERSION,
    duration: mono.length / sampleRate,
    key: { tonic: key.tonic, mode: key.mode },
    segments,
    melodyRange: mr ? { low: mr.low, high: mr.high } : null,
    melody: mr ? Array.from(mr.track, (m) => (Number.isFinite(m) ? Math.round(m) : 0)) : undefined,
    // la trame i couvre [i·hop, i·hop + fftSize] : son centre est à i·hop + fftSize/2
    melodyStep: hop / sr,
    melodyOffset: fftSize / 2 / sr,
    bpm: Math.round(bpm),
  };
}

import type { Key, Range } from '../music/theory';
import { bassChromagram, chromagram } from './chroma';
import { recognizeChords, type ChordSegment } from './chords';
import { detectKey } from './key';
import { estimateMelodyRange } from './melody';
import { decimate, toMono } from './resample';
import { stft } from './spectrum';

export interface AnalysisResult {
  duration: number;
  key: Key;
  segments: ChordSegment[];
  melodyRange: Range | null;
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
  const segments = recognizeChords(chroma, { frameDuration, minDuration: 0.7, bass });
  // décaler pour que chaque trame soit centrée sur sa fenêtre
  const offset = fftSize / 2 / sr - frameDuration / 2;
  for (const s of segments) {
    s.start = Math.max(0, s.start + offset);
    s.end = s.end + offset;
  }
  if (segments.length) {
    segments[0].start = 0;
    segments[segments.length - 1].end = mono.length / sampleRate;
  }

  onProgress(0.85, 'Détection de la tonalité et de la mélodie…');
  const key = detectKey(chroma);
  const mr = estimateMelodyRange(spec);

  onProgress(1, 'Terminé');
  return {
    duration: mono.length / sampleRate,
    key: { tonic: key.tonic, mode: key.mode },
    segments,
    melodyRange: mr ? { low: mr.low, high: mr.high } : null,
  };
}

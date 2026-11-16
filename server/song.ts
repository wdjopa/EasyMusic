import type { AnalysisResult } from '../src/dsp/analyze';

/** Résultat renvoyé au navigateur : métadonnées + accords (jamais l'audio). */
export interface Song {
  id: string; // identifiant YouTube
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  analysis: AnalysisResult;
}

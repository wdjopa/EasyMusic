import type { AnalysisResult } from '../src/dsp/analyze';

/** Résultat renvoyé au navigateur : métadonnées + accords (jamais l'audio). */
export interface Song {
  id: string; // identifiant YouTube
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  /** Faux si le propriétaire interdit la lecture hors de YouTube : l'app joue alors le son directement. */
  embeddable?: boolean;
  analysis: AnalysisResult;
}

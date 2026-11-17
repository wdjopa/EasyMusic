// Client de l'API du serveur (catalogue et analyses YouTube).
import type { AnalysisResult } from '../dsp/analyze';
import type { Lyrics } from '../shared/lyrics';

/** Résultat d'analyse renvoyé par le serveur. */
export interface Song {
  id: string;
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  analysis: AnalysisResult;
}
interface Job {
  id: string;
  status: 'queued' | 'downloading' | 'analyzing' | 'done' | 'error';
  progress: number;
  label: string;
  error?: string;
  title?: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, init);
  } catch {
    throw new Error('Serveur injoignable : vérifiez votre connexion.');
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Erreur du serveur (${r.status})`);
  return body as T;
}

/**
 * Demande au serveur d'analyser une vidéo (réponse immédiate si elle vient d'être analysée)
 * et suit sa progression jusqu'au résultat.
 */
export async function analyzeVideo(
  url: string,
  onProgress: (fraction: number, label: string) => void,
  signal?: { cancelled: boolean },
): Promise<Song> {
  const first = await req<{ song?: Song; job: Job }>('/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (first.song) return first.song;
  let job = first.job;
  for (;;) {
    if (signal?.cancelled) throw new Error('annulé');
    onProgress(job.progress, job.label);
    if (job.status === 'error') throw new Error(job.error ?? 'Analyse impossible');
    await new Promise((r) => setTimeout(r, 800));
    const r = await req<{ job: Job; song?: Song }>(`/api/jobs/${job.id}`);
    if (r.song) return r.song;
    job = r.job;
  }
}

/** Demande au serveur une version transposée de l'audio ; renvoie l'adresse du fichier à lire. */
export async function prepareTransposedAudio(videoId: string, semitones: number): Promise<string> {
  const r = await req<{ url: string }>(`/api/audio/${videoId}/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ semitones }),
  });
  return r.url;
}

/** Cherche les paroles d'un morceau ; null si introuvables. */
export async function fetchLyrics(title: string, author: string, duration?: number): Promise<Lyrics | null> {
  const q = new URLSearchParams({ title, author, ...(duration ? { duration: String(Math.round(duration)) } : {}) });
  const r = await fetch(`/api/lyrics?${q}`);
  if (r.status === 404) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Erreur du serveur (${r.status})`);
  return body.lyrics as Lyrics;
}

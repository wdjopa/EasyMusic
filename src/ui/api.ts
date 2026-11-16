// Client de l'API du serveur (catalogue et analyses YouTube).
import type { AnalysisResult } from '../dsp/analyze';

export interface SongSummary {
  id: string;
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  addedAt: string;
  key: AnalysisResult['key'];
}
export interface Song extends Omit<SongSummary, 'key'> {
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

export async function fetchCatalogue(): Promise<SongSummary[]> {
  return (await req<{ songs: SongSummary[] }>('/api/catalogue')).songs;
}

export async function fetchSong(id: string): Promise<Song | null> {
  try {
    return (await req<{ song: Song }>(`/api/songs/${id}`)).song;
  } catch {
    return null;
  }
}

/**
 * Demande l'analyse d'une vidéo (ou la récupère directement si elle est déjà au catalogue)
 * et suit sa progression jusqu'au résultat.
 */
export async function analyzeVideo(
  url: string,
  onProgress: (fraction: number, label: string) => void,
  signal?: { cancelled: boolean },
): Promise<Song> {
  const first = await req<{ status: string; song?: Song; job?: Job }>('/api/songs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (first.song) return first.song;
  let job = first.job!;
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

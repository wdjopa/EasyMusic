// Client de l'API du serveur (catalogue et analyses YouTube).
import type { AnalysisResult } from '../dsp/analyze';
import type { Lyrics } from '../shared/lyrics';
import { getAudio } from './audioStore';

/** Résultat d'analyse renvoyé par le serveur. */
export interface Song {
  id: string;
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  embeddable?: boolean;
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

/**
 * Adresse du serveur. Vide sur le site (même origine) ; les apps (Tauri) la fixent à la compilation
 * avec VITE_API_BASE=https://enjoysing.resub.me.
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
/** Adresse complète d'un chemin de l'API (« /api/… »). */
export const apiUrl = (path: string) => (path.startsWith('/') ? `${API_BASE}${path}` : path);

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(apiUrl(path), init);
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
  onProgress: (fraction: number, label: string, title?: string) => void,
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
    onProgress(job.progress, job.label, job.title);
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
  return apiUrl(r.url);
}

/** Analyse déjà faite par le serveur pour quelqu'un d'autre (catalogue partagé), ou null. */
export async function catalogueSong(videoId: string): Promise<Song | null> {
  try {
    const r = await fetch(apiUrl(`/api/catalogue/${videoId}`));
    if (!r.ok) return null;
    return ((await r.json()) as { song: Song }).song;
  } catch {
    return null;
  }
}

/** Titre, auteur, miniature d'une vidéo, sans la télécharger. */
export async function videoInfo(videoId: string): Promise<Omit<Song, 'analysis' | 'duration'> | null> {
  try {
    const r = await fetch(apiUrl(`/api/info/${videoId}`));
    if (!r.ok) return null;
    return ((await r.json()) as { info: Omit<Song, 'analysis' | 'duration'> }).info;
  } catch {
    return null;
  }
}

/** Cherche les paroles d'un morceau ; null si introuvables. */
export async function fetchLyrics(title: string, author: string, duration?: number): Promise<Lyrics | null> {
  const q = new URLSearchParams({ title, author, ...(duration ? { duration: String(Math.round(duration)) } : {}) });
  const r = await fetch(apiUrl(`/api/lyrics?${q}`));
  if (r.status === 404) return null;
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `Erreur du serveur (${r.status})`);
  return body.lyrics as Lyrics;
}

export interface Features {
  whisper: boolean;
  /** Séparation voix / instruments (Demucs) installée sur le serveur. */
  separation?: boolean;
  whisperReason?: string;
  transposedAudio: boolean;
}
let featuresCache: { at: number; p: Promise<Features> } | null = null;
/** Fonctions disponibles sur le serveur (transcription IA…), redemandées toutes les 30 s. */
export function fetchFeatures(): Promise<Features> {
  if (!featuresCache || Date.now() - featuresCache.at > 30_000)
    featuresCache = { at: Date.now(), p: req<Features>('/api/features').catch(() => ({ whisper: false, whisperReason: 'serveur injoignable', transposedAudio: false })) };
  return featuresCache.p;
}

/** Fait transcrire les paroles par IA (Whisper, sur le serveur) et attend le résultat. */
export async function transcribeLyrics(
  videoId: string,
  meta: { title?: string; author?: string },
  onProgress: (fraction: number, label: string) => void,
  signal?: { cancelled: boolean },
): Promise<Lyrics> {
  type First = { job: { id: string; status: string; progress: number; label: string; error?: string }; lyrics?: Lyrics };
  // le son est déjà sur l'appareil : on l'envoie (le serveur, lui, est souvent bloqué par YouTube)
  const local = await getAudio(videoId);
  let first: First;
  if (local) {
    onProgress(0, 'Envoi du son au serveur…');
    const q = new URLSearchParams({ videoId, ...(meta.title ? { title: meta.title } : {}), ...(meta.author ? { author: meta.author } : {}) });
    first = await req<First>(`/api/lyrics/transcribe-audio?${q}`, {
      method: 'POST',
      headers: { 'content-type': local.type || 'application/octet-stream' },
      body: local,
    });
  } else
    first = await req<First>('/api/lyrics/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, ...meta }),
    });
  if (first.lyrics) return first.lyrics; // déjà transcrites (catalogue partagé)
  let job = first.job;
  for (;;) {
    if (signal?.cancelled) throw new Error('annulé');
    onProgress(job.progress, job.label);
    if (job.status === 'error') throw new Error(job.error ?? 'Transcription impossible');
    await new Promise((r) => setTimeout(r, 1000));
    const r = await req<{ job: typeof job; lyrics?: Lyrics }>(`/api/transcribe/${job.id}`);
    if (r.lyrics) return r.lyrics;
    job = r.job;
  }
}

export interface Separation {
  analysis: AnalysisResult;
  stems: { vocals: string; instrumental: string };
}

/**
 * Sépare la voix et les instruments sur le serveur (Demucs) et attend le résultat : analyse refaite
 * (accords sur les instruments, mélodie sur la voix) et adresses des deux pistes.
 * `audio` : le son si l'appareil l'a déjà (le serveur, lui, est souvent bloqué par YouTube).
 */
export async function separateSong(
  videoId: string,
  audio: Blob | undefined,
  onProgress: (fraction: number, label: string) => void,
  signal?: { cancelled: boolean },
): Promise<Separation> {
  type R = { job: { id: string; status: string; progress: number; label: string; error?: string }; analysis?: AnalysisResult; stems?: Separation['stems'] };
  if (audio) onProgress(0, 'Envoi du son au serveur…');
  let r = await req<R>(`/api/separate?videoId=${videoId}`, {
    method: 'POST',
    headers: { 'content-type': audio?.type || 'application/octet-stream' },
    body: audio ?? null,
  });
  for (;;) {
    if (signal?.cancelled) throw new Error('annulé');
    onProgress(r.job.progress, r.job.label);
    if (r.job.status === 'error') throw new Error(r.job.error ?? 'Séparation impossible');
    if (r.job.status === 'done' && r.analysis && r.stems) return { analysis: r.analysis, stems: { vocals: apiUrl(r.stems.vocals), instrumental: apiUrl(r.stems.instrumental) } };
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await req<R>(`/api/separate/${r.job.id}`);
  }
}

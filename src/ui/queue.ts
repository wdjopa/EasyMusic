// File d'attente : des chansons analysées en arrière-plan, sans toucher à celle qui joue.
import { ANALYSIS_VERSION } from '../dsp/analyze';
import { parseYouTubeId } from '../shared/youtubeId';
import { fetchFeatures, fetchLyrics, transcribeLyrics } from './api';
import { getSong, saveLyrics, saveSong } from './library';
import { songAudio } from './localAudio';
import { obtainSong } from './obtain';

export interface QueueItem {
  id: string; // identifiant YouTube
  title: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  progress: number;
  label: string;
  error?: string;
  addedAt: number;
}

const KEY = 'easymusic.queue.v1';
/** Analyses en arrière-plan menées en même temps (le serveur a aussi sa propre limite). */
const PARALLEL = 2;

export class Queue {
  items: QueueItem[] = [];
  private running = 0;
  private listeners: (() => void)[] = [];
  private cancelled = new Set<string>();

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '[]') as QueueItem[];
      // les analyses interrompues (page fermée) reprennent
      this.items = saved.map((i) => (i.status === 'running' ? { ...i, status: 'waiting', progress: 0, label: 'En attente' } : i));
    } catch {
      this.items = [];
    }
    queueMicrotask(() => this.pump());
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private emit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch {
      /* ignore */
    }
    for (const fn of this.listeners) fn();
  }

  /** Ajoute une vidéo ; renvoie false si le lien n'est pas valide. */
  add(url: string): QueueItem | null {
    const id = parseYouTubeId(url);
    if (!id) return null;
    const existing = this.items.find((i) => i.id === id);
    if (existing) {
      if (existing.status === 'error') this.retry(id);
      return existing;
    }
    const saved = getSong(id);
    const ready = saved && saved.analysis.version === ANALYSIS_VERSION;
    const item: QueueItem = {
      id,
      title: saved?.title ?? 'Vidéo YouTube',
      status: ready ? 'done' : 'waiting',
      progress: ready ? 1 : 0,
      label: ready ? 'Déjà dans le catalogue' : 'En attente',
      addedAt: Date.now(),
    };
    this.items.push(item);
    this.emit();
    this.pump();
    return item;
  }

  retry(id: string) {
    const i = this.items.find((x) => x.id === id);
    if (!i) return;
    Object.assign(i, { status: 'waiting', progress: 0, label: 'En attente', error: undefined });
    this.emit();
    this.pump();
  }

  remove(id: string) {
    this.cancelled.add(id);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  /** Retire les chansons prêtes (elles restent dans le catalogue). */
  clearDone() {
    this.items = this.items.filter((i) => i.status !== 'done');
    this.emit();
  }

  get pending() {
    return this.items.filter((i) => i.status === 'waiting' || i.status === 'running').length;
  }
  get ready() {
    return this.items.filter((i) => i.status === 'done').length;
  }

  private pump() {
    while (this.running < PARALLEL) {
      const next = this.items.find((i) => i.status === 'waiting');
      if (!next) return;
      this.running++;
      void this.process(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async process(item: QueueItem) {
    this.cancelled.delete(item.id);
    item.status = 'running';
    item.label = 'Démarrage…';
    this.emit();
    const signal = { cancelled: false };
    const check = () => (signal.cancelled = this.cancelled.has(item.id));
    try {
      const song = await obtainSong(
        item.id,
        (f, label, title) => {
          if (check()) return;
          item.progress = f;
          item.label = label;
          if (title) item.title = title;
          this.emit();
        },
        signal,
      );
      if (check()) return;
      const prev = getSong(item.id);
      saveSong({ ...song, prefs: prev?.prefs });
      item.title = song.title;
      item.label = 'Recherche des paroles…';
      this.emit();
      try {
        let lyrics = await fetchLyrics(song.title, song.author, song.analysis.duration);
        // paroles absentes de la base : transcription par IA, en arrière-plan aussi
        if (!lyrics?.synced && (await fetchFeatures()).whisper) {
          try {
            lyrics = await transcribeLyrics(item.id, { title: song.title, author: song.author }, (f, label) => {
              item.progress = f;
              item.label = label;
              this.emit();
            });
          } catch {
            /* on garde ce qu'on a */
          }
        }
        saveLyrics(item.id, lyrics);
      } catch {
        /* les paroles seront recherchées à l'ouverture */
      }
      // l'audio est gardé dans le navigateur dès maintenant (le serveur l'a encore en cache)
      item.label = 'Enregistrement du son…';
      this.emit();
      await songAudio(item.id).catch(() => {});
      Object.assign(item, { status: 'done', progress: 1, label: 'Prête' });
    } catch (e) {
      if (check()) return;
      Object.assign(item, { status: 'error', label: 'Erreur', error: (e as Error).message });
    }
    this.emit();
  }
}

// Catalogue personnel, stocké dans le navigateur (localStorage). Pas de compte utilisateur.
import type { AnalysisResult } from '../dsp/analyze';

export interface SongPrefs {
  semitones: number;
  octave: number;
  capo: number;
  simple: boolean;
  flats: boolean | null;
  mode?: 'original' | 'voice';
}

export interface LibrarySong {
  id: string; // identifiant YouTube
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  addedAt: string;
  openedAt: string;
  analysis: AnalysisResult;
  prefs?: SongPrefs;
}

const KEY = 'easymusic.library.v1';

function read(): LibrarySong[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(songs: LibrarySong[]): boolean {
  // si le stockage est plein, on retire les chansons ouvertes il y a le plus longtemps
  const list = [...songs].sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  for (;;) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch {
      if (!list.length) return false; // stockage indisponible
      list.pop();
    }
  }
}

export function listSongs(): LibrarySong[] {
  return read().sort((a, b) => b.openedAt.localeCompare(a.openedAt));
}

export function getSong(id: string): LibrarySong | undefined {
  return read().find((s) => s.id === id);
}

export function saveSong(song: Omit<LibrarySong, 'addedAt' | 'openedAt'> & Partial<LibrarySong>): void {
  const all = read();
  const now = new Date().toISOString();
  const i = all.findIndex((s) => s.id === song.id);
  const prev = i >= 0 ? all[i] : undefined;
  const entry: LibrarySong = { ...prev, ...song, addedAt: prev?.addedAt ?? now, openedAt: now } as LibrarySong;
  if (i >= 0) all[i] = entry;
  else all.push(entry);
  write(all);
}

export function savePrefs(id: string, prefs: SongPrefs): void {
  const all = read();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  s.prefs = prefs;
  write(all);
}

export function removeSong(id: string): void {
  write(read().filter((s) => s.id !== id));
}

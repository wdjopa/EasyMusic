import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSong, listSongs, removeSong, savePrefs, saveSong } from '../src/ui/library';

const store = new Map<string, string>();
let quota = Infinity;
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (v.length > quota) throw new Error('QuotaExceededError');
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const song = (id: string) => ({
  id,
  title: `Titre ${id}`,
  author: 'A',
  duration: 100,
  thumbnail: '',
  analysis: { duration: 100, key: { tonic: 0, mode: 'major' as const }, segments: [], melodyRange: null },
});

describe('catalogue local', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    store.clear();
    quota = Infinity;
  });

  it('ajoute, enregistre les réglages et retire (y compris la dernière chanson)', () => {
    saveSong(song('aaaaaaaaaaa'));
    savePrefs('aaaaaaaaaaa', { semitones: -3, octave: -12, capo: 2, simple: true, flats: null });
    expect(getSong('aaaaaaaaaaa')?.prefs?.semitones).toBe(-3);
    saveSong(song('aaaaaaaaaaa')); // réouverture : les réglages sont conservés
    expect(getSong('aaaaaaaaaaa')?.prefs?.capo).toBe(2);
    removeSong('aaaaaaaaaaa');
    expect(listSongs()).toEqual([]);
  });

  it('libère de la place en retirant les chansons les moins récentes si le stockage est plein', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    saveSong(song('aaaaaaaaaaa'));
    vi.setSystemTime(new Date('2026-01-01T11:00:00Z'));
    saveSong(song('bbbbbbbbbbb'));
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    quota = JSON.stringify(listSongs()).length + 10; // la place pour deux chansons seulement
    saveSong(song('ccccccccccc'));
    expect(listSongs().map((s) => s.id).sort()).toEqual(['bbbbbbbbbbb', 'ccccccccccc']);
  });
});

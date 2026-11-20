// Catalogue partagé : les analyses faites par le serveur sont gardées sur disque et resservies à tout le monde.
// Seuls des résultats (accords, tempo, mélodie, paroles) y sont stockés, jamais d'audio.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANALYSIS_VERSION } from '../src/dsp/analyze';
import type { Lyrics } from '../src/shared/lyrics';
import type { Song } from './song';

const ID = /^[\w-]{11}$/;

export class Catalogue {
  private songs = new Map<string, Song | null>(); // petit cache mémoire (null = absent)

  constructor(private dir: string) {}

  private file(kind: 'songs' | 'lyrics', id: string) {
    return join(this.dir, kind, `${id}.json`);
  }

  private async read<T>(kind: 'songs' | 'lyrics', id: string): Promise<T | null> {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(this.file(kind, id), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private async write(kind: 'songs' | 'lyrics', id: string, value: unknown) {
    if (!ID.test(id)) return;
    try {
      await mkdir(join(this.dir, kind), { recursive: true });
      const tmp = `${this.file(kind, id)}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, this.file(kind, id)); // jamais de fichier à moitié écrit
    } catch (e) {
      console.warn(`Catalogue : impossible d'enregistrer ${kind}/${id} (${(e as Error).message})`);
    }
  }

  /** Analyse déjà faite par le serveur (avec l'algorithme actuel), ou null. */
  async get(id: string): Promise<Song | null> {
    if (!this.songs.has(id)) {
      const s = await this.read<Song>('songs', id);
      this.songs.set(id, s && s.analysis?.version === ANALYSIS_VERSION ? s : null);
      if (this.songs.size > 500) this.songs.delete(this.songs.keys().next().value!);
    }
    return this.songs.get(id) ?? null;
  }

  async put(song: Song): Promise<void> {
    this.songs.set(song.id, song);
    await this.write('songs', song.id, song);
  }

  /** Paroles transcrites par IA à partir de l'audio téléchargé par le serveur. */
  getLyrics(id: string): Promise<Lyrics | null> {
    return this.read<Lyrics>('lyrics', id);
  }

  putLyrics(id: string, lyrics: Lyrics): Promise<void> {
    return this.write('lyrics', id, lyrics);
  }
}

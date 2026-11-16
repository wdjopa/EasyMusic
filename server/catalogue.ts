import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnalysisResult } from '../src/dsp/analyze';

/** Une chanson du catalogue : uniquement les métadonnées et l'analyse (jamais l'audio). */
export interface Song {
  id: string; // identifiant YouTube
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  addedAt: string;
  analysis: AnalysisResult;
}

export type SongSummary = Omit<Song, 'analysis'> & { key: AnalysisResult['key'] };

export class Catalogue {
  private songs = new Map<string, Song>();
  private dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'songs');
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as Song;
        this.songs.set(s.id, s);
      } catch (e) {
        console.warn(`Fichier de catalogue illisible ignoré : ${f}`, e);
      }
    }
  }

  get(id: string): Song | undefined {
    return this.songs.get(id);
  }

  list(): SongSummary[] {
    return [...this.songs.values()]
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
      .map(({ analysis, ...rest }) => ({ ...rest, key: analysis.key }));
  }

  async add(song: Song): Promise<void> {
    // écriture atomique : fichier temporaire puis renommage
    const file = join(this.dir, `${song.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(song));
    await rename(`${file}.tmp`, file);
    this.songs.set(song.id, song);
  }
}

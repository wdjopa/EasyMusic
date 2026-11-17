import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config';
import { run } from './youtube';

/**
 * Cache TEMPORAIRE de l'audio téléchargé, uniquement pour la lecture transposée.
 * Rien n'est gardé au-delà de `ttlMs` (30 min sans utilisation) ni au-delà de `maxEntries` vidéos.
 * Le catalogue, lui, ne contient jamais d'audio.
 */
interface Entry {
  dir: string;
  file: string;
  lastUsed: number;
  shifted: Map<number, Promise<string>>;
}

function detect(args: string[], pattern: RegExp): boolean {
  try {
    const r = spawnSync(config.ffmpeg, args, { encoding: 'utf8' });
    return pattern.test(`${r.stdout}${r.stderr}`);
  } catch {
    return false;
  }
}

export class AudioCache {
  private entries = new Map<string, Entry>();
  private downloads = new Map<string, Promise<void>>();
  private hasRubberband = detect(['-hide_banner', '-filters'], /\brubberband\b/);
  private hasMp3 = detect(['-hide_banner', '-encoders'], /libmp3lame/);

  constructor(
    private ttlMs = 30 * 60_000,
    private maxEntries = 8,
  ) {
    setInterval(() => void this.cleanup(), 60_000).unref();
  }

  get format() {
    return this.hasMp3 ? { ext: 'mp3', mime: 'audio/mpeg' } : { ext: 'm4a', mime: 'audio/mp4' };
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Appelé après un téléchargement : on garde le fichier un moment. */
  keep(id: string, dir: string, file: string): void {
    const old = this.entries.get(id);
    if (old && old.dir !== dir) void rm(old.dir, { recursive: true, force: true });
    this.entries.set(id, { dir, file, lastUsed: Date.now(), shifted: new Map() });
    void this.cleanup();
  }

  /** S'assure que l'audio original est disponible (téléchargement dédoublonné). */
  async ensure(id: string, download: () => Promise<void>): Promise<void> {
    if (this.entries.has(id)) return;
    let p = this.downloads.get(id);
    if (!p) {
      p = download().finally(() => this.downloads.delete(id));
      this.downloads.set(id, p);
    }
    await p;
    if (!this.entries.has(id)) throw new Error('Audio indisponible.');
  }

  /** Fichier audio original (pour la transcription des paroles), s'il est en cache. */
  original(id: string): string | undefined {
    const e = this.entries.get(id);
    if (e) e.lastUsed = Date.now();
    return e?.file;
  }

  /** Fichier transposé de `semitones` demi-tons (créé à la demande, puis réutilisé). */
  shifted(id: string, semitones: number): Promise<string> {
    const e = this.entries.get(id);
    if (!e) return Promise.reject(new Error('Audio expiré : relancez la lecture.'));
    e.lastUsed = Date.now();
    let p = e.shifted.get(semitones);
    if (!p) {
      p = this.transcode(e.file, join(e.dir, `shift_${semitones}.${this.format.ext}`), semitones);
      p.catch(() => e.shifted.delete(semitones));
      e.shifted.set(semitones, p);
    }
    return p;
  }

  /** Chemin d'un fichier déjà préparé (pour le servir), sinon undefined. */
  async ready(id: string, semitones: number): Promise<string | undefined> {
    const e = this.entries.get(id);
    const p = e?.shifted.get(semitones);
    if (!e || !p) return undefined;
    e.lastUsed = Date.now();
    return p.catch(() => undefined);
  }

  private async transcode(input: string, output: string, semitones: number): Promise<string> {
    const r = Math.pow(2, semitones / 12);
    const sr = 44100;
    const filter = !semitones
      ? []
      : this.hasRubberband
        ? ['-af', `rubberband=pitch=${r.toFixed(6)}:pitchq=quality`]
        : ['-af', `asetrate=${sr}*${r.toFixed(6)},aresample=${sr},atempo=${(1 / r).toFixed(6)}`];
    const codec = this.hasMp3 ? ['-c:a', 'libmp3lame', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '2', '-ar', String(sr), ...filter, ...codec, output]);
    return output;
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const sorted = [...this.entries.entries()].sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    for (const [i, [id, e]] of sorted.entries()) {
      if (now - e.lastUsed > this.ttlMs || i >= this.maxEntries) {
        this.entries.delete(id);
        await rm(e.dir, { recursive: true, force: true });
      }
    }
  }

  /** Supprime tout (arrêt du serveur, tests). */
  async clear(): Promise<void> {
    for (const e of this.entries.values()) await rm(e.dir, { recursive: true, force: true });
    this.entries.clear();
  }
}

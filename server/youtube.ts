import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config';

export interface VideoInfo {
  id: string;
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
}

export class UserError extends Error {}

/** Refus de YouTube (403) : on peut réessayer autrement. `details` = fin du journal de yt-dlp. */
export class DownloadRefused extends Error {
  constructor(message: string, public details: string) {
    super(message);
  }
}

function baseArgs(): string[] {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
  if (config.cookies) a.push('--cookies', config.cookies);
  return [...a, ...config.ytDlpExtraArgs];
}

function friendlyError(stderr: string): Error {
  if (/not a bot|Sign in to confirm/i.test(stderr))
    return new Error('YouTube bloque temporairement le serveur (vérification anti-robot). Réessayez plus tard.');
  if (/HTTP Error 403/i.test(stderr))
    return new DownloadRefused(
      'YouTube a refusé le téléchargement (erreur 403). Sur le serveur : mettre yt-dlp à jour, installer Deno, ou fournir des cookies (voir le README).',
      stderr.trim().split('\n').slice(-12).join('\n'),
    );
  if (/Private video|Video unavailable|This video is not available|removed/i.test(stderr))
    return new UserError('Vidéo indisponible ou privée.');
  if (/age/i.test(stderr) && /confirm/i.test(stderr)) return new UserError('Vidéo soumise à une limite d’âge : impossible de l’analyser.');
  const line = stderr.trim().split('\n').filter((l) => l.startsWith('ERROR')).pop();
  return new Error(line ? line.replace(/^ERROR:\s*/, '') : 'Téléchargement impossible.');
}

function run(cmd: string, args: string[], onLine?: (line: string) => void): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    // arguments passés en tableau : pas de shell, donc pas d'injection possible
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    let partial = '';
    p.stdout.on('data', (d: Buffer) => {
      out.push(d);
      if (onLine) {
        partial += d.toString();
        const lines = partial.split(/\r?\n|\r/);
        partial = lines.pop() ?? '';
        lines.forEach(onLine);
      }
    });
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e: NodeJS.ErrnoException) =>
      reject(e.code === 'ENOENT' ? new Error(`Programme introuvable : ${cmd}`) : e),
    );
    p.on('close', (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out), stderr: err }) : reject(friendlyError(err))));
  });
}

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export async function fetchInfo(id: string): Promise<VideoInfo> {
  const { stdout } = await run(config.ytDlp, [...baseArgs(), '-J', '--', watchUrl(id)]);
  const j = JSON.parse(stdout.toString());
  return {
    id,
    title: String(j.title ?? 'Sans titre'),
    author: String(j.channel ?? j.uploader ?? ''),
    duration: Number(j.duration ?? 0),
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

/**
 * Stratégies de téléchargement, essayées dans l'ordre en cas de refus (403) :
 * YouTube refuse parfois un format ou un « client » donné mais en accepte un autre.
 */
const STRATEGIES: { label: string; args: string[] }[] = [
  { label: 'audio seul', args: ['-f', 'bestaudio[abr<=160]/bestaudio/best'] },
  { label: 'vidéo basse qualité (format 18)', args: ['-f', '18/worst[acodec!=none]/best'] },
  {
    label: 'autres clients YouTube',
    args: ['-f', 'bestaudio/best', '--extractor-args', 'youtube:player_client=tv,mweb,web_safari'],
  },
];

/**
 * Télécharge l'audio dans un dossier temporaire, le décode en PCM mono,
 * puis supprime le fichier : seul le signal en mémoire est renvoyé.
 */
export async function downloadAudio(id: string, onProgress: (fraction: number) => void): Promise<Float32Array> {
  let lastError: Error | null = null;
  for (const [i, strategy] of STRATEGIES.entries()) {
    const dir = await mkdtemp(join(tmpdir(), 'easymusic-'));
    try {
      await run(
        config.ytDlp,
        [
          ...baseArgs(),
          ...strategy.args,
          '--max-filesize', '120M',
          '--newline',
          '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
          '-o', join(dir, 'audio.%(ext)s'),
          '--', watchUrl(id),
        ],
        (line) => {
          const m = line.match(/PROGRESS\s+([\d.]+)%/);
          if (m) onProgress(Math.min(1, Number(m[1]) / 100));
        },
      );
      const file = (await readdir(dir)).find((f) => f.startsWith('audio.') && !f.endsWith('.part'));
      if (!file) throw new Error('Fichier audio introuvable après le téléchargement.');
      if (i > 0) console.log(`[yt-dlp] ${id} : réussi avec la stratégie « ${strategy.label} »`);
      return await decode(join(dir, file));
    } catch (e) {
      lastError = e as Error;
      const retryable = e instanceof DownloadRefused;
      console.warn(`[yt-dlp] ${id} : échec (« ${strategy.label} »)${retryable && i < STRATEGIES.length - 1 ? ', nouvel essai…' : ''}`);
      if (e instanceof DownloadRefused) console.warn(e.details);
      if (!retryable) throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  throw lastError ?? new Error('Téléchargement impossible.');
}

/** Décode n'importe quel fichier audio en PCM float mono à config.sampleRate (via ffmpeg). */
export async function decode(file: string): Promise<Float32Array> {
  const { stdout } = await run(config.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(config.sampleRate), '-f', 'f32le', '-',
  ]);
  const copy = new Uint8Array(stdout.length);
  copy.set(stdout);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.length / 4));
}

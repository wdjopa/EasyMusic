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

function baseArgs(): string[] {
  const a = ['--no-playlist', '--no-warnings', '--js-runtimes', 'node'];
  if (config.cookies) a.push('--cookies', config.cookies);
  return [...a, ...config.ytDlpExtraArgs];
}

function friendlyError(stderr: string): Error {
  if (/not a bot|Sign in to confirm/i.test(stderr))
    return new Error('YouTube bloque temporairement le serveur (vérification anti-robot). Réessayez plus tard.');
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
 * Télécharge l'audio dans un dossier temporaire, le décode en PCM mono,
 * puis supprime le fichier : seul le signal en mémoire est renvoyé.
 */
export async function downloadAudio(id: string, onProgress: (fraction: number) => void): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'easymusic-'));
  try {
    await run(
      config.ytDlp,
      [
        ...baseArgs(),
        '-f', 'bestaudio[abr<=160]/bestaudio/best',
        '--max-filesize', '80M',
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
    const file = (await readdir(dir)).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('Fichier audio introuvable après le téléchargement.');
    return await decode(join(dir, file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

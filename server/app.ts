import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { parseYouTubeId } from '../src/shared/youtubeId';
import type { AudioCache } from './audioCache';
import type { Job, JobQueue } from './jobs';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const publicJob = ({ song: _song, ...j }: Job) => j;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 10_000): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error('Requête trop volumineuse');
  }
  return data ? JSON.parse(data) : {};
}

/** Sert un fichier en gérant les requêtes partielles (nécessaires pour avancer dans un morceau). */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  const { size } = await stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const headers = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=1800' };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(createReadStream(file, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(createReadStream(file), res).catch(() => {});
}

/** Limite simple du nombre de nouvelles analyses par adresse IP. */
class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perHour: number) {}
  allow(ip: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (list.length >= this.perHour) return false;
    list.push(now);
    this.hits.set(ip, list);
    return true;
  }
}

export function createApp(opts: {
  queue: JobQueue;
  staticDir?: string;
  rateLimitPerHour: number;
  /** Lecture transposée des vidéos (facultatif). */
  audio?: { cache: AudioCache; download: (id: string) => Promise<void> };
}) {
  const { queue, staticDir, audio } = opts;
  const limiter = new RateLimiter(opts.rateLimitPerHour);

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!staticDir) return json(res, 404, { error: 'Introuvable' });
    const safe = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    let file = join(staticDir, safe);
    if (!file.startsWith(staticDir)) return json(res, 403, { error: 'Interdit' });
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(staticDir, 'index.html'); // application monopage
    }
    try {
      await stat(file);
    } catch {
      return json(res, 404, { error: 'Introuvable' });
    }
    const immutable = file.includes(`${join(staticDir, 'assets')}`);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/analyze' && req.method === 'POST') {
        const body = (await readBody(req)) as { url?: unknown };
        const id = typeof body.url === 'string' ? parseYouTubeId(body.url) : null;
        if (!id) return json(res, 400, { error: 'Lien YouTube invalide.' });
        // analyse récente ou en cours : pas de nouveau téléchargement, pas de quota consommé
        const recent = queue.findByVideo(id);
        if (recent) return json(res, recent.song ? 200 : 202, { job: publicJob(recent), song: recent.song });
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        if (!limiter.allow(ip)) return json(res, 429, { error: 'Trop d’analyses demandées : réessayez dans une heure.' });
        const job = queue.submit(id);
        return json(res, 202, { job: publicJob(job) });
      }

      const m = path.match(/^\/api\/jobs\/([\w-]+)$/);
      if (m && req.method === 'GET') {
        const job = queue.get(m[1]);
        if (!job) return json(res, 404, { error: 'Analyse inconnue ou expirée.' });
        return json(res, 200, { job: publicJob(job), song: job.song });
      }

      // lecture transposée : préparation (téléchargement si besoin + transposition)…
      let a = path.match(/^\/api\/audio\/([\w-]{11})\/prepare$/);
      if (a && req.method === 'POST' && audio) {
        const body = (await readBody(req)) as { semitones?: unknown };
        const semi = Number(body.semitones);
        if (!Number.isInteger(semi) || Math.abs(semi) > 12) return json(res, 400, { error: 'Transposition invalide.' });
        const id = a[1];
        if (!audio.cache.has(id)) {
          const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
          if (!limiter.allow(ip)) return json(res, 429, { error: 'Trop de téléchargements demandés : réessayez dans une heure.' });
        }
        try {
          await audio.cache.ensure(id, () => audio.download(id));
          await audio.cache.shifted(id, semi);
        } catch (e) {
          return json(res, 502, { error: (e as Error).message });
        }
        return json(res, 200, { url: `/api/audio/${id}/${semi}.${audio.cache.format.ext}` });
      }
      // …puis lecture du fichier préparé
      a = path.match(/^\/api\/audio\/([\w-]{11})\/(-?\d{1,2})\.(mp3|m4a)$/);
      if (a && (req.method === 'GET' || req.method === 'HEAD') && audio) {
        const file = await audio.cache.ready(a[1], Number(a[2]));
        if (!file) return json(res, 404, { error: 'Audio expiré : relancez la lecture.' });
        return await serveFile(req, res, file, audio.cache.format.mime);
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: 'Introuvable' });
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, path);
      return json(res, 405, { error: 'Méthode non autorisée' });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: 'Erreur interne' });
    }
  };
}

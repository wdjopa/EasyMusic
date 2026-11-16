import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { parseYouTubeId } from '../src/shared/youtubeId';
import type { Catalogue } from './catalogue';
import type { JobQueue } from './jobs';

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

export function createApp(opts: { catalogue: Catalogue; queue: JobQueue; staticDir?: string; rateLimitPerHour: number }) {
  const { catalogue, queue, staticDir } = opts;
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
      if (path === '/api/catalogue' && req.method === 'GET') return json(res, 200, { songs: catalogue.list() });

      let m = path.match(/^\/api\/songs\/([\w-]{11})$/);
      if (m && req.method === 'GET') {
        const song = catalogue.get(m[1]);
        return song ? json(res, 200, { song }) : json(res, 404, { error: 'Chanson absente du catalogue' });
      }

      if (path === '/api/songs' && req.method === 'POST') {
        const body = (await readBody(req)) as { url?: unknown };
        const id = typeof body.url === 'string' ? parseYouTubeId(body.url) : null;
        if (!id) return json(res, 400, { error: 'Lien YouTube invalide.' });
        const song = catalogue.get(id);
        if (song) return json(res, 200, { status: 'done', song });
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        if (!limiter.allow(ip)) return json(res, 429, { error: 'Trop d’analyses demandées : réessayez dans une heure.' });
        const job = queue.submit(id);
        return json(res, 202, { status: job.status, job });
      }

      m = path.match(/^\/api\/jobs\/([\w-]+)$/);
      if (m && req.method === 'GET') {
        const job = queue.get(m[1]);
        if (!job) return json(res, 404, { error: 'Tâche inconnue' });
        const song = job.status === 'done' ? catalogue.get(job.videoId) : undefined;
        return json(res, 200, { job, song });
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

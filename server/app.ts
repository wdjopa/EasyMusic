import type { Catalogue } from './catalogue';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { parseYouTubeId } from '../src/shared/youtubeId';
import type { AudioCache } from './audioCache';
import type { Job, JobQueue } from './jobs';
import { findLyrics } from './lyrics';
import { cleanTitle, type LyricLine, type Lyrics } from '../src/shared/lyrics';

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

/** Adresse du visiteur : derrière Cloudflare, la vraie adresse est dans « cf-connecting-ip ». */
function clientIp(req: IncomingMessage): string {
  const h = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '';
  return String(Array.isArray(h) ? h[0] : h).split(',')[0].trim();
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
  /** Recherche de paroles (remplaçable dans les tests). */
  findLyrics?: typeof findLyrics;
  /** Transcription des paroles par IA (Whisper), si installée. */
  whisper?: { available: () => boolean; reason?: () => string; transcribe: (file: string, onProgress: (f: number) => void) => Promise<LyricLine[]> };
  /** Lecture transposée des vidéos (facultatif). */
  audio?: { cache: AudioCache; download: (id: string) => Promise<void> };
  /** Catalogue partagé des analyses (facultatif). */
  catalogue?: Catalogue;
  /** Origines autorisées à appeler l'API depuis ailleurs (apps Tauri). */
  corsOrigins?: string[];
  /** Infos publiques d'une vidéo (titre, auteur…) sans la télécharger (remplaçable dans les tests). */
  videoInfo?: (id: string) => Promise<PublicInfo | null>;
}) {
  const { queue, staticDir, audio, catalogue } = opts;
  const getInfo = opts.videoInfo ?? oembedInfo;
  const infoCache = new Map<string, PublicInfo | null>();
  const limiter = new RateLimiter(opts.rateLimitPerHour);
  const lyricsCache = new Map<string, Lyrics | null>();

  // transcriptions par IA : une à la fois (c'est lourd), résultats gardés 1 h en mémoire
  interface TJob { id: string; videoId: string; status: 'queued' | 'running' | 'done' | 'error'; progress: number; label: string; lyrics?: Lyrics; error?: string; at: number }
  const tjobs = new Map<string, TJob>();
  const tByVideo = new Map<string, TJob>();
  let tChain: Promise<void> = Promise.resolve();
  const startTranscription = (videoId: string, meta: { title?: string; author?: string }): TJob => {
    const existing = tByVideo.get(videoId);
    if (existing && existing.status !== 'error' && Date.now() - existing.at < 3600_000) return existing;
    const job: TJob = { id: crypto.randomUUID(), videoId, status: 'queued', progress: 0, label: 'En attente…', at: Date.now() };
    tjobs.set(job.id, job);
    tByVideo.set(videoId, job);
    tChain = tChain.then(async () => {
      try {
        job.status = 'running';
        job.label = 'Récupération de l’audio…';
        await audio!.cache.ensure(videoId, () => audio!.download(videoId));
        const file = audio!.cache.original(videoId);
        if (!file) throw new Error('Audio indisponible.');
        job.label = 'Transcription par IA…';
        const lines = await opts.whisper!.transcribe(file, (f) => {
          job.progress = f;
          job.label = `Transcription par IA… ${Math.round(f * 100)} %`;
        });
        // quelques mots isolés = sans doute une hallucination sur un morceau instrumental
        const words = lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
        if (words < 6) throw new Error('Aucune parole détectée (morceau instrumental ?).');
        const names = cleanTitle(meta.title ?? '', meta.author ?? '');
        job.lyrics = { synced: lines, plain: null, track: names.track, artist: names.artist, source: 'Whisper (IA)' };
        job.status = 'done';
        job.progress = 1;
        job.label = 'Terminé';
        void catalogue?.putLyrics(videoId, job.lyrics);
      } catch (e) {
        job.status = 'error';
        job.error = (e as Error).message;
        console.warn(`✗ Transcription ${videoId} : ${job.error}`);
      }
      job.at = Date.now();
    });
    return job;
  };

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
    // apps Tauri (autre origine que le site) : autorisées à appeler l'API
    const origin = req.headers.origin;
    if (origin && path.startsWith('/api/') && opts.corsOrigins?.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
        return res.end();
      }
    }
    try {
      // catalogue partagé : analyse déjà faite par le serveur pour quelqu'un d'autre
      const cat = path.match(/^\/api\/catalogue\/([\w-]{11})$/);
      if (cat && req.method === 'GET') {
        const song = await catalogue?.get(cat[1]);
        return song ? json(res, 200, { song }) : json(res, 404, { error: 'Pas encore analysée.' });
      }

      // infos publiques d'une vidéo (pour les analyses faites sur l'appareil de l'utilisateur)
      const inf = path.match(/^\/api\/info\/([\w-]{11})$/);
      if (inf && req.method === 'GET') {
        const id = inf[1];
        if (!infoCache.has(id)) {
          infoCache.set(id, await getInfo(id).catch(() => null));
          if (infoCache.size > 1000) infoCache.delete(infoCache.keys().next().value!);
        }
        const info = infoCache.get(id);
        return info ? json(res, 200, { info }) : json(res, 404, { error: 'Vidéo introuvable.' });
      }

      if (path === '/api/analyze' && req.method === 'POST') {
        const body = (await readBody(req)) as { url?: unknown };
        const id = typeof body.url === 'string' ? parseYouTubeId(body.url) : null;
        if (!id) return json(res, 400, { error: 'Lien YouTube invalide.' });
        // analyse récente ou en cours : pas de nouveau téléchargement, pas de quota consommé
        const recent = queue.findByVideo(id);
        if (recent) return json(res, recent.song ? 200 : 202, { job: publicJob(recent), song: recent.song });
        const shared = await catalogue?.get(id);
        if (shared) return json(res, 200, { job: { id: 'catalogue', videoId: id, status: 'done', progress: 1, label: 'Déjà analysée', updatedAt: Date.now() }, song: shared });
        const ip = clientIp(req);
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
          const ip = clientIp(req);
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

      // contrôle de santé (Coolify, Docker) : le serveur répond
      if (path === '/api/health') return json(res, 200, { ok: true });

      if (path === '/api/features' && req.method === 'GET') {
        const whisper = !!(opts.whisper?.available() && audio);
        return json(res, 200, { whisper, whisperReason: whisper ? '' : opts.whisper?.reason?.() ?? 'non configuré', transposedAudio: !!audio });
      }

      if (path === '/api/lyrics/transcribe' && req.method === 'POST') {
        if (!opts.whisper?.available() || !audio) return json(res, 501, { error: 'La transcription par IA n’est pas installée sur ce serveur.' });
        const body = (await readBody(req)) as { videoId?: unknown; title?: unknown; author?: unknown };
        const id = typeof body.videoId === 'string' ? parseYouTubeId(body.videoId) : null;
        if (!id) return json(res, 400, { error: 'Vidéo invalide.' });
        const known = await catalogue?.getLyrics(id);
        if (known) return json(res, 200, { job: { id: 'catalogue', videoId: id, status: 'done', progress: 1, label: 'Terminé', at: Date.now() }, lyrics: known });
        if (!audio.cache.has(id) && !tByVideo.has(id)) {
          const ip = clientIp(req);
          if (!limiter.allow(ip)) return json(res, 429, { error: 'Trop de demandes : réessayez dans une heure.' });
        }
        const job = startTranscription(id, {
          title: typeof body.title === 'string' ? body.title.slice(0, 300) : undefined,
          author: typeof body.author === 'string' ? body.author.slice(0, 200) : undefined,
        });
        return json(res, 202, { job: { ...job, lyrics: undefined } });
      }

      const tj = path.match(/^\/api\/transcribe\/([\w-]+)$/);
      if (tj && req.method === 'GET') {
        const job = tjobs.get(tj[1]);
        if (!job) return json(res, 404, { error: 'Transcription inconnue ou expirée.' });
        return json(res, 200, { job: { ...job, lyrics: undefined }, lyrics: job.lyrics });
      }

      if (path === '/api/lyrics' && req.method === 'GET') {
        const title = url.searchParams.get('title')?.slice(0, 300) ?? '';
        if (!title.trim()) return json(res, 400, { error: 'Titre manquant.' });
        const cacheKey = `${title}|${url.searchParams.get('author') ?? ''}`;
        let lyrics = lyricsCache.get(cacheKey);
        if (lyrics === undefined) {
          try {
            lyrics = await (opts.findLyrics ?? findLyrics)({
              title,
              author: url.searchParams.get('author')?.slice(0, 200) ?? '',
              duration: Number(url.searchParams.get('duration')) || undefined,
            });
          } catch (e) {
            return json(res, 502, { error: `Paroles indisponibles : ${(e as Error).message}` });
          }
          lyricsCache.set(cacheKey, lyrics);
          if (lyricsCache.size > 500) lyricsCache.delete(lyricsCache.keys().next().value!);
        }
        return lyrics ? json(res, 200, { lyrics }) : json(res, 404, { error: 'Paroles introuvables pour ce morceau.' });
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

export interface PublicInfo {
  id: string;
  title: string;
  author: string;
  thumbnail: string;
  /** Faux si la vidéo ne peut pas être lue hors de YouTube. */
  embeddable: boolean;
}

/** Infos publiques via oEmbed (YouTube les sert aussi aux serveurs : pas de vérification anti-robot). */
async function oembedInfo(id: string): Promise<PublicInfo | null> {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
    signal: AbortSignal.timeout(8000),
  });
  // 401 : intégration désactivée par le propriétaire (la vidéo existe)
  if (r.status === 401 || r.status === 403) return { id, title: 'Vidéo YouTube', author: '', thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, embeddable: false };
  if (!r.ok) return null;
  const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
  return { id, title: j.title ?? 'Vidéo YouTube', author: j.author_name ?? '', thumbnail: j.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, embeddable: true };
}

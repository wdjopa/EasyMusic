import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeWav } from '../src/ui/wav';
import { synthChords } from './helpers';

// Faux yt-dlp : répond à -J et « télécharge » un WAV de démo en affichant une progression.
const FAKE_YTDLP = (wav: string) => `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const url = a[a.length - 1];
if (url.includes('privvvvvvvv')) { console.error('ERROR: [youtube] privvvvvvvv: Private video'); process.exit(1); }
if (url.includes('longgggggggg'.slice(0, 11))) { console.log(JSON.stringify({ title: 'Long', duration: 99999 })); process.exit(0); }
if (a.includes('-J')) { console.log(JSON.stringify({ title: 'Chanson de test', channel: 'Artiste', duration: 16 })); process.exit(0); }
if (url.includes('refus403000') && !a.includes('18/worst[acodec!=none]/best')) { console.error('ERROR: [download] Got error: HTTP Error 403: Forbidden'); process.exit(1); }
if (url.includes('toujours403')) { console.error('ERROR: unable to download video data: HTTP Error 403: Forbidden'); process.exit(1); }
const out = a[a.indexOf('-o') + 1].replace('%(ext)s', 'wav');
if (url.includes('sinus440abc')) { fs.copyFileSync(process.env.SINE_WAV, out); process.exit(0); }
for (const p of [10, 50, 100]) console.log('PROGRESS ' + p + '.0%');
fs.copyFileSync(${JSON.stringify(wav)}, out);
`;

let server: Server;
let base = '';
let dataDir = '';
let cache: import('../server/audioCache').AudioCache;
let sineWav = '';

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'easymusic-test-'));
  dataDir = join(dir, 'data');
  const sr = 44100;
  const seq = [
    { root: 0, quality: 'maj' as const },
    { root: 9, quality: 'min' as const },
    { root: 5, quality: 'maj' as const },
    { root: 7, quality: 'maj' as const },
  ];
  const audio = synthChords([...seq, ...seq], 2, sr);
  const wav = join(dir, 'demo.wav');
  await writeFile(wav, Buffer.from(await encodeWav([audio, audio], sr).arrayBuffer()));
  const sine = new Float32Array(sr * 4);
  for (let i = 0; i < sine.length; i++) sine[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sr);
  sineWav = join(dir, 'sine.wav');
  await writeFile(sineWav, Buffer.from(await encodeWav([sine, sine], sr).arrayBuffer()));
  process.env.SINE_WAV = sineWav;
  const yt = join(dir, 'yt-dlp');
  await writeFile(yt, FAKE_YTDLP(wav));
  await chmod(yt, 0o755);
  Object.assign(process.env, { YTDLP_PATH: yt, RATE_LIMIT_PER_HOUR: '8', TMPDIR: dataDir });
  await mkdir(dataDir, { recursive: true });

  const { JobQueue } = await import('../server/jobs');
  const { createApp } = await import('../server/app');
  const { fetchInfo, downloadAudio } = await import('../server/youtube');
  const { AudioCache } = await import('../server/audioCache');
  cache = new AudioCache();
  const queue = new JobQueue({ fetchInfo, downloadAudio }, 2, (id, d, f) => cache.keep(id, d, f));
  const handler = createApp({
    queue,
    rateLimitPerHour: 8,
    audio: { cache, download: (id) => downloadAudio(id, () => {}, (d, f) => cache.keep(id, d, f)).then(() => undefined) },
  });
  server = createServer((q, r) => void handler(q, r));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  server?.close();
  await cache?.clear();
});

async function post(url: string) {
  const r = await fetch(`${base}/api/analyze`, { method: 'POST', body: JSON.stringify({ url }) });
  return { status: r.status, body: await r.json() };
}
async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (r.job.status === 'done' || r.job.status === 'error') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('délai dépassé');
}

describe('serveur', () => {
  it('télécharge, analyse et renvoie les accords, l’audio n’étant gardé que temporairement', async () => {
    const { status, body } = await post('https://youtu.be/abcdefghijk');
    expect(status).toBe(202);
    const r = await waitJob(body.job.id);
    expect(r.job.status).toBe('done');
    expect(r.song.title).toBe('Chanson de test');
    const segs = r.song.analysis.segments.filter((s: { end: number; start: number }) => s.end - s.start > 1);
    expect(segs.length).toBeGreaterThanOrEqual(6);
    expect(r.song.analysis.key).toEqual({ tonic: 0, mode: 'major' });
    // l'audio n'est gardé que dans le cache temporaire de lecture, qui supprime tout quand il est vidé
    expect(cache.has('abcdefghijk')).toBe(true);
    await cache.clear();
    expect((await readdir(dataDir)).filter((f) => f.startsWith('easymusic-'))).toEqual([]);
    // une deuxième demande récente répond directement, sans nouveau téléchargement
    const again = await post('https://www.youtube.com/watch?v=abcdefghijk');
    expect(again.status).toBe(200);
    expect(again.body.song.id).toBe('abcdefghijk');
  });

  it('réessaie autrement quand YouTube refuse un format (403)', async () => {
    const r = await waitJob((await post('refus403000')).body.job.id);
    expect(r.job.status).toBe('done');
    expect(r.song.analysis.segments.length).toBeGreaterThan(3);
  });

  it('explique clairement un refus persistant', async () => {
    const r = await waitJob((await post('toujours403')).body.job.id);
    expect(r.job.status).toBe('error');
    expect(r.job.error).toMatch(/erreur 403/);
  });

  it('prépare et sert l’audio transposé (avec lecture partielle)', async () => {
    // vidéo jamais analysée : le serveur la télécharge pour la lecture
    const r = await fetch(`${base}/api/audio/sinus440abc/prepare`, { method: 'POST', body: JSON.stringify({ semitones: 3 }) });
    expect(r.status).toBe(200);
    const { url } = await r.json();
    expect(url).toMatch(/^\/api\/audio\/sinus440abc\/3\.(mp3|m4a)$/);
    const full = await fetch(base + url);
    expect(full.status).toBe(200);
    const bytes = Buffer.from(await full.arrayBuffer());
    const part = await fetch(base + url, { headers: { range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));
    // le son est bien transposé (+3 demi-tons : 440 -> 523 Hz) et dure toujours ~4 s
    const out = join(dataDir, `check.${url.split('.').pop()}`);
    await writeFile(out, bytes);
    const { decode } = await import('../server/youtube');
    const pcm = await decode(out);
    expect(Math.abs(pcm.length / 22050 - 4)).toBeLessThan(0.15);
    const { dominantFreq } = await import('./helpers');
    const f = dominantFreq(pcm, 22050);
    expect(f).toBeGreaterThan(510);
    expect(f).toBeLessThan(537);
    // l'original est aussi disponible ; une valeur absurde est refusée
    expect((await fetch(`${base}/api/audio/sinus440abc/prepare`, { method: 'POST', body: '{"semitones":0}' })).status).toBe(200);
    expect((await fetch(`${base}/api/audio/sinus440abc/prepare`, { method: 'POST', body: '{"semitones":40}' })).status).toBe(400);
    expect((await fetch(`${base}/api/audio/zzzzzzzzzzz/7.mp3`)).status).toBe(404);
  });

  it('rejette les liens invalides', async () => {
    expect((await post('https://vimeo.com/1')).status).toBe(400);
    expect((await post('; rm -rf /')).status).toBe(400);
  });

  it('remonte des erreurs compréhensibles', async () => {
    const priv = await waitJob((await post('privvvvvvvv')).body.job.id);
    expect(priv.job.error).toMatch(/indisponible ou privée/);
    const long = await waitJob((await post('longgggggggg'.slice(0, 11))).body.job.id);
    expect(long.job.error).toMatch(/trop longue/);
  });

  it('limite le nombre d’analyses par heure', async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await post(`zzzzzzzzzz${i}`)).status;
    expect(last).toBe(429);
  });
});

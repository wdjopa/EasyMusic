import { chmod, mkdtemp, readdir, writeFile } from 'node:fs/promises';
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
const out = a[a.indexOf('-o') + 1].replace('%(ext)s', 'wav');
for (const p of [10, 50, 100]) console.log('PROGRESS ' + p + '.0%');
fs.copyFileSync(${JSON.stringify(wav)}, out);
`;

let server: Server;
let base = '';
let dataDir = '';

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
  const yt = join(dir, 'yt-dlp');
  await writeFile(yt, FAKE_YTDLP(wav));
  await chmod(yt, 0o755);
  Object.assign(process.env, { YTDLP_PATH: yt, DATA_DIR: dataDir, RATE_LIMIT_PER_HOUR: '5' });

  const { Catalogue } = await import('../server/catalogue');
  const { JobQueue } = await import('../server/jobs');
  const { createApp } = await import('../server/app');
  const { fetchInfo, downloadAudio } = await import('../server/youtube');
  const catalogue = new Catalogue(dataDir);
  await catalogue.load();
  const queue = new JobQueue(catalogue, { fetchInfo, downloadAudio });
  const handler = createApp({ catalogue, queue, rateLimitPerHour: 5 });
  server = createServer((q, r) => void handler(q, r));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => server?.close());

async function post(url: string) {
  const r = await fetch(`${base}/api/songs`, { method: 'POST', body: JSON.stringify({ url }) });
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
  it('télécharge, analyse, ajoute au catalogue et ne garde pas l’audio', async () => {
    const { status, body } = await post('https://youtu.be/abcdefghijk');
    expect(status).toBe(202);
    const r = await waitJob(body.job.id);
    expect(r.job.status).toBe('done');
    expect(r.song.title).toBe('Chanson de test');
    const names = r.song.analysis.segments.filter((s: { end: number; start: number }) => s.end - s.start > 1);
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(r.song.analysis.key).toEqual({ tonic: 0, mode: 'major' });

    const cat = await (await fetch(`${base}/api/catalogue`)).json();
    expect(cat.songs.map((s: { id: string }) => s.id)).toEqual(['abcdefghijk']);
    expect(cat.songs[0].analysis).toBeUndefined();
    // seul le JSON est stocké
    expect(await readdir(join(dataDir, 'songs'))).toEqual(['abcdefghijk.json']);

    // une deuxième demande répond directement depuis le catalogue
    const again = await post('https://www.youtube.com/watch?v=abcdefghijk');
    expect(again.status).toBe(200);
    expect(again.body.song.id).toBe('abcdefghijk');
    expect((await fetch(`${base}/api/songs/abcdefghijk`)).status).toBe(200);
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
    for (let i = 0; i < 6; i++) last = (await post(`zzzzzzzzzz${i}`)).status;
    expect(last).toBe(429);
  });
});

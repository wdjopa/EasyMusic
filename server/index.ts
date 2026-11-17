import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { config } from './config';
import { analyzeOffThread } from './analyzer';
import { AudioCache } from './audioCache';
import { JobQueue } from './jobs';
import { downloadAudio, fetchInfo } from './youtube';

const audioCache = new AudioCache();
const queue = new JobQueue({ fetchInfo, downloadAudio, analyze: analyzeOffThread }, undefined, (id, dir, file) =>
  audioCache.keep(id, dir, file),
);
const handler = createApp({
  queue,
  audio: {
    cache: audioCache,
    // téléchargement pour la lecture seule (chanson ouverte depuis le catalogue)
    download: (id) => downloadAudio(id, () => {}, (dir, file) => audioCache.keep(id, dir, file)).then(() => undefined),
  },
  staticDir: existsSync(config.staticDir) ? config.staticDir : undefined,
  rateLimitPerHour: config.rateLimitPerHour,
});

createServer((req, res) => void handler(req, res)).listen(config.port, () => {
  console.log(`EasyMusic : http://localhost:${config.port}`);
});

// ne laisser aucun fichier audio derrière soi
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void audioCache.clear().finally(() => process.exit(0)));
}

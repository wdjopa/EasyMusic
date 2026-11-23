import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { config } from './config';
import { analyzeOffThread } from './analyzer';
import { AudioCache } from './audioCache';
import { JobQueue } from './jobs';
import { Catalogue } from './catalogue';
import { transcribe, whisperAvailable, whisperReason } from './whisper';
import { decode, downloadAudio, fetchInfo } from './youtube';
import { separate, separationAvailable } from './separate';

const audioCache = new AudioCache();
const catalogue = new Catalogue(config.dataDir);
const queue = new JobQueue(
  { fetchInfo, downloadAudio, analyze: analyzeOffThread },
  undefined,
  (id, dir, file) => audioCache.keep(id, dir, file),
  (song) => void catalogue.put(song),
);
const handler = createApp({
  queue,
  whisper: { available: whisperAvailable, reason: whisperReason, transcribe },
  audio: {
    cache: audioCache,
    // téléchargement pour la lecture seule (chanson ouverte depuis le catalogue)
    download: (id) => downloadAudio(id, () => {}, (dir, file) => audioCache.keep(id, dir, file)).then(() => undefined),
  },
  staticDir: existsSync(config.staticDir) ? config.staticDir : undefined,
  rateLimitPerHour: config.rateLimitPerHour,
  separation: {
    available: separationAvailable,
    separate,
    analyze: async (instrumental, vocals, onProgress) =>
      analyzeOffThread(await decode(instrumental), config.sampleRate, onProgress, await decode(vocals)),
  },
  catalogue,
  corsOrigins: config.corsOrigins,
});

createServer((req, res) => void handler(req, res)).listen(config.port, () => {
  console.log(`EnjoySing : http://localhost:${config.port}`);
  whisperAvailable(); // affiche tout de suite si les paroles par IA sont prêtes, et sinon pourquoi
  setTimeout(() => separationAvailable(), 2000); // idem pour la séparation (import de torch : quelques secondes)
});

// ne laisser aucun fichier audio derrière soi
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void audioCache.clear().finally(() => process.exit(0)));
}

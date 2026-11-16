import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { Catalogue } from './catalogue';
import { config } from './config';
import { analyzeOffThread } from './analyzer';
import { JobQueue } from './jobs';
import { downloadAudio, fetchInfo } from './youtube';

const catalogue = new Catalogue(config.dataDir);
await catalogue.load();
const queue = new JobQueue(catalogue, { fetchInfo, downloadAudio, analyze: analyzeOffThread });
const handler = createApp({
  catalogue,
  queue,
  staticDir: existsSync(config.staticDir) ? config.staticDir : undefined,
  rateLimitPerHour: config.rateLimitPerHour,
});

createServer((req, res) => void handler(req, res)).listen(config.port, () => {
  console.log(`EasyMusic : http://localhost:${config.port}  (${catalogue.list().length} chansons au catalogue)`);
});

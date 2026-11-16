import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { createApp } from './app';
import { config } from './config';
import { analyzeOffThread } from './analyzer';
import { JobQueue } from './jobs';
import { downloadAudio, fetchInfo } from './youtube';

const queue = new JobQueue({ fetchInfo, downloadAudio, analyze: analyzeOffThread });
const handler = createApp({
  queue,
  staticDir: existsSync(config.staticDir) ? config.staticDir : undefined,
  rateLimitPerHour: config.rateLimitPerHour,
});

createServer((req, res) => void handler(req, res)).listen(config.port, () => {
  console.log(`EasyMusic : http://localhost:${config.port}`);
});

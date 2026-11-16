import { resolve } from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Dossier des données (catalogue). */
  dataDir: resolve(env.DATA_DIR ?? 'data'),
  /** Dossier du site compilé (production). */
  staticDir: resolve(env.STATIC_DIR ?? 'dist'),
  ytDlp: env.YTDLP_PATH ?? 'yt-dlp',
  ffmpeg: env.FFMPEG_PATH ?? 'ffmpeg',
  /** Fichier de cookies YouTube (format Netscape), utile si YouTube bloque le serveur. */
  cookies: env.YTDLP_COOKIES || undefined,
  /** Arguments supplémentaires pour yt-dlp (séparés par des espaces), ex. « --proxy http://… ». */
  ytDlpExtraArgs: (env.YTDLP_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
  /** Durée maximale d'une vidéo analysée (s). */
  maxDuration: Number(env.MAX_DURATION ?? 15 * 60),
  /** Analyses simultanées. */
  concurrency: Number(env.CONCURRENCY ?? 2),
  /** Nouvelles analyses autorisées par adresse IP et par heure. */
  rateLimitPerHour: Number(env.RATE_LIMIT_PER_HOUR ?? 20),
  /** Fréquence d'échantillonnage utilisée pour l'analyse. */
  sampleRate: 22050,
};

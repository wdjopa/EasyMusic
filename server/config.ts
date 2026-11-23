import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
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
  /** Whisper (whisper.cpp) pour transcrire les paroles introuvables. */
  whisperCli: env.WHISPER_CLI ?? 'whisper-cli',
  /** Modèle Whisper : celui indiqué, sinon le meilleur trouvé dans models/ (voir npm run whisper:setup). */
  whisperModel: resolve(
    env.WHISPER_MODEL ??
      ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-small.bin', 'ggml-base.bin']
        .map((m) => `models/${m}`)
        .find((m) => existsSync(m)) ??
      'models/ggml-large-v3-turbo-q5_0.bin',
  ),
  /** Langue des paroles (« auto » : détection automatique). */
  whisperLanguage: env.WHISPER_LANGUAGE ?? 'auto',
  whisperThreads: Number(env.WHISPER_THREADS ?? 4),
  /** Réglage DTW (déduit du nom du modèle si absent). */
  whisperDtw: env.WHISPER_DTW || undefined,
  /** Séparation voix / instruments (Demucs) : Python qui a demucs et torch installés. */
  demucsPython: env.DEMUCS_PYTHON ?? 'python3',
  demucsModel: env.DEMUCS_MODEL ?? 'htdemucs',
  demucsThreads: Number(env.DEMUCS_THREADS ?? env.WHISPER_THREADS ?? 4),
  /** Dossier du catalogue partagé (analyses et paroles déjà calculées). */
  dataDir: resolve(env.DATA_DIR ?? 'data'),
  /** Origines autorisées à appeler l'API depuis un autre site (apps Tauri, développement). */
  corsOrigins: (env.CORS_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:1420')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Fréquence d'échantillonnage utilisée pour l'analyse. */
  sampleRate: 22050,
};

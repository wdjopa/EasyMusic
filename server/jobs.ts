import { randomUUID } from 'node:crypto';
import { analyze, type AnalysisResult, type Progress } from '../src/dsp/analyze';
import type { Song } from './song';
import { config } from './config';
import { UserError, type VideoInfo } from './youtube';

export type JobStatus = 'queued' | 'downloading' | 'analyzing' | 'done' | 'error';

export interface Job {
  id: string;
  videoId: string;
  status: JobStatus;
  progress: number;
  label: string;
  error?: string;
  title?: string;
  /** Résultat, gardé en mémoire uniquement (1 h), le temps que le navigateur le récupère. */
  song?: Song;
  updatedAt: number;
}

/** Ce dont la file a besoin pour récupérer une vidéo (remplaçable dans les tests). */
export interface Source {
  fetchInfo(id: string): Promise<VideoInfo>;
  downloadAudio(id: string, onProgress: (f: number) => void): Promise<Float32Array>;
  /** Analyse (par défaut : dans le thread courant). */
  analyze?: (audio: Float32Array, sampleRate: number, onProgress: Progress) => Promise<AnalysisResult>;
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private byVideo = new Map<string, Job>();
  private waiting: Job[] = [];
  private running = 0;

  constructor(
    private source: Source,
    private concurrency = config.concurrency,
  ) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Analyse récente (en cours ou terminée) pour cette vidéo, s'il y en a une. */
  findByVideo(videoId: string): Job | undefined {
    this.cleanup();
    const j = this.byVideo.get(videoId);
    return j && j.status !== 'error' ? j : undefined;
  }

  /** Crée une analyse, ou renvoie celle déjà en cours (ou récente) pour la même vidéo. */
  submit(videoId: string): Job {
    const existing = this.findByVideo(videoId);
    if (existing) return existing;
    const job: Job = { id: randomUUID(), videoId, status: 'queued', progress: 0, label: 'En attente…', updatedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.byVideo.set(videoId, job);
    this.waiting.push(job);
    this.pump();
    this.cleanup();
    return job;
  }

  private update(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: Date.now() });
  }

  private pump() {
    while (this.running < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.running++;
      this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job) {
    try {
      this.update(job, { status: 'downloading', label: 'Récupération des informations…', progress: 0.02 });
      const info = await this.source.fetchInfo(job.videoId);
      this.update(job, { title: info.title });
      if (info.duration > config.maxDuration)
        throw new UserError(`Vidéo trop longue (${Math.round(info.duration / 60)} min, maximum ${Math.round(config.maxDuration / 60)} min).`);
      this.update(job, { label: 'Téléchargement de l’audio…', progress: 0.05 });
      const audio = await this.source.downloadAudio(job.videoId, (f) =>
        this.update(job, { progress: 0.05 + f * 0.6, label: `Téléchargement de l’audio… ${Math.round(f * 100)} %` }),
      );
      this.update(job, { status: 'analyzing', label: 'Analyse des accords…', progress: 0.7 });
      const onProgress: Progress = (f, label) => this.update(job, { progress: 0.7 + f * 0.28, label });
      const analysis = this.source.analyze
        ? await this.source.analyze(audio, config.sampleRate, onProgress)
        : analyze([audio], config.sampleRate, onProgress);
      // l'audio n'est plus référencé : il sera libéré, seul le résultat est conservé
      const song: Song = {
        id: info.id,
        title: info.title,
        author: info.author,
        duration: info.duration || analysis.duration,
        thumbnail: info.thumbnail,
        analysis,
      };
      this.update(job, { status: 'done', progress: 1, label: 'Terminé', song });
    } catch (e) {
      const err = e as Error;
      if (!(err instanceof UserError)) console.error(`Analyse ${job.videoId} :`, err.message);
      this.update(job, { status: 'error', error: err.message, label: 'Erreur' });
    }
  }

  /** Oublie les tâches terminées depuis plus d'une heure. */
  private cleanup() {
    const limit = Date.now() - 3600_000;
    for (const [id, j] of this.jobs) {
      if ((j.status === 'done' || j.status === 'error') && j.updatedAt < limit) {
        this.jobs.delete(id);
        if (this.byVideo.get(j.videoId) === j) this.byVideo.delete(j.videoId);
      }
    }
  }
}

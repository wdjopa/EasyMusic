import { Worker } from 'node:worker_threads';
import type { AnalysisResult, Progress } from '../src/dsp/analyze';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: AnalysisResult) => void; reject: (e: Error) => void; onProgress: Progress }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./analyzeWorker.ts', import.meta.url));
  w.on('message', (m: { id: number; type: string; result?: AnalysisResult; message?: string; fraction?: number; label?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') p.onProgress(m.fraction!, m.label!);
    else {
      pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.result!);
      else p.reject(new Error(m.message));
    }
  });
  w.on('error', (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
    worker = null;
  });
  w.unref();
  worker = w;
  return w;
}

/** Analyse un signal mono dans un thread dédié. */
export function analyzeOffThread(audio: Float32Array, sampleRate: number, onProgress: Progress): Promise<AnalysisResult> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, audio, sampleRate }, [audio.buffer as ArrayBuffer]);
  });
}

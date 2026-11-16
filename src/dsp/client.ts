import type { AnalysisResult } from './analyze';
import type { WorkerRequest, WorkerResponse } from './worker';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (f: number, l: string) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') p.onProgress?.(msg.fraction, msg.label);
    else {
      pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.message));
    }
  };
  return worker;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function call<T>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: Pending['onProgress']): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
    getWorker().postMessage({ ...req, id });
  });
}

export function analyzeInWorker(buffer: AudioBuffer, onProgress?: Pending['onProgress']): Promise<AnalysisResult> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
  return analyzeChannels(channels, buffer.sampleRate, onProgress);
}

export function analyzeChannels(channels: Float32Array[], sampleRate: number, onProgress?: Pending['onProgress']): Promise<AnalysisResult> {
  return call({ type: 'analyze', channels, sampleRate }, onProgress);
}

export function shiftInWorker(buffer: AudioBuffer, semitones: number, onProgress?: Pending['onProgress']): Promise<Float32Array[]> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
  return call({ type: 'shift', channels, semitones }, onProgress);
}

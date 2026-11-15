/// <reference lib="webworker" />
import { analyze } from './analyze';
import { pitchShift } from './pitchshift';

export type WorkerRequest =
  | { id: number; type: 'analyze'; channels: Float32Array[]; sampleRate: number }
  | { id: number; type: 'shift'; channels: Float32Array[]; semitones: number };

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label: string }
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const progress = (fraction: number, label: string) =>
    ctx.postMessage({ id: req.id, type: 'progress', fraction, label } satisfies WorkerResponse);
  try {
    if (req.type === 'analyze') {
      const result = analyze(req.channels, req.sampleRate, progress);
      ctx.postMessage({ id: req.id, type: 'result', result } satisfies WorkerResponse);
    } else {
      const out: Float32Array[] = [];
      req.channels.forEach((ch, i) => {
        progress(i / req.channels.length, `Transposition du canal ${i + 1}/${req.channels.length}…`);
        out.push(pitchShift(ch, req.semitones));
      });
      ctx.postMessage({ id: req.id, type: 'result', result: out } satisfies WorkerResponse, out.map((c) => c.buffer));
    }
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'error', message: String((err as Error)?.message ?? err) } satisfies WorkerResponse);
  }
};

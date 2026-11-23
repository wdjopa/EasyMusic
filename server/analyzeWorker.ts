import { parentPort } from 'node:worker_threads';
import { analyze } from '../src/dsp/analyze';

// Analyse dans un thread séparé pour ne pas bloquer le serveur.
parentPort!.on('message', (msg: { id: number; audio: Float32Array; sampleRate: number; vocals?: Float32Array }) => {
  try {
    const result = analyze([msg.audio], msg.sampleRate, (fraction, label) =>
      parentPort!.postMessage({ id: msg.id, type: 'progress', fraction, label }),
      msg.vocals ? { vocals: [msg.vocals] } : {},
    );
    parentPort!.postMessage({ id: msg.id, type: 'result', result });
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, type: 'error', message: (e as Error).message });
  }
});

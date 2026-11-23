// Prises de chant : enregistrement de la voix pendant l'entraînement, et prises gardées dans le navigateur
// (IndexedDB : rien n'est envoyé au serveur).
import type { NoteResult, TakeSummary, TimelinePoint } from '../dsp/voiceEval';

export interface Take {
  id: string;
  songKey: string; // identifiant YouTube, ou « file:nom »
  title: string;
  date: string;
  blob: Blob;
  /** Correspondance temps de l'enregistrement -> temps du morceau. */
  timeline: TimelinePoint[];
  /** Son entendu pendant la prise : original (0) ou transposé (demi-tons). */
  semitones: number;
  /** Plage du morceau couverte par la prise. */
  range: { start: number; end: number };
  summary: TakeSummary;
  notes: NoteResult[];
  /** Voix retenue après nettoyage : [temps du morceau, note MIDI]. */
  voice: [number, number][];
}

// ---------------------------------------------------------------- enregistrement
export class TakeRecorder {
  private rec: MediaRecorder;
  private parts: Blob[] = [];
  private t0 = 0;
  readonly timeline: TimelinePoint[] = [];

  constructor(stream: MediaStream) {
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.parts.push(e.data);
    this.rec.start(1000);
    this.t0 = performance.now();
  }

  /** À chaque bloc du micro : où en est le morceau. Un point n'est ajouté que si la lecture a changé. */
  mark(song: number, playing: boolean, rate: number) {
    const rec = (performance.now() - this.t0) / 1000;
    const last = this.timeline[this.timeline.length - 1];
    if (last) {
      const predicted = last.playing ? last.song + (rec - last.rec) * last.rate : last.song;
      if (last.playing === playing && last.rate === rate && Math.abs(predicted - song) < 0.25) return;
    }
    this.timeline.push({ rec, song, playing, rate });
  }

  get duration() {
    return (performance.now() - this.t0) / 1000;
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      if (this.rec.state === 'inactive') return resolve(new Blob(this.parts, { type: this.rec.mimeType }));
      this.rec.onstop = () => resolve(new Blob(this.parts, { type: this.rec.mimeType || 'audio/webm' }));
      this.rec.stop();
    });
  }
}

// ---------------------------------------------------------------- prises gardées
const DB = 'easymusic-takes';
const STORE = 'takes';
let dbP: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  dbP ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('song', 'songKey');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Stockage indisponible.'));
  });
  return dbP;
}
function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const r = run(db.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

export async function saveTake(t: Take): Promise<void> {
  void navigator.storage?.persist?.();
  await tx('readwrite', (s) => s.put(t));
}
export function deleteTake(id: string): Promise<unknown> {
  return tx('readwrite', (s) => s.delete(id));
}
export async function takesFor(songKey: string): Promise<Take[]> {
  try {
    const all = await tx<Take[]>('readonly', (s) => s.index('song').getAll(songKey));
    return all.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}
export async function hasTake(id: string): Promise<boolean> {
  try {
    return !!(await tx('readonly', (s) => s.getKey(id)));
  } catch {
    return false;
  }
}

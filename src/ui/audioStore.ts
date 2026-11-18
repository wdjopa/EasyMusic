// Audio des chansons gardé dans le navigateur (IndexedDB : prévu pour les gros fichiers,
// contrairement à localStorage limité à ~5 Mo). Une chanson n'est téléchargée qu'une fois.

const DB = 'easymusic-audio';
const STORE = 'audio';

interface Entry {
  id: string;
  blob: Blob;
  savedAt: string;
  size: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) return reject(new Error('Stockage indisponible dans ce navigateur.'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Stockage indisponible.'));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Identifiants des chansons dont l'audio est enregistré (pour l'affichage dans le catalogue). */
export const storedIds = new Set<string>();
const listeners: (() => void)[] = [];
export function onStoredChange(fn: () => void) {
  listeners.push(fn);
}
const emit = () => listeners.forEach((fn) => fn());

export async function loadStoredIds(): Promise<void> {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    storedIds.clear();
    for (const k of keys) storedIds.add(String(k));
    emit();
  } catch {
    /* stockage indisponible : on fera sans */
  }
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  try {
    const e = await tx<Entry | undefined>('readonly', (s) => s.get(id));
    return e?.blob;
  } catch {
    return undefined;
  }
}

export async function putAudio(id: string, blob: Blob): Promise<boolean> {
  try {
    // demande au navigateur de ne pas effacer ces fichiers quand l'espace manque
    void navigator.storage?.persist?.();
    await tx('readwrite', (s) => s.put({ id, blob, savedAt: new Date().toISOString(), size: blob.size } satisfies Entry));
    storedIds.add(id);
    emit();
    return true;
  } catch {
    return false; // espace plein ou stockage refusé
  }
}

export async function deleteAudio(id: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(id));
  } catch {
    /* rien à supprimer */
  }
  storedIds.delete(id);
  emit();
}

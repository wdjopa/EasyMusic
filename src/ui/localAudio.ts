// Audio d'une chanson YouTube : depuis le navigateur s'il est enregistré, sinon récupéré une seule fois
// auprès du serveur puis enregistré. La transposition se calcule ensuite dans le navigateur.
import { shiftInWorker } from '../dsp/client';
import { prepareTransposedAudio } from './api';
import { getAudio, putAudio } from './audioStore';
import { audioProvider } from './audioProvider';
import { encodeWav } from './wav';

const inFlight = new Map<string, Promise<Blob>>();

/** Récupère l'audio original auprès du serveur et l'enregistre dans le navigateur. */
export function fetchAndStoreAudio(id: string): Promise<Blob> {
  let p = inFlight.get(id);
  if (!p) {
    p = (async () => {
      // fournisseur local (app, extension) : depuis l'appareil, sans passer par le serveur
      const local = audioProvider();
      if (local?.priority === 'first') {
        const blob = await local.fetchAudio(id, () => {});
        await putAudio(id, blob);
        return blob;
      }
      const url = await prepareTransposedAudio(id, 0);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Audio indisponible (${r.status})`);
      const blob = await r.blob();
      await putAudio(id, blob);
      return blob;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

/** L'audio original : celui du navigateur s'il existe, sinon téléchargé une fois. */
export async function songAudio(id: string): Promise<Blob> {
  return (await getAudio(id)) ?? fetchAndStoreAudio(id);
}

// caches de la session (mémoire) : audio décodé de la chanson ouverte, versions transposées récentes
let decoded: { id: string; buffer: Promise<AudioBuffer> } | null = null;
const urls = new Map<string, string>();

function remember(key: string, url: string) {
  urls.set(key, url);
  // au-delà de 4 versions, on libère la plus ancienne (une version transposée pèse ~40 Mo)
  while (urls.size > 4) {
    const [k, u] = urls.entries().next().value!;
    URL.revokeObjectURL(u);
    urls.delete(k);
  }
}

async function decode(blob: Blob): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return ctx.decodeAudioData(await blob.arrayBuffer());
}

/**
 * Adresse à lire pour la chanson `id` transposée de `semitones` demi-tons :
 * tout est fait dans le navigateur à partir de l'audio enregistré.
 */
export async function localAudioUrl(id: string, semitones: number, onProgress?: (label: string) => void): Promise<string> {
  const key = `${id}:${semitones}`;
  const cached = urls.get(key);
  if (cached) return cached;
  onProgress?.('Récupération du son…');
  const blob = await songAudio(id);
  if (!semitones) {
    const url = URL.createObjectURL(blob);
    remember(key, url);
    return url;
  }
  if (decoded?.id !== id) decoded = { id, buffer: decode(blob) };
  onProgress?.('Transposition dans votre navigateur…');
  const buffer = await decoded.buffer;
  const chans = await shiftInWorker(buffer, semitones, (f) => onProgress?.(`Transposition dans votre navigateur… ${Math.round(f * 100)} %`));
  const url = URL.createObjectURL(encodeWav(chans, buffer.sampleRate));
  remember(key, url);
  return url;
}

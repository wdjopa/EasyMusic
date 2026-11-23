// Obtenir l'analyse d'une vidéo YouTube, par le chemin le plus rapide et le plus fiable :
//  1. le catalogue partagé du serveur (déjà analysée pour quelqu'un : instantané) ;
//  2. un fournisseur d'audio local « prioritaire » (app ordinateur : yt-dlp sur l'appareil) ;
//  3. le serveur (téléchargement + analyse) ;
//  4. en secours, un fournisseur local « de secours » (extension) si le serveur échoue.
// Avec un fournisseur local, l'analyse se fait dans le navigateur et l'audio y est gardé.
import { ANALYSIS_VERSION } from '../dsp/analyze';
import { analyzeInWorker } from '../dsp/client';
import { decodableAudio } from '../dsp/fmp4';
import { analyzeVideo, catalogueSong, videoInfo, type Song } from './api';
import { putAudio } from './audioStore';
import { audioProvider, type LocalAudioProvider } from './audioProvider';

type Progress = (fraction: number, label: string, title?: string) => void;

/** Analyse dans le navigateur à partir de l'audio récupéré sur l'appareil. */
export async function analyzeWithProvider(p: LocalAudioProvider, id: string, onProgress: Progress, signal?: { cancelled: boolean }): Promise<Song> {
  type LocalInfo = Awaited<ReturnType<NonNullable<LocalAudioProvider['fetchInfo']>>>;
  const none: LocalInfo = {};
  const metaP = Promise.all([videoInfo(id), p.fetchInfo?.(id).catch(() => none) ?? Promise.resolve(none)]);
  onProgress(0.02, `Téléchargement de l’audio (${p.label})…`);
  const blob = await p.fetchAudio(id, (f, l) => onProgress(0.02 + f * 0.5, l || `Téléchargement de l’audio… ${Math.round(f * 100)} %`), signal);
  if (signal?.cancelled) throw new Error('annulé');
  onProgress(0.55, 'Décodage…');
  const { blob: audio, buffer } = await decodeAny(blob);
  // durée attendue connue (infos de la vidéo) : un son nettement plus court = téléchargement ou décodage incomplet
  const [server, local] = await metaP;
  const expected = local.duration;
  if (expected && buffer.duration < expected * 0.9)
    throw new Error(`son incomplet : ${Math.round(buffer.duration)} s décodées sur ${Math.round(expected)} s`);
  const analysis = await step('analyse des accords', () => analyzeInWorker(buffer, (f, l) => onProgress(0.6 + f * 0.38, l)));
  await putAudio(id, audio); // gardé dans le navigateur : plus jamais téléchargé
  return {
    id,
    title: local.title ?? server?.title ?? 'Vidéo YouTube',
    author: local.author ?? server?.author ?? '',
    thumbnail: local.thumbnail ?? server?.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    embeddable: local.embeddable ?? server?.embeddable ?? true,
    duration: local.duration ?? buffer.duration,
    analysis,
  };
}

/** Message lisible d'une erreur quelconque (certains navigateurs rejettent avec null ou sans message). */
export function describeError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  const any = e as { message?: unknown; name?: unknown } | null | undefined;
  if (any && typeof any.message === 'string' && any.message) return any.message;
  if (any && typeof any.name === 'string' && any.name) return any.name;
  return e == null ? 'erreur sans message' : String(e);
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Error(`${label} : ${describeError(e)}`);
  }
}

/**
 * Décode le son, en essayant d'abord la version « décodable partout » (m4a fragmenté de YouTube
 * converti en AAC simple, voir dsp/fmp4.ts), puis le fichier d'origine.
 */
async function decodeAny(original: Blob): Promise<{ blob: Blob; buffer: AudioBuffer }> {
  const size = `${(original.size / 1e6).toFixed(1).replace('.', ',')} Mo`;
  if (original.size < 10_000) throw new Error(`le son reçu est vide ou presque (${original.size} octets)`);
  const candidates = [await decodableAudio(original).catch(() => original)];
  if (candidates[0] !== original) candidates.push(original);
  const errors: string[] = [];
  for (const blob of candidates) {
    try {
      const buffer = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
      if (buffer.duration < 1) throw new Error('durée nulle');
      return { blob, buffer };
    } catch (e) {
      errors.push(`${blob.type || 'type inconnu'} : ${describeError(e)}`);
    }
  }
  throw new Error(`décodage du son impossible (${original.type || 'type inconnu'}, ${size} ; ${errors.join(' ; ')})`);
}

export async function obtainSong(id: string, onProgress: Progress, signal?: { cancelled: boolean }): Promise<Song> {
  onProgress(0.01, 'Recherche dans le catalogue…');
  const shared = await catalogueSong(id);
  if (shared && shared.analysis.version === ANALYSIS_VERSION) return shared;
  const p = audioProvider();
  let localError: Error | null = null;
  if (p?.priority === 'first') {
    try {
      return await analyzeWithProvider(p, id, onProgress, signal);
    } catch (e) {
      if (signal?.cancelled) throw e;
      localError = new Error(describeError(e));
      console.warn(`${p.label} : ${localError.message} — essai par le serveur`);
    }
  }
  try {
    return await analyzeVideo(id, onProgress, signal);
  } catch (e) {
    // les deux ont échoué : la raison locale (yt-dlp de l'appareil) est la plus utile
    if (localError && !signal?.cancelled) throw new Error(`${localError.message} (serveur : ${(e as Error).message})`);
    const fb = audioProvider();
    if (signal?.cancelled) throw e;
    // sans aide locale : on indique comment contourner le blocage
    if (!fb && /bloque|robot|403/i.test((e as Error).message))
      throw new Error(`${(e as Error).message} Sur ordinateur, installez l’extension « EnjoySing Helper » (lien en bas de page) qui contourne ce blocage, ou importez le fichier audio de la chanson.`);
    if (!fb || fb.priority !== 'fallback') throw e;
    onProgress(0.02, `Le serveur n’a pas pu récupérer la vidéo : essai avec l’${fb.label}…`);
    return analyzeWithProvider(fb, id, onProgress, signal);
  }
}

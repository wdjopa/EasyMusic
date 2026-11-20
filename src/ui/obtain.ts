// Obtenir l'analyse d'une vidéo YouTube, par le chemin le plus rapide et le plus fiable :
//  1. le catalogue partagé du serveur (déjà analysée pour quelqu'un : instantané) ;
//  2. un fournisseur d'audio local « prioritaire » (app ordinateur : yt-dlp sur l'appareil) ;
//  3. le serveur (téléchargement + analyse) ;
//  4. en secours, un fournisseur local « de secours » (extension) si le serveur échoue.
// Avec un fournisseur local, l'analyse se fait dans le navigateur et l'audio y est gardé.
import { ANALYSIS_VERSION } from '../dsp/analyze';
import { analyzeInWorker } from '../dsp/client';
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
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const analysis = await analyzeInWorker(buffer, (f, l) => onProgress(0.6 + f * 0.38, l));
  await putAudio(id, blob); // gardé dans le navigateur : plus jamais téléchargé
  const [server, local] = await metaP;
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
      localError = e as Error;
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

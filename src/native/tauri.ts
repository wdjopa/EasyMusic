// Fournisseur d'audio de l'app ordinateur (Tauri) : yt-dlp tourne sur la machine de l'utilisateur
// (voir src-tauri/src/desktop.rs). Chargé seulement dans l'app, par import dynamique depuis main.ts :
// le site web ne télécharge jamais ce code.
import { Channel, invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { registerAudioProvider, type LocalAudioProvider } from '../ui/audioProvider';

type DownloadEvent = { type: 'progress'; fraction: number; label: string } | { type: 'done'; mime: string };

interface VideoInfo {
  title: string;
  author: string;
  duration: number;
  thumbnail: string;
  embeddable: boolean;
}

/** Vrai dans l'app Tauri (ordinateur ou mobile). */
export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Vrai sur ordinateur (les apps mobiles ont leur propre fournisseur). */
export function isDesktop(ua = navigator.userAgent): boolean {
  return !/Android|iPhone|iPad|iPod/i.test(ua);
}

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export function desktopProvider(): LocalAudioProvider {
  return {
    id: 'tauri-desktop',
    label: 'yt-dlp de cet ordinateur',
    priority: 'first',
    async fetchAudio(videoId, onProgress, signal) {
      const reqId = `${videoId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      let mime = 'audio/mp4';
      const onEvent = new Channel<DownloadEvent>();
      onEvent.onmessage = (m) => {
        if (m.type === 'progress') onProgress(m.fraction, m.label);
        else mime = m.mime;
      };
      // annulation : le jeton est un simple objet, on le surveille
      const timer = setInterval(() => {
        if (signal?.cancelled) void invoke('yt_cancel', { reqId }).catch(() => {});
      }, 300);
      try {
        const bytes = await invoke<ArrayBuffer | number[]>('yt_download', { videoId, reqId, onEvent });
        if (signal?.cancelled) throw new Error('annulé');
        // octets bruts (ArrayBuffer) ; certaines versions renvoient un tableau de nombres
        const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
        return new Blob([buf], { type: mime });
      } catch (e) {
        throw toError(e);
      } finally {
        clearInterval(timer);
      }
    },
    async fetchInfo(videoId) {
      try {
        return await invoke<VideoInfo>('yt_info', { videoId });
      } catch (e) {
        throw toError(e);
      }
    },
  };
}

/** Lien à ouvrir dans le navigateur de l'utilisateur plutôt que dans l'app ? */
export function isExternalLink(a: Pick<HTMLAnchorElement, 'protocol' | 'target' | 'origin'>, appOrigin = location.origin): boolean {
  if (!/^https?:$/.test(a.protocol)) return false;
  return a.target === '_blank' || a.origin !== appOrigin;
}

/** Branche le fournisseur et ajuste l'app au contexte « application ». */
export function setupTauri() {
  if (!inTauri()) return;
  document.documentElement.classList.add('in-app', 'in-tauri');
  // la vue web de l'app n'ouvre pas de nouvel onglet : on passe par le navigateur du système
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !isExternalLink(a)) return;
      e.preventDefault();
      void openUrl(a.href).catch((err) => console.warn('Lien non ouvert :', err));
    },
    true,
  );
  if (isDesktop()) registerAudioProvider(desktopProvider());
}

setupTauri();

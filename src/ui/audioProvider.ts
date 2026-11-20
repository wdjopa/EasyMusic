// Fournisseur d'audio LOCAL : récupère le son d'une vidéo YouTube depuis l'appareil de l'utilisateur
// (son adresse IP de particulier, donc pas de blocage « robot » comme sur le serveur).
//
// Plusieurs implémentations se branchent ici, de la même façon :
//  - l'extension de navigateur « EnjoySing Helper » (voir extension/ et extensionProvider ci-dessous) ;
//  - les apps Tauri (ordinateur, Android, iOS), qui appellent registerAudioProvider() au démarrage.
// Le reste de l'app ne connaît que cette interface.

export interface LocalAudioProvider {
  /** Identifiant court (« extension », « tauri-desktop », « tauri-mobile »…). */
  id: string;
  /** Nom affiché à l'utilisateur. */
  label: string;
  /**
   * « first » : à utiliser avant le serveur (rapide, ex. yt-dlp dans l'app ordinateur).
   * « fallback » : seulement si le serveur échoue (ex. l'extension, qui doit faire jouer la vidéo).
   */
  priority: 'first' | 'fallback';
  /** Télécharge l'audio (tout format lisible par le navigateur : m4a, webm/opus, mp3, wav…). */
  fetchAudio(videoId: string, onProgress: (fraction: number, label: string) => void, signal?: { cancelled: boolean }): Promise<Blob>;
  /** Infos de la vidéo, si le fournisseur les connaît (sinon le serveur les donne via oEmbed). */
  fetchInfo?(videoId: string): Promise<{ title?: string; author?: string; thumbnail?: string; embeddable?: boolean; duration?: number }>;
}

let current: LocalAudioProvider | null = null;
const listeners: (() => void)[] = [];

/** Branche un fournisseur (le plus récent l'emporte : une app Tauri remplace l'extension). */
export function registerAudioProvider(p: LocalAudioProvider) {
  if (current && current.priority === 'first' && p.priority === 'fallback') return;
  current = p;
  listeners.forEach((fn) => fn());
}

export function audioProvider(): LocalAudioProvider | null {
  return current;
}

export function onAudioProviderChange(fn: () => void) {
  listeners.push(fn);
}

// accessible aux scripts injectés par les apps natives
declare global {
  interface Window {
    enjoysing?: { registerAudioProvider: typeof registerAudioProvider };
  }
}
window.enjoysing = { ...window.enjoysing, registerAudioProvider };

// ---------------------------------------------------------------- extension de navigateur
// Protocole (window.postMessage, même fenêtre) :
//  extension -> page : { source: 'enjoysing-ext', type: 'hello', version }
//  page -> extension : { source: 'enjoysing-page', type: 'fetchAudio', reqId, videoId }
//  extension -> page : { source: 'enjoysing-ext', type: 'progress', reqId, fraction, label }
//                      { source: 'enjoysing-ext', type: 'result', reqId, audio: ArrayBuffer, mime }
//                      { source: 'enjoysing-ext', type: 'error', reqId, error }
//  page -> extension : { source: 'enjoysing-page', type: 'cancel', reqId }
export const EXT_PROTOCOL = 1;

interface ExtMessage {
  source: 'enjoysing-ext';
  type: 'hello' | 'progress' | 'result' | 'error';
  reqId?: string;
  version?: string;
  protocol?: number;
  fraction?: number;
  label?: string;
  audio?: ArrayBuffer;
  mime?: string;
  error?: string;
}

const pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: Error) => void; onProgress: (f: number, l: string) => void }>();

function extensionProvider(version: string): LocalAudioProvider {
  return {
    id: 'extension',
    label: `extension EnjoySing ${version}`,
    priority: 'fallback',
    fetchAudio(videoId, onProgress, signal) {
      const reqId = Math.random().toString(36).slice(2);
      return new Promise<Blob>((resolve, reject) => {
        pending.set(reqId, { resolve, reject, onProgress });
        window.postMessage({ source: 'enjoysing-page', type: 'fetchAudio', reqId, videoId, protocol: EXT_PROTOCOL }, location.origin);
        const timer = window.setInterval(() => {
          if (!signal?.cancelled || !pending.has(reqId)) return;
          window.clearInterval(timer);
          window.postMessage({ source: 'enjoysing-page', type: 'cancel', reqId }, location.origin);
          pending.delete(reqId);
          reject(new Error('annulé'));
        }, 500);
      });
    },
  };
}

window.addEventListener('message', (e) => {
  if (e.source !== window || (e.data as ExtMessage)?.source !== 'enjoysing-ext') return;
  const m = e.data as ExtMessage;
  if (m.type === 'hello') return registerAudioProvider(extensionProvider(m.version ?? '?'));
  const p = m.reqId ? pending.get(m.reqId) : undefined;
  if (!p) return;
  if (m.type === 'progress') p.onProgress(m.fraction ?? 0, m.label ?? '');
  else if (m.type === 'result' && m.audio) {
    pending.delete(m.reqId!);
    p.resolve(new Blob([m.audio], { type: m.mime ?? 'audio/wav' }));
  } else if (m.type === 'error') {
    pending.delete(m.reqId!);
    p.reject(new Error(m.error ?? 'L’extension n’a pas pu récupérer le son.'));
  }
});
// l'extension a peut-être été chargée avant ce script : on lui demande de se présenter
window.postMessage({ source: 'enjoysing-page', type: 'ping', protocol: EXT_PROTOCOL }, location.origin);

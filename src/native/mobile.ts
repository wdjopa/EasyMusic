// Apps Android et iOS (Tauri v2) : branchement du fournisseur d'audio « tauri-mobile » et petits
// ajustements d'interface propres à une app (zones sûres, bouton retour Android, clavier).
// Chargé dynamiquement par main.ts SEULEMENT dans Tauri mobile : youtubei.js et bgutils-js ne
// sont donc jamais téléchargés par le site web.
import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { registerAudioProvider, type LocalAudioProvider } from '../ui/audioProvider';
import { buildEvalCode, extractAudio, infoFromYt, playabilityError, type FetchLike, type MobileVideoInfo, type YtLike } from './youtubeMobile';

/** Plateforme mobile, ou null (site web, app ordinateur). */
export function mobilePlatform(): 'android' | 'ios' | null {
  if (typeof window === 'undefined' || !isTauri()) return null;
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  // iPadOS se présente comme un Mac : on le reconnaît à l'écran tactile
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return null;
}

// ---------------------------------------------------------------- réseau par Rust
/** fetch qui passe par Rust : pas de CORS, IP du téléphone. Accepte aussi les objets Request de youtubei.js. */
const nativeFetch: FetchLike = (url, init) => tauriFetch(url, init);
const fetchForYt = ((input: RequestInfo | URL, init?: RequestInit) => tauriFetch(input instanceof Request ? input : String(input), init)) as typeof fetch;

// ---------------------------------------------------------------- déchiffrage dans un Worker
let worker: Worker | null = null;
let seq = 0;
function evalInWorker(code: string): Promise<unknown> {
  worker ??= new Worker(new URL('./ytEval.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      w.terminate();
      if (worker === w) worker = null;
      reject(new Error('déchiffrage trop long'));
    }, 15_000);
    const onMsg = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      if (e.data.id !== id) return;
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ id, code });
  });
}

// ---------------------------------------------------------------- youtubei.js (créé à la demande)
type Innertube = Awaited<ReturnType<typeof import('youtubei.js/web').Innertube.create>>;
let ytP: Promise<Innertube> | null = null;
function innertube(): Promise<Innertube> {
  ytP ??= (async () => {
    const { Innertube, Platform, UniversalCache } = await import('youtubei.js/web');
    Platform.shim.eval = async (data, env) => (await evalInWorker(buildEvalCode(data.output, env))) as Record<string, unknown>;
    return Innertube.create({
      fetch: fetchForYt,
      cache: new UniversalCache(true), // lecteur YouTube gardé (IndexedDB) : pas retéléchargé à chaque fois
      retrieve_player: true,
      lang: 'fr',
      location: 'FR',
    });
  })().catch((e) => {
    ytP = null; // on réessaiera la prochaine fois (réseau absent au démarrage…)
    throw e;
  });
  return ytP;
}

export function createMobileProvider(platform: 'android' | 'ios'): LocalAudioProvider {
  const infos = new Map<string, MobileVideoInfo>();
  return {
    id: 'tauri-mobile',
    label: platform === 'ios' ? 'iPhone' : 'téléphone',
    priority: 'first',
    async fetchAudio(videoId, onProgress, signal) {
      onProgress(0, 'Connexion à YouTube depuis le téléphone…');
      const yt = await innertube();
      const r = await extractAudio(
        videoId,
        {
          yt: yt as unknown as YtLike,
          fetch: nativeFetch,
          ios: platform === 'ios',
          poToken: async (id) => (await import('./poToken')).mintPoToken(yt, nativeFetch, id),
          log: (m) => console.info(`[youtube] ${m}`),
        },
        onProgress,
        signal,
      );
      infos.set(videoId, r.info);
      return r.blob;
    },
    async fetchInfo(videoId) {
      const known = infos.get(videoId);
      if (known) return known;
      const yt = (await innertube()) as unknown as YtLike;
      const info = await yt.getBasicInfo(videoId, { client: 'ANDROID_VR' });
      const err = playabilityError(info);
      if (err && !info.basic_info.title) throw new Error(err);
      const r = infoFromYt(info);
      infos.set(videoId, r);
      return r;
    },
  };
}

// ---------------------------------------------------------------- interface
function setupUi(platform: 'android' | 'ios') {
  document.documentElement.classList.add('app-mobile', `app-${platform}`);
  // clavier virtuel : le contenu se redimensionne (au lieu de passer sous le clavier)
  const vp = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  if (vp && !vp.content.includes('interactive-widget')) vp.content += ', interactive-widget=resizes-content';
  // le champ actif reste visible quand le clavier s'ouvre
  document.addEventListener('focusin', (e) => {
    const el = e.target as HTMLElement;
    if (el.matches('input, textarea, select')) setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  });
  // « Entrée » sur le clavier mobile : fermer le clavier après la validation d'un formulaire
  document.addEventListener('submit', () => (document.activeElement as HTMLElement | null)?.blur?.(), true);
  if (platform === 'android') void setupBackButton();
}

/**
 * Bouton retour Android : ferme d'abord ce qui est ouvert (fenêtre, file d'attente), puis revient à
 * l'accueil, et seulement ensuite quitte l'app (au lieu de la quitter d'emblée, comportement par défaut).
 */
async function setupBackButton() {
  const { onBackButtonPress, exit } = await import('@tauri-apps/api/app').catch(() => ({ onBackButtonPress: null, exit: null }));
  if (!onBackButtonPress) return;
  await onBackButtonPress(() => {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) return dialog.close();
    const queue = document.getElementById('queue-panel');
    if (queue && !queue.hidden) return void (queue.hidden = true);
    if (document.activeElement instanceof HTMLInputElement) return document.activeElement.blur();
    const workspace = document.getElementById('workspace');
    if (workspace && !workspace.hidden) return document.getElementById('go-home')?.click();
    void exit?.(0);
  }).catch((e) => console.warn('bouton retour :', e));
}

/** Point d'entrée, appelé par main.ts. */
export function initMobile(): boolean {
  const platform = mobilePlatform();
  if (!platform) return false;
  setupUi(platform);
  registerAudioProvider(createMobileProvider(platform));
  return true;
}

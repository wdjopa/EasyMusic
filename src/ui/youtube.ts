// Intégration du lecteur YouTube officiel (IFrame Player API).

export { parseYouTubeId } from '../shared/youtubeId';

/** Sous-ensemble de l'API du lecteur utilisé par l'app. */
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  loadVideoById(id: string): void;
  /** Prépare une vidéo sans la lancer (miniature + grand bouton ▶). */
  cueVideoById(id: string): void;
  getVideoData(): { title?: string; author?: string };
  /** Vitesse de lecture (YouTube accepte 0,25 à 2). */
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

export const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

interface YTNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      videoId: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YTPlayer }) => void;
        onStateChange?: (e: { data: number; target: YTPlayer }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT!);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => {
      apiPromise = null;
      reject(new Error('Impossible de charger le lecteur YouTube (connexion ?)'));
    };
    document.head.append(tag);
  });
  return apiPromise;
}

/** Codes d'erreur : vidéo dont le propriétaire interdit la lecture hors de YouTube. */
export const YT_EMBED_BLOCKED = [101, 150];

export const YT_ERRORS: Record<number, string> = {
  2: 'Lien YouTube invalide.',
  5: 'Cette vidéo ne peut pas être lue dans le lecteur intégré.',
  100: 'Vidéo introuvable ou privée.',
  101: 'Le propriétaire de cette vidéo interdit sa lecture en dehors de YouTube.',
  150: 'Le propriétaire de cette vidéo interdit sa lecture en dehors de YouTube.',
};

export async function createPlayer(
  container: HTMLElement,
  videoId: string,
  onState: (state: number) => void,
  onError: (message: string, code: number) => void,
): Promise<YTPlayer> {
  const YT = await loadApi();
  container.innerHTML = '<div></div>';
  return new Promise((resolve) => {
    new YT.Player(container.firstElementChild as HTMLElement, {
      videoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: (e) => resolve(e.target),
        onStateChange: (e) => onState(e.data),
        onError: (e) => onError(YT_ERRORS[e.data] ?? `Erreur du lecteur YouTube (${e.data}).`, e.data),
      },
    });
  });
}

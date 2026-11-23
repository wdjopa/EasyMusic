// Récupération de l'audio YouTube DEPUIS LE TÉLÉPHONE (apps Android / iOS), en TypeScript :
// pas de yt-dlp sur mobile. On s'appuie sur youtubei.js (client InnerTube maintenu), avec un
// `fetch` qui passe par Rust (@tauri-apps/plugin-http) : pas de CORS, et c'est l'adresse IP de
// l'utilisateur (un particulier) que YouTube voit, pas celle du serveur qu'il bloque.
//
// Ce fichier ne contient que la logique (choix du client, du format, téléchargement par morceaux) ;
// il ne dépend ni de Tauri ni de youtubei.js directement, pour être testé avec des réponses factices.
// Le branchement réel se trouve dans mobile.ts.

/** Clients InnerTube essayés, dans l'ordre (voir CLIENTS_PAR_DEFAUT). */
export type YtClient = 'ANDROID_VR' | 'TV' | 'IOS' | 'MWEB' | 'WEB_EMBEDDED' | 'WEB';

/**
 * Ordre d'essai (état fin 2026, susceptible de changer : YouTube modifie souvent ses règles) :
 *  - ANDROID_VR : adresses directes, sans jeton PO ni signature chiffrée ;
 *  - TV : signature à déchiffrer (lecteur JavaScript), généralement sans jeton PO ;
 *  - MWEB : exige un jeton PO (BotGuard, fabriqué dans le WebView) ;
 *  - WEB_EMBEDDED : dernier recours pour les vidéos intégrables.
 */
export const CLIENTS_PAR_DEFAUT: YtClient[] = ['ANDROID_VR', 'TV', 'MWEB', 'WEB_EMBEDDED'];
/** Clients pour lesquels un jeton PO « web » est utile. */
export const CLIENTS_AVEC_JETON_PO: YtClient[] = ['MWEB', 'WEB', 'WEB_EMBEDDED'];

// ---------------------------------------------------------------- formes minimales (sous-ensemble de youtubei.js)
export interface YtFormat {
  itag: number;
  url?: string;
  mime_type: string;
  bitrate: number;
  content_length?: number;
  has_audio: boolean;
  has_video: boolean;
  is_drc?: boolean;
  is_original?: boolean;
  is_dubbed?: boolean;
  is_auto_dubbed?: boolean;
  is_descriptive?: boolean;
  audio_track?: { audio_is_default?: boolean };
  decipher(player?: unknown): Promise<string>;
}
export interface YtVideoInfo {
  basic_info: {
    title?: string;
    author?: string;
    duration?: number;
    thumbnail?: { url: string; width: number; height: number }[];
    is_live?: boolean;
  };
  playability_status?: { status: string; reason?: string; embeddable?: boolean };
  streaming_data?: { formats: YtFormat[]; adaptive_formats: YtFormat[] };
}
export interface YtLike {
  getBasicInfo(videoId: string, options: { client: YtClient; po_token?: string }): Promise<YtVideoInfo>;
  /** `player.po_token` est ajouté par youtubei.js aux adresses (paramètre `pot`) lors du déchiffrage. */
  session: { player?: { po_token?: string } };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Signal = { cancelled: boolean };
export type Progress = (fraction: number, label: string) => void;

export class Annule extends Error {
  constructor() {
    super('annulé');
  }
}
/** Erreur propre à un client : on peut essayer le suivant. */
class ClientRefuse extends Error {}

// ---------------------------------------------------------------- choix du format
/**
 * Choisit le meilleur format AUDIO SEUL décodable par le WebView :
 *  - iOS (WKWebView) ne décode pas webm/opus avec decodeAudioData → m4a/AAC uniquement (itag 140 de préférence) ;
 *  - Android (WebView Chromium) décode aussi opus, mais on préfère quand même m4a (itag 140 : partout pareil).
 * Pistes doublées / audiodescription / « drc » écartées si possible : on veut la piste originale.
 */
export function chooseAudioFormat(formats: YtFormat[], opts: { allowOpus: boolean }): YtFormat | null {
  const audio = formats.filter((f) => f.has_audio && !f.has_video && (f.url || hasCipher(f)));
  const lisible = audio.filter((f) => f.mime_type.startsWith('audio/mp4') || (opts.allowOpus && f.mime_type.startsWith('audio/webm')));
  if (!lisible.length) return null;
  const score = (f: YtFormat) => {
    let s = 0;
    if (f.is_dubbed || f.is_auto_dubbed || f.is_descriptive) s -= 1000;
    if (f.is_original || f.audio_track?.audio_is_default) s += 100;
    if (f.is_drc) s -= 50;
    if (f.itag === 140) s += 30; // AAC 128 kb/s : la référence, lisible partout
    if (f.mime_type.startsWith('audio/mp4')) s += 20;
    s += Math.min(f.bitrate, 256_000) / 100_000; // départage
    return s;
  };
  return [...lisible].sort((a, b) => score(b) - score(a))[0];
}

function hasCipher(f: YtFormat): boolean {
  const any = f as YtFormat & { signature_cipher?: string; cipher?: string };
  return !!(any.signature_cipher || any.cipher);
}

/** Type MIME simple pour le Blob (« audio/mp4 », « audio/webm »). */
export function blobType(f: YtFormat): string {
  return f.mime_type.split(';')[0].trim() || 'audio/mp4';
}

// ---------------------------------------------------------------- infos de la vidéo
export interface MobileVideoInfo {
  title?: string;
  author?: string;
  thumbnail?: string;
  embeddable?: boolean;
  duration?: number;
}

export function infoFromYt(info: YtVideoInfo): MobileVideoInfo {
  const b = info.basic_info;
  const thumbs = [...(b.thumbnail ?? [])].sort((x, y) => y.width - x.width);
  // une miniature « raisonnable » (≤ 640 px) plutôt que l'énorme maxres
  const thumb = thumbs.find((t) => t.width <= 640) ?? thumbs[thumbs.length - 1];
  return {
    title: b.title || undefined,
    author: b.author?.replace(/ - Topic$/, '') || undefined,
    duration: b.duration || undefined,
    thumbnail: thumb?.url,
    embeddable: info.playability_status?.embeddable,
  };
}

/** Message lisible pour une vidéo injouable (privée, bloquée dans le pays, réservée aux adultes…). */
export function playabilityError(info: YtVideoInfo): string | null {
  const p = info.playability_status;
  if (!p || p.status === 'OK') return null;
  if (p.status === 'LOGIN_REQUIRED') {
    if (/bot/i.test(p.reason ?? '')) return 'YouTube demande une vérification « robot » sur ce réseau.';
    return 'Cette vidéo demande d’être connecté à YouTube (âge, vidéo privée…).';
  }
  if (p.status === 'UNPLAYABLE' || p.status === 'ERROR') return p.reason || 'Vidéo indisponible.';
  return p.reason || `Vidéo indisponible (${p.status}).`;
}

// ---------------------------------------------------------------- téléchargement par morceaux
/** Taille d'un morceau : YouTube coupe les réponses trop longues (≈ 10 Mo) ; 1 Mo donne une progression fluide. */
export const CHUNK = 1 << 20;

/**
 * Télécharge `url` par plages d'octets (paramètre `range=` de googlevideo, plus fiable que l'en-tête Range),
 * avec progression et annulation entre les morceaux. Chaque morceau est réessayé une fois.
 * Si la taille est inconnue, on lit jusqu'à recevoir un morceau incomplet.
 */
export async function downloadByChunks(
  url: string,
  size: number | undefined,
  fetchFn: FetchLike,
  onProgress: Progress,
  signal?: Signal,
  chunk = CHUNK,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (;;) {
    if (signal?.cancelled) throw new Annule();
    const end = size ? Math.min(size, pos + chunk) - 1 : pos + chunk - 1;
    const u = new URL(url);
    u.searchParams.set('range', `${pos}-${end}`);
    let buf: Uint8Array | null = null;
    for (let essai = 0; essai < 2 && !buf; essai++) {
      let r: Response;
      try {
        r = await fetchFn(u.toString(), { method: 'GET' });
      } catch (e) {
        if (essai === 1) throw new Error(`Réseau : ${(e as Error).message}`);
        continue;
      }
      if (r.status === 403 || r.status === 401) {
        // refus net (jeton PO manquant, adresse liée à une autre IP…) : inutile d'insister avec ce client
        throw new ClientRefuse(`YouTube refuse le téléchargement (HTTP ${r.status}).`);
      }
      if (!r.ok) {
        if (essai === 1) throw new Error(`Téléchargement : HTTP ${r.status}`);
        continue;
      }
      buf = new Uint8Array(await r.arrayBuffer());
    }
    if (!buf) throw new Error('Téléchargement interrompu.');
    if (pos === 0 && buf.length === 0) throw new ClientRefuse('YouTube a renvoyé un fichier vide.');
    const demande = end - pos + 1;
    parts.push(buf);
    pos += buf.length;
    const fini = size ? pos >= size : buf.length < demande;
    if (size) onProgress(Math.min(1, pos / size), `Téléchargement de l’audio… ${Math.round((100 * pos) / size)} %`);
    else onProgress(0, `Téléchargement de l’audio… ${(pos / 1e6).toFixed(1)} Mo`);
    if (fini || buf.length === 0) break;
  }
  return parts;
}

// ---------------------------------------------------------------- orchestration
export interface ExtractDeps {
  yt: YtLike;
  fetch: FetchLike;
  /** true sur iOS : seulement m4a/AAC. */
  ios: boolean;
  clients?: YtClient[];
  /** Fabrique un jeton PO lié à la vidéo (BotGuard) ; absent ou en échec → clients sans jeton seulement. */
  poToken?: (videoId: string) => Promise<string | undefined>;
  log?: (msg: string) => void;
}

export interface ExtractResult {
  blob: Blob;
  info: MobileVideoInfo;
  client: YtClient;
  itag: number;
}

/**
 * Essaie les clients un par un jusqu'à obtenir un format lisible ET téléchargeable.
 * Les erreurs « définitives » (vidéo privée, supprimée…) arrêtent tout ; les refus propres à un client
 * (pas de format, HTTP 403, jeton PO exigé…) font passer au client suivant.
 */
export async function extractAudio(videoId: string, deps: ExtractDeps, onProgress: Progress, signal?: Signal): Promise<ExtractResult> {
  const log = deps.log ?? (() => {});
  const erreurs: string[] = [];
  let definitive: string | null = null;
  for (const client of deps.clients ?? CLIENTS_PAR_DEFAUT) {
    if (signal?.cancelled) throw new Annule();
    try {
      let po_token: string | undefined;
      if (CLIENTS_AVEC_JETON_PO.includes(client) && deps.poToken) {
        onProgress(0, 'Vérification par YouTube (jeton)…');
        po_token = await deps.poToken(videoId).catch((e) => {
          log(`jeton PO impossible : ${(e as Error).message}`);
          return undefined;
        });
        if (!po_token && client !== 'WEB_EMBEDDED') throw new ClientRefuse('jeton PO indisponible');
      }
      onProgress(0, 'Recherche du flux audio…');
      const info = await deps.yt.getBasicInfo(videoId, { client, ...(po_token ? { po_token } : {}) });
      const bloque = playabilityError(info);
      if (bloque) {
        // « LOGIN_REQUIRED » / robot : un autre client peut passer ; « UNPLAYABLE » (supprimée, privée) : non
        if (info.playability_status?.status === 'UNPLAYABLE' || info.playability_status?.status === 'ERROR') definitive = bloque;
        throw new ClientRefuse(bloque);
      }
      if (info.basic_info.is_live) {
        definitive = 'Les directs ne sont pas pris en charge.';
        throw new ClientRefuse(definitive);
      }
      const sd = info.streaming_data;
      const format = sd && chooseAudioFormat([...sd.adaptive_formats, ...sd.formats], { allowOpus: !deps.ios });
      if (!format) throw new ClientRefuse('aucun format audio lisible');
      const player = deps.yt.session.player;
      if (player) player.po_token = po_token; // jeton de la vidéo pour googlevideo, ou rien
      const url = await format.decipher(player);
      if (!url) throw new ClientRefuse('adresse du flux introuvable');
      log(`${client} : itag ${format.itag} (${format.mime_type})`);
      const parts = await downloadByChunks(url, format.content_length, deps.fetch, onProgress, signal);
      return { blob: new Blob(parts as BlobPart[], { type: blobType(format) }), info: infoFromYt(info), client, itag: format.itag };
    } catch (e) {
      if (e instanceof Annule || signal?.cancelled) throw new Annule();
      const msg = (e as Error).message;
      log(`${client} : ${msg}`);
      erreurs.push(`${client} : ${msg}`);
      if (definitive) throw new Error(definitive);
      // sinon (refus propre au client, erreur réseau ou d'analyse) : client suivant
    }
  }
  throw new Error(`Impossible de récupérer le son depuis le téléphone (${erreurs.join(' ; ')})`);
}

// ---------------------------------------------------------------- déchiffrage des signatures
/**
 * Code à exécuter pour déchiffrer « n » / « sig » : youtubei.js extrait les fonctions du lecteur YouTube
 * et y ajoute une fonction `process(n, sp, s)`. Depuis la v18, il ajoute aussi l'appel
 * `return process("…", "…", "…")` avec les bonnes valeurs : le code s'exécute alors tel quel.
 * Pour une version qui ne l'ajouterait pas, on ajoute l'appel nous-mêmes.
 * Exécuté dans un Web Worker (voir ytEval.worker.ts) : le code de YouTube n'a ainsi accès ni à la page
 * ni aux commandes de l'app.
 */
export function buildEvalCode(output: string, env: Record<string, unknown>): string {
  if (/\breturn\s+process\s*\(/.test(output)) return output;
  const arg = (v: unknown) => JSON.stringify(typeof v === 'string' ? v : '');
  return `${output}\nreturn process(${arg(env.n)}, ${arg(env.sp)}, ${arg(env.sig)});`;
}

// ---------------------------------------------------------------- en-têtes HTTP
/**
 * En-têtes d'une requête vers YouTube. Sans eux, le module réseau de Tauri envoie de lui-même
 * « Origin: http://tauri.localhost » et « User-Agent: tauri-plugin-http/… », que YouTube refuse (HTTP 403).
 * Origin vide = en-tête retiré (fonction « unsafe-headers » du plugin, activée dans Cargo.toml).
 */
const TV_USER_AGENT = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version';
export function youtubeHeaders(url: string, init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return headers;
  }
  if (!/(^|\.)(youtube\.com|googlevideo\.com|google\.com|youtube-nocookie\.com)$/.test(host)) return headers;
  const flux = host.endsWith('googlevideo.com');
  if (!headers.has('origin')) headers.set('Origin', flux ? '' : 'https://www.youtube.com');
  if (!flux && !headers.has('referer')) headers.set('Referer', 'https://www.youtube.com/');
  if (!headers.has('user-agent')) headers.set('User-Agent', headers.get('x-youtube-client-name') === '7' ? TV_USER_AGENT : (globalThis.navigator?.userAgent ?? ''));
  return headers;
}

// ---------------------------------------------------------------- réseau instable
const NETWORK_ERROR = /error sending request|connection (?:closed|reset|refused)|timed? ?out|dns|network|tcp connect|unreachable/i;

/**
 * Réessaie une requête qui échoue pour une raison RÉSEAU (téléphone qui passe du Wi-Fi à la 4G, mise en veille,
 * réseau lent) : 3 essais espacés. Une vraie réponse de YouTube (même une erreur HTTP) n'est pas réessayée ici.
 */
export async function withNetworkRetry<T>(
  run: () => Promise<T>,
  url: string,
  tries = 3,
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  /** Diagnostic détaillé (DNS, TLS, IPv6…) ajouté au message si le réseau reste en échec. */
  diagnose?: (url: string) => Promise<string>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const network = NETWORK_ERROR.test(msg) && !/cancel|annul/i.test(msg);
      if (!network) throw e;
      if (i >= tries - 1) {
        let host = url;
        try {
          host = new URL(url).hostname;
        } catch {
          /* adresse brute */
        }
        const detail = diagnose ? await diagnose(url).catch(() => '') : '';
        throw new Error(
          `Connexion à ${host} impossible depuis le téléphone (réseau coupé ou instable). Vérifiez la connexion Internet et réessayez.${detail ? ` [diagnostic : ${detail}]` : ''}`,
        );
      }
      await wait(800 * (i + 1));
    }
  }
}

// Jetons PO (« Proof of Origin ») pour les clients web de YouTube (MWEB, WEB_EMBEDDED).
// YouTube les exige de plus en plus pour télécharger (googlevideo) avec les clients web. Ils sont
// fabriqués par BotGuard, le programme anti-robot de Google, qu'on fait tourner dans le WebView de
// l'app : c'est un vrai navigateur sur le téléphone de l'utilisateur, ce que BotGuard vérifie.
// Bibliothèque : bgutils-js (LuanRT, auteur de youtubei.js).
//
// Utilisé seulement si les clients sans jeton (ANDROID_VR, TV) échouent : c'est plus lent (≈ 1-3 s)
// et exécute le script BotGuard dans la page.
import { BotGuardClient } from 'bgutils-js/botguard';
import { WebPoMinter } from 'bgutils-js/webpo';
import { buildURL, GOOG_API_KEY } from 'bgutils-js/utils';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import type { FetchLike } from './youtubeMobile';

/** Clé de requête utilisée par le lecteur web de YouTube. */
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

interface Challenge {
  bg_challenge?: {
    interpreter_url: { private_do_not_access_or_else_trusted_resource_url_wrapped_value?: string };
    interpreter_hash: string;
    program: string;
    global_name: string;
  };
}
export interface ChallengeSource {
  getAttestationChallenge(engagement: 'ENGAGEMENT_TYPE_UNBOUND'): Promise<Challenge>;
}

interface Minter {
  minter: WebPoMinter;
  expires: number;
}
let current: Promise<Minter> | null = null;

async function createMinter(yt: ChallengeSource, fetchFn: FetchLike): Promise<Minter> {
  const ch = (await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND')).bg_challenge;
  if (!ch) throw new Error('pas de défi BotGuard');
  const src = ch.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!src) throw new Error('adresse du script BotGuard absente');
  const js = await (await fetchFn(src.startsWith('//') ? `https:${src}` : src)).text();
  if (!js) throw new Error('script BotGuard vide');
  // BotGuard s'installe dans l'objet global (globalThis[global_name])
  new Function(js)();
  const client = await BotGuardClient.create({ program: ch.program, globalName: ch.global_name, globalObject: globalThis });
  const webPoSignalOutput: WebPoSignalOutput = [];
  const response = await client.snapshot({ webPoSignalOutput });
  const r = await fetchFn(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: { 'content-type': 'application/json+protobuf', 'x-goog-api-key': GOOG_API_KEY, 'x-user-agent': 'grpc-web-javascript/0.1' },
    body: JSON.stringify([REQUEST_KEY, response]),
  });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await r.json()) as [string, number, number, string];
  if (!integrityToken) throw new Error('jeton d’intégrité refusé');
  const minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken }, webPoSignalOutput);
  const ttl = Math.max(60, (estimatedTtlSecs ?? 3600) - (mintRefreshThreshold ?? 300));
  return { minter, expires: Date.now() + ttl * 1000 };
}

/** Jeton PO lié à `contentBinding` (identifiant de vidéo). Le « minter » est réutilisé tant qu'il est valide. */
export async function mintPoToken(yt: ChallengeSource, fetchFn: FetchLike, contentBinding: string): Promise<string> {
  let m = current ? await current.catch(() => null) : null;
  if (!m || m.expires < Date.now()) {
    current = createMinter(yt, fetchFn);
    m = await current.catch((e) => {
      current = null;
      throw e;
    });
  }
  return m.minter.mintAsWebsafeString(contentBinding);
}

import { cleanTitle, type Lyrics, parseLrc } from '../src/shared/lyrics';

/** Résultat de l'API LRCLIB (https://lrclib.net), base libre de paroles synchronisées. */
interface LrclibTrack {
  trackName: string;
  artistName: string;
  duration: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/** Mots significatifs d'un titre (sans accents ni ponctuation). */
function words(t: string): string[] {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Vrai si le titre trouvé correspond bien au morceau cherché (la plupart de ses mots s'y retrouvent). */
export function titleMatches(wanted: string, found: string): boolean {
  const w = words(wanted);
  if (!w.length) return true;
  const f = new Set(words(found));
  return w.filter((x) => f.has(x)).length / w.length >= 0.6;
}

/** Choisit le meilleur résultat : paroles synchronisées en priorité, puis la durée la plus proche. */
export function pickBest(results: LrclibTrack[], duration?: number, track?: string): LrclibTrack | null {
  const usable = results.filter(
    (r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics) && (!track || titleMatches(track, `${r.trackName} ${r.artistName}`)),
  );
  if (!usable.length) return null;
  const score = (r: LrclibTrack) =>
    (r.syncedLyrics ? 0 : 1000) + (duration ? Math.min(Math.abs(r.duration - duration), 120) : 0);
  return [...usable].sort((a, b) => score(a) - score(b))[0];
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function findLyrics(
  q: { title: string; author?: string; duration?: number },
  fetcher: Fetcher = fetch,
): Promise<Lyrics | null> {
  const { query, track, artist } = cleanTitle(q.title, q.author);
  const headers = { 'user-agent': 'EasyMusic (https://github.com/wdjopa/EasyMusic)' };
  const search = async (params: Record<string, string>) => {
    const r = await fetcher(`https://lrclib.net/api/search?${new URLSearchParams(params)}`, { headers });
    if (!r.ok) throw new Error(`LRCLIB : erreur ${r.status}`);
    return (await r.json()) as LrclibTrack[];
  };
  let results = artist && track ? await search({ track_name: track, artist_name: artist }) : [];
  if (!results.some((r) => r.syncedLyrics)) results = [...results, ...(await search({ q: query }))];
  // la recherche libre renvoie toujours quelque chose : on vérifie que c'est bien le bon morceau
  const best = pickBest(results, q.duration, track);
  if (!best) return null;
  return {
    synced: best.syncedLyrics ? parseLrc(best.syncedLyrics) : null,
    plain: best.plainLyrics ?? null,
    track: best.trackName,
    artist: best.artistName,
    source: 'LRCLIB',
  };
}

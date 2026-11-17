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

/** Choisit le meilleur résultat : paroles synchronisées en priorité, puis la durée la plus proche. */
export function pickBest(results: LrclibTrack[], duration?: number): LrclibTrack | null {
  const usable = results.filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
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
  const best = pickBest(results, q.duration);
  if (!best) return null;
  return {
    synced: best.syncedLyrics ? parseLrc(best.syncedLyrics) : null,
    plain: best.plainLyrics ?? null,
    track: best.trackName,
    artist: best.artistName,
    source: 'LRCLIB',
  };
}

// Paroles : lecture du format LRC et nettoyage des titres YouTube. Partagé navigateur / serveur.

export interface LyricLine {
  time: number; // secondes
  text: string;
}

export interface Lyrics {
  synced: LyricLine[] | null; // paroles synchronisées, si disponibles
  plain: string | null; // texte seul sinon
  track: string;
  artist: string;
  source: string;
}

/** Lit des paroles au format LRC : « [mm:ss.xx] texte » (plusieurs horodatages possibles par ligne). */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ time: Number(m[1]) * 60 + Number(m[2].replace(':', '.')), text });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Retire du titre d'une vidéo ce qui n'est pas le titre du morceau. */
export function cleanTitle(title: string, author = ''): { track: string; artist: string; query: string } {
  let t = title
    .replace(/[([{【][^)\]}】]*(official|video|clip|lyric|lyrics|paroles|audio|visuali[sz]er|hd|hq|4k|remaster|live|mv|version)[^)\]}】]*[)\]}】]/gi, '')
    .replace(/\b(official\s+(music\s+)?video|clip officiel|official audio|lyrics?|paroles)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const artistFromChannel = author.replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '').replace(/official$/i, '').trim();
  let artist = artistFromChannel;
  let track = t;
  const m = t.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (m) {
    artist = m[1].trim();
    track = m[2].trim();
  }
  track = track.replace(/\s+(ft\.?|feat\.?)\s.*$/i, '').replace(/["“”]/g, '').trim();
  t = `${artist} ${track}`.trim();
  return { track, artist, query: t };
}

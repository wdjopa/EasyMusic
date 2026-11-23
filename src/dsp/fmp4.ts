// Audio m4a « fragmenté » (DASH, celui que YouTube sert pour l'itag 140) -> flux AAC ADTS.
// Les navigateurs décodent mal le MP4 fragmenté avec decodeAudioData : Chrome Android le refuse,
// Safari / WKWebView n'en décode que le premier fragment. Le flux ADTS (trames AAC précédées d'un
// petit en-tête) est, lui, décodé et lu partout. Aucune perte : les trames AAC sont recopiées telles quelles.

interface Box {
  type: string;
  start: number; // début de la boîte (en-tête compris)
  data: number; // début du contenu
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = from;
  while (p + 8 <= to) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header || p + size > to) return;
    yield { type, start: p, data: p + header, end: p + size };
    p += size;
  }
}

function find(b: Uint8Array, parent: { data: number; end: number }, path: string[]): Box | null {
  let cur: { data: number; end: number } | Box = parent;
  let found: Box | null = null;
  for (const t of path) {
    found = null;
    for (const x of boxes(b, cur.data, cur.end)) if (x.type === t) { found = x; break; }
    if (!found) return null;
    cur = found;
  }
  return found;
}

/** Vrai si le fichier est un MP4 fragmenté (contient des « moof »). */
export function isFragmentedMp4(b: Uint8Array): boolean {
  for (const x of boxes(b, 0, b.length)) if (x.type === 'moof') return true;
  return false;
}

/** AudioSpecificConfig de la piste AAC (dans esds) : type d'objet, fréquence, canaux. */
function aacConfig(b: Uint8Array, moov: Box): { profile: number; freqIndex: number; channels: number } | null {
  const stsd = find(b, moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd) return null;
  // stsd : version/flags (4) + nombre d'entrées (4), puis l'entrée « mp4a » (28 octets d'en-tête audio)
  const entries = { data: stsd.data + 8, end: stsd.end };
  const mp4a = find(b, entries, ['mp4a']);
  if (!mp4a) return null;
  const esds = find(b, { data: mp4a.data + 28, end: mp4a.end }, ['esds']);
  if (!esds) return null;
  // descripteurs : on cherche DecoderSpecificInfo (tag 5)
  for (let p = esds.data + 4; p < esds.end - 2; p++) {
    if (b[p] !== 5) continue;
    let q = p + 1;
    let len = 0;
    for (let k = 0; k < 4; k++) {
      const c = b[q++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    if (len < 2 || q + 2 > esds.end) continue;
    const profile = b[q] >> 3; // audioObjectType (2 = AAC LC)
    const freqIndex = ((b[q] & 7) << 1) | (b[q + 1] >> 7);
    const channels = (b[q + 1] >> 3) & 15;
    if (profile > 0 && profile < 31 && freqIndex < 13 && channels > 0) return { profile, freqIndex, channels };
  }
  return null;
}

/**
 * Convertit un m4a fragmenté en flux ADTS (type « audio/aac »), ou renvoie null si ce n'est pas un
 * MP4 fragmenté AAC (le fichier est alors laissé tel quel).
 */
export function fragmentedMp4ToAdts(b: Uint8Array): Uint8Array | null {
  let moov: Box | null = null;
  for (const x of boxes(b, 0, b.length)) if (x.type === 'moov') { moov = x; break; }
  if (!moov || !isFragmentedMp4(b)) return null;
  const cfg = aacConfig(b, moov);
  if (!cfg) return null;
  // taille par défaut des échantillons (trex), si les fragments ne la précisent pas
  const trex = find(b, moov, ['mvex', 'trex']);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const trexSize = trex ? v.getUint32(trex.data + 16) : 0;

  const frames: [number, number][] = []; // [début, taille]
  for (const moof of boxes(b, 0, b.length)) {
    if (moof.type !== 'moof') continue;
    for (const traf of boxes(b, moof.data, moof.end)) {
      if (traf.type !== 'traf') continue;
      let base = moof.start; // « default-base-is-moof » (le cas de YouTube)
      let defSize = trexSize;
      for (const x of boxes(b, traf.data, traf.end)) {
        if (x.type === 'tfhd') {
          const flags = v.getUint32(x.data) & 0xffffff;
          let p = x.data + 8; // version/flags + track_ID
          if (flags & 0x1) {
            base = Number(v.getBigUint64(p));
            p += 8;
          }
          if (flags & 0x2) p += 4;
          if (flags & 0x8) p += 4;
          if (flags & 0x10) defSize = v.getUint32(p);
        } else if (x.type === 'trun') {
          const flags = v.getUint32(x.data) & 0xffffff;
          const count = v.getUint32(x.data + 4);
          let p = x.data + 8;
          let offset = base;
          if (flags & 0x1) {
            offset = base + v.getInt32(p);
            p += 4;
          }
          if (flags & 0x4) p += 4;
          for (let i = 0; i < count; i++) {
            if (flags & 0x100) p += 4;
            let size = defSize;
            if (flags & 0x200) {
              size = v.getUint32(p);
              p += 4;
            }
            if (flags & 0x400) p += 4;
            if (flags & 0x800) p += 4;
            if (size <= 0 || offset + size > b.length) break;
            frames.push([offset, size]);
            offset += size;
          }
        }
      }
    }
  }
  if (!frames.length) return null;

  const out = new Uint8Array(frames.reduce((n, [, s]) => n + s + 7, 0));
  let o = 0;
  for (const [start, size] of frames) {
    const len = size + 7;
    // en-tête ADTS (7 octets, sans CRC)
    out[o] = 0xff;
    out[o + 1] = 0xf1;
    out[o + 2] = ((cfg.profile - 1) << 6) | (cfg.freqIndex << 2) | (cfg.channels >> 2);
    out[o + 3] = ((cfg.channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(b.subarray(start, start + size), o + 7);
    o += len;
  }
  return out;
}

/** Blob audio prêt à décoder partout : le m4a fragmenté est converti, le reste est rendu tel quel. */
export async function decodableAudio(blob: Blob): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const adts = fragmentedMp4ToAdts(bytes);
  return adts ? new Blob([adts], { type: 'audio/aac' }) : blob;
}

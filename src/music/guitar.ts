import { Chord, ChordQuality, chordName, mod12 } from './theory';

/** Cases jouées pour les 6 cordes (Mi grave -> Mi aigu). -1 = corde étouffée, 0 = à vide. */
export type Voicing = number[];

const OPEN: Record<string, Voicing> = {
  C: [-1, 3, 2, 0, 1, 0],
  C7: [-1, 3, 2, 3, 1, 0],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  D7: [-1, -1, 0, 2, 1, 2],
  Dm7: [-1, -1, 0, 2, 1, 1],
  Dmaj7: [-1, -1, 0, 2, 2, 2],
  Dsus2: [-1, -1, 0, 2, 3, 0],
  Dsus4: [-1, -1, 0, 2, 3, 3],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  Emaj7: [0, 2, 1, 1, 0, 0],
  Esus4: [0, 2, 2, 2, 0, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fmaj7: [-1, -1, 3, 2, 1, 0],
  G: [3, 2, 0, 0, 0, 3],
  G7: [3, 2, 0, 0, 0, 1],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  Amaj7: [-1, 0, 2, 1, 2, 0],
  Asus2: [-1, 0, 2, 2, 0, 0],
  Asus4: [-1, 0, 2, 2, 3, 0],
  B7: [-1, 2, 1, 2, 0, 2],
};

/** Formes « barrées » relatives à la case de la fondamentale. */
const E_SHAPES: Partial<Record<ChordQuality, Voicing>> = {
  maj: [0, 2, 2, 1, 0, 0],
  min: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, -1, 1, 1, 0, -1],
  sus4: [0, 2, 2, 2, 0, 0],
};
const A_SHAPES: Partial<Record<ChordQuality, Voicing>> = {
  maj: [-1, 0, 2, 2, 2, 0],
  min: [-1, 0, 2, 2, 1, 0],
  '7': [-1, 0, 2, 0, 2, 0],
  m7: [-1, 0, 2, 0, 1, 0],
  maj7: [-1, 0, 2, 1, 2, 0],
  sus2: [-1, 0, 2, 2, 0, 0],
  sus4: [-1, 0, 2, 2, 3, 0],
  dim: [-1, 0, 1, 2, 1, -1],
};

function shift(shape: Voicing, fret: number): Voicing {
  return shape.map((f) => (f < 0 ? -1 : f + fret));
}

export function voicingsFor(c: Chord): Voicing[] {
  const out: Voicing[] = [];
  const open = OPEN[chordName(c, false)];
  if (open) out.push(open);
  const eFret = mod12(c.root - 4) || 12;
  const aFret = mod12(c.root - 9) || 12;
  const candidates: Voicing[] = [];
  if (E_SHAPES[c.quality]) candidates.push(shift(E_SHAPES[c.quality]!, eFret));
  if (A_SHAPES[c.quality]) candidates.push(shift(A_SHAPES[c.quality]!, aFret));
  candidates.sort((a, b) => Math.max(...a) - Math.max(...b));
  for (const v of candidates) {
    if (!out.some((o) => o.join() === v.join())) out.push(v);
  }
  return out.slice(0, 2);
}

/** Classe de hauteur des cordes à vide (Mi grave → Mi aigu). */
export const OPEN_PCS = [4, 9, 2, 7, 11, 4];
export const STRING_NAMES = ['Mi grave', 'La', 'Ré', 'Sol', 'Si', 'Mi aigu'];

export type StringStatus = 'heard' | 'missing' | null;

/**
 * Pour un doigté joué avec un capo, indique pour chaque corde si sa note a été entendue.
 * (Une même note peut venir de deux cordes : elle est alors comptée pour les deux.)
 */
export function diagnoseVoicing(
  v: Voicing,
  capo: number,
  heard: Set<number>,
  /** Notes non vérifiables (ni entendues ni manquantes). */
  uncertain: Set<number> = new Set(),
): { status: StringStatus[]; missing: { string: number; fret: number; pc: number }[] } {
  const status: StringStatus[] = [];
  const missing: { string: number; fret: number; pc: number }[] = [];
  v.forEach((fret, s) => {
    if (fret < 0) return status.push(null);
    const pc = (OPEN_PCS[s] + fret + capo) % 12;
    if (uncertain.has(pc) && !heard.has(pc)) return status.push(null);
    const ok = heard.has(pc);
    status.push(ok ? 'heard' : 'missing');
    if (!ok) missing.push({ string: s, fret, pc });
  });
  return { status, missing };
}

/** Dessine un diagramme d'accord en SVG ; `status` colore les cordes entendues / muettes. */
export function chordDiagramSvg(name: string, v: Voicing, status?: StringStatus[]): string {
  const W = 110;
  const H = 148;
  const left = 22;
  const top = 42;
  const sp = 14; // espace entre cordes
  const fh = 18; // hauteur d'une case
  const nFrets = 5;
  const played = v.filter((f) => f > 0);
  const maxF = played.length ? Math.max(...played) : 0;
  const minF = played.length ? Math.min(...played) : 0;
  const base = maxF <= nFrets ? 1 : minF;

  const parts: string[] = [];
  parts.push(`<text x="${W / 2}" y="16" text-anchor="middle" class="cd-name">${name}</text>`);
  // sillet ou numéro de case
  if (base === 1) {
    parts.push(`<rect x="${left - 1}" y="${top - 4}" width="${sp * 5 + 2}" height="4" class="cd-nut"/>`);
  } else {
    parts.push(`<text x="${left - 6}" y="${top + fh * 0.7}" text-anchor="end" class="cd-fretno">${base}</text>`);
  }
  for (let i = 0; i <= nFrets; i++) {
    const y = top + i * fh;
    parts.push(`<line x1="${left}" y1="${y}" x2="${left + sp * 5}" y2="${y}" class="cd-line"/>`);
  }
  for (let s = 0; s < 6; s++) {
    const x = left + s * sp;
    parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + fh * nFrets}" class="cd-line"/>`);
  }
  // barré : même case la plus basse sur plusieurs cordes à partir de la plus grave jouée
  const firstPlayed = v.findIndex((f) => f >= 0);
  const barreFret =
    minF > 0 && !v.includes(0) && v[firstPlayed] === minF && v[5] === minF && v.filter((f) => f === minF).length >= 2
      ? minF
      : 0;
  if (barreFret) {
    const strings = v.map((f, i) => (f === barreFret ? i : -1)).filter((i) => i >= 0);
    const from = strings[0];
    const to = strings[strings.length - 1];
    const y = top + (barreFret - base + 0.5) * fh;
    parts.push(
      `<rect x="${left + from * sp - 5}" y="${y - 5}" width="${(to - from) * sp + 10}" height="10" rx="5" class="cd-dot"/>`,
    );
  }
  v.forEach((f, s) => {
    const x = left + s * sp;
    const st = status?.[s];
    const cls = st === 'heard' ? ' cd-heard' : st === 'missing' ? ' cd-missing' : '';
    if (f < 0) parts.push(`<text x="${x}" y="${top - 9}" text-anchor="middle" class="cd-mark">×</text>`);
    else if (f === 0) parts.push(`<circle cx="${x}" cy="${top - 13}" r="${st ? 4.5 : 3.5}" class="cd-open${cls}"/>`);
    else if (f !== barreFret || st) {
      // sur un barré, seule une corde évaluée reçoit son propre point coloré
      const y = top + (f - base + 0.5) * fh;
      parts.push(`<circle cx="${x}" cy="${y}" r="5.5" class="cd-dot${cls}"/>`);
    }
    if (st === 'missing') parts.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + fh * nFrets}" class="cd-line-missing"/>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="chord-diagram" role="img" aria-label="Accord ${name}">${parts.join('')}</svg>`;
}

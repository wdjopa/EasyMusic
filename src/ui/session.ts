// Séance d'entraînement : résultats par passage (ligne de paroles), bilan et historique des séances.

export interface Passage {
  start: number;
  end: number;
  label: string; // texte de la ligne (ou « Mesures … »)
  chords: string; // accords du passage, pour l'affichage
}

interface PassageStats {
  chordOk: number;
  chordTotal: number;
  voiceOk: number;
  voiceTotal: number;
  late: number; // erreurs juste après un changement d'accord
  sharp: number;
  flat: number;
  strings: Map<string, number>; // « la corde de Sol sur C » → nombre de fois
  wrong: Map<string, number>; // accord attendu mal joué → nombre de fois
}

export interface PassageReport extends Passage {
  index: number;
  chordScore: number | null; // 0..1
  voiceScore: number | null;
  tip: string;
  weak: boolean;
}

export interface SessionSummary {
  date: string;
  chords: number | null; // %
  voice: number | null;
  minutes: number;
}

export class SessionRecorder {
  private stats = new Map<number, PassageStats>();
  readonly startedAt = Date.now();

  private get(i: number): PassageStats {
    let s = this.stats.get(i);
    if (!s) {
      s = { chordOk: 0, chordTotal: 0, voiceOk: 0, voiceTotal: 0, late: 0, sharp: 0, flat: 0, strings: new Map(), wrong: new Map() };
      this.stats.set(i, s);
    }
    return s;
  }

  get empty(): boolean {
    return this.stats.size === 0;
  }

  recordChord(passage: number, verdict: 'ok' | 'close' | 'wrong', info: { expected: string; late: boolean; mutedString?: string }) {
    if (passage < 0) return;
    const s = this.get(passage);
    s.chordTotal++;
    s.chordOk += verdict === 'ok' ? 1 : verdict === 'close' ? 0.5 : 0;
    if (verdict !== 'ok') {
      if (info.late) s.late++;
      else s.wrong.set(info.expected, (s.wrong.get(info.expected) ?? 0) + 1);
    }
    if (info.mutedString) s.strings.set(info.mutedString, (s.strings.get(info.mutedString) ?? 0) + 1);
  }

  recordVoice(passage: number, good: boolean, cents: number, inTune: boolean) {
    if (passage < 0) return;
    const s = this.get(passage);
    s.voiceTotal++;
    if (good) s.voiceOk++;
    else if (!inTune) {
      if (cents > 0) s.sharp++;
      else s.flat++;
    }
  }

  /** Bilan par passage (seulement ceux qui ont été joués ou chantés). */
  report(passages: Passage[]): PassageReport[] {
    const out: PassageReport[] = [];
    passages.forEach((p, index) => {
      const s = this.stats.get(index);
      // trop peu de mesures pour juger (quelques dixièmes de seconde)
      if (!s || s.chordTotal + s.voiceTotal < 4) return;
      const chordScore = s.chordTotal >= 3 ? s.chordOk / s.chordTotal : null;
      const voiceScore = s.voiceTotal >= 3 ? s.voiceOk / s.voiceTotal : null;
      const tips: string[] = [];
      if (chordScore !== null && chordScore < 0.7) {
        const string = top(s.strings);
        const wrong = top(s.wrong);
        if (s.late >= Math.max(2, s.chordTotal * 0.2)) tips.push('Changement d’accord en retard');
        else if (string) tips.push(`${string[0].toUpperCase()}${string.slice(1)} ne sonne pas`);
        else if (wrong) tips.push(`Accord ${wrong} à revoir`);
      }
      if (voiceScore !== null && voiceScore < 0.7) {
        if (s.sharp > s.flat * 1.5) tips.push('Voix un peu haute');
        else if (s.flat > s.sharp * 1.5) tips.push('Voix un peu basse');
        else tips.push('Notes de la mélodie à revoir');
      }
      const scores = [chordScore, voiceScore].filter((x): x is number => x !== null);
      out.push({ ...p, index, chordScore, voiceScore, tip: tips.join(' · '), weak: scores.some((x) => x < 0.7) });
    });
    return out;
  }

  /** Scores globaux de la séance (en %), pondérés par le temps passé sur chaque passage. */
  totals(): { chords: number | null; voice: number | null } {
    let co = 0;
    let ct = 0;
    let vo = 0;
    let vt = 0;
    for (const s of this.stats.values()) {
      co += s.chordOk;
      ct += s.chordTotal;
      vo += s.voiceOk;
      vt += s.voiceTotal;
    }
    return { chords: ct >= 5 ? Math.round((co / ct) * 100) : null, voice: vt >= 5 ? Math.round((vo / vt) * 100) : null };
  }
}

function top(m: Map<string, number>): string | null {
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return n >= 2 ? best : null;
}

// ---- historique des séances, par chanson (dans le navigateur)
const KEY = 'easymusic.sessions.v1';

function readAll(): Record<string, SessionSummary[]> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

export function sessionHistory(songKey: string): SessionSummary[] {
  return readAll()[songKey] ?? [];
}

export function saveSession(songKey: string, s: SessionSummary) {
  const all = readAll();
  all[songKey] = [...(all[songKey] ?? []), s].slice(-20);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* stockage plein : l'historique n'est pas essentiel */
  }
}

/** Phrase de synthèse du bilan. */
export function headline(reports: PassageReport[], totals: { chords: number | null; voice: number | null }, previous?: SessionSummary): string {
  if (!reports.length) return 'Séance trop courte pour un bilan : jouez au moins quelques mesures.';
  const weak = reports.filter((r) => r.weak);
  const delta = (now: number | null, before: number | null | undefined) => (now !== null && before != null ? now - before : null);
  const d = delta(totals.chords, previous?.chords) ?? delta(totals.voice, previous?.voice);
  const progress = d !== null && d >= 5 ? 'Vous progressez' : d !== null && d <= -5 ? 'Un peu moins bien que la dernière fois' : null;
  if (!weak.length) return `${progress ? `${progress} : ` : ''}tout est juste, bravo. Essayez à 100 % de la vitesse ou dans une autre tonalité.`;
  const first = weak[0];
  const where = first.label && first.label !== '♪' ? `« ${first.label.length > 40 ? `${first.label.slice(0, 40)}…` : first.label} »` : 'un passage instrumental';
  return `${progress ? `${progress}. ` : ''}${weak.length === 1 ? 'Un passage' : `${weak.length} passages`} à travailler, à commencer par ${where}.`;
}

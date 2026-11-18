// Piste « karaoké » : les notes de la mélodie défilent, la voix du chanteur est tracée par-dessus.
import type { MelodyNote } from '../music/melody';

const NAMES = ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

export interface VoicePoint {
  t: number; // temps du morceau (s)
  midi: number; // déjà ramenée dans l'octave affichée
  good: boolean;
}

export interface NoteResult {
  hit: number;
  total: number;
}

export class PitchLane {
  notes: MelodyNote[] = [];
  chords: { start: number; name: string }[] = [];
  points: VoicePoint[] = [];
  results = new Map<number, NoteResult>();
  private ctx: CanvasRenderingContext2D;
  /** Secondes visibles avant et après la tête de lecture. */
  past = 2.5;
  future = 6;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  reset() {
    this.points = [];
    this.results = new Map();
  }

  /** Index de la note attendue à l'instant t (ou -1). */
  noteAt(t: number): number {
    // recherche dichotomique : les notes sont triées
    let lo = 0;
    let hi = this.notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = this.notes[mid];
      if (t < n.start) hi = mid - 1;
      else if (t >= n.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  addPoint(p: VoicePoint, noteIndex: number) {
    this.points.push(p);
    // on ne garde que ce qui peut encore s'afficher
    while (this.points.length && this.points[0].t < p.t - this.past - 1) this.points.shift();
    if (noteIndex >= 0) {
      const r = this.results.get(noteIndex) ?? { hit: 0, total: 0 };
      r.total++;
      if (p.good) r.hit++;
      this.results.set(noteIndex, r);
    }
  }

  draw(t: number) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(canvas);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const C = {
      card: color('--card', '#1f1d18'),
      bg: color('--bg', '#15140f'),
      line: color('--line', '#34312a'),
      text: color('--text', '#f1ede4'),
      muted: color('--muted', '#a59f93'),
      accent: color('--accent', '#f08048'),
      good: color('--voice', '#4cc196'),
      warn: '#d9a04a',
    };

    const labelW = 44;
    const top = 22; // bandeau des accords
    const laneH = h - top;
    const headX = labelW + (w - labelW) * 0.3;
    const pps = (w - labelW) / (this.past + this.future);
    const xOf = (time: number) => headX + (time - t) * pps;
    const t0 = t - this.past;
    const t1 = t + this.future;

    // plage de hauteurs : les notes visibles (et la voix) avec une marge
    const visible = this.notes.filter((n) => n.end > t0 && n.start < t1);
    const pts = this.points.filter((p) => p.t > t0 && p.t <= t);
    const all = [...visible.map((n) => n.midi), ...pts.map((p) => p.midi)];
    // bornes entières : la voix n'est jamais pile sur une note (64,3…)
    let lo = all.length ? Math.floor(Math.min(...all)) - 2 : 55;
    let hi = all.length ? Math.ceil(Math.max(...all)) + 2 : 67;
    if (hi - lo < 12) {
      const mid = (hi + lo) / 2;
      lo = Math.floor(mid - 6);
      hi = Math.ceil(mid + 6);
    }
    const rowH = laneH / (hi - lo + 1);
    const yOf = (m: number) => top + (hi - m + 0.5) * rowH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.card;
    ctx.fillRect(0, 0, w, h);
    // lignes de hauteur (dièses plus sombres) et noms des notes naturelles
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      const name = NAMES[((m % 12) + 12) % 12];
      const y = top + (hi - m) * rowH;
      if (name.includes('♯')) {
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(labelW, y, w - labelW, rowH);
        ctx.globalAlpha = 1;
      } else if (rowH >= 9) {
        ctx.fillStyle = C.muted;
        ctx.fillText(`${name}${Math.floor(m / 12) - 1}`, labelW - 6, y + rowH / 2);
      }
    }
    // temps passé, légèrement assombri
    ctx.fillStyle = C.bg;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(labelW, top, headX - labelW, laneH);
    ctx.globalAlpha = 1;

    // accords au-dessus
    ctx.textAlign = 'left';
    ctx.font = '700 13px ui-monospace, Menlo, monospace';
    for (let i = 0; i < this.chords.length; i++) {
      const c = this.chords[i];
      const next = this.chords[i + 1]?.start ?? Infinity;
      if (next < t0 || c.start > t1) continue;
      const current = c.start <= t && t < next;
      ctx.fillStyle = current ? C.accent : c.start < t ? C.muted : C.text;
      ctx.fillText(c.name, Math.max(labelW + 2, xOf(c.start)), 11);
    }

    // notes à chanter
    const barH = Math.max(6, Math.min(16, rowH * 0.75));
    this.notes.forEach((n, i) => {
      if (n.end < t0 || n.start > t1) return;
      const x = Math.max(labelW, xOf(n.start));
      const x2 = xOf(n.end);
      if (x2 <= labelW) return;
      const y = yOf(n.midi) - barH / 2;
      const current = n.start <= t && t < n.end;
      const past = n.end <= t;
      const r = this.results.get(i);
      ctx.beginPath();
      ctx.roundRect(x, y, Math.max(3, x2 - x - 2), barH, barH / 2);
      ctx.fillStyle = current ? C.accent : C.line;
      ctx.globalAlpha = past ? 0.55 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (past && r && r.total >= 2) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = r.hit / r.total >= 0.5 ? C.good : C.warn;
        ctx.stroke();
      }
    });

    // voix du chanteur : segments reliés, verts si justes, orange sinon
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      // pas de trait entre deux notes éloignées (saut de voix) ni après un silence
      if (b.t - a.t > 0.3 || Math.abs(b.midi - a.midi) > 1.5) continue;
      ctx.strokeStyle = b.good ? C.good : C.warn;
      ctx.beginPath();
      ctx.moveTo(xOf(a.t), yOf(a.midi));
      ctx.lineTo(xOf(b.t), yOf(b.midi));
      ctx.stroke();
    }

    // tête de lecture et point de la voix actuelle
    ctx.fillStyle = C.text;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(headX - 1, top, 2, laneH);
    ctx.globalAlpha = 1;
    const last = pts[pts.length - 1];
    if (last && t - last.t < 0.4) {
      ctx.beginPath();
      ctx.arc(headX, yOf(last.midi), 7, 0, Math.PI * 2);
      ctx.fillStyle = last.good ? C.good : C.warn;
      ctx.fill();
    }
    if (!this.notes.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = C.muted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('Mélodie non disponible pour ce morceau : seule votre voix est tracée.', w / 2, top + laneH / 2);
    }
  }
}

// Bilan d'une prise de chant : notes justes / fausses / oubliées, voix comparée à la mélodie,
// réécoute de la voix SUPERPOSÉE à la musique entendue pendant la prise (originale ou transposée).
import { cleanVoice, evaluateTake, pitchTrack, songTimeAt, type NoteResult, type TimelinePoint } from '../dsp/voiceEval';
import { midiName } from '../music/theory';
import type { Take } from './takes';

export interface AnalyzeInput {
  blob: Blob;
  timeline: TimelinePoint[];
  expected: { start: number; end: number; midi: number }[];
}

/** Analyse une prise : hauteur de la voix, nettoyage, comparaison note par note. */
export async function analyzeTake(input: AnalyzeInput, onProgress?: (f: number) => void) {
  const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await input.blob.arrayBuffer());
  const frames = await pitchTrack(buf.getChannelData(0), buf.sampleRate, 0.02, onProgress);
  const { kept } = cleanVoice(frames);
  const voice: [number, number][] = [];
  for (const f of kept) {
    const song = songTimeAt(input.timeline, f.t);
    if (song !== null && f.midi !== null) voice.push([song, f.midi]);
  }
  // plage du morceau effectivement chantée / écoutée pendant la prise
  const played = input.timeline.filter((p) => p.playing);
  let start = Infinity;
  let end = -Infinity;
  input.timeline.forEach((p, i) => {
    if (!p.playing) return;
    const next = input.timeline[i + 1];
    const recEnd = next ? next.rec : buf.duration;
    start = Math.min(start, p.song);
    end = Math.max(end, p.song + (recEnd - p.rec) * p.rate);
  });
  const range = played.length ? { start, end } : { start: 0, end: 0 };
  const { notes, summary } = evaluateTake(
    input.expected,
    voice.map(([songT, midi]) => ({ songT, midi })),
    range,
  );
  return { notes, summary, voice, range, duration: buf.duration };
}

/** Instant de l'enregistrement où le morceau était à `song` (premier passage). */
function recTimeAt(timeline: TimelinePoint[], song: number): number | null {
  for (let i = 0; i < timeline.length; i++) {
    const p = timeline[i];
    if (!p.playing) continue;
    const next = timeline[i + 1];
    const endSong = next ? p.song + (next.rec - p.rec) * p.rate : Infinity;
    if (song >= p.song && song < endSong) return p.rec + (song - p.song) / p.rate;
  }
  return null;
}

const VERDICT_TEXT: Record<NoteResult['verdict'], string> = {
  ok: 'juste',
  close: 'presque',
  sharp: 'trop haut',
  flat: 'trop bas',
  missed: 'pas chantée',
};

export function headlineOf(t: Pick<Take, 'summary'>): string {
  const s = t.summary;
  if (!s.judged) return 'Pas assez de mélodie chantée pour juger.';
  return `${s.ok} note${s.ok > 1 ? 's' : ''} juste${s.ok > 1 ? 's' : ''} sur ${s.judged} (${s.score} %)`;
}

/** Conseil principal tiré des erreurs. */
export function adviceOf(t: Pick<Take, 'summary'>): string {
  const s = t.summary;
  if (!s.judged) return 'Chantez avec la musique pendant au moins quelques mesures, idéalement avec un casque.';
  if (s.missed > s.judged * 0.4) return 'Beaucoup de notes non chantées : chantez plus fort, plus près du micro, ou vérifiez les paroles en même temps.';
  if (s.flat > s.sharp * 1.5 && s.flat >= 3) return `Vous chantez souvent trop bas (en moyenne ${Math.abs(s.tendency).toFixed(1).replace('.', ',')} demi-ton) : soutenez le souffle, visez la note un peu plus haut.`;
  if (s.sharp > s.flat * 1.5 && s.sharp >= 3) return `Vous chantez souvent trop haut : relâchez, visez la note un peu plus bas.`;
  if (s.score >= 80) return 'Très bien ! Essayez à 100 % de la vitesse ou dans une autre tonalité.';
  return 'Réécoutez les passages en rouge en suivant les barres : la note à chanter est la barre, votre voix la courbe.';
}

export interface ReviewOptions {
  take: Take;
  /** Adresse du son entendu pendant la prise (null : voix seule). */
  backingUrl: Promise<string | null>;
  /** Ligne de paroles à un instant du morceau (pour le détail par passage). */
  lyricAt?: (t: number) => { start: number; text: string } | null;
  saved: boolean;
  onSave?: () => Promise<void>;
  onDelete?: () => Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Affiche le bilan dans `root` ; renvoie une fonction qui arrête la lecture (fermeture). */
export function renderReview(root: HTMLElement, o: ReviewOptions): () => void {
  const t = o.take;
  const s = t.summary;
  const pct = (n: number) => (s.judged ? Math.round((n / s.judged) * 100) : 0);
  // passages à revoir, par ligne de paroles
  const lines = new Map<number, { text: string; start: number; n: number; ok: number; low: number; high: number; miss: number }>();
  for (const n of t.notes) {
    const l = o.lyricAt?.(n.start);
    const k = l ? l.start : Math.floor(n.start / 8) * 8;
    const e = lines.get(k) ?? { text: l?.text || `Mesures vers ${Math.floor(k / 60)}:${String(Math.floor(k % 60)).padStart(2, '0')}`, start: k, n: 0, ok: 0, low: 0, high: 0, miss: 0 };
    e.n++;
    if (n.verdict === 'ok') e.ok++;
    if (n.verdict === 'flat') e.low++;
    if (n.verdict === 'sharp') e.high++;
    if (n.verdict === 'missed') e.miss++;
    lines.set(k, e);
  }
  const weak = [...lines.values()].filter((l) => l.n >= 2 && l.ok / l.n < 0.6).sort((a, b) => a.ok / a.n - b.ok / b.n).slice(0, 5);

  root.innerHTML = `
    <div class="take-head">
      <div class="take-score ${s.score >= 75 ? 'good' : s.score >= 50 ? 'mid' : 'low'}">${s.judged ? `${s.score}<small>%</small>` : '—'}</div>
      <div>
        <p class="take-headline">${esc(headlineOf(t))}</p>
        <p class="take-advice">${esc(adviceOf(t))}</p>
      </div>
    </div>
    <div class="take-bars" aria-label="Répartition des notes">
      <span class="tb ok" style="flex:${s.ok}" title="justes">${s.ok ? `✓ ${s.ok}` : ''}</span>
      <span class="tb close" style="flex:${s.close}" title="presque">${s.close ? `≈ ${s.close}` : ''}</span>
      <span class="tb high" style="flex:${s.sharp}" title="trop haut">${s.sharp ? `↑ ${s.sharp}` : ''}</span>
      <span class="tb low" style="flex:${s.flat}" title="trop bas">${s.flat ? `↓ ${s.flat}` : ''}</span>
      <span class="tb miss" style="flex:${s.missed}" title="pas chantées">${s.missed ? `○ ${s.missed}` : ''}</span>
    </div>
    <p class="small take-legend">✓ justes ${pct(s.ok)} % · ≈ presque (± 1 demi-ton) ${pct(s.close)} % · ↑ trop haut ${pct(s.sharp)} % · ↓ trop bas ${pct(s.flat)} % · ○ pas chantées ${pct(s.missed)} %
      <br/>Seules les notes d'au moins 0,2 s sont jugées ; les sons de moins de 0,15 s (bruits, consonnes) sont ignorés ; l'octave ne compte pas.</p>
    <div class="take-player">
      <button class="btn primary" type="button" data-act="play">▶ Réécouter</button>
      <label class="small">🎤 Voix <input type="range" min="0" max="1" step="0.05" value="1" data-vol="voice" /></label>
      <label class="small">🎵 Musique <input type="range" min="0" max="1" step="0.05" value="0.6" data-vol="music" /></label>
      <span class="small take-time" data-el="time"></span>
    </div>
    <div class="take-canvas-wrap"><canvas data-el="canvas" height="220"></canvas></div>
    <p class="small take-legend"><i class="lg-bar"></i> note à chanter (couleur = votre résultat) · <i class="lg-curve"></i> votre voix · touchez le graphique pour réécouter à cet endroit</p>
    ${weak.length ? `<h3>Passages à travailler</h3><ul class="take-weak">${weak
      .map(
        (l) =>
          `<li data-start="${l.start}"><strong>${esc(l.text.length > 60 ? `${l.text.slice(0, 60)}…` : l.text)}</strong> <span class="small">${l.ok}/${l.n} justes${
            l.low > l.high && l.low ? ' · plutôt trop bas' : l.high > l.low && l.high ? ' · plutôt trop haut' : l.miss > l.n / 2 ? ' · peu chanté' : ''
          }</span> <button class="btn small-btn" type="button">▶</button></li>`,
      )
      .join('')}</ul>` : ''}
    <div class="take-actions">
      ${o.saved ? '' : '<button class="btn" type="button" data-act="save">💾 Garder cette prise</button>'}
      <a class="btn" data-act="download">⬇️ Télécharger ma voix</a>
      ${o.onDelete ? '<button class="btn ghost" type="button" data-act="delete">🗑️ Supprimer</button>' : ''}
    </div>`;

  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const voiceUrl = URL.createObjectURL(t.blob);
  const voice = new Audio(voiceUrl);
  const music = new Audio();
  let musicReady = false;
  void o.backingUrl.then((u) => {
    if (!u) {
      (q<HTMLInputElement>('[data-vol="music"]').closest('label') as HTMLElement).title = 'Son du morceau indisponible : voix seule';
      return;
    }
    music.src = u;
    musicReady = true;
  });
  music.volume = 0.6;
  // téléchargement
  const dl = q<HTMLAnchorElement>('[data-act="download"]');
  dl.href = voiceUrl;
  dl.download = `EnjoySing - ${t.title} - ${t.date.slice(0, 16).replace('T', ' ').replace(':', 'h')}.${t.blob.type.includes('mp4') ? 'm4a' : t.blob.type.includes('ogg') ? 'ogg' : 'webm'}`;

  // ---- graphique
  const canvas = q<HTMLCanvasElement>('[data-el="canvas"]');
  const wrap = canvas.parentElement as HTMLElement;
  const PX = 70; // pixels par seconde
  const { start, end } = t.range.end > t.range.start ? t.range : { start: 0, end: 10 };
  const width = Math.max(wrap.clientWidth || 600, Math.ceil((end - start) * PX) + 40);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.width = width * dpr;
  canvas.height = 220 * dpr;
  // voix ramenée à l'octave de la note attendue la plus proche dans le temps (l'octave ne compte pas)
  const refAt = (time: number) => {
    let best = t.notes[0];
    for (const n of t.notes) if (Math.abs((n.start + n.end) / 2 - time) < Math.abs((best.start + best.end) / 2 - time)) best = n;
    return best?.midi ?? 60;
  };
  const shown = t.voice.map(([time, m]) => [time, m + 12 * Math.round((refAt(time) - m) / 12)] as [number, number]);
  const mids = [...t.notes.map((n) => n.midi), ...shown.map(([, m]) => m)];
  const lo = Math.floor(Math.min(...mids, 60)) - 2;
  const hi = Math.ceil(Math.max(...mids, 64)) + 2;
  const css = getComputedStyle(document.documentElement);
  const color = (v: string, fb: string) => css.getPropertyValue(v).trim() || fb;
  const X = (time: number) => 20 + (time - start) * PX;
  const Y = (m: number) => 10 + ((hi - m) / (hi - lo)) * 200;
  const COLORS: Record<NoteResult['verdict'], string> = { ok: '#2f9e5c', close: '#d9a21b', sharp: '#d9534f', flat: '#d9534f', missed: '#8a857c' };
  const draw = (playSong: number | null) => {
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, 220);
    // lignes des notes (do en plus marqué)
    for (let m = lo; m <= hi; m++) {
      g.strokeStyle = m % 12 === 0 ? color('--line', '#ccc') : 'rgba(128,128,128,0.12)';
      g.beginPath();
      g.moveTo(0, Y(m));
      g.lineTo(width, Y(m));
      g.stroke();
      if (m % 12 === 0) {
        g.fillStyle = color('--muted', '#888');
        g.font = '10px sans-serif';
        g.fillText(midiName(m), 2, Y(m) - 2);
      }
    }
    // notes attendues
    for (const n of t.notes) {
      const c = COLORS[n.verdict];
      g.fillStyle = `${c}${n.verdict === 'missed' ? '33' : '55'}`;
      g.strokeStyle = c;
      g.lineWidth = 1.5;
      const h = Math.max(6, 200 / (hi - lo) - 2);
      g.beginPath();
      g.roundRect(X(n.start), Y(n.midi) - h / 2, Math.max(3, (n.end - n.start) * PX), h, 3);
      g.fill();
      g.stroke();
    }
    // voix
    g.strokeStyle = color('--voice', '#2f8f6b');
    g.lineWidth = 2.5;
    g.beginPath();
    let prev: [number, number] | null = null;
    for (const p of shown) {
      if (!prev || p[0] - prev[0] > 0.08 || Math.abs(p[1] - prev[1]) > 1.5) g.moveTo(X(p[0]), Y(p[1]));
      else g.lineTo(X(p[0]), Y(p[1]));
      prev = p;
    }
    g.stroke();
    if (playSong !== null) {
      g.strokeStyle = color('--accent', '#d9622b');
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(playSong), 0);
      g.lineTo(X(playSong), 220);
      g.stroke();
    }
  };
  draw(null);

  // ---- lecture synchronisée : la voix mène, la musique suit (pauses et retours de la prise compris)
  const playBtn = q<HTMLButtonElement>('[data-act="play"]');
  let raf = 0;
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const sync = () => {
    const song = songTimeAt(t.timeline, voice.currentTime);
    if (musicReady) {
      const p = t.timeline.filter((x) => x.rec <= voice.currentTime).pop();
      if (song === null || voice.paused) {
        if (!music.paused) music.pause();
      } else {
        if (p && music.playbackRate !== p.rate) music.playbackRate = p.rate;
        if (Math.abs(music.currentTime - song) > 0.25) music.currentTime = song;
        if (music.paused) void music.play().catch(() => {});
      }
    }
    q('[data-el="time"]').textContent = song !== null ? `${fmt(song)} dans le morceau` : '';
    draw(song);
    if (song !== null) {
      const x = X(song);
      if (x < wrap.scrollLeft + 40 || x > wrap.scrollLeft + wrap.clientWidth - 40) wrap.scrollLeft = x - wrap.clientWidth / 3;
    }
    if (!voice.paused) raf = requestAnimationFrame(sync);
  };
  const play = (fromRec?: number) => {
    if (fromRec !== undefined) voice.currentTime = Math.max(0, fromRec);
    void voice.play();
    playBtn.textContent = '⏸ Pause';
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(sync);
  };
  const pause = () => {
    voice.pause();
    music.pause();
    playBtn.textContent = '▶ Réécouter';
  };
  voice.onended = pause;
  playBtn.onclick = () => (voice.paused ? play() : pause());
  q<HTMLInputElement>('[data-vol="voice"]').oninput = (e) => (voice.volume = +(e.target as HTMLInputElement).value);
  q<HTMLInputElement>('[data-vol="music"]').oninput = (e) => (music.volume = +(e.target as HTMLInputElement).value);
  canvas.onclick = (e) => {
    const song = start + (e.offsetX - 20) / PX;
    const rec = recTimeAt(t.timeline, song);
    if (rec !== null) play(rec - 0.5);
  };
  root.querySelectorAll<HTMLElement>('.take-weak li').forEach((li) => {
    li.querySelector('button')!.onclick = () => {
      const rec = recTimeAt(t.timeline, +li.dataset.start!);
      if (rec !== null) play(rec - 0.3);
    };
  });
  // titre des barres : détail au survol
  canvas.onmousemove = (e) => {
    const song = start + (e.offsetX - 20) / PX;
    const n = t.notes.find((x) => song >= x.start && song <= x.end);
    canvas.title = n ? `${midiName(n.midi)} : ${VERDICT_TEXT[n.verdict]}${n.deviation !== undefined ? ` (${n.deviation > 0 ? '+' : ''}${n.deviation.toFixed(1).replace('.', ',')} demi-ton)` : ''}` : '';
  };
  const saveBtn = root.querySelector<HTMLButtonElement>('[data-act="save"]');
  if (saveBtn && o.onSave)
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      await o.onSave!();
      saveBtn.textContent = '✓ Prise gardée';
    };
  const delBtn = root.querySelector<HTMLButtonElement>('[data-act="delete"]');
  if (delBtn && o.onDelete) delBtn.onclick = () => void o.onDelete!();

  return () => {
    pause();
    cancelAnimationFrame(raf);
    URL.revokeObjectURL(voiceUrl);
  };
}

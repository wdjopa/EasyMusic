import { analyzeInWorker, shiftInWorker } from './dsp/client';
import type { AnalysisResult } from './dsp/analyze';
import type { ChordSegment } from './dsp/chords';
import { rangeFromFrequencies } from './dsp/melody';
import { chordDiagramSvg, voicingsFor } from './music/guitar';
import {
  bestOctave,
  type Chord,
  chordName,
  freqToMidi,
  keyName,
  midiName,
  planTransposition,
  preferFlats,
  type Range,
  sameChord,
  simplifyChord,
  suggestCapo,
  transposeChord,
  transposeKey,
  VOICE_TYPES,
} from './music/theory';
import { startMic, type MicSession } from './ui/mic';
import { encodeWav } from './ui/wav';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- état
const state = {
  file: null as File | null,
  buffer: null as AudioBuffer | null,
  analysis: null as AnalysisResult | null,
  voice: loadVoice(),
  songRange: { low: 55, high: 72 } as Range,
  songRangeEstimated: false,
  semitones: 0,
  octave: 0,
  simple: true,
  appliedSemitones: 0,
  capo: 0,
  capoManual: false,
  flats: null as boolean | null, // null = automatique selon la tonalité
  currentIdx: -1,
  shiftedUrl: null as string | null,
  originalUrl: null as string | null,
};

function loadVoice(): Range {
  try {
    const v = JSON.parse(localStorage.getItem('easymusic.voice') || 'null');
    if (v && typeof v.low === 'number' && typeof v.high === 'number') return v;
  } catch {
    /* ignore */
  }
  return { ...VOICE_TYPES[2].range };
}
function saveVoice() {
  try {
    localStorage.setItem('easymusic.voice', JSON.stringify(state.voice));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- éléments
const fileInput = $<HTMLInputElement>('file');
const drop = $('drop');
const progress = $('progress');
const player = $<HTMLAudioElement>('player');
const voiceLow = $<HTMLSelectElement>('voice-low');
const voiceHigh = $<HTMLSelectElement>('voice-high');
const songLow = $<HTMLSelectElement>('song-low');
const songHigh = $<HTMLSelectElement>('song-high');
const capoSel = $<HTMLSelectElement>('capo');
const flatsBox = $<HTMLInputElement>('flats');
const simpleBox = $<HTMLInputElement>('simple');

// listes de notes
function fillNotes(sel: HTMLSelectElement, from: number, to: number) {
  sel.innerHTML = '';
  for (let m = from; m <= to; m++) sel.add(new Option(midiName(m), String(m)));
}
fillNotes(voiceLow, 33, 84);
fillNotes(voiceHigh, 45, 96);
fillNotes(songLow, 33, 84);
fillNotes(songHigh, 45, 96);
for (let c = 0; c <= 9; c++) capoSel.add(new Option(c === 0 ? 'Sans capo' : `Case ${c}`, String(c)));

// préréglages de voix
const presets = $('presets');
for (const vt of VOICE_TYPES) {
  const b = document.createElement('button');
  b.className = 'btn preset';
  b.dataset.id = vt.id;
  b.innerHTML = `<strong>${vt.label}</strong><small>${midiName(vt.range.low).split(' ')[0]} – ${midiName(vt.range.high).split(' ')[0]}</small>`;
  b.onclick = () => {
    state.voice = { ...vt.range };
    saveVoice();
    autoTranspose();
  };
  presets.append(b);
}

// ---------------------------------------------------------------- chargement
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
});

function setProgress(fraction: number | null, label = '') {
  progress.hidden = fraction === null;
  if (fraction === null) return;
  (progress.querySelector('.fill') as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
  (progress.querySelector('.label') as HTMLElement).textContent = label;
}

async function loadFile(file: File) {
  state.file = file;
  try {
    setProgress(0.02, 'Décodage du fichier…');
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    void ctx.close();
    state.buffer = buffer;
    state.analysis = null;
    state.appliedSemitones = 0;
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    if (state.shiftedUrl) URL.revokeObjectURL(state.shiftedUrl);
    state.shiftedUrl = null;
    state.originalUrl = URL.createObjectURL(file);
    player.src = state.originalUrl;
    $('player-wrap').hidden = false;
    $('song-title').textContent = file.name.replace(/\.[^.]+$/, '');
    $('song-meta').textContent = `${formatTime(buffer.duration)} · analyse en cours…`;

    const analysis = await analyzeInWorker(buffer, (f, l) => setProgress(f, l));
    state.analysis = analysis;
    if (analysis.melodyRange) {
      state.songRange = { ...analysis.melodyRange };
      state.songRangeEstimated = true;
    }
    state.capoManual = false;
    setProgress(null);
    autoTranspose();
  } catch (err) {
    console.error(err);
    setProgress(1, `Impossible de lire ce fichier : ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- test de voix
let mic: MicSession | null = null;
let liveMin = Infinity;
let liveMax = -Infinity;
$('mic-btn').addEventListener('click', async () => {
  const btn = $('mic-btn');
  if (mic) {
    const freqs = mic.stop();
    mic = null;
    btn.textContent = '🎤 Tester ma voix';
    btn.classList.remove('recording');
    const r = rangeFromFrequencies(freqs);
    if (r && r.high - r.low >= 5) {
      state.voice = r;
      saveVoice();
      $('mic-range').textContent = `Tessiture mesurée : ${midiName(r.low)} → ${midiName(r.high)}`;
      autoTranspose();
    } else {
      $('mic-range').textContent = "Pas assez de notes détectées. Réessayez en chantant plus fort et en tenant les notes.";
    }
    $('live-note').textContent = '—';
    return;
  }
  try {
    liveMin = Infinity;
    liveMax = -Infinity;
    mic = await startMic((f) => {
      if (f === null) return;
      const m = freqToMidi(f);
      liveMin = Math.min(liveMin, m);
      liveMax = Math.max(liveMax, m);
      const cents = Math.round((m - Math.round(m)) * 100);
      $('live-note').innerHTML = `${midiName(m).split(' ')[0]} <small>${Math.round(f)} Hz ${cents >= 0 ? '+' : ''}${cents}¢</small>`;
      $('mic-range').textContent = `De ${midiName(liveMin).split(' ')[0]} à ${midiName(liveMax).split(' ')[0]}`;
    });
    btn.textContent = '⏹ Terminer';
    btn.classList.add('recording');
  } catch (err) {
    $('mic-range').textContent = `Micro indisponible : ${(err as Error).message}`;
  }
});

// ---------------------------------------------------------------- réglages
voiceLow.onchange = voiceHigh.onchange = () => {
  state.voice = { low: +voiceLow.value, high: Math.max(+voiceHigh.value, +voiceLow.value + 1) };
  saveVoice();
  autoTranspose();
};
songLow.onchange = songHigh.onchange = () => {
  state.songRange = { low: +songLow.value, high: Math.max(+songHigh.value, +songLow.value + 1) };
  state.songRangeEstimated = false;
  autoTranspose();
};
const manualShift = (s: number) => setSemitones(s, bestOctave(state.songRange, state.voice, s));
$('t-minus').onclick = () => manualShift(Math.max(-12, state.semitones - 1));
$('t-plus').onclick = () => manualShift(Math.min(12, state.semitones + 1));
$('t-auto').onclick = () => autoTranspose();
capoSel.onchange = () => {
  state.capo = +capoSel.value;
  state.capoManual = true;
  render();
};
simpleBox.onchange = () => {
  state.simple = simpleBox.checked;
  state.capoManual = false;
  setSemitones(state.semitones, state.octave);
};
flatsBox.onchange = () => {
  state.flats = flatsBox.checked;
  render();
};
$('apply-audio').onclick = () => void applyAudio();
$('copy').onclick = () => {
  void navigator.clipboard.writeText(chordSheetText()).then(() => {
    $('copy').textContent = '✅ Copié';
    setTimeout(() => ($('copy').textContent = '📋 Copier la grille'), 1500);
  });
};

function autoTranspose() {
  const plan = planTransposition(state.songRange, state.voice);
  setSemitones(plan.semitones, plan.octave);
}

function setSemitones(s: number, octave: number) {
  state.semitones = Math.max(-12, Math.min(12, s));
  state.octave = octave;
  if (!state.capoManual) {
    const sugg = suggestCapo(weightedChords(), 7)[0];
    state.capo = sugg ? sugg.capo : 0;
  }
  render();
}

// ---------------------------------------------------------------- calculs
function flats(): boolean {
  if (state.flats !== null) return state.flats;
  return state.analysis ? preferFlats(transposeKey(state.analysis.key, state.semitones)) : false;
}

function soundingChord(c: Chord | null): Chord | null {
  return c ? transposeChord(c, state.semitones) : null;
}
function shapeChord(c: Chord | null): Chord | null {
  return c ? transposeChord(c, state.semitones - state.capo) : null;
}

/** Segments affichés (éventuellement simplifiés en triades, puis regroupés). */
function displaySegments(): ChordSegment[] {
  if (!state.analysis) return [];
  if (!state.simple) return state.analysis.segments;
  const out: ChordSegment[] = [];
  for (const seg of state.analysis.segments) {
    const chord = seg.chord ? simplifyChord(seg.chord) : null;
    const last = out[out.length - 1];
    if (last && sameChord(last.chord, chord)) last.end = seg.end;
    else out.push({ ...seg, chord });
  }
  return out;
}
let segs: ChordSegment[] = [];

function weightedChords(): { chord: Chord; weight: number }[] {
  if (!state.analysis) return [];
  const m = new Map<string, { chord: Chord; weight: number }>();
  for (const s of displaySegments()) {
    const c = soundingChord(s.chord);
    if (!c) continue;
    const k = chordName(c);
    const e = m.get(k) ?? { chord: c, weight: 0 };
    e.weight += s.end - s.start;
    m.set(k, e);
  }
  return [...m.values()];
}

function chordSheetText(): string {
  if (!state.analysis) return '';
  const f = flats();
  const lines = [
    `${$('song-title').textContent}`,
    `Tonalité : ${keyName(transposeKey(state.analysis.key, state.semitones), f)}`,
    state.capo ? `Capo case ${state.capo}` : 'Sans capo',
    state.semitones ? `Transposé de ${state.semitones > 0 ? '+' : ''}${state.semitones} demi-tons` : '',
    '',
  ].filter((l, i) => l || i === 4);
  const row: string[] = [];
  for (const s of segs) {
    if (!s.chord) continue;
    row.push(`[${formatTime(s.start)}] ${chordName(shapeChord(s.chord), f)}`);
  }
  for (let i = 0; i < row.length; i += 4) lines.push(row.slice(i, i + 4).join('   '));
  return lines.join('\n');
}

// ---------------------------------------------------------------- audio transposé
async function applyAudio() {
  if (!state.buffer) return;
  const target = state.semitones;
  const btn = $<HTMLButtonElement>('apply-audio');
  btn.disabled = true;
  const t = player.currentTime;
  const wasPlaying = !player.paused;
  try {
    let url: string;
    if (target === 0) {
      url = state.originalUrl!;
    } else {
      setProgress(0, 'Transposition de l’audio…');
      const chans = await shiftInWorker(state.buffer, target, (f, l) => setProgress(f, l));
      setProgress(0.98, 'Encodage…');
      const blob = encodeWav(chans, state.buffer.sampleRate);
      if (state.shiftedUrl) URL.revokeObjectURL(state.shiftedUrl);
      state.shiftedUrl = url = URL.createObjectURL(blob);
    }
    state.appliedSemitones = target;
    player.src = url;
    player.currentTime = t;
    if (wasPlaying) void player.play();
    setProgress(null);
  } catch (err) {
    setProgress(1, `Erreur : ${(err as Error).message}`);
  }
  render();
}

// ---------------------------------------------------------------- rendu
function formatTime(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const f = flats();
  const a = state.analysis;
  segs = displaySegments();
  simpleBox.checked = state.simple;

  // voix
  voiceLow.value = String(state.voice.low);
  voiceHigh.value = String(state.voice.high);
  presets.querySelectorAll<HTMLButtonElement>('.preset').forEach((b) => {
    const vt = VOICE_TYPES.find((v) => v.id === b.dataset.id)!;
    b.classList.toggle('active', vt.range.low === state.voice.low && vt.range.high === state.voice.high);
  });

  // chanson
  songLow.value = String(state.songRange.low);
  songHigh.value = String(state.songRange.high);
  $('song-range-hint').textContent = a
    ? state.songRangeEstimated
      ? 'Tessiture estimée automatiquement à partir de l’enregistrement — ajustez-la si besoin.'
      : a.melodyRange
        ? 'Tessiture ajustée manuellement.'
        : 'Mélodie non détectée : indiquez la tessiture à la main.'
    : 'Chargez une chanson pour estimer automatiquement la tessiture de la mélodie.';
  if (a) {
    $('song-meta').textContent = `${formatTime(a.duration)} · Tonalité d’origine : ${keyName(a.key)} · ${
      new Set(a.segments.filter((s) => s.chord).map((s) => chordName(s.chord))).size
    } accords différents`;
  }

  // transposition
  const s = state.semitones;
  $('t-value').textContent = s > 0 ? `+${s}` : String(s);
  renderRangeViz();
  const o = state.octave;
  const shifted = { low: state.songRange.low + s + o, high: state.songRange.high + s + o };
  const below = Math.max(0, state.voice.low - shifted.low);
  const above = Math.max(0, shifted.high - state.voice.high);
  let msg = '';
  if (a) msg += `Nouvelle tonalité : <strong>${keyName(transposeKey(a.key, s), f)}</strong>. `;
  if (o) msg += `🎤 Chantez <strong>une octave plus ${o < 0 ? 'bas' : 'haut'}</strong> que la voix originale. `;
  if (!below && !above) msg += '✅ La mélodie tient entièrement dans votre voix.';
  else {
    if (above) msg += `⚠️ ${above} demi-ton${above > 1 ? 's' : ''} trop aigu. `;
    if (below) msg += `⚠️ ${below} demi-ton${below > 1 ? 's' : ''} trop grave. `;
    if (state.songRange.high - state.songRange.low > state.voice.high - state.voice.low)
      msg += 'La mélodie est plus étendue que votre tessiture : ce réglage est le meilleur compromis.';
  }
  $('recommend').innerHTML = msg;
  const btn = $<HTMLButtonElement>('apply-audio');
  btn.disabled = !state.buffer || state.appliedSemitones === s;
  btn.textContent = s === 0 ? '🔊 Revenir à l’original' : `🔊 Transposer l’audio (${s > 0 ? '+' : ''}${s})`;
  $('audio-state').textContent = state.buffer
    ? state.appliedSemitones === s
      ? state.appliedSemitones === 0
        ? 'Lecture : version originale'
        : `Lecture : version transposée (${s > 0 ? '+' : ''}${s})`
      : 'L’audio n’est pas encore transposé.'
    : '';
  const dl = $<HTMLAnchorElement>('download');
  dl.hidden = !(state.shiftedUrl && state.appliedSemitones !== 0);
  if (state.shiftedUrl) {
    dl.href = state.shiftedUrl;
    dl.download = `${$('song-title').textContent} (${state.appliedSemitones > 0 ? '+' : ''}${state.appliedSemitones}).wav`;
  }

  // capo
  capoSel.value = String(state.capo);
  flatsBox.checked = f;
  if (a) {
    const best = suggestCapo(weightedChords(), 7)[0];
    $('capo-hint').textContent =
      best && best.capo !== state.capo
        ? `Astuce : capo case ${best.capo} pour jouer ${best.shapes.slice(0, 5).map((c) => chordName(c)).join(', ')}`
        : best
          ? state.capo
            ? `Les accords affichés sont les formes à jouer avec le capo en case ${state.capo}.`
            : ''
          : '';
  }

  renderTimeline();
  renderDiagrams();
  state.currentIdx = -1;
  updateNow();
}

function renderRangeViz() {
  const lo = 36;
  const hi = 90;
  const pct = (m: number) => `${((Math.max(lo, Math.min(hi, m)) - lo) / (hi - lo)) * 100}%`;
  const s = state.semitones;
  const bar = (r: Range, cls: string, label: string) =>
    `<div class="rv-row"><span class="rv-label">${label}</span><div class="rv-track"><div class="rv-bar ${cls}" style="left:${pct(
      r.low,
    )};width:calc(${pct(r.high)} - ${pct(r.low)})"><span>${midiName(r.low).split(' ')[0]}</span><span>${
      midiName(r.high).split(' ')[0]
    }</span></div></div></div>`;
  let keys = '';
  for (let m = lo; m <= hi; m++) if (m % 12 === 0) keys += `<span class="rv-c" style="left:${pct(m)}">Do${m / 12 - 1}</span>`;
  $('range-viz').innerHTML =
    bar(state.voice, 'voice', 'Votre voix') +
    bar(state.songRange, 'orig', 'Original') +
    (s || state.octave
      ? bar(
          { low: state.songRange.low + s + state.octave, high: state.songRange.high + s + state.octave },
          'shifted',
          'Vous chanterez',
        )
      : '') +
    `<div class="rv-row"><span class="rv-label"></span><div class="rv-track rv-axis">${keys}</div></div>`;
}

function renderTimeline() {
  const tl = $('timeline');
  if (!state.analysis) return;
  const f = flats();
  tl.innerHTML = '';
  segs.forEach((seg, i) => {
    const el = document.createElement('button');
    el.className = 'chip' + (seg.chord ? '' : ' nc') + (seg.confidence < 0.6 ? ' unsure' : '');
    el.dataset.idx = String(i);
    const shape = chordName(shapeChord(seg.chord), f);
    const sound = chordName(soundingChord(seg.chord), f);
    el.innerHTML = `<span class="c">${shape}</span>${
      state.capo && seg.chord ? `<span class="s">son : ${sound}</span>` : ''
    }<span class="t">${formatTime(seg.start)}</span>`;
    el.title = seg.confidence < 0.6 ? 'Détection incertaine' : '';
    el.style.flexGrow = String(Math.min(4, Math.max(1, (seg.end - seg.start) / 2)));
    el.onclick = () => {
      player.currentTime = seg.start + 0.01;
      if (player.paused) void player.play();
    };
    tl.append(el);
  });
}

function renderDiagrams() {
  const a = state.analysis;
  const box = $('diagrams');
  if (!a) return;
  const f = flats();
  const seen = new Map<string, Chord>();
  for (const s of segs) {
    const c = shapeChord(s.chord);
    if (c && !seen.has(chordName(c, f))) seen.set(chordName(c, f), c);
  }
  box.innerHTML = [...seen.entries()]
    .map(([name, c]) => `<div class="diagram">${voicingsFor(c).map((v) => chordDiagramSvg(name, v)).join('')}</div>`)
    .join('');
}

function segmentAt(t: number, segs: ChordSegment[]): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < segs[mid].start) hi = mid - 1;
    else if (t >= segs[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function updateNow() {
  const a = state.analysis;
  if (!a) return;
  const idx = segmentAt(player.currentTime, segs);
  if (idx === state.currentIdx) return;
  state.currentIdx = idx;
  const f = flats();
  const tl = $('timeline');
  tl.querySelector('.chip.current')?.classList.remove('current');
  const el = tl.querySelector<HTMLElement>(`.chip[data-idx="${idx}"]`);
  el?.classList.add('current');
  if (el && !player.paused) {
    const r = el.getBoundingClientRect();
    const tr = tl.getBoundingClientRect();
    if (r.top < tr.top || r.bottom > tr.bottom) tl.scrollTop += r.top - tr.top - 8;
  }
  const cur = idx >= 0 ? segs[idx].chord : null;
  const nextSeg = segs.slice(idx + 1).find((s) => s.chord);
  $('now-chord').textContent = chordName(shapeChord(cur), f);
  $('next-chord').textContent = nextSeg ? chordName(shapeChord(nextSeg.chord), f) : '—';
  const sc = shapeChord(cur);
  $('now-diagram').innerHTML = sc ? chordDiagramSvg(chordName(sc, f), voicingsFor(sc)[0]) : '';
}

function tick() {
  updateNow();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

render();

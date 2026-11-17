import { analyzeChannels, analyzeInWorker, shiftInWorker } from './dsp/client';
import { ANALYSIS_VERSION, type AnalysisResult } from './dsp/analyze';
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
import { analyzeVideo, prepareTransposedAudio } from './ui/api';
import { getSong, listSongs, removeSong, savePrefs, saveSong, type LibrarySong } from './ui/library';
import { startTabRecorder, tabCaptureSupported, type TabRecorder } from './ui/capture';
import { startMic, type MicSession } from './ui/mic';
import { createPlayer, parseYouTubeId, YT_STATE, type YTPlayer } from './ui/youtube';
import { encodeWav } from './ui/wav';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- état
const state = {
  source: 'file' as 'file' | 'youtube',
  file: null as File | null,
  buffer: null as AudioBuffer | null,
  analysis: null as AnalysisResult | null,
  voice: loadVoice(),
  songRange: { low: 55, high: 72 } as Range,
  songRangeEstimated: false,
  semitones: 0,
  octave: 0,
  /** « original » : accords et son de la chanson ; « voice » : accords et son transposés pour la voix. */
  mode: loadMode(),
  simple: true,
  appliedSemitones: 0,
  capo: 0,
  capoManual: false,
  flats: null as boolean | null, // null = automatique selon la tonalité
  currentIdx: -1,
  shiftedUrl: null as string | null,
  originalUrl: null as string | null,
};

function loadMode(): 'original' | 'voice' {
  try {
    return localStorage.getItem('easymusic.mode') === 'voice' ? 'voice' : 'original';
  } catch {
    return 'original';
  }
}

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
  state.source = 'file';
  currentSongId = null;
  analysisToken.cancelled = true;
  stopListening(false);
  yt?.pauseVideo();
  player.hidden = false;
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
    setProgress(null);
    if (state.source !== 'file' || state.file !== file) return; // une autre source a été chargée entre-temps
    state.analysis = null;
    showAnalysis(analysis);
    scheduleAudio(0);
  } catch (err) {
    console.error(err);
    setProgress(1, `Impossible de lire ce fichier : ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- YouTube
let yt: YTPlayer | null = null;
let ytState = -1;
let recorder: TabRecorder | null = null;
let liveTimer = 0;
let liveBusy = false;

function showTab(name: string) {
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
  if (name === 'catalogue') refreshCatalogue();
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => (tab.onclick = () => showTab(tab.dataset.tab!)));

// ---------------------------------------------------------------- catalogue
// Stocké dans le navigateur de l'utilisateur (pas de compte).
let catalogue: LibrarySong[] = [];
let currentSongId: string | null = null;
function refreshCatalogue() {
  catalogue = listSongs();
  $('cat-count').textContent = catalogue.length ? `(${catalogue.length})` : '';
  renderCatalogue();
}
function escapeHtml(t: string) {
  return t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
function renderCatalogue() {
  const q = $<HTMLInputElement>('cat-search').value.trim().toLowerCase();
  const list = catalogue.filter((s) => !q || `${s.title} ${s.author}`.toLowerCase().includes(q));
  const box = $('catalogue');
  if (!list.length) {
    box.innerHTML = `<p class="hint">${
      catalogue.length
        ? 'Aucune chanson ne correspond.'
        : 'Votre catalogue est vide : analysez une première vidéo YouTube ! Il est enregistré dans ce navigateur.'
    }</p>`;
    return;
  }
  box.innerHTML = list
    .map(
      (s) => `<div class="song-wrap"><button class="song" data-id="${s.id}">
        <img src="${s.thumbnail}" alt="" loading="lazy" />
        <span class="info"><span class="t">${escapeHtml(s.title)}</span>
        <span class="a">${escapeHtml(s.author)}</span>
        <span class="a">${keyName(s.prefs ? transposeKey(s.analysis.key, s.prefs.semitones) : s.analysis.key).split(' (')[0]}${
          s.prefs?.semitones ? ` (${s.prefs.semitones > 0 ? '+' : ''}${s.prefs.semitones})` : ''
        } · ${formatTime(s.duration)}</span></span>
      </button><button class="del" data-del="${s.id}" title="Retirer du catalogue" aria-label="Retirer du catalogue">✕</button></div>`,
    )
    .join('');
  box.querySelectorAll<HTMLButtonElement>('.del').forEach((b) => {
    b.onclick = () => {
      const song = catalogue.find((x) => x.id === b.dataset.del);
      if (song && confirm(`Retirer « ${song.title} » du catalogue ?`)) {
        removeSong(song.id);
        refreshCatalogue();
      }
    };
  });
  box.querySelectorAll<HTMLButtonElement>('.song').forEach((b) => {
    b.onclick = () => {
      showTab('youtube');
      $<HTMLInputElement>('yt-url').value = `https://www.youtube.com/watch?v=${b.dataset.id}`;
      void loadYouTube(b.dataset.id!);
      $('step-song').scrollIntoView({ behavior: 'smooth' });
    };
  });
}
$('cat-search').addEventListener('input', renderCatalogue);

$('yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void loadYouTube($<HTMLInputElement>('yt-url').value);
});

function ytError(msg: string) {
  $('yt-error').textContent = msg;
}

async function loadYouTube(url: string) {
  ytError('');
  const id = parseYouTubeId(url);
  if (!id) return ytError("Ce lien ne ressemble pas à une vidéo YouTube.");
  stopListening(false);
  audioToken++;
  audioStatus = '';
  yt?.unMute();
  state.source = 'youtube';
  state.file = null;
  state.buffer = null;
  state.analysis = null;
  state.appliedSemitones = 0;
  state.songRangeEstimated = false;
  if (state.shiftedUrl) URL.revokeObjectURL(state.shiftedUrl);
  state.shiftedUrl = null;
  player.pause();
  player.removeAttribute('src');
  player.hidden = true;
  $('timeline').innerHTML = '<p class="hint">Analyse en cours…</p>';
  $('listen').hidden = true;
  analysisToken.cancelled = true;
  const token = (analysisToken = { cancelled: false });
  $('diagrams').innerHTML = '';
  $('yt-wrap').hidden = false;
  $('player-wrap').hidden = false;
  $('song-title').textContent = 'Vidéo YouTube';
  $('song-meta').textContent = '';
  try {
    if (yt) yt.loadVideoById(id);
    else
      yt = await createPlayer($('yt-player'), id, onYtState, (m) => {
        ytError(m);
        stopListening(false);
      });
    yt.pauseVideo();
    history.replaceState(null, '', `?v=${id}`);
    render();
  } catch (err) {
    ytError((err as Error).message);
  }
  currentSongId = id;
  // déjà dans le catalogue du navigateur : rien à demander au serveur
  const saved = getSong(id);
  if (saved && saved.analysis.version === ANALYSIS_VERSION) {
    saveSong(saved); // met à jour la date d'ouverture
    openSong(saved);
    refreshCatalogue();
    return;
  }
  try {
    const song = await analyzeVideo(id, (f, l) => !token.cancelled && setProgress(f, l), token);
    if (token.cancelled) return;
    setProgress(null);
    saveSong(song);
    // une ancienne analyse refaite garde les réglages de l'utilisateur
    openSong({ ...song, prefs: saved?.prefs });
    refreshCatalogue();
  } catch (err) {
    if (token.cancelled) return;
    setProgress(null);
    ytError((err as Error).message);
    $('timeline').innerHTML = '<p class="hint">Les accords n’ont pas pu être trouvés.</p>';
    // solution de secours sur ordinateur : écouter le son de l'onglet
    if (tabCaptureSupported()) {
      $('listen').hidden = false;
      $('listen-state').textContent = 'Vous pouvez aussi analyser la vidéo en écoutant cet onglet.';
    }
  }
}
let analysisToken = { cancelled: false };

/** Affiche une chanson et restaure les réglages enregistrés (transposition, capo…). */
function openSong(song: Pick<LibrarySong, 'title' | 'analysis' | 'prefs'>) {
  $('song-title').textContent = song.title;
  state.analysis = null;
  restoringPrefs = true;
  showAnalysis(song.analysis);
  const p = song.prefs;
  if (p) {
    state.simple = p.simple;
    state.flats = p.flats;
    state.capo = p.capo;
    state.capoManual = true;
    if (p.mode) state.mode = p.mode;
    setSemitones(p.semitones, p.octave);
  }
  restoringPrefs = false;
  scheduleAudio(0);
}
let restoringPrefs = false;
let prefsTimer = 0;
/** Enregistre (avec un léger délai) les réglages de la chanson YouTube affichée. */
function persistPrefs() {
  if (restoringPrefs || state.source !== 'youtube' || !currentSongId || !state.analysis) return;
  const id = currentSongId;
  const prefs = {
    semitones: state.semitones,
    octave: state.octave,
    capo: state.capo,
    simple: state.simple,
    flats: state.flats,
    mode: state.mode,
  };
  clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => savePrefs(id, prefs), 300);
}

function onYtState(s: number) {
  ytState = s;
  const title = yt?.getVideoData()?.title;
  if (title && state.source === 'youtube' && $('song-title').textContent === 'Vidéo YouTube') $('song-title').textContent = title;
  // en mode transposé, toucher la vidéo pilote le son transposé
  if (followingAudio() && performance.now() - ytCommandAt > 800) {
    if (s === YT_STATE.PLAYING && player.paused) {
      yt!.mute();
      void player.play();
    } else if (s === YT_STATE.PAUSED && !player.paused) player.pause();
  }
  recorder?.setRecording(s === YT_STATE.PLAYING);
  if (s === YT_STATE.ENDED && recorder) void finishListening();
}

$('listen-btn').addEventListener('click', () => {
  if (recorder) void finishListening();
  else void startListening();
});

async function startListening() {
  if (!yt) return;
  ytError('');
  try {
    yt.pauseVideo();
    recorder = await startTabRecorder();
  } catch (err) {
    const e = err as Error;
    ytError(e.name === 'NotAllowedError' ? 'Partage refusé : il faut partager cet onglet avec son audio.' : e.message);
    return;
  }
  recorder.onEnded = () => void finishListening();
  player.pause();
  state.analysis = null;
  state.appliedSemitones = 0;
  player.hidden = true;
  yt.unMute();
  yt.seekTo(0, true);
  yt.playVideo();
  $('listen-btn').textContent = '⏹ Terminer l’écoute';
  $('listen-btn').classList.add('recording');
  liveTimer = window.setInterval(liveUpdate, 1000);
}

let lastLiveAnalysis = 0;
function liveUpdate() {
  if (!recorder || !yt) return;
  const d = recorder.duration();
  const v = yt.getCurrentTime();
  const total = yt.getDuration();
  $('level-fill').style.width = `${Math.min(100, recorder.level() * 140)}%`;
  let msg = `Écoute : ${formatTime(d)}${total ? ` / ${formatTime(total)}` : ''}`;
  if (ytState === YT_STATE.PLAYING && d > 3 && recorder.level() < 0.002)
    msg += " — ⚠️ aucun son reçu : vérifiez que l'audio de l'onglet est partagé et que la vidéo n'est pas muette.";
  else if (Math.abs(v - d) > 2.5) msg += ' — ⚠️ ne déplacez pas la lecture pendant l’écoute (publicité ?) : les accords risquent d’être décalés.';
  $('listen-state').textContent = msg;
  // analyse progressive toutes les ~8 s
  if (!liveBusy && d > 6 && d - lastLiveAnalysis >= 8) {
    liveBusy = true;
    lastLiveAnalysis = d;
    analyzeChannels(recorder.snapshot(), recorder.sampleRate)
      .then((a) => {
        if (!recorder) return;
        showAnalysis(a);
      })
      .finally(() => (liveBusy = false));
  }
}

function stopListening(keep: boolean): Float32Array[] | null {
  clearInterval(liveTimer);
  $('listen-btn').textContent = '🎧 Écouter et analyser';
  $('listen-btn').classList.remove('recording');
  $('level-fill').style.width = '0';
  if (!recorder) return null;
  const r = recorder;
  recorder = null;
  lastLiveAnalysis = 0;
  const chans = r.stop();
  return keep ? chans : null;
}

async function finishListening() {
  const sr = recorder?.sampleRate ?? 48000;
  const chans = stopListening(true);
  if (!chans || chans[0].length < sr * 3) {
    $('listen-state').textContent = 'Écoute trop courte : relancez et laissez jouer la chanson.';
    return;
  }
  const buffer = new AudioBuffer({ length: chans[0].length, numberOfChannels: 2, sampleRate: sr });
  buffer.copyToChannel(chans[0], 0);
  buffer.copyToChannel(chans[1], 1);
  state.buffer = buffer;
  if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
  state.originalUrl = URL.createObjectURL(encodeWav(chans, sr));
  $('listen-state').textContent = `Écoute terminée (${formatTime(buffer.duration)}).`;
  try {
    const a = await analyzeChannels(chans.map((c) => c.slice()), sr, (f, l) => setProgress(f, l));
    setProgress(null);
    showAnalysis(a);
    if (state.source === 'youtube' && currentSongId) {
      const id = currentSongId;
      saveSong({
        id,
        title: $('song-title').textContent || 'Vidéo YouTube',
        author: '',
        duration: a.duration,
        thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
        analysis: a,
      });
      persistPrefs();
      refreshCatalogue();
    }
  } catch (err) {
    setProgress(1, `Erreur d'analyse : ${(err as Error).message}`);
  }
}

/** Enregistre un résultat d'analyse et met l'interface à jour. */
function showAnalysis(a: AnalysisResult) {
  const first = !state.analysis;
  state.analysis = a;
  if (a.melodyRange && (first || state.songRangeEstimated)) {
    state.songRange = { ...a.melodyRange };
    state.songRangeEstimated = true;
  }
  if (first) state.capoManual = false;
  autoTranspose();
}

// ---------------------------------------------------------------- lecture (fichier ou YouTube)
/** Lecture de la vidéo YouTube d'origine (et non d'une version transposée). */
const usingYt = () => state.source === 'youtube' && !!yt && state.appliedSemitones === 0;
function mediaTime(): number {
  return usingYt() ? yt!.getCurrentTime() : player.currentTime;
}
function mediaSeek(t: number) {
  if (usingYt()) {
    yt!.seekTo(t, true);
    if (ytState !== YT_STATE.PLAYING) yt!.playVideo();
  } else {
    player.currentTime = t;
    if (player.paused) void player.play();
  }
}
// Son transposé d'une vidéo YouTube : la vidéo reste visible, muette, et suit le son.
let ytCommandAt = 0;
const followingAudio = () => state.source === 'youtube' && !!yt && state.appliedSemitones !== 0;
function commandYt(fn: (p: YTPlayer) => void) {
  if (!yt) return;
  ytCommandAt = performance.now();
  fn(yt);
}
player.addEventListener('play', () => {
  if (followingAudio()) commandYt((p) => (p.mute(), p.seekTo(player.currentTime, true), p.playVideo()));
});
player.addEventListener('pause', () => {
  if (followingAudio()) commandYt((p) => p.pauseVideo());
});
player.addEventListener('seeked', () => {
  if (followingAudio()) commandYt((p) => p.seekTo(player.currentTime, true));
});

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
  const changed = s !== state.semitones;
  state.semitones = Math.max(-12, Math.min(12, s));
  state.octave = octave;
  if (changed && state.mode === 'voice') scheduleAudio();
  if (!state.capoManual) {
    const sugg = suggestCapo(weightedChords(), 7)[0];
    state.capo = sugg ? sugg.capo : 0;
  }
  render();
}

// ---------------------------------------------------------------- calculs
function flats(): boolean {
  if (state.flats !== null) return state.flats;
  return state.analysis ? preferFlats(transposeKey(state.analysis.key, shift())) : false;
}

function soundingChord(c: Chord | null): Chord | null {
  return c ? transposeChord(c, shift()) : null;
}
function shapeChord(c: Chord | null): Chord | null {
  return c ? transposeChord(c, shift() - state.capo) : null;
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
    `Tonalité : ${keyName(transposeKey(state.analysis.key, shift()), f)}`,
    state.capo ? `Capo case ${state.capo}` : 'Sans capo',
    shift() ? `Transposé de ${shift() > 0 ? '+' : ''}${shift()} demi-tons` : '',
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

// ---------------------------------------------------------------- son joué (original ou transposé)
/** Décalage appliqué aux accords affichés ET au son : 0 en mode « original ». */
function shift(): number {
  return state.mode === 'voice' ? state.semitones : 0;
}

let audioTimer = 0;
let audioToken = 0;
let audioStatus: '' | 'preparing' | 'error' = '';
let audioError = '';

function setMode(mode: 'original' | 'voice') {
  if (mode === state.mode) return;
  state.mode = mode;
  try {
    localStorage.setItem('easymusic.mode', mode);
  } catch {
    /* ignore */
  }
  state.capoManual = false;
  setSemitones(state.semitones, state.octave); // recalcule le capo et réaffiche
  scheduleAudio(0);
}
document.querySelectorAll<HTMLButtonElement>('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode as 'original' | 'voice')));

/** Met le son en accord avec les accords affichés (avec un petit délai si on clique plusieurs fois sur +/−). */
function scheduleAudio(delay = 500) {
  clearTimeout(audioTimer);
  audioTimer = window.setTimeout(() => void syncAudio(), delay);
}

async function syncAudio() {
  const target = shift();
  const token = ++audioToken;
  if (!state.analysis && !state.buffer) return;
  if (target === state.appliedSemitones && !(state.source === 'file' && !player.src)) {
    audioStatus = '';
    return render();
  }
  const fromYt = usingYt();
  const t = fromYt ? yt!.getCurrentTime() : player.currentTime;
  const wasPlaying = fromYt ? ytState === YT_STATE.PLAYING : !player.paused;

  // retour à la vidéo originale
  if (state.source === 'youtube' && target === 0) {
    player.pause();
    player.hidden = true;
    state.appliedSemitones = 0;
    audioStatus = '';
    if (yt) {
      commandYt((p) => (p.unMute(), p.seekTo(t, true)));
      if (wasPlaying) yt.playVideo();
    }
    return render();
  }

  audioStatus = 'preparing';
  render();
  try {
    let url: string;
    if (state.source === 'youtube') {
      if (!currentSongId) return;
      url = await prepareTransposedAudio(currentSongId, target);
    } else if (target === 0) {
      url = state.originalUrl!;
    } else {
      if (!state.buffer) return;
      const chans = await shiftInWorker(state.buffer, target);
      if (token !== audioToken) return;
      if (state.shiftedUrl) URL.revokeObjectURL(state.shiftedUrl);
      state.shiftedUrl = url = URL.createObjectURL(encodeWav(chans, state.buffer.sampleRate));
    }
    if (token !== audioToken) return; // un autre réglage a été demandé entre-temps
    if (fromYt) commandYt((p) => (p.mute(), p.pauseVideo()));
    player.src = url;
    player.hidden = false;
    await new Promise<void>((r) => {
      player.addEventListener('loadedmetadata', () => r(), { once: true });
      player.addEventListener('error', () => r(), { once: true });
    });
    player.currentTime = t;
    state.appliedSemitones = target;
    audioStatus = '';
    if (wasPlaying) void player.play();
  } catch (err) {
    if (token !== audioToken) return;
    audioStatus = 'error';
    audioError = (err as Error).message;
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
  persistPrefs();

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
    $('song-meta').textContent = `${formatTime(a.duration)}${a.bpm ? ` · ${a.bpm} BPM` : ''} · Tonalité d’origine : ${keyName(a.key)} · ${
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
  // sélecteur « Original / Ma tonalité » et état du son
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  document.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  document.querySelectorAll<HTMLElement>('.mode-key-orig').forEach((e) => (e.textContent = a ? keyName(a.key, f).split(' (')[0] : ''));
  document.querySelectorAll<HTMLElement>('.mode-key-voice').forEach(
    (e) => (e.textContent = a ? `${keyName(transposeKey(a.key, s), f).split(' (')[0]}${s ? ` (${sign(s)})` : ''}` : s ? sign(s) : ''),
  );
  let st = '';
  if (a || state.buffer) {
    // le message décrit ce qui joue réellement, pas seulement ce qui est demandé
    const pending = shift() !== state.appliedSemitones && audioStatus !== 'error';
    if (audioStatus === 'preparing' || pending)
      st = state.appliedSemitones
        ? '⏳ Préparation du son… (le son joue encore dans la tonalité précédente)'
        : '⏳ Préparation du son transposé… (le son joue encore dans la tonalité originale)';
    else if (audioStatus === 'error') st = `⚠️ Son transposé indisponible : ${audioError}`;
    else if (state.mode === 'original') st = '🎵 Accords et son de la chanson originale.';
    else if (!s) st = '🎤 Votre tonalité est celle de la chanson : rien à transposer.';
    else st = `🎤 Accords et son transposés de ${sign(s)} demi-ton${Math.abs(s) > 1 ? 's' : ''} pour votre voix.`;
    if (state.mode === 'voice' && state.octave) st += ` Chantez une octave plus ${state.octave < 0 ? 'bas' : 'haut'} que la voix originale.`;
  }
  document.querySelectorAll<HTMLElement>('.audio-state').forEach((e) => (e.textContent = st));

  // rappel bien visible au-dessus des accords : dans quelle tonalité sont-ils ?
  const banner = $('key-banner');
  if (!a) banner.textContent = '';
  else {
    const k = keyName(transposeKey(a.key, shift()), f).split(' (')[0];
    const what =
      state.mode === 'voice' && s
        ? `🎤 Accords dans <strong>votre tonalité</strong> : ${k} (${sign(s)} demi-ton${Math.abs(s) > 1 ? 's' : ''} par rapport à l’original)`
        : state.mode === 'voice'
          ? `🎤 Votre tonalité = celle du morceau : ${k}`
          : `🎵 Accords de la <strong>chanson originale</strong> : ${k}`;
    const capo = state.capo
      ? ` — capo case ${state.capo} : jouez les formes en gros ; « son » = l’accord réellement entendu.`
      : '';
    banner.innerHTML = what + capo;
  }
  const dl = $<HTMLAnchorElement>('download');
  dl.hidden = !(state.source === 'file' && state.shiftedUrl && state.appliedSemitones !== 0);
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
    el.className = 'chip' + (seg.chord ? '' : ' nc') + (seg.confidence < 0.5 ? ' unsure' : '');
    el.dataset.idx = String(i);
    const shape = chordName(shapeChord(seg.chord), f);
    const sound = chordName(soundingChord(seg.chord), f);
    el.innerHTML = `<span class="c">${shape}</span>${
      state.capo && seg.chord ? `<span class="s">son : ${sound}</span>` : ''
    }<span class="t">${formatTime(seg.start)}${seg.chord && beatsOf(seg) ? ` · ${beatsOf(seg)} t.` : ''}</span>`;
    el.title = seg.confidence < 0.5 ? 'Détection incertaine' : '';
    el.style.flexGrow = String(Math.min(4, Math.max(1, (seg.end - seg.start) / 2)));
    el.onclick = () => mediaSeek(seg.start + 0.01);
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
  const t = mediaTime();
  const idx = segmentAt(t, segs);
  if (idx === state.currentIdx) return;
  state.currentIdx = idx;
  const f = flats();
  const tl = $('timeline');
  tl.querySelector('.chip.current')?.classList.remove('current');
  const el = tl.querySelector<HTMLElement>(`.chip[data-idx="${idx}"]`);
  el?.classList.add('current');
  if (el && (usingYt() ? ytState === YT_STATE.PLAYING : !player.paused)) {
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

/** Durée d'un temps (s) d'après le tempo détecté, ou null s'il est inconnu. */
function beatSeconds(): number | null {
  const bpm = state.analysis?.bpm;
  return bpm && bpm > 30 ? 60 / bpm : null;
}

/** Nombre de temps d'un accord. */
function beatsOf(seg: ChordSegment): number {
  const b = beatSeconds();
  return b ? Math.max(1, Math.round((seg.end - seg.start) / b)) : 0;
}

let gaugeKey = '';
/** Jauge : une case par temps de l'accord en cours, qui se remplit ; alerte sur le dernier temps. */
function updateGauge() {
  const wrap = $('gauge-wrap');
  const seg = state.currentIdx >= 0 ? segs[state.currentIdx] : undefined;
  if (!state.analysis || !seg || !seg.chord) {
    wrap.hidden = true;
    gaugeKey = '';
    return;
  }
  wrap.hidden = false;
  const t = mediaTime();
  const dur = seg.end - seg.start;
  const beat = beatSeconds();
  // au-delà de 16 temps, une seule barre continue
  const n = beat ? Math.min(beatsOf(seg), 16) : 1;
  const cell = dur / n;
  const gauge = $('gauge');
  const key = `${state.currentIdx}:${n}`;
  if (key !== gaugeKey) {
    gauge.innerHTML = '<div class="beat"></div>'.repeat(n);
    gaugeKey = key;
  }
  const elapsed = Math.max(0, Math.min(dur, t - seg.start));
  const remaining = dur - elapsed;
  const cur = Math.min(n - 1, Math.floor(elapsed / cell));
  gauge.querySelectorAll<HTMLElement>('.beat').forEach((el, i) => {
    el.classList.toggle('done', i < cur);
    el.style.setProperty('--fill', i === cur ? `${((elapsed - i * cell) / cell) * 100}%` : '0%');
  });
  const last = beat ? remaining <= beat : remaining <= 1;
  gauge.classList.toggle('last', last);
  $('next-chord').classList.toggle('soon', last);
  const next = segs.slice(state.currentIdx + 1).find((x) => x.chord);
  const total = beatsOf(seg);
  const label = beat
    ? `<span>Temps <strong>${Math.min(total, Math.floor(elapsed / beat) + 1)}</strong> / ${total}</span>`
    : `<span>${elapsed.toFixed(1)} s / ${dur.toFixed(1)} s</span>`;
  const nextLabel = next
    ? `<span class="soon">${last ? '➜ ' : ''}${chordName(shapeChord(next.chord), flats())} dans ${remaining.toFixed(1).replace('.', ',')} s</span>`
    : '';
  $('gauge-label').innerHTML = label + nextLabel;
}

function tick() {
  updateNow();
  updateGauge();
  if (followingAudio() && !player.paused && performance.now() - ytCommandAt > 1500) {
    const drift = yt!.getCurrentTime() - player.currentTime;
    if (Math.abs(drift) > 0.5) commandYt((p) => p.seekTo(player.currentTime, true));
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

render();
refreshCatalogue();
const initial = new URLSearchParams(location.search).get('v');
if (initial && parseYouTubeId(initial)) {
  $<HTMLInputElement>('yt-url').value = `https://www.youtube.com/watch?v=${initial}`;
  void loadYouTube(initial);
}

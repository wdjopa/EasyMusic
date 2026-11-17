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
  noteName,
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
import { analyzeVideo, fetchLyrics, prepareTransposedAudio } from './ui/api';
import type { Lyrics } from './shared/lyrics';
import { getSong, listSongs, removeSong, saveLyrics, savePrefs, saveSong, type LibrarySong } from './ui/library';
import { startTabRecorder, tabCaptureSupported, type TabRecorder } from './ui/capture';
import { startMic, type MicSession } from './ui/mic';
import { Queue } from './ui/queue';
import { startPractice, type PracticeSession } from './ui/practice';
import { judgeChord, judgeVoice, type LiveFrame, type PracticeMode } from './dsp/live';
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
  lyrics: null as Lyrics | null,
  lyricsOffset: 0,
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
  if (steps.length && label) setStep(stepFromLabel(label), 'active');
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
  $('yt-wrap').hidden = true;
  showView('workspace');
  showPending();
  startLoading(['decode', 'analyze', 'lyrics']);
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
    state.lyricsOffset = 0;
    showAnalysis(analysis);
    scheduleAudio(0);
    void loadLyrics(file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), '', analysis.duration, null);
  } catch (err) {
    console.error(err);
    setProgress(null);
    const active = steps.find((x) => x.state === 'active') ?? steps[0];
    setStep(active.id, 'error', `Impossible de lire ce fichier : ${(err as Error).message}`);
    finishLoading();
    showFailed();
  }
}

// ---------------------------------------------------------------- YouTube
let yt: YTPlayer | null = null;
let ytState = -1;
let recorder: TabRecorder | null = null;
let liveTimer = 0;
let liveBusy = false;

// ---------------------------------------------------------------- navigation
/** Accueil (catalogue, fichiers) ou espace de jeu (chanson ouverte). */
function showView(view: 'home' | 'workspace') {
  $('home').hidden = view !== 'home';
  $('workspace').hidden = view !== 'workspace';
  if (view === 'home') refreshCatalogue();
  window.scrollTo({ top: 0 });
  updateMiniNow();
}
$('go-home').onclick = () => showView('home');
$('open-catalogue').onclick = () => {
  showView('home');
  $('cat-search').focus();
};
const voiceDialog = $<HTMLDialogElement>('voice-dialog');
$('open-voice').onclick = () => voiceDialog.showModal();
// fermer en cliquant à côté
voiceDialog.addEventListener('click', (e) => {
  if (e.target === voiceDialog) voiceDialog.close();
});

/** Onglets de la partition : paroles, grille, doigtés (choix retenu). */
function showSheetView(view: string) {
  document.querySelectorAll<HTMLElement>('.sheet .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll<HTMLElement>('.sheet .view').forEach((v) => (v.hidden = v.dataset.view !== view));
  try {
    localStorage.setItem('easymusic.sheetView', view);
  } catch {
    /* ignore */
  }
}
document.querySelectorAll<HTMLButtonElement>('.sheet .tab').forEach((t) => (t.onclick = () => showSheetView(t.dataset.view!)));
try {
  showSheetView(localStorage.getItem('easymusic.sheetView') ?? 'lyrics');
} catch {
  showSheetView('lyrics');
}

// ---------------------------------------------------------------- chargement par étapes
type StepState = 'pending' | 'active' | 'done' | 'error';
const STEP_LABELS: Record<string, string> = {
  info: 'Infos de la vidéo',
  download: 'Téléchargement de l’audio',
  decode: 'Lecture du fichier',
  analyze: 'Accords, tempo et tonalité',
  lyrics: 'Paroles',
};
let steps: { id: string; state: StepState; note?: string }[] = [];
let loadingStarted = 0;
let loadingTimer = 0;

function startLoading(ids: string[]) {
  steps = ids.map((id) => ({ id, state: 'pending' as StepState }));
  loadingStarted = performance.now();
  $('loading').hidden = false;
  $('yt-submit').classList.add('loading');
  $<HTMLButtonElement>('yt-submit').disabled = true;
  clearInterval(loadingTimer);
  loadingTimer = window.setInterval(renderSteps, 1000);
  renderSteps();
}
function setStep(id: string, state: StepState, note?: string) {
  const st = steps.find((x) => x.id === id);
  if (!st) return;
  // les étapes précédentes sont forcément terminées
  if (state === 'active' || state === 'done') for (const x of steps) {
    if (x === st) break;
    if (x.state !== 'error') x.state = 'done';
  }
  st.state = state;
  if (note !== undefined) st.note = note;
  renderSteps();
  if (steps.every((x) => x.state === 'done' || x.state === 'error')) finishLoading();
}
function finishLoading() {
  clearInterval(loadingTimer);
  $('yt-submit').classList.remove('loading');
  $<HTMLButtonElement>('yt-submit').disabled = false;
  setTimeout(() => {
    if (steps.every((x) => x.state === 'done')) $('loading').hidden = true;
  }, 900);
}
function renderSteps() {
  const secs = Math.round((performance.now() - loadingStarted) / 1000);
  $('steps').innerHTML = steps
    .map(
      (x) =>
        `<li class="step ${x.state}"><span class="dot"></span><span>${STEP_LABELS[x.id]}${
          x.note ? ` <small>${escapeHtml(x.note)}</small>` : ''
        }</span>${x.state === 'active' && secs > 2 ? `<small class="elapsed">${secs} s</small>` : ''}</li>`,
    )
    .join('');
}
/** Associe un message de progression du serveur ou de l'analyse à une étape. */
function stepFromLabel(label: string): string {
  if (/informations/i.test(label)) return 'info';
  if (/téléchargement/i.test(label)) return 'download';
  if (/décodage/i.test(label)) return 'decode';
  return 'analyze';
}

/** Contenu d'attente pendant l'analyse. */
function showPending() {
  $('timeline').innerHTML = `<div class="skel-grid">${'<div class="skel chip-skel"></div>'.repeat(12)}</div>`;
  $('lyrics').innerHTML = `<div class="skel-lines">${skeleton(10)}</div>`;
  $('diagrams').innerHTML = '';
  $('now-chord').innerHTML = '<span class="skel skel-inline"></span>';
  $('next-chord').textContent = '';
  $('now-diagram').innerHTML = '';
  $('gauge-wrap').hidden = true;
}
function showFailed() {
  $('timeline').innerHTML = '<p class="hint">Les accords n’ont pas pu être trouvés.</p>';
  $('lyrics').innerHTML = '<p class="hint">Pas de paroles sans analyse.</p>';
  $('now-chord').textContent = '—';
}

/** Blocs gris animés en attendant le contenu. */
function skeleton(lines: number) {
  return Array.from({ length: lines }, (_, i) => `<div class="skel" style="width:${55 + ((i * 37) % 40)}%"></div>`).join('');
}

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
      $<HTMLInputElement>('yt-url').value = `https://www.youtube.com/watch?v=${b.dataset.id}`;
      void loadYouTube(b.dataset.id!);
    };
  });
}
$('cat-search').addEventListener('input', renderCatalogue);

const isPlaying = () => (usingYt() ? ytState === YT_STATE.PLAYING : !!state.analysis && !player.paused);

$('yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $<HTMLInputElement>('yt-url').value;
  // une chanson joue : on ne l'interrompt pas, la nouvelle part en file d'attente
  if (isPlaying() && parseYouTubeId(url) !== currentSongId) return enqueue(url, true);
  void loadYouTube(url);
});
$('yt-queue').onclick = () => enqueue($<HTMLInputElement>('yt-url').value, false);

// ---------------------------------------------------------------- file d'attente
const queue = new Queue();
let toastTimer = 0;
function toast(html: string, action?: { label: string; run: () => void }) {
  const t = $('toast');
  t.innerHTML = `<span>${html}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small-btn';
    b.textContent = action.label;
    b.onclick = () => {
      t.hidden = true;
      action.run();
    };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 6000);
}

function enqueue(url: string, becausePlaying: boolean) {
  const item = queue.add(url);
  if (!item) return ytError('Ce lien ne ressemble pas à une vidéo YouTube.');
  ytError('');
  $<HTMLInputElement>('yt-url').value = '';
  toast(
    item.status === 'done'
      ? 'Déjà prête dans votre catalogue.'
      : `${becausePlaying ? 'La musique continue : ' : ''}ajoutée à la file, analyse en arrière-plan.`,
    { label: 'Ouvrir maintenant', run: () => void loadYouTube(item.id) },
  );
}

function renderQueue() {
  const btn = $('open-queue');
  btn.hidden = queue.items.length === 0;
  const pending = queue.pending;
  $('queue-badge').innerHTML = pending
    ? `<span class="spinner dark"></span> ${pending} en cours`
    : `✅ ${queue.ready} prête${queue.ready > 1 ? 's' : ''}`;
  btn.classList.toggle('has-ready', !pending && queue.ready > 0);
  const label = { waiting: 'En attente', running: '', done: 'Prête', error: 'Erreur' };
  $('queue-list').innerHTML = queue.items
    .map(
      (i) => `<li class="q-item ${i.status}">
        <img src="https://i.ytimg.com/vi/${i.id}/default.jpg" alt="" loading="lazy" />
        <div class="q-info">
          <div class="q-title">${escapeHtml(i.title)}</div>
          <div class="q-state">${escapeHtml(i.status === 'running' ? i.label : i.status === 'error' ? i.error ?? 'Erreur' : label[i.status])}</div>
          ${i.status === 'running' ? `<div class="q-bar"><div style="width:${Math.round(i.progress * 100)}%"></div></div>` : ''}
        </div>
        <div class="q-actions">
          ${i.status === 'done' ? `<button class="btn small-btn primary" data-open="${i.id}">Ouvrir</button>` : ''}
          ${i.status === 'error' ? `<button class="btn small-btn" data-retry="${i.id}">Réessayer</button>` : ''}
          <button class="btn small-btn ghost" data-remove="${i.id}" title="Retirer de la file">✕</button>
        </div>
      </li>`,
    )
    .join('');
  $('queue-list').querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
    b.onclick = () => {
      $('queue-panel').hidden = true;
      void loadYouTube(b.dataset.open!);
    };
  });
  $('queue-list').querySelectorAll<HTMLButtonElement>('[data-retry]').forEach((b) => (b.onclick = () => queue.retry(b.dataset.retry!)));
  $('queue-list').querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => (b.onclick = () => queue.remove(b.dataset.remove!)));
}
let lastReady = queue.ready;
queue.onChange(() => {
  renderQueue();
  // une chanson vient d'être prête : on prévient et on rafraîchit le catalogue
  if (queue.ready > lastReady) {
    const done = [...queue.items].reverse().find((i) => i.status === 'done');
    if (done) toast(`✅ « ${escapeHtml(done.title)} » est prête.`, { label: 'Ouvrir', run: () => void loadYouTube(done.id) });
    refreshCatalogue();
  }
  lastReady = queue.ready;
});
$('open-queue').onclick = (e) => {
  e.stopPropagation();
  $('queue-panel').hidden = !$('queue-panel').hidden;
};
$('queue-clear').onclick = () => queue.clearDone();
document.addEventListener('click', (e) => {
  if (!$('queue-panel').hidden && !(e.target as HTMLElement).closest('.queue-anchor')) $('queue-panel').hidden = true;
});
renderQueue();

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
  state.lyrics = null;
  lyricsToken++;
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
  showView('workspace');
  showPending();
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
    startLoading(['lyrics']);
    saveSong(saved); // met à jour la date d'ouverture
    openSong(saved);
    refreshCatalogue();
    return;
  }
  startLoading(['info', 'download', 'analyze', 'lyrics']);
  setStep('info', 'active');
  try {
    const song = await analyzeVideo(id, (f, l) => !token.cancelled && setProgress(f, l), token);
    if (token.cancelled) return;
    setProgress(null);
    saveSong(song);
    // une ancienne analyse refaite garde les réglages de l'utilisateur
    openSong({ ...song, prefs: saved?.prefs, lyrics: saved?.lyrics });
    refreshCatalogue();
  } catch (err) {
    if (token.cancelled) return;
    setProgress(null);
    ytError((err as Error).message);
    const active = steps.find((x) => x.state === 'active') ?? steps[0];
    if (active) setStep(active.id, 'error', (err as Error).message);
    finishLoading();
    showFailed();
    // solution de secours sur ordinateur : écouter le son de l'onglet
    if (tabCaptureSupported()) {
      $('listen').hidden = false;
      $('listen-state').textContent = 'Vous pouvez aussi analyser la vidéo en écoutant cet onglet.';
    }
  }
}
let analysisToken = { cancelled: false };

/** Affiche une chanson et restaure les réglages enregistrés (transposition, capo…). */
function openSong(song: Pick<LibrarySong, 'title' | 'analysis' | 'prefs'> & Partial<Pick<LibrarySong, 'id' | 'author' | 'lyrics'>>) {
  $('song-title').textContent = song.title;
  state.lyricsOffset = song.prefs?.lyricsOffset ?? 0;
  void loadLyrics(song.title, song.author ?? '', song.analysis.duration, song.id ?? null, song.lyrics);
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
    lyricsOffset: state.lyricsOffset,
  };
  clearTimeout(prefsTimer);
  pendingPrefs = () => savePrefs(id, prefs);
  prefsTimer = window.setTimeout(() => {
    pendingPrefs?.();
    pendingPrefs = null;
  }, 300);
}
let pendingPrefs: (() => void) | null = null;
// ne rien perdre si la page est fermée juste après un réglage
window.addEventListener('pagehide', () => pendingPrefs?.());

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
  const vt = VOICE_TYPES.find((v) => v.range.low === state.voice.low && v.range.high === state.voice.high);
  $('voice-chip').textContent = vt ? vt.label : `${midiName(state.voice.low).split(' ')[0]}–${midiName(state.voice.high).split(' ')[0]}`;
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
  $('recommend').innerHTML = state.mode === 'voice' ? msg : '';
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
    // le bandeau au-dessus de l'accord dit déjà quelle tonalité est jouée : ici, seulement les messages utiles
    else if (state.mode === 'original' && s) st = `💡 Pour votre voix : ${sign(s)} demi-ton${Math.abs(s) > 1 ? 's' : ''} → choisissez « 🎤 Ma tonalité ».`;
    else if (state.mode === 'voice' && state.octave) st = `🎤 Chantez une octave plus ${state.octave < 0 ? 'bas' : 'haut'} que la voix originale.`;
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
  renderLyrics();
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
    const result = tallies.get(i);
    if (result?.total) applyResult(el, result);
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

// ---------------------------------------------------------------- paroles
let lyricsToken = 0;
let lyricsStatus: 'idle' | 'loading' | 'none' | 'error' = 'idle';

/** Charge les paroles (depuis le catalogue si déjà connues, sinon via le serveur). */
async function loadLyrics(title: string, author: string, duration: number, songId: string | null, known?: Lyrics | null) {
  const token = ++lyricsToken;
  if (known !== undefined) {
    state.lyrics = known;
    lyricsStatus = known ? 'idle' : 'none';
    setStep('lyrics', 'done', known ? '' : 'introuvables');
    return render();
  }
  setStep('lyrics', 'active');
  state.lyrics = null;
  lyricsStatus = 'loading';
  render();
  try {
    const l = await fetchLyrics(title, author, duration);
    if (token !== lyricsToken) return;
    state.lyrics = l;
    lyricsStatus = l ? 'idle' : 'none';
    if (songId) saveLyrics(songId, l);
    setStep('lyrics', 'done', l ? (l.synced ? '' : 'non synchronisées') : 'introuvables');
  } catch {
    if (token !== lyricsToken) return;
    lyricsStatus = 'error';
    setStep('lyrics', 'done', 'indisponibles');
  }
  render();
}

$('lyr-minus').onclick = () => shiftLyrics(-0.5);
$('lyr-plus').onclick = () => shiftLyrics(0.5);
function shiftLyrics(d: number) {
  state.lyricsOffset = Math.round((state.lyricsOffset + d) * 10) / 10;
  render();
}

interface SheetRow {
  start: number;
  text: string;
  instru: boolean;
  chords: { pos: number; name: string; held: boolean }[];
}
let sheet: SheetRow[] = [];

/**
 * Grille « paroles + accords » : chaque ligne de paroles avec, au-dessus, les accords qui changent
 * pendant qu'elle est chantée (position estimée selon le moment du changement dans la ligne).
 */
function buildSheet(): SheetRow[] {
  const lines = state.lyrics?.synced;
  if (!lines?.length || !state.analysis) return [];
  const f = flats();
  const off = state.lyricsOffset;
  const end = state.analysis.duration;
  const name = (c: Chord | null) => chordName(shapeChord(c), f);
  const rows: SheetRow[] = [];
  const chordRow = (from: number, to: number) => segs.filter((g) => g.chord && g.start >= from - 0.15 && g.start < to);
  // accords consécutifs identiques (après simplification) : un seul
  const dedupe = (list: ChordSegment[]) => list.filter((g, k) => k === 0 || name(g.chord) !== name(list[k - 1].chord));
  const spread = (list: ChordSegment[]) => {
    let pos = 0;
    return dedupe(list).map((g) => {
      const r = { pos, name: name(g.chord), held: false };
      pos += r.name.length + 3;
      return r;
    });
  };
  // intro instrumentale
  const first = lines[0].time + off;
  const intro = chordRow(0, first - 0.15);
  if (intro.length) rows.push({ start: 0, text: '♪ intro', instru: true, chords: spread(intro) });
  lines.forEach((line, i) => {
    const start = line.time + off;
    const next = i + 1 < lines.length ? lines[i + 1].time + off : end;
    const text = line.text || '♪';
    // durée réellement chantée (estimée) : une ligne n'occupe pas forcément tout l'intervalle
    const sung = Math.min(next - start, Math.max(1.5, text.length / 8 + 0.6));
    const chords: SheetRow['chords'] = [];
    const inLine = chordRow(start, start + sung);
    const active = segs.find((g) => g.start <= start && g.end > start && g.chord);
    if (active && !inLine.some((g) => g.start - start < sung * 0.12)) chords.push({ pos: 0, name: name(active.chord), held: true });
    for (const g of inLine) {
      const ratio = Math.max(0, (g.start - start) / sung);
      chords.push({ pos: Math.round(ratio * text.length), name: name(g.chord), held: false });
    }
    // éviter les chevauchements
    for (let k = 1; k < chords.length; k++) chords[k].pos = Math.max(chords[k].pos, chords[k - 1].pos + chords[k - 1].name.length + 1);
    rows.push({ start, text, instru: !line.text, chords });
    // passage instrumental entre deux lignes
    const gap = chordRow(start + sung, next - 0.15);
    if (gap.length && next - start - sung > 4) rows.push({ start: start + sung, text: '♪', instru: true, chords: spread(gap) });
    else if (gap.length) {
      const last = rows[rows.length - 1];
      let pos = Math.max(text.length + 2, ...last.chords.map((c) => c.pos + c.name.length + 1));
      for (const g of dedupe(gap)) {
        if (last.chords.length && last.chords[last.chords.length - 1].name === name(g.chord)) continue;
        last.chords.push({ pos, name: name(g.chord), held: false });
        pos += name(g.chord).length + 1;
      }
    }
  });
  return rows;
}

function renderLyrics() {
  const box = $('lyrics');
  const offBox = $('lyrics-offset-box');
  $('lyr-offset').textContent = `${state.lyricsOffset > 0 ? '+' : ''}${String(state.lyricsOffset).replace('.', ',')} s`;
  const l = state.lyrics;
  $('lyrics-source').textContent = l ? `${l.artist} — ${l.track} · source : ${l.source}` : '';
  offBox.hidden = !l?.synced;
  sheet = [];
  lyricLine = -1;
  if (!state.analysis) return;
  if (lyricsStatus === 'loading') return void (box.innerHTML = `<p class="hint">Recherche des paroles…</p><div class="skel-lines">${skeleton(8)}</div>`);
  if (lyricsStatus === 'error') return void (box.innerHTML = '<p class="hint">Paroles indisponibles pour le moment.</p>');
  if (!l) return void (box.innerHTML = '<p class="hint">Paroles introuvables pour ce morceau.</p>');
  if (!l.synced) {
    box.innerHTML = `<p class="hint">Paroles non synchronisées : les accords ne peuvent pas être placés au-dessus.</p><pre class="plain">${escapeHtml(l.plain ?? '')}</pre>`;
    return;
  }
  sheet = buildSheet();
  box.innerHTML = sheet
    .map(
      (r, i) =>
        `<div class="lyric${r.instru ? ' instru' : ''}" data-i="${i}"><div class="chords">${r.chords
          .map((c) => `<span${c.held ? ' class="held"' : ''} style="left:${c.pos}ch">${escapeHtml(c.name)}</span>`)
          .join('')}</div><div class="text">${escapeHtml(r.text)}</div></div>`,
    )
    .join('');
  box.querySelectorAll<HTMLElement>('.lyric').forEach((el) => (el.onclick = () => mediaSeek(Math.max(0, sheet[+el.dataset.i!].start) + 0.01)));
}

let lyricLine = -1;
/** Surligne la ligne en cours et fait défiler les paroles. */
function updateLyrics() {
  if (!sheet.length) return;
  const t = mediaTime();
  let i = -1;
  for (let k = 0; k < sheet.length; k++) if (sheet[k].start <= t + 0.1) i = k;
  if (i === lyricLine) return;
  lyricLine = i;
  const box = $('lyrics');
  box.querySelector('.lyric.current')?.classList.remove('current');
  const el = box.querySelector<HTMLElement>(`.lyric[data-i="${i}"]`);
  el?.classList.add('current');
  const playing = usingYt() ? ytState === YT_STATE.PLAYING : !player.paused;
  if (el && playing) box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 3;
}

// ---------------------------------------------------------------- vérifier mon jeu (micro)
let practice: PracticeSession | null = null;
let practiceMode: PracticeMode = (() => {
  try {
    const m = localStorage.getItem('easymusic.practiceMode');
    return m === 'voice' || m === 'both' ? m : 'instrument';
  } catch {
    return 'instrument';
  }
})();
/** Résultats par accord de la grille : part des moments joués justes. */
let tallies = new Map<number, { ok: number; total: number }>();
let voiceScore = { ok: 0, total: 0 };
const recentChords: (Chord | null)[] = [];
const MIC_LATENCY = 0.15; // le son arrive au micro un peu après la musique

document.querySelectorAll<HTMLButtonElement>('.pmode').forEach((b) => {
  b.onclick = () => {
    practiceMode = b.dataset.pmode as PracticeMode;
    try {
      localStorage.setItem('easymusic.practiceMode', practiceMode);
    } catch {
      /* ignore */
    }
    renderPracticeMode();
  };
});

function renderPracticeMode() {
  document.querySelectorAll<HTMLElement>('.pmode').forEach((b) => b.classList.toggle('active', b.dataset.pmode === practiceMode));
  $('pl-chord-box').hidden = practiceMode === 'voice';
  $('pl-voice-box').hidden = practiceMode === 'instrument';
  $('practice-live').classList.toggle('single', practiceMode !== 'both');
}

$('practice-btn').addEventListener('click', async () => {
  const btn = $('practice-btn');
  if (practice) {
    practice.stop();
    practice = null;
    btn.textContent = '▶ Démarrer';
    btn.classList.remove('recording');
    return;
  }
  try {
    tallies = new Map();
    voiceScore = { ok: 0, total: 0 };
    renderTimeline();
    practice = await startPractice(
      () => practiceMode,
      () => (state.analysis ? transposeKey(state.analysis.key, shift()) : undefined),
      onPracticeFrame,
    );
    btn.textContent = '⏹ Arrêter';
    btn.classList.add('recording');
    $('practice-live').hidden = false;
    $('pl-score').textContent = 'Jouez en même temps que la musique…';
  } catch (err) {
    $('pl-score').textContent = `Micro indisponible : ${(err as Error).message}`;
    $('practice-live').hidden = false;
  }
});

/** Note de la mélodie attendue à l'instant t (dans la tonalité jouée), si l'analyse l'a estimée. */
function expectedMelody(t: number): number | null {
  const a = state.analysis;
  if (!a?.melody?.length || !a.melodyStep) return null;
  const i = Math.round((t - (a.melodyOffset ?? 0)) / a.melodyStep);
  // tolérance : la note la plus proche dans ±0,2 s
  for (const d of [0, -1, 1, -2, 2]) {
    const m = a.melody[i + d];
    if (m) return m + shift();
  }
  return null;
}

function onPracticeFrame(f: LiveFrame) {
  if (!state.analysis) return;
  const t = mediaTime() - MIC_LATENCY;
  const idx = segmentAt(t, segs);
  const expected = idx >= 0 ? soundingChord(segs[idx].chord) : null;
  const fl = flats();
  const key = transposeKey(state.analysis.key, shift());

  // instrument : accord stable sur les 3 derniers blocs, pour éviter le clignotement
  if (practiceMode !== 'voice') {
    recentChords.push(f.chord);
    if (recentChords.length > 3) recentChords.shift();
    const counts = new Map<string, { c: Chord | null; n: number }>();
    for (const c of recentChords) {
      const k = c ? chordName(c) : '';
      counts.set(k, { c, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    const stable = [...counts.values()].sort((x, y) => y.n - x.n)[0].c;
    const v = judgeChord(stable, expected);
    const box = $('pl-chord-box');
    box.classList.remove('ok', 'close', 'wrong');
    // on affiche la forme à jouer (capo compris), comme dans la grille
    const shape = (c: Chord | null) => (c ? chordName(transposeChord(c, -state.capo), fl) : '—');
    $('pl-chord').textContent = stable ? shape(stable) : '—';
    if (v !== 'silent') box.classList.add(v);
    $('pl-chord-verdict').textContent =
      v === 'silent'
        ? f.level < 0.008
          ? 'Je n’entends rien…'
          : 'Accord pas assez net'
        : v === 'ok'
          ? '✓ Juste'
          : v === 'close'
            ? `≈ Presque : attendu ${shape(expected)}`
            : `✗ Attendu : ${shape(expected)}`;
    if (v !== 'silent' && idx >= 0) {
      const tl = tallies.get(idx) ?? { ok: 0, total: 0 };
      tl.total++;
      tl.ok += v === 'ok' ? 1 : v === 'close' ? 0.5 : 0;
      tallies.set(idx, tl);
      const chip = document.querySelector<HTMLElement>(`.chip[data-idx="${idx}"]`);
      if (chip) applyResult(chip, tl);
    }
  }

  // voix : accordeur + rapport à la mélodie / à l'accord
  if (practiceMode !== 'instrument') {
    const box = $('pl-voice-box');
    box.classList.remove('ok', 'close', 'wrong');
    if (!f.pitch) {
      $('pl-note').textContent = '—';
      $('pl-voice-verdict').textContent = f.level < 0.008 ? 'Je n’entends rien…' : '';
      $('tuner-needle').style.left = '50%';
    } else {
      const p = f.pitch;
      $('pl-note').textContent = `${midiName(p.midi).split(' ')[0]}`;
      $('tuner-needle').style.left = `${50 + p.cents}%`;
      const v = judgeVoice(p.midi, expectedMelody(t), expected, key);
      const tune = Math.abs(p.cents) <= 10 ? 'pile juste' : `${p.cents > 0 ? 'un peu haut' : 'un peu bas'} (${p.cents > 0 ? '+' : ''}${p.cents} cents)`;
      const fits = {
        melody: '✓ la note de la mélodie',
        chord: '✓ dans l’accord',
        scale: v.expected !== null ? `≈ dans la gamme (mélodie : ${noteName(v.expected, fl)})` : '≈ dans la gamme',
        outside: v.expected !== null ? `✗ hors de la tonalité (mélodie : ${noteName(v.expected, fl)})` : '✗ hors de la tonalité',
      }[v.fit];
      $('pl-voice-verdict').textContent = `${fits} · ${tune}`;
      const good = v.inTune && (v.fit === 'melody' || v.fit === 'chord');
      const mid = v.fit !== 'outside';
      box.classList.add(good ? 'ok' : mid ? 'close' : 'wrong');
      voiceScore.total++;
      voiceScore.ok += good ? 1 : mid ? 0.5 : 0;
    }
  }

  // score de la séance
  let ok = 0;
  let total = 0;
  for (const v of tallies.values()) {
    ok += v.ok;
    total += v.total;
  }
  const parts: string[] = [];
  if (practiceMode !== 'voice' && total) parts.push(`Accords : <strong>${Math.round((ok / total) * 100)} %</strong> justes`);
  if (practiceMode !== 'instrument' && voiceScore.total)
    parts.push(`Voix : <strong>${Math.round((voiceScore.ok / voiceScore.total) * 100)} %</strong> juste`);
  if (parts.length) $('pl-score').innerHTML = parts.join(' · ');
}

function applyResult(chip: HTMLElement, tl: { ok: number; total: number }) {
  const r = tl.ok / tl.total;
  chip.classList.remove('res-ok', 'res-mid', 'res-ko');
  chip.classList.add(r >= 0.7 ? 'res-ok' : r >= 0.4 ? 'res-mid' : 'res-ko');
  chip.title = `Joué juste ${Math.round(r * 100)} % du temps`;
}
renderPracticeMode();

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

// ---------------------------------------------------------------- barre fixe sur téléphone
let nowVisible = true;
new IntersectionObserver((entries) => {
  nowVisible = entries[0].isIntersecting;
  updateMiniNow();
}).observe($('now-playing'));
function updateMiniNow() {
  const show = !nowVisible && !$('workspace').hidden && !!state.analysis && window.innerWidth < 900;
  $('mini-now').hidden = !show;
  document.body.classList.toggle('has-mini', show);
}
window.addEventListener('resize', updateMiniNow);
function tickMini() {
  if ($('mini-now').hidden) return;
  $('mini-chord').textContent = $('now-chord').textContent;
  $('mini-next').textContent = $('next-chord').textContent;
  const seg = state.currentIdx >= 0 ? segs[state.currentIdx] : undefined;
  const r = seg ? Math.max(0, Math.min(1, (mediaTime() - seg.start) / (seg.end - seg.start))) : 0;
  $('mini-fill').style.width = `${r * 100}%`;
  $('mini-now').classList.toggle('last', $('gauge').classList.contains('last'));
}

function tick() {
  updateNow();
  updateGauge();
  tickMini();
  updateLyrics();
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

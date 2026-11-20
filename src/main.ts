import { analyzeChannels, analyzeInWorker, shiftInWorker } from './dsp/client';
import { ANALYSIS_VERSION, type AnalysisResult } from './dsp/analyze';
import type { ChordSegment } from './dsp/chords';
import { rangeFromFrequencies } from './dsp/melody';
import { chordDiagramSvg, diagnoseVoicing, OPEN_PCS, STRING_NAMES, voicingsFor } from './music/guitar';
import { displayOctave, foldToOctave, melodyNotes } from './music/melody';
import { buildScore, type Score } from './music/score';
import { PitchLane } from './ui/pitchLane';
import {
  bestOctave,
  type Chord,
  chordName,
  freqToMidi,
  keyName,
  midiName,
  noteName,
  QUALITY_INTERVALS,
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
import { fetchFeatures, fetchLyrics, transcribeLyrics } from './ui/api';
import type { Lyrics } from './shared/lyrics';
import { getSong, listSongs, markNotEmbeddable, removeSong, saveLyrics, savePrefs, saveSong, type LibrarySong } from './ui/library';
import { startTabRecorder, tabCaptureSupported, type TabRecorder } from './ui/capture';
import { startMic, type MicSession } from './ui/mic';
import { Queue } from './ui/queue';
import { Layout, type PanelId } from './ui/layout';
import { deleteAudio, loadStoredIds, onStoredChange, storedIds } from './ui/audioStore';
import { localAudioUrl, songAudio } from './ui/localAudio';
import { obtainSong } from './ui/obtain';
import { headline, saveSession, sessionHistory, SessionRecorder, type Passage, type PassageReport } from './ui/session';
import { startPractice, type PracticeSession } from './ui/practice';
import { heardChordTones, judgeChord, judgeVoice, SILENCE_RMS, type LiveFrame, type PracticeMode } from './dsp/live';
import { createPlayer, parseYouTubeId, YT_EMBED_BLOCKED, YT_STATE, type YTPlayer } from './ui/youtube';
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
    audioFor = `file:${file.name}`;
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

// solfège (voir renderScore)
let scoreDirty = true;
let score: Score | null = null;
let scoreToken = 0;
let scorePos = '';

/** Onglets de la partition : paroles, solfège, grille, doigtés (choix retenu). */
function showSheetView(view: string) {
  document.querySelectorAll<HTMLElement>('.sheet .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll<HTMLElement>('.sheet .view').forEach((v) => (v.hidden = v.dataset.view !== view));
  try {
    localStorage.setItem('easymusic.sheetView', view);
  } catch {
    /* ignore */
  }
  $('note-names-box').hidden = view !== 'score';
  if (view === 'score' && scoreDirty) void renderScore();
}
document.querySelectorAll<HTMLButtonElement>('.sheet .tab').forEach((t) => (t.onclick = () => showSheetView(t.dataset.view!)));
try {
  const v = localStorage.getItem('easymusic.sheetView') ?? 'lyrics';
  showSheetView(['lyrics', 'score', 'grid', 'diagrams'].includes(v) ? v : 'lyrics');
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
        <span class="a">${escapeHtml(s.author)}${storedIds.has(s.id) ? ' · <span class="saved" title="Son enregistré dans ce navigateur : pas de nouveau téléchargement">💾 son gardé</span>' : ''}</span>
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
        void deleteAudio(song.id);
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
  audioFor = null;
  ytBlocked = false;
  clearLoop();
  $('open-report').hidden = true;
  $('yt-blocked').hidden = true;
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
    // préparer sans lancer : YouTube affiche la miniature et son grand bouton ▶
    // (lancer puis mettre en pause laissait un écran noir sans bouton)
    if (yt) yt.cueVideoById(id);
    else
      yt = await createPlayer($('yt-player'), id, onYtState, onYtError);
    history.replaceState(null, '', `?v=${id}`);
    render();
  } catch (err) {
    ytError((err as Error).message);
  }
  currentSongId = id;
  // déjà dans le catalogue du navigateur : rien à demander au serveur
  const saved = getSong(id);
  if (saved?.embeddable === false) onEmbedBlocked(true);
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
    const song = await obtainSong(id, (f, l) => !token.cancelled && setProgress(f, l), token);
    if (token.cancelled) return;
    setProgress(null);
    saveSong(song);
    if (song.embeddable === false) onEmbedBlocked(true);
    if (!storedIds.has(id)) void songAudio(id).catch(() => {}); // téléchargé une fois, gardé dans le navigateur
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

function onYtError(m: string, code: number) {
  if (YT_EMBED_BLOCKED.includes(code)) return onEmbedBlocked();
  ytError(m);
  stopListening(false);
}

function onYtState(s: number) {
  ytState = s;
  if (s === -1 || s === YT_STATE.BUFFERING || s === YT_STATE.PLAYING) playIntentAt = performance.now();
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
/** Vidéo interdite hors de YouTube : on joue alors le son (téléchargé par le serveur) à la place. */
let ytBlocked = false;
const usingYt = () => state.source === 'youtube' && !!yt && !ytBlocked && state.appliedSemitones === 0;

/** Moment où l'utilisateur a demandé la lecture (pour enchaîner sur le son si la vidéo est refusée). */
let playIntentAt = 0;
let autoStartAudio = false;

/**
 * Vidéo interdite hors de YouTube : on joue le son à la place. `known` = on le savait d'avance
 * (analyse ou erreur précédente) : pas besoin d'essayer le lecteur YouTube.
 */
function onEmbedBlocked(known = false) {
  if (ytBlocked || state.source !== 'youtube') return;
  ytBlocked = true;
  // la lecture venait d'être demandée : le son démarre tout seul, sans second clic
  autoStartAudio = !known && performance.now() - playIntentAt < 10_000;
  if (currentSongId) markNotEmbeddable(currentSongId);
  yt?.pauseVideo();
  const id = currentSongId;
  const blocked = $('yt-blocked');
  blocked.hidden = false;
  if (id) {
    blocked.style.backgroundImage = `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`;
    $<HTMLAnchorElement>('yt-open').href = `https://www.youtube.com/watch?v=${id}`;
  }
  ytError('');
  state.appliedSemitones = Number.NaN; // force le chargement du son, même dans la tonalité originale
  scheduleAudio(0);
}
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
const followingAudio = () => state.source === 'youtube' && !!yt && !ytBlocked && state.appliedSemitones !== 0;
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
/** Chanson à laquelle appartient le son chargé dans le lecteur audio. */
let audioFor: string | null = null;
let audioLabel = '';
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
  // le son chargé appartient-il à la chanson ouverte ? Sinon : nouvelle chanson, on part du début, en pause
  const sameSong = fromYt || audioFor === songKey();
  const t = !sameSong ? 0 : fromYt ? yt!.getCurrentTime() : player.currentTime;
  const wasPlaying = (sameSong && (fromYt ? ytState === YT_STATE.PLAYING : !player.paused)) || autoStartAudio;
  autoStartAudio = false;

  // retour à la vidéo originale (sauf si elle ne peut pas être lue ici)
  if (state.source === 'youtube' && target === 0 && !ytBlocked) {
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
  audioLabel = '';
  render();
  try {
    let url: string;
    if (state.source === 'youtube') {
      if (!currentSongId) return;
      // audio gardé dans le navigateur (téléchargé une seule fois), transposé sur place
      url = await localAudioUrl(currentSongId, target, (label) => {
        if (token !== audioToken) return;
        audioLabel = label;
        document.querySelectorAll<HTMLElement>('.audio-state').forEach((e) => (e.textContent = `⏳ ${label}`));
      });
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
    audioFor = songKey();
    player.hidden = false;
    await new Promise<void>((r) => {
      player.addEventListener('loadedmetadata', () => r(), { once: true });
      player.addEventListener('error', () => r(), { once: true });
    });
    player.currentTime = t;
    state.appliedSemitones = target;
    audioStatus = '';
    audioLabel = '';
    if (wasPlaying)
      player.play().catch(() => toast('▶ Appuyez sur lecture pour écouter le son.', { label: '▶ Lecture', run: () => void player.play() }));
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
    if ((audioStatus === 'preparing' || pending) && audioLabel) st = `⏳ ${audioLabel}`;
    else if ((audioStatus === 'preparing' || pending) && ytBlocked && !shift()) st = '⏳ Préparation du son…';
    else if (audioStatus === 'preparing' || pending)
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

  rebuildLane();
  renderTimeline();
  renderLyrics();
  scoreDirty = true;
  if (!$('score').closest<HTMLElement>('.view')!.hidden) void renderScore();
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
  diagKey = ''; // le diagnostic des cordes sera redessiné sur ce nouvel accord
}

// ---------------------------------------------------------------- paroles
let lyricsToken = 0;
let lyricsStatus: 'idle' | 'loading' | 'transcribing' | 'none' | 'error' = 'idle';
let transcribeLabel = '';
let transcribeProgress = 0;
let transcribeError = '';
let whisperOn = false;
let whisperWhy = '';
void fetchFeatures().then((f) => {
  whisperOn = f.whisper;
  whisperWhy = f.whisperReason ?? '';
  render();
});
/** Infos de la chanson ouverte, pour la transcription. */
let lyricsMeta: { title: string; author: string; songId: string | null } = { title: '', author: '', songId: null };

/** Transcrit les paroles par IA (Whisper) : pour les chansons YouTube absentes de la base de paroles. */
async function transcribeCurrent() {
  const { songId, title, author } = lyricsMeta;
  if (!songId || !whisperOn) return;
  const token = ++lyricsToken;
  lyricsStatus = 'transcribing';
  transcribeError = '';
  transcribeLabel = 'Préparation…';
  transcribeProgress = 0;
  setStep('lyrics', 'active', 'transcription par IA…');
  render();
  try {
    const l = await transcribeLyrics(songId, { title, author }, (f, label) => {
      if (token !== lyricsToken) return;
      transcribeProgress = f;
      transcribeLabel = label;
      const bar = document.querySelector<HTMLElement>('#transcribe-bar');
      if (bar) {
        bar.style.width = `${Math.round(f * 100)}%`;
        $('transcribe-label').textContent = label;
      }
    });
    if (token !== lyricsToken) return;
    state.lyrics = l;
    lyricsStatus = 'idle';
    saveLyrics(songId, l);
    setStep('lyrics', 'done', 'transcrites par IA');
  } catch (e) {
    if (token !== lyricsToken) return;
    lyricsStatus = state.lyrics ? 'idle' : 'none';
    transcribeError = (e as Error).message;
    setStep('lyrics', 'done', 'transcription impossible');
  }
  render();
}

/** Charge les paroles (depuis le catalogue si déjà connues, sinon via le serveur). */
async function loadLyrics(title: string, author: string, duration: number, songId: string | null, known?: Lyrics | null) {
  lyricsMeta = { title, author, songId: state.source === 'youtube' ? songId : null };
  transcribeError = '';
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
    // paroles absentes de la base : l'IA prend le relais
    const features = await fetchFeatures();
    whisperOn = features.whisper;
    whisperWhy = features.whisperReason ?? '';
    if (!l?.synced && songId && state.source === 'youtube' && whisperOn) return void transcribeCurrent();
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
  $('lyrics-source').textContent = l ? `${[l.artist, l.track].filter(Boolean).join(' — ')} · source : ${l.source}` : '';
  offBox.hidden = !l?.synced;
  sheet = [];
  lyricLine = -1;
  if (!state.analysis) return;
  const canAI = whisperOn && state.source === 'youtube' && !!lyricsMeta.songId;
  const aiButton = (text: string) => (canAI ? `<button class="btn small-btn" id="ai-lyrics">🤖 ${text}</button>` : '');
  const aiError = transcribeError ? `<p class="hint ai-error">⚠️ Transcription par IA : ${escapeHtml(transcribeError)}</p>` : '';
  if (lyricsStatus === 'loading') return void (box.innerHTML = `<p class="hint">Recherche des paroles…</p><div class="skel-lines">${skeleton(8)}</div>`);
  if (lyricsStatus === 'transcribing') {
    box.innerHTML = `<div class="transcribing">
        <p><strong>🤖 L’IA écoute la chanson pour écrire les paroles…</strong></p>
        <div class="q-bar"><div id="transcribe-bar" style="width:${Math.round(transcribeProgress * 100)}%"></div></div>
        <p class="small" id="transcribe-label">${escapeHtml(transcribeLabel)}</p>
        <p class="small hint">Les paroles ne sont pas dans la base : elles sont transcrites sur le serveur (Whisper). Comptez 20 s à 1 min.</p>
      </div><div class="skel-lines">${skeleton(6)}</div>`;
    return;
  }
  const wire = () => document.querySelector<HTMLButtonElement>('#ai-lyrics')?.addEventListener('click', () => void transcribeCurrent());
  if (lyricsStatus === 'error') {
    box.innerHTML = `<p class="hint">Paroles indisponibles pour le moment.</p>${aiButton('Transcrire par IA')}${aiError}`;
    return wire();
  }
  // l'IA n'est pas installée sur le serveur : on le dit, avec la marche à suivre
  const aiMissing =
    !whisperOn && state.source === 'youtube' && whisperWhy
      ? `<p class="hint ai-missing">🤖 Paroles par IA indisponibles sur le serveur : ${escapeHtml(whisperWhy)}.</p>`
      : '';
  if (!l) {
    box.innerHTML = `<p class="hint">Paroles introuvables pour ce morceau${canAI ? '' : '.'}</p>${aiButton('Transcrire les paroles par IA')}${aiError}${aiMissing}`;
    return wire();
  }
  if (!l.synced) {
    box.innerHTML = `<p class="hint">Paroles non synchronisées : les accords ne peuvent pas être placés au-dessus.</p>${aiButton('Les transcrire par IA (synchronisées)')}${aiError}<pre class="plain">${escapeHtml(l.plain ?? '')}</pre>`;
    return wire();
  }
  sheet = buildSheet();
  const isAI = l.source.startsWith('Whisper');
  const notice = isAI
    ? `<p class="ai-notice">🤖 Paroles transcrites automatiquement par IA : elles peuvent contenir des erreurs.</p>`
    : canAI
      ? `<p class="ai-notice subtle">Paroles incorrectes ? ${aiButton('Transcrire par IA')}</p>`
      : '';
  box.innerHTML = notice + aiError + sheet
    .map(
      (r, i) =>
        `<div class="lyric${r.instru ? ' instru' : ''}" data-i="${i}"><div class="chords">${r.chords
          .map((c) => `<span${c.held ? ' class="held"' : ''} style="left:${c.pos}ch">${escapeHtml(c.name)}</span>`)
          .join('')}</div><div class="text">${escapeHtml(r.text)}</div></div>`,
    )
    .join('');
  box.querySelectorAll<HTMLElement>('.lyric').forEach((el) => (el.onclick = () => mediaSeek(Math.max(0, sheet[+el.dataset.i!].start) + 0.01)));
  wire();
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

// ---------------------------------------------------------------- solfège : la mélodie sur une portée
const noteNamesBox = $<HTMLInputElement>('note-names');
try {
  noteNamesBox.checked = localStorage.getItem('easymusic.noteNames') === '1';
} catch {
  /* ignore */
}
noteNamesBox.onchange = () => {
  try {
    localStorage.setItem('easymusic.noteNames', noteNamesBox.checked ? '1' : '0');
  } catch {
    /* ignore */
  }
  void renderScore();
};

/** Écrit la mélodie (dans la tonalité jouée) en notation musicale, une ligne de portée par ligne de paroles. */
async function renderScore() {
  scoreDirty = false;
  const box = $('score');
  const info = $('score-info');
  const a = state.analysis;
  score = null;
  scorePos = '';
  const token = ++scoreToken;
  if (!a) return void ((box.innerHTML = ''), (info.textContent = ''));
  const octave = state.mode === 'voice' ? laneOctave : 0;
  const notes = melodyNotes(a, shift(), 0.15).map((n) => ({ ...n, midi: n.midi + octave }));
  if (!notes.length) {
    info.textContent = '';
    box.innerHTML = '<p class="hint">Mélodie introuvable sur ce morceau : la partition ne peut pas être écrite.</p>';
    return;
  }
  const f = flats();
  const off = state.lyricsOffset;
  const s = buildScore({
    notes,
    beats: a.beats,
    bpm: a.bpm,
    meter: a.meter,
    duration: a.duration,
    key: transposeKey(a.key, shift()),
    chords: segs.filter((g) => g.chord).map((g) => ({ start: g.start, name: chordName(soundingChord(g.chord), f) })),
    lines: state.lyrics?.synced?.map((l) => ({ start: l.time + off, text: l.text })),
    noteNames: noteNamesBox.checked,
    barsPerSystem: box.clientWidth && box.clientWidth < 520 ? 2 : 4,
  });
  if (!s.systems.length) {
    box.innerHTML = '<p class="hint">Mélodie trop incertaine sur ce morceau pour écrire une partition.</p>';
    return;
  }
  box.innerHTML = `<div class="skel-lines">${skeleton(5)}</div>`;
  const abcjs = await import('abcjs');
  if (token !== scoreToken) return;
  info.textContent = `Mélodie du chant, estimée automatiquement : vérifiez à l’oreille. Tonalité ${s.keyLabel.replace('m', ' mineur')}${s.keyLabel.endsWith('m') ? '' : ' majeur'} · ${s.meter}/4 · ${a.bpm ?? '?'} BPM${s.clef === 'bass' ? ' · clé de fa (voix grave)' : ''}. Touchez une mesure pour l’écouter.`;
  box.innerHTML = s.systems
    .map((sys, i) => `<div class="score-sys" data-i="${i}">${sys.text ? `<p class="score-text">${escapeHtml(sys.text)}</p>` : ''}<div class="score-staff"></div></div>`)
    .join('');
  const staffs = box.querySelectorAll<HTMLElement>('.score-staff');
  s.systems.forEach((sys, i) => {
    abcjs.renderAbc(staffs[i], `X:1\n${s.header}${sys.abc}\n`, {
      responsive: 'resize',
      add_classes: true,
      staffwidth: Math.min(640, Math.max(300, box.clientWidth - 40)),
      paddingtop: 4,
      paddingbottom: 4,
      paddingleft: 0,
      paddingright: 4,
      format: { gchordfont: 'sans-serif 13 bold', annotationfont: 'sans-serif 11' },
    });
  });
  score = s;
  box.querySelectorAll<HTMLElement>('.score-sys').forEach((el) => {
    el.onclick = (e) => {
      const sys = s.systems[+el.dataset.i!];
      const m = (e.target as Element).closest('[class*="abcjs-m"]')?.getAttribute('class')?.match(/abcjs-m(\d+)/);
      const bar = m ? sys.bars[+m[1]] : undefined;
      mediaSeek(Math.max(0, (bar ?? sys).start) + 0.01);
    };
  });
}

/** Ligne et mesure en cours surlignées pendant la lecture. */
function updateScore() {
  if (!score || $('score').closest<HTMLElement>('.view')!.hidden) return;
  const t = mediaTime();
  const i = score.systems.findIndex((sys) => t >= sys.start && t < sys.end);
  const k = i >= 0 ? score.systems[i].bars.findIndex((b) => t >= b.start && t < b.end) : -1;
  const pos = `${i}:${k}`;
  if (pos === scorePos) return;
  const prevSys = scorePos.split(':')[0];
  scorePos = pos;
  const box = $('score');
  box.querySelectorAll('.score-sys.current').forEach((el) => el.classList.remove('current'));
  box.querySelectorAll('.bar-now').forEach((el) => el.classList.remove('bar-now'));
  if (i < 0) return;
  const el = box.querySelector<HTMLElement>(`.score-sys[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('current');
  if (k >= 0) el.querySelectorAll(`.abcjs-m${k}`).forEach((n) => n.classList.add('bar-now'));
  const playing = usingYt() ? ytState === YT_STATE.PLAYING : !player.paused;
  if (playing && String(i) !== prevSys) box.scrollTop = el.offsetTop - box.offsetTop - box.clientHeight / 4;
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
let lastVoiceClass = '';

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
  // le verdict de l'instrument s'affiche directement dans la carte de l'accord
  $('pl-chord-box').hidden = true;
  $('pl-voice-box').hidden = practiceMode === 'instrument';
  $('lane-wrap').hidden = !practice || practiceMode === 'instrument';
  $('practice-live').classList.add('single');
  if (!practice || practiceMode === 'voice') clearCardVerdict();
}

$('practice-btn').addEventListener('click', async () => {
  const btn = $('practice-btn');
  if (practice) {
    practice.stop();
    practice = null;
    btn.textContent = '▶ Démarrer';
    btn.classList.remove('recording');
    $('mic-level-row').hidden = true;
    $('lane-wrap').hidden = true;
    clearCardVerdict();
    showReport();
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
    $('mic-level-row').hidden = false;
    lane.reset();
    session = new SessionRecorder();
    passages = buildPassages();
    renderPracticeMode();
    micSilentSince = performance.now();
    lastPitchAt = 0;
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

// ---- verdict de l'instrument dans la carte « Maintenant »
const lane = new PitchLane($<HTMLCanvasElement>('pitch-lane'));
let laneOctave = 0;
const recentNotes: number[][] = [];
let notesForIdx = -1;
let diagKey = '';

function showCardVerdict(v: string, played: string, text: string) {
  const card = $('now-playing');
  const mini = $('mini-now');
  for (const el of [card, mini]) {
    el.classList.remove('v-ok', 'v-close', 'v-wrong');
    if (v !== 'silent') el.classList.add(`v-${v}`);
  }
  $('np-played').hidden = false;
  $('np-played-chord').textContent = played;
  $('np-verdict').hidden = false;
  $('np-verdict').textContent = text;
}

function clearCardVerdict() {
  for (const el of [$('now-playing'), $('mini-now')]) el.classList.remove('v-ok', 'v-close', 'v-wrong');
  $('np-played').hidden = true;
  $('np-verdict').hidden = true;
  $('np-notes').hidden = true;
  if (diagKey) {
    diagKey = '';
    state.currentIdx = -1; // redessine le doigté normal
    updateNow();
  }
}

/** Colore le doigté selon les notes entendues et explique quelle corde ne sonne pas. */
function showStringDiagnosis(expected: Chord | null, v: string) {
  const sc = expected ? transposeChord(expected, -state.capo) : null;
  // notes de l'accord entendues dans la majorité des derniers blocs (la quinte doit ressortir nettement)
  const { heard, uncertain } = expected ? heardChordTones(recentNotes, expected) : { heard: new Set<number>(), uncertain: new Set<number>() };
  // au moins ~0,4 s de son sur cet accord avant de juger les cordes (doigté neutre en attendant)
  if (recentNotes.filter((x) => x.length).length < 3) {
    $('np-notes').hidden = true;
    if (diagKey && sc) {
      diagKey = '';
      $('now-diagram').innerHTML = chordDiagramSvg(chordName(sc, flats()), voicingsFor(sc)[0]);
    }
    return;
  }
  if (!sc || !heard.size) {
    $('np-notes').hidden = true;
    return;
  }
  const fl = flats();
  const voicing = voicingsFor(sc)[0];
  const d = diagnoseVoicing(voicing, state.capo, heard, uncertain);
  const played = voicing.filter((x) => x >= 0).length;
  // accord presque juste (une ou deux cordes muettes) : on montre lesquelles ; sinon c'est tout l'accord à revoir
  const mostlyRight = d.missing.length <= 2 && d.missing.length < played / 2;
  const key = `${chordName(sc)}|${d.status.join(',')}|${v}|${mostlyRight}`;
  if (key === diagKey) return;
  diagKey = key;
  $('now-diagram').innerHTML = chordDiagramSvg(chordName(sc, fl), voicing, mostlyRight ? d.status : undefined);
  // notes de l'accord : entendues ou manquantes
  const tones = mostlyRight ? QUALITY_INTERVALS[expected!.quality].map((iv) => (expected!.root + iv) % 12) : [];
  const chips = tones
    .map((pc) => {
      if (!heard.has(pc) && uncertain.has(pc))
        return `<span class="note-chip unsure" title="La quinte ne peut pas être vérifiée de façon fiable au micro">${noteName(pc, fl, true)}</span>`;
      const ok = heard.has(pc);
      return `<span class="note-chip ${ok ? 'ok' : 'missing'}">${ok ? '✓' : '!'} ${noteName(pc, fl, true)}${ok ? '' : ' manquant'}</span>`;
    })
    .join('');
  let tip = '';
  if (mostlyRight && d.missing.length) lastMutedString = `la corde de ${STRING_NAMES[d.missing[0].string]} sur ${chordName(sc, fl)}`;
  if (v !== 'ok' && !mostlyRight) tip = `Ce n’est pas le bon accord : placez les doigts comme sur le doigté de ${chordName(sc, fl)}.`;
  else if (d.missing.length) {
    const m = d.missing[0];
    const string = `la corde de ${STRING_NAMES[m.string]} (${6 - m.string}e)`;
    tip =
      m.fret === 0
        ? `${string[0].toUpperCase()}${string.slice(1)} ne sonne pas : elle doit sonner à vide. Un doigt la touche sans doute.`
        : `${string[0].toUpperCase()}${string.slice(1)}, case ${m.fret}${state.capo ? ' (à partir du capo)' : ''} : appuyez plus fort, juste derrière la frette.`;
  }
  $('np-notes').innerHTML = `<div class="chips">${chips}</div>${tip ? `<p class="np-tip">${escapeHtml(tip)}</p>` : ''}`;
  $('np-notes').hidden = false;
}
void OPEN_PCS;

let micSilentSince = 0;
let lastPitchAt = 0;
/** Garde la dernière note affichée un court instant (respirations, consonnes) au lieu de clignoter. */
const HOLD_MS = 700;

function onPracticeFrame(f: LiveFrame) {
  // niveau du micro : pour vérifier qu'il capte bien
  const now = performance.now();
  $('mic-level').style.width = `${Math.min(100, Math.sqrt(f.level / 0.1) * 100)}%`;
  if (f.level >= SILENCE_RMS) micSilentSince = now;
  $('mic-level-hint').textContent =
    now - micSilentSince > 3000
      ? 'Aucun son : vérifiez le micro choisi par le navigateur et son autorisation.'
      : f.level < SILENCE_RMS
        ? 'silence'
        : '';
  if (!state.analysis) return;
  const t = mediaTime() - MIC_LATENCY;
  const lateIdx = segmentAt(t, segs);
  // au moment d'un changement, le son du micro peut encore correspondre à l'accord d'avant :
  // on juge par rapport à l'accord affiché, sauf si l'accord d'avant colle mieux
  let idx = state.currentIdx >= 0 ? state.currentIdx : lateIdx;
  if (practiceMode !== 'voice' && lateIdx !== idx && lateIdx >= 0) {
    const rank = { ok: 3, close: 2, wrong: 1, silent: 0 } as const;
    const vs = (i: number) => rank[judgeChord(f.chord, soundingChord(segs[i].chord))];
    if (vs(lateIdx) > vs(idx)) idx = lateIdx;
  }
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
    // on affiche la forme à jouer (capo compris), comme dans la grille
    const shape = (c: Chord | null) =>
      c ? chordName(transposeChord(state.simple ? simplifyChord(c) : c, -state.capo), fl) : '—';
    const verdict =
      v === 'silent'
        ? f.level < SILENCE_RMS
          ? 'Jouez…'
          : 'Accord pas assez net'
        : v === 'ok'
          ? '✓ Juste'
          : v === 'close'
            ? `≈ Presque : ${shape(stable)} au lieu de ${shape(expected)}`
            : `✗ Faux : attendu ${shape(expected)}`;
    showCardVerdict(v, stable ? shape(stable) : '—', verdict);
    // nouvel accord attendu : l'historique du précédent ne compte plus
    if (idx !== notesForIdx) {
      recentNotes.length = 0;
      notesForIdx = idx;
    }
    recentNotes.push(f.level >= SILENCE_RMS ? f.chroma : []);
    if (recentNotes.length > 5) recentNotes.shift();
    // doigté et notes : seulement pour l'accord affiché
    lastMutedString = '';
    if (idx === state.currentIdx) showStringDiagnosis(expected, v);
    else $('np-notes').hidden = true;
    if (v !== 'silent' && idx >= 0)
      session?.recordChord(passageAt(t), v, {
        expected: shape(expected),
        late: v !== 'ok' && t - segs[idx].start < 0.6,
        mutedString: lastMutedString || undefined,
      });
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
      // pas de note sur ce bloc : on garde l'affichage précédent un instant
      if (now - lastPitchAt > HOLD_MS) {
        $('pl-note').textContent = '—';
        $('pl-voice-verdict').textContent = f.level < SILENCE_RMS ? 'Chantez…' : 'Note pas assez nette';
        $('tuner-needle').style.left = '50%';
      } else box.classList.add(lastVoiceClass);
    } else {
      lastPitchAt = now;
      const p = f.pitch;
      $('pl-note').textContent = `${midiName(p.midi).split(' ')[0]}`;
      $('tuner-needle').style.left = `${50 + p.cents}%`;
      const v = judgeVoice(p.midi, expectedMelody(t), expected, key);
      const tune = Math.abs(p.cents) <= 10 ? 'pile juste' : `${p.cents > 0 ? 'un peu haut' : 'un peu bas'} (${p.cents > 0 ? '+' : ''}${p.cents} cents)`;
      const fits = {
        melody: '✓ la note de la mélodie',
        chord: '✓ dans l’accord',
        scale: v.expected !== null ? `≈ dans la gamme (mélodie : ${noteName(v.expected, fl, true)})` : '≈ dans la gamme',
        outside: v.expected !== null ? `✗ hors de la tonalité (mélodie : ${noteName(v.expected, fl, true)})` : '✗ hors de la tonalité',
      }[v.fit];
      $('pl-voice-verdict').textContent = `${fits} · ${tune}`;
      const good = v.inTune && (v.fit === 'melody' || v.fit === 'chord');
      const mid = v.fit !== 'outside';
      // piste karaoké : la voix est ramenée dans l'octave de la note attendue
      const ni = lane.noteAt(t);
      const ref = ni >= 0 ? lane.notes[ni].midi : lane.points[lane.points.length - 1]?.midi ?? (state.voice.low + state.voice.high) / 2;
      const laneGood = ni >= 0 ? v.fit === 'melody' && v.inTune : good;
      lane.addPoint({ t, midi: foldToOctave(p.midi, ref), good: laneGood }, ni);
      session?.recordVoice(passageAt(t), laneGood, p.cents, v.inTune);
      lastVoiceClass = good ? 'ok' : mid ? 'close' : 'wrong';
      box.classList.add(lastVoiceClass);
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

/** Notes de la piste karaoké : mélodie dans la tonalité jouée, à l'octave de la voix. */
function rebuildLane() {
  const a = state.analysis;
  if (!a) {
    lane.notes = [];
    lane.chords = [];
    return;
  }
  const notes = melodyNotes(a, shift());
  laneOctave = displayOctave(notes, state.voice.low, state.voice.high);
  lane.notes = notes.map((n) => ({ ...n, midi: n.midi + laneOctave }));
  const fl = flats();
  lane.chords = segs.filter((g) => g.chord).map((g) => ({ start: g.start, name: chordName(shapeChord(g.chord), fl) }));
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

// ---------------------------------------------------------------- commandes de lecture
function isMediaPlaying(): boolean {
  return usingYt() ? ytState === YT_STATE.PLAYING || ytState === YT_STATE.BUFFERING : !player.paused;
}
function mediaDuration(): number {
  if (usingYt()) return yt?.getDuration() || state.analysis?.duration || 0;
  return Number.isFinite(player.duration) ? player.duration : state.analysis?.duration ?? 0;
}
function togglePlay() {
  if (!isMediaPlaying()) playIntentAt = performance.now();
  if (usingYt()) {
    if (isMediaPlaying()) yt!.pauseVideo();
    else yt!.playVideo();
  } else if (player.src) {
    if (player.paused) void player.play();
    else player.pause();
  }
}
function seekBy(d: number) {
  const t = Math.max(0, Math.min(mediaDuration() - 0.5, mediaTime() + d));
  if (usingYt()) yt!.seekTo(t, true);
  else player.currentTime = t;
}
$('tp-play').onclick = togglePlay;
$('tp-back').onclick = () => seekBy(-5);
$('tp-fwd').onclick = () => seekBy(5);
const seekBar = $<HTMLInputElement>('tp-seek');
let seeking = false;
seekBar.addEventListener('input', () => {
  seeking = true;
  $('tp-time').textContent = `${formatTime(+seekBar.value)} / ${formatTime(mediaDuration())}`;
});
seekBar.addEventListener('change', () => {
  seeking = false;
  const t = +seekBar.value;
  if (usingYt()) yt!.seekTo(t, true);
  else player.currentTime = t;
});
// raccourcis clavier (sauf quand on écrit dans un champ)
document.addEventListener('keydown', (e) => {
  if ($('workspace').hidden || (e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.code === 'ArrowLeft') seekBy(-5);
  else if (e.code === 'ArrowRight') seekBy(5);
});
function updateTransport() {
  const ready = !$('workspace').hidden && (state.source === 'youtube' ? !!yt : !!player.src);
  $('transport').hidden = !ready;
  $('transport-2').hidden = !ready;
  if (!ready) return;
  const playing = isMediaPlaying();
  const btn = $('tp-play');
  btn.textContent = playing ? '⏸' : '▶';
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
  const d = mediaDuration();
  seekBar.max = String(Math.max(1, d));
  if (!seeking) {
    seekBar.value = String(mediaTime());
    $('tp-time').textContent = `${formatTime(mediaTime())} / ${formatTime(d)}`;
  }
}

// ---------------------------------------------------------------- déverrouillage du son
// Safari (iPhone) n'autorise un son que s'il a déjà été lancé lors d'un geste de l'utilisateur :
// au premier geste sur la page, on lance le lecteur audio en silence, ce qui permet ensuite
// de démarrer le son automatiquement (par exemple quand une vidéo est refusée par YouTube).
const SILENT_WAV = URL.createObjectURL(encodeWav([new Float32Array(800)], 8000));
function unlockAudio() {
  if (player.getAttribute('src')) return;
  player.src = SILENT_WAV;
  player
    .play()
    .catch(() => {})
    .finally(() => {
      if (player.getAttribute('src') === SILENT_WAV) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    });
}
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
document.addEventListener('keydown', unlockAudio, { once: true, capture: true });

// ---------------------------------------------------------------- vitesse et boucle A–B
let rate = 1;
function setRate(r: number) {
  rate = r;
  applyRate();
  document.querySelectorAll<HTMLElement>('.sp').forEach((b) => b.classList.toggle('active', Number(b.dataset.rate) === r));
}
/** Ralentit sans changer la hauteur des notes (son du navigateur) ; YouTube a son propre réglage. */
function applyRate() {
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
  player.preservesPitch = true;
  yt?.setPlaybackRate?.(rate);
}
document.querySelectorAll<HTMLButtonElement>('.sp').forEach((b) => (b.onclick = () => setRate(Number(b.dataset.rate))));
// un nouveau son chargé repart à la vitesse normale : on réapplique la vitesse choisie
player.addEventListener('loadedmetadata', applyRate);

let loop: { a: number; b: number; count: number } | null = null;
let loopA: number | null = null;
function setLoop(a: number, b: number) {
  loop = { a, b, count: 0 };
  loopA = null;
  renderLoop();
}
function clearLoop() {
  loop = null;
  loopA = null;
  renderLoop();
}
$('tp-loop').onclick = () => {
  const t = mediaTime();
  if (loop) return clearLoop();
  if (loopA === null) {
    loopA = t;
    return renderLoop();
  }
  if (t > loopA + 0.5) {
    setLoop(loopA, t);
    mediaSeek(loopA);
  } else clearLoop();
};
function renderLoop() {
  const btn = $('tp-loop');
  btn.classList.toggle('on', !!loop || loopA !== null);
  btn.textContent = loop ? '⟳ Enlever la boucle' : loopA !== null ? '⟳ Fin de la boucle (B)' : '⟳ Boucle A–B';
  $('loop-info').textContent = loop
    ? `Boucle ${formatTime(loop.a)} → ${formatTime(loop.b)}${loop.count ? ` · ×${loop.count + 1}` : ''}`
    : loopA !== null
      ? `Début (A) à ${formatTime(loopA)} : cliquez à nouveau pour la fin (B)`
      : '';
  const d = mediaDuration();
  const region = $('loop-region');
  region.hidden = !loop && loopA === null;
  if (d && !region.hidden) {
    const a = loop?.a ?? loopA!;
    const b = loop?.b ?? Math.max(a, mediaTime());
    region.style.left = `${(a / d) * 100}%`;
    region.style.width = `${Math.max(0.5, ((b - a) / d) * 100)}%`;
  }
}
/** Revient au début de la boucle quand la fin est atteinte. */
function enforceLoop() {
  if (loopA !== null) renderLoop();
  if (!loop || !isMediaPlaying()) return;
  const t = mediaTime();
  if (t >= loop.b - 0.03 || t < loop.a - 1) {
    loop.count++;
    if (usingYt()) yt!.seekTo(loop.a, true);
    else player.currentTime = loop.a;
    renderLoop();
  }
}

// ---------------------------------------------------------------- bilan de séance
let session: SessionRecorder | null = null;
let passages: Passage[] = [];
let lastReport: { reports: PassageReport[]; html: string } | null = null;
let lastMutedString = '';

/** Passages du bilan : les lignes de paroles, sinon des groupes de 4 accords. */
function buildPassages(): Passage[] {
  const end = state.analysis?.duration ?? 0;
  if (sheet.length)
    return sheet.map((r, i) => ({
      start: Math.max(0, r.start),
      end: sheet[i + 1]?.start ?? end,
      label: r.instru ? '♪' : r.text,
      chords: r.chords.map((c) => c.name).join(' '),
    }));
  const fl = flats();
  const list = segs.filter((g) => g.chord);
  const out: Passage[] = [];
  for (let i = 0; i < list.length; i += 4) {
    const g = list.slice(i, i + 4);
    const stop = list[i + 4]?.start ?? end;
    out.push({ start: g[0].start, end: stop, label: `${formatTime(g[0].start)} – ${formatTime(stop)}`, chords: g.map((x) => chordName(shapeChord(x.chord), fl)).join(' ') });
  }
  return out;
}
function passageAt(t: number): number {
  for (let i = passages.length - 1; i >= 0; i--) if (passages[i].start <= t) return t < passages[i].end ? i : -1;
  return -1;
}
const songKey = () => currentSongId ?? (state.file ? `file:${state.file.name}` : '');

function showReport() {
  if (!session || session.empty) return;
  const reports = session.report(passages);
  const totals = session.totals();
  const key = songKey();
  const history = key ? sessionHistory(key) : [];
  const previous = history[history.length - 1];
  const minutes = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  if (key && (totals.chords !== null || totals.voice !== null)) saveSession(key, { date: new Date().toISOString(), ...totals, minutes });
  const all = key ? sessionHistory(key) : [];
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)} %`);
  const col = (x: number | null) => (x === null ? 'var(--muted)' : x >= 0.8 ? 'var(--voice)' : x >= 0.6 ? '#d9a04a' : '#e0604c');
  const delta = (now: number | null, before: number | null | undefined) =>
    now === null || before == null ? '' : now - before >= 1 ? `<span class="up">▲ +${now - before} points</span>` : now - before <= -1 ? `<span class="down">▼ ${now - before} points</span>` : '<span>= comme la dernière fois</span>';
  const kpi = (label: string, v: number | null, before: number | null | undefined) =>
    `<div class="kpi"><span class="kpi-label">${label}</span><strong>${v === null ? '—' : `${v} %`}</strong>${delta(v, before)}</div>`;
  const series = all.map((x) => x.chords ?? x.voice ?? 0).slice(-6);
  const max = Math.max(100, ...series);
  const chart = series.length > 1
    ? `<div class="kpi"><span class="kpi-label">Progression · ${series.length} séances</span><div class="mini-chart">${series
        .map((v, i) => `<div><small>${v}</small><span style="height:${Math.round((v / max) * 48)}px" class="${i === series.length - 1 ? 'cur' : ''}"></span></div>`)
        .join('')}</div></div>`
    : `<div class="kpi"><span class="kpi-label">Durée</span><strong>${minutes} min</strong><span>première séance sur ce morceau</span></div>`;
  const rows = reports
    .map(
      (r) => `<li class="rp ${r.weak ? 'weak' : ''}">
        <span class="rp-bar" style="background:${col(Math.min(r.chordScore ?? 1, r.voiceScore ?? 1))}"></span>
        <span class="rp-time">${formatTime(r.start)}</span>
        <div class="rp-text"><span class="rp-chords">${escapeHtml(r.chords)}</span><span>${escapeHtml(r.label)}</span></div>
        <span class="rp-score">Accords <strong style="color:${col(r.chordScore)}">${pct(r.chordScore)}</strong></span>
        <span class="rp-score">Voix <strong style="color:${col(r.voiceScore)}">${pct(r.voiceScore)}</strong></span>
        <span class="rp-tip">${escapeHtml(r.tip)}</span>
        <button class="btn small-btn ${r.weak ? 'primary' : ''}" data-loop="${r.index}">⟳ En boucle</button>
      </li>`,
    )
    .join('');
  const weak = reports.find((r) => r.weak);
  const html = `<p class="rp-headline">${escapeHtml(headline(reports, totals, previous))}</p>
    <div class="kpis">${kpi('Accords justes', totals.chords, previous?.chords)}${kpi('Voix juste', totals.voice, previous?.voice)}${chart}</div>
    ${weak ? `<button class="btn primary" id="rp-practice">⟳ Travailler le premier passage difficile à 75 %</button>` : ''}
    <ul class="rp-list">${rows || '<li class="hint">Aucun passage assez long pour être évalué.</li>'}</ul>`;
  lastReport = { reports, html };
  $('open-report').hidden = false;
  openReport();
}

function openReport() {
  if (!lastReport) return;
  $('report').innerHTML = lastReport.html;
  const loopOn = (i: number, slow: boolean) => {
    const p = passages[i];
    if (!p) return;
    $<HTMLDialogElement>('report-dialog').close();
    setLoop(p.start, p.end);
    if (slow) setRate(0.75);
    mediaSeek(p.start);
    toast(`⟳ Boucle ${formatTime(p.start)} → ${formatTime(p.end)}${slow ? ' à 75 %' : ''}`, slow ? undefined : { label: 'Ralentir à 75 %', run: () => setRate(0.75) });
  };
  $('report').querySelectorAll<HTMLButtonElement>('[data-loop]').forEach((b) => (b.onclick = () => loopOn(Number(b.dataset.loop), false)));
  const first = lastReport.reports.find((r) => r.weak);
  const btn = document.querySelector<HTMLButtonElement>('#rp-practice');
  if (btn && first) btn.onclick = () => loopOn(first.index, true);
  $<HTMLDialogElement>('report-dialog').showModal();
}
$('open-report').onclick = openReport;
$<HTMLDialogElement>('report-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $<HTMLDialogElement>('report-dialog').close();
});

// ---------------------------------------------------------------- barre fixe sur téléphone
let nowVisible = true;
new IntersectionObserver((entries) => {
  nowVisible = entries[0].isIntersecting;
  updateMiniNow();
}).observe($('now-playing'));
function updateMiniNow() {
  const show = (!nowVisible || layout.isCollapsed('now')) && !$('workspace').hidden && !!state.analysis;
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

// ---------------------------------------------------------------- disposition des cartes
const layout = new Layout($('workspace'), {
  // déplacer le lecteur YouTube dans la page le recharge : on le recrée et on reprend au même endroit
  onMove: (id: PanelId) => {
    if (id === 'video') void remountYouTube();
  },
  onChange: () => updateMiniNow(),
});

async function remountYouTube() {
  if (!yt || state.source !== 'youtube' || !currentSongId) return;
  const id = currentSongId;
  const t = yt.getCurrentTime();
  const playing = ytState === YT_STATE.PLAYING && usingYt();
  const muted = followingAudio();
  try {
    yt.destroy();
  } catch {
    /* le lecteur a déjà été rechargé par le navigateur */
  }
  yt = await createPlayer($('yt-player'), id, onYtState, onYtError);
  if (currentSongId !== id) return;
  applyRate();
  if (muted) yt.mute();
  if (t > 0.5) yt.seekTo(t, true);
  if (playing) yt.playVideo();
  else if (t > 0.5) yt.pauseVideo();
}

/** Résumé affiché dans la barre de titre d'une carte réduite. */
let summaryAt = 0;
function updateSummaries() {
  if (performance.now() - summaryAt < 250) return;
  summaryAt = performance.now();
  const set = (id: PanelId, text: string) => {
    const el = document.querySelector<HTMLElement>(`[data-summary="${id}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  };
  const a = state.analysis;
  set('video', a || state.buffer ? `${$('song-title').textContent} · ${formatTime(mediaTime())}` : '');
  set('now', a ? `${$('now-chord').textContent} → ${$('next-chord').textContent}` : '');
  set('settings', a ? `${state.mode === 'voice' ? `Ma tonalité ${state.semitones > 0 ? '+' : ''}${state.semitones}` : 'Original'} · ${state.capo ? `capo ${state.capo}` : 'sans capo'}` : '');
  set('sheet', document.querySelector('.sheet .tab.active')?.textContent?.trim() ?? '');
  set('micro', practice ? `en cours · ${$('pl-score').textContent?.trim() || 'écoute…'}` : 'arrêté');
}

/** Boucle d'affichage : une erreur ponctuelle ne doit jamais la stopper (l'écran se figerait). */
function tick() {
  try {
    tickOnce();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(tick);
}

function tickOnce() {
  enforceLoop();
  updateSummaries();
  if (practice && practiceMode !== 'instrument' && !$('lane-wrap').hidden) {
    lane.draw(mediaTime());
    $('lane-lyric').textContent = lyricLine >= 0 ? sheet[lyricLine]?.text ?? '' : '';
  }
  updateTransport();
  updateNow();
  updateGauge();
  tickMini();
  updateLyrics();
  updateScore();
  if (followingAudio() && !player.paused && performance.now() - ytCommandAt > 1500) {
    const drift = yt!.getCurrentTime() - player.currentTime;
    if (Math.abs(drift) > 0.5) commandYt((p) => p.seekTo(player.currentTime, true));
  }
}
requestAnimationFrame(tick);

render();
refreshCatalogue();
onStoredChange(() => renderCatalogue());
void loadStoredIds();
$('app-version').textContent = __APP_VERSION__;
// apps Android / iOS (Tauri) : audio récupéré depuis le téléphone, réglages d'interface
if ('__TAURI_INTERNALS__' in window) void import('./native/mobile').then((m) => m.initMobile()).catch((e) => console.warn('mobile :', e));
const initial = new URLSearchParams(location.search).get('v');
if (initial && parseYouTubeId(initial)) {
  $<HTMLInputElement>('yt-url').value = `https://www.youtube.com/watch?v=${initial}`;
  void loadYouTube(initial);
}

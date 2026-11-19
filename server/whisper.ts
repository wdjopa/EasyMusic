// Transcription des paroles par IA (Whisper, via whisper.cpp), en local : rien n'est envoyé ailleurs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LyricLine } from '../src/shared/lyrics';
import { config } from './config';
import { run } from './youtube';

interface WhisperSetup {
  cli: string;
  /** Options reconnues par la version installée (elles varient selon les versions de whisper.cpp). */
  flags: Set<string>;
}
let setup: WhisperSetup | null = null;
let reason = '';
let checkedAt = 0;

/** Pourquoi Whisper n'est pas disponible (vide s'il l'est). */
export function whisperReason(): string {
  whisperAvailable();
  return reason;
}

/**
 * Vrai si whisper.cpp et un modèle sont installés. Revérifié toutes les 30 s tant que ce n'est pas le cas :
 * inutile de redémarrer le serveur après « npm run whisper:setup ».
 */
export function whisperAvailable(): boolean {
  if (setup) return true;
  if (Date.now() - checkedAt < 30_000) return false;
  checkedAt = Date.now();
  if (!existsSync(config.whisperModel)) {
    return fail(`modèle introuvable (${config.whisperModel}) : lancez « npm run whisper:setup »`);
  }
  // selon les versions, Homebrew installe « whisper-cli » ou « whisper-cpp »
  const candidates = process.env.WHISPER_CLI ? [config.whisperCli] : [config.whisperCli, 'whisper-cpp', 'whisper'];
  for (const cli of candidates) {
    try {
      const r = spawnSync(cli, ['--help'], { encoding: 'utf8' });
      const help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.error || !/usage/i.test(help)) continue;
      const flags = new Set([...help.matchAll(/(?:^|\s)(-[a-z]+)[ ,]/gm)].map((m) => m[1]));
      setup = { cli, flags };
      reason = '';
      console.log(`✓ Whisper disponible : ${cli} · modèle ${config.whisperModel}`);
      return true;
    } catch {
      /* candidat suivant */
    }
  }
  return fail('programme whisper.cpp introuvable (« brew install whisper-cpp », ou WHISPER_CLI=chemin)');
}

function fail(why: string): false {
  if (why !== reason) console.warn(`✗ Paroles par IA (Whisper) inactives : ${why}`);
  reason = why;
  return false;
}

interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
  /** Avec -ojf : les jetons, dont l'horodatage précis t_dtw (en centièmes de seconde). */
  tokens?: { text: string; t_dtw?: number }[];
}

/** Début réel d'une ligne : le premier mot horodaté par DTW (bien plus précis que le début du segment). */
export function segmentStart(s: WhisperSegment): number {
  const first = s.tokens?.find((t) => !t.text.startsWith('[_') && /\p{L}/u.test(t.text) && (t.t_dtw ?? -1) >= 0);
  return first ? first.t_dtw! / 100 : s.offsets.from / 1000;
}

/** Réglage DTW de whisper.cpp correspondant au modèle (ex. ggml-large-v3-turbo-q5_0.bin -> large.v3.turbo). */
export function dtwPreset(modelPath: string): string {
  const name = modelPath.split(/[\\/]/).pop()!.replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q\d.*$/, '');
  return name.replace(/-/g, '.');
}

/** Phrases que Whisper « invente » souvent sur la musique ou le silence. */
const HALLUCINATIONS = [
  /merci d'avoir regard/i,
  /thanks? for watching/i,
  /sous-titr/i,
  /subtitles? by/i,
  /abonnez-vous/i,
  /subscribe/i,
  /amara\.org/i,
  /^\W*(musique|music|applause|applaudissements|rires|laughter)\W*$/i,
];

/** Nettoie la sortie de Whisper pour en faire des lignes de paroles. */
export function cleanTranscript(segments: WhisperSegment[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const s of segments) {
    const text = s.text
      .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, '') // [Musique], (rires), *applaudissements*
      .replace(/[♪♫🎵🎶]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/\p{L}/u.test(text)) continue;
    if (HALLUCINATIONS.some((h) => h.test(text))) continue;
    out.push({ time: segmentStart(s), text });
  }
  // Whisper peut boucler sur une même phrase : au-delà de 2 répétitions consécutives, on coupe
  const dedup: LyricLine[] = [];
  let repeat = 0;
  for (const l of out) {
    const prev = dedup[dedup.length - 1];
    repeat = prev && prev.text.toLowerCase() === l.text.toLowerCase() ? repeat + 1 : 0;
    if (repeat < 2) dedup.push(l);
  }
  return dedup;
}

/** Transcrit un fichier audio ; `onProgress` reçoit une fraction entre 0 et 1. */
export async function transcribe(audioFile: string, onProgress: (f: number) => void = () => {}): Promise<LyricLine[]> {
  if (!whisperAvailable()) throw new Error(`Whisper n’est pas installé : ${reason}`);
  const dir = await mkdtemp(join(tmpdir(), 'easymusic-whisper-'));
  try {
    const wav = join(dir, 'voix.wav');
    // Whisper attend du 16 kHz mono
    await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', audioFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const base = join(dir, 'paroles');
    await new Promise<void>((resolve, reject) => {
      const has = (f: string) => setup!.flags.has(f);
      const args = [
        '-m', config.whisperModel,
        '-f', wav,
        '-l', config.whisperLanguage,
        '-t', String(config.whisperThreads),
        '-ml', '60', '-sow', // lignes courtes, coupées entre deux mots
        // options récentes : utilisées seulement si la version installée les connaît
        ...(has('-sns') ? ['-sns'] : []), // ignore les sons non vocaux (musique, bruits)
        // horodatage précis mot par mot (DTW) : sur la musique, le début des segments est souvent faux
        ...(has('-dtw') ? ['-dtw', config.whisperDtw ?? dtwPreset(config.whisperModel)] : []),
        ...(has('-dtw') && has('-nfa') ? ['-nfa'] : []),
        has('-ojf') ? '-ojf' : '-oj', '-of', base,
        '-pp',
      ];
      const p = spawn(setup!.cli, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        const t = d.toString();
        err += t;
        const m = [...t.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
        if (m) onProgress(Number(m[1]) / 100);
      });
      p.on('error', (e) => reject(new Error(`Whisper introuvable (${config.whisperCli}) : ${e.message}`)));
      p.on('close', (code) => {
        if (code === 0) return resolve();
        // le détail complet va dans le terminal du serveur, pour le diagnostic
        console.warn(`✗ Whisper a échoué (code ${code}) :\n${err.trim().split('\n').slice(-15).join('\n')}`);
        reject(new Error(`Whisper a échoué : ${err.trim().split('\n').filter((l) => /error|failed|invalid|unknown/i.test(l)).pop() ?? `code ${code}`}`));
      });
    });
    const json = JSON.parse(await readFile(`${base}.json`, 'utf8')) as { transcription: WhisperSegment[] };
    return cleanTranscript(json.transcription ?? []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Séparation voix / instruments avec Demucs (modèle libre de Meta, « htdemucs »), sur le processeur.
// Une chanson de 4 min prend environ 1 à 2 min sur 4 cœurs et 2 à 3 Go de mémoire.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config';
import { run } from './youtube';

let available: { ok: boolean; why: string; at: number } | null = null;
let checking = false;

/** Vérifie en arrière-plan (sans bloquer le serveur : importer torch prend quelques secondes). */
function check() {
  if (checking) return;
  checking = true;
  const p = spawn(config.demucsPython, ['-c', 'import demucs, torch'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
  const done = (ok: boolean, why: string) => {
    const changed = available?.ok !== ok;
    available = { ok, why, at: Date.now() };
    checking = false;
    if (changed) console.log(ok ? '✓ Séparation voix / instruments (Demucs) disponible' : `✗ Séparation voix / instruments inactive : ${why}`);
  };
  p.on('error', (e) => done(false, e.message));
  p.on('close', (code) => done(code === 0, err.trim().split('\n').pop() || 'demucs introuvable'));
}

/** Demucs installé ? (réponse immédiate ; revérifié en arrière-plan toutes les 5 min) */
export function separationAvailable(): boolean {
  if (!available || Date.now() - available.at > 300_000) check();
  return available?.ok ?? false;
}

export interface Stems {
  dir: string;
  vocals: string; // fichiers compressés (mp3/m4a) prêts à servir
  instrumental: string;
  vocalsWav: string; // pour l'analyse
  instrumentalWav: string;
}

/** Sépare `file` ; le dossier renvoyé est à supprimer par l'appelant. */
export async function separate(file: string, onProgress: (f: number) => void, ext: 'mp3' | 'm4a'): Promise<Stems> {
  const dir = await mkdtemp(join(tmpdir(), 'easymusic-separation-'));
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        config.demucsPython,
        ['-m', 'demucs', '--two-stems=vocals', '-n', config.demucsModel, '-j', '1', '-o', dir, '--filename', '{stem}.{ext}', file],
        { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, OMP_NUM_THREADS: String(config.demucsThreads) } },
      );
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        err = (err + s).slice(-4000);
        // barre de progression : « 45%|████ »
        const m = [...s.matchAll(/(\d{1,3})%\|/g)].pop();
        if (m) onProgress(Math.min(1, Number(m[1]) / 100));
      });
      p.on('error', (e) => reject(new Error(`Demucs ne démarre pas : ${e.message}`)));
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(/memory|Killed/i.test(err) ? 'Mémoire insuffisante pour séparer ce morceau.' : `Séparation impossible : ${err.trim().split('\n').pop() ?? code}`)),
      );
    });
    const modelDir = join(dir, config.demucsModel);
    const files = await readdir(modelDir);
    const vocalsWav = join(modelDir, files.find((f) => f.startsWith('vocals'))!);
    const instrumentalWav = join(modelDir, files.find((f) => f.startsWith('no_vocals'))!);
    // versions compressées pour l'appareil (la séparation produit du WAV : ~40 Mo par piste)
    const enc = (src: string, dst: string) =>
      run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', src, ...(ext === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '160k']), dst]);
    const vocals = join(dir, `voix.${ext}`);
    const instrumental = join(dir, `instruments.${ext}`);
    await Promise.all([enc(vocalsWav, vocals), enc(instrumentalWav, instrumental)]);
    return { dir, vocals, instrumental, vocalsWav, instrumentalWav };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

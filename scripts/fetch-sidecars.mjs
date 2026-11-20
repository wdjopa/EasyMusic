#!/usr/bin/env node
// Télécharge les programmes embarqués dans l'app ordinateur (« sidecars » Tauri) :
//  - yt-dlp : binaire officiel des releases GitHub de yt-dlp (contient déjà les scripts EJS) ;
//  - Deno : runtime JavaScript exigé par yt-dlp pour YouTube (le seul activé par défaut, cf. wiki EJS).
// Ils ne sont jamais commités : ce script les place dans src-tauri/binaries/<nom>-<triplet cible>[.exe],
// le nommage attendu par Tauri (bundle.externalBin). Les sommes SHA-256 publiées sont vérifiées.
//
// Usage : node scripts/fetch-sidecars.mjs [--target <triplet>] [--force]
//   triplet par défaut : celui de rustc (machine actuelle). « universal-apple-darwin » pour un Mac universel.
//   versions : YTDLP_VERSION=2026.10.26 DENO_VERSION=v2.5.6 (par défaut : la dernière publiée).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src-tauri', 'binaries');

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const ti = argv.indexOf('--target');
const target =
  (ti >= 0 && argv[ti + 1]) ||
  process.env.TAURI_TARGET_TRIPLE ||
  execFileSync('rustc', ['-vV']).toString().match(/^host:\s*(\S+)/m)?.[1];
if (!target) throw new Error('Triplet cible inconnu : précisez --target.');

const YTDLP_ASSETS = {
  'x86_64-unknown-linux-gnu': 'yt-dlp_linux',
  'aarch64-unknown-linux-gnu': 'yt-dlp_linux_aarch64',
  'x86_64-apple-darwin': 'yt-dlp_macos',
  'aarch64-apple-darwin': 'yt-dlp_macos',
  'universal-apple-darwin': 'yt-dlp_macos', // déjà universel
  'x86_64-pc-windows-msvc': 'yt-dlp.exe',
  'aarch64-pc-windows-msvc': 'yt-dlp_arm64.exe',
};
const DENO_TRIPLES = {
  'x86_64-unknown-linux-gnu': ['x86_64-unknown-linux-gnu'],
  'aarch64-unknown-linux-gnu': ['aarch64-unknown-linux-gnu'],
  'x86_64-apple-darwin': ['x86_64-apple-darwin'],
  'aarch64-apple-darwin': ['aarch64-apple-darwin'],
  'universal-apple-darwin': ['x86_64-apple-darwin', 'aarch64-apple-darwin'], // assemblés avec lipo
  'x86_64-pc-windows-msvc': ['x86_64-pc-windows-msvc'],
  'aarch64-pc-windows-msvc': ['x86_64-pc-windows-msvc'], // émulé (pas de Deno ARM64 Windows officiel)
};
if (!YTDLP_ASSETS[target]) throw new Error(`Cible non prise en charge : ${target}`);

const exe = target.includes('windows') ? '.exe' : '';
const ytRelease = process.env.YTDLP_VERSION
  ? `https://github.com/yt-dlp/yt-dlp/releases/download/${process.env.YTDLP_VERSION}`
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const denoRelease = process.env.DENO_VERSION
  ? `https://github.com/denoland/deno/releases/download/${process.env.DENO_VERSION}`
  : 'https://github.com/denoland/deno/releases/latest/download';

async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 4) throw new Error(`Téléchargement impossible : ${url} (${e.message})`);
      await new Promise((ok) => setTimeout(ok, 2000 * attempt));
    }
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
function check(buf, expected, name) {
  if (!expected) throw new Error(`Somme SHA-256 introuvable pour ${name}`);
  if (sha256(buf) !== expected.toLowerCase()) throw new Error(`Somme SHA-256 incorrecte pour ${name} : fichier corrompu ?`);
}

function writeExe(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, buf);
  chmodSync(`${path}.tmp`, 0o755);
  renameSync(`${path}.tmp`, path);
}

function unzip(zip, dir) {
  try {
    execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  } catch {
    execFileSync('tar', ['-xf', zip, '-C', dir]); // bsdtar (macOS, Windows 10+) lit les .zip
  }
}

async function fetchYtDlp() {
  const dest = join(outDir, `yt-dlp-${target}${exe}`);
  if (existsSync(dest) && !force) return console.log(`✓ ${dest} (déjà présent)`);
  const asset = YTDLP_ASSETS[target];
  const sums = (await download(`${ytRelease}/SHA2-256SUMS`)).toString();
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === asset)?.[0];
  const bin = await download(`${ytRelease}/${asset}`);
  check(bin, expected, asset);
  writeExe(dest, bin);
  console.log(`✓ yt-dlp (${asset}) -> ${dest}`);
}

async function fetchDeno() {
  const dest = join(outDir, `deno-${target}${exe}`);
  if (existsSync(dest) && !force) return console.log(`✓ ${dest} (déjà présent)`);
  const work = mkdtempSync(join(tmpdir(), 'enjoysing-deno-'));
  try {
    const parts = [];
    for (const triple of DENO_TRIPLES[target]) {
      const name = `deno-${triple}.zip`;
      const [zip, sum] = await Promise.all([download(`${denoRelease}/${name}`), download(`${denoRelease}/${name}.sha256sum`)]);
      check(zip, sum.toString().trim().split(/\s+/)[0], name);
      const dir = join(work, triple);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), zip);
      unzip(join(dir, name), dir);
      parts.push(join(dir, `deno${triple.includes('windows') ? '.exe' : ''}`));
    }
    if (parts.length > 1) {
      const fat = join(work, 'deno-universal');
      execFileSync('lipo', ['-create', '-output', fat, ...parts]);
      parts.splice(0, parts.length, fat);
    }
    writeExe(dest, readFileSync(parts[0]));
    console.log(`✓ Deno -> ${dest}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`Programmes embarqués pour ${target}…`);
await fetchYtDlp();
await fetchDeno();

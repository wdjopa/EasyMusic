#!/usr/bin/env node
// Télécharge les programmes embarqués dans l'app ordinateur (« sidecars » Tauri) :
//  - yt-dlp : binaire officiel des releases GitHub de yt-dlp (contient déjà les scripts EJS) ;
//  - Deno : runtime JavaScript exigé par yt-dlp pour YouTube (le seul activé par défaut, cf. wiki EJS).
// Ils ne sont jamais commités : ce script les place dans src-tauri/binaries/enjoysing-<nom>-<triplet cible>[.exe],
// le nommage attendu par Tauri (bundle.externalBin). Préfixe « enjoysing- » : le paquet .deb les installe
// dans /usr/bin, où un « yt-dlp » ou un « deno » du système existe peut-être déjà.
// Les sommes SHA-256 publiées sont vérifiées.
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
  const dest = join(outDir, `enjoysing-yt-dlp-${target}${exe}`);
  if (existsSync(dest) && !force) return console.log(`✓ ${dest} (déjà présent)`);
  const asset = YTDLP_ASSETS[target];
  const sums = (await download(`${ytRelease}/SHA2-256SUMS`)).toString();
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, f]) => f === asset)?.[0];
  const bin = await download(`${ytRelease}/${asset}`);
  check(bin, expected, asset);
  writeExe(dest, bin);
  // Mac universel : le binaire yt-dlp_macos l'est déjà ; une copie par architecture pour Tauri
  if (target === 'universal-apple-darwin')
    for (const t of ['aarch64-apple-darwin', 'x86_64-apple-darwin']) writeExe(join(outDir, `enjoysing-yt-dlp-${t}`), bin);
  console.log(`✓ yt-dlp (${asset}) -> ${dest}`);
}

async function fetchDeno() {
  const dest = join(outDir, `enjoysing-deno-${target}${exe}`);
  if (existsSync(dest) && !force) return console.log(`✓ ${dest} (déjà présent)`);
  const work = mkdtempSync(join(tmpdir(), 'enjoysing-deno-'));
  try {
    const parts = [];
    for (const triple of DENO_TRIPLES[target]) {
      const name = `deno-${triple}.zip`;
      const [zip, sum] = await Promise.all([download(`${denoRelease}/${name}`), download(`${denoRelease}/${name}.sha256sum`)]);
      // format « somme  fichier » (Linux, macOS) ou tableau PowerShell (Windows) : on prend l'empreinte hexadécimale
      check(zip, sum.toString().match(/\b[0-9a-fA-F]{64}\b/)?.[0], name);
      const dir = join(work, triple);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), zip);
      unzip(join(dir, name), dir);
      parts.push(join(dir, `deno${triple.includes('windows') ? '.exe' : ''}`));
    }
    if (parts.length > 1) {
      // Mac universel : Tauri compile chaque architecture séparément et veut aussi une copie par architecture
      DENO_TRIPLES[target].forEach((triple, i) => writeExe(join(outDir, `enjoysing-deno-${triple}`), readFileSync(parts[i])));
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

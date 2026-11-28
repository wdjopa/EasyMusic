// Génère le site de présentation statique (Vercel) dans landing/dist :
//   dist/index.html (anglais, par défaut), dist/fr/index.html (français), style, script, images.
// Usage : node landing/build.mjs   (ou, dans landing/ : node build.mjs)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JS_KEYS, LANGS } from './i18n.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

// Réglages (modifiables par variables d'environnement Vercel)
const config = {
  /** Adresse du site de présentation (balises canonical, aperçus de partage). */
  siteUrl: (process.env.SITE_URL ?? 'https://enjoysing.vercel.app').replace(/\/$/, ''),
  /** L'app web. */
  appUrl: (process.env.APP_URL ?? 'https://enjoysing.resub.me').replace(/\/$/, ''),
  /** Dépôt GitHub dont les « releases » contiennent les fichiers à installer. */
  repo: process.env.GITHUB_REPO ?? 'wdjopa/EasyMusic',
  /** Lien d'invitation TestFlight (iPhone), vide tant que l'app iOS n'est pas en test. */
  testflight: process.env.TESTFLIGHT_URL ?? '',
};

// Icônes des appareils (SVG inline, couleur du texte) : {{icon:android}} dans template.html
const icon = (name) =>
  readFileSync(join(here, 'icons', `${name}.svg`), 'utf8')
    .trim()
    .replace(/<title>.*?<\/title>/, '')
    .replace(' role="img"', '')
    .replace('<svg ', '<svg class="icon" aria-hidden="true" focusable="false" ' + (name === 'web' ? '' : 'fill="currentColor" '));
const template = readFileSync(join(here, 'template.html'), 'utf8').replace(/\{\{icon:(\w+)\}\}/g, (_, n) => icon(n));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });

// Clavier de piano (3 octaves) et formes d'onde, en SVG
function piano() {
  const W = 21;
  let white = '', black = '';
  for (let i = 0; i < W; i++) white += `<rect x="${i * 10 + 0.5}" y="0" width="9" height="52" rx="1.5" fill="#efe8dc"/>`;
  for (let i = 0; i < W - 1; i++) if ([0, 1, 3, 4, 5].includes(i % 7)) black += `<rect x="${i * 10 + 6.5}" y="0" width="7" height="31" rx="1.2" fill="#141210"/>`;
  return `<svg viewBox="0 0 ${W * 10} 52" preserveAspectRatio="none">${white}${black}</svg>`;
}
function wave(seed, quiet = false) {
  let x = seed, bars = '';
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  const grad = '<defs><linearGradient id="wavegrad" x1="0" x2="1"><stop offset="0" stop-color="#f08048"/><stop offset="1" stop-color="#e3507a"/></linearGradient></defs>';
  for (let i = 0; i < 90; i++) {
    const env = 0.35 + 0.65 * Math.abs(Math.sin(i / 9));
    const h = Math.max(2, (quiet ? 0.35 : 1) * 60 * env * (0.35 + 0.65 * rnd()));
    bars += `<rect x="${i * 4}" y="${32 - h / 2}" width="2.4" height="${h}" rx="1.2"/>`;
  }
  return `<svg viewBox="0 0 360 64" preserveAspectRatio="none">${quiet ? '' : grad}${bars}</svg>`;
}

for (const [code, t] of Object.entries(LANGS)) {
  const vars = {
    ...t,
    ...config,
    appHost: new URL(config.appUrl).host,
    piano: piano(),
    waveBand: wave(7),
    waveVoice: wave(42, true),
    otherLangCode: code === 'en' ? 'fr' : 'en',
    config: JSON.stringify({
      lang: code,
      repo: config.repo,
      testflight: config.testflight,
      t: Object.fromEntries(JS_KEYS.map((k) => [k, t[k]])),
    }).replace(/</g, '\\u003c'),
  };
  const html = template.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`Texte manquant « ${k} » (${code})`);
    return String(vars[k]);
  });
  const dir = t.path === '/' ? out : join(out, t.path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log(`${code} → ${join(dir, 'index.html')}`);
}

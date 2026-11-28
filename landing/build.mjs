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

const template = readFileSync(join(here, 'template.html'), 'utf8');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'static'), out, { recursive: true });

for (const [code, t] of Object.entries(LANGS)) {
  const vars = {
    ...t,
    ...config,
    appHost: new URL(config.appUrl).host,
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

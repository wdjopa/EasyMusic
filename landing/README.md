# Site de présentation EnjoySing (Vercel)

Page statique, **anglais par défaut** (`/`) et **français** (`/fr/`) : présentation, fonctionnalités,
problèmes résolus, questions fréquentes et **liens de téléchargement** de toutes les apps.

Les liens de téléchargement sont trouvés au chargement de la page dans la **dernière release publiée** du
dépôt GitHub (APK Android, installeurs Windows/macOS/Linux). Rien à modifier sur le site à chaque version :
il suffit de publier la release.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `i18n.mjs` | tous les textes, en anglais et en français |
| `template.html` | la page (commune aux deux langues) |
| `static/` | style, script des téléchargements, icônes, image de partage |
| `build.mjs` | génère `dist/index.html` et `dist/fr/index.html` |

Aperçu en local : `node landing/build.mjs && npx serve landing/dist` (ou `python3 -m http.server -d landing/dist`).

## Mettre en ligne sur Vercel

1. Vercel › **Add New › Project** › importer le dépôt GitHub `wdjopa/EasyMusic`.
2. **Root Directory** : `landing`. Framework : *Other*. Le reste vient de `vercel.json`
   (commande `node build.mjs`, dossier `dist`).
3. Variables d'environnement (facultatives) :

   | Variable | Défaut | Rôle |
   | --- | --- | --- |
   | `SITE_URL` | `https://enjoysing.vercel.app` | adresse finale du site (liens canoniques, aperçus de partage) |
   | `APP_URL` | `https://enjoysing.resub.me` | l'app web |
   | `GITHUB_REPO` | `wdjopa/EasyMusic` | dépôt dont on lit les releases |
   | `TESTFLIGHT_URL` | — | lien d'invitation TestFlight, quand l'app iPhone sera en test |

4. **Deploy**. Chaque envoi sur la branche de production redéploie le site.
5. Domaine : Vercel › Settings › **Domains** (ex. `enjoysing.app`, ou `www.enjoysing.resub.me` avec un
   enregistrement CNAME vers `cname.vercel-dns.com`). Mettre alors `SITE_URL` à jour.

## Publier une version (pour que les boutons de téléchargement marchent)

1. Mettre la même version dans `src-tauri/tauri.conf.json` et `package.json` (ex. `0.2.0`).
2. Pousser l'étiquette : `git tag v0.2.0 && git push origin v0.2.0`.
3. Les CI « App ordinateur » et « Apps mobiles » ajoutent les installeurs et `EnjoySing-android.apk` à un
   **brouillon** de release `v0.2.0`.
4. Sur GitHub › Releases, relire le brouillon puis **Publish release** : le site affiche aussitôt les liens.

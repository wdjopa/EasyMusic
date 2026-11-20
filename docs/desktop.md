# App ordinateur (Tauri v2) : Windows, macOS, Linux

L'app ordinateur reprend **toute l'app web** (le même build Vite) dans une fenêtre native. Elle ajoute une chose
que le site ne peut pas faire : **télécharger l'audio YouTube depuis l'ordinateur de l'utilisateur**, avec son
adresse IP de particulier. YouTube bloque le serveur (« Sign in to confirm you're not a bot »), mais rarement un
particulier.

## Fonctionnement

```
src-tauri/                  app Tauri v2 (Rust)
  tauri.conf.json           réglages communs (aussi utilisés par les apps mobiles)
  tauri.{linux,macos,windows}.conf.json
                            programmes embarqués (yt-dlp, Deno) : ordinateur seulement
  capabilities/default.json droits de la fenêtre (core, opener)
  Info.plist, Entitlements.plist   micro sur macOS, exécution renforcée
  src/lib.rs                point d'entrée (ordinateur et mobile), micro autorisé dans la vue web
  src/desktop.rs            commandes yt_info, yt_download, yt_cancel, ytdlp_status, ytdlp_update
  src/ytdlp.rs              appels à yt-dlp (formats, repli en cas de 403, messages d'erreur)
  src/updater.rs            copie et mise à jour automatique de yt-dlp
  tests/ytdlp.rs            tests avec un faux yt-dlp
src/native/tauri.ts         fournisseur d'audio « tauri-desktop » (chargé seulement dans l'app)
scripts/fetch-sidecars.mjs  télécharge yt-dlp et Deno avant la compilation (jamais commités)
.env.tauri                  VITE_API_BASE=https://enjoysing.resub.me
```

- **Ordre des sources** (`src/ui/obtain.ts`) : catalogue partagé du serveur, puis yt-dlp de l'ordinateur
  (fournisseur prioritaire), puis le serveur. L'analyse se fait dans l'app (Web Worker) et l'audio est gardé
  dans l'app (IndexedDB) : une chanson n'est téléchargée qu'une fois. Paroles (LRCLIB), Whisper et catalogue
  restent sur le serveur `https://enjoysing.resub.me`.
- **yt-dlp** : binaire officiel des releases GitHub de yt-dlp. Il contient déjà les scripts EJS.
  Formats : AAC/m4a d'abord (`bestaudio[ext=m4a][abr<=160]`), puis le format 18, puis d'autres clients YouTube
  (`tv,mweb,web_safari`), comme sur le serveur. La progression arrive au front par un canal Tauri, les octets
  arrivent bruts (ArrayBuffer, sans JSON), et le bouton Annuler arrête yt-dlp.
- **Deno** : yt-dlp exige maintenant un runtime JavaScript pour YouTube. Deno est le seul activé par défaut et
  celui que recommande le [wiki EJS de yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Il est embarqué et
  passé avec `--js-runtimes deno:<chemin>`. Coût : environ 95 Mo de plus, soit environ 35 Mo compressés.
  QuickJS-NG, environ 2 Mo, est une piste pour alléger l'app, mais elle n'a pas été essayée.
- **Mise à jour de yt-dlp** : YouTube change souvent. Au premier lancement, le yt-dlp embarqué est copié dans le
  dossier de données de l'app (`~/.local/share/me.resub.enjoysing/bin/`,
  `~/Library/Application Support/me.resub.enjoysing/bin/`, `%APPDATA%\me.resub.enjoysing\bin\`). Ensuite,
  au plus une fois par jour, cette copie se met à jour elle-même (`yt-dlp -U`). Une nouvelle version de l'app
  qui apporte un yt-dlp plus récent remplace la copie.
- **Lecteur YouTube** : servi depuis `tauri://localhost` (macOS, Linux), le lecteur intégré refuse de
  s'afficher (erreurs 152/153). L'app joue alors **le son téléchargé** à la place, avec le message « Le
  lecteur YouTube ne peut pas s'afficher dans l'application ». Accords, paroles et partition restent
  synchronisés. La vidéo n'est pas marquée « interdite par le propriétaire » et le son ne démarre pas tout
  seul. Le lien « Voir la vidéo sur YouTube », comme tout lien externe, s'ouvre dans le navigateur du système.
- **Micro** : la page de l'app reçoit l'autorisation (`on_permission_request`). Sans elle, WebKitGTK refuse.
  Le système garde sa propre autorisation : sur macOS, la demande affiche le texte de
  `NSMicrophoneUsageDescription` ; sur Windows, l'accès passe par Paramètres › Confidentialité › Microphone.

## Compiler et lancer

Prérequis : Node 22, [Rust](https://rustup.rs) stable, et les
[dépendances système de Tauri](https://v2.tauri.app/start/prerequisites/) :

- **Linux (Debian/Ubuntu)** :
  `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
  Pour lire l'AAC : `gstreamer1.0-plugins-good gstreamer1.0-libav`. Le .deb les installe tout seul.
- **macOS** : Xcode Command Line Tools (`xcode-select --install`).
- **Windows** : Visual Studio Build Tools (C++), et WebView2 (déjà présent sur Windows 10/11).

```sh
npm ci
npm run tauri:dev     # télécharge yt-dlp et Deno (une fois), puis lance l'app avec Vite (port 1420)
npm run tauri:build   # installeurs dans src-tauri/target/release/bundle/
```

`npm run tauri:sidecars` (ou `node scripts/fetch-sidecars.mjs [--target <triplet>] [--force]`) ne fait que
télécharger les programmes embarqués dans `src-tauri/binaries/` et vérifie leurs sommes SHA-256. Pour figer
une version : `YTDLP_VERSION=2026.10.26 DENO_VERSION=v2.9.8`. Mac universel :
`node scripts/fetch-sidecars.mjs --target universal-apple-darwin && npx tauri build --target universal-apple-darwin`
(Deno est assemblé avec `lipo`).

Dépannage : `ENJOYSING_YTDLP=/chemin/yt-dlp` et `ENJOYSING_DENO=/chemin/deno` remplacent les programmes
embarqués. La commande `ytdlp_status` donne la version et le chemin utilisés.

Tests :

```sh
npx vitest run                       # dont tests/tauri.test.ts et tests/obtain.test.ts
cd src-tauri && cargo test           # faux yt-dlp : téléchargement, repli 403, annulation, mise à jour
```

## Publier

La CI `.github/workflows/desktop.yml` lance :

- à chaque push ou pull request : les types et les tests du front, puis les tests Rust ;
- sur une étiquette `v*` (ex. `git tag v0.1.0 && git push origin v0.1.0`) ou à la main (Actions › App ordinateur
  › Run workflow) : la compilation sur **macOS (universel Intel + Apple Silicon)**, **Windows (x64)** et
  **Linux (x64, Ubuntu 22.04)** avec `tauri-apps/tauri-action`. Les installeurs (.dmg, .app.tar.gz, .msi,
  -setup.exe, .AppImage, .deb, .rpm) sont joints à un **brouillon de release** `v<version>`, à relire puis
  publier à la main.

La version vient de `src-tauri/tauri.conf.json` (`version`) : changez-la avant chaque étiquette.

### Signature (facultative, avec vos comptes)

Sans signature, les installeurs marchent mais le système avertit l'utilisateur :

- **macOS** : « EnjoySing ne peut pas être ouvert » ou « est endommagé ». Contournement : clic droit › Ouvrir,
  ou `xattr -dr com.apple.quarantine /Applications/EnjoySing.app`.
- **Windows** : SmartScreen « Windows a protégé votre ordinateur ». Contournement : Informations
  complémentaires › Exécuter quand même.

Pour signer, ajoutez ces secrets au dépôt (Settings › Secrets and variables › Actions). La CI ne les utilise
que s'ils existent.

**Apple (compte Apple Developer, 99 $/an)** : certificat « Developer ID Application » et notarisation.

| Secret | Contenu |
| --- | --- |
| `APPLE_CERTIFICATE` | le certificat .p12 en base64 (`base64 -i certificat.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | mot de passe du .p12 |
| `APPLE_SIGNING_IDENTITY` | ex. `Developer ID Application: Nom (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarisation : identifiant Apple, mot de passe d'app (appleid.apple.com), Team ID |

Les droits (`src-tauri/Entitlements.plist`) sont déjà prêts pour l'exécution renforcée : micro, JIT pour Deno,
bibliothèques de yt-dlp (PyInstaller). Tauri signe aussi les programmes embarqués.
À vérifier au premier essai signé : que yt-dlp et Deno se lancent bien depuis l'app notarisée.

**Windows (certificat de signature de code, OV ou EV)** :

| Secret | Contenu |
| --- | --- |
| `WINDOWS_CERTIFICATE` | le certificat .pfx en base64 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("c.pfx"))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | mot de passe du .pfx |

Les certificats récents sont souvent sur clé matérielle ou dans le cloud (Azure Trusted Signing). Dans ce
cas, remplacez l'étape « Signature Windows » par `bundle.windows.signCommand` (voir la
[doc Tauri](https://v2.tauri.app/distribute/sign/windows/)).

**Linux** : pas de signature nécessaire.

## État et vérifications (rapport du 20/11/2026)

**Vérifié dans le conteneur de développement (Linux, WebKitGTK, sous Xvfb, app pilotée par WebDriver)** :

- compilation Linux complète : `.deb` (82 Mo) et `.AppImage` ; le .deb installe `enjoysing`,
  `enjoysing-yt-dlp` et `enjoysing-deno` dans `/usr/bin` (préfixés pour ne pas heurter un yt-dlp du système) ;
- chaîne complète avec un faux yt-dlp : infos (`-J`), téléchargement avec progression, octets bruts jusqu'au
  front, décodage m4a/AAC par WebKitGTK (GStreamer), analyse (« C majeur » trouvé), audio gardé en IndexedDB ;
- **un vrai téléchargement YouTube a réussi** depuis l'app avec le yt-dlp et le Deno embarqués : Rick Astley,
  analysée puis affichée. Le défi JavaScript est résolu par Deno (`[jsc:deno]`). D'autres vidéos ont reçu la
  vérification anti-robot, car ce conteneur est un serveur cloud ;
- copie de yt-dlp dans le dossier de données et `yt-dlp -U` au premier lancement ;
- micro dans WebKitGTK : `getUserMedia` marche, avec un micro virtuel PulseAudio, et le bouton « Tester ma
  voix » démarre ;
- lecteur YouTube refusé depuis `tauri://localhost` : le son local le remplace, sans démarrer tout seul ;
- tests : Rust 7 (faux yt-dlp : téléchargement, repli 403, erreurs, annulation, mise à jour) ; front 99.

**Non vérifié (pas de Mac ni de PC Windows ici)** : à essayer avant de publier.

- macOS : compilation universelle et `lipo` de Deno (seulement dans la CI) ; micro dans WKWebView et demande
  d'autorisation ; lecteur YouTube refusé ; app signée et notarisée avec les programmes embarqués.
- Windows : compilation, absence de fenêtre de console pour yt-dlp (`CREATE_NO_WINDOW`), micro dans WebView2.
  Le lecteur YouTube y est servi depuis `http://tauri.localhost` et marche peut-être ; sinon, le repli est le même.
- Fichiers m4a « DASH » sans ffmpeg : yt-dlp corrige normalement le conteneur avec ffmpeg, qui n'est pas
  embarqué. Chromium et WebKit lisent en général ces fichiers tels quels. Si le décodage échoue chez un
  utilisateur, il faudra embarquer ffmpeg ou préférer le format 18.
- **Serveur en production** : le 20/11, `https://enjoysing.resub.me` ne renvoyait pas encore les en-têtes CORS
  pour `tauri://localhost` (OPTIONS `/api/analyze` → 404). Il faut redéployer la version de `main` qui contient
  `corsOrigins` (`server/config.ts`). Sinon, depuis l'app, le catalogue partagé, les paroles, Whisper et le
  repli par le serveur échouent (« Serveur injoignable »). Le téléchargement par yt-dlp, lui, marche.

**À faire par le propriétaire** : redéployer le serveur (CORS) ; tester l'app sur Mac et sur PC ; créer
éventuellement les comptes de signature (Apple Developer, certificat Windows) et ajouter les secrets ;
pousser une étiquette `v0.1.0` pour lancer la première compilation.

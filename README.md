# EnjoySing

Trouvez les **accords de guitare** de n'importe quelle chanson et **transposez-la dans la tessiture de votre voix**.
L'analyse des fichiers se fait dans le navigateur ; celle des vidéos YouTube sur le serveur.

## Fonctionnalités

1. **Trois sources** :
   - **une vidéo YouTube** (ordinateur et téléphone) : le serveur récupère la piste audio, trouve les accords,
     **supprime l'audio** et renvoie les accords. La vidéo se lit dans le lecteur YouTube officiel, les accords
     défilent en même temps. Lien partageable : `/?v=<identifiant>` ;
   - **le catalogue** personnel, avec recherche : stocké dans le navigateur (localStorage, pas de compte), il garde
     les accords et les réglages de chaque chanson (transposition, capo…). Une chanson du catalogue s'ouvre
     instantanément, sans repasser par le serveur ;
   - **un fichier audio** (MP3, WAV, M4A…), analysé directement dans le navigateur.
2. **Détection des accords**
   - chromagramme (énergie des 12 notes) sur les pics spectraux ;
   - reconnaissance par gabarits harmoniques (majeur, mineur, 7, maj7, m7, dim, sus2, sus4) + analyse de la basse ;
   - lissage temporel par algorithme de Viterbi ;
   - détection de la tonalité (profils de Krumhansl).
3. **Test de voix au micro** (détection de hauteur YIN) ou choix d'un type de voix (basse → soprano).
4. **Estimation de la tessiture de la mélodie** (sommation harmonique), ajustable à la main.
5. **Transposition automatique** : calcule le décalage qui place la mélodie dans votre voix — et sait qu'un homme
   peut chanter une chanson de femme une octave plus bas sans changer de tonalité.
6. **Transposition de l'audio** sans changer le tempo (vocodeur de phase avec verrouillage de phase), téléchargeable en WAV.
7. **Capodastre** suggéré pour jouer avec des formes faciles, **diagrammes d'accords**, grille synchronisée avec la lecture,
   mode « accords simplifiés », copie de la grille.

## Démarrer

Prérequis : Node 22, `ffmpeg` et `yt-dlp` (`pip install -U yt-dlp`).

```bash
npm install
npm run dev      # site sur http://localhost:5173 + serveur d'analyse sur :8787
npm test         # tests (algorithmes, serveur avec un faux yt-dlp)
npm run build && npm start   # production : tout sur http://localhost:8787
```

**Mise en ligne** (serveur + Cloudflare, sur enjoysing.resub.me) : voir **[DEPLOY.md](DEPLOY.md)**.

Le serveur ne stocke rien sur disque : l'audio est supprimé après l'analyse et le résultat n'est gardé qu'une heure
en mémoire (pour éviter de retélécharger une vidéo demandée plusieurs fois).

### Configuration du serveur (variables d'environnement)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | 8787 | Port HTTP |
| `YTDLP_PATH` / `FFMPEG_PATH` | `yt-dlp` / `ffmpeg` | Chemins des outils |
| `YTDLP_COOKIES` | — | Fichier de cookies YouTube, si YouTube bloque le serveur |
| `YTDLP_EXTRA_ARGS` | — | Options supplémentaires de yt-dlp (ex. `--proxy http://…`) |
| `MAX_DURATION` | 900 | Durée maximale d'une vidéo (s) |
| `CONCURRENCY` | 2 | Analyses simultanées |
| `RATE_LIMIT_PER_HOUR` | 20 | Nouvelles analyses par IP et par heure |

### Paroles par IA (Whisper, en local)

Quand une chanson n'a pas de paroles synchronisées dans LRCLIB, le serveur les transcrit avec
[whisper.cpp](https://github.com/ggml-org/whisper.cpp), sans rien envoyer à l'extérieur :

```bash
npm run whisper:setup            # installe whisper.cpp (Homebrew) + modèle large-v3-turbo-q5_0 (~550 Mo)
npm run whisper:setup small      # ou un modèle plus léger : base (~150 Mo), small (~470 Mo)
```

Le serveur détecte tout seul le modèle dans `models/`. Variables : `WHISPER_CLI`, `WHISPER_MODEL`,
`WHISPER_LANGUAGE` (`auto` par défaut), `WHISPER_THREADS`. La transcription prend de 20 s à 1 min par chanson sur
un Mac récent ; elle peut contenir des erreurs (l'app l'indique).

### En cas d'erreur 403 ou « not a bot »

1. Mettre yt-dlp à jour : `brew upgrade yt-dlp`, `pip install -U "yt-dlp[default]"` ou `yt-dlp -U`.
2. Installer Deno (`brew install deno`) : yt-dlp s'en sert pour résoudre les protections de YouTube.
3. Tester directement : `yt-dlp -v -f bestaudio -o /tmp/test.%(ext)s "https://www.youtube.com/watch?v=…"`.
4. Si ça bloque encore, utiliser les cookies du navigateur de la machine (sur un ordinateur personnel) :
   `YTDLP_EXTRA_ARGS="--cookies-from-browser chrome" npm start`.

### YouTube bloque souvent les serveurs

Depuis un hébergeur cloud, YouTube répond fréquemment « Sign in to confirm you're not a bot ». Solutions :
héberger le serveur sur une connexion résidentielle, passer par un proxy résidentiel (`YTDLP_EXTRA_ARGS`), ou
fournir des cookies (`YTDLP_COOKIES`, avec un compte secondaire : le compte peut être suspendu). Gardez yt-dlp à
jour (l'image Docker le met à jour à chaque démarrage). Sur ordinateur, l'app propose en secours d'analyser la
vidéo en écoutant l'onglet. L'**app ordinateur** (Tauri, voir [docs/desktop.md](docs/desktop.md)) télécharge
l'audio depuis la machine de l'utilisateur, avec son adresse IP de particulier.

Télécharger depuis YouTube est contraire à ses conditions d'utilisation : EnjoySing ne conserve jamais l'audio sur le serveur.

## Structure

```
server/       API d'analyse (file d'attente, yt-dlp + ffmpeg), sans stockage
src/
  dsp/        traitement du signal (FFT, chroma, accords, tonalité, YIN, mélodie, pitch-shift, worker)
  music/      théorie musicale (transposition, tessitures, capo) et doigtés de guitare
  ui/         micro, lecteur YouTube, écoute de l'onglet, encodage WAV
  native/     intégration des apps Tauri (fournisseur d'audio yt-dlp de l'ordinateur)
  main.ts     interface
src-tauri/    app ordinateur Tauri v2 (yt-dlp et Deno embarqués), voir docs/desktop.md
tests/        tests Vitest
```

## Limites

La détection automatique est une estimation : elle marche le mieux sur des enregistrements clairs
(guitare/piano + voix). Les accords marqués « ? » sont incertains. Utilisez uniquement des fichiers que vous avez le droit d'utiliser.

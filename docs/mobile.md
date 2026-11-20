# Apps Android et iOS (Tauri v2)

Les apps mobiles réutilisent **toute l'app web** (le dossier `dist/` est embarqué dans l'app) et
appellent le serveur EnjoySing en ligne (`https://enjoysing.resub.me`, fixé par `.env.tauri`) pour le
catalogue partagé, les paroles et la transcription.

La seule différence : **l'audio YouTube est récupéré par le téléphone lui-même**, avec l'adresse IP
de l'utilisateur (un particulier). YouTube bloque le serveur (« Sign in to confirm you're not a
bot »), mais pas un téléphone ordinaire.

## Comment ça marche

| Fichier | Rôle |
| --- | --- |
| `src/native/mobile.ts` | Chargé seulement dans Tauri. Branche le fournisseur d'audio `tauri-mobile` (priorité `first`) et règle l'interface (bouton retour Android, clavier, zones sûres). |
| `src/native/youtubeMobile.ts` | Logique d'extraction : clients YouTube essayés un par un, choix du format, téléchargement par morceaux. Testé dans `tests/youtubeMobile.test.ts`. |
| `src/native/poToken.ts` | Jetons PO (BotGuard, via `bgutils-js`) pour les clients web, en dernier recours. |
| `src/native/ytEval.worker.ts` | Déchiffre les signatures du lecteur YouTube dans un Worker isolé. |
| `src-tauri/` | Projet Tauri commun (ordinateur, Android, iOS ; l'app ordinateur et yt-dlp sont décrits par la branche `tauri`). Sur mobile, plugin `http` : les requêtes YouTube sont faites par Rust (pas de CORS). |
| `src-tauri/capabilities/mobile.json` | Droits des apps mobiles (domaines joignables par le `fetch` natif, bouton retour). |
| `src-tauri/gen/android` | Projet Android Studio (créé par `tauri android init`, versionné). |
| `src-tauri/Info.ios.plist` | Réglages ajoutés à l'app iOS (texte de la demande d'accès au micro). |

Déroulement quand on colle un lien :

1. le catalogue partagé du serveur (si la chanson a déjà été analysée : instantané) ;
2. sinon, le **téléphone** télécharge l'audio avec [youtubei.js](https://github.com/LuanRT/YouTube.js) :
   - clients essayés dans l'ordre : `ANDROID_VR` (adresses directes, sans jeton), `TV` (signature
     à déchiffrer), `MWEB` (jeton PO fabriqué par BotGuard dans le WebView), `WEB_EMBEDDED` ;
   - format : **audio seul m4a/AAC (itag 140)**. iOS (WKWebView) ne sait pas décoder webm/opus
     avec `decodeAudioData` ; Android accepterait opus, mais on prend 140 partout ;
   - téléchargement par plages de 1 Mo (`range=`), avec progression et annulation ;
3. l'analyse (accords, mélodie…) se fait dans le WebView et l'audio est gardé dans IndexedDB ;
   la transposition du son aussi (`src/ui/localAudio.ts`) ;
4. si le téléphone échoue, l'app essaie le serveur comme avant.

Le lecteur YouTube intégré (iframe) est utilisé quand il marche. Dans une app, YouTube refuse
parfois l'intégration (erreurs 152/153, surtout sur iOS où l'adresse de la page est
`tauri://localhost`) : l'app joue alors l'audio téléchargé à la place, comme pour les vidéos dont
l'intégration est interdite.

## Prérequis

- Node 22, Rust (stable) : <https://www.rust-lang.org/tools/install>
- Prérequis Tauri : <https://v2.tauri.app/start/prerequisites/>
- **Android** : Android Studio (ou les outils en ligne de commande), SDK, NDK, Java 17+ :
  ```sh
  export ANDROID_HOME=$HOME/Android/Sdk            # macOS : $HOME/Library/Android/sdk
  export NDK_HOME=$ANDROID_HOME/ndk/27.2.12479018
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```
- **iOS** : un Mac avec Xcode, CocoaPods (`brew install cocoapods`) :
  ```sh
  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
  ```

## Compiler et tester sur un téléphone

```sh
npm ci
```

### Android

Le projet Android est versionné dans `src-tauri/gen/android` (permission micro `RECORD_AUDIO`
déjà ajoutée au manifeste).

```sh
# téléphone branché en USB avec le « débogage USB » activé (Options pour les développeurs)
npm run android:dev            # app en direct, rechargée à chaque modification
# ou un APK de test, installable directement :
npx tauri android build --debug --apk --target aarch64
adb install src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Pour `android:dev`, le téléphone doit joindre l'ordinateur sur le réseau local (même Wi-Fi) : le
serveur de développement Vite écoute sur le port 1420 (`npm run tauri:web:dev`), Tauri règle
l'adresse tout seul. Les builds lancent `npm run tauri:web:build` (vérification des types + Vite
en mode `tauri`, donc avec `VITE_API_BASE` de `.env.tauri`).

### iOS (sur un Mac)

Le projet Xcode n'est pas versionné (il ne peut être créé que sur macOS) :

```sh
npx tauri ios init             # une fois ; reprend src-tauri/Info.ios.plist (micro…)
npm run ios:dev                # simulateur, ou iPhone branché (choix proposé)
npx tauri ios open             # ouvrir dans Xcode (équipe de signature, appareil…)
```

Sur un iPhone réel, Xcode demande une équipe de signature : un identifiant Apple gratuit suffit
pour installer sur **son propre** iPhone (l'app expire au bout de 7 jours) ; il faut un compte
Apple Developer (99 $/an) pour TestFlight.

### À vérifier sur un vrai téléphone

Ce conteneur de développement est bloqué par YouTube et n'a ni téléphone ni macOS : **la vraie
récupération de l'audio n'a pas pu être testée.** La logique est couverte par des tests avec des
réponses factices. Sur un téléphone, vérifier :

1. coller un lien YouTube jamais analysé : la barre doit afficher « Téléchargement de l'audio
   (téléphone)… » puis l'analyse ; dans les journaux (`adb logcat | grep youtube`, ou la console
   Safari pour iOS), une ligne `[youtube] ANDROID_VR : itag 140 …` indique le client qui a marché ;
2. la lecture : vidéo YouTube intégrée, ou audio téléchargé si l'intégration est refusée ;
3. la transposition du son ;
4. l'entraînement au micro (autoriser le micro à la première demande) ;
5. Android : le bouton retour ferme les fenêtres, revient à l'accueil, puis quitte l'app ;
6. le clavier ne cache pas le champ du lien ; rien sous l'encoche / la barre d'état.

Si YouTube change ses règles (cela arrive souvent), mettre à jour `youtubei.js` / `bgutils-js` et,
si besoin, l'ordre des clients dans `CLIENTS_PAR_DEFAUT` (`src/native/youtubeMobile.ts`).

## Compilation automatique (GitHub Actions)

`.github/workflows/mobile.yml` compile à chaque push sur `tauri-mobile`, sur les tags `v*` et à la
demande (onglet *Actions* → *Apps mobiles* → *Run workflow*). Les fichiers produits sont dans les
*artifacts* du run :

- **Android** : APK universel + AAB (release) ; sans clé de signature, l'APK release n'est pas signé
  et un **APK debug arm64** (installable) est fourni en plus ;
- **iOS** : build pour le simulateur, non signé ; IPA signé si les secrets Apple sont fournis.

### Secrets pour signer

Android (dans *Settings → Secrets and variables → Actions*) :

```sh
keytool -genkey -v -keystore upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias enjoysing
base64 -w0 upload.jks   # → ANDROID_KEYSTORE_BASE64
```

| Secret | Valeur |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | le fichier `.jks` en base64 |
| `ANDROID_KEYSTORE_PASSWORD` | mot de passe du keystore (et de la clé) |
| `ANDROID_KEY_ALIAS` | `enjoysing` |

**Gardez le keystore en lieu sûr** : sans lui, impossible de publier une mise à jour de l'app.

iOS (compte Apple Developer) : `APPLE_DEVELOPMENT_TEAM` (identifiant d'équipe), et une clé d'API
App Store Connect : `APPLE_API_ISSUER`, `APPLE_API_KEY` (identifiant de la clé),
`APPLE_API_KEY_CONTENT` (contenu du fichier `.p8`). Les certificats et profils sont alors gérés
automatiquement par Xcode (voir <https://v2.tauri.app/distribute/sign/ios/>).

## Distribuer

> **Important : Google Play et l'App Store refusent en général les apps qui téléchargent depuis
> YouTube** (règles des boutiques et conditions d'utilisation de YouTube). Ne comptez pas sur une
> publication dans les boutiques officielles.

### Android : APK direct

- Publier l'APK signé (release) sur le site, ou dans une *Release* GitHub, avec un lien de
  téléchargement ;
- l'utilisateur autorise « Installer des applis inconnues » pour son navigateur, puis ouvre l'APK ;
- les mises à jour doivent être signées **avec la même clé** (sinon il faut désinstaller) ;
- autres canaux possibles : F-Droid (dépôt personnel), Obtainium (suit les Releases GitHub).

Aucun compte payant n'est nécessaire (le compte Google Play Console, 25 $, ne sert que pour le
Play Store).

### iOS : TestFlight ou distribution alternative

Apple n'autorise pas l'installation libre d'un fichier comme sur Android :

- **TestFlight** (compte Apple Developer, 99 $/an) : jusqu'à 10 000 testeurs par lien
  d'invitation, chaque build expire au bout de 90 jours. Les builds pour testeurs externes passent
  une vérification d'Apple (plus légère que l'App Store, mais elle peut refuser) ;
- **installation par Xcode** sur ses propres appareils (identifiant Apple gratuit : 7 jours ;
  compte payant : 1 an) ;
- **Union européenne** : distribution alternative (boutiques alternatives ou distribution web),
  qui demande aussi un compte Apple Developer et la « notarisation » par Apple ;
- AltStore / SideStore : installation avec un identifiant Apple personnel (renouvellement tous les
  7 jours).

## Notes techniques

- **CORS** : l'app appelle le serveur depuis `http://tauri.localhost` (Android) et
  `tauri://localhost` (iOS), déjà autorisés dans `server/config.ts` (`corsOrigins`).
- **Permissions Tauri** : `src-tauri/capabilities/mobile.json` limite le `fetch` natif aux domaines
  de YouTube/Google nécessaires. Le plugin `http` est compilé avec `unsafe-headers` pour que
  youtubei.js puisse fixer `User-Agent`, `Origin`, `Referer`…
- **Sécurité** : le code de déchiffrage extrait du lecteur YouTube s'exécute dans un Worker (sans
  accès à la page ni aux commandes Tauri). Le script BotGuard (jetons PO), lui, s'exécute dans la
  page : il n'est utilisé qu'en dernier recours. Si une politique CSP est ajoutée un jour dans
  `tauri.conf.json`, elle doit autoriser `'unsafe-eval'` et les Workers.
- Le site web n'est pas alourdi : `youtubei.js` et `bgutils-js` ne sont chargés que dans l'app
  (import dynamique).

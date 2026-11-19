# Mettre EnjoySing en ligne sur enjoysing.resub.me

EnjoySing tourne sur un **serveur loué (VPS)** avec Docker. Le site est publié par un **tunnel Cloudflare** :
aucun port à ouvrir sur le serveur, et le HTTPS est géré par Cloudflare.

Trois services tournent ensemble (`docker-compose.yml`) :

| Service | Rôle |
| --- | --- |
| `enjoysing` | le site et le serveur d'analyse (yt-dlp, ffmpeg, Whisper) |
| `bgutil` | fournisseur de « jetons PO » : aide yt-dlp à passer le blocage « not a bot » de YouTube sur les serveurs |
| `cloudflared` | le tunnel qui publie le site sur enjoysing.resub.me |

## Avec Coolify

Si vous avez un serveur Coolify, utilisez `docker-compose.coolify.yml` : Coolify fournit le proxy et le HTTPS
(Let's Encrypt), il n'y a donc ni tunnel ni port à ouvrir en plus. Serveur conseillé : 4 processeurs, 8 Go
(2 processeurs, 4 Go avec `WHISPER_MODEL_NAME=base`).

1. **DNS Cloudflare** : enregistrement **A** `enjoysing` → adresse IP du serveur Coolify, **nuage gris (DNS only)**
   pour que Let's Encrypt puisse délivrer le certificat.
2. **Accès au dépôt** : Coolify › **Sources** › ajoutez une **GitHub App** ayant accès à `wdjopa/EasyMusic`
   (nécessaire si le dépôt est privé ; elle permet aussi le déploiement automatique à chaque push).
3. **Créer la ressource** : un projet › **+ New** › **Private Repository (with GitHub App)** › `EasyMusic` :
   - Branch : `main`
   - Build Pack : **Docker Compose**
   - Base Directory : `/` · Docker Compose Location : `/docker-compose.coolify.yml`
4. **Domaine** : dans la liste des services, pour `enjoysing`, indiquez **`https://enjoysing.resub.me`** (sans port :
   le serveur écoute sur le port 80, celui que Coolify utilise par défaut). Laissez `bgutil` sans domaine.
5. **Environment Variables** (facultatif, les valeurs par défaut conviennent) : `WHISPER_MODEL_NAME`,
   `WHISPER_THREADS`, `RATE_LIMIT_PER_HOUR`, `CONCURRENCY`. Laissez `YTDLP_COOKIES` vide pour l'instant.
6. **Deploy**. La première construction prend 5 à 10 minutes (compilation de Whisper). Dans **Logs**, vous devez
   voir `EnjoySing : http://localhost:80`, puis quelques minutes plus tard `✓ Whisper disponible`.
7. Ouvrez **https://enjoysing.resub.me** et collez un lien YouTube.
8. **Si YouTube bloque le serveur** : onglet **Persistent Storage**, ouvrez le fichier `/secrets/cookies.txt`, collez
   vos cookies YouTube (voir l'étape 5 plus bas), enregistrez ; puis mettez `YTDLP_COOKIES=/secrets/cookies.txt`
   dans Environment Variables et **Redeploy**.
9. (Facultatif) Une fois le certificat obtenu, vous pouvez passer l'enregistrement Cloudflare en **nuage orange**
   avec SSL/TLS en mode **Full (strict)**.

Mises à jour : chaque push sur la branche redéploie automatiquement (GitHub App), sinon bouton **Redeploy**.
yt-dlp se met à jour à chaque redémarrage : en cas de souci avec YouTube, **Restart** suffit souvent.

Les parties 1 à 4 ci-dessous concernent l'autre méthode (VPS nu + tunnel Cloudflare).

## Pourquoi pas Vercel

Vercel convient au site seul, pas au serveur d'analyse : réponses limitées à 4,5 Mo (un fichier audio pèse plus),
pas de serveur permanent (la file d'analyses et le cache audio ne tiendraient pas), et Whisper y serait trop lourd.

## 1. Louer un serveur

N'importe quel VPS sous **Ubuntu 24.04** convient, par exemple chez Hetzner, OVH ou Scaleway :

- **2 processeurs, 4 Go de mémoire** : suffisant (paroles par IA avec le modèle `base`) ;
- **4 processeurs, 8 Go** : recommandé (modèle `small`, de meilleures paroles par IA) ;
- 20 Go de disque.

## 2. Installer Docker sur le serveur

```bash
ssh root@ADRESSE_DU_SERVEUR
curl -fsSL https://get.docker.com | sh
```

## 3. Créer le tunnel Cloudflare

Dans le tableau de bord Cloudflare :

1. **Zero Trust** › **Networks** › **Tunnels** › **Create a tunnel** › type **Cloudflared**, nom : `enjoysing`.
2. À l'étape « Install connector », copiez le **jeton** : la longue chaîne après `--token` dans la commande proposée
   (inutile de lancer cette commande, Docker s'en charge).
3. Onglet **Public Hostname** › **Add a public hostname** :
   - Subdomain : `enjoysing` · Domain : `resub.me`
   - Service : type **HTTP**, URL **`enjoysing:8787`**
4. Enregistrez. Cloudflare crée lui-même l'enregistrement DNS de enjoysing.resub.me.

## 4. Installer EnjoySing

```bash
git clone https://github.com/wdjopa/EasyMusic.git enjoysing
cd enjoysing
cp .env.example .env
nano .env            # collez le jeton du tunnel dans CLOUDFLARE_TUNNEL_TOKEN
mkdir -p secrets
docker compose up -d --build
```

La première construction prend 5 à 10 minutes (compilation de Whisper). Ensuite, ouvrez **https://enjoysing.resub.me**.

Pour suivre ce qui se passe :

```bash
docker compose logs -f enjoysing
```

Au démarrage, vous devez voir `EnjoySing : http://localhost:8787`, puis, une fois le modèle téléchargé (quelques
minutes), `✓ Whisper disponible`.

## 5. Vérifier que YouTube ne bloque pas le serveur

Collez un lien YouTube dans l'app. Si l'analyse échoue avec « YouTube bloque temporairement le serveur » ou une
erreur 403, les journaux indiquent la cause :

```bash
docker compose logs enjoysing | grep yt-dlp
```

Le fournisseur de jetons suffit souvent. Sinon, ajoutez des **cookies YouTube** :

1. Sur votre ordinateur, avec un compte YouTube **secondaire** (le compte peut être suspendu), exportez les cookies
   de youtube.com au format Netscape (extension « Get cookies.txt LOCALLY », par exemple).
2. Copiez le fichier sur le serveur : `scp cookies.txt root@ADRESSE_DU_SERVEUR:~/enjoysing/secrets/cookies.txt`
3. Dans `.env`, décommentez `YTDLP_COOKIES=/secrets/cookies.txt`, puis `docker compose up -d`.

Dans tous les cas, si une vidéo ne peut pas être lue dans le lecteur YouTube intégré, l'app joue l'audio téléchargé.

## Mettre à jour

```bash
cd ~/enjoysing
git pull
docker compose up -d --build
```

yt-dlp est mis à jour automatiquement à chaque redémarrage du conteneur : en cas de souci avec YouTube, un simple
`docker compose restart enjoysing` suffit souvent.

## Réglages (fichier `.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `CLOUDFLARE_TUNNEL_TOKEN` | — | jeton du tunnel (obligatoire) |
| `WHISPER_MODEL_NAME` | `small` | `base` (rapide), `small`, `large-v3-turbo-q5_0` (meilleur, lent sans GPU), `none` |
| `WHISPER_THREADS` | 4 | processeurs utilisés par Whisper |
| `RATE_LIMIT_PER_HOUR` | 30 | nouvelles analyses par visiteur et par heure |
| `YTDLP_COOKIES` | — | fichier de cookies YouTube, si le blocage persiste |

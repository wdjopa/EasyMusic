#!/bin/sh
# Démarrage du conteneur EnjoySing.
set -e

# yt-dlp doit rester à jour : YouTube change souvent son fonctionnement
pip3 install -q -U --break-system-packages "yt-dlp[default]" bgutil-ytdlp-pot-provider 2>/dev/null \
  || echo "Mise à jour de yt-dlp impossible (on garde la version installée)."

# Modèle Whisper (paroles par IA) : téléchargé une fois dans le volume /models, en arrière-plan.
# Le serveur le détecte tout seul dès qu'il est là (WHISPER_MODEL_NAME=none pour désactiver).
if [ "${WHISPER_MODEL_NAME:-small}" != "none" ]; then
  MODEL="/models/ggml-${WHISPER_MODEL_NAME:-small}.bin"
  export WHISPER_MODEL="$MODEL"
  if [ ! -f "$MODEL" ]; then
    (
      echo "Téléchargement du modèle Whisper ${WHISPER_MODEL_NAME:-small}…"
      curl -fsSL -o "$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL_NAME:-small}.bin" \
        && mv "$MODEL.part" "$MODEL" && echo "Modèle Whisper prêt : $MODEL" \
        || echo "Téléchargement du modèle Whisper impossible."
    ) &
  fi
fi

exec node_modules/.bin/tsx server/index.ts

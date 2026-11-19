#!/usr/bin/env bash
# Installe la transcription des paroles par IA (Whisper, en local) pour EasyMusic.
# Usage : npm run whisper:setup [modèle]   (par défaut : large-v3-turbo-q5_0, ~550 Mo)
# Modèles possibles : base (~150 Mo, rapide), small (~470 Mo), large-v3-turbo-q5_0 (~550 Mo, le meilleur compromis)
set -euo pipefail
MODEL="${1:-large-v3-turbo-q5_0}"
cd "$(dirname "$0")/.."

if ! command -v whisper-cli >/dev/null 2>&1 && ! command -v whisper-cpp >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "→ Installation de whisper.cpp (Homebrew)…"
    brew install whisper-cpp
  else
    echo "whisper-cli est introuvable. Installez whisper.cpp : https://github.com/ggml-org/whisper.cpp"
    echo "(sur Mac : brew install whisper-cpp), ou indiquez son chemin avec WHISPER_CLI=…"
    exit 1
  fi
fi

mkdir -p models
FILE="models/ggml-${MODEL}.bin"
if [ -f "$FILE" ]; then
  echo "✓ Modèle déjà présent : $FILE"
else
  echo "→ Téléchargement du modèle $MODEL…"
  curl -L --fail --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"
  mv "$FILE.part" "$FILE"
fi
CLI="$(command -v whisper-cli || command -v whisper-cpp || true)"
if [ -z "$CLI" ]; then
  echo "✗ whisper.cpp n'est toujours pas trouvé : vérifiez « brew install whisper-cpp »."
  exit 1
fi
echo "✓ Whisper est prêt ($CLI, modèle $FILE)."
echo "  Le serveur le détecte tout seul (dans les 30 s) ; au démarrage, il affiche « ✓ Whisper disponible »."
echo "  Vérification : curl -s http://localhost:8787/api/features"

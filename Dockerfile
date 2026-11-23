# EnjoySing : site + serveur d'analyse (Node, ffmpeg, yt-dlp, Whisper)

# 1. Le site et le serveur
FROM node:26-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm install --no-save tsx@4

# 2. whisper.cpp (paroles par IA), compilé en binaire autonome
FROM debian:trixie-slim AS whisper
RUN apt-get update \
 && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG WHISPER_REF=v1.9.6
RUN git clone --depth 1 --branch "$WHISPER_REF" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build /src/build -j"$(nproc)" --target whisper-cli \
 && cp /src/build/bin/whisper-cli /usr/local/bin/whisper-cli

# 3. L'image finale
FROM node:26-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv ca-certificates unzip curl libgomp1 \
 && curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
 # yt-dlp + le fournisseur de jetons PO (contre le blocage « not a bot » de YouTube sur les serveurs)
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" bgutil-ytdlp-pot-provider \
 && rm -rf /var/lib/apt/lists/*
# Séparation voix / instruments (Demucs, version processeur de PyTorch : ~1 Go), dans un environnement Python
# à part (aucun conflit avec les paquets du système). WITH_DEMUCS=0 pour s'en passer.
ARG WITH_DEMUCS=1
RUN if [ "$WITH_DEMUCS" = "1" ]; then \
      python3 -m venv /opt/demucs \
   && /opt/demucs/bin/pip install --no-cache-dir -U pip \
   && /opt/demucs/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch torchaudio \
   && /opt/demucs/bin/pip install --no-cache-dir demucs soundfile numpy; \
    fi
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
WORKDIR /app
COPY --from=build /app /app
RUN chmod +x /app/docker/start.sh && mkdir -p /models
# modèles d'IA (Whisper, Demucs) gardés dans le volume /models : téléchargés une seule fois
ENV NODE_ENV=production PORT=8787 STATIC_DIR=/app/dist WHISPER_CLI=whisper-cli HF_HOME=/models/hf TORCH_HOME=/models/torch DEMUCS_PYTHON=/opt/demucs/bin/python
EXPOSE 8787
CMD ["/app/docker/start.sh"]

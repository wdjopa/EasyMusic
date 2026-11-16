# EasyMusic : site + serveur d'analyse (Node, ffmpeg, yt-dlp)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev && npm install --no-save tsx@4

FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data STATIC_DIR=/app/dist
VOLUME /data
EXPOSE 8787
# yt-dlp doit rester à jour : YouTube change souvent son fonctionnement
CMD ["sh", "-c", "pip3 install -q -U --break-system-packages yt-dlp || true; exec node_modules/.bin/tsx server/index.ts"]

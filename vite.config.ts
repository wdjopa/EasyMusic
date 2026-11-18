import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// version affichée en bas de page : permet de vérifier qu'on voit bien la dernière mise à jour
const version = (() => {
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim();
    const date = execSync('git log -1 --format=%cd "--date=format:%d/%m %H:%M"').toString().trim();
    return `${hash} · ${date}`;
  } catch {
    return 'inconnue';
  }
})();

const api = { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { host: true, allowedHosts: true, proxy: api },
  preview: { host: true, allowedHosts: true, proxy: api },
  worker: { format: 'es' },
});

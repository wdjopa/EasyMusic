import { defineConfig } from 'vite';

const api = { '/api': `http://localhost:${process.env.API_PORT ?? 8787}` };

export default defineConfig({
  server: { host: true, allowedHosts: true, proxy: api },
  preview: { host: true, allowedHosts: true, proxy: api },
  worker: { format: 'es' },
});

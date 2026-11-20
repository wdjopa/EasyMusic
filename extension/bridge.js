// Pont entre la page EnjoySing et l'extension (voir src/ui/audioProvider.ts pour le protocole).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const VERSION = api.runtime.getManifest().version;
  const ID = /^[\w-]{11}$/;
  const ports = new Map(); // reqId -> port vers l'arrière-plan

  const toPage = (msg) => window.postMessage({ source: 'enjoysing-ext', ...msg }, location.origin);
  const hello = () => toPage({ type: 'hello', version: VERSION, protocol: 1 });

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'enjoysing-page') return;
    const m = e.data;
    if (m.type === 'ping') return hello();
    if (m.type === 'cancel') {
      ports.get(m.reqId)?.disconnect();
      ports.delete(m.reqId);
      return;
    }
    if (m.type !== 'fetchAudio' || typeof m.reqId !== 'string' || !ID.test(m.videoId ?? '')) return;
    const port = api.runtime.connect({ name: 'capture' });
    ports.set(m.reqId, port);
    const chunks = [];
    port.onMessage.addListener((r) => {
      if (r.type === 'progress') toPage({ type: 'progress', reqId: m.reqId, fraction: r.fraction, label: r.label });
      else if (r.type === 'chunk') chunks.push(r.data);
      else if (r.type === 'done') {
        const bin = atob(chunks.join(''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        toPage({ type: 'result', reqId: m.reqId, audio: bytes.buffer, mime: r.mime });
        ports.delete(m.reqId);
        port.disconnect();
      } else if (r.type === 'error') {
        toPage({ type: 'error', reqId: m.reqId, error: r.error });
        ports.delete(m.reqId);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (ports.delete(m.reqId)) toPage({ type: 'error', reqId: m.reqId, error: 'L’extension s’est arrêtée avant la fin.' });
    });
    port.postMessage({ type: 'start', videoId: m.videoId });
  });

  hello();
})();

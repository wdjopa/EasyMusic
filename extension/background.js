// Arrière-plan : ouvre la vidéo dans un onglet YouTube muet, relaie la progression et le son vers la page.
const api = globalThis.browser ?? globalThis.chrome;
const jobs = new Map(); // id de capture -> { page, tabId, yt }
let seq = 0;

api.runtime.onConnect.addListener((port) => {
  if (port.name === 'capture') return onPage(port);
  if (port.name.startsWith('yt-capture:')) return onYouTube(port, port.name.slice('yt-capture:'.length));
});

function onPage(page) {
  page.onMessage.addListener(async (m) => {
    if (m.type !== 'start') return;
    const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
    const job = { page, tabId: null, yt: null };
    jobs.set(id, job);
    page.postMessage({ type: 'progress', fraction: 0, label: 'Ouverture de la vidéo dans un onglet YouTube…' });
    try {
      const tab = await api.tabs.create({ url: `https://www.youtube.com/watch?v=${m.videoId}&enjoysing_capture=${id}`, active: false });
      job.tabId = tab.id;
      await api.tabs.update(tab.id, { muted: true }); // on écoute sans déranger
    } catch (e) {
      page.postMessage({ type: 'error', error: `Impossible d’ouvrir YouTube (${e.message}).` });
      jobs.delete(id);
    }
  });
  page.onDisconnect.addListener(() => {
    for (const [id, job] of jobs) if (job.page === page) finish(id);
  });
}

function onYouTube(yt, id) {
  const job = jobs.get(id);
  if (!job) return yt.disconnect();
  job.yt = yt;
  yt.onMessage.addListener((m) => {
    if (m.type === 'needClick' && job.tabId != null) {
      // lecture automatique refusée par le navigateur : on montre l'onglet pour un clic sur Lecture
      void api.tabs.update(job.tabId, { active: true, muted: false });
    }
    if (m.type === 'progress' || m.type === 'chunk' || m.type === 'needClick') {
      job.page.postMessage(m.type === 'needClick' ? { type: 'progress', fraction: 0, label: 'Cliquez sur ▶ Lecture dans l’onglet YouTube ouvert.' } : m);
    } else if (m.type === 'done' || m.type === 'error') {
      job.page.postMessage(m);
      finish(id);
    }
  });
  yt.onDisconnect.addListener(() => {
    if (jobs.has(id)) {
      job.page.postMessage({ type: 'error', error: 'L’onglet YouTube a été fermé avant la fin de l’écoute.' });
      finish(id);
    }
  });
}

function finish(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  try {
    job.yt?.disconnect();
  } catch {}
  if (job.tabId != null) void api.tabs.remove(job.tabId).catch(() => {});
}

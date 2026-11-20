// Dans l'onglet YouTube ouvert par l'extension : fait jouer la vidéo du début à la fin et enregistre son son
// (publicités exclues), puis l'envoie à EnjoySing. Ne fait rien dans les onglets YouTube ordinaires.
(() => {
  const id = new URLSearchParams(location.search).get('enjoysing_capture');
  if (!id) return;
  const api = globalThis.browser ?? globalThis.chrome;
  const port = api.runtime.connect({ name: `yt-capture:${id}` });
  const send = (m) => {
    try {
      port.postMessage(m);
    } catch {}
  };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const isAd = () => !!document.querySelector('.ad-showing, .ad-interrupting');
  let stopped = false;
  port.onDisconnect.addListener(() => (stopped = true));

  const waitFor = (fn, ms = 20000) =>
    new Promise((ok, ko) => {
      const t0 = Date.now();
      const tick = () => {
        if (stopped) return ko(new Error('annulé'));
        const v = fn();
        if (v) return ok(v);
        if (Date.now() - t0 > ms) return ko(new Error('La vidéo ne se charge pas dans l’onglet YouTube.'));
        setTimeout(tick, 250);
      };
      tick();
    });

  async function skipAds(video) {
    while (isAd() && !stopped) {
      document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();
      if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.max(0, video.duration - 0.1);
      send({ type: 'progress', fraction: 0, label: 'Publicité YouTube en cours…' });
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function run() {
    const video = await waitFor(() => document.querySelector('video.html5-main-video') ?? document.querySelector('video'));
    await waitFor(() => Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1, 30000);
    await skipAds(video);
    const duration = video.duration;
    video.pause();
    video.currentTime = 0;
    video.playbackRate = 1;
    video.muted = false;
    video.volume = 1;
    try {
      await video.play();
    } catch {
      send({ type: 'needClick' });
      await waitFor(() => !video.paused, 120000);
    }
    const stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    const audioOnly = new MediaStream(stream.getAudioTracks());
    if (!audioOnly.getAudioTracks().length) throw new Error('Aucun son récupérable dans cette vidéo.');
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(audioOnly, { mimeType: mime, audioBitsPerSecond: 128000 });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.start(1000);

    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (stopped) {
          clearInterval(timer);
          rec.stop();
          return reject(new Error('annulé'));
        }
        // publicité au milieu : on met l'enregistrement en pause
        if (isAd()) {
          if (rec.state === 'recording') rec.pause();
          document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();
          return;
        }
        if (rec.state === 'paused') rec.resume();
        if (video.paused && !video.ended) void video.play().catch(() => {});
        const t = video.currentTime;
        send({ type: 'progress', fraction: Math.min(1, t / duration), label: `Écoute de la chanson par l’extension… ${fmt(t)} / ${fmt(duration)}` });
        if (video.ended || t >= duration - 0.3) {
          clearInterval(timer);
          video.pause(); // pas de vidéo suivante
          rec.onstop = resolve;
          rec.stop();
        }
      }, 500);
    });

    const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
    send({ type: 'progress', fraction: 1, label: 'Envoi du son à EnjoySing…' });
    // envoi par morceaux (base64 : les messages de l'extension sont du JSON)
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 3 * 256 * 1024;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      let s = '';
      const part = bytes.subarray(i, i + CHUNK);
      for (let j = 0; j < part.length; j += 8192) s += String.fromCharCode.apply(null, part.subarray(j, j + 8192));
      send({ type: 'chunk', data: btoa(s) });
    }
    send({ type: 'done', mime: blob.type });
  }

  run().catch((e) => send({ type: 'error', error: e.message }));
})();

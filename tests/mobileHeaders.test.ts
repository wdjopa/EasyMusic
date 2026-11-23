import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' });

describe('requêtes YouTube depuis le téléphone', async () => {
  const { youtubeHeaders } = await import('../src/native/youtubeMobile');
  it('API YouTube : origine youtube.com (pas tauri.localhost) et un vrai User-Agent', () => {
    const h = youtubeHeaders('https://www.youtube.com/youtubei/v1/player', { headers: { 'X-Youtube-Client-Name': '1' } });
    expect(h.get('origin')).toBe('https://www.youtube.com');
    expect(h.get('user-agent')).toContain('Android');
  });
  it('garde le User-Agent fixé par youtubei.js (client ANDROID_VR) et celui de la TV', () => {
    expect(youtubeHeaders('https://www.youtube.com/youtubei/v1/player', { headers: { 'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1' } }).get('user-agent')).toMatch(/oculus/);
    expect(youtubeHeaders('https://www.youtube.com/youtubei/v1/player', { headers: { 'X-Youtube-Client-Name': '7' } }).get('user-agent')).toMatch(/Cobalt/);
  });
  it('flux googlevideo : en-tête Origin retiré (valeur vide)', () => {
    expect(youtubeHeaders('https://rr1---sn-x.googlevideo.com/videoplayback?x=1').get('origin')).toBe('');
  });
  it('ne touche pas aux autres sites', () => {
    expect(youtubeHeaders('https://enjoysing.resub.me/api/health').has('origin')).toBe(false);
  });
});

describe('réseau instable sur le téléphone', async () => {
  const { withNetworkRetry } = await import('../src/native/youtubeMobile');
  const noWait = async () => {};
  it('réessaie une erreur réseau puis réussit', async () => {
    let n = 0;
    const r = await withNetworkRetry(async () => {
      if (++n < 3) throw new Error('error sending request for url (https://www.youtube.com/iframe_api)');
      return 'ok';
    }, 'https://www.youtube.com/iframe_api', 3, noWait);
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('message clair si le réseau reste coupé', async () => {
    await expect(withNetworkRetry(async () => { throw new Error('error sending request for url (x)'); }, 'https://www.youtube.com/iframe_api', 3, noWait)).rejects.toThrow(/www\.youtube\.com impossible depuis le téléphone/);
  });
  it('ne réessaie pas une vraie réponse d’erreur de YouTube', async () => {
    let n = 0;
    await expect(withNetworkRetry(async () => { n++; throw new Error('Request failed with status code 403'); }, 'https://x', 3, noWait)).rejects.toThrow(/403/);
    expect(n).toBe(1);
  });
});

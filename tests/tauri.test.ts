// Fournisseur d'audio de l'app ordinateur (src/native/tauri.ts), avec un faux pont Tauri.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let handler: (cmd: string, args: Record<string, unknown>) => Promise<unknown> = async () => null;

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class<T> {
    onmessage: (m: T) => void = () => {};
  },
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return handler(cmd, args);
  },
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
// le module audioProvider touche à window au chargement
vi.stubGlobal('window', { addEventListener() {}, postMessage() {} });
vi.stubGlobal('location', { origin: 'tauri://localhost' });

const { desktopProvider, isDesktop, isExternalLink } = await import('../src/native/tauri');

beforeEach(() => {
  calls.length = 0;
});

describe('fournisseur tauri-desktop', () => {
  it('se présente comme prioritaire', () => {
    const p = desktopProvider();
    expect(p.id).toBe('tauri-desktop');
    expect(p.priority).toBe('first');
  });

  it('transmet la progression et renvoie l’audio avec son type', async () => {
    handler = async (cmd, args) => {
      expect(cmd).toBe('yt_download');
      const ch = args.onEvent as { onmessage: (m: unknown) => void };
      ch.onmessage({ type: 'progress', fraction: 0.5, label: 'Téléchargement de l’audio… 50 %' });
      ch.onmessage({ type: 'done', mime: 'audio/webm' });
      return new Uint8Array([1, 2, 3]).buffer;
    };
    const seen: [number, string][] = [];
    const blob = await desktopProvider().fetchAudio('dQw4w9WgXcQ', (f, l) => seen.push([f, l]));
    expect(seen).toEqual([[0.5, 'Téléchargement de l’audio… 50 %']]);
    expect(blob.type).toBe('audio/webm');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls[0].args.videoId).toBe('dQw4w9WgXcQ');
  });

  it('accepte aussi un tableau de nombres', async () => {
    handler = async () => [7, 8];
    const blob = await desktopProvider().fetchAudio('dQw4w9WgXcQ', () => {});
    expect(blob.size).toBe(2);
  });

  it('annule le téléchargement natif', async () => {
    const signal = { cancelled: false };
    let finish: (e: Error) => void = () => {};
    handler = (cmd) => {
      if (cmd === 'yt_cancel') {
        finish(new Error('annulé'));
        return Promise.resolve(null);
      }
      return new Promise((_, reject) => (finish = reject));
    };
    const p = desktopProvider().fetchAudio('dQw4w9WgXcQ', () => {}, signal);
    signal.cancelled = true;
    await expect(p).rejects.toThrow('annulé');
    const cancel = calls.find((c) => c.cmd === 'yt_cancel');
    expect(cancel?.args.reqId).toBe(calls[0].args.reqId);
  });

  it('transforme les erreurs du natif (chaînes) en Error', async () => {
    handler = async () => {
      throw 'Vidéo indisponible ou privée.';
    };
    await expect(desktopProvider().fetchAudio('dQw4w9WgXcQ', () => {})).rejects.toThrow('Vidéo indisponible ou privée.');
    await expect(desktopProvider().fetchInfo!('dQw4w9WgXcQ')).rejects.toBeInstanceOf(Error);
  });

  it('donne les infos de la vidéo', async () => {
    const info = { title: 'T', author: 'A', duration: 3, thumbnail: 'x', embeddable: false };
    handler = async (cmd) => (cmd === 'yt_info' ? info : null);
    expect(await desktopProvider().fetchInfo!('dQw4w9WgXcQ')).toEqual(info);
  });
});

describe('contexte de l’app', () => {
  it('distingue ordinateur et mobile', () => {
    expect(isDesktop('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130')).toBe(true);
    expect(isDesktop('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')).toBe(true);
    expect(isDesktop('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36')).toBe(false);
    expect(isDesktop('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(false);
  });

  it('ouvre les liens externes dans le navigateur', () => {
    const app = 'tauri://localhost';
    expect(isExternalLink({ protocol: 'https:', target: '_blank', origin: 'https://www.youtube.com' }, app)).toBe(true);
    expect(isExternalLink({ protocol: 'https:', target: '', origin: 'https://lrclib.net' }, app)).toBe(true);
    expect(isExternalLink({ protocol: 'blob:', target: '', origin: app }, app)).toBe(false);
    expect(isExternalLink({ protocol: 'http:', target: '', origin: 'http://tauri.localhost' }, 'http://tauri.localhost')).toBe(false);
  });
});

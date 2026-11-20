// Ordre des sources d'une analyse (src/ui/obtain.ts) avec un fournisseur local prioritaire (app ordinateur).
import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { addEventListener() {}, postMessage() {} });
vi.stubGlobal('location', { origin: 'tauri://localhost' });
vi.mock('../src/ui/api', () => ({
  catalogueSong: async () => null,
  videoInfo: async () => null,
  analyzeVideo: async () => {
    throw new Error('Serveur injoignable : vérifiez votre connexion.');
  },
}));
vi.mock('../src/ui/audioStore', () => ({ putAudio: async () => {} }));

const { registerAudioProvider } = await import('../src/ui/audioProvider');
const { obtainSong } = await import('../src/ui/obtain');

describe('obtainSong avec un fournisseur prioritaire', () => {
  it('garde la raison locale quand le serveur échoue aussi', async () => {
    const fetchAudio = vi.fn(async () => {
      throw new Error('YouTube demande une vérification anti-robot pour cette connexion.');
    });
    registerAudioProvider({ id: 'tauri-desktop', label: 'yt-dlp', priority: 'first', fetchAudio });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(obtainSong('jNQXAC9IVRw', () => {})).rejects.toThrow(
      'YouTube demande une vérification anti-robot pour cette connexion. (serveur : Serveur injoignable : vérifiez votre connexion.)',
    );
    expect(fetchAudio).toHaveBeenCalledOnce();
  });
});

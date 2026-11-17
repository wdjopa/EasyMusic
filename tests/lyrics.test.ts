import { describe, expect, it } from 'vitest';
import { findLyrics, pickBest } from '../server/lyrics';
import { cleanTitle, parseLrc } from '../src/shared/lyrics';

describe('paroles', () => {
  it('lit le format LRC', () => {
    const l = parseLrc('[ar:Ed Sheeran]\n[00:16.80] Loving can hurt\n[00:21.24] Loving can hurt sometimes\n[01:02.5][02:10.00] Refrain\n[03:00.00]');
    expect(l.map((x) => x.text)).toEqual(['Loving can hurt', 'Loving can hurt sometimes', 'Refrain', 'Refrain', '']);
    expect(l[0].time).toBeCloseTo(16.8);
    expect(l[2].time).toBeCloseTo(62.5);
  });

  it.each([
    ['Ed Sheeran - Photograph (Official Music Video)', 'Ed Sheeran', 'Ed Sheeran', 'Photograph'],
    ['Lewis Capaldi - Someone You Loved', 'LewisCapaldiVEVO', 'Lewis Capaldi', 'Someone You Loved'],
    ['Stromae - Alors On Danse (Clip Officiel)', 'StromaeVEVO', 'Stromae', 'Alors On Danse'],
    ['Photograph', 'Ed Sheeran - Topic', 'Ed Sheeran', 'Photograph'],
    ['Angèle - Balance Ton Quoi [CLIP OFFICIEL]', 'Angèle', 'Angèle', 'Balance Ton Quoi'],
    ['Shape of You (Lyrics) ft. Someone', 'Ed Sheeran', 'Ed Sheeran', 'Shape of You'],
  ])('nettoie « %s »', (title, author, artist, track) => {
    const r = cleanTitle(title, author);
    expect(r.artist).toBe(artist);
    expect(r.track).toBe(track);
  });

  it('préfère les paroles synchronisées à la bonne durée', () => {
    const best = pickBest(
      [
        { trackName: 'a', artistName: 'x', duration: 258, plainLyrics: 'texte' },
        { trackName: 'b', artistName: 'x', duration: 300, syncedLyrics: '[00:01.00] b' },
        { trackName: 'c', artistName: 'x', duration: 262, syncedLyrics: '[00:01.00] c' },
        { trackName: 'd', artistName: 'x', duration: 261, instrumental: true },
      ],
      260,
    );
    expect(best?.trackName).toBe('c');
  });

  it('refuse des paroles d’un autre morceau', async () => {
    const fake = async () =>
      new Response(JSON.stringify([{ trackName: 'À ma place', artistName: 'Axel Bauer', duration: 250, syncedLyrics: '[00:01.00] x' }]));
    expect(await findLyrics({ title: 'Chanson A (Official Video)', author: 'Test' }, fake)).toBeNull();
    // mais accepte de petites différences d'écriture
    const ok = async () => new Response(JSON.stringify([{ trackName: 'Alors on danse', artistName: 'Stromae', duration: 207, syncedLyrics: '[00:07.35] Alors on' }]));
    expect(await findLyrics({ title: 'Stromae - Alors On Danse (Clip Officiel)', author: 'StromaeVEVO' }, ok)).not.toBeNull();
  });

  it('interroge LRCLIB avec le titre nettoyé', async () => {
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([{ trackName: 'Photograph', artistName: 'Ed Sheeran', duration: 259, syncedLyrics: '[00:16.80] Loving can hurt' }]));
    };
    const l = await findLyrics({ title: 'Ed Sheeran - Photograph (Official Music Video)', author: 'Ed Sheeran', duration: 260 }, fake);
    expect(urls[0]).toContain('track_name=Photograph');
    expect(urls[0]).toContain('artist_name=Ed+Sheeran');
    expect(l?.synced?.[0]).toEqual({ time: 16.8, text: 'Loving can hurt' });
  });
});

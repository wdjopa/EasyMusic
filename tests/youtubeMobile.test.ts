// Extraction YouTube des apps mobiles, testée avec des réponses FACTICES : le conteneur de test est
// bloqué par YouTube, la vraie récupération ne peut être vérifiée que sur un téléphone.
import { describe, expect, it } from 'vitest';
import { Utils } from 'youtubei.js';
import {
  buildEvalCode,
  chooseAudioFormat,
  downloadByChunks,
  extractAudio,
  infoFromYt,
  playabilityError,
  type FetchLike,
  type YtClient,
  type YtFormat,
  type YtLike,
  type YtVideoInfo,
} from '../src/native/youtubeMobile';

function fmt(itag: number, mime: string, extra: Partial<YtFormat> = {}): YtFormat {
  const url = `https://rr1.googlevideo.com/videoplayback?itag=${itag}`;
  return {
    itag,
    url,
    mime_type: mime,
    bitrate: 130_000,
    content_length: 2_500_000,
    has_audio: mime.startsWith('audio') || mime.includes('mp4a'),
    has_video: mime.startsWith('video'),
    decipher: async () => url,
    ...extra,
  };
}
// formats typiques d'une réponse /player (adaptatifs)
const FORMATS = [
  fmt(137, 'video/mp4; codecs="avc1.640028"'),
  fmt(18, 'video/mp4; codecs="avc1.42001E, mp4a.40.2"'),
  fmt(251, 'audio/webm; codecs="opus"', { bitrate: 160_000 }),
  fmt(250, 'audio/webm; codecs="opus"', { bitrate: 70_000 }),
  fmt(139, 'audio/mp4; codecs="mp4a.40.5"', { bitrate: 49_000 }),
  fmt(140, 'audio/mp4; codecs="mp4a.40.2"', { bitrate: 130_000 }),
];

describe('choix du format audio', () => {
  it('prend le m4a/AAC itag 140 sur iOS (WKWebView ne décode pas opus)', () => {
    expect(chooseAudioFormat(FORMATS, { allowOpus: false })?.itag).toBe(140);
  });
  it('préfère aussi 140 sur Android, mais accepte opus s’il est seul', () => {
    expect(chooseAudioFormat(FORMATS, { allowOpus: true })?.itag).toBe(140);
    const opusSeul = FORMATS.filter((f) => !f.mime_type.startsWith('audio/mp4'));
    expect(chooseAudioFormat(opusSeul, { allowOpus: true })?.itag).toBe(251);
    expect(chooseAudioFormat(opusSeul, { allowOpus: false })).toBeNull();
  });
  it('écarte les pistes doublées et la version « drc »', () => {
    const multi = [
      fmt(140, 'audio/mp4; codecs="mp4a.40.2"', { is_dubbed: true }),
      fmt(140, 'audio/mp4; codecs="mp4a.40.2"', { is_original: true, url: 'https://x/orig' }),
      fmt(140, 'audio/mp4; codecs="mp4a.40.2"', { is_drc: true, is_original: true }),
    ];
    expect(chooseAudioFormat(multi, { allowOpus: false })?.url).toBe('https://x/orig');
  });
  it('accepte un format à signature chiffrée (sans url directe)', () => {
    const f = { ...fmt(140, 'audio/mp4; codecs="mp4a.40.2"'), url: undefined, signature_cipher: 's=abc&sp=sig&url=https%3A%2F%2Fx' };
    expect(chooseAudioFormat([f], { allowOpus: false })?.itag).toBe(140);
  });
});

describe('infos et lisibilité', () => {
  it('extrait titre, auteur, durée, miniature, intégration', () => {
    const info: YtVideoInfo = {
      basic_info: {
        title: 'Ma chanson',
        author: 'Artiste - Topic',
        duration: 215,
        thumbnail: [
          { url: 'https://i.ytimg.com/maxres.jpg', width: 1280, height: 720 },
          { url: 'https://i.ytimg.com/hq.jpg', width: 480, height: 360 },
          { url: 'https://i.ytimg.com/def.jpg', width: 120, height: 90 },
        ],
      },
      playability_status: { status: 'OK', embeddable: false },
    };
    expect(infoFromYt(info)).toEqual({ title: 'Ma chanson', author: 'Artiste', duration: 215, thumbnail: 'https://i.ytimg.com/hq.jpg', embeddable: false });
  });
  it('explique les refus', () => {
    expect(playabilityError({ basic_info: {}, playability_status: { status: 'OK' } })).toBeNull();
    expect(playabilityError({ basic_info: {}, playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } })).toMatch(/robot/);
    expect(playabilityError({ basic_info: {}, playability_status: { status: 'UNPLAYABLE', reason: 'Vidéo privée' } })).toBe('Vidéo privée');
  });
});

/** Faux googlevideo : sert `data` selon le paramètre range=début-fin. */
function fakeGooglevideo(data: Uint8Array, opts: { status?: number; failOnce?: boolean } = {}) {
  const calls: string[] = [];
  let failed = false;
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    if (opts.status) return new Response('', { status: opts.status });
    if (opts.failOnce && !failed) {
      failed = true;
      throw new Error('connexion perdue');
    }
    const [a, b] = new URL(url).searchParams.get('range')!.split('-').map(Number);
    return new Response(data.slice(a, b + 1), { status: 200 });
  };
  return { fetchFn, calls };
}
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe('téléchargement par morceaux', () => {
  it('assemble les plages, suit la progression', async () => {
    const data = bytes(2500);
    const { fetchFn, calls } = fakeGooglevideo(data);
    const prog: number[] = [];
    const parts = await downloadByChunks('https://g/videoplayback?itag=140', data.length, fetchFn, (f) => prog.push(f), undefined, 1000);
    expect(calls.map((c) => new URL(c).searchParams.get('range'))).toEqual(['0-999', '1000-1999', '2000-2499']);
    expect(Buffer.concat(parts)).toEqual(Buffer.from(data));
    expect(prog).toEqual([0.4, 0.8, 1]);
  });
  it('sans taille connue, s’arrête au morceau incomplet', async () => {
    const data = bytes(1500);
    const { fetchFn, calls } = fakeGooglevideo(data);
    const parts = await downloadByChunks('https://g/v', undefined, fetchFn, () => {}, undefined, 1000);
    expect(calls).toHaveLength(2);
    expect(Buffer.concat(parts).length).toBe(1500);
  });
  it('réessaie une fois après une coupure réseau', async () => {
    const { fetchFn } = fakeGooglevideo(bytes(500), { failOnce: true });
    const parts = await downloadByChunks('https://g/v', 500, fetchFn, () => {}, undefined, 1000);
    expect(Buffer.concat(parts).length).toBe(500);
  });
  it('s’arrête quand on annule', async () => {
    const data = bytes(3000);
    const signal = { cancelled: false };
    const { fetchFn, calls } = fakeGooglevideo(data);
    const p = downloadByChunks('https://g/v', data.length, fetchFn, () => (signal.cancelled = true), signal, 1000);
    await expect(p).rejects.toThrow('annulé');
    expect(calls).toHaveLength(1);
  });
});

/** Faux youtubei.js : une réponse par client. */
function fakeYt(byClient: Partial<Record<YtClient, YtVideoInfo | Error>>) {
  const asked: { client: YtClient; po_token?: string }[] = [];
  const yt: YtLike = {
    session: { player: {} },
    async getBasicInfo(_id, o) {
      asked.push(o);
      const r = byClient[o.client];
      if (!r) throw new Error('client inconnu');
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { yt, asked };
}
const ok = (formats: YtFormat[]): YtVideoInfo => ({
  basic_info: { title: 'T', author: 'A', duration: 100 },
  playability_status: { status: 'OK', embeddable: true },
  streaming_data: { formats: [], adaptive_formats: formats },
});

describe('extraction complète (clients successifs)', () => {
  const data = bytes(3000);
  const m4a = (url: string) => fmt(140, 'audio/mp4; codecs="mp4a.40.2"', { content_length: data.length, url, decipher: async () => url });

  it('ANDROID_VR suffit dans le cas normal', async () => {
    const { yt, asked } = fakeYt({ ANDROID_VR: ok([m4a('https://g/vr')]) });
    const { fetchFn } = fakeGooglevideo(data);
    const r = await extractAudio('abcdefghijk', { yt, fetch: fetchFn, ios: true }, () => {});
    expect(r.client).toBe('ANDROID_VR');
    expect(r.itag).toBe(140);
    expect(r.blob.type).toBe('audio/mp4');
    expect(r.blob.size).toBe(3000);
    expect(r.info.title).toBe('T');
    expect(asked.map((a) => a.client)).toEqual(['ANDROID_VR']);
  });

  it('passe au client suivant si YouTube refuse (robot, 403), avec jeton PO pour MWEB', async () => {
    const robot: YtVideoInfo = { basic_info: {}, playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
    const { yt, asked } = fakeYt({ ANDROID_VR: robot, TV: ok([m4a('https://g/tv-403')]), MWEB: ok([m4a('https://g/mweb')]) });
    const fetchFn: FetchLike = async (url) =>
      url.includes('tv-403') ? new Response('', { status: 403 }) : fakeGooglevideo(data).fetchFn(url);
    const r = await extractAudio('abcdefghijk', { yt, fetch: fetchFn, ios: false, poToken: async () => 'JETON' }, () => {});
    expect(r.client).toBe('MWEB');
    expect(asked).toEqual([{ client: 'ANDROID_VR' }, { client: 'TV' }, { client: 'MWEB', po_token: 'JETON' }]);
    expect(yt.session.player?.po_token).toBe('JETON'); // ajouté aux adresses (pot=) par youtubei.js
  });

  it('s’arrête tout de suite pour une vidéo supprimée ou privée', async () => {
    const { yt, asked } = fakeYt({ ANDROID_VR: { basic_info: {}, playability_status: { status: 'ERROR', reason: 'Cette vidéo n’est plus disponible' } } });
    await expect(extractAudio('abcdefghijk', { yt, fetch: async () => new Response(''), ios: true }, () => {})).rejects.toThrow('plus disponible');
    expect(asked).toHaveLength(1);
  });

  it('résume les échecs de chaque client', async () => {
    const { yt } = fakeYt({ ANDROID_VR: ok([]), TV: new Error('réseau') });
    await expect(extractAudio('abcdefghijk', { yt, fetch: async () => new Response(''), ios: true, clients: ['ANDROID_VR', 'TV'] }, () => {})).rejects.toThrow(
      /ANDROID_VR : aucun format audio lisible ; TV : réseau/,
    );
  });
});

describe('déchiffrage', () => {
  it('appelle process(n, sp, s) ajouté par youtubei.js au code du lecteur', () => {
    // imite la sortie de youtubei.js : fonctions extraites du lecteur + process()
    const output = `
      var exportedVars = { nsigFunction: (url, sp, s) => {
        const u = new URL(url);
        const map = new Map([['n', u.searchParams.get('n').split('').reverse().join('')]]);
        if (s) map.set(sp, s.toUpperCase());
        return { get: (k) => map.get(k) };
      } };
      function process(n = "", sp = "", s = "") {
        const o = exportedVars.nsigFunction("https://x/?n=" + encodeURIComponent(n), sp, s);
        return { n: o.get('n'), sig: o.get(sp) };
      }`;
    const code = buildEvalCode(output, { n: 'abc"\\', sp: 'sig', sig: 'xyz' });
    expect(new Function(code)()).toEqual({ n: '\\"cba', sig: 'XYZ' });
  });

  it('respecte le contrat de process() de la version installée de youtubei.js', () => {
    // fonction « nsig » factice dans le style du lecteur YouTube (objet URL avec get/set)
    const output = `class FauxUrl {
      constructor(url, sp, s) { this.p = new URL(url).searchParams; if (s) this.p.set(sp, s.split('').reverse().join('')); }
      get(k) { return this.p.get(k); }
      set(k, v) { this.p.set(k, v); }
      transformN() { this.p.set('n', this.p.get('n') + '!'); }
    }
    var exportedVars = { nsigFunction: (url, sp, s) => new FauxUrl(url, sp, s) };`;
    // youtubei.js génère le code avec les valeurs (comme Player.decipher) ; l'env est redondant
    const code = buildEvalCode(`${output}\n${Utils.getNsigProcessorFn('abc', 'sig', '123')}`, { n: 'abc', sp: 'sig', sig: '123' });
    expect(new Function(code)()).toEqual({ n: 'abc!', sig: '321' });
  });
});

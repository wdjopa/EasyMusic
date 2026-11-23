import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragmentedMp4ToAdts, isFragmentedMp4 } from '../src/dsp/fmp4';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const duration = (file: string) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

describe.skipIf(!hasFfmpeg)('m4a fragmenté (DASH YouTube) -> AAC ADTS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmp4-'));
  const frag = join(dir, 'frag.m4a');
  const plain = join(dir, 'plain.m4a');
  // 20 s de son, en m4a fragmenté façon DASH (fragments de 2 s) et en m4a classique
  const src = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-ac', '2', '-c:a', 'aac', '-b:a', '128k'];
  execFileSync('ffmpeg', ['-v', 'error', ...src, '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', '-y', frag]);
  execFileSync('ffmpeg', ['-v', 'error', ...src, '-y', plain]);

  it('reconnaît le MP4 fragmenté', () => {
    expect(isFragmentedMp4(readFileSync(frag))).toBe(true);
    expect(isFragmentedMp4(readFileSync(plain))).toBe(false);
  });

  it('convertit TOUT le son (pas seulement le premier fragment), sans réencodage', () => {
    const adts = fragmentedMp4ToAdts(readFileSync(frag));
    expect(adts).not.toBeNull();
    const out = join(dir, 'out.aac');
    writeFileSync(out, adts!);
    // décodage complet : la durée doit être celle du fichier d'origine
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 's16le', '-ac', '1', '-ar', '8000', '-']);
    expect(pcm.length / 2 / 8000).toBeGreaterThan(19.5);
    expect(Math.abs(duration(out) - 20)).toBeLessThan(0.6);
  });

  it('laisse les fichiers non fragmentés tels quels', () => {
    expect(fragmentedMp4ToAdts(readFileSync(plain))).toBeNull();
  });
});

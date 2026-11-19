import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, movePanel, normalize } from '../src/ui/layout';

describe('disposition des cartes', () => {
  it('monte, descend et change de colonne', () => {
    let l = structuredClone(DEFAULT_LAYOUT);
    l = movePanel(l, 'micro', 'up');
    expect(l.cols[1]).toEqual(['settings', 'micro', 'sheet']);
    l = movePanel(l, 'settings', 'up'); // déjà en haut : rien ne change
    expect(l.cols[1]).toEqual(['settings', 'micro', 'sheet']);
    l = movePanel(l, 'micro', 'other');
    expect(l.cols).toEqual([['video', 'now', 'micro'], ['settings', 'sheet']]);
  });

  it('répare une disposition enregistrée incomplète ou en double', () => {
    const l = normalize({ cols: [['now', 'now', 'inconnue' as never], ['sheet']], collapsed: ['micro', 'x' as never] });
    expect(l.cols[0]).toEqual(['now', 'video']);
    expect(l.cols[1]).toEqual(['sheet', 'settings', 'micro']);
    expect(l.collapsed).toEqual(['micro']);
  });
});

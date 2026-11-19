// Disposition des cartes de l'espace de jeu : ordre dans 2 colonnes, cartes réduites. Retenue dans le navigateur.

export type PanelId = 'video' | 'now' | 'settings' | 'sheet' | 'micro';

export interface LayoutState {
  cols: PanelId[][];
  collapsed: PanelId[];
}

export const DEFAULT_LAYOUT: LayoutState = {
  cols: [
    ['video', 'now'],
    ['settings', 'sheet', 'micro'],
  ],
  collapsed: [],
};

const KEY = 'easymusic.layout.v1';
const ALL: PanelId[] = ['video', 'now', 'settings', 'sheet', 'micro'];

/** Disposition enregistrée, complétée si une carte manque (nouvelle version de l'app). */
export function loadLayout(): LayoutState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null') as LayoutState | null;
    if (raw && Array.isArray(raw.cols) && raw.cols.length === 2) return normalize(raw);
  } catch {
    /* disposition par défaut */
  }
  return structuredClone(DEFAULT_LAYOUT);
}

export function normalize(l: LayoutState): LayoutState {
  const seen = new Set<PanelId>();
  const cols = l.cols.map((c) => c.filter((id) => ALL.includes(id) && !seen.has(id) && seen.add(id)));
  for (const id of ALL) if (!seen.has(id)) cols[DEFAULT_LAYOUT.cols[0].includes(id) ? 0 : 1].push(id);
  return { cols, collapsed: (l.collapsed ?? []).filter((id) => ALL.includes(id)) };
}

function save(l: LayoutState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* sans importance */
  }
}

/** Déplace une carte : dans sa colonne (delta ±1) ou vers l'autre colonne (en fin de liste). */
export function movePanel(l: LayoutState, id: PanelId, how: 'up' | 'down' | 'other'): LayoutState {
  const out = structuredClone(l);
  const c = out.cols.findIndex((col) => col.includes(id));
  const i = out.cols[c].indexOf(id);
  if (how === 'other') {
    out.cols[c].splice(i, 1);
    out.cols[1 - c].push(id);
  } else {
    const j = how === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= out.cols[c].length) return out;
    [out.cols[c][i], out.cols[c][j]] = [out.cols[c][j], out.cols[c][i]];
  }
  return out;
}

export class Layout {
  state = loadLayout();
  private root: HTMLElement;
  private onMove: (id: PanelId) => void;
  private onChange: () => void;

  constructor(root: HTMLElement, opts: { onMove: (id: PanelId) => void; onChange: () => void }) {
    this.root = root;
    this.onMove = opts.onMove;
    this.onChange = opts.onChange;
    for (const panel of this.panels()) this.wire(panel);
    this.apply(true);
    document.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.ph-menu, .ph-menu-btn')) this.closeMenus();
    });
  }

  private panels(): HTMLElement[] {
    return [...this.root.querySelectorAll<HTMLElement>('.panel')];
  }
  private panel(id: PanelId): HTMLElement {
    return this.root.querySelector<HTMLElement>(`.panel[data-panel="${id}"]`)!;
  }
  private col(i: number): HTMLElement {
    return this.root.querySelector<HTMLElement>(`.col[data-col="${i}"]`)!;
  }

  isCollapsed(id: PanelId) {
    return this.state.collapsed.includes(id);
  }

  /** Place les cartes selon l'état. Seules les cartes réellement déplacées changent de place dans la page. */
  private apply(initial = false) {
    const moved: PanelId[] = [];
    this.state.cols.forEach((ids, c) => {
      const col = this.col(c);
      ids.forEach((id, i) => {
        const el = this.panel(id);
        if (col.children[i] !== el) {
          // déplacer les AUTRES cartes plutôt que la vidéo quand c'est possible (déplacer un lecteur YouTube le recharge)
          col.insertBefore(el, col.children[i] ?? null);
          if (!initial) moved.push(id);
        }
      });
    });
    for (const p of this.panels()) {
      const id = p.dataset.panel as PanelId;
      const collapsed = this.isCollapsed(id);
      p.classList.toggle('collapsed', collapsed);
      const t = p.querySelector<HTMLButtonElement>('.ph-toggle')!;
      t.textContent = collapsed ? '▸' : '▾';
      t.setAttribute('aria-expanded', String(!collapsed));
      t.setAttribute('aria-label', `${collapsed ? 'Déplier' : 'Réduire'} la carte « ${p.querySelector('.ph-title')!.textContent} »`);
    }
    for (const id of moved) this.onMove(id);
    if (!initial) this.onChange();
  }

  set(next: LayoutState) {
    this.state = normalize(next);
    save(this.state);
    this.apply();
  }

  toggle(id: PanelId) {
    const collapsed = this.isCollapsed(id) ? this.state.collapsed.filter((x) => x !== id) : [...this.state.collapsed, id];
    this.set({ ...this.state, collapsed });
  }

  reset() {
    this.set(structuredClone(DEFAULT_LAYOUT));
  }

  private closeMenus() {
    this.root.querySelectorAll('.ph-menu').forEach((m) => m.remove());
  }

  private wire(panel: HTMLElement) {
    const id = panel.dataset.panel as PanelId;
    panel.querySelector<HTMLButtonElement>('.ph-toggle')!.onclick = () => this.toggle(id);
    // double-clic sur la barre de titre : réduire / déplier
    panel.querySelector<HTMLElement>('.panel-head')!.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('button')) this.toggle(id);
    });
    // menu : monter, descendre, changer de colonne, disposition par défaut
    const menuBtn = panel.querySelector<HTMLButtonElement>('.ph-menu-btn')!;
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      const open = panel.querySelector('.ph-menu');
      this.closeMenus();
      if (open) return;
      const c = this.state.cols.findIndex((col) => col.includes(id));
      const i = this.state.cols[c].indexOf(id);
      const menu = document.createElement('div');
      menu.className = 'ph-menu';
      menu.setAttribute('role', 'menu');
      const items: [string, () => void, boolean][] = [
        ['↑ Monter', () => this.set(movePanel(this.state, id, 'up')), i > 0],
        ['↓ Descendre', () => this.set(movePanel(this.state, id, 'down')), i < this.state.cols[c].length - 1],
        [c === 0 ? '→ Colonne de droite' : '← Colonne de gauche', () => this.set(movePanel(this.state, id, 'other')), true],
        [this.isCollapsed(id) ? '▸ Déplier' : '▾ Réduire', () => this.toggle(id), true],
        ['↺ Disposition par défaut', () => this.reset(), true],
      ];
      for (const [label, run, enabled] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.textContent = label;
        b.disabled = !enabled;
        b.onclick = () => {
          this.closeMenus();
          run();
        };
        menu.append(b);
      }
      panel.querySelector('.ph-actions')!.append(menu);
      (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
    };
    this.wireDrag(panel, id);
  }

  /** Glisser-déposer par la poignée ⠿ (souris et doigt) : un repère montre où la carte va se placer. */
  private wireDrag(panel: HTMLElement, id: PanelId) {
    const handle = panel.querySelector<HTMLElement>('.ph-drag')!;
    let marker: HTMLElement | null = null;
    let target: { col: number; index: number } | null = null;

    const locate = (x: number, y: number) => {
      const cols = [0, 1].map((i) => this.col(i));
      // colonne sous le doigt (sur téléphone les colonnes sont l'une sous l'autre)
      let ci = cols.findIndex((c) => {
        const r = c.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top - 40 && y <= r.bottom + 40;
      });
      if (ci < 0) ci = cols.map((c) => Math.abs(c.getBoundingClientRect().left - x)).reduce((b, d, i, a) => (d < a[b] ? i : b), 0);
      const others = [...cols[ci].querySelectorAll<HTMLElement>(':scope > .panel')].filter((p) => p !== panel);
      let index = others.length;
      for (let i = 0; i < others.length; i++) {
        const r = others[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) {
          index = i;
          break;
        }
      }
      return { col: ci, index, before: others[index] ?? null, colEl: cols[ci] };
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      panel.classList.add('dragging');
      document.body.classList.add('dragging-panel');
      marker = document.createElement('div');
      marker.className = 'drop-marker';
    });
    handle.addEventListener('pointermove', (e) => {
      if (!marker) return;
      const loc = locate(e.clientX, e.clientY);
      target = { col: loc.col, index: loc.index };
      loc.colEl.insertBefore(marker, loc.before);
      // faire défiler la page près des bords
      if (e.clientY < 60) window.scrollBy(0, -12);
      else if (e.clientY > innerHeight - 60) window.scrollBy(0, 12);
    });
    const end = () => {
      if (!marker) return;
      marker.remove();
      marker = null;
      panel.classList.remove('dragging');
      document.body.classList.remove('dragging-panel');
      if (!target) return;
      const next = structuredClone(this.state);
      const from = next.cols.findIndex((c) => c.includes(id));
      next.cols[from].splice(next.cols[from].indexOf(id), 1);
      next.cols[target.col].splice(target.index, 0, id);
      target = null;
      if (JSON.stringify(next.cols) !== JSON.stringify(this.state.cols)) this.set(next);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // clavier : flèches haut / bas sur la poignée
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.set(movePanel(this.state, id, e.key === 'ArrowUp' ? 'up' : 'down'));
        handle.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.set(movePanel(this.state, id, 'other'));
        handle.focus();
      }
    });
  }
}

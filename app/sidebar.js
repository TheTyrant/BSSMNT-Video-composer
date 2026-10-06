// Modular tab sidebars (v2.1 D-42, reworked in v2.2 D-48).
//
// Each `.side-panel` section inside a sidebar's panel column is a tab: its
// data-num / data-label become a rail button. Sidebars only span the
// viewport row, so slide-outs never take space from the timeline.
//
//  - Everything starts closed (tabs-only rail).
//  - Clicking a tab opens its panel; clicking it again closes it.
//  - Up to `maxOpen` panels stack top-to-bottom in the order they were
//    opened. Opening one more closes the TOP (oldest) panel.
//  - No rail or arrow buttons: just the tabs, floating at the sidebar's
//    inner edge. Closed, a sidebar takes no width at all.
// Adding or reordering a tab is a one-place change in index.html.
class Sidebar {
  constructor(rootId, panelsId, railId, { maxOpen = 2 } = {}) {
    this.root = document.getElementById(rootId);
    this.rail = document.getElementById(railId);
    this.panels = Array.from(document.querySelectorAll(`#${panelsId} > .side-panel`));
    this.maxOpen = maxOpen;
    this.openTabs = [];        // top first
    this.lastOpen = [];
    this.buttons = new Map();
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); }

  init() {
    this.panels.forEach(panel => {
      const tab = panel.dataset.tab;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rail-tab';
      b.id = `tab-${tab}`;
      b.setAttribute('aria-controls', panel.id);
      b.innerHTML = `<span class="rail-num">${panel.dataset.num}</span><span class="rail-label">${panel.dataset.label}</span>`;
      b.addEventListener('click', () => this.toggle(tab));
      this.rail.appendChild(b);
      this.buttons.set(tab, b);
    });
    this.apply();
  }

  // Panels can be renamed in the page (data-tab / data-label) without
  // breaking code: code may use a panel's tab name or its usual name, which
  // is looked up by the panel's id (D-65).
  // Each entry: every name code may use, and every id the panel has had.
  static GROUPS = [
    { names: ['audio', 'input'], ids: ['panel-input', 'panel-audio'] },
    { names: ['assets', 'sound'], ids: ['customMediaSection'] },
    { names: ['output', 'file'], ids: ['panel-output'] },
    { names: ['text', 'overlays', 'effects'], ids: ['panel-overlays', 'panel-text'] },
    { names: ['autoedit'], ids: ['panel-autoedit'] },
  ];

  resolve(name) {
    if (this.panels.some(p => p.dataset.tab === name)) return name;
    const g = Sidebar.GROUPS.find(x => x.names.includes(name));
    const p = g && this.panels.find(x => g.ids.includes(x.id) || g.names.includes(x.dataset.tab));
    return p ? p.dataset.tab : name;
  }

  isOpen(tab) { return this.openTabs.includes(this.resolve(tab)); }

  toggle(tab) {
    tab = this.resolve(tab);
    if (this.isOpen(tab)) this.openTabs = this.openTabs.filter(t => t !== tab);
    else this.push(tab);
    this.apply();
  }

  // Programmatic open (e.g. selecting an asset opens 02 Assets). Leaves the
  // panel where it is if it's already open.
  open(tab) {
    tab = this.resolve(tab);
    if (!this.isOpen(tab)) this.push(tab);
    this.apply();
  }

  push(tab) {
    this.openTabs.push(tab);
    while (this.openTabs.length > this.maxOpen) this.openTabs.shift();   // close the top panel
  }

  closeAll() {
    if (this.openTabs.length) this.lastOpen = this.openTabs.slice();
    this.openTabs = [];
    this.apply();
  }

  toggleCollapsed() {
    if (this.openTabs.length) this.closeAll();
    else {
      this.openTabs = (this.lastOpen.length ? this.lastOpen : [this.panels[0].dataset.tab]).slice(-this.maxOpen);
      this.apply();
    }
  }

  apply() {
    const open = this.openTabs;
    this.root.classList.toggle('collapsed', open.length === 0);
    this.root.classList.toggle('stacked', open.length > 1);
    this.panels.forEach(p => {
      const i = open.indexOf(p.dataset.tab);
      p.hidden = i < 0;
      p.style.order = i < 0 ? '' : String(i);
    });
    this.buttons.forEach((b, tab) => {
      const on = open.includes(tab);
      const name = b.querySelector('.rail-label').textContent;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
      const key = this.panels.find(p => p.dataset.tab === tab).dataset.key;
      b.title = (on ? `Close ${name}` : `Open ${name}`) + (key ? ` (${key})` : '');
    });
    this.listeners.forEach(fn => fn(open.slice()));
  }
}

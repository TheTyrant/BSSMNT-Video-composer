// Modular tab sidebar (v2.1, D-42).
//
// Every `.side-panel` section inside #tabPanels is a tab: its data-num /
// data-label become a rail button, and only the open tab's panel shows.
// Adding or reordering a tab is a one-place change in index.html.
// Clicking the open tab (or the « button) collapses the sidebar to the
// tabs-only rail; clicking any tab while collapsed slides its panel out.
// The open tab and collapsed state are remembered per browser.
class Sidebar {
  constructor() {
    this.KEY = 'djv.sidebar';
    this.root = document.getElementById('sidebar');
    this.rail = document.getElementById('tabRail');
    this.panels = Array.from(document.querySelectorAll('#tabPanels > .side-panel'));
    this.buttons = new Map();
    this.state = { open: this.panels[0] && this.panels[0].dataset.tab, collapsed: false };
  }

  init() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.KEY) || 'null');
      if (saved && this.panels.some(p => p.dataset.tab === saved.open)) this.state = saved;
    } catch (e) { /* storage unavailable: use defaults */ }

    this.panels.forEach(panel => {
      const tab = panel.dataset.tab;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rail-tab';
      b.id = `tab-${tab}`;
      b.setAttribute('aria-controls', panel.id);
      b.innerHTML = `<span class="rail-num">${panel.dataset.num}</span><span class="rail-label">${panel.dataset.label}</span>`;
      b.addEventListener('click', () => this.onTab(tab));
      this.rail.appendChild(b);
      this.buttons.set(tab, b);
    });

    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'rail-collapse';
    collapse.id = 'sidebarCollapse';
    collapse.addEventListener('click', () => this.toggleCollapsed());
    this.rail.appendChild(collapse);
    this.collapseBtn = collapse;

    this.apply();
  }

  onTab(tab) {
    if (this.state.open === tab && !this.state.collapsed) this.state.collapsed = true;
    else { this.state.open = tab; this.state.collapsed = false; }
    this.apply();
  }

  open(tab) {
    this.state.open = tab;
    this.state.collapsed = false;
    this.apply();
  }

  toggleCollapsed() {
    this.state.collapsed = !this.state.collapsed;
    this.apply();
  }

  apply() {
    const { open, collapsed } = this.state;
    this.root.classList.toggle('collapsed', collapsed);
    this.panels.forEach(p => { p.hidden = p.dataset.tab !== open; });
    this.buttons.forEach((b, tab) => {
      const on = tab === open && !collapsed;
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
      b.title = on ? `Collapse ${b.textContent.slice(2)}` : `Open ${b.textContent.slice(2)}`;
    });
    this.collapseBtn.textContent = collapsed ? '»' : '«';
    this.collapseBtn.title = collapsed ? 'Expand sidebar' : 'Collapse to tabs';
    this.collapseBtn.setAttribute('aria-label', this.collapseBtn.title);
    try { localStorage.setItem(this.KEY, JSON.stringify(this.state)); } catch (e) { /* ignore */ }
  }
}

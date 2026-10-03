// Display size (D-63): the header SIZE picker. The viewport shows the frame
// at the chosen output shape (letterboxed), live, during playback or
// editing. "Original" fills the viewport as before.
//
// Breakpoints work like a responsive website: sizes with the same shape
// look identical (everything is laid out as fractions of the frame), so
// they share one layout. Base = landscape (16:9 and anything wider than
// 6:5); Vertical (narrower than 5:6) and Square (in between) can override
// it. Text layout (position, size, align, backing) set on a breakpoint
// applies there only; anything not set there inherits from Base.
class DisplaySize {
  static BREAKPOINTS = {
    base: { label: 'Base · landscape', short: 'Base' },
    vertical: { label: 'Vertical · 9:16', short: 'Vertical' },
    square: { label: 'Square · 1:1', short: 'Square' },
  };

  static bpFor(w, h) {
    const r = w / Math.max(1, h);
    if (r < 5 / 6) return 'vertical';
    if (r <= 6 / 5) return 'square';
    return 'base';
  }

  // Header menu entries: Original, then the export sizes.
  static options() {
    const out = [{ value: 'original', label: 'Original', short: 'ORIGINAL', w: 16, h: 10 }];
    Object.entries(OfflineRenderer.SIZES).forEach(([k, v]) => {
      const ratio = v.label.split('·')[1].trim();
      out.push({ value: k, label: v.label, short: `${k === 'vertical' || k === 'square' ? '' : k.toUpperCase() + ' '}${ratio}`.trim(), w: v.w, h: v.h });
    });
    return out;
  }

  // Small frame icon in the menu: the shape itself.
  static icon(w, h) {
    const s = 12 / Math.max(w, h);
    const bw = Math.max(3, w * s), bh = Math.max(3, h * s);
    return `<svg class="mode-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="${(16 - bw) / 2}" y="${(16 - bh) / 2}" width="${bw}" height="${bh}"/></svg>`;
  }

  constructor(app) {
    this.app = app;
    this.key = 'original';
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => fn(this.key)); }

  init() {
    this.container = document.querySelector('.visualizer-container');
    this.stage = document.getElementById('stage');
    if (!this.container || !this.stage) return;
    new ResizeObserver(() => this.layout()).observe(this.container);
    this.layout();
  }

  get size() { return OfflineRenderer.SIZES[this.key] || null; }

  // Breakpoint of what is on screen now.
  get breakpoint() {
    const s = this.size;
    if (s) return DisplaySize.bpFor(s.w, s.h);
    return this.container ? DisplaySize.bpFor(this.container.clientWidth, this.container.clientHeight) : 'base';
  }

  set(key) {
    if (key !== 'original' && !OfflineRenderer.SIZES[key]) key = 'original';
    if (key === this.key) return;
    this.key = key;
    this.layout();
    this.emit();
    if (this.app.project && !this.app.project.restoring) this.app.project.markDirty();
  }

  // Fit the stage inside the viewport at the chosen shape, centred.
  layout() {
    const c = this.container, st = this.stage;
    if (!c || !st) return;
    const s = this.size;
    c.classList.toggle('is-framed', !!s);
    if (!s) { st.style.left = st.style.top = '0px'; st.style.width = st.style.height = '100%'; return; }
    const cw = c.clientWidth, ch = c.clientHeight, pad = 12;
    const k = Math.min((cw - pad * 2) / s.w, (ch - pad * 2) / s.h);
    const w = Math.max(1, Math.floor(s.w * k)), h = Math.max(1, Math.floor(s.h * k));
    st.style.width = `${w}px`;
    st.style.height = `${h}px`;
    st.style.left = `${Math.floor((cw - w) / 2)}px`;
    st.style.top = `${Math.floor((ch - h) / 2)}px`;
  }
}

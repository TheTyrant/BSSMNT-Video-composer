// Text: titles, credits and general text (v2.4, D-60). The first piece of
// the overlay system (the rest is roadmap only).
//
// Text items sit on the master timeline and draw on top of every visual
// mode: in the viewport, in fullscreen, in the pop-out output window, and
// (later) in the offline renderer, all through one render() function. Sizes
// are fractions of the frame height, so text looks the same at any output
// resolution.
//
// Timing ("lock"): start  = from the beginning (+ optional offset)
//                  end    = the last <duration> seconds of the track
//                  time   = at an exact time on the timeline
// In live mode there is no end, so End-locked items play when "Show now"
// is pressed.
class TextOverlay {
  static FONTS = {
    display: '"Boldonse", "Inter Tight", "Segoe UI", sans-serif',
    sans: '"Inter Tight", "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", Consolas, monospace',
    serif: 'Georgia, "Times New Roman", serif',
  };
  static SIZES = { s: 0.035, m: 0.05, l: 0.07, xl: 0.11 };

  static defaults(kind) {
    const base = {
      kind, anchor: 'time', start: 0, duration: 4, firedAt: null,
      style: { font: 'sans', size: 'l', color: '#ffffff', align: 'center', position: 'lower', plate: 'shadow' },
      anim: 'fade',
    };
    if (kind === 'title') return { ...base, anchor: 'start', start: 0, duration: 5, content: 'TITLE\nSubtitle',
      style: { ...base.style, font: 'display', size: 'xl', position: 'center' } };
    if (kind === 'credits') return { ...base, anchor: 'end', duration: 15, anim: 'roll',
      content: '# Credits\n\nDirected by\nYour Name\n\nMusic\nArtist — Track\n\nThanks for watching',
      style: { ...base.style, font: 'sans', size: 'm', position: 'center' } };
    return { ...base, content: 'Your text', style: { ...base.style, plate: 'plate', align: 'left' } };
  }

  constructor(app) {
    this.app = app;
    this.items = [];
    this.nextId = 1;
    this.selectedId = null;
    this.listeners = new Set();
    this.boxes = new Map();     // on-screen bounds per item (viewport), for the drag handle
  }

  on(fn) { this.listeners.add(fn); }
  emit(type) { this.listeners.forEach(fn => fn(type)); }

  // ---- model -------------------------------------------------------------

  add(kind) {
    const item = { id: this.nextId++, ...TextOverlay.defaults(kind) };
    if (item.anchor === 'time') item.start = +this.app.masterTime().toFixed(1);
    this.items.push(item);
    this.selectedId = item.id;
    this.emit('change');
    return item;
  }

  get(id) { return this.items.find(i => i.id === id); }

  update(id, patch) {
    const it = this.get(id);
    if (!it) return;
    if ('anchor' in patch || 'start' in patch) patch.firedWall = null;
    if (patch.style) { Object.assign(it.style, patch.style); delete patch.style; }
    Object.assign(it, patch);
    this.emit('change');
  }

  remove(id) {
    this.items = this.items.filter(i => i.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.emit('change');
  }

  select(id) { this.selectedId = id; this.emit('select'); }

  // Live mode: play an item from now (End-locked items have no end to sit on).
  fire(id) {
    const it = this.get(id);
    if (it) { it.firedAt = this.app.masterTime(); it.firedWall = performance.now() / 1000; this.emit('change'); }
  }

  // [start, end) on the master timeline, or null if it can't be placed yet.
  windowOf(it) {
    const d = Math.max(0.2, +it.duration || 0);
    if (it.firedAt != null) return [it.firedAt, it.firedAt + d];
    if (it.anchor === 'start') return [Math.max(0, +it.start || 0), Math.max(0, +it.start || 0) + d];
    if (it.anchor === 'end') {
      const end = this.app.isTrackMode() ? this.app.trackSource.duration : 0;
      return end > 0 ? [Math.max(0, end - d), end] : null;
    }
    return [Math.max(0, +it.start || 0), Math.max(0, +it.start || 0) + d];
  }

  // ---- drawing -------------------------------------------------------------

  // Draw every item visible at time t into a 2D context of size W×H.
  // preview: an item id to show faded even outside its time (editing while
  // paused, D-62); during playback every item keeps strictly to its time.
  // live = false (export): Show now items sit at their master time.
  render(ctx, W, H, t, preview = null, live = true) {
    ctx.clearRect(0, 0, W, H);
    if (ctx === this.ctx) this.boxes = new Map();
    let drawn = 0;
    for (const it of this.items) {
      let win = this.windowOf(it);
      let tt = t;
      // Show now runs on the wall clock, so it plays even while the live clock is stopped.
      if (live && it.firedWall != null && !this.app.isTrackMode()) { tt = performance.now() / 1000; win = [it.firedWall, it.firedWall + (win[1] - win[0])]; }
      let p = null, ghost = false;
      if (win && tt >= win[0] && tt < win[1]) p = (tt - win[0]) / (win[1] - win[0]);
      else if (it.id === preview) { p = it.anim === 'roll' ? 0.35 : 0.5; ghost = true; }
      if (p == null) continue;
      const box = this.drawItem(ctx, W, H, it, p, (win ? win[1] - win[0] : it.duration), ghost);
      if (ctx === this.ctx && box) this.boxes.set(it.id, { ...box, ghost });
      drawn++;
    }
    return drawn;
  }

  lines(it, H) {
    const base = H * (TextOverlay.SIZES[it.style.size] || 0.05);
    const raw = String(it.content || '').split('\n');
    return raw.map((text, i) => {
      let size = base, weight = it.style.font === 'display' ? 400 : 600, t = text;
      if (it.kind === 'credits' && t.startsWith('# ')) { t = t.slice(2); size = base * 1.4; weight = 800; }
      else if (it.kind === 'title' && i > 0) { size = base * 0.42; weight = 500; }
      return { text: t, size, weight, gap: t.trim() === '' ? base * 0.6 : size * 1.25 };
    });
  }

  drawItem(ctx, W, H, it, p, dur, ghost = false) {
    const L = this.lines(it, H);
    const blockH = L.reduce((h, l) => h + l.gap, 0);
    const fadeP = Math.min(0.25, 0.6 / Math.max(0.6, dur));
    let alpha = 1;
    if (it.anim !== 'none' && it.anim !== 'roll') alpha = Math.min(1, p / fadeP, (1 - p) / fadeP);
    else if (it.anim === 'roll') alpha = Math.min(1, p / 0.04, (1 - p) / 0.04);
    alpha = Math.max(0, alpha);
    if (ghost) alpha = 0.55;
    if (alpha <= 0) return null;

    const align = it.style.align;
    const pad = W * 0.06;
    let x = align === 'left' ? pad : align === 'right' ? W - pad : W / 2;
    let y;
    if (it.anim === 'roll') {
      y = H - p * (H + blockH);                  // credits roll bottom → top
    } else if (it.style.position === 'free') {
      // Placed by dragging (D-62): x/y are fractions of the frame.
      x = (it.style.x != null ? it.style.x : 0.5) * W;
      y = (it.style.y != null ? it.style.y : 0.5) * H;
      if (it.anim === 'rise') y += (1 - alpha) * H * 0.03;
    } else {
      const pos = it.style.position;
      y = pos === 'top' ? H * 0.08 : pos === 'bottom' ? H * 0.92 - blockH : pos === 'lower' ? H * 0.72 - blockH / 2 : (H - blockH) / 2;
      if (it.anim === 'rise') y += (1 - alpha) * H * 0.03;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    const family = TextOverlay.FONTS[it.style.font] || TextOverlay.FONTS.sans;

    let maxW = 0;
    L.forEach(l => { ctx.font = `${l.weight} ${l.size}px ${family}`; maxW = Math.max(maxW, ctx.measureText(l.text).width); });
    const boxLeft = align === 'left' ? x : align === 'right' ? x - maxW : x - maxW / 2;
    if (it.style.plate === 'plate') {
      const px = H * 0.02;
      const left = align === 'left' ? x - px : align === 'right' ? x - maxW - px : x - maxW / 2 - px;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(left, y - px, maxW + px * 2, blockH + px * 1.4);
    }
    if (it.style.plate === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = H * 0.012;
      ctx.shadowOffsetY = H * 0.003;
    }
    ctx.fillStyle = it.style.color || '#ffffff';
    let yy = y;
    for (const l of L) {
      if (l.text.trim()) {
        ctx.font = `${l.weight} ${l.size}px ${family}`;
        ctx.fillText(l.text, x, yy);
      }
      yy += l.gap;
    }
    ctx.restore();
    return { x: boxLeft, y, w: maxW, h: blockH, anchorX: x };
  }

  // ---- viewport overlay ----------------------------------------------------

  attach(container) {
    const c = document.createElement('canvas');
    c.className = 'text-overlay';
    c.setAttribute('aria-hidden', 'true');
    c.hidden = true;
    container.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.max(1, Math.round(container.clientWidth * dpr));
      c.height = Math.max(1, Math.round(container.clientHeight * dpr));
    };
    new ResizeObserver(fit).observe(container);
    fit();
    // make sure the web fonts are ready before the first draw
    if (document.fonts) ['Boldonse', 'Inter Tight', 'JetBrains Mono'].forEach(f => document.fonts.load(`600 40px "${f}"`).catch(() => {}));
    const loop = () => {
      requestAnimationFrame(loop);
      // The canvas is taken out of the page whenever nothing is on screen:
      // an empty full-size layer over the WebGL canvas still costs
      // compositing time every frame.
      if (!this.items.length && !this.drawn) return;
      const preview = this.previewing && !this.app.timelineRolling() ? this.selectedId : null;
      this.drawn = this.render(this.ctx, c.width, c.height, this.app.masterTime(), preview) > 0;
      if (c.hidden === this.drawn) c.hidden = !this.drawn;
      this.updateHandle();
    };
    loop();
    this.makeHandle(container);
  }

  // ---- drag handle (D-62) ----------------------------------------------------
  // While 04 Text is open, the selected base text gets a dashed box on the
  // viewport. Dragging it places the text anywhere (position "Free").

  makeHandle(container) {
    const h = document.createElement('div');
    h.className = 'text-handle';
    h.hidden = true;
    h.title = 'Drag to move this text';
    h.innerHTML = '<span class="text-handle-tag"></span>';
    container.appendChild(h);
    this.handle = h;
    this.handleTag = h.firstChild;
    let drag = null;
    h.addEventListener('pointerdown', (e) => {
      const it = this.get(this.selectedId);
      const box = this.boxes && this.boxes.get(this.selectedId);
      if (!it || !box) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const W = this.canvas.width, H = this.canvas.height;
      // Start from where it is drawn now, whatever its position preset.
      if (it.style.position !== 'free') { it.style.x = box.anchorX / W; it.style.y = box.y / H; it.style.position = 'free'; }
      drag = { x: e.clientX, y: e.clientY, sx: it.style.x, sy: it.style.y, cw: this.canvas.clientWidth, ch: this.canvas.clientHeight };
      h.classList.add('dragging');
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const it = this.get(this.selectedId);
      if (!it) return;
      const clamp = (v) => Math.max(-0.2, Math.min(1.2, v));
      it.style.x = clamp(drag.sx + (e.clientX - drag.x) / drag.cw);
      it.style.y = clamp(drag.sy + (e.clientY - drag.y) / drag.ch);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      h.classList.remove('dragging');
      const it = this.get(this.selectedId);
      if (it) {
        it.style.x = Math.round(it.style.x * 1000) / 1000;
        it.style.y = Math.round(it.style.y * 1000) / 1000;
      }
      this.emit('change');
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }

  updateHandle() {
    const h = this.handle;
    if (!h) return;
    const it = this.previewing ? this.get(this.selectedId) : null;
    const box = it && it.kind === 'text' && it.anim !== 'roll' && this.boxes ? this.boxes.get(it.id) : null;
    if (!box) { if (!h.hidden) h.hidden = true; return; }
    const s = this.canvas.clientWidth / this.canvas.width;     // canvas px → CSS px
    const pad = 6;
    h.hidden = false;
    h.style.left = `${box.x * s - pad}px`;
    h.style.top = `${box.y * s - pad}px`;
    h.style.width = `${box.w * s + pad * 2}px`;
    h.style.height = `${box.h * s + pad * 2}px`;
    h.classList.toggle('ghost', box.ghost);
    const win = this.windowOf(it);
    const tag = box.ghost && win ? `Preview · on screen ${fmtTime(win[0], true)}–${fmtTime(win[1], true)}` : '';
    if (this.handleTag.textContent !== tag) this.handleTag.textContent = tag;
  }

  // ---- project file ----------------------------------------------------------

  toJSON() { return { nextId: this.nextId, items: this.items.map(i => ({ ...i, style: { ...i.style }, firedAt: null, firedWall: null })) }; }

  fromJSON(data) {
    this.items = (data && data.items || []).map(i => ({ ...TextOverlay.defaults(i.kind), ...i, style: { ...TextOverlay.defaults(i.kind).style, ...i.style } }));
    this.nextId = Math.max((data && data.nextId) || 1, ...this.items.map(i => i.id + 1));
    this.selectedId = null;
    this.emit('change');
  }
}

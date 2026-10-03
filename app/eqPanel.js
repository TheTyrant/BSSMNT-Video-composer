// EQ section of 02 Assets (v2.2, D-51).
//  - Two views on a tab swap: Sensitivity (simple: band faders + meters)
//    and Dynamic (advanced: the analysis EQ curve, see analysisEq.js).
//  - The "Use" radios choose what is applied: Sensitivity, Dynamic, or
//    Blend (both). Default is Sensitivity, i.e. exactly today's behaviour.
class EqPanel {
  constructor(app) {
    this.app = app;
    this.eq = app.eq;
    this.F_MIN = 20;
    this.F_MAX = 20000;
    this.G_MAX = 18;        // ±dB shown
    this.drag = null;
    this.hover = null;
    this.lastDraw = 0;
  }

  init() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      tabSens: $('eqTabSens'), tabDyn: $('eqTabDyn'), paneSens: $('eqPaneSens'), paneDyn: $('eqPaneDyn'),
      preset: $('eqPreset'), listen: $('eqListen'), reset: $('eqReset'), readout: $('eqReadout'),
      canvas: $('eqCanvas'),
    };
    this.ctx = this.el.canvas.getContext('2d');

    [this.el.tabSens, this.el.tabDyn].forEach(b => b.addEventListener('click', () => this.setView(b.dataset.v)));
    document.querySelectorAll('input[name="eqMode"]').forEach(r =>
      r.addEventListener('change', () => { if (r.checked) this.app.setEqMode(r.value); }));

    this.el.preset.add(new Option('Custom', 'custom'));
    Object.entries(AnalysisEQ.PRESETS).forEach(([k, p]) => this.el.preset.add(new Option(p.label, k)));
    this.el.preset.value = 'flat';
    this.el.preset.addEventListener('change', () => {
      if (this.el.preset.value !== 'custom') this.eq.applyPreset(this.el.preset.value);
    });
    this.el.listen.addEventListener('change', () => this.eq.setListen(this.el.listen.checked));
    this.el.reset.addEventListener('click', () => { this.eq.applyPreset('flat'); this.el.preset.value = 'flat'; });
    this.eq.on(() => this.syncUI());

    this.initCanvas();
    this.setView('sensitivity');
    this.syncUI();
    requestAnimationFrame(() => this.loop());
  }

  setView(v) {
    this.view = v;
    const dyn = v === 'dynamic';
    this.el.paneSens.hidden = dyn;
    this.el.paneDyn.hidden = !dyn;
    [[this.el.tabSens, !dyn], [this.el.tabDyn, dyn]].forEach(([b, on]) => {
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
  }

  syncUI() {
    const mode = this.app.eqMode;
    document.querySelectorAll('input[name="eqMode"]').forEach(r => { r.checked = r.value === mode; });
    const canListen = this.app.isTrackMode() && this.eq.active;
    this.el.listen.disabled = !canListen;
    if (!canListen && this.eq.listen) this.eq.setListen(false);
    this.el.listen.checked = this.eq.listen;
    if (!this.drag) this.el.readout.textContent = this.eq.describe();
  }

  // ---- geometry ---------------------------------------------------------

  xOf(f) { return (Math.log10(f / this.F_MIN) / Math.log10(this.F_MAX / this.F_MIN)) * this.W; }
  fOf(x) { return this.F_MIN * Math.pow(this.F_MAX / this.F_MIN, Math.max(0, Math.min(1, x / this.W))); }
  yOf(g) { return this.H / 2 - (g / this.G_MAX) * (this.H / 2 - 10); }
  gOf(y) { return ((this.H / 2 - y) / (this.H / 2 - 10)) * this.G_MAX; }
  nodePos(b) { return { x: this.xOf(b.freq), y: this.eq.isCut(b) ? this.yOf(0) : this.yOf(b.gain) }; }

  nodeAt(x, y) {
    let best = null, bd = 16;
    this.eq.bands.forEach(b => {
      const p = this.nodePos(b);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = b; }
    });
    return best;
  }

  initCanvas() {
    const c = this.el.canvas;
    const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('pointerdown', (e) => {
      const p = local(e);
      const b = this.nodeAt(p.x, p.y);
      if (!b) return;
      this.drag = b;
      c.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (!this.drag) { this.hover = this.nodeAt(p.x, p.y); c.style.cursor = this.hover ? 'grab' : 'default'; return; }
      const b = this.drag;
      const freq = Math.round(Math.max(this.F_MIN, Math.min(this.F_MAX, this.fOf(p.x))));
      const vals = { freq };
      if (this.eq.isCut(b)) vals.on = true;
      else vals.gain = Math.round(Math.max(-this.G_MAX, Math.min(this.G_MAX, this.gOf(p.y))) * 2) / 2;
      this.eq.setBand(b.id, vals);
      this.el.preset.value = 'custom';
      this.el.readout.textContent = this.nodeText(b);
    });
    const end = () => { this.drag = null; this.syncUI(); };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      const p = local(e);
      const b = this.nodeAt(p.x, p.y);
      if (!b) return;
      e.preventDefault();
      const q = Math.max(0.3, Math.min(12, b.q * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.eq.setBand(b.id, { q: Math.round(q * 100) / 100 });
      this.el.preset.value = 'custom';
      this.el.readout.textContent = this.nodeText(b);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const p = local(e);
      const b = this.nodeAt(p.x, p.y);
      if (!b) return;
      this.eq.setBand(b.id, this.eq.isCut(b) ? { on: false } : { gain: 0, q: 1 });
      this.el.preset.value = this.eq.isFlat ? 'flat' : 'custom';
    });
  }

  nodeText(b) {
    const hz = b.freq >= 1000 ? `${(b.freq / 1000).toFixed(1)} kHz` : `${Math.round(b.freq)} Hz`;
    if (this.eq.isCut(b)) return `${b.label} ${b.on ? hz : 'off'} · Q ${b.q.toFixed(2)}`;
    return `${b.label} ${hz} · ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB · Q ${b.q.toFixed(2)}`;
  }

  // ---- drawing ----------------------------------------------------------

  loop() {
    requestAnimationFrame(() => this.loop());
    if (this.el.paneDyn.hidden || this.el.paneDyn.offsetParent === null) return;
    const now = performance.now();
    if (now - this.lastDraw < 33) return;
    this.lastDraw = now;
    this.draw();
  }

  // Drawn as an analyser window (D-69): navy screen, filled blue spectrum,
  // glowing blue → violet → pink → orange EQ curve. Colours: --scope-*.
  draw() {
    const c = this.el.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = W; this.H = H;
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    const live = col('--live');
    const P = Scope.palette();

    Scope.background(ctx, 0, 0, W, H, P);

    // grid
    ctx.font = '8px "JetBrains Mono", monospace';
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => {
      const x = Math.round(this.xOf(f)) + 0.5;
      ctx.fillStyle = P.grid;
      ctx.fillRect(x, 0, 1, H);
      ctx.fillStyle = P.text;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 3);
    });
    [-12, -6, 6, 12].forEach(g => { if (Math.abs(g) <= this.G_MAX) { ctx.fillStyle = P.grid; ctx.fillRect(0, Math.round(this.yOf(g)), W, 1); } });
    ctx.fillStyle = P.axis;
    ctx.fillRect(0, Math.round(this.yOf(0)), W, 1);

    // live spectrum: what the analysis hears right now (filled, with a crisp top edge)
    const spec = this.app.visualizer.audioData.spectrum || [];
    const sr = (this.app.audioProcessor.audioContext && this.app.audioProcessor.audioContext.sampleRate) || 48000;
    const nyq = sr / 2;
    if (spec.length) {
      const pts = [];
      for (let x = 0; x <= W; x += 2) {
        const i = Math.min(spec.length - 1, Math.round((this.fOf(x) / nyq) * spec.length));
        pts.push([x, H - (spec[i] || 0) * (H - 12)]);
      }
      ctx.beginPath();
      ctx.moveTo(0, H);
      pts.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = Scope.fillGradient(ctx, 8, H, P.fillTop, P.fillBottom);
      ctx.fill();
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // where the frozen analyser splits Bass | Mid | High (bandEnergy: 12 % / 45 % of the bins)
    const split = [['BASS', 0, 0.12, P.bass], ['MID', 0.12, 0.45, P.mid], ['HIGH', 0.45, 1, P.high]];
    split.forEach(([name, a, b, color], i) => {
      const fa = Math.max(this.F_MIN, a * nyq), fb = Math.min(this.F_MAX, b * nyq);
      const xa = this.xOf(fa), xb = this.xOf(fb);
      ctx.fillStyle = color;
      ctx.fillRect(xa, 0, Math.max(0, xb - xa), 3);
      ctx.font = '700 8px "JetBrains Mono", monospace';
      ctx.fillText(name, xa + 3, 12);
      if (i > 0) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(xa + 0.5, 0); ctx.lineTo(xa + 0.5, H); ctx.stroke();
        ctx.restore();
      }
    });

    // EQ curve: soft fill to 0 dB, then the glowing gradient line
    const N = 160;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = this.fOf((i / (N - 1)) * W);
    const db = this.eq.response(freqs);
    const applied = this.app.eqMode !== 'sensitivity';
    const y0 = this.yOf(0);
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const x = (i / (N - 1)) * W;
        const y = this.yOf(Math.max(-this.G_MAX - 6, Math.min(this.G_MAX + 6, db[i])));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    };
    const grad = Scope.curveGradient(ctx, 0, W, P);
    ctx.save();
    if (applied && !this.eq.isFlat) {
      path();
      ctx.lineTo(W, y0); ctx.lineTo(0, y0); ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (!applied) { ctx.setLineDash([4, 4]); ctx.globalAlpha = 0.6; }
    path();
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = P.c2;
    ctx.shadowBlur = applied ? 10 : 0;
    ctx.stroke();
    ctx.restore();

    // points: coloured by where they sit on the curve, white ring
    this.eq.bands.forEach((b, i) => {
      const p = this.nodePos(b);
      const on = this.eq.isActiveBand(b);
      const hot = b === this.drag || b === this.hover;
      const tint = Scope.colorAt(p.x / W, P);
      ctx.save();
      ctx.lineWidth = hot ? 2 : 1.25;
      ctx.strokeStyle = P.node;
      ctx.fillStyle = on ? (hot ? live : tint) : P.bg1;
      ctx.shadowColor = tint;
      ctx.shadowBlur = on ? 8 : 0;
      if (this.eq.isCut(b)) {
        ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
        ctx.strokeRect(p.x - 5 + 0.5, p.y - 5 + 0.5, 9, 9);
      } else {
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = on ? P.bg1 : P.node;
      ctx.font = '700 7px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), p.x, p.y + 2.5);
      ctx.textAlign = 'left';
    });

    // Beat detection needs low end. If the applied EQ leaves the analysis
    // "bass" near zero while music is playing, say so on the graph.
    const ad = this.app.visualizer.audioData;
    const playing = this.app.timelineRolling() && ad.isActive;
    this.starved = applied && !this.eq.isFlat && playing && ad.bass < 0.06 ? (this.starved || performance.now()) : 0;
    if (this.starved && performance.now() - this.starved > 2000) {
      ctx.fillStyle = live;
      ctx.font = '700 9px "JetBrains Mono", monospace';
      ctx.fillText('BEAT DETECTION NEEDS MORE LOW END', 6, 38);
    }

    if (!applied && !this.eq.isFlat) {
      ctx.fillStyle = P.text;
      ctx.font = '700 9px "JetBrains Mono", monospace';
      ctx.fillText('PREVIEW — set Use to Dynamic or Blend', 6, 26);
    }
  }
}

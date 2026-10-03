// Analyser-window look (D-69), shared by the EQ graph and the timeline's
// Master / Voice lanes: a deep navy "screen", a filled blue spectrum, and a
// glowing blue → violet → pink → orange curve (after iZotope Ozone's EQ).
// Every colour comes from CSS variables (--scope-*), so the light and dark
// skins can each tune it.
const Scope = {
  palette() {
    const css = getComputedStyle(document.documentElement);
    const v = (n, d) => css.getPropertyValue(n).trim() || d;
    return {
      bg1: v('--scope-bg-1', '#0B1120'), bg2: v('--scope-bg-2', '#121B30'),
      grid: v('--scope-grid', 'rgba(150,175,220,0.10)'), axis: v('--scope-axis', 'rgba(170,195,240,0.28)'),
      text: v('--scope-text', 'rgba(185,200,232,0.62)'),
      fillTop: v('--scope-fill-top', 'rgba(84,140,230,0.55)'), fillBottom: v('--scope-fill-bottom', 'rgba(40,70,150,0.04)'),
      line: v('--scope-line', 'rgba(140,190,255,0.85)'),
      c1: v('--scope-c1', '#38B6FF'), c2: v('--scope-c2', '#7C5CFF'), c3: v('--scope-c3', '#E64C9B'), c4: v('--scope-c4', '#FF9E45'),
      bass: v('--scope-bass', '#FF5A6E'), mid: v('--scope-mid', '#3FE08A'), high: v('--scope-high', '#4FA0FF'),
      node: v('--scope-node', '#FFFFFF'),
    };
  },

  // The screen: a soft vertical gradient.
  background(ctx, x, y, w, h, P) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, P.bg2);
    g.addColorStop(1, P.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  },

  // Blue → violet → pink → orange across x0..x1 (the curve colour).
  curveGradient(ctx, x0, x1, P) {
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, P.c1);
    g.addColorStop(0.38, P.c2);
    g.addColorStop(0.7, P.c3);
    g.addColorStop(1, P.c4);
    return g;
  },

  // The same colours as a function of t (0..1), for points on the curve.
  colorAt(t, P) {
    const stops = [[0, P.c1], [0.38, P.c2], [0.7, P.c3], [1, P.c4]];
    const rgb = (c) => {
      const m = c.match(/^#([0-9a-f]{6})$/i);
      if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
      const r = c.match(/\d+(\.\d+)?/g);
      return r ? r.slice(0, 3).map(Number) : [255, 255, 255];
    };
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [a0, ca] = stops[i - 1], [a1, cb] = stops[i];
        const k = (t - a0) / (a1 - a0), A = rgb(ca), B = rgb(cb);
        return `rgb(${A.map((x, j) => Math.round(x + (B[j] - x) * k)).join(',')})`;
      }
    }
    return stops[stops.length - 1][1];
  },

  // A filled area under a path (spectrum / waveform), gradient top → bottom.
  fillGradient(ctx, yTop, yBottom, top, bottom) {
    const g = ctx.createLinearGradient(0, yTop, 0, yBottom);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  },
};

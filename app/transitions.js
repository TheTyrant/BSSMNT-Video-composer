// Clip transitions for the auto-editor, kept as a small registry so new ones
// can be added with ClipTransitions.register() without touching the engine.
//
// A transition definition:
//   label        -- UI name
//   glyph        -- one-character mark drawn on the clip timeline
//   lengthBeats  -- how long the blend lasts, in beats (0 = instantaneous);
//                   converted to ms with the live BPM so blends scale with tempo
//   render(p, t, from, to, draw)
//                -- draw one frame of the blend. t runs 0 -> 1.
//                   `from` / `to` are clip handles (from may be null).
//                   draw(clip, { alpha, offsetX, scale }) paints a clip
//                   full-frame; alpha is 0..1.
const ClipTransitions = (() => {
  const registry = new Map();

  function register(id, def) {
    registry.set(id, { id, lengthBeats: 0, glyph: '?', ...def });
  }

  register('jump', {
    label: 'Jump cut',
    glyph: '|',
    lengthBeats: 0,
    render(p, t, from, to, draw) {
      draw(to, { alpha: 1 });
    },
  });

  register('crossfade', {
    label: 'Crossfade',
    glyph: '×',
    lengthBeats: 1,
    render(p, t, from, to, draw) {
      if (from) draw(from, { alpha: 1 });
      draw(to, { alpha: easeInOut(t) });
    },
  });

  // Motion-blur style: both clips are smeared horizontally by a bell-shaped
  // amount that peaks mid-transition, while the incoming clip fades up.
  // Smear is faked with offset low-alpha copies (cheap on WebGL, no shader).
  register('blur', {
    label: 'Blur',
    glyph: '≈',
    lengthBeats: 0.5,
    render(p, t, from, to, draw) {
      const smear = Math.sin(Math.PI * t);         // 0 -> 1 -> 0
      const reach = smear * p.width * 0.12;
      const taps = 6;
      const mix = easeInOut(t);
      const smeared = (clip, alpha, dir) => {
        draw(clip, { alpha, offsetX: 0, scale: 1 + smear * 0.04 });
        for (let i = 1; i <= taps; i++) {
          const o = (i / taps) * reach * dir;
          draw(clip, { alpha: alpha * 0.28 * smear, offsetX: o, scale: 1 + smear * 0.04 });
          draw(clip, { alpha: alpha * 0.18 * smear, offsetX: -o * 0.5, scale: 1 + smear * 0.04 });
        }
      };
      if (from) smeared(from, 1, 1);
      smeared(to, mix, -1);
    },
  });

  function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  return {
    register,
    get: (id) => registry.get(id) || registry.get('jump'),
    list: () => Array.from(registry.values()),
    ids: () => Array.from(registry.keys()),
  };
})();

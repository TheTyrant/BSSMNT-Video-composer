// Output window: shows only the canvas, no sidebar/timeline/controls, so it's
// safe to fullscreen on a projector or second monitor while the editor stays
// on the control window. It never runs its own audio pipeline -- it just
// mirrors whatever the control window's DJVisualizer instance is doing.

(function () {
  let w = window.innerWidth;
  let h = window.innerHeight;
  let p5Instance = null;

  // p5.Image/p5.MediaElement objects are tied to the renderer that created
  // them -- reusing the control window's directly throws inside p5's WebGL
  // texture pipeline. So this window loads its own copy of each layer's media
  // from the same source File, and only reloads when that File reference
  // changes (i.e. the operator uploaded something new in the control window).
  const localLayers = {
    background: { file: null, media: null },
    bass: { file: null, media: null },
    mid: { file: null, media: null },
    high: { file: null, media: null }
  };

  function waitForSource(callback) {
    if (window.opener && !window.opener.closed && window.opener.djApp && window.opener.djApp.visualizer) {
      callback(window.opener.djApp.visualizer);
    } else {
      setTimeout(() => waitForSource(callback), 200);
    }
  }

  function syncLocalMedia(sourceViz) {
    if (!p5Instance) return;
    Object.keys(localLayers).forEach((name) => {
      const sourceLayer = sourceViz.layers[name];
      const local = localLayers[name];
      if (sourceLayer.file === local.file) return;

      local.file = sourceLayer.file;
      local.media = null;
      if (local.bridge) { local.bridge.remove(); local.bridge = null; }
      if (!sourceLayer.file) return;

      const url = URL.createObjectURL(sourceLayer.file);
      if (sourceLayer.type === 'video') {
        const video = p5Instance.createVideo([url], () => {
          video.volume(0);
          video.hide();
          video.loop();
        });
        local.media = video;
        // Rotated phone video: this window needs its own 2D bridge (D-54).
        const VO = window.opener && window.opener.VideoOrientation;
        if (VO) VO.detect(sourceLayer.file).then((rot) => { if (rot && local.media === video) local.bridge = VO.bridge(p5Instance, video); });
      } else if (sourceLayer.type === 'image') {
        p5Instance.loadImage(url, (img) => { local.media = img; });
      }
    });
  }

  // Text overlay (D-60): the control window's TextOverlay draws into a
  // canvas here, so titles and credits show on the projector too.
  let textCanvas = null;
  function drawText() {
    const app = window.opener && window.opener.djApp;
    if (!app || !app.text) return;
    if (!textCanvas) {
      textCanvas = document.createElement('canvas');
      textCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
      document.body.appendChild(textCanvas);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Boldonse&family=Inter+Tight:wght@400;500;600;800&family=JetBrains+Mono:wght@400;700&display=swap';
      document.head.appendChild(link);
    }
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr), H = Math.round(window.innerHeight * dpr);
    if (textCanvas.width !== W || textCanvas.height !== H) { textCanvas.width = W; textCanvas.height = H; }
    app.text.render(textCanvas.getContext('2d'), W, H, app.masterTime());
  }

  waitForSource((sourceViz) => {
    const waitingEl = document.getElementById('waiting');
    if (waitingEl) waitingEl.style.display = 'none';

    new p5((p) => {
      p5Instance = p;

      p.setup = () => {
        const canvas = p.createCanvas(w, h, p.WEBGL);
        canvas.parent('p5-canvas');
        p.frameRate(60);
        p.background(0);
      };

      p.windowResized = () => {
        w = window.innerWidth;
        h = window.innerHeight;
        p.resizeCanvas(w, h);
      };

      p.draw = () => {
        if (!window.opener || window.opener.closed) {
          p.background(0);
          return;
        }

        // Clip auto-editor videos live in the control window's renderer and
        // can't be drawn here (same p5 texture limitation as layers above).
        // Mirroring them needs local clip copies kept in time sync -- not
        // built yet, so say so instead of throwing inside p5.
        const waitingEl = document.getElementById('waiting');
        if (sourceViz.currentMode === 'clips') {
          p.background(0);
          if (waitingEl) {
            waitingEl.textContent = 'Clip Auto-Editor output is not mirrored to the pop-out yet — use Fullscreen (F) in the control window.';
            waitingEl.style.display = 'block';
          }
          return;
        }
        if (waitingEl) waitingEl.style.display = 'none';

        syncLocalMedia(sourceViz);
        drawText();

        // A fresh proxy each frame: reads (audioData, colors, time,
        // beatFlash/beatPulse) fall through to the live control-window
        // instance, so this window always mirrors its current state. Own
        // writes the draw methods make (this.time += ..., polygonCollageStarted,
        // etc.) land on the throwaway proxy instead of the shared instance,
        // so this window's rendering never fights with the control window's
        // own draw loop over the same mutable fields. `layers` is shadowed
        // with this window's own locally-loaded media (see syncLocalMedia)
        // while enabled/justify/stack still mirror the control window live.
        const proxy = Object.create(sourceViz);
        proxy.w = w;
        proxy.h = h;
        proxy.layers = {
          background: { ...sourceViz.layers.background, media: localLayers.background.media, bridge: localLayers.background.bridge || null },
          bass: { ...sourceViz.layers.bass, media: localLayers.bass.media, bridge: localLayers.bass.bridge || null },
          mid: { ...sourceViz.layers.mid, media: localLayers.mid.media, bridge: localLayers.mid.bridge || null },
          high: { ...sourceViz.layers.high, media: localLayers.high.media, bridge: localLayers.high.bridge || null }
        };

        // Calls sourceViz's own (control window's) draw method via the
        // proxy's prototype chain -- there's no separate copy of
        // DJVisualizer loaded in this window.
        sourceViz.draw.call(proxy, p);
      };
    });
  });
})();

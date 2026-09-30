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
      if (!sourceLayer.file) return;

      const url = URL.createObjectURL(sourceLayer.file);
      if (sourceLayer.type === 'video') {
        const video = p5Instance.createVideo([url], () => {
          video.volume(0);
          video.hide();
          video.loop();
        });
        local.media = video;
      } else if (sourceLayer.type === 'image') {
        p5Instance.loadImage(url, (img) => { local.media = img; });
      }
    });
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
          background: { ...sourceViz.layers.background, media: localLayers.background.media },
          bass: { ...sourceViz.layers.bass, media: localLayers.bass.media },
          mid: { ...sourceViz.layers.mid, media: localLayers.mid.media },
          high: { ...sourceViz.layers.high, media: localLayers.high.media }
        };

        // Calls sourceViz's own (control window's) draw method via the
        // proxy's prototype chain -- there's no separate copy of
        // DJVisualizer loaded in this window.
        sourceViz.draw.call(proxy, p);
      };
    });
  });
})();

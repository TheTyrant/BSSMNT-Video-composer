// Offline renderer (v2.3, D-55 / D-61): exports the finished video on this
// machine, faster than real time where the hardware allows, with no server
// and no internet connection.
//
// It replays the session record instead of re-running the analysis:
//   - the per-frame analysis log (SessionRecord, 60 fps) drives every visual
//     mode through the app's own DJVisualizer drawing code, on a private p5
//     instance at the export size;
//   - the cut list (ClipEngine.edl()) says which clip, from which in-point,
//     with which transition; clips are decoded frame-accurately with
//     Mediabunny (WebCodecs), so cuts land exactly where they were made;
//   - text (TextOverlay) is drawn over everything with the same render();
//   - audio is mixed offline (OfflineAudioContext) from the track, voice and
//     story-clip sound with the same mutes, fades and levels as playback.
// Video (H.264) and audio (AAC) are muxed to MP4 and streamed straight to
// the file picked in the save dialog (Chrome / Edge), so long exports don't
// have to fit in memory.
class OfflineRenderer {
  static SIZES = {
    '1080p': { w: 1920, h: 1080, label: '1080p · 16:9' },
    '720p': { w: 1280, h: 720, label: '720p · 16:9' },
    '4k': { w: 3840, h: 2160, label: '4K · 16:9' },
    'vertical': { w: 1080, h: 1920, label: '1080×1920 · 9:16' },
    'square': { w: 1080, h: 1080, label: '1080×1080 · 1:1' },
  };
  static SR = 48000;
  static AUDIO_CHUNK = 10;          // seconds of audio mixed at a time
  static VIZ_HZ = 60;               // visual modes step at the live rate
  static STATEFUL = ['particles', 'rings', 'waves', 'mandala', 'tunnel', 'galaxy', 'polygons'];

  constructor(app) {
    this.app = app;
    this.busy = false;
  }

  lib() {
    if (!this._lib) this._lib = VendorLoader.media();   // works offline and from file:// (D-64)
    return this._lib;
  }

  static supported() {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
  }

  // What an export would contain right now (for the Output panel).
  plan() {
    const app = this.app, rec = app.record;
    const track = app.isTrackMode() && app.trackSource.isLoaded;
    const duration = track ? app.trackSource.duration : rec.duration;
    const frames = Math.ceil(duration * SessionRecord.FPS);
    let recorded = 0, first = -1, last = -1;
    for (let i = 0; i < frames; i++) if (rec.frame(i)) { recorded++; if (first < 0) first = i; last = i; }
    const played = first >= 0 ? { start: first / SessionRecord.FPS, end: Math.min(duration, (last + 1) / SessionRecord.FPS) } : null;
    const edl = app.clipEngine.edl();
    const warnings = [];
    if (!(duration > 0)) warnings.push(track ? 'The track has no length yet.' : 'Nothing recorded yet: play the set first.');
    const missing = Math.max(0, frames - recorded) / SessionRecord.FPS;
    if (duration > 0 && missing > 0.5) warnings.push(`${fmtTime(missing, false)} of the timeline hasn't been played yet, so it has no recorded motion (shown still). Play it through once to record it.`);
    if (!track && duration > 0) warnings.push('Live mode: the input sound is not recorded, so the export carries voice and clip sound only.');
    const usesClips = this.modesUsed(frames).has('clips');
    if (usesClips && !edl.length) warnings.push('Clip Auto-Editor was on but no cuts were recorded.');
    const offline = app.clipEngine.assets.filter(a => a.offline).length;
    if (offline) warnings.push(`${offline} media file(s) aren't connected: reconnect them in Project first.`);
    return { duration, played, recorded: recorded / SessionRecord.FPS, missing, cuts: edl.length, track, warnings, ok: duration > 0 && !offline };
  }

  modesUsed(frames) {
    const set = new Set();
    for (let i = 0; i < frames; i += 30) { const f = this.app.record.frame(i); if (f) set.add(f.mode); }
    if (!set.size) set.add(this.app.visualizer.currentMode);
    return set;
  }

  cancel() { this.cancelled = true; }

  // opts: { size, fps, quality, name, range: 'all' | 'played' | {start, end} }, onProgress({ done, total, fps, eta, stage })
  async export(opts, onProgress = () => {}) {
    if (this.busy) throw new Error('An export is already running.');
    if (!OfflineRenderer.supported()) throw new Error('This browser cannot encode video. Use Chrome or Edge.');
    const plan = this.plan();
    if (!plan.ok) throw new Error(plan.warnings[0] || 'Nothing to export.');
    const size = OfflineRenderer.SIZES[opts.size] || OfflineRenderer.SIZES['1080p'];
    const W = size.w, H = size.h, fps = opts.fps || 30;
    const name = (opts.name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '_');

    // The save dialog has to open straight from the click.
    let handle = null, writable = null;
    if (window.showSaveFilePicker && !opts.toMemory) {
      handle = await window.showSaveFilePicker({ suggestedName: `${name}.mp4`, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
      writable = await handle.createWritable();
    }

    this.busy = true;
    this.cancelled = false;
    const app = this.app;
    const wasPlaying = app.trackSource.isPlaying;
    if (app.isTrackMode() && wasPlaying) app.toggleAudio();
    const mainP5 = app.visualizer.p5Instance;
    if (mainP5) mainP5.noLoop();       // free the GPU for the export
    let output = null;
    try {
      const M = await this.lib();
      const target = writable ? new M.StreamTarget(writable, { chunked: true }) : new M.BufferTarget();
      output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });

      const vcodec = await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width: W, height: H });
      if (!vcodec) throw new Error(`This machine can't encode ${W}×${H} video. Try a smaller size.`);
      const acodec = await M.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: 2, sampleRate: OfflineRenderer.SR });
      const quality = { standard: M.QUALITY_MEDIUM, high: M.QUALITY_HIGH, max: M.QUALITY_VERY_HIGH }[opts.quality] || M.QUALITY_HIGH;

      const frame = document.createElement('canvas');
      frame.width = W; frame.height = H;
      const fctx = frame.getContext('2d');
      const videoSource = new M.CanvasSource(frame, { codec: vcodec, bitrate: quality, keyFrameInterval: 2 });
      output.addVideoTrack(videoSource, { frameRate: fps });
      let audioSource = null;
      if (acodec) {
        audioSource = new M.AudioBufferSource({ codec: acodec, bitrate: M.QUALITY_HIGH });
        output.addAudioTrack(audioSource);
      }
      await output.start();

      onProgress({ stage: 'Preparing media', done: 0, total: 1 });
      const scene = await this.prepareScene(M, W, H);
      const mix = acodec ? await this.prepareAudio(scene.edl) : null;

      // Range on the master timeline; the file starts at 0.
      let start = 0, end = plan.duration;
      if (opts.range === 'played' && plan.played) ({ start, end } = plan.played);
      else if (opts.range && typeof opts.range === 'object') { start = Math.max(0, opts.range.start); end = Math.min(plan.duration, opts.range.end); }
      const duration = Math.max(0, end - start);
      if (!(duration > 0)) throw new Error('The export range is empty.');
      const total = Math.max(1, Math.round(duration * fps));
      const t0 = performance.now();
      let audioDone = 0;           // seconds of audio already added
      for (let f = 0; f < total; f++) {
        if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError');
        const t = f / fps;
        // Audio is mixed a chunk at a time, slightly ahead of the video.
        while (mix && audioDone < duration && audioDone <= t + 1) {
          const to = Math.min(duration, audioDone + OfflineRenderer.AUDIO_CHUNK);
          await audioSource.add(await this.mixChunk(mix, start + audioDone, start + to));
          audioDone = to;
        }
        await this.renderFrame(scene, start + t, fctx, W, H);
        await videoSource.add(t, 1 / fps);
        if (f % 10 === 0 || f === total - 1) {
          const secs = (performance.now() - t0) / 1000;
          const rate = (f + 1) / secs;
          onProgress({ stage: 'Rendering', done: f + 1, total, fps: rate, speed: rate / fps, eta: (total - f - 1) / rate });
          await new Promise(r => setTimeout(r, 0));   // keep the page responsive
        }
      }
      while (mix && audioDone < duration) {
        const to = Math.min(duration, audioDone + OfflineRenderer.AUDIO_CHUNK);
        await audioSource.add(await this.mixChunk(mix, start + audioDone, start + to));
        audioDone = to;
      }
      onProgress({ stage: 'Finishing', done: total, total });
      await output.finalize();
      this.disposeScene(scene);
      const secs = (performance.now() - t0) / 1000;
      const result = { name: handle ? handle.name : `${name}.mp4`, width: W, height: H, fps, frames: total, duration, start, seconds: secs, speed: duration / secs, vcodec, acodec };
      if (!writable) result.blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      return result;
    } catch (e) {
      if (output && output.state !== 'finalized' && output.state !== 'canceled') { try { await output.cancel(); } catch (_) { /* already closed */ } }
      if (writable) { try { await writable.abort(); } catch (_) { /* closed by cancel */ } }
      throw e;
    } finally {
      this.busy = false;
      if (mainP5) mainP5.loop();
    }
  }

  // ---- video --------------------------------------------------------------

  async prepareScene(M, W, H) {
    const app = this.app;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none';
    document.body.appendChild(host);
    const p = await new Promise((resolve) => new p5((pp) => {
      pp.setup = () => { pp.pixelDensity(1); pp.createCanvas(W, H, pp.WEBGL); pp.noLoop(); resolve(pp); };
      pp.draw = () => { if (pp.drawFrame) pp.drawFrame(); };
    }, host));

    // A private visualizer: same drawing code, its own state, no page access.
    const live = app.visualizer;
    const viz = new DJVisualizer();
    Object.assign(viz, { p5Instance: p, w: W, h: H, isRunning: true, colors: live.colors });
    viz.updateFrequencyDisplay = () => {};
    viz.applyModeSurface = () => {};
    viz.updateSpectrumBars = () => {};
    viz.initializeParticles();
    const scene = { M, p, host, viz, W, H, sources: new Map(), images: new Map(), edl: app.clipEngine.edl(), segIdx: 0, simIndex: -1, mode: null, clipFrame: null };
    viz.clipEngine = { draw: (pp) => this.drawClips(scene, pp) };

    // Media Layers: same slots and settings, media decoded here.
    ['background', 'bass', 'mid', 'high'].forEach(slot => {
      const L = live.layers[slot];
      viz.layers[slot] = { ...L, media: null, bridge: null };
      if (L.media && L.file) scene.layerFiles = { ...(scene.layerFiles || {}), [slot]: { file: L.file, type: L.type } };
    });
    for (const [slot, { file, type }] of Object.entries(scene.layerFiles || {})) {
      if (type === 'image') viz.layers[slot].media = await this.imageGraphics(scene, file, `layer:${slot}`);
      else viz.layers[slot].source = await this.videoSource(scene, file, `layer:${slot}`);
    }

    this.textCanvas = this.textCanvas || document.createElement('canvas');
    this.textCanvas.width = W; this.textCanvas.height = H;
    return scene;
  }

  disposeScene(scene) {
    scene.sources.forEach(s => s.dispose && s.dispose());
    scene.p.remove();
    scene.host.remove();
  }

  // One output frame at master time t.
  async renderFrame(scene, t, fctx, W, H) {
    const idx = Math.round(t * OfflineRenderer.VIZ_HZ);
    const data = this.frameData(idx);
    const mode = data.mode;
    if (mode !== scene.mode) {
      scene.viz.currentMode = mode;
      scene.viz.polygonCollageStarted = false;
      if (mode === 'particles') scene.viz.initializeParticles();
      scene.simIndex = idx - 1;
      scene.mode = mode;
    }

    if (mode === 'spectrum') {
      this.drawSpectrum(fctx, W, H, data);
    } else {
      if (mode === 'clips') await this.loadClipFrames(scene, t);
      if (mode === 'clips' || mode === 'layers') await this.loadLayerFrames(scene, t);
      // Trail-based modes accumulate frame over frame, so they step at the
      // live 60 Hz even when the export runs at 30 fps.
      const stateful = OfflineRenderer.STATEFUL.includes(mode);
      const from = stateful ? Math.max(scene.simIndex + 1, idx - 3) : idx;
      for (let i = from; i <= idx; i++) {
        this.applyData(scene.viz, i === idx ? data : this.frameData(i));
        scene.p.drawFrame = () => scene.viz.draw(scene.p);
        scene.p.redraw();
      }
      scene.simIndex = idx;
      fctx.drawImage(scene.p.canvas, 0, 0, W, H);
    }

    // Text on top of every mode.
    const tc = this.textCanvas;
    if (this.app.text.items.length && this.app.text.render(tc.getContext('2d'), W, H, t, null, false) > 0) fctx.drawImage(tc, 0, 0);
  }

  // Recorded analysis for 60 Hz frame i; a stretch that was never played
  // holds still (no motion) in the mode around it.
  frameData(i) {
    const rec = this.app.record;
    const f = rec.frame(i);
    if (f) { this._lastMode = f.mode; return f; }
    let mode = this._lastMode;
    if (!mode) {
      for (let k = i + 1; k <= rec.maxFrame; k++) { const g = rec.frame(k); if (g) { mode = g.mode; break; } }
    }
    return { rms: 0, bass: 0, mid: 0, high: 0, bpm: 0, beatFlash: 0, beatPulse: 0, beat: false, isActive: false,
      mode: mode || this.app.visualizer.currentMode, spectrum: new Array(SessionRecord.BINS).fill(0) };
  }

  applyData(viz, d) {
    viz.audioData = { rms: d.rms, bass: d.bass, mid: d.mid, high: d.high, bpm: d.bpm, spectrum: d.spectrum, isActive: d.isActive };
    viz.beatFlash = d.beatFlash;
    viz.beatPulse = d.beatPulse;
    if (d.bpm > 0) viz.bpmInterval = 60000 / d.bpm;
  }

  // Spectrum Bars as canvas drawing (live it is page elements): the band
  // colours repeat bar by bar, low frequencies on the left, as on screen.
  drawSpectrum(ctx, W, H, d) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const pad = Math.round(H * 0.03);
    const n = 64;                                 // = the 256 bars on screen, two by two
    const slot = (W - pad * 2) / n, bar = Math.max(1, slot * 0.66);
    const cols = [[255, 80, 80], [80, 255, 120], [80, 160, 255]];
    const top = H - pad * 2;
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(1, d.spectrum[i] || 0));
      const h = v * top;
      if (h < 0.5) continue;
      const x = pad + i * slot + (slot - bar) / 2, y = H - pad - h;
      const c = cols[i % 3];
      const g = ctx.createLinearGradient(0, y, 0, H - pad);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0.8)`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},1)`);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, bar, h);
    }
  }

  // ---- clips ----------------------------------------------------------------

  // The cut on air at t and, inside a blend, the outgoing cut.
  segmentsAt(scene, t) {
    const edl = scene.edl;
    let k = scene.segIdx;
    if (k >= edl.length || (edl[k] && edl[k].start > t)) k = 0;
    while (k < edl.length && edl[k].end <= t) k++;
    scene.segIdx = k;
    const cur = edl[k] && edl[k].start <= t ? edl[k] : null;
    if (!cur) return { cur: null };
    let out = null, progress = 1;
    if (cur.blendSec > 0 && t - cur.start < cur.blendSec && k > 0 && Math.abs(edl[k - 1].end - cur.start) < 0.05) {
      out = edl[k - 1];
      progress = (t - cur.start) / cur.blendSec;
    }
    return { cur, out, progress };
  }

  // Where in the clip file a cut is at master time t: playback runs from the
  // in-point; regular clips loop, story clips play once and hold the end.
  clipTime(seg, asset, t, dur) {
    const ct = seg.inPoint + (t - seg.start);
    if (!(dur > 0)) return Math.max(0, ct);
    if (seg.story) return Math.max(0, Math.min(ct, dur - 0.001));
    return ((ct % dur) + dur) % dur;
  }

  async loadClipFrames(scene, t) {
    const { cur, out, progress } = this.segmentsAt(scene, t);
    const engine = this.app.clipEngine;
    const handle = async (seg, role) => {
      if (!seg) return null;
      const a = engine.clipById(seg.clipId);
      if (!a || !a.file) return null;
      if (a.kind === 'image') return { g: await this.imageGraphics(scene, a.file, `img:${a.id}`) };
      const src = await this.videoSource(scene, a.file, `clip:${a.id}:${role}`);
      return { g: await src.frameAt(this.clipTime(seg, a, t, src.duration)) };
    };
    scene.clipFrame = {
      cur: await handle(cur, 'a'),
      out: out ? await handle(out, out.clipId === (cur && cur.clipId) ? 'b' : 'a') : null,
      def: cur ? ClipTransitions.get(cur.transition) : null,
      progress,
    };
  }

  async loadLayerFrames(scene, t) {
    for (const slot of ['background', 'bass', 'mid', 'high']) {
      const L = scene.viz.layers[slot];
      // Layer videos loop on their own clock live; here they loop on the master time.
      if (L.source) L.media = await L.source.frameAt(L.source.duration > 0 ? t % L.source.duration : t);
    }
  }

  drawClips(scene, p) {
    const cf = scene.clipFrame;
    const drawClip = (clip, { alpha = 1, offsetX = 0, scale = 1 } = {}) => {
      if (!clip || !clip.g) return;
      const vw = clip.g.width, vh = clip.g.height;
      if (!vw || !vh) return;
      const cover = Math.max(p.width / vw, p.height / vh) * scale;
      const w = vw * cover, h = vh * cover;
      p.push();
      p.translate(offsetX, 0);
      p.tint(255, Math.max(0, Math.min(1, alpha)) * 255);
      p.image(clip.g, -w / 2, -h / 2, w, h);
      p.pop();
    };
    if (cf && cf.cur) {
      if (cf.out && cf.progress < 1) cf.def.render(p, cf.progress, cf.out, cf.cur, drawClip);
      else drawClip(cf.cur);
    }
    p.noTint();
    if (this.app.clipEngine.settings.overlayLayers) scene.viz.drawReactiveLayers(p);
  }

  // Decoded image as a p5 graphic (cached).
  async imageGraphics(scene, file, key) {
    if (scene.images.has(key)) return scene.images.get(key);
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const s = Math.min(1, Math.max(scene.W, scene.H) / Math.max(bmp.width, bmp.height));
    const g = scene.p.createGraphics(Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s)));
    g.pixelDensity(1);
    g.drawingContext.drawImage(bmp, 0, 0, g.width, g.height);
    bmp.close();
    scene.images.set(key, g);
    return g;
  }

  // Frame-accurate video reader: decodes forward from the last position and
  // only seeks (from the nearest keyframe) when the request jumps.
  async videoSource(scene, file, key) {
    if (scene.sources.has(key)) return scene.sources.get(key);
    const M = scene.M;
    const input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`No video in ${file.name}`);
    const duration = await input.computeDuration();
    const dw = await track.getDisplayWidth(), dh = await track.getDisplayHeight();
    // Decode no bigger than needed to cover the output frame.
    const s = Math.min(1, Math.max(scene.W / dw, scene.H / dh));
    const w = Math.max(2, Math.round(dw * s)), h = Math.max(2, Math.round(dh * s));
    const sink = new M.CanvasSink(track, { width: w, height: h, fit: 'fill', poolSize: 0 });
    const g = scene.p.createGraphics(w, h);
    g.pixelDensity(1);
    const src = {
      duration, iter: null, cur: null, next: null, shown: null,
      async restart(t) {
        if (this.iter) { try { await this.iter.return(); } catch (_) { /* ended */ } }
        this.iter = sink.canvases(Math.max(0, t));
        this.cur = null;
        const r = await this.iter.next();
        this.next = r.done ? null : r.value;
      },
      async frameAt(t) {
        const ahead = this.next ? this.next.timestamp : (this.cur ? this.cur.timestamp + this.cur.duration : -1);
        if (!this.iter || (this.cur && t < this.cur.timestamp - 1e-4) || (!this.cur && this.next && t < this.next.timestamp - 0.05) || t > ahead + 1.5) {
          await this.restart(t);
        }
        while (this.next && this.next.timestamp <= t + 1e-4) {
          this.cur = this.next;
          const r = await this.iter.next();
          this.next = r.done ? null : r.value;
        }
        const show = this.cur || this.next;
        if (show && show !== this.shown) {
          g.drawingContext.drawImage(show.canvas, 0, 0, w, h);
          this.shown = show;
        }
        return g;
      },
      dispose() { if (this.iter) this.iter.return().catch(() => {}); g.remove(); },
    };
    scene.sources.set(key, src);
    return src;
  }

  // ---- audio ----------------------------------------------------------------

  async decode(blob) {
    const ctx = new OfflineAudioContext(2, 1, OfflineRenderer.SR);
    return ctx.decodeAudioData(await blob.arrayBuffer());
  }

  // Everything that sounds, placed on the master timeline.
  async prepareAudio(edl) {
    const app = this.app, parts = [];
    if (app.isTrackMode() && app.trackSource.file && !app.musicMuted) {
      // Fades follow the mode that was on screen at each moment.
      const rec = app.record;
      const modeAt = (t) => { const f = rec.frame(Math.round(t * SessionRecord.FPS)); return f ? f.mode : app.visualizer.currentMode; };
      parts.push({ buffer: await this.decode(app.trackSource.file), at: 0, offset: 0, level: (t) => app.storyFadeLevel(t, modeAt(t)) });
    }
    const v = app.voice;
    if (v.isLoaded && v.blob && !v.muted) {
      const norm = v.normalize && v.stats ? VoiceTrack.normGainFor(v.stats) : 1;
      parts.push({ buffer: await this.decode(v.blob), at: v.offset, offset: 0, gain: norm * v.volume });
    }
    // Story clips play with their own sound (Q9).
    const cache = new Map();
    for (const s of edl) {
      if (!s.story) continue;
      const a = app.clipEngine.clipById(s.clipId);
      if (!a || a.kind !== 'video' || !a.file) continue;
      if (!cache.has(a.id)) cache.set(a.id, await this.decode(a.file).catch(() => null));
      const buf = cache.get(a.id);
      if (buf) parts.push({ buffer: buf, at: s.start, offset: s.inPoint, length: s.end - s.start, gain: 1 });
    }
    return parts;
  }

  async mixChunk(parts, a, b) {
    const SR = OfflineRenderer.SR;
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.round((b - a) * SR)), SR);
    for (const part of parts) {
      const len = Math.min(part.length != null ? part.length : Infinity, part.buffer.duration - part.offset);
      const s0 = part.at, s1 = part.at + len;
      if (s1 <= a || s0 >= b) continue;
      const from = Math.max(s0, a), to = Math.min(s1, b);
      const node = ctx.createBufferSource();
      node.buffer = part.buffer;
      const g = ctx.createGain();
      if (part.level) {
        // Fades follow the master time (sampled every 10 ms).
        const n = Math.max(2, Math.ceil((to - from) * 100) + 1);
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = part.level(from + (i / (n - 1)) * (to - from));
        g.gain.setValueCurveAtTime(curve, from - a, Math.max(0.001, to - from));
      } else {
        g.gain.value = part.gain;
      }
      node.connect(g).connect(ctx.destination);
      node.start(from - a, part.offset + (from - s0), to - from);
    }
    return ctx.startRendering();
  }
}

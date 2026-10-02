// Video clip auto-editor.
//
// Advances through a set of uploaded video clips in sync with the music,
// recording each switch as a segment on a clip timeline laid against the
// master (track / live-session) timeline.
//
// Timing source: this does NOT detect beats itself. It reads the beat clock
// DJVisualizer already maintains from audioData.bpm (lastBeatTime /
// bpmInterval, the same clock behind beatFlash/beatPulse). Each time that
// clock ticks we advance one beat; sub-beat position is interpolated from
// bpmInterval. Switch intervals are expressed in beats (see musicalTime.js).
class ClipEngine {
  constructor(visualizer) {
    this.viz = visualizer;
    this.assets = [];        // every imported image/video: one typed list (v2.1, D-44)
    this.nextClipId = 1;
    this.selectedId = null;  // selection shared by 03 Assets and the Action Editor

    this.settings = {
      timingMode: 'auto',      // 'auto' | 'manual'
      autoPace: 'driving',     // key of MusicalTime.AUTO_PACES
      manualCount: 2,
      manualUnit: 'beat',      // key of MusicalTime.UNITS
      order: 'sequential',     // 'sequential' | 'random' | 'band'
      transitionMode: 'band',  // 'band' (auto by band) | a ClipTransitions id
      inPoint: 'random',       // 'random' | 'resume' | 'start'
      overlayLayers: false,    // draw Media Layers (bass/mid/high) over clips
    };
    // Used when transitionMode === 'band': which band triggered the switch
    // picks the transition.
    this.bandTransitions = { bass: 'jump', mid: 'crossfade', high: 'blur' };

    // Master timeline hooks, supplied by the app.
    this.clock = () => 0;            // seconds on the master timeline
    this.isAdvancing = () => false;  // true while the timeline is rolling

    this.listeners = new Set();
    this.bandAvg = { bass: 0.05, mid: 0.05, high: 0.05 };
    this.bandRatio = { bass: 1, mid: 1, high: 1 };
    this.dominant = 'bass';
    this.reset();
  }

  // ---- lifecycle -------------------------------------------------------

  reset() {
    this.pauseAll();
    this.segments = [];     // { clipId, start, end, inPoint, transition, band, beat }
    this.beats = [];        // { time, index } -- beat grid as the engine saw it
    this.beatIndex = -1;
    this.lastSeenBeatTime = null;
    this.nextCutPos = null;  // beat position of the next scheduled cut
    this.segStartPos = null; // beat position the current shot started on
    this.holdBeats = null;   // current shot's hold length (beats)
    this.current = null;    // { clip, segment }
    this.outgoing = null;
    this.pending = null;    // pre-rolled next clip { clip, inPoint }
    this.transition = null; // { def, startMs, lengthMs }
    this.emit('reset');
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail) { this.listeners.forEach(fn => fn(type, detail)); }

  // ---- assets ----------------------------------------------------------
  //
  // One entry per imported file. Defaults reproduce v2: a new asset is an
  // auto-edit clip at the bottom of the stack, Global pace, any band, no
  // Media Layer, no story role.

  // Assets used as auto-edit clips, in stack (Importance) order.
  get clips() {
    return this.assets.filter(a => a.asClip).sort((a, b) => a.importance - b.importance);
  }

  addFiles(fileList) {
    Array.from(fileList)
      .filter(f => f.type.startsWith('video/') || f.type.startsWith('image/'))
      .forEach(f => this.addAsset(f));
  }

  addAsset(file) {
    const p = this.viz.p5Instance;
    if (!p) return;
    const kind = file.type.startsWith('image/') ? 'image' : 'video';
    const asset = {
      id: this.nextClipId++, name: file.name.replace(/\.[^.]+$/, ''), file,
      url: URL.createObjectURL(file), kind,
      media: null, el: null, duration: 0, width: 0, height: 0, thumb: null,
      lastPos: 0, ready: false, error: null,
      asClip: true,              // "Use as: Auto-edit clip"
      layer: null,               // "Use as: Media Layer" slot -> visualizer.layers
      band: 'any',
      pace: 'global',            // 'global' or a MusicalTime.AUTO_PACES key -- how long this clip holds
      importance: this.clips.length + 1,   // = position in the Action Editor stack
      story: 'none',             // 'none' | 'hook' | 'result' | 'cta' (Story Mode only)
      storyHold: 3,              // seconds an image story block holds (Q9)
    };
    this.assets.push(asset);
    if (kind === 'image') this.loadImageAsset(asset);
    else this.loadVideoAsset(asset);
    this.emit('clips');
    return asset;
  }

  loadImageAsset(asset) {
    this.viz.p5Instance.loadImage(asset.url, (img) => {
      asset.media = img;
      asset.width = img.width;
      asset.height = img.height;
      asset.ready = true;
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.max(1, Math.round(160 * img.height / (img.width || 1)));
      c.getContext('2d').drawImage(img.canvas, 0, 0, c.width, c.height);
      asset.thumb = c;
      this.emit('clips');
    }, () => {
      asset.error = 'Can’t decode this file in this browser';
      this.emit('clips');
    });
  }

  loadVideoAsset(clip) {
    const p = this.viz.p5Instance;
    const url = clip.url;
    const media = p.createVideo([url], () => {
      // Some files (e.g. MediaRecorder WebM) report Infinity until probed;
      // makeThumb() resolves the real duration in that case.
      if (isFinite(media.elt.duration)) clip.duration = media.elt.duration;
      clip.ready = true;
      this.emit('clips');
    });
    // Unsupported codec/container (e.g. H.264 MP4 in VS Code's Simple
    // Browser, which ships without proprietary codecs) never fires the
    // ready callback -- flag it so the bin can say so instead of the clip
    // silently never appearing.
    media.elt.addEventListener('error', () => {
      clip.error = 'Can’t decode this file in this browser';
      clip.ready = false;
      this.emit('clips');
    });
    media.hide();
    media.volume(0);
    media.elt.muted = true;
    media.elt.loop = true;
    media.elt.playsInline = true;
    media.elt.addEventListener('loadedmetadata', () => {
      clip.width = media.elt.videoWidth;
      clip.height = media.elt.videoHeight;
    }, { once: true });
    clip.media = media;
    clip.el = media.elt;
    this.makeThumb(clip);
  }

  // Poster frame (and, if needed, the real duration) from a separate
  // <video> so it never disturbs playback.
  makeThumb(clip) {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = clip.url;
    const seekToPoster = () => {
      if (isFinite(v.duration)) clip.duration = v.duration;
      v.addEventListener('seeked', capture, { once: true });
      v.currentTime = Math.min(1, (clip.duration || 0) * 0.15);
    };
    v.addEventListener('loadeddata', () => {
      if (isFinite(v.duration)) { seekToPoster(); return; }
      // Duration unknown: seeking far past the end makes the browser
      // scan the file and report the real duration.
      v.addEventListener('seeked', seekToPoster, { once: true });
      v.currentTime = 1e101;
    }, { once: true });
    const capture = () => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.round(160 * (v.videoHeight || 9) / (v.videoWidth || 16));
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      clip.thumb = c;
      v.removeAttribute('src');
      this.emit('clips');
    };
  }

  removeAsset(id) {
    const clip = this.clipById(id);
    if (!clip) return;
    if (this.current && this.current.clip === clip) this.current = null;
    if (this.outgoing && this.outgoing.clip === clip) { this.outgoing = null; this.transition = null; }
    if (this.pending && this.pending.clip === clip) this.pending = null;
    if (clip.layer) this.viz.clearLayerMedia(clip.layer);
    if (clip.kind === 'video' && clip.media) clip.media.remove();
    URL.revokeObjectURL(clip.url);
    this.assets = this.assets.filter(c => c !== clip);
    if (this.selectedId === id) this.selectedId = null;
    this.renumber();
    this.emit('clips');
  }

  setClipBand(id, band) {
    const clip = this.clipById(id);
    if (clip) { clip.band = band; this.emit('clips'); }
  }

  setClipPace(id, pace) {
    const clip = this.clipById(id);
    if (clip) { clip.pace = pace; this.emit('clips'); }
  }

  // "Use as: Auto-edit clip". Re-enabling puts the clip at the bottom of
  // the stack, like a new upload.
  setAssetAsClip(id, on) {
    const a = this.clipById(id);
    if (!a || a.asClip === on) return;
    a.asClip = on;
    if (on) a.importance = Infinity;
    this.renumber();
    this.emit('clips');
  }

  // Importance = position in the Action Editor stack (1 = top, D-32).
  // Moving a clip renumbers the whole stack so positions stay 1..N.
  moveClip(id, toIndex) {
    const stack = this.clips;
    const from = stack.findIndex(c => c.id === id);
    if (from < 0) return;
    const [clip] = stack.splice(from, 1);
    stack.splice(Math.max(0, Math.min(stack.length, toIndex)), 0, clip);
    stack.forEach((c, i) => { c.importance = i + 1; });
    this.emit('clips');
  }

  setClipImportance(id, n) { this.moveClip(id, Math.round(n) - 1); }

  renumber() {
    this.clips.forEach((c, i) => { c.importance = i + 1; });
  }

  // "Use as: Media Layer". Drives the existing layer engine
  // (DJVisualizer.loadLayerMedia / clearLayerMedia) unchanged, so layers
  // look and react exactly as before. One asset per slot: taking a slot
  // that's in use releases it from the other asset.
  setAssetLayer(id, slot) {
    const a = this.clipById(id);
    if (!a || a.layer === slot) return;
    if (a.layer) { this.viz.clearLayerMedia(a.layer); a.layer = null; }
    if (slot) {
      const holder = this.assets.find(x => x.layer === slot);
      if (holder) holder.layer = null;
      this.viz.loadLayerMedia(slot, a.file);
      a.layer = slot;
    }
    this.emit('clips');
  }

  select(id) {
    this.selectedId = id;
    this.emit('select', id);
  }

  clipById(id) { return this.assets.find(c => c.id === id); }

  pauseAll() {
    (this.assets || []).forEach(c => { if (c.el && !c.el.paused) c.el.pause(); });
  }

  // ---- timing ----------------------------------------------------------

  // Global switch interval from the Auto-Editor panel.
  intervalBeats(bpm) {
    const s = this.settings;
    if (s.timingMode === 'auto') return MusicalTime.autoMultiplier(bpm, s.autoPace).beats;
    return MusicalTime.toBeats(s.manualCount, s.manualUnit);
  }

  // How long a given clip holds once it's on screen: its own pace if set,
  // otherwise the global interval. Per-clip pace wins over manual timing too.
  intervalFor(clip, bpm) {
    if (clip && clip.pace && clip.pace !== 'global') return MusicalTime.autoMultiplier(bpm, clip.pace).beats;
    return this.intervalBeats(bpm);
  }

  status() {
    const bpm = (this.viz.audioData && this.viz.audioData.bpm) || 0;
    const curClip = this.current && this.current.clip;
    const beats = this.intervalFor(curClip, bpm);
    let state = 'running';
    if (this.clips.length === 0) state = 'no-clips';
    else if (!this.clips.some(c => c.ready) && this.clips.some(c => c.error)) state = 'unplayable';
    else if (!this.isAdvancing()) state = 'idle';
    else if (!(bpm > 0) || this.beatIndex < 0) state = 'waiting-bpm';
    return {
      state, bpm,
      intervalBeats: beats,
      intervalMs: MusicalTime.beatsToMs(beats, bpm),
      globalBeats: this.intervalBeats(bpm),
      clipPace: curClip && curClip.pace && curClip.pace !== 'global' ? curClip.pace : null,
      nextCutPos: this.nextCutPos,
      autoLabel: MusicalTime.autoMultiplier(bpm, this.settings.autoPace).label,
      dominant: this.dominant,
      position: this.beatIndex >= 0 ? this.beatIndex + this.beatPhase() : -1,
    };
  }

  beatPhase() {
    if (!this.viz.bpmInterval || this.lastSeenBeatTime == null) return 0;
    return Math.min(0.999, Math.max(0, (Date.now() - this.lastSeenBeatTime) / this.viz.bpmInterval));
  }

  // Called once per analysis frame, after DJVisualizer.updateAudioData().
  update(audioData) {
    this.trackBands(audioData);
    if (!this.isAdvancing() || this.clips.length === 0) return;

    const bpm = audioData.bpm || 0;

    // Put a clip on screen as soon as the timeline rolls; beat-locked
    // cutting takes over once BPM locks (the first beat cuts).
    if (!this.current) this.cut(bpm, null);

    if (!(bpm > 0)) return;

    // Beat edge from the visualizer's clock.
    if (this.viz.lastBeatTime !== this.lastSeenBeatTime) {
      this.lastSeenBeatTime = this.viz.lastBeatTime;
      this.beatIndex++;
      this.beats.push({ time: this.clock(), index: this.beatIndex });
      if (this.beats.length > 20000) this.beats.splice(0, 5000);
      this.emit('beat', this.beatIndex);
    }
    if (this.beatIndex < 0) return;

    const pos = this.beatIndex + this.beatPhase();

    // First beat after start / seek / tempo lock: cut on it and start
    // scheduling from there.
    if (this.nextCutPos == null) {
      this.cut(bpm, Math.floor(pos));
      return;
    }

    // Each cut schedules the next one from the segment's own start, using
    // the on-screen clip's hold (its pace, or the global interval). If that
    // hold changes mid-shot (panel edit, clip pace edit, auto multiplier
    // stepping with tempo), reschedule without firing an extra cut.
    const hold = this.intervalFor(this.current && this.current.clip, bpm);
    if (hold !== this.holdBeats) {
      this.holdBeats = hold;
      const elapsed = pos - this.segStartPos;
      this.nextCutPos = this.segStartPos + Math.max(1, Math.ceil(elapsed / hold + 1e-6)) * hold;
    }

    if (pos >= this.nextCutPos - 1e-6) {
      this.cut(bpm, this.nextCutPos);
      return;
    }

    // Pre-roll: pick + seek the next clip up to one beat early so the
    // incoming frame is decoded by the time the cut lands.
    const untilCut = this.nextCutPos - pos;
    if (!this.pending && untilCut <= Math.min(1, hold / 2)) {
      this.pending = this.prepare(this.choose(), bpm);
    }
  }

  // Which band is currently most excited relative to its own recent level.
  // Raw values aren't comparable across bands (bass reads much hotter), so
  // each band is normalized by a slow running average of itself.
  trackBands(d) {
    let best = this.dominant, bestRatio = -1;
    ['bass', 'mid', 'high'].forEach(b => {
      const v = d[b] || 0;
      this.bandAvg[b] = this.bandAvg[b] * 0.985 + v * 0.015;
      const r = v / (this.bandAvg[b] + 0.01);
      this.bandRatio[b] = r;
      if (r > bestRatio) { bestRatio = r; best = b; }
    });
    // Small hysteresis so the dominant band doesn't flicker frame to frame.
    if (best !== this.dominant && this.bandRatio[best] > this.bandRatio[this.dominant] * 1.08) {
      this.dominant = best;
    }
  }

  // Clips the automation may pick: decoded, used as clips, in stack order.
  // (Story assets leave this pool in Story Mode -- step 7.)
  regularPool() {
    return this.clips.filter(c => c.ready);
  }

  // Importance (stack position) only changes WHICH clip is picked (D-32):
  //  - Sequential: the next clip down the stack, wrapping to the top.
  //  - Random / By band: weighted pick, top of the stack most often.
  //    Never the same clip twice in a row.
  choose() {
    const clips = this.regularPool();
    if (clips.length === 0) return null;
    const currentClip = this.current && this.current.clip;
    const s = this.settings;

    if (s.order === 'sequential') {
      const i = clips.indexOf(currentClip);
      return clips[(i + 1) % clips.length];
    }

    let pool = clips;
    if (s.order === 'band') {
      pool = clips.filter(c => c.band === this.dominant);
      if (pool.length === 0) pool = clips.filter(c => c.band === 'any');
      if (pool.length === 0) pool = clips;
    }
    return this.weightedPick(pool, currentClip);
  }

  // Weight = N − rank + 1 within the pool (rank 1 = highest in the stack),
  // so with 3 clips the odds are 3:2:1 (Q15).
  weightedPick(pool, exclude) {
    const cands = pool.length > 1 ? pool.filter(c => c !== exclude) : pool;
    const N = pool.length;
    const weights = cands.map(c => N - pool.indexOf(c));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i];
      if (r < 0) return cands[i];
    }
    return cands[cands.length - 1];
  }

  prepare(clip, bpm) {
    if (!clip) return null;
    // Images hold for their Pace; in-points don't apply (D-46).
    if (clip.kind === 'image') return { clip, inPoint: 0 };
    const dur = clip.duration || (isFinite(clip.el.duration) ? clip.el.duration : 0);
    let inPoint = 0;
    if (this.settings.inPoint === 'resume') inPoint = clip.lastPos || 0;
    else if (this.settings.inPoint === 'random') {
      const need = MusicalTime.beatsToMs(this.intervalFor(clip, bpm), bpm) / 1000;
      inPoint = Math.random() * Math.max(0, dur - need);
    }
    if (dur && inPoint >= dur) inPoint = 0;
    if (!(this.current && this.current.clip === clip)) {
      try { clip.el.currentTime = inPoint; } catch (e) { /* not seekable yet */ }
      clip.el.play().catch(() => {});
    }
    return { clip, inPoint };
  }

  // atPos: musical position (beats) this cut lands on, or null before the
  // tempo has locked (the clip just goes on screen; no schedule yet).
  cut(bpm, atPos) {
    const next = this.pending || this.prepare(this.choose(), bpm);
    this.pending = null;
    if (!next) return;
    if (next.clip.el && next.clip.el.paused) next.clip.el.play().catch(() => {});

    const hold = this.intervalFor(next.clip, bpm);
    if (atPos != null) {
      this.segStartPos = atPos;
      this.holdBeats = hold;
      this.nextCutPos = atPos + hold;
    }

    const now = this.clock();
    const band = this.dominant;
    const transitionId = this.settings.transitionMode === 'band'
      ? this.bandTransitions[band]
      : this.settings.transitionMode;
    const def = ClipTransitions.get(transitionId);

    // Finish any blend still running before starting a new one.
    if (this.outgoing && this.outgoing.clip !== next.clip) this.retire(this.outgoing.clip);

    if (this.current) {
      this.current.segment.end = now;
      this.outgoing = this.current;
    }

    const segment = {
      clipId: next.clip.id, start: now, end: null, inPoint: next.inPoint,
      transition: def.id, band, beat: this.beatIndex,
      pace: next.clip.pace, holdBeats: hold,
    };
    this.segments.push(segment);
    if (this.segments.length > 5000) this.segments.splice(0, 1000);
    this.current = { clip: next.clip, segment };

    // Blend length scales with tempo; never longer than the incoming shot.
    const lengthMs = Math.min(
      MusicalTime.beatsToMs(def.lengthBeats, bpm),
      MusicalTime.beatsToMs(hold, bpm) * 0.9
    );
    this.transition = lengthMs > 0 && this.outgoing ? { def, startMs: performance.now(), lengthMs } : null;
    segment.blendSec = this.transition ? lengthMs / 1000 : 0;
    if (!this.transition && this.outgoing) {
      if (this.outgoing.clip !== next.clip) this.retire(this.outgoing.clip);
      this.outgoing = null;
    }
    this.emit('cut', segment);
  }

  retire(clip) {
    if (!clip || !clip.el) return;
    clip.lastPos = clip.el.currentTime;
    const inUse = (this.current && this.current.clip === clip) || (this.pending && this.pending.clip === clip);
    if (!inUse) clip.el.pause();
  }

  // Master-timeline seek (track mode). Everything recorded after the new
  // playhead is discarded and regenerated live from there.
  seekTo(seconds) {
    this.segments = this.segments.filter(s => s.start < seconds);
    const last = this.segments[this.segments.length - 1];
    if (last) last.end = seconds;
    this.beats = this.beats.filter(b => b.time < seconds);
    this.beatIndex = this.beats.length ? this.beats[this.beats.length - 1].index : -1;
    this.lastSeenBeatTime = this.viz.lastBeatTime;
    this.nextCutPos = null;   // forces a cut on the next frame
    this.segStartPos = null;
    this.holdBeats = null;
    this.pending = null;
    this.emit('seek', seconds);
  }

  // Leaving clips mode or stopping audio: hold still, keep the recording.
  setActive(active) {
    if (!active) this.pauseAll();
    else if (this.current && this.current.clip.el) this.current.clip.el.play().catch(() => {});
  }

  // ---- rendering -------------------------------------------------------

  draw(p) {
    const drawClip = (clip, { alpha = 1, offsetX = 0, scale = 1 } = {}) => {
      if (!clip || !clip.media) return;
      // Videos and images share the same cover-fit path and transitions.
      const vw = clip.kind === 'image' ? clip.media.width : clip.el.videoWidth;
      const vh = clip.kind === 'image' ? clip.media.height : clip.el.videoHeight;
      if (!vw || !vh) return;
      const cover = Math.max(p.width / vw, p.height / vh) * scale;
      const w = vw * cover, h = vh * cover;
      p.push();
      p.translate(offsetX, 0);
      p.tint(255, Math.max(0, Math.min(1, alpha)) * 255);
      p.image(clip.media, -w / 2, -h / 2, w, h);
      p.pop();
    };

    if (!this.current) {
      // Not rolling yet: show the first clip's frame as a preview.
      const first = this.clips.find(c => c.ready);
      if (first) drawClip(first, { alpha: 0.35 });
    } else if (this.transition) {
      const t = (performance.now() - this.transition.startMs) / this.transition.lengthMs;
      if (t >= 1) {
        if (this.outgoing && this.outgoing.clip !== this.current.clip) this.retire(this.outgoing.clip);
        this.outgoing = null;
        this.transition = null;
        drawClip(this.current.clip);
      } else {
        this.transition.def.render(p, t, this.outgoing && this.outgoing.clip, this.current.clip, drawClip);
      }
    } else {
      drawClip(this.current.clip);
    }
    p.noTint();

    if (this.settings.overlayLayers && this.viz.drawReactiveLayers) this.viz.drawReactiveLayers(p);
  }

  // Name of whatever is on screen right now (for the viewport HUD).
  nowShowing() {
    if (!this.current) return null;
    return {
      clip: this.current.clip,
      segment: this.current.segment,
      transition: this.transition ? this.transition.def : null,
    };
  }
}

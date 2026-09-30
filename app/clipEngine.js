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
    this.clips = [];
    this.nextClipId = 1;

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
    this.lastSlot = null;
    this.lastInterval = null;
    this.current = null;    // { clip, segment }
    this.outgoing = null;
    this.pending = null;    // pre-rolled next clip { clip, inPoint }
    this.transition = null; // { def, startMs, lengthMs }
    this.cursor = { all: -1, bass: -1, mid: -1, high: -1, any: -1 };
    this.emit('reset');
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, detail) { this.listeners.forEach(fn => fn(type, detail)); }

  // ---- clips -----------------------------------------------------------

  addFiles(fileList) {
    Array.from(fileList)
      .filter(f => f.type.startsWith('video/'))
      .forEach(f => this.addClip(f));
  }

  addClip(file) {
    const p = this.viz.p5Instance;
    if (!p) return;
    const url = URL.createObjectURL(file);
    const clip = {
      id: this.nextClipId++, name: file.name.replace(/\.[^.]+$/, ''), file, url,
      media: null, el: null, duration: 0, band: 'any', thumb: null, lastPos: 0, ready: false,
    };
    const media = p.createVideo([url], () => {
      // Some files (e.g. MediaRecorder WebM) report Infinity until probed;
      // makeThumb() resolves the real duration in that case.
      if (isFinite(media.elt.duration)) clip.duration = media.elt.duration;
      clip.ready = true;
      this.emit('clips');
    });
    media.hide();
    media.volume(0);
    media.elt.muted = true;
    media.elt.loop = true;
    media.elt.playsInline = true;
    clip.media = media;
    clip.el = media.elt;
    this.clips.push(clip);
    this.makeThumb(clip);
    this.emit('clips');
    return clip;
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

  removeClip(id) {
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    if (this.current && this.current.clip === clip) this.current = null;
    if (this.outgoing && this.outgoing.clip === clip) { this.outgoing = null; this.transition = null; }
    if (this.pending && this.pending.clip === clip) this.pending = null;
    clip.media.remove();
    URL.revokeObjectURL(clip.url);
    this.clips = this.clips.filter(c => c !== clip);
    this.emit('clips');
  }

  setClipBand(id, band) {
    const clip = this.clips.find(c => c.id === id);
    if (clip) { clip.band = band; this.emit('clips'); }
  }

  clipById(id) { return this.clips.find(c => c.id === id); }

  pauseAll() {
    (this.clips || []).forEach(c => { if (c.el && !c.el.paused) c.el.pause(); });
  }

  // ---- timing ----------------------------------------------------------

  intervalBeats(bpm) {
    const s = this.settings;
    if (s.timingMode === 'auto') return MusicalTime.autoMultiplier(bpm, s.autoPace).beats;
    return MusicalTime.toBeats(s.manualCount, s.manualUnit);
  }

  status() {
    const bpm = (this.viz.audioData && this.viz.audioData.bpm) || 0;
    const beats = this.intervalBeats(bpm);
    let state = 'running';
    if (this.clips.length === 0) state = 'no-clips';
    else if (!this.isAdvancing()) state = 'idle';
    else if (!(bpm > 0) || this.beatIndex < 0) state = 'waiting-bpm';
    return {
      state, bpm,
      intervalBeats: beats,
      intervalMs: MusicalTime.beatsToMs(beats, bpm),
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

    const interval = this.intervalBeats(bpm);
    const pos = this.beatIndex + this.beatPhase();
    const slot = Math.floor(pos / interval + 1e-6);

    // Interval changed (user or auto-tempo): re-sync to the new grid
    // without firing an extra cut; the next boundary cuts as normal.
    if (interval !== this.lastInterval) {
      const first = this.lastSlot == null;
      this.lastInterval = interval;
      if (!first) { this.lastSlot = slot; this.pending = null; return; }
    }

    if (slot !== this.lastSlot) {
      this.lastSlot = slot;
      this.cut(bpm, interval);
      return;
    }

    // Pre-roll: pick + seek the next clip up to one beat early so the
    // incoming frame is decoded by the time the cut lands.
    const untilCut = (slot + 1) * interval - pos;
    if (!this.pending && untilCut <= Math.min(1, interval / 2)) {
      this.pending = this.prepare(this.choose(), interval, bpm);
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

  choose() {
    const clips = this.clips.filter(c => c.ready);
    if (clips.length === 0) return null;
    const currentClip = this.current && this.current.clip;
    const s = this.settings;

    if (s.order === 'random') {
      if (clips.length === 1) return clips[0];
      let pick;
      do { pick = clips[Math.floor(Math.random() * clips.length)]; } while (pick === currentClip);
      return pick;
    }

    let pool = clips, key = 'all';
    if (s.order === 'band') {
      key = this.dominant;
      pool = clips.filter(c => c.band === key);
      if (pool.length === 0) { key = 'any'; pool = clips.filter(c => c.band === 'any'); }
      if (pool.length === 0) { key = 'all'; pool = clips; }
    }
    this.cursor[key] = (this.cursor[key] + 1) % pool.length;
    let pick = pool[this.cursor[key]];
    if (pick === currentClip && pool.length > 1) {
      this.cursor[key] = (this.cursor[key] + 1) % pool.length;
      pick = pool[this.cursor[key]];
    }
    return pick;
  }

  prepare(clip, intervalBeats, bpm) {
    if (!clip) return null;
    const dur = clip.duration || (isFinite(clip.el.duration) ? clip.el.duration : 0);
    let inPoint = 0;
    if (this.settings.inPoint === 'resume') inPoint = clip.lastPos || 0;
    else if (this.settings.inPoint === 'random') {
      const need = MusicalTime.beatsToMs(intervalBeats, bpm) / 1000;
      inPoint = Math.random() * Math.max(0, dur - need);
    }
    if (dur && inPoint >= dur) inPoint = 0;
    if (!(this.current && this.current.clip === clip)) {
      try { clip.el.currentTime = inPoint; } catch (e) { /* not seekable yet */ }
      clip.el.play().catch(() => {});
    }
    return { clip, inPoint };
  }

  cut(bpm, intervalBeats) {
    const next = this.pending || this.prepare(this.choose(), intervalBeats, bpm);
    this.pending = null;
    if (!next) return;
    if (next.clip.el.paused) next.clip.el.play().catch(() => {});

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
    };
    this.segments.push(segment);
    if (this.segments.length > 5000) this.segments.splice(0, 1000);
    this.current = { clip: next.clip, segment };

    // Blend length scales with tempo; never longer than the switch interval.
    const lengthMs = Math.min(
      MusicalTime.beatsToMs(def.lengthBeats, bpm),
      MusicalTime.beatsToMs(intervalBeats, bpm) * 0.9
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
    this.lastSlot = null;   // forces a cut on the next frame
    this.pending = null;
    this.emit('seek', seconds);
  }

  // Leaving clips mode or stopping audio: hold still, keep the recording.
  setActive(active) {
    if (!active) this.pauseAll();
    else if (this.current) this.current.clip.el.play().catch(() => {});
  }

  // ---- rendering -------------------------------------------------------

  draw(p) {
    const drawClip = (clip, { alpha = 1, offsetX = 0, scale = 1 } = {}) => {
      if (!clip || !clip.el || !clip.el.videoWidth) return;
      const vw = clip.el.videoWidth, vh = clip.el.videoHeight;
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

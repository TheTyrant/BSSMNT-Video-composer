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
      storyMode: true,         // D-58: positions (Hook / Result / CTA) are always available; with none set this is Free Mode
      storyFade: false,        // Auto Fade Music to Story Blocks
    };
    // Used when transitionMode === 'band': which band triggered the switch
    // picks the transition.
    this.bandTransitions = { bass: 'jump', mid: 'crossfade', high: 'blur' };

    // Master timeline hooks, supplied by the app.
    this.clock = () => 0;            // seconds on the master timeline
    this.isAdvancing = () => false;  // true while the timeline is rolling
    this.songDuration = () => 0;     // track length in track mode, 0 in live mode

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
    this.story = null;      // story block on screen, if any
    // Session record (D-56): segments/beats are kept across seeks. Each
    // play-through after a seek is a "pass" that overwrites only the span
    // it actually plays, like punching in on a DAW track.
    this.pass = 0;
    this.passStart = 0;
    this.lastAdvanceTime = 0;
    this.fired = [];        // live mode: story roles fired this session { role, at }
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

  // Video or image by MIME type, or by extension when the system reports
  // none (common on Windows for some video files). null = not usable.
  static kindOf(f) {
    if (f.type.startsWith('video/')) return 'video';
    if (f.type.startsWith('image/')) return 'image';
    if (/.(mp4|m4v|mov|webm|mkv|ogv|3gp|avi)$/i.test(f.name)) return 'video';
    if (/.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name)) return 'image';
    return null;
  }

  // Returns { added, rejected } so callers can say what happened instead
  // of silently skipping files.
  addFiles(fileList) {
    const added = [], rejected = [];
    Array.from(fileList || []).forEach(f => {
      const kind = ClipEngine.kindOf(f);
      const a = kind ? this.addAsset(f, kind) : null;
      if (a) added.push(a); else rejected.push(f.name);
    });
    this.emit('added', { added, rejected });
    return { added, rejected };
  }

  addAsset(file, kind = ClipEngine.kindOf(file) || 'video', opts = {}) {
    const p = this.viz.p5Instance;
    if (!p) return;
    if (opts.id) this.nextClipId = Math.max(this.nextClipId, opts.id + 1);
    const asset = {
      id: opts.id || this.nextClipId++, name: file.name.replace(/\.[^.]+$/, ''), file,
      url: URL.createObjectURL(file), kind,
      media: null, el: null, duration: 0, width: 0, height: 0, thumb: null,
      lastPos: 0, ready: false, error: null, rotation: 0,
      asClip: true,              // "Use as: Auto-edit clip"
      layer: null,               // "Use as: Media Layer" slot -> visualizer.layers
      band: 'any',
      pace: 'global',            // 'global' or a MusicalTime.AUTO_PACES key -- how long this clip holds
      importance: this.clips.length + 1,   // = position in the Action Editor stack
      story: 'none',             // 'none' | 'hook' | 'result' | 'cta' (Story Mode only)
      storyHold: 3,              // seconds an image story block holds (Q9)
      fade: { on: false, curve: 'smooth', bars: 1 },   // Auto Fade Music around this locked clip (D-59)
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
    // Rotated phone video: draw through a 2D copy (D-54).
    clip.rotation = 0;
    VideoOrientation.detect(clip.file).then((rot) => {
      clip.rotation = rot;
      if (rot) clip.bridge = VideoOrientation.bridge(p, media);
      this.emit('clips');
    });
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

  // ---- project restore (D-57) -------------------------------------------

  // An asset from a saved project whose file isn't connected yet. It keeps
  // its id (the recorded cut list refers to it), its settings and its saved
  // thumbnail, shows as "Offline" and is skipped by the automation.
  addOfflineAsset(saved, thumb) {
    this.nextClipId = Math.max(this.nextClipId, saved.id + 1);
    const asset = {
      id: saved.id, name: saved.name, file: null, url: null, kind: saved.kind,
      media: null, el: null, duration: saved.duration || 0, width: saved.width || 0, height: saved.height || 0,
      thumb: thumb || null, lastPos: 0, ready: false, error: null, offline: true, ref: saved.ref,
      asClip: saved.asClip, layer: saved.layer, band: saved.band, pace: saved.pace,
      importance: saved.importance, story: saved.story, storyHold: saved.storyHold, rotation: saved.rotation || 0,
      fade: { on: false, curve: 'smooth', bars: 1, ...(saved.fade || {}) },
    };
    this.assets.push(asset);
    this.emit('clips');
    return asset;
  }

  // Connect a file to an offline asset: load its media in place.
  relinkAsset(id, file) {
    const a = this.clipById(id);
    if (!a || !a.offline) return false;
    a.file = file;
    a.url = URL.createObjectURL(file);
    a.offline = false;
    a.ready = false;
    if (a.kind === 'image') this.loadImageAsset(a); else this.loadVideoAsset(a);
    if (a.layer) this.viz.loadLayerMedia(a.layer, file);
    this.emit('clips');
    return true;
  }

  removeAsset(id) {
    const clip = this.clipById(id);
    if (!clip) return;
    if (this.current && this.current.clip === clip) this.current = null;
    if (this.outgoing && this.outgoing.clip === clip) { this.outgoing = null; this.transition = null; }
    if (this.pending && this.pending.clip === clip) this.pending = null;
    if (clip.layer && !clip.offline) this.viz.clearLayerMedia(clip.layer);
    if (clip.bridge) clip.bridge.remove();
    if (clip.kind === 'video' && clip.media) clip.media.remove();
    if (clip.url) URL.revokeObjectURL(clip.url);
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
    const stack = this.stack;
    const from = stack.findIndex(c => c.id === id);
    if (from < 0) return;
    const [clip] = stack.splice(from, 1);
    stack.splice(Math.max(0, Math.min(stack.length, toIndex)), 0, clip);
    stack.forEach((c, i) => { c.importance = i + 1; });
    this.renumber();
    this.emit('clips');
  }

  setClipImportance(id, n) { this.moveClip(id, Math.round(n) - 1); }

  // Stack clips are 1..N. Story assets (Story Mode) have no Importance;
  // they sit after the stack and rejoin it at the bottom in Free Mode.
  renumber() {
    const stack = this.stack;
    stack.forEach((c, i) => { c.importance = i + 1; });
    this.clips.filter(c => !stack.includes(c)).forEach((c, i) => { c.importance = stack.length + i + 1; });
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
      story: this.story ? this.story.role : null,
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
    if (!this.isAdvancing()) return;
    if (this.clips.length === 0 && !this.storyBlocks().length) return;

    const bpm = audioData.bpm || 0;
    this.overwritePlayed(this.clock());

    // Beat edge from the visualizer's clock. Counted through story blocks
    // too, so the bar grid stays continuous.
    if (bpm > 0 && this.viz.lastBeatTime !== this.lastSeenBeatTime) {
      this.lastSeenBeatTime = this.viz.lastBeatTime;
      this.beatIndex++;
      this.beats.push({ time: this.clock(), index: this.beatIndex, pass: this.pass });
      this.emit('beat', this.beatIndex);
    }

    // Story Mode: while the master time is inside a story block, that block
    // owns the screen (no automated picks). When it ends, cutting re-syncs
    // on the master beat grid, the same way it does after a seek (D-34).
    const block = this.settings.storyMode ? this.storyBlockAt(this.clock()) : null;
    if (block) { this.playStory(block); return; }
    if (this.story) {
      this.endStory();
      if (!(bpm > 0) || this.beatIndex < 0) { this.cut(bpm, null); return; }
      this.nextCutPos = null;
    }

    // Put a clip on screen as soon as the timeline rolls; beat-locked
    // cutting takes over once BPM locks (the first beat cuts).
    if (!this.current) this.cut(bpm, null);

    if (!(bpm > 0) || this.beatIndex < 0) return;

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

  // The Action Editor stack: clips minus story assets while Story Mode is
  // on (story assets have fixed places and no Importance, D-33).
  get stack() {
    const sm = this.settings.storyMode;
    return this.clips.filter(c => !(sm && c.story !== 'none'));
  }

  // Clips the automation may pick: decoded, in stack order.
  regularPool() {
    return this.stack.filter(c => c.ready);
  }

  // ---- Story Mode (v2.1 step 7, D-33–D-35) ------------------------------

  setStoryMode(on) {
    this.settings.storyMode = on;
    if (!on && this.story) this.endStory();
    this.renumber();
    this.emit('clips');
  }

  // One asset per role: taking a role that's in use releases it from the
  // other asset. Positions are kept while Story Mode is off (Free Mode
  // ignores them).
  setClipStory(id, role) {
    const a = this.clipById(id);
    if (!a) return;
    if (role !== 'none') {
      const holder = this.assets.find(x => x !== a && x.story === role);
      if (holder) holder.story = 'none';
    }
    a.story = role;
    this.renumber();
    this.emit('clips');
  }

  setClipFade(id, patch) {
    const a = this.clipById(id);
    if (a) { a.fade = { ...(a.fade || { on: false, curve: 'smooth', bars: 1 }), ...patch }; this.emit('clips'); }
  }

  setStoryHold(id, seconds) {
    const a = this.clipById(id);
    if (a) { a.storyHold = Math.max(0.5, seconds); this.emit('clips'); }
  }

  storyAssets() {
    const out = {};
    if (!this.settings.storyMode) return out;
    this.assets.forEach(a => { if (a.story !== 'none' && a.ready) out[a.story] = a; });
    return out;
  }

  // A video block plays its full length once; an image holds storyHold (Q9).
  storyLength(a) {
    return a.kind === 'image' ? a.storyHold : (a.duration || 0);
  }

  // Track mode: blocks sit on the song's own timeline (D-34), so the
  // master timeline stays the only clock. HOOK at the start, CTA at the
  // end, RESULT/CLIMAX ending where CTA starts (or at the song's end).
  // Every ordering in the brief falls out of these three rules.
  storyPlan(songDur) {
    const s = this.storyAssets();
    const blocks = [];
    let hookEnd = 0, tail = songDur;
    if (s.hook) {
      hookEnd = Math.min(this.storyLength(s.hook), songDur);
      if (hookEnd > 0) blocks.push({ role: 'hook', clip: s.hook, start: 0, end: hookEnd });
    }
    if (s.cta) {
      const start = Math.max(hookEnd, songDur - this.storyLength(s.cta));
      if (songDur - start > 0) { blocks.push({ role: 'cta', clip: s.cta, start, end: songDur }); tail = start; }
    }
    if (s.result) {
      const start = Math.max(hookEnd, tail - this.storyLength(s.result));
      if (tail - start > 0) blocks.push({ role: 'result', clip: s.result, start, end: tail });
    }
    return blocks.sort((a, b) => a.start - b.start);
  }

  // Live mode (Q11): no known end, so Hook plays on Start and Result / CTA
  // are fired from the transport, each once per session.
  liveStoryBlocks() {
    const s = this.storyAssets();
    const out = [];
    if (s.hook) out.push({ role: 'hook', clip: s.hook, start: 0, end: this.storyLength(s.hook) });
    this.fired.forEach(f => {
      const a = s[f.role];
      if (a) out.push({ role: f.role, clip: a, start: f.at, end: f.at + this.storyLength(a) });
    });
    return out;
  }

  storyBlocks() {
    if (!this.settings.storyMode) return [];
    const dur = this.songDuration();
    return dur > 0 ? this.storyPlan(dur) : this.liveStoryBlocks();
  }

  storyBlockAt(t) {
    return this.storyBlocks().find(b => t >= b.start && t < b.end) || null;
  }

  fireStory(role) {
    if (this.fired.some(f => f.role === role) || !this.storyAssets()[role]) return false;
    this.fired.push({ role, at: this.clock() });
    this.emit('story');
    return true;
  }

  // Enter (or hold) a story block: a jump cut to the story asset, which is
  // not chosen by the automation. A video block plays once from the
  // matching offset, WITH its own audio (Q9), kept on the master timeline.
  playStory(block) {
    const t = this.clock();
    const a = block.clip;
    const into = Math.max(0, t - block.start);
    if (!this.story || this.story.role !== block.role || this.story.clip !== a) {
      if (this.story) this.endStory();
      this.pending = null;
      if (this.outgoing) { this.retire(this.outgoing.clip); this.outgoing = null; }
      this.transition = null;
      if (this.current) {
        // Only close a cut that is still open: after a seek it was already
        // closed where playback left it.
        if (this.current.segment.end == null) this.current.segment.end = t;
        if (this.current.clip !== a) this.retire(this.current.clip);
      }
      const segment = {
        clipId: a.id, start: t, end: null, inPoint: into, transition: 'jump',
        band: this.dominant, beat: this.beatIndex, story: block.role, blendSec: 0, pass: this.pass,
      };
      this.segments.push(segment);
      this.current = { clip: a, segment };
      this.story = block;
      if (a.kind === 'video') {
        a.el.loop = false;
        a.el.muted = false;
        a.el.volume = 1;
        try { a.el.currentTime = into; } catch (e) { /* not seekable yet */ }
        a.el.play().catch(() => {});
      }
      this.emit('cut', segment);
    } else if (a.kind === 'video' && !a.el.ended && Math.abs(a.el.currentTime - into) > 0.15) {
      a.el.currentTime = into;
    }
  }

  endStory() {
    const a = this.story && this.story.clip;
    if (a && a.kind === 'video') {
      a.el.pause();
      a.el.muted = true;
      a.el.volume = 0;
      a.el.loop = true;
    }
    this.story = null;
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
      if (this.current.segment.end == null) this.current.segment.end = now;
      this.outgoing = this.current;
    }

    const segment = {
      clipId: next.clip.id, start: now, end: null, inPoint: next.inPoint,
      transition: def.id, band, beat: this.beatIndex,
      pace: next.clip.pace, holdBeats: hold, pass: this.pass,
    };
    this.segments.push(segment);
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
    if (this.story) this.endStory();   // re-entered from the matching offset if the seek lands inside a block
    // Keep the whole record (D-56): only the cut that spans the new
    // playhead is trimmed there. Playing from here overwrites as it goes.
    // The cut on air ends where playback actually was, not at the seek target.
    this.closeOpenSegment(this.lastAdvanceTime);
    this.segments.forEach(s => {
      if (s.start < seconds && (s.end == null || s.end > seconds)) s.end = seconds;
    });
    // Drop cuts trimmed down to nothing.
    this.segments = this.segments.filter(s => s.end == null || s.end > s.start + 0.001 || (this.current && s === this.current.segment));
    this.pass++;
    this.passStart = seconds;
    const before = this.beats.filter(b => b.time < seconds);
    this.beatIndex = before.length ? before[before.length - 1].index : -1;
    this.lastSeenBeatTime = this.viz.lastBeatTime;
    this.nextCutPos = null;   // forces a cut on the next frame
    this.segStartPos = null;
    this.holdBeats = null;
    this.pending = null;
    this.emit('seek', seconds);
  }

  // Punch-in overwrite: anything recorded by an earlier pass that starts
  // inside [passStart, now) has just been played over. A cut that runs past
  // the playhead keeps its remaining part (start and in-point move up), so
  // stopping mid-way leaves the rest of the earlier take intact.
  overwritePlayed(now) {
    this.lastAdvanceTime = now;
    const from = this.passStart;
    if (!(now > from)) return;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const s = this.segments[i];
      if (s.pass === this.pass || s.start < from || s.start >= now) continue;
      if (s.end != null && s.end <= now + 0.001) this.segments.splice(i, 1);
      else { s.inPoint += now - s.start; s.start = now; }
    }
    for (let i = this.beats.length - 1; i >= 0; i--) {
      const b = this.beats[i];
      if (b.pass !== this.pass && b.time >= from && b.time < now) this.beats.splice(i, 1);
    }
  }

  // Close the live cut at time t (pause, stop, seek, save).
  closeOpenSegment(t) {
    if (this.current && this.current.segment.end == null && t >= this.current.segment.start) {
      this.current.segment.end = t;
    }
  }

  // The edit decision list in time order, every cut closed.
  edl() {
    return this.segments
      .map(s => ({ ...s, end: s.end == null ? Math.max(s.start, this.lastAdvanceTime) : s.end }))
      .filter(s => s.end > s.start)
      .sort((a, b) => a.start - b.start);
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
      p.image(clip.bridge ? clip.bridge.frame() : clip.media, -w / 2, -h / 2, w, h);
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

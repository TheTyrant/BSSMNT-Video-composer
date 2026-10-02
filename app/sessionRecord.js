// Session record: per-frame analysis log (v2.3, D-56).
//
// What the live analysis produced each frame, on a fixed 60 fps grid of the
// master timeline, so the offline renderer can replay exactly how the
// visuals reacted (D-55). Frame i covers master time i / 60 s. Writing a
// frame again simply overwrites it, which gives punch-in behaviour for free
// when a stretch is played again after a seek.
//
// Frame layout (FRAME_BYTES bytes, little-endian):
//   0  u16 rms ×10000       2  u16 bass ×10000    4  u16 mid ×10000
//   6  u16 high ×10000      8  u16 bpm            10 u8  beatFlash ×255
//   11 u8  beatPulse ×255   12 u8  flags (1 = written, 2 = beat edge, 4 = active)
//   13 u8  visual mode index                       14..141 spectrum, 128 bins ×255
class SessionRecord {
  static FPS = 60;
  static BINS = 128;
  static FRAME_BYTES = 144;
  static CHUNK_FRAMES = 3600;   // one minute per block
  static MODES = ['spectrum', 'particles', 'rings', 'waves', 'mandala', 'tunnel', 'galaxy', 'polygons', 'layers', 'clips'];

  constructor() { this.clear(); }

  clear() {
    this.chunks = new Map();      // chunk index -> Uint8Array
    this.maxFrame = -1;
    this.lastWritten = -1;
    this.lastBeatTime = null;
  }

  get frameCount() { return this.maxFrame + 1; }
  get duration() { return this.frameCount / SessionRecord.FPS; }

  chunk(i, create) {
    const c = Math.floor(i / SessionRecord.CHUNK_FRAMES);
    let buf = this.chunks.get(c);
    if (!buf && create) {
      buf = new Uint8Array(SessionRecord.CHUNK_FRAMES * SessionRecord.FRAME_BYTES);
      this.chunks.set(c, buf);
    }
    return buf;
  }

  // Called once per analysis frame while the timeline rolls.
  capture(t, data, viz) {
    const i = Math.max(0, Math.round(t * SessionRecord.FPS));
    const beatEdge = viz.lastBeatTime !== this.lastBeatTime;
    this.lastBeatTime = viz.lastBeatTime;
    const bytes = this.encode(data, viz, beatEdge);
    // Frames skipped by an uneven frame rate get the same values, so the
    // grid has no holes inside a played stretch.
    const from = this.lastWritten >= 0 && i > this.lastWritten && i - this.lastWritten < 30 ? this.lastWritten + 1 : i;
    for (let f = from; f <= i; f++) {
      const buf = this.chunk(f, true);
      const off = (f % SessionRecord.CHUNK_FRAMES) * SessionRecord.FRAME_BYTES;
      buf.set(bytes, off);
      if (f !== i) buf[off + 12] &= ~2;   // the beat edge belongs to frame i only
    }
    this.lastWritten = i;
    if (i > this.maxFrame) this.maxFrame = i;
  }

  // A seek breaks continuity: don't fill frames across the jump.
  breakContinuity() { this.lastWritten = -1; }

  encode(d, viz, beatEdge) {
    const b = new Uint8Array(SessionRecord.FRAME_BYTES);
    const dv = new DataView(b.buffer);
    const u16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));
    dv.setUint16(0, u16((d.rms || 0) * 10000), true);
    dv.setUint16(2, u16((d.bass || 0) * 10000), true);
    dv.setUint16(4, u16((d.mid || 0) * 10000), true);
    dv.setUint16(6, u16((d.high || 0) * 10000), true);
    dv.setUint16(8, u16(d.bpm || 0), true);
    b[10] = Math.max(0, Math.min(255, Math.round((viz.beatFlash || 0) * 255)));
    b[11] = Math.max(0, Math.min(255, Math.round((viz.beatPulse || 0) * 255)));
    b[12] = 1 | (beatEdge ? 2 : 0) | (d.isActive ? 4 : 0);
    b[13] = Math.max(0, SessionRecord.MODES.indexOf(viz.currentMode));
    const s = d.spectrum || [];
    const per = Math.max(1, Math.floor(s.length / SessionRecord.BINS));
    for (let k = 0; k < SessionRecord.BINS; k++) {
      let sum = 0;
      for (let j = 0; j < per; j++) sum += s[k * per + j] || 0;
      b[14 + k] = Math.max(0, Math.min(255, Math.round((sum / per) * 255)));
    }
    return b;
  }

  // Decoded frame for the renderer (null where nothing was recorded).
  frame(i) {
    const buf = this.chunk(i, false);
    if (!buf) return null;
    const off = (i % SessionRecord.CHUNK_FRAMES) * SessionRecord.FRAME_BYTES;
    if (!(buf[off + 12] & 1)) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset + off, SessionRecord.FRAME_BYTES);
    const spectrum = new Array(SessionRecord.BINS);
    for (let k = 0; k < SessionRecord.BINS; k++) spectrum[k] = buf[off + 14 + k] / 255;
    return {
      rms: dv.getUint16(0, true) / 10000, bass: dv.getUint16(2, true) / 10000,
      mid: dv.getUint16(4, true) / 10000, high: dv.getUint16(6, true) / 10000,
      bpm: dv.getUint16(8, true), beatFlash: buf[off + 10] / 255, beatPulse: buf[off + 11] / 255,
      beat: !!(buf[off + 12] & 2), isActive: !!(buf[off + 12] & 4),
      mode: SessionRecord.MODES[buf[off + 13]] || 'spectrum', spectrum,
    };
  }

  // How much of the timeline has been recorded (for the UI).
  recordedSeconds() {
    let n = 0;
    for (let i = 0; i <= this.maxFrame; i++) {
      const buf = this.chunk(i, false);
      if (buf && (buf[(i % SessionRecord.CHUNK_FRAMES) * SessionRecord.FRAME_BYTES + 12] & 1)) n++;
    }
    return n / SessionRecord.FPS;
  }

  // ---- (de)serialise for the .mnt file ----------------------------------

  toBytes() {
    const n = this.frameCount;
    const out = new Uint8Array(n * SessionRecord.FRAME_BYTES);
    this.chunks.forEach((buf, c) => {
      const start = c * SessionRecord.CHUNK_FRAMES;
      if (start >= n) return;
      const frames = Math.min(SessionRecord.CHUNK_FRAMES, n - start);
      out.set(buf.subarray(0, frames * SessionRecord.FRAME_BYTES), start * SessionRecord.FRAME_BYTES);
    });
    return out;
  }

  fromBytes(bytes) {
    this.clear();
    const n = Math.floor(bytes.length / SessionRecord.FRAME_BYTES);
    for (let i = 0; i < n; i += SessionRecord.CHUNK_FRAMES) {
      const frames = Math.min(SessionRecord.CHUNK_FRAMES, n - i);
      const buf = this.chunk(i, true);
      buf.set(bytes.subarray(i * SessionRecord.FRAME_BYTES, (i + frames) * SessionRecord.FRAME_BYTES));
    }
    this.maxFrame = n - 1;
  }

  meta() {
    return { fps: SessionRecord.FPS, frameBytes: SessionRecord.FRAME_BYTES, bins: SessionRecord.BINS, frames: this.frameCount, modes: SessionRecord.MODES };
  }
}

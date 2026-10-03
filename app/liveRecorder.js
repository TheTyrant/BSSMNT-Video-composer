// Live input recording (D-68): in live mode the input (mic / line in) is
// recorded while the session clock runs, so an export carries the sound.
//
// The recorder taps the stream AudioProcessor already opened (raw: echo
// cancellation, noise suppression and auto-gain are off), without touching
// that frozen file. The recording goes to the browser's disk area as it
// arrives, in 5-second segment files: the browser only commits a file when
// it is closed, so closing a segment every 5 s means a crash loses at most
// the last few seconds. The segments joined in order are the recording.
// `offset` = master-timeline second where the recording begins, so the
// renderer can line it up with the recorded analysis.
class LiveRecorder {
  static PREFIX = 'bssmnt-live-';
  static SEGMENT_MS = 5000;

  constructor(app) {
    this.app = app;
    this.enabled = true;
    try { this.enabled = localStorage.getItem('bssmnt.liveRecord') !== '0'; } catch (e) { /* storage blocked */ }
    this.session = null;      // while recording
    this.take = null;         // { blob, type, offset, id } of the last finished recording
    this.listeners = new Set();
    this.recovered = [];      // recordings left by a session that didn't finish (crash)
  }

  on(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => fn()); }

  get recording() { return !!this.session; }

  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem('bssmnt.liveRecord', this.enabled ? '1' : '0'); } catch (e) { /* storage blocked */ }
    this.emit();
  }

  static mime() {
    if (!window.MediaRecorder) return null;
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  static ext(type) { return /ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm'; }

  // Recording files on disk, grouped by take: bssmnt-live-<id>-<n>.<ext>
  // segments, and bssmnt-live-<id>.done once the take finished normally.
  async scan() {
    const dir = await TempDisk.dir();
    const takes = new Map();
    if (!dir || !dir.entries) return { dir, takes };
    try {
      for await (const [name, h] of dir.entries()) {
        const m = name.match(/^bssmnt-live-(\d+)(?:-(\d+)\.(\w+)|\.done)$/);
        if (!m || h.kind !== 'file') continue;
        const t = takes.get(m[1]) || { id: m[1], parts: [], done: false, ext: 'webm' };
        if (m[2]) { t.parts.push({ n: +m[2], name, h }); t.ext = m[3]; } else t.done = true;
        takes.set(m[1], t);
      }
    } catch (e) { /* nothing */ }
    takes.forEach(t => t.parts.sort((a, b) => a.n - b.n));
    return { dir, takes };
  }

  async removeTake(dir, t) {
    for (const p of t.parts) await dir.removeEntry(p.name).catch(() => {});
    await dir.removeEntry(`${LiveRecorder.PREFIX}${t.id}.done`).catch(() => {});
  }

  // On start: finished takes from earlier sessions are cleared; a take that
  // never finished (the browser closed or crashed mid-set) is offered back.
  async init() {
    const { dir, takes } = await this.scan();
    if (!dir) return;
    for (const t of takes.values()) {
      if (t.done) { await this.removeTake(dir, t); continue; }
      const files = [];
      for (const p of t.parts) { const f = await p.h.getFile(); if (f.size) files.push(f); }
      if (!files.length) { await this.removeTake(dir, t); continue; }
      const type = t.ext === 'ogg' ? 'audio/ogg' : t.ext === 'm4a' ? 'audio/mp4' : 'audio/webm';
      this.recovered.push({ id: t.id, ext: t.ext, file: new Blob(files, { type }), at: +t.id });
    }
    this.emit();
  }

  async dismissRecovered() {
    const { dir, takes } = await this.scan();
    for (const r of this.recovered) { const t = takes.get(r.id); if (dir && t) await this.removeTake(dir, t); }
    this.recovered = [];
    this.emit();
  }

  // Called when the live session clock starts (t0 = performance.now() of
  // master time 0).
  async start(stream, t0) {
    await this.discard();
    if (!this.enabled || !stream || LiveRecorder.mime() === null) return;
    const type = LiveRecorder.mime();
    let rec;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 160000 } : undefined); }
    catch (e) { console.warn('Live recording unavailable:', e); return; }
    const dir = await TempDisk.dir();
    const s = {
      rec, dir, id: String(Date.now()), type: rec.mimeType || type, ext: LiveRecorder.ext(rec.mimeType || type),
      parts: [], seg: null, segStarted: 0, chunks: [], chain: Promise.resolve(), offset: Math.max(0, (performance.now() - t0) / 1000),
    };
    // Next segment file (the previous one is closed = committed to disk).
    const nextSegment = async () => {
      if (s.seg) { try { await s.seg.writable.close(); } catch (e) { /* closed */ } }
      s.seg = null;
      if (!s.dir) return;
      try {
        const name = `${LiveRecorder.PREFIX}${s.id}-${String(s.parts.length + 1).padStart(4, '0')}.${s.ext}`;
        const handle = await s.dir.getFileHandle(name, { create: true });
        s.seg = { name, handle, writable: await handle.createWritable() };
        s.parts.push(s.seg);
        s.segStarted = performance.now();
      } catch (e) { s.dir = null; s.seg = null; }
    };
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      s.chain = s.chain.then(async () => {
        if (!s.dir) { s.chunks.push(e.data); return; }
        if (!s.seg || performance.now() - s.segStarted >= LiveRecorder.SEGMENT_MS) await nextSegment();
        if (s.seg) await s.seg.writable.write(e.data); else s.chunks.push(e.data);
      }).catch(err => console.warn('Live recording write:', err));
    };
    rec.onstart = () => { s.offset = Math.max(0, (performance.now() - t0) / 1000); };
    this.session = s;
    rec.start(1000);
    this.emit();
  }

  // Called when the live session stops: finish the files and keep the take.
  async stop() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (s.rec.state !== 'inactive') {
      await new Promise(r => { s.rec.onstop = r; try { s.rec.stop(); } catch (e) { r(); } });
    }
    await s.chain;
    if (s.seg) { try { await s.seg.writable.close(); } catch (e) { /* closed */ } }
    const files = [];
    for (const p of s.parts) { try { files.push(await p.handle.getFile()); } catch (e) { /* gone */ } }
    const blob = new Blob(files.length ? [...files, ...s.chunks] : s.chunks, { type: s.type });
    if (s.dir) {
      try { await (await s.dir.getFileHandle(`${LiveRecorder.PREFIX}${s.id}.done`, { create: true })).createWritable().then(w => w.close()); } catch (e) { /* marker only */ }
    }
    this.take = blob.size ? { blob, type: s.type, offset: s.offset, id: s.id } : null;
    this.emit();
  }

  // A new session (or a track, or a project) replaces the take.
  async discard() {
    if (this.session) await this.stop();
    const old = this.take;
    this.take = null;
    this.emit();
    if (old && old.id) {
      const { dir, takes } = await this.scan();
      const t = takes.get(old.id);
      if (dir && t) await this.removeTake(dir, t);
    }
  }

  // From a project file.
  load(blob, type, offset) {
    this.take = blob ? { blob, type, offset: offset || 0 } : null;
    this.emit();
  }
}

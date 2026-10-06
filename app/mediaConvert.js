// ASF / WMV / WMA import (D-73). Browsers can't decode Windows Media
// (WMV3 / WMA), so these files arrived blank with no duration. In the
// desktop app they're converted on import by the bundled FFmpeg (video →
// MP4 H.264 + AAC, audio → M4A AAC) and then used like any other file.
// In a browser there is no converter: the app says so instead.
const MediaConvert = {
  EXT: /\.(asf|wmv|wma)$/i,
  ACCEPT: ['.asf', '.wmv', '.wma'],
  progress: new Map(),   // id -> pct

  needs(f) { return !!f && (this.EXT.test(f.name || '') || /x-ms-(asf|wmv|wma)/i.test(f.type || '')); },
  available() { return !!(window.bssmntDesktop && window.bssmntDesktop.convert); },

  init() {
    if (this.available() && window.bssmntDesktop.onConvertProgress) {
      window.bssmntDesktop.onConvertProgress(({ id, pct }) => this.progress.set(id, pct));
    }
  },

  // Split a pick / drop into files usable now and files needing conversion.
  split(files) {
    const now = [], later = [];
    Array.from(files || []).forEach(f => (this.needs(f) ? later : now).push(f));
    return { now, later };
  },

  // Converted copy as a File (named like the original, .mp4 / .m4a).
  async convert(file, kind, onProgress) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tick = onProgress ? setInterval(() => { const p = this.progress.get(id); if (p != null) onProgress(p); }, 400) : null;
    try {
      const r = await window.bssmntDesktop.convert(file.__path || file, kind, id);
      const blob = await (await fetch(r.url)).blob();
      const out = new File([blob], r.name, { type: r.type, lastModified: file.lastModified });
      // Where it came from, so a linked project can find and convert it again (D-74).
      out.__origin = { path: DesktopFiles.pathOf(file), ref: MediaLibrary.ref(file), kind };
      return out;
    } finally {
      if (tick) clearInterval(tick);
      this.progress.delete(id);
    }
  },

  // Re-convert from a saved original (linked projects). File or null.
  async fromOrigin(origin) {
    if (!origin || !this.available()) return null;
    const src = origin.path ? await DesktopFiles.open(origin.path) : null;
    if (!src || !MediaLibrary.sameFile(origin.ref, src)) return null;
    return this.convert(src, origin.kind || 'video');
  },

  unsupportedMessage(files) {
    return `${files.map(f => f.name).join(', ')}: Windows Media (ASF / WMV / WMA) can't play in a browser. Use the BSS MNT desktop app (it converts them on import), or convert to MP4 first.`;
  },
};

// Real file paths in the desktop app (D-74). Browsers never reveal where a
// file lives; the desktop app does, so linked projects reopen their media
// directly instead of asking to reconnect.
const DesktopFiles = {
  available() { return !!(window.bssmntDesktop && window.bssmntDesktop.openPath); },
  pathOf(file) {
    if (!file) return null;
    if (file.__path) return file.__path;
    try { return (window.bssmntDesktop && window.bssmntDesktop.pathFor && window.bssmntDesktop.pathFor(file)) || null; } catch (e) { return null; }
  },
  // The file at a saved path, as a File (null if it's gone).
  async open(p) {
    if (!p || !this.available()) return null;
    try {
      const r = await window.bssmntDesktop.openPath(p);
      if (!r) return null;
      const blob = await (await fetch(r.url)).blob();
      const f = new File([blob], r.name, { type: blob.type, lastModified: r.lastModified });
      f.__path = p;
      return f;
    } catch (e) { console.warn('Could not open', p, e); return null; }
  },
  // A linked item: same file at its saved path, else its original converted again.
  async find(ref, p, origin) {
    const f = p ? await this.open(p) : null;
    if (f && (!ref || MediaLibrary.sameFile(ref, f))) return f;
    return origin ? MediaConvert.fromOrigin(origin) : null;
  },
};

// Media links for project files (v2.3, D-57).
//
// .mnt projects LINK video, image and music files rather than copying them
// in. To reconnect them on reopen, the browser's file handles are kept in
// IndexedDB keyed by a fingerprint (name + size + last-modified). Handles
// come from drag-and-drop and from the file picker (Chrome / Edge). When a
// handle isn't available, the user points at a folder or picks files and
// they are matched by name + size.
const MediaLibrary = {
  DB: 'bssmnt-media',
  STORE: 'handles',

  ref(file) {
    return file ? { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type } : null;
  },
  key(ref) { return `${ref.name}|${ref.size}|${ref.lastModified}`; },
  sameFile(ref, file) { return !!(ref && file && ref.name === file.name && ref.size === file.size); },

  db() {
    if (this._db) return this._db;
    this._db = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(this.DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },

  async put(ref, handle) {
    try {
      const db = await this.db();
      await new Promise((res, rej) => {
        const tx = db.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).put(handle, this.key(ref));
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* storage blocked: reconnecting will ask instead */ }
  },

  async get(ref) {
    try {
      const db = await this.db();
      return await new Promise((res) => {
        const req = db.transaction(this.STORE).objectStore(this.STORE).get(this.key(ref));
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => res(null);
      });
    } catch (e) { return null; }
  },

  async remember(handles) {
    for (const h of handles) {
      if (!h || h.kind !== 'file') continue;
      try { const f = await h.getFile(); await this.put(this.ref(f), h); } catch (e) { /* ignore */ }
    }
  },

  // Call synchronously inside a drop handler: the handles must be requested
  // before the event finishes.
  captureDrop(e) {
    const items = Array.from((e.dataTransfer && e.dataTransfer.items) || []);
    const ps = items.filter(i => i.kind === 'file' && i.getAsFileSystemHandle).map(i => i.getAsFileSystemHandle().catch(() => null));
    if (ps.length) Promise.all(ps).then(hs => this.remember(hs));
  },

  // The picker that also gives us handles (Chrome / Edge). Only in a
  // top-level window: inside a frame (VS Code's Simple Browser, embeds) the
  // dialog may open but the page isn't allowed to read the file (D-72).
  // Save / folder dialogs that write or read through handles: top-level only.
  canUse(fn) {
    let top = false;
    try { top = window.self === window.top; } catch (e) { top = false; }
    return !!window[fn] && top;
  },

  handlesOK() {
    let top = false;
    try { top = window.self === window.top; } catch (e) { top = false; }
    return !!window.showOpenFilePicker && top && !this.pickerBroken;
  },

  // Files chosen, [] if cancelled, null if this picker can't be used here.
  async pick({ multiple = false, accept = {} } = {}) {
    if (!this.handlesOK()) return null;
    try {
      const hs = await window.showOpenFilePicker({ multiple, types: Object.keys(accept).length ? [{ description: 'Media', accept }] : undefined });
      const files = await Promise.all(hs.map(h => h.getFile()));
      this.remember(hs);
      return files;
    } catch (e) {
      if (e && e.name === 'AbortError') return [];
      console.warn('File picker unavailable here, using the standard one:', e);
      this.pickerBroken = true;
      return null;
    }
  },

  // Route a file <input> through pick() when it works here, so files chosen
  // with the chooser are remembered too; otherwise the input's own dialog.
  // onFail(message) is told when the pick had to be redone.
  usePicker(input, accept, onFiles, onFail) {
    if (!input) return;
    input.addEventListener('click', (e) => {
      if (!this.handlesOK()) return;              // standard dialog
      e.preventDefault();
      this.pick({ multiple: input.multiple, accept }).then((files) => {
        if (files === null) {
          // Couldn't read the pick: open the standard dialog (or ask to click again).
          try { input.showPicker(); } catch (err) { if (onFail) onFail('This window could not read that file. Click Choose file again.'); }
        } else if (files.length) onFiles(files);
      });
    });
  },

  // Reopen via stored handles. Needs a user gesture if permission must be asked.
  async fromHandle(ref, ask) {
    const h = await this.get(ref);
    if (!h) return null;
    try {
      let p = await h.queryPermission({ mode: 'read' });
      if (p !== 'granted' && ask) p = await h.requestPermission({ mode: 'read' });
      if (p !== 'granted') return null;
      const f = await h.getFile();
      return this.sameFile(ref, f) ? f : null;
    } catch (e) { return null; }
  },

  // Find files by name + size inside a folder the user picks (a few levels deep).
  async findInFolder(refs, depth = 4) {
    if (!window.showDirectoryPicker) return new Map();
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'read' }); } catch (e) { return new Map(); }
    const wanted = new Map(refs.map(r => [`${r.name}|${r.size}`, r]));
    const found = new Map();
    const walk = async (d, level) => {
      for await (const entry of d.values()) {
        if (found.size === wanted.size) return;
        if (entry.kind === 'file') {
          const r = [...wanted.values()].find(x => x.name === entry.name);
          if (!r) continue;
          const f = await entry.getFile();
          if (f.size === r.size) { found.set(this.key(r), f); this.put(this.ref(f), entry); }
        } else if (level < depth) {
          await walk(entry, level + 1);
        }
      }
    };
    await walk(dir, 0);
    return found;
  },

  // Match an arbitrary file selection against what's missing.
  matchFiles(refs, files) {
    const found = new Map();
    refs.forEach(r => {
      const f = Array.from(files).find(x => this.sameFile(r, x));
      if (f) found.set(this.key(r), f);
    });
    return found;
  },
};

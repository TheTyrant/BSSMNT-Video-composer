// BSSMNT project files (.mnt) — v2.3, D-57; media packing D-65.
//
// A .mnt file is a ZIP container (like .docx) holding:
//   project.json        everything needed to reopen and keep editing:
//                       source, visual mode, Auto-Editor + Story settings,
//                       EQ / sensitivity, mutes, Media Layer settings,
//                       every asset with its per-asset settings, the voice
//                       settings, and the session record's edit list (EDL)
//   record/frames.bin   the per-frame analysis log (SessionRecord)
//   thumbs/<id>.jpg     small thumbnails, so offline assets still show
//   media/voice.*       the voice track (recorded takes exist nowhere else)
//   media/track/…       the music track    } with "Pack media" on (default):
//   media/assets/<id>/… each video / image } reopens anywhere, nothing to
//                                            reconnect
// With Pack media off, video, image and music files are LINKED (by name,
// size and date) and MediaLibrary reconnects them on reopen.
//
// Packed media is stored uncompressed and written as a stream, so saving is
// quick and never holds the whole project in one buffer. Opening reads the
// ZIP's index and plays packed media straight from its slice of the .mnt.
class ProjectFile {
  static FORMAT = 'bssmnt-project';
  static VERSION = 1;
  static MIME = 'application/x-bssmnt';
  static PACK_LIMIT = 3.8e9;   // ZIP without ZIP64 tops out at 4 GB

  constructor(app) {
    this.app = app;
    this.handle = null;       // FileSystemFileHandle of the open .mnt (Chrome / Edge)
    this.name = 'Untitled';
    this.dirty = false;
    this.savedAt = null;
    this.missing = [];        // [{ type: 'asset'|'track', id?, ref }]
    this.restoring = false;
    this.pack = true;
    try { this.pack = localStorage.getItem('bssmnt.pack') !== '0'; } catch (e) { /* storage blocked */ }
  }

  zipLib() {
    if (!this._zip) this._zip = VendorLoader.zip();   // local copy, works offline and from file:// (D-64)
    return this._zip;
  }

  // Loading media after an open or a reconnect fires the same events as
  // edits do; those don't count as changes, so a short quiet window follows.
  markDirty() {
    if (this.restoring || performance.now() < (this.quietUntil || 0)) return;
    if (!this.dirty) { this.dirty = true; this.render(); }
  }

  quiet(ms = 4000) { this.quietUntil = performance.now() + ms; }

  fileName() { return `${(this.name || 'Untitled').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled'}.mnt`; }

  // ---- UI (03 Output › Project) --------------------------------------------

  init() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      name: $('projectName'), save: $('projectSave'), saveAs: $('projectSaveAs'), open: $('projectOpen'),
      openInput: $('projectOpenInput'), status: $('projectStatus'), missing: $('projectMissing'),
      missingCount: $('missingCount'), missingList: $('missingList'), auto: $('reconnectAuto'),
      folder: $('reconnectFolder'), folderInput: $('reconnectFolderInput'), files: $('reconnectFiles'),
      pack: $('projectPack'), packHint: $('projectPackHint'),
    };
    if (!this.el.save) return;
    const fail = (e) => { console.error(e); if (e && e.name !== 'AbortError') alert('Project: ' + (e.message || e)); };
    this.el.name.addEventListener('input', () => { this.name = this.el.name.value; this.markDirty(); });
    this.el.save.addEventListener('click', () => this.save(false).catch(fail));
    this.el.saveAs.addEventListener('click', () => this.save(true).catch(fail));
    this.el.open.addEventListener('click', () => this.openPicker().catch(fail));
    this.el.openInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.open(f).catch(fail);
    });
    if (this.el.pack) {
      this.el.pack.checked = this.pack;
      this.el.pack.addEventListener('change', () => {
        this.pack = this.el.pack.checked;
        try { localStorage.setItem('bssmnt.pack', this.pack ? '1' : '0'); } catch (e) { /* storage blocked */ }
        this.render();
      });
    }
    this.el.auto.addEventListener('click', () => this.reconnect('handles').catch(fail));
    // Find in folder: the folder dialog (Chrome / Edge), or a folder upload
    // picker everywhere else (Firefox) — either way, one folder, every file
    // matched by name and size (D-65).
    this.el.folder.addEventListener('click', () => {
      if (window.showDirectoryPicker) this.reconnect('folder').catch(fail);
      else if (this.el.folderInput) this.el.folderInput.click();
    });
    if (this.el.folderInput) {
      this.el.folderInput.addEventListener('change', (e) => {
        const fs = Array.from(e.target.files);
        e.target.value = '';
        this.reconnect('files', fs).catch(fail);
      });
    }
    this.el.files.addEventListener('change', (e) => {
      const fs = Array.from(e.target.files);
      e.target.value = '';
      this.reconnect('files', fs).catch(fail);
    });
    this.el.auto.hidden = !window.showOpenFilePicker;   // remembered files exist only where the browser keeps file handles
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
    setInterval(() => this.render(), 1000);
    this.render();
  }

  // Media the project would pack (track + every connected asset).
  packable() {
    const out = [];
    const tf = this.app.trackSource.file;
    if (tf) out.push(tf);
    this.app.clipEngine.assets.forEach(a => { if (a.file && !a.offline) out.push(a.file); });
    return out;
  }

  render() {
    if (!this.el || !this.el.status) return;
    if (document.activeElement !== this.el.name) this.el.name.value = this.name;
    const linked = this.app.clipEngine.assets.filter(a => !a.offline).length;
    const rec = this.app.record.recordedSeconds();
    const parts = [];
    parts.push(this.savedAt ? `${this.dirty ? 'Unsaved changes' : 'Saved'} · ${new Date(this.savedAt).toLocaleTimeString()}` : (this.dirty ? 'Not saved yet' : 'New project'));
    parts.push(`${linked} media ${this.pack ? 'packed' : 'linked'}`);
    if (rec > 0) parts.push(`${fmtTime(rec, false)} recorded`);
    this.el.status.textContent = parts.join(' · ');
    if (this.el.packHint) {
      const bytes = this.packable().reduce((n, f) => n + f.size, 0);
      const mb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
      this.el.packHint.textContent = !this.pack ? 'Media is linked: reopening may ask you to reconnect files.'
        : bytes > ProjectFile.PACK_LIMIT ? `Media is ${mb(bytes)}: over the 3.8 GB a project can hold, so the largest files will be linked instead.`
          : bytes ? `Adds ${mb(bytes)} of media to the file.` : '';
    }
    this.el.missing.hidden = !this.missing.length;
    if (this.missing.length) {
      this.el.missingCount.textContent = String(this.missing.length);
      this.el.missingList.innerHTML = '';
      this.missing.forEach(m => {
        const li = document.createElement('li');
        li.textContent = `${m.type === 'track' ? 'Track: ' : ''}${m.ref.name}`;
        this.el.missingList.appendChild(li);
      });
    }
  }

  // ---- save -----------------------------------------------------------------

  static safeName(n) { return String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120); }

  // Everything that goes into the .mnt, as ZIP entries:
  // { name, data: Uint8Array | Blob } — all stored as is.
  async entries() {
    const { strToU8 } = await this.zipLib();
    const app = this.app, e = app.clipEngine, v = app.voice, viz = app.visualizer;
    const out = [];
    // Which media fits in the pack: smallest first, up to the ZIP limit.
    const packSet = new Set();
    if (this.pack) {
      let total = 0;
      this.packable().slice().sort((a, b) => a.size - b.size).forEach(f => {
        if (total + f.size <= ProjectFile.PACK_LIMIT) { packSet.add(f); total += f.size; }
      });
    }
    const assets = [];
    for (const a of e.assets) {
      let thumb = null;
      if (a.thumb) {
        const blob = await new Promise(res => a.thumb.toBlob(res, 'image/jpeg', 0.8));
        if (blob) { thumb = `thumbs/${a.id}.jpg`; out.push({ name: thumb, data: new Uint8Array(await blob.arrayBuffer()), level: 0 }); }
      }
      let packed = null;
      if (a.file && packSet.has(a.file)) {
        packed = `media/assets/${a.id}/${ProjectFile.safeName(a.file.name)}`;
        out.push({ name: packed, data: a.file, level: 0 });
      }
      assets.push({
        id: a.id, name: a.name, kind: a.kind, ref: a.file ? MediaLibrary.ref(a.file) : a.ref, packed,
        asClip: a.asClip, layer: a.layer, band: a.band, pace: a.pace, importance: a.importance,
        story: a.story, storyHold: a.storyHold, fade: { ...(a.fade || {}) }, duration: a.duration, width: a.width, height: a.height,
        rotation: a.rotation || 0, thumb,
      });
    }
    let voice = null;
    if (v.isLoaded && v.blob) {
      const ext = /mp4|m4a/.test(v.blob.type) ? 'm4a' : /mpeg/.test(v.blob.type) ? 'mp3' : /wav/.test(v.blob.type) ? 'wav' : 'webm';
      voice = { file: `media/voice.${ext}`, type: v.blob.type, name: v.name, offset: v.offset, volume: v.volume, normalize: v.normalize, muted: v.muted };
      out.push({ name: voice.file, data: v.blob, level: 0 });
    }
    const tf = app.trackSource.file;
    let trackPacked = null;
    if (tf && packSet.has(tf)) {
      trackPacked = `media/track/${ProjectFile.safeName(tf.name)}`;
      out.push({ name: trackPacked, data: tf, level: 0 });
    }
    const layers = {};
    ['background', 'bass', 'mid', 'high'].forEach(k => {
      const L = viz.layers[k];
      layers[k] = { enabled: L.enabled, justify: L.justify, stack: L.stack };
    });
    const project = {
      format: ProjectFile.FORMAT, version: ProjectFile.VERSION, app: 'BSSMNT DJ Visualizer',
      saved: new Date().toISOString(), name: this.name,
      source: {
        mode: app.audioSourceMode,
        track: tf ? MediaLibrary.ref(tf) : (this.trackRef || null),
        packed: trackPacked,
        duration: app.trackSource.duration || (this.trackRef && this.trackDuration) || 0,
      },
      visualMode: viz.currentMode,
      display: app.display ? app.display.key : 'original',
      engine: { settings: { ...e.settings }, bandTransitions: { ...e.bandTransitions } },
      layers,
      eq: { mode: app.eqMode, bands: app.eq.bands.map(b => ({ ...b })), sensitivity: { bass: app.bassGain, mid: app.midGain, high: app.highGain } },
      mutes: { music: app.musicMuted, voice: v.muted },
      voice,
      text: app.text.toJSON(),
      assets,
      record: {
        edl: e.edl(),
        beats: e.beats.map(b => ({ time: b.time, index: b.index })).sort((x, y) => x.time - y.time),
        frames: { ...app.record.meta(), file: 'record/frames.bin' },
      },
    };
    // project.json first, so a reader finds it at the start of the file.
    // Stored, not compressed: fflate's streaming compressor (0.8.2 and 0.8.3)
    // can write corrupt data for some inputs ("invalid distance" on reading);
    // its one-shot compressor is fine but can't stream. The recording costs
    // ~8.6 KB per second stored, small next to the media (D-65).
    out.unshift({ name: 'project.json', data: strToU8(JSON.stringify(project, null, 1)), level: 0 });
    out.splice(1, 0, { name: 'record/frames.bin', data: app.record.toBytes(), level: 0 });
    return out;
  }

  // Stream entries into a ZIP; write(chunk) receives the bytes in order and
  // may return a promise (backpressure while writing to disk).
  async writeZip(entries, write) {
    const { Zip, ZipPassThrough } = await this.zipLib();
    let chain = Promise.resolve(), failed = null, done;
    const finished = new Promise(r => { done = r; });
    const zip = new Zip((err, chunk, final) => {
      if (err) { failed = err; done(); return; }
      // fflate may reuse its buffers for the next chunk, and the write runs
      // later (after the disk catches up): keep our own copy.
      const own = chunk.slice();
      chain = chain.then(() => write(own));
      if (final) done();
    });
    for (const en of entries) {
      const f = new ZipPassThrough(en.name);   // everything stored (see entries())
      zip.add(f);
      if (en.data instanceof Blob) {
        const reader = en.data.stream().getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) { f.push(new Uint8Array(0), true); break; }
          f.push(value);
          await chain;            // don't run ahead of the disk
          if (failed) throw failed;
        }
      } else {
        f.push(en.data, true);
      }
    }
    zip.end();
    await finished;
    await chain;
    if (failed) throw failed;
  }

  // The whole project as one Blob (download, tests).
  async build() {
    const chunks = [];
    await this.writeZip(await this.entries(), (c) => { chunks.push(c); });
    return new Blob(chunks, { type: ProjectFile.MIME });
  }

  async save(as) {
    const entries = await this.entries();
    let size = 0;
    if (window.showSaveFilePicker) {
      if (as || !this.handle) {
        this.handle = await window.showSaveFilePicker({
          suggestedName: this.fileName(),
          types: [{ description: 'BSSMNT project', accept: { [ProjectFile.MIME]: ['.mnt'] } }],
        });
      }
      const w = await this.handle.createWritable();
      try {
        await this.writeZip(entries, (c) => { size += c.length; return w.write(c); });
        await w.close();
      } catch (e) { try { await w.abort(); } catch (_) { /* closed */ } throw e; }
      this.name = this.handle.name.replace(/\.mnt$/i, '');
      // Media opened from this same .mnt now has to read from the new file.
      if (this.sourceHandle && await this.handle.isSameEntry(this.sourceHandle)) await this.repointPacked(await this.handle.getFile());
    } else {
      const chunks = [];
      await this.writeZip(entries, (c) => { size += c.length; chunks.push(c); });
      const blob = new Blob(chunks, { type: ProjectFile.MIME });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = this.fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    this.dirty = false;
    this.savedAt = Date.now();
    this.app.notify(`Saved ${this.fileName()} (${(size / 1e6).toFixed(1)} MB)`);
    this.render();
    return size;
  }

  // ---- reading a .mnt ---------------------------------------------------------

  // Index of a ZIP file without reading it all: stored entries come back as
  // slices of the file (no copy), deflated ones are inflated.
  static async readZip(file) {
    const { inflateSync } = await VendorLoader.zip();
    const tailLen = Math.min(file.size, 65557);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${file.name} isn't a BSSMNT project.`);
    const tv = new DataView(tail.buffer);
    const count = tv.getUint16(eocd + 10, true), cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true);
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const cv = new DataView(cd.buffer);
    const dec = new TextDecoder();
    const entries = new Map();
    for (let i = 0, p = 0; i < count && p + 46 <= cd.length; i++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const nlen = cv.getUint16(p + 28, true), elen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
      entries.set(dec.decode(cd.subarray(p + 46, p + 46 + nlen)), {
        method: cv.getUint16(p + 10, true), csize: cv.getUint32(p + 20, true), offset: cv.getUint32(p + 42, true),
      });
      p += 46 + nlen + elen + clen;
    }
    const locate = async (name) => {
      const en = entries.get(name);
      if (!en) return null;
      const lh = new DataView(await file.slice(en.offset, en.offset + 30).arrayBuffer());
      const start = en.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      return { blob: file.slice(start, start + en.csize), method: en.method };
    };
    return {
      file,
      has: (name) => entries.has(name),
      async bytes(name) {
        const r = await locate(name);
        if (!r) return null;
        const u = new Uint8Array(await r.blob.arrayBuffer());
        return r.method === 8 ? inflateSync(u) : u;
      },
      async blob(name, type = '') {
        const r = await locate(name);
        if (!r) return null;
        if (r.method === 0) return r.blob;
        return new Blob([inflateSync(new Uint8Array(await r.blob.arrayBuffer()))], { type });
      },
    };
  }

  // Packed media as a File with its original name, size and date, so it
  // matches its reference exactly (and re-packs on the next save).
  async packedFile(zr, path, ref) {
    if (!path || !ref || !zr.has(path)) return null;
    const blob = await zr.blob(path);
    return new File([blob], ref.name, { type: ref.type || '', lastModified: ref.lastModified || Date.now() });
  }

  // ---- open -----------------------------------------------------------------

  async openPicker() {
    if (window.showOpenFilePicker) {
      let hs;
      try {
        hs = await window.showOpenFilePicker({ types: [{ description: 'BSSMNT project', accept: { [ProjectFile.MIME]: ['.mnt'] } }] });
      } catch (e) { if (e.name === 'AbortError') return; throw e; }
      const f = await hs[0].getFile();
      await this.open(f, hs[0]);
    } else {
      this.el.openInput.click();
    }
  }

  async open(file, handle = null) {
    if (this.dirty && !window.confirm('Open another project? Unsaved changes in this one will be lost.')) return false;
    const zr = await ProjectFile.readZip(file);
    const json = await zr.bytes('project.json');
    if (!json) throw new Error(`${file.name} isn't a BSSMNT project.`);
    const { strFromU8 } = await this.zipLib();
    const project = JSON.parse(strFromU8(json));
    if (project.format !== ProjectFile.FORMAT) throw new Error(`${file.name} isn't a BSSMNT project.`);
    if (project.version > ProjectFile.VERSION) throw new Error('This project was saved by a newer BSSMNT version.');
    this.restoring = true;
    try {
      await this.restore(project, zr);
    } finally {
      this.restoring = false;
      this.quiet();
    }
    this.handle = handle;
    this.sourceHandle = handle;      // packed media plays from this file
    this.name = project.name || file.name.replace(/\.mnt$/i, '');
    this.dirty = false;
    this.savedAt = Date.parse(project.saved) || Date.now();
    this.app.sidebar.open('output');
    this.app.notify(this.missing.length
      ? `Opened ${file.name} · ${this.missing.length} media file${this.missing.length === 1 ? '' : 's'} to reconnect (03 Output)`
      : `Opened ${file.name}`);
    this.render();
    return true;
  }

  async restore(project, zr) {
    const app = this.app, e = app.clipEngine, v = app.voice, viz = app.visualizer;

    // 1. Clear the current session.
    if (app.isRunning || app.trackSource.isLoaded) app.stopAudio();
    v.unload();
    e.assets.slice().forEach(a => e.removeAsset(a.id));
    e.nextClipId = 1;
    app.resetSession();

    // 2. Settings.
    Object.assign(e.settings, project.engine.settings);
    e.settings.storyMode = true;   // D-58: positions are always available
    Object.assign(e.bandTransitions, project.engine.bandTransitions);
    document.querySelectorAll('#propBandMap select').forEach((sel, i) => { sel.value = e.bandTransitions[['bass', 'mid', 'high'][i]]; });
    app.timeline.syncProps();
    if (project.eq) {
      app.eq.bands = project.eq.bands.map(b => ({ ...b }));
      ['bass', 'mid', 'high'].forEach(k => {
        const g = project.eq.sensitivity[k];
        app[`${k}Gain`] = g;
        const slider = document.getElementById(`${k}Gain`), label = document.getElementById(`${k}Value`);
        if (slider) slider.value = g;
        if (label) label.textContent = Number(g).toFixed(1);
      });
      app.setEqMode(project.eq.mode);
      app.eq.changed();
      const preset = document.getElementById('eqPreset');
      if (preset) preset.value = app.eq.isFlat ? 'flat' : 'custom';
      if (app.eqPanel) app.eqPanel.syncUI();
    }
    Object.entries(project.layers || {}).forEach(([k, L]) => Object.assign(viz.layers[k], L));
    const modeSel = document.getElementById('visualMode');
    modeSel.value = project.visualMode || 'spectrum';
    modeSel.dispatchEvent(new Event('change'));
    if (app.display) app.display.set(project.display || 'original');

    // 3. Source: switch mode; the track comes from the pack, else from a
    //    file handle the browser remembers, else it's listed to reconnect.
    const wantFile = project.source.mode === 'file';
    // A project brings its own track: nothing parked from before it comes back (D-62).
    app.parkedTrack = null;
    app.clipAutoSwitch = null;
    if (wantFile !== (app.audioSourceMode === 'file')) document.getElementById(wantFile ? 'audioSourceFile' : 'audioSourceMic').click();
    app.parkedTrack = null;
    this.missing = [];
    this.trackRef = project.source.track || null;
    this.trackDuration = project.source.duration || 0;
    if (wantFile && this.trackRef) {
      const f = (await this.packedFile(zr, project.source.packed, this.trackRef)) || await MediaLibrary.fromHandle(this.trackRef, false);
      if (f) await app.loadAudioFile(f, { autoplay: false, keepSession: true });
      else this.missing.push({ type: 'track', ref: this.trackRef });
    }

    // 4. Assets: placeholders keep ids + settings; connect what we can.
    for (const saved of project.assets) {
      let thumb = null;
      if (saved.thumb && zr.has(saved.thumb)) thumb = await this.thumbCanvas(await zr.bytes(saved.thumb));
      e.addOfflineAsset(saved, thumb);
    }
    e.renumber();
    for (const saved of project.assets) {
      const f = (await this.packedFile(zr, saved.packed, saved.ref)) || (saved.ref ? await MediaLibrary.fromHandle(saved.ref, false) : null);
      if (f) e.relinkAsset(saved.id, f);
      else this.missing.push({ type: 'asset', id: saved.id, ref: saved.ref });
    }

    // 5. Voice (always stored inside the project; copied out so a later save
    //    over this same file can't pull it from under us).
    if (project.voice && zr.has(project.voice.file)) {
      const blob = new Blob([await zr.bytes(project.voice.file)], { type: project.voice.type || '' });
      await v.load(blob, { offset: project.voice.offset, name: project.voice.name });
      v.setVolume(project.voice.volume);
      v.setNormalize(project.voice.normalize);
      v.setMuted(!!project.voice.muted);
      const ui = app.voiceUI;
      ui.volume.value = Math.round(project.voice.volume * 100);
      ui.volumeValue.textContent = `${ui.volume.value}%`;
      ui.normalize.checked = !!project.voice.normalize;
      ui.muteVoice.setAttribute('aria-pressed', String(!!project.voice.muted));
      app.updateVoiceUI();
    }
    app.musicMuted = !!(project.mutes && project.mutes.music);
    app.voiceUI.muteMaster.setAttribute('aria-pressed', String(app.musicMuted));
    app.applyMusicLevel();

    // Text (titles, credits, text) — D-60.
    app.text.fromJSON(project.text || null);
    // Projects saved with the old global Auto Fade switch: fade every locked clip.
    if (project.engine && project.engine.settings && project.engine.settings.storyFade) {
      e.assets.forEach(a => { if (a.story !== 'none' && !(a.fade && a.fade.on)) a.fade = { on: true, curve: 'linear', bars: 1 }; });
    }

    // 6. Session record: cut list, beat grid, per-frame analysis log.
    const rec = project.record || {};
    e.segments = (rec.edl || []).map(s => ({ ...s, pass: 0 }));
    e.beats = (rec.beats || []).map(b => ({ ...b, pass: 0 }));
    e.beatIndex = e.beats.length ? e.beats[e.beats.length - 1].index : -1;
    e.lastAdvanceTime = e.segments.reduce((m, s) => Math.max(m, s.end || 0), 0);
    e.pass = 1;
    e.passStart = 0;
    if (rec.frames && zr.has(rec.frames.file)) app.record.fromBytes(await zr.bytes(rec.frames.file));
    e.emit('clips');
  }

  // After saving over the .mnt that packed media is playing from (Chrome /
  // Edge), the old file is gone: point the media at the new file, keeping
  // the playback position.
  async repointPacked(newFile) {
    const zr = await ProjectFile.readZip(newFile);
    const app = this.app, viz = app.visualizer;
    const swap = (el, url) => {
      if (!el) return;
      const t = el.currentTime, paused = el.paused;
      el.src = url;
      try { el.currentTime = t; } catch (e) { /* not seekable yet */ }
      if (!paused) el.play().catch(() => {});
    };
    for (const a of app.clipEngine.assets) {
      if (!a.file) continue;
      const path = `media/assets/${a.id}/${ProjectFile.safeName(a.file.name)}`;
      const f = await this.packedFile(zr, path, MediaLibrary.ref(a.file));
      if (!f) continue;
      const old = a.url;
      a.file = f;
      a.url = URL.createObjectURL(f);
      if (a.kind === 'video') swap(a.el, a.url);
      if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
      if (a.layer && viz.layers[a.layer]) {
        const L = viz.layers[a.layer];
        L.file = f;
        if (L.type === 'video' && L.media && L.media.elt) { const lu = URL.createObjectURL(f); swap(L.media.elt, lu); L.url = lu; }
      }
    }
    const ts = app.trackSource;
    if (ts.file) {
      const f = await this.packedFile(zr, `media/track/${ProjectFile.safeName(ts.file.name)}`, MediaLibrary.ref(ts.file));
      if (f) {
        const old = ts.url;
        ts.file = f;
        ts.url = URL.createObjectURL(f);
        swap(ts.audio, ts.url);
        if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
      }
    }
  }

  async thumbCanvas(bytes) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return c;
    } catch (e) { return null; }
  }

  // ---- reconnect media ------------------------------------------------------

  async reconnect(method, picked) {
    if (!this.missing.length) return;
    const refs = this.missing.map(m => m.ref);
    let found = new Map();
    if (method === 'handles') {
      for (const r of refs) {
        const f = await MediaLibrary.fromHandle(r, true);
        if (f) found.set(MediaLibrary.key(r), f);
      }
    } else if (method === 'folder') {
      found = await MediaLibrary.findInFolder(refs);
    } else if (method === 'files') {
      found = MediaLibrary.matchFiles(refs, picked || []);
    }
    let n = 0;
    this.quiet(6000);
    for (const m of this.missing.slice()) {
      const f = found.get(MediaLibrary.key(m.ref));
      if (!f) continue;
      if (m.type === 'track') await this.app.loadAudioFile(f, { autoplay: false, keepSession: true });
      else this.app.clipEngine.relinkAsset(m.id, f);
      this.missing = this.missing.filter(x => x !== m);
      n++;
    }
    this.quiet();
    this.app.notify(n ? `Reconnected ${n} file${n === 1 ? '' : 's'}${this.missing.length ? ` · ${this.missing.length} still missing` : ''}` : 'No matching files found (matched by name and size)');
    this.render();
  }
}

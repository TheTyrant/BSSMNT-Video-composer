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
// Packed media is stored uncompressed and written as a stream (ZIP64 — no
// size limit, D-66), so saving is quick and never holds the project in
// memory. Opening reads the ZIP's index and plays packed media straight from
// its slice of the .mnt.
class ProjectFile {
  static FORMAT = 'bssmnt-project';
  static VERSION = 1;
  static MIME = 'application/x-bssmnt';

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
      media: $('projectMedia'), packHint: $('projectPackHint'), newBtn: $('projectNew'), newKey: $('projectNewKey'),
      recent: $('projectRecent'), exportMenu: $('exportMenu'),
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
    if (this.el.media) {
      this.el.media.querySelectorAll('input[type=radio]').forEach(r => r.addEventListener('change', () => this.setPack(r.value === 'pack')));
    }
    // New project / Open recent (D-76)
    if (this.el.newBtn) this.el.newBtn.addEventListener('click', () => this.app.newProject());
    if (this.el.newKey) this.el.newKey.textContent = window.bssmntDesktop ? 'Ctrl+N' : 'Alt+N';
    if (this.el.recent) {
      this.el.recent.addEventListener('change', () => {
        const id = this.el.recent.value;
        this.el.recent.value = '';
        if (id) this.openRecent(id).catch(fail);
      });
      this.renderRecent();
    }
    try {
      if (sessionStorage.getItem('bssmnt.newProject')) { sessionStorage.removeItem('bssmnt.newProject'); setTimeout(() => this.app.notify('New project'), 300); }
    } catch (e) { /* storage blocked */ }
    this.el.auto.addEventListener('click', () => this.reconnect('handles').catch(fail));
    // Find in folder: the folder dialog (Chrome / Edge), or a folder upload
    // picker everywhere else (Firefox) — either way, one folder, every file
    // matched by name and size (D-65).
    this.el.folder.addEventListener('click', () => {
      if (MediaLibrary.canUse('showDirectoryPicker')) this.reconnect('folder').catch(fail);
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
    this.el.auto.hidden = !MediaLibrary.canUse('showOpenFilePicker');   // remembered files exist only where the browser keeps file handles
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
    setInterval(() => this.render(), 1000);
    this.render();
  }

  // Pack or Link (D-67); remembered for next time.
  setPack(on) {
    this.pack = !!on;
    try { localStorage.setItem('bssmnt.pack', this.pack ? '1' : '0'); } catch (e) { /* storage blocked */ }
    this.render();
  }

  // Projected size of the .mnt for Pack or Link, before saving: media (when
  // packed), voice, the recording, thumbnails, project data and the index.
  estimateSize(pack = this.pack) {
    const app = this.app, e = app.clipEngine;
    let n = 6000 + e.assets.length * 400 + app.text.items.length * 400;      // project.json + ZIP index
    n += e.segments.length * 260 + e.beats.length * 40;                       // cut list + beat grid
    n += app.record.frameCount * SessionRecord.FRAME_BYTES;                     // recorded motion
    n += e.assets.filter(a => a.thumb).length * 6000;                          // thumbnails
    if (app.voice.isLoaded && app.voice.blob) n += app.voice.blob.size;       // voice is always inside
    if (app.live && app.live.take) n += app.live.take.blob.size;               // so is the live recording
    if (pack) n += this.packable().reduce((s, f) => s + f.size, 0);
    return n;
  }

  // Media the project would pack (track + every connected asset).
  packable() {
    const out = [];
    const tf = this.app.trackSource.file || (this.app.parkedTrack && this.app.parkedTrack.file);
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
    if (this.el.media) {
      this.el.media.querySelectorAll('input[type=radio]').forEach(r => { r.checked = (r.value === 'pack') === this.pack; });
    }
    if (this.el.packHint) {
      const size = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
      const media = this.packable().reduce((n, f) => n + f.size, 0);
      const left = this.unsaved();
      let text = `Project file: ≈ ${size(this.estimateSize())}`;
      text += this.pack ? (media ? ` — includes ${size(media)} of media` : ' — media will be packed inside')
        : ` — media linked${media ? ` (${size(media)} stays where it is)` : ''}`;
      if (left.length) text += ` · ${left.length} file${left.length === 1 ? '' : 's'} not connected, so not included`;
      this.el.packHint.textContent = text;
      if (this.el.save) this.el.save.title = `Save (Ctrl+S) · ${text}`;
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

  static livePath(type) { return `media/live-input.${/ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm'}`; }

  static safeName(n) { return String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120); }

  // Everything that goes into the .mnt, as ZIP entries:
  // { name, data: Uint8Array | Blob } — all stored as is.
  async entries() {
    const { strToU8 } = await this.zipLib();
    const app = this.app, e = app.clipEngine, v = app.voice, viz = app.visualizer;
    const out = [];
    // Every connected media file goes in — no size limit (ZIP64, D-66).
    const packSet = new Set(this.pack ? this.packable() : []);
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
        path: a.file ? DesktopFiles.pathOf(a.file) : (a.path || null),
        origin: a.file ? (a.file.__origin || null) : (a.origin || null),
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
    // Live input recording (D-68): the only copy of the set, so always inside.
    let live = null;
    const take = app.live && app.live.take;
    if (take) {
      live = { file: ProjectFile.livePath(take.type), type: take.type, offset: take.offset };
      out.push({ name: live.file, data: take.blob });
    }
    // The track: the loaded one, or one parked while SRC is on Live (D-74).
    const pk = app.trackSource.file ? null : app.parkedTrack;
    const tf = app.trackSource.file || (pk && pk.file) || null;
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
        path: tf ? DesktopFiles.pathOf(tf) : (this.trackPath || null),
        origin: tf ? (tf.__origin || null) : (this.trackOrigin || null),
        parked: pk ? { time: pk.time, engine: pk.engine, record: 'record/parked-frames.bin' } : null,
        duration: app.trackSource.duration || (pk && pk.duration) || (this.trackRef && this.trackDuration) || 0,
      },
      visualMode: viz.currentMode,
      display: app.display ? app.display.key : 'original',
      engine: { settings: { ...e.settings }, bandTransitions: { ...e.bandTransitions } },
      layers,
      eq: { mode: app.eqMode, bands: app.eq.bands.map(b => ({ ...b })), sensitivity: { bass: app.bassGain, mid: app.midGain, high: app.highGain } },
      mutes: { music: app.musicMuted, voice: v.muted },
      voice,
      live,
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
    if (pk) out.push({ name: 'record/parked-frames.bin', data: pk.record });
    return out;
  }

  // Stream entries into a ZIP64 file; write(chunk) receives the bytes in
  // order and may return a promise (backpressure while writing to disk).
  async writeZip(entries, write, onProgress) {
    const total = entries.reduce((n, en) => n + (en.data instanceof Blob ? en.data.size : en.data.length), 0);
    let done = 0, lastPct = -1;
    const w = new Zip64.ZipWriter(write);
    for (const en of entries) {
      await w.add(en.name, en.data, (n) => {
        done += n;
        const pct = Math.floor((done / Math.max(1, total)) * 100);
        if (onProgress && pct !== lastPct) { lastPct = pct; onProgress(pct, done, total); }
      });
    }
    return w.finish();
  }

  // The whole project as one Blob (tests, small projects).
  async build() {
    const chunks = [];
    await this.writeZip(await this.entries(), (c) => { chunks.push(c); });
    return new Blob(chunks, { type: ProjectFile.MIME });
  }

  // Connected-but-not-packed and not-connected media, so a save can say so.
  unsaved() {
    const out = [];
    this.app.clipEngine.assets.forEach(a => { if (!a.file || a.offline) out.push(a.ref ? a.ref.name : a.name); });
    if (this.app.audioSourceMode === 'file' && !this.app.trackSource.file && this.trackRef) out.push(this.trackRef.name);
    return out;
  }

  async save(as) {
    const entries = await this.entries();
    const status = this.el && this.el.status;
    const progress = (pct, done, total) => {
      if (status && total > 50e6) status.textContent = `Saving… ${pct}% (${(done / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB)`;
    };
    let size = 0;
    if (MediaLibrary.canUse('showSaveFilePicker')) {
      // Chrome / Edge: straight to the chosen file.
      if (as || !this.handle) {
        this.handle = await window.showSaveFilePicker({
          suggestedName: this.fileName(),
          types: [{ description: 'BSSMNT project', accept: { [ProjectFile.MIME]: ['.mnt'] } }],
        });
      }
      const w = await this.handle.createWritable();
      try {
        size = await this.writeZip(entries, (c) => w.write(c), progress);
        await w.close();
      } catch (e) { try { await w.abort(); } catch (_) { /* closed */ } throw e; }
      this.name = this.handle.name.replace(/\.mnt$/i, '');
      this.addRecent({ name: this.handle.name, handle: this.handle });
      // Media opened from this same .mnt now has to read from the new file.
      if (this.sourceHandle && await this.handle.isSameEntry(this.sourceHandle)) await this.repointPacked(await this.handle.getFile());
    } else {
      // No save dialog (Firefox): write to the browser's disk area, then
      // download from that file — the project is never held in memory.
      const need = entries.reduce((n, en) => n + (en.data instanceof Blob ? en.data.size : en.data.length), 0);
      const tmp = await TempDisk.create('mnt', need);
      let blob;
      if (tmp) {
        try {
          size = await this.writeZip(entries, (c) => tmp.writable.write(c), progress);
          await tmp.writable.close();
        } catch (e) { try { await tmp.writable.abort(); } catch (_) { /* closed */ } throw e; }
        blob = await tmp.handle.getFile();
      } else {
        const chunks = [];
        size = await this.writeZip(entries, (c) => { chunks.push(c); }, progress);
        blob = new Blob(chunks, { type: ProjectFile.MIME });
      }
      this.addRecent({ name: this.fileName(), file: new File([blob], this.fileName(), { type: ProjectFile.MIME }) });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = this.fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 120000);
    }
    this.dirty = false;
    this.savedAt = Date.now();
    const left = this.pack ? this.unsaved() : [];
    if (left.length) {
      const msg = `Saved ${this.fileName()}, but ${left.length === 1 ? '1 media file is' : `${left.length} media files are`} not connected, so not inside it: ${left.join(', ')}. Reconnect (03 File › Project) and save again.`;
      this.app.notify(msg, 12000);
      alert(msg);
    } else {
      this.app.notify(`Saved ${this.fileName()} (${size >= 1e9 ? (size / 1e9).toFixed(2) + ' GB' : (size / 1e6).toFixed(1) + ' MB'})`);
    }
    this.render();
    return size;
  }

  // ---- reading a .mnt ---------------------------------------------------------

  // Index of a .mnt without reading it all (ZIP and ZIP64, D-66).
  static readZip(file) { return Zip64.open(file); }

  // Packed media as a File with its original name, size and date, so it
  // matches its reference exactly (and re-packs on the next save).
  async packedFile(zr, path, ref) {
    if (!path || !ref || !zr.has(path)) return null;
    const blob = await zr.blob(path);
    return new File([blob], ref.name, { type: ref.type || '', lastModified: ref.lastModified || Date.now() });
  }

  // ---- open -----------------------------------------------------------------

  async openPicker() {
    if (MediaLibrary.canUse('showOpenFilePicker')) {
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
    // The project is named after its file, as in other software (D-76).
    this.name = file.name.replace(/\.mnt$/i, '') || project.name || 'Untitled';
    this.dirty = false;
    this.savedAt = Date.parse(project.saved) || Date.now();
    this.addRecent({ name: file.name, handle, path: DesktopFiles.pathOf(file), file });
    this.app.sidebar.open('output');
    this.app.notify(this.missing.length
      ? `Opened ${file.name} · ${this.missing.length} media file${this.missing.length === 1 ? '' : 's'} to reconnect (01 File)`
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
    this.trackPath = project.source.path || null;
    this.trackOrigin = project.source.origin || null;
    this.trackDuration = project.source.duration || 0;
    const findTrack = async () => (await this.packedFile(zr, project.source.packed, this.trackRef))
      || await MediaLibrary.fromHandle(this.trackRef, false)
      || await DesktopFiles.find(this.trackRef, this.trackPath, this.trackOrigin);
    if (wantFile && this.trackRef) {
      const f = await findTrack();
      if (f) await app.loadAudioFile(f, { autoplay: false, keepSession: true });
      else this.missing.push({ type: 'track', ref: this.trackRef, path: this.trackPath, origin: this.trackOrigin });
    } else if (!wantFile && this.trackRef && project.source.parked) {
      // Saved on Live with a track parked: it comes back parked (D-74).
      const f = await findTrack();
      const pk = project.source.parked;
      if (f) app.parkedTrack = { file: f, time: pk.time || 0, engine: pk.engine, record: (zr.has(pk.record) && await zr.bytes(pk.record)) || new Uint8Array(0), energy: [] };
    }

    // 4. Assets: placeholders keep ids + settings; connect what we can.
    for (const saved of project.assets) {
      let thumb = null;
      if (saved.thumb && zr.has(saved.thumb)) thumb = await this.thumbCanvas(await zr.bytes(saved.thumb));
      e.addOfflineAsset(saved, thumb);
    }
    e.renumber();
    for (const saved of project.assets) {
      const f = (await this.packedFile(zr, saved.packed, saved.ref))
        || (saved.ref ? await MediaLibrary.fromHandle(saved.ref, false) : null)
        || await DesktopFiles.find(saved.ref, saved.path, saved.origin);
      if (f) e.relinkAsset(saved.id, f);
      else this.missing.push({ type: 'asset', id: saved.id, ref: saved.ref, path: saved.path, origin: saved.origin });
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
    // Live input recording (D-68).
    if (app.live) {
      if (project.live && zr.has(project.live.file)) app.live.load(await zr.blob(project.live.file, project.live.type), project.live.type, project.live.offset);
      else app.live.load(null);
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
    const lt = app.live && app.live.take;
    if (lt && zr.has(ProjectFile.livePath(lt.type))) {
      lt.blob = await zr.blob(ProjectFile.livePath(lt.type), lt.type);
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

  // ---- open recent (D-76) ------------------------------------------------------
  // The last projects opened or saved: name and time in localStorage; the
  // file handle (Chrome / Edge / desktop) in IndexedDB; the real path in the
  // desktop app. A browser that gives neither can only list them.

  recentList() {
    try { return JSON.parse(localStorage.getItem('bssmnt.recent') || '[]'); } catch (e) { return []; }
  }

  // Every project opened or saved is logged. Where the browser gives no
  // reusable handle or path (Firefox, VS Code's preview), a copy of the
  // project file is kept in the browser's storage (up to RECENT_COPY_MAX).
  static RECENT_COPY_MAX = 300e6;

  async addRecent({ name, handle, path, file }) {
    if (!name) return;
    const old = this.recentList();
    const same = old.filter(r => r.name === name);
    const list = old.filter(r => r.name !== name);
    const id = String(Date.now());
    let copy = false;
    if (!handle && !path && file && file.size <= ProjectFile.RECENT_COPY_MAX) {
      try { await MediaLibrary.put({ name: 'recent-copy:' + id, size: 0, lastModified: 0 }, file); copy = true; } catch (e) { copy = false; }
    }
    if (handle) { try { await MediaLibrary.put({ name: 'recent:' + id, size: 0, lastModified: 0 }, handle); } catch (e) { handle = null; } }
    list.unshift({ id, name, path: path || null, hasHandle: !!handle, hasCopy: copy, at: Date.now() });
    const keep = list.slice(0, 8);
    try { localStorage.setItem('bssmnt.recent', JSON.stringify(keep)); } catch (e) { /* storage blocked */ }
    // drop stored handles / copies of entries that left the list
    for (const r of [...same, ...old.slice(7)]) {
      if (keep.some(k => k.id === r.id)) continue;
      MediaLibrary.del && MediaLibrary.del({ name: 'recent:' + r.id, size: 0, lastModified: 0 });
      MediaLibrary.del && MediaLibrary.del({ name: 'recent-copy:' + r.id, size: 0, lastModified: 0 });
    }
    this.renderRecent();
  }

  renderRecent() {
    const sel = this.el && this.el.recent;
    if (!sel) return;
    const list = this.recentList();
    sel.textContent = '';
    sel.add(new Option(list.length ? 'Choose a project…' : 'No recent projects', ''));
    list.forEach(r => sel.add(new Option(`${r.name.replace(/\.mnt$/i, '')}  ·  ${new Date(r.at).toLocaleDateString()}`, r.id)));
    sel.disabled = !list.length;
  }

  async openRecent(id) {
    const r = this.recentList().find(x => x.id === id);
    if (!r) return;
    let file = null, handle = null;
    if (r.hasHandle) {
      try {
        handle = await MediaLibrary.getRaw('recent:' + id);
        if (handle) {
          let p = await handle.queryPermission({ mode: 'readwrite' });
          if (p !== 'granted') p = await handle.requestPermission({ mode: 'readwrite' });
          if (p === 'granted') file = await handle.getFile(); else handle = null;
        }
      } catch (e) { handle = null; }
    }
    if (!file && r.path) file = await DesktopFiles.open(r.path);
    if (!file && r.hasCopy) {
      const blob = await MediaLibrary.getRaw('recent-copy:' + id).catch(() => null);
      if (blob) file = blob instanceof File ? blob : new File([blob], r.name, { type: ProjectFile.MIME });
    }
    if (!file && !r.hasHandle && !r.path && !r.hasCopy) {
      // Too big to keep a copy, and no handle / path here: choose it again.
      this.app.notify(`Choose ${r.name} again — this browser can't reopen it by itself.`, 8000);
      return this.openPicker();
    }
    if (!file) {
      const list = this.recentList().filter(x => x.id !== id);
      try { localStorage.setItem('bssmnt.recent', JSON.stringify(list)); } catch (e) { /* storage blocked */ }
      this.renderRecent();
      this.app.notify(`Couldn't find ${r.name} (moved or deleted?) — use Open… to find it.`, 8000);
      return;
    }
    await this.open(file, handle);
  }

  // ---- reconnect media ------------------------------------------------------

  async reconnect(method, picked) {
    if (!this.missing.length) return;
    // Converted items (ASF / WMV) are found by their original file (D-74).
    const keyRef = (m) => (m.origin && m.origin.ref) || m.ref;
    const refs = this.missing.map(keyRef);
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
      let f = found.get(MediaLibrary.key(keyRef(m)));
      if (!f) continue;
      if (m.origin) {
        if (!MediaConvert.available()) continue;
        try { f = await MediaConvert.convert(f, m.origin.kind || (m.type === 'track' ? 'audio' : 'video')); } catch (err) { console.warn(err); continue; }
      }
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

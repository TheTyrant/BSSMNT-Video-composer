// BSSMNT project files (.mnt) — v2.3, D-57.
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
// Video, image and music files are LINKED (by name, size and date), not
// copied in; MediaLibrary reconnects them on reopen.
class ProjectFile {
  static FORMAT = 'bssmnt-project';
  static VERSION = 1;
  static MIME = 'application/x-bssmnt';
  static FFLATE = new URL('vendor/fflate.mjs', document.baseURI).href;   // local copy: works offline

  constructor(app) {
    this.app = app;
    this.handle = null;       // FileSystemFileHandle of the open .mnt (Chrome / Edge)
    this.name = 'Untitled';
    this.dirty = false;
    this.savedAt = null;
    this.missing = [];        // [{ type: 'asset'|'track', id?, ref }]
    this.restoring = false;
  }

  zipLib() {
    if (!this._zip) this._zip = import(ProjectFile.FFLATE);
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
      folder: $('reconnectFolder'), files: $('reconnectFiles'),
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
    this.el.auto.addEventListener('click', () => this.reconnect('handles').catch(fail));
    this.el.folder.addEventListener('click', () => this.reconnect('folder').catch(fail));
    this.el.files.addEventListener('change', (e) => {
      const fs = Array.from(e.target.files);
      e.target.value = '';
      this.reconnect('files', fs).catch(fail);
    });
    this.el.folder.hidden = !window.showDirectoryPicker;
    window.addEventListener('beforeunload', (e) => {
      if (!this.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
    setInterval(() => this.render(), 1000);
    this.render();
  }

  render() {
    if (!this.el || !this.el.status) return;
    if (document.activeElement !== this.el.name) this.el.name.value = this.name;
    const linked = this.app.clipEngine.assets.filter(a => !a.offline).length;
    const rec = this.app.record.recordedSeconds();
    const parts = [];
    parts.push(this.savedAt ? `${this.dirty ? 'Unsaved changes' : 'Saved'} · ${new Date(this.savedAt).toLocaleTimeString()}` : (this.dirty ? 'Not saved yet' : 'New project'));
    parts.push(`${linked} media linked`);
    if (rec > 0) parts.push(`${fmtTime(rec, false)} recorded`);
    this.el.status.textContent = parts.join(' · ');
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

  async build() {
    const { zipSync, strToU8 } = await this.zipLib();
    const app = this.app, e = app.clipEngine, v = app.voice, viz = app.visualizer;
    const files = {};
    const assets = [];
    for (const a of e.assets) {
      let thumb = null;
      if (a.thumb) {
        const blob = await new Promise(res => a.thumb.toBlob(res, 'image/jpeg', 0.8));
        if (blob) { thumb = `thumbs/${a.id}.jpg`; files[thumb] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]; }
      }
      assets.push({
        id: a.id, name: a.name, kind: a.kind, ref: a.file ? MediaLibrary.ref(a.file) : a.ref,
        asClip: a.asClip, layer: a.layer, band: a.band, pace: a.pace, importance: a.importance,
        story: a.story, storyHold: a.storyHold, fade: { ...(a.fade || {}) }, duration: a.duration, width: a.width, height: a.height,
        rotation: a.rotation || 0, thumb,
      });
    }
    let voice = null;
    if (v.isLoaded && v.blob) {
      const ext = /mp4|m4a/.test(v.blob.type) ? 'm4a' : /mpeg/.test(v.blob.type) ? 'mp3' : /wav/.test(v.blob.type) ? 'wav' : 'webm';
      voice = { file: `media/voice.${ext}`, type: v.blob.type, name: v.name, offset: v.offset, volume: v.volume, normalize: v.normalize, muted: v.muted };
      files[voice.file] = [new Uint8Array(await v.blob.arrayBuffer()), { level: 0 }];
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
        track: app.trackSource.file ? MediaLibrary.ref(app.trackSource.file) : (this.trackRef || null),
        duration: app.trackSource.duration || (this.trackRef && this.trackDuration) || 0,
      },
      visualMode: viz.currentMode,
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
    files['project.json'] = strToU8(JSON.stringify(project, null, 1));
    files['record/frames.bin'] = [app.record.toBytes(), { level: 6 }];
    return new Blob([zipSync(files)], { type: ProjectFile.MIME });
  }

  async save(as) {
    const blob = await this.build();
    if (window.showSaveFilePicker) {
      if (as || !this.handle) {
        this.handle = await window.showSaveFilePicker({
          suggestedName: this.fileName(),
          types: [{ description: 'BSSMNT project', accept: { [ProjectFile.MIME]: ['.mnt'] } }],
        });
      }
      const w = await this.handle.createWritable();
      await w.write(blob);
      await w.close();
      this.name = this.handle.name.replace(/\.mnt$/i, '');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = this.fileName();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    this.dirty = false;
    this.savedAt = Date.now();
    this.app.notify(`Saved ${this.fileName()} (${(blob.size / 1e6).toFixed(1)} MB)`);
    this.render();
    return blob;
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
    const { unzipSync, strFromU8 } = await this.zipLib();
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    if (!files['project.json']) throw new Error(`${file.name} isn't a BSSMNT project.`);
    const project = JSON.parse(strFromU8(files['project.json']));
    if (project.format !== ProjectFile.FORMAT) throw new Error(`${file.name} isn't a BSSMNT project.`);
    if (project.version > ProjectFile.VERSION) throw new Error('This project was saved by a newer BSSMNT version.');
    this.restoring = true;
    try {
      await this.restore(project, files);
    } finally {
      this.restoring = false;
      this.quiet();
    }
    this.handle = handle;
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

  async restore(project, files) {
    const app = this.app, e = app.clipEngine, v = app.voice, viz = app.visualizer;
    const { strFromU8 } = await this.zipLib();

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

    // 3. Source: switch mode, reconnect the track if the browser still has it.
    const wantFile = project.source.mode === 'file';
    if (wantFile !== (app.audioSourceMode === 'file')) document.getElementById(wantFile ? 'audioSourceFile' : 'audioSourceMic').click();
    this.missing = [];
    this.trackRef = project.source.track || null;
    this.trackDuration = project.source.duration || 0;
    if (wantFile && this.trackRef) {
      const f = await MediaLibrary.fromHandle(this.trackRef, false);
      if (f) await app.loadAudioFile(f, { autoplay: false, keepSession: true });
      else this.missing.push({ type: 'track', ref: this.trackRef });
    }

    // 4. Assets: placeholders keep ids + settings; connect what we can.
    for (const saved of project.assets) {
      let thumb = null;
      if (saved.thumb && files[saved.thumb]) thumb = await this.thumbCanvas(files[saved.thumb]);
      e.addOfflineAsset(saved, thumb);
    }
    e.renumber();
    for (const saved of project.assets) {
      const f = saved.ref ? await MediaLibrary.fromHandle(saved.ref, false) : null;
      if (f) e.relinkAsset(saved.id, f);
      else this.missing.push({ type: 'asset', id: saved.id, ref: saved.ref });
    }

    // 5. Voice (stored inside the project).
    if (project.voice && files[project.voice.file]) {
      const blob = new Blob([files[project.voice.file]], { type: project.voice.type || '' });
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
    if (rec.frames && files[rec.frames.file]) app.record.fromBytes(files[rec.frames.file]);
    e.emit('clips');
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

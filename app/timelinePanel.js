// Bottom editor panel: master timeline (ruler + master lane) over the clip
// editor lane, plus the Auto-Editor properties column, the clip bin and the
// viewport HUD. Drawing is a single 2D canvas redrawn at ~30fps.
//
// Two timeline modes:
//   track -- bounded to the loaded file's duration; click/drag to seek
//   live  -- unbounded session time; the view scrolls with the playhead
class TimelinePanel {
  constructor(app) {
    this.app = app;
    this.engine = app.clipEngine;
    this.ROWS = { ruler: 28, master: 72, clips: 64, voice: 40 };   // match styles.css (.ch-*)
    this.LIVE_WINDOW = 30;                                // seconds visible in live mode
    this.view = { start: 0, span: 30, fit: true };
    this.energy = [];     // { t, b, m, h } per analysis frame
    this.peaks = null;    // Float32Array of min/max pairs for the track waveform
    this.lastDraw = 0;
    this.css = getComputedStyle(document.documentElement);
  }

  init() {
    const $ = (id) => document.getElementById(id);
    this.canvas = $('timelineCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.el = {
      time: $('tlTime'), barBeat: $('tlBarBeat'), bpm: $('tlBpm'), band: $('tlBand'),
      badge: $('tlModeBadge'), summary: $('tlSummary'), masterSub: $('chMasterSub'),
      play: $('tlPlay'), stop: $('tlStop'), home: $('tlHome'),
      binCards: $('binCards'), binCount: $('binCount'), bin: $('clipBin'), upload: $('clipUpload'),
      hud: $('viewportHud'), hint: $('viewportHint'), readout: $('propReadout'),
      topMode: $('topMode'), topSource: $('topSource'), viewportMode: $('viewportModeLabel'),
    };

    this.color = (name) => this.css.getPropertyValue(name).trim();

    this.initTransport();
    this.initProps();
    this.initBin();
    this.initCanvasInteraction();
    this.initSplitter();

    // Voice lane appears only while a voice track exists (D-41).
    this.app.voice.on(() => {
      document.getElementById('chVoice').hidden = !this.app.voice.isLoaded;
      document.getElementById('chVoiceSub').textContent = this.app.voice.isLoaded ? this.app.voice.name : '—';
      this.resizeCanvas();
    });

    this.engine.on((type) => {
      if (type === 'clips' || type === 'select') this.renderBin();
    });

    const modeSelect = document.getElementById('visualMode');
    const onMode = () => {
      const label = modeSelect.selectedOptions[0].textContent;
      if (this.el.topMode) this.el.topMode.textContent = label;
      if (this.el.viewportMode) this.el.viewportMode.textContent = label;
    };
    modeSelect.addEventListener('change', onMode);
    onMode();

    new ResizeObserver(() => this.resizeCanvas()).observe(this.canvas.parentElement);
    this.resizeCanvas();
    this.renderBin();
    this.syncProps();
    requestAnimationFrame(() => this.loop());
  }

  // ---- data in ---------------------------------------------------------

  onAudioFrame(d) {
    if (!this.app.timelineRolling()) return;
    const t = this.app.masterTime();
    const last = this.energy[this.energy.length - 1];
    if (last && t < last.t) this.energy = this.energy.filter(e => e.t < t);   // seeked back
    this.energy.push({ t, b: d.bass || 0, m: d.mid || 0, h: d.high || 0 });
    if (this.energy.length > 40000) this.energy.splice(0, 10000);
  }

  resetSession() {
    this.energy = [];
    this.view = { start: 0, span: this.LIVE_WINDOW, fit: true };
  }

  // Waveform overview for track mode. Decoded separately from playback --
  // purely for drawing; analysis still runs through AudioProcessor.
  async loadTrackWaveform(file) {
    this.peaks = null;
    try {
      const buf = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const buckets = 2400;
      const size = Math.max(1, Math.floor(data.length / buckets));
      const peaks = new Float32Array(buckets * 2);
      for (let i = 0; i < buckets; i++) {
        let mn = 0, mx = 0;
        const end = Math.min(data.length, (i + 1) * size);
        for (let j = i * size; j < end; j++) {
          const v = data[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        peaks[i * 2] = mn;
        peaks[i * 2 + 1] = mx;
      }
      this.peaks = peaks;
      this.peaksDuration = audio.duration;
    } catch (e) {
      console.warn('Waveform decode failed (timeline still works):', e);
    }
  }

  // ---- transport -------------------------------------------------------

  initTransport() {
    document.getElementById('tlFireResult').addEventListener('click', () => this.engine.fireStory('result'));
    document.getElementById('tlFireCta').addEventListener('click', () => this.engine.fireStory('cta'));
    this.el.play.addEventListener('click', () => this.app.toggleAudio());
    this.el.stop.addEventListener('click', () => this.app.transportStop());
    this.el.home.addEventListener('click', () => this.app.seekMaster(0));
  }

  // ---- properties ------------------------------------------------------

  initProps() {
    const s = this.engine.settings;
    const $ = (id) => document.getElementById(id);

    this.segButtons($('propTimingMode'), null, (v) => { s.timingMode = v; this.syncProps(); });

    const pace = $('propAutoPace');
    Object.entries(MusicalTime.AUTO_PACES).forEach(([k, v]) => pace.add(new Option(`${v.label} (≥ ${v.minSeconds}s per cut)`, k)));
    pace.addEventListener('change', () => { s.autoPace = pace.value; this.syncProps(); });

    const unitSeg = $('propUnit');
    ['sixteenth', 'eighth', 'beat', 'half', 'bar', 'measure'].forEach(k => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = k;
      b.textContent = MusicalTime.UNITS[k].label;
      b.title = MusicalTime.UNITS[k].long;
      unitSeg.appendChild(b);
    });
    this.segButtons(unitSeg, null, (v) => { s.manualUnit = v; this.syncProps(); });

    const count = $('propCount');
    const setCount = (n) => { s.manualCount = Math.max(1, Math.min(64, Math.round(n) || 1)); this.syncProps(); };
    count.addEventListener('change', () => setCount(parseFloat(count.value)));
    $('propCountDec').addEventListener('click', () => setCount(s.manualCount - 1));
    $('propCountInc').addEventListener('click', () => setCount(s.manualCount + 1));

    // Quick tempo multipliers: single / double / triple / quad time.
    const quick = $('propQuick');
    MusicalTime.MULTIPLIERS.slice(0, 4).forEach(m => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = String(m.beats);
      b.textContent = `×${m.beats}`;
      b.title = `${m.label} — switch every ${MusicalTime.describeBeats(m.beats)}`;
      quick.appendChild(b);
    });
    this.segButtons(quick, null, (v) => {
      s.timingMode = 'manual'; s.manualUnit = 'beat'; s.manualCount = parseInt(v, 10);
      this.syncProps();
    });

    const order = $('propOrder');
    order.addEventListener('change', () => { s.order = order.value; });

    const trans = $('propTransition');
    trans.add(new Option('Auto — by triggering band', 'band'));
    ClipTransitions.list().forEach(t => trans.add(new Option(t.label, t.id)));
    trans.addEventListener('change', () => { s.transitionMode = trans.value; this.syncProps(); });

    const map = $('propBandMap');
    ['bass', 'mid', 'high'].forEach(band => {
      const lab = document.createElement('label');
      lab.className = band;
      lab.innerHTML = `<span class="chip"></span>${band}`;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `${band} transition`);
      ClipTransitions.list().forEach(t => sel.add(new Option(t.label, t.id)));
      sel.value = this.engine.bandTransitions[band];
      sel.addEventListener('change', () => { this.engine.bandTransitions[band] = sel.value; });
      map.append(lab, sel);
    });

    const inPoint = $('propInPoint');
    inPoint.addEventListener('change', () => { s.inPoint = inPoint.value; });

    const overlay = $('propOverlay');
    overlay.addEventListener('change', () => { s.overlayLayers = overlay.checked; });

    // Story Mode (step 7). Off = Free Mode: the automation is unchanged.
    if ($('propStoryMode')) this.segButtons($('propStoryMode'), null, (v) => {
      this.engine.setStoryMode(v === 'on');
      this.app.applyMusicLevel();
      this.syncProps();
    });
    const fade = $('propStoryFade');
    fade.addEventListener('change', () => {
      s.storyFade = fade.checked;
      this.app.applyMusicLevel();
    });
  }

  storyHint() {
    const s = this.engine.settings;
    if (!s.storyMode) return 'Free Mode: the automation runs unrestricted.';
    const used = this.engine.assets.filter(a => a.story !== 'none').length;
    if (!used) return 'No positions set. Give up to three clips a position (Hook, Result / Climax, CTA) in 02 Assets › Asset timing; everything else stays automated.';
    const roles = { hook: 'Hook', result: 'Result', cta: 'CTA' };
    const set = Object.keys(roles).map(r => {
      const a = this.engine.assets.find(x => x.story === r);
      return `${roles[r]}: ${a ? a.name : '—'}`;
    }).join(' · ');
    const where = this.app.isTrackMode()
      ? 'Hook → automated content → Result → CTA, placed on the song.'
      : 'Live: Hook plays on Start; fire Result and CTA from the transport. Music fades need a track file.';
    return `${where} ${set} (${used} of 3 used)`;
  }

  segButtons(container, _unused, onPick) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) onPick(b.dataset.v);
    });
  }

  syncProps() {
    const s = this.engine.settings;
    const $ = (id) => document.getElementById(id);
    const mark = (id, v) => $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
    mark('propTimingMode', s.timingMode);
    mark('propUnit', s.manualUnit);
    mark('propQuick', s.timingMode === 'manual' && s.manualUnit === 'beat' ? s.manualCount : '');
    $('propCount').value = s.manualCount;
    $('propAutoPace').value = s.autoPace;
    $('propOrder').value = s.order;
    $('propTransition').value = s.transitionMode;
    $('propInPoint').value = s.inPoint;
    $('propOverlay').checked = s.overlayLayers;
    if ($('propStoryMode')) mark('propStoryMode', s.storyMode ? 'on' : 'off');
    $('propStoryFade').checked = s.storyFade;
    $('propStoryFade').disabled = !s.storyMode || !this.app.isTrackMode();
    $('propStoryFadeRow').hidden = false;
    $('propStoryHint').textContent = this.storyHint();
    $('propBandMap').hidden = s.transitionMode !== 'band';
    document.querySelectorAll('[data-show-timing]').forEach(el => {
      el.hidden = el.dataset.showTiming !== s.timingMode;
    });
    this.updateReadout();
  }

  updateReadout() {
    const st = this.engine.status();
    const s = this.engine.settings;
    // Panel readout is the global setting; clips with their own pace say so
    // on their bin card and in the header summary.
    const globalMs = MusicalTime.beatsToMs(st.globalBeats, st.bpm);
    const secs = st.bpm > 0 ? (globalMs / 1000).toFixed(2) + 's' : '— s (needs BPM)';
    const how = s.timingMode === 'auto'
      ? `AUTO · ${st.autoLabel.toUpperCase()}`
      : `MANUAL · ${s.manualCount} × ${MusicalTime.UNITS[s.manualUnit].long}`;
    this.el.readout.innerHTML = `Cut every <b>${MusicalTime.describeBeats(st.globalBeats)}</b> = ${secs}<br>${how}`;
  }

  // ---- Action Editor (was the clip bin, D-45) ----------------------------
  //
  // The auto-edit clips as an ordered stack. Position = Importance
  // (1 = top). Clicking a card selects the asset and opens its options in
  // 03 Assets; dragging a card (or Alt+←/→) moves it in the stack. Files
  // dropped here are still added as assets (shortcut).

  initBin() {
    this.el.upload.addEventListener('change', (e) => {
      this.app.addDroppedFiles(e.target.files);
      e.target.value = '';
    });
    const bin = this.el.bin;
    this.dragId = null;

    // A card drag carries its own data type, so it can never be mistaken
    // for a file drop (and a missed "dragend" can't block file drops).
    const CARD = 'application/x-bssmnt-card';
    const isCard = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(CARD);
    window.addEventListener('dragend', () => { this.dragId = null; this.showInsert(-1); });

    // Reordering cards (an in-page drag) is handled on the Action Editor row.
    bin.addEventListener('dragover', (e) => {
      if (!isCard(e)) return;
      e.preventDefault();
      this.showInsert(this.insertIndexAt(e.clientX));
    });
    bin.addEventListener('dragleave', (e) => {
      if (!bin.contains(e.relatedTarget)) this.showInsert(-1);
    });
    bin.addEventListener('drop', (e) => {
      if (!isCard(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = Number(e.dataTransfer.getData(CARD)) || this.dragId;
      if (id != null) this.reorderTo(id, this.insertIndexAt(e.clientX));
      this.dragId = null;
      this.showInsert(-1);
    });

    // Files from the desktop can be dropped anywhere on the bottom editor
    // (Clips lane, timeline, Action Editor) and are added as assets.
    const editor = document.getElementById('editorPanel');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    editor.addEventListener('dragover', (e) => {
      if (isCard(e) || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      bin.classList.add('drag-over');
      editor.classList.add('drag-over-panel');
    });
    editor.addEventListener('dragleave', (e) => {
      if (!editor.contains(e.relatedTarget)) { bin.classList.remove('drag-over'); editor.classList.remove('drag-over-panel'); }
    });
    editor.addEventListener('drop', (e) => {
      if (isCard(e) || !hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      MediaLibrary.captureDrop(e);
      bin.classList.remove('drag-over');
      editor.classList.remove('drag-over-panel');
      this.app.addDroppedFiles(e.dataTransfer.files);
    });
  }

  // Insertion slot 0..N under the pointer (before the card whose centre is
  // to the right of x).
  insertIndexAt(x) {
    const cards = Array.from(this.el.binCards.querySelectorAll('.bin-card:not(.story-card)'));
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return cards.length;
  }

  showInsert(slot) {
    const cards = Array.from(this.el.binCards.querySelectorAll('.bin-card:not(.story-card)'));
    cards.forEach((c, i) => {
      c.classList.toggle('insert-before', i === slot);
      c.classList.toggle('insert-after', slot === cards.length && i === cards.length - 1);
    });
  }

  // slot is an insertion point in the current stack; convert to the index
  // the clip ends up at once it's been lifted out.
  reorderTo(id, slot) {
    const from = this.engine.stack.findIndex(c => c.id === id);
    if (from < 0) return;
    this.engine.moveClip(id, slot > from ? slot - 1 : slot);
  }

  renderBin() {
    const CARD_TYPE = 'application/x-bssmnt-card';
    const cards = this.el.binCards;
    const clips = this.engine.stack;
    const focusedId = document.activeElement && document.activeElement.closest && document.activeElement.closest('.bin-card')
      ? document.activeElement.closest('.bin-card').dataset.id : null;
    this.el.binCount.textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
    cards.textContent = '';
    clips.forEach((clip, i) => {
      const card = document.createElement('div');
      card.className = 'bin-card' + (clip.id === this.engine.selectedId ? ' selected' : '');
      card.dataset.id = clip.id;
      card.dataset.band = clip.band;
      card.tabIndex = 0;
      card.draggable = true;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(clip.id === this.engine.selectedId));
      card.setAttribute('aria-label', `${i + 1}. ${clip.name}`);
      card.title = 'Click for options. Drag (or Alt+←/→) to change its place in the stack.';

      let thumb;
      if (clip.thumb) {
        thumb = document.createElement('img');
        thumb.src = clip.thumb.toDataURL('image/jpeg', 0.8);
        thumb.alt = '';
        thumb.draggable = false;
      } else {
        thumb = document.createElement('div');
      }
      thumb.className = 'bin-thumb';

      const rank = document.createElement('span');
      rank.className = 'bin-rank';
      rank.textContent = clip.importance;

      const meta = document.createElement('div');
      meta.className = 'bin-meta';
      const name = document.createElement('span');
      name.className = 'bin-name';
      name.textContent = clip.name;
      name.title = clip.name;
      const dur = document.createElement('span');
      dur.className = 'bin-dur';
      dur.textContent = clip.offline ? 'OFFLINE' : clip.error ? 'ERR' : !clip.ready ? '…' : clip.kind === 'image' ? 'Still' : fmtTime(clip.duration, false);
      if (clip.error) {
        card.classList.add('bin-error');
        card.title = `${clip.error}. Try Chrome/Edge, or convert to WebM (VP9) or H.264 MP4.`;
      }
      meta.append(name, dur);

      const tags = document.createElement('div');
      tags.className = 'bin-tags';
      const t = [clip.kind === 'image' ? 'IMG' : 'VID'];
      if (clip.pace !== 'global') t.push(MusicalTime.AUTO_PACES[clip.pace].label);
      if (clip.band !== 'any') t.push(clip.band);
      if (clip.layer) t.push(`layer ${clip.layer}`);
      tags.textContent = t.join(' · ');

      const bar = document.createElement('div');
      bar.className = 'bin-band-bar';

      card.append(rank, thumb, bar, meta, tags);
      const select = () => {
        this.engine.select(clip.id);
        if (this.app.sidebar) this.app.sidebar.open('assets');
      };
      card.addEventListener('click', select);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); select(); }
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          this.engine.moveClip(clip.id, i + (e.key === 'ArrowLeft' ? -1 : 1));
        }
      });
      card.addEventListener('dragstart', (e) => {
        this.dragId = clip.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(CARD_TYPE, String(clip.id));
        e.dataTransfer.setData('text/plain', String(clip.id));
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => {
        this.dragId = null;
        card.classList.remove('dragging');
        this.showInsert(-1);
      });
      cards.appendChild(card);
    });
    // Story Mode: Hook first, Result / CTA last, as fixed markers (D-45).
    const story = this.engine.storyAssets();
    if (story.hook) cards.prepend(this.storyCard(story.hook, 'Hook'));
    if (story.result) cards.appendChild(this.storyCard(story.result, 'Result'));
    if (story.cta) cards.appendChild(this.storyCard(story.cta, 'CTA'));
    if (focusedId) {
      const again = cards.querySelector(`[data-id="${focusedId}"]`);
      if (again) again.focus();
    }
    this.markShowing();
  }

  storyCard(a, label) {
    const card = document.createElement('div');
    card.className = 'bin-card story-card' + (a.id === this.engine.selectedId ? ' selected' : '');
    card.dataset.id = a.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'option');
    card.setAttribute('aria-label', `${label}: ${a.name}`);
    card.title = 'Story block: fixed place, plays once. Click for options.';
    const tag = document.createElement('span');
    tag.className = 'bin-rank story-tag';
    tag.textContent = label;
    let thumb;
    if (a.thumb) { thumb = document.createElement('img'); thumb.src = a.thumb.toDataURL('image/jpeg', 0.8); thumb.alt = ''; thumb.draggable = false; }
    else thumb = document.createElement('div');
    thumb.className = 'bin-thumb';
    const meta = document.createElement('div');
    meta.className = 'bin-meta';
    meta.innerHTML = `<span class="bin-name"></span><span class="bin-dur"></span>`;
    meta.firstChild.textContent = a.name;
    meta.lastChild.textContent = a.kind === 'image' ? `${a.storyHold}s` : fmtTime(a.duration, false);
    const tags = document.createElement('div');
    tags.className = 'bin-tags';
    tags.textContent = 'Story · once';
    card.append(tag, thumb, meta, tags);
    const select = () => { this.engine.select(a.id); if (this.app.sidebar) this.app.sidebar.open('assets'); };
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select(); } });
    return card;
  }

  markShowing() {
    const now = this.engine.nowShowing();
    this.el.binCards.querySelectorAll('.bin-card').forEach(c => {
      c.classList.toggle('showing', !!now && String(now.clip.id) === c.dataset.id);
    });
  }

  // ---- canvas interaction ---------------------------------------------

  initCanvasInteraction() {
    const c = this.canvas;
    let dragging = false;
    const timeAt = (e) => {
      const r = c.getBoundingClientRect();
      return this.view.start + ((e.clientX - r.left) / r.width) * this.view.span;
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.app.isTrackMode()) return;
      dragging = true;
      c.setPointerCapture(e.pointerId);
      this.app.trackSource.seek(timeAt(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (dragging) this.app.trackSource.seek(timeAt(e));
    });
    c.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      this.app.seekMaster(timeAt(e));
    });
    // Ctrl/Cmd+wheel zooms around the cursor, wheel pans (track mode).
    c.addEventListener('wheel', (e) => {
      if (!this.app.isTrackMode()) return;
      e.preventDefault();
      const dur = this.app.trackSource.duration || 1;
      if (e.ctrlKey || e.metaKey) {
        const t = timeAt(e);
        const span = Math.max(2, Math.min(dur, this.view.span * (e.deltaY > 0 ? 1.15 : 0.87)));
        const frac = (t - this.view.start) / this.view.span;
        this.view.start = t - frac * span;
        this.view.span = span;
      } else {
        this.view.start += (e.deltaX || e.deltaY) / c.clientWidth * this.view.span;
      }
      this.view.start = Math.max(0, Math.min(dur - this.view.span, this.view.start));
      this.view.fit = this.view.span >= dur;
    }, { passive: false });
    c.addEventListener('dblclick', () => { this.view.fit = true; });
  }

  initSplitter() {
    const split = document.getElementById('panelSplitter');
    const editor = document.getElementById('editorPanel');
    const KEY = 'djv.editorHeight';
    try {
      const saved = parseInt(localStorage.getItem(KEY), 10);
      if (saved) editor.style.height = saved + 'px';
    } catch (e) { /* storage unavailable */ }
    let startY = 0, startH = 0;
    const move = (e) => {
      const h = Math.max(230, Math.min(window.innerHeight * 0.75, startH + (startY - e.clientY)));
      editor.style.height = h + 'px';
    };
    const up = () => {
      split.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(KEY, parseInt(editor.style.height, 10)); } catch (e) { /* ignore */ }
    };
    split.addEventListener('pointerdown', (e) => {
      startY = e.clientY;
      startH = editor.getBoundingClientRect().height;
      split.classList.add('dragging');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.ROWS.ruler + this.ROWS.master + this.ROWS.clips + (this.app.voice.isLoaded ? this.ROWS.voice : 0);
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;
  }

  // ---- frame loop ------------------------------------------------------

  loop() {
    requestAnimationFrame(() => this.loop());
    const now = performance.now();
    if (now - this.lastDraw < 33) return;
    this.lastDraw = now;
    this.updateView();
    this.updateHeader();
    this.updateHud();
    const showing = this.engine.nowShowing();
    const showingId = showing ? showing.clip.id : null;
    if (showingId !== this.shownId) { this.shownId = showingId; this.markShowing(); }
    this.draw();
  }

  updateView() {
    const t = this.app.masterTime();
    if (this.app.isTrackMode()) {
      const dur = this.app.trackSource.duration || 1;
      if (this.view.fit) { this.view.start = 0; this.view.span = dur; }
      else if (t > this.view.start + this.view.span * 0.95 || t < this.view.start) {
        this.view.start = Math.max(0, Math.min(dur - this.view.span, t - this.view.span * 0.1));
      }
    } else {
      this.view.span = this.LIVE_WINDOW;
      this.view.start = Math.max(0, t - this.LIVE_WINDOW * 0.85);
    }
  }

  updateHeader() {
    const st = this.engine.status();
    const track = this.app.isTrackMode();
    const t = this.app.masterTime();
    this.el.time.textContent = track
      ? `${fmtTime(t, true)}`
      : fmtTime(t, true);
    this.el.bpm.textContent = st.bpm > 0 ? st.bpm : '--';
    if (st.position >= 0) {
      const bb = MusicalTime.barBeat(st.position);
      this.el.barBeat.textContent = `${bb.bar}.${bb.beat}`;
    } else {
      this.el.barBeat.textContent = '–.–';
    }
    this.el.band.textContent = st.dominant.toUpperCase();
    this.el.band.className = `lcd-v band-chip ${st.dominant}`;

    this.el.badge.textContent = track ? `TRACK ${fmtTime(this.app.trackSource.duration, false)}` : 'LIVE';
    this.el.badge.className = `badge ${track ? 'track' : 'live'}`;
    this.el.masterSub.textContent = track ? 'Track file' : 'Live session';
    if (this.el.topSource) this.el.topSource.textContent = this.app.audioSourceMode === 'file' ? 'TRACK' : 'LIVE';
    this.canvas.classList.toggle('no-seek', !track);

    const playing = this.app.timelineRolling() || (track ? this.app.trackSource.isPlaying : this.app.isRunning);
    this.el.play.innerHTML = playing ? '&#x275A;&#x275A;' : '&#x25B6;';
    this.el.play.classList.toggle('is-live', playing);

    const messages = {
      'no-clips': 'Add clips to the bin to start auto-editing',
      'unplayable': 'This browser can’t decode these clips — open in Chrome/Edge or use WebM',
      'idle': this.app.visualizer.currentMode === 'clips'
        ? `${this.engine.clips.length} clips ready · press play`
        : 'Select “Clip Auto-Editor” mode to roll the clip timeline',
      'waiting-bpm': 'Listening for tempo…',
      'running': `${st.clipPace ? `Clip pace ${MusicalTime.AUTO_PACES[st.clipPace].label}: holding` : 'Cutting every'} ${MusicalTime.describeBeats(st.intervalBeats)} · ${(st.intervalMs / 1000).toFixed(2)}s · ${this.engine.segments.length} cuts`,
    };
    const notice = this.app.notice && performance.now() < this.app.notice.until ? this.app.notice.text : null;
    this.el.summary.textContent = notice ? notice : st.story
      ? `Story block: ${({ hook: 'HOOK', result: 'RESULT / CLIMAX', cta: 'CTA' })[st.story]} · automation paused`
      : messages[st.state];

    // Story panel bits that depend on the source mode (track vs live).
    const fadeBox = document.getElementById('propStoryFade');
    const fadeOff = !this.engine.settings.storyMode || !track;
    if (fadeBox.disabled !== fadeOff) fadeBox.disabled = fadeOff;
    const hint = this.storyHint();
    const hintEl = document.getElementById('propStoryHint');
    if (hintEl.textContent !== hint) hintEl.textContent = hint;

    // Live Story Mode: Result / CTA are fired by hand, once each.
    const liveStory = this.engine.settings.storyMode && !track;
    const assets = this.engine.storyAssets();
    [['tlFireResult', 'result'], ['tlFireCta', 'cta']].forEach(([id, role]) => {
      const b = document.getElementById(id);
      b.hidden = !liveStory || !assets[role];
      b.disabled = this.engine.fired.some(f => f.role === role) || !this.app.isRunning;
    });
    this.updateReadout();
  }

  updateHud() {
    const inClips = this.app.visualizer.currentMode === 'clips';
    const now = inClips ? this.engine.nowShowing() : null;
    if (now) {
      // Same row layout as the Status overlay (D-43).
      const tr = ClipTransitions.get(now.segment.transition);
      this.el.hud.innerHTML = '';
      const add = (label, value, cls) => {
        const row = document.createElement('div');
        row.className = 'status-item' + (cls ? ` ${cls}` : '');
        const l = document.createElement('span');
        l.className = 'status-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.textContent = value;
        row.append(l, v);
        this.el.hud.appendChild(row);
      };
      add('On air', now.clip.name, 'on-air');
      add('In', now.clip.kind === 'image' ? 'Still' : fmtTime(now.segment.inPoint, true));
      add('Cut', `${tr.glyph} ${tr.label}${now.transition ? ' …' : ''}`);
      add('Band', now.segment.band);
      if (now.segment.story) add('Story', ({ hook: 'Hook', result: 'Result / Climax', cta: 'CTA' })[now.segment.story], 'on-air');
      this.el.hud.hidden = false;
    } else {
      this.el.hud.hidden = true;
    }

    let hint = '';
    if (inClips) {
      const st = this.engine.status().state;
      if (st === 'no-clips') hint = 'Drop video clips into the Bin below';
      else if (st === 'unplayable') hint = 'Can’t decode these clips in this browser — open in Chrome or Edge';
      else if (st === 'waiting-bpm' && !this.engine.current) hint = 'Listening for tempo…';
      else if (st === 'idle' && !this.engine.current) hint = 'Press play to start the auto-editor';
    }
    this.el.hint.textContent = hint;
    this.el.hint.hidden = !hint;
  }

  // ---- drawing ---------------------------------------------------------

  draw() {
    const ctx = this.ctx, W = this.W, R = this.ROWS;
    if (!W) return;
    const C = {
      ink: this.color('--ink'), ink3: this.color('--ink-3'), paper: this.color('--paper'),
      surface: this.color('--surface'), steel: this.color('--steel'), steel2: this.color('--steel-2'),
      bass: this.color('--bass'), mid: this.color('--mid'), high: this.color('--high'), live: this.color('--live'),
    };
    const { start, span } = this.view;
    const x = (t) => ((t - start) / span) * W;
    const now = this.app.masterTime();
    const yMaster = R.ruler, yClips = R.ruler + R.master, H = this.H;

    ctx.clearRect(0, 0, W, H);

    // Backgrounds
    ctx.fillStyle = C.surface; ctx.fillRect(0, 0, W, R.ruler);
    ctx.fillStyle = C.steel; ctx.fillRect(0, yMaster, W, R.master);
    ctx.fillStyle = C.surface; ctx.fillRect(0, yClips, W, R.clips);

    // Track end region (bounded mode)
    if (this.app.isTrackMode()) {
      const endX = x(this.app.trackSource.duration);
      if (endX < W) {
        ctx.fillStyle = C.steel2;
        ctx.fillRect(endX, yMaster, W - endX, H - yMaster);
      }
    }

    // Beat / bar grid from the beats the engine actually counted
    const bpb = MusicalTime.beatsPerBar();
    const beats = this.engine.beats;
    let pxPerBeat = Infinity;
    if (beats.length > 1) pxPerBeat = (x(beats[beats.length - 1].time) - x(beats[0].time)) / (beats.length - 1);
    for (const b of beats) {
      if (b.time < start || b.time > start + span) continue;
      const bx = Math.round(x(b.time)) + 0.5;
      const isBar = b.index % bpb === 0;
      if (!isBar && pxPerBeat < 6) continue;
      ctx.strokeStyle = isBar ? 'rgba(26,26,26,0.28)' : 'rgba(26,26,26,0.09)';
      ctx.beginPath(); ctx.moveTo(bx, yMaster); ctx.lineTo(bx, H); ctx.stroke();
      if (isBar && pxPerBeat * bpb > 22) {
        ctx.fillStyle = C.ink3;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillText(String(b.index / bpb + 1), bx + 3, yMaster + 10);
      }
    }

    this.drawRuler(ctx, C, x, W, R);
    this.drawMaster(ctx, C, x, W, yMaster, R.master, now);
    this.drawClips(ctx, C, x, W, yClips, R.clips, now);
    if (this.app.voice.isLoaded) this.drawVoice(ctx, C, x, W, yClips + R.clips, R.voice);

    // Row rules
    ctx.fillStyle = C.ink;
    ctx.fillRect(0, R.ruler - 1, W, 1);
    ctx.fillStyle = 'rgba(26,26,26,0.16)';
    ctx.fillRect(0, yClips - 1, W, 1);

    // Playhead
    const px = Math.round(x(now)) + 0.5;
    if (px >= 0 && px <= W) {
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, R.ruler - 6); ctx.lineTo(px, H); ctx.stroke();
      ctx.lineWidth = 1;
      const label = fmtTime(now, true);
      ctx.font = '700 10px "JetBrains Mono", monospace';
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.max(0, Math.min(W - tw, px - tw / 2));
      ctx.fillStyle = C.ink; ctx.fillRect(lx, 2, tw, 16);
      ctx.fillStyle = C.paper; ctx.fillText(label, lx + 5, 14);
    }
  }

  drawRuler(ctx, C, x, W, R) {
    const { start, span } = this.view;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find(s => (s / span) * W >= 64) || 600;
    const minor = step / 5;
    ctx.fillStyle = C.ink;
    ctx.font = '10px "JetBrains Mono", monospace';
    for (let t = Math.floor(start / minor) * minor; t <= start + span; t += minor) {
      if (t < 0) continue;
      const tx = Math.round(x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = major ? C.ink : 'rgba(26,26,26,0.35)';
      ctx.fillRect(tx - 0.5, R.ruler - (major ? 10 : 5), 1, major ? 10 : 5);
      if (major) {
        ctx.fillStyle = C.ink;
        ctx.fillText(fmtTime(t, step < 1), tx + 3, 12);
      }
    }
  }

  drawMaster(ctx, C, x, W, y, h, now) {
    const mid = y + h / 2;
    // Track waveform
    if (this.app.isTrackMode() && this.peaks) {
      const n = this.peaks.length / 2;
      const dur = this.peaksDuration || this.app.trackSource.duration || 1;
      for (let px = 0; px < W; px++) {
        const t0 = this.view.start + (px / W) * this.view.span;
        const t1 = this.view.start + ((px + 1) / W) * this.view.span;
        const i0 = Math.floor((t0 / dur) * n), i1 = Math.max(i0 + 1, Math.floor((t1 / dur) * n));
        if (i0 >= n || i1 <= 0) continue;
        let mn = 0, mx = 0;
        for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) {
          if (this.peaks[i * 2] < mn) mn = this.peaks[i * 2];
          if (this.peaks[i * 2 + 1] > mx) mx = this.peaks[i * 2 + 1];
        }
        ctx.fillStyle = t0 <= now ? 'rgba(26,26,26,0.62)' : 'rgba(26,26,26,0.26)';
        ctx.fillRect(px, mid - mx * (h / 2 - 6), 1, Math.max(1, (mx - mn) * (h / 2 - 6)));
      }
    } else if (!this.app.isTrackMode()) {
      ctx.fillStyle = 'rgba(26,26,26,0.12)';
      ctx.fillRect(0, mid, W, 1);
    }

    // Band energy history (both modes)
    const bands = [['b', C.bass], ['m', C.mid], ['h', C.high]];
    const { start, span } = this.view;
    for (const [k, col] of bands) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let started = false, lastPx = -1;
      for (const e of this.energy) {
        if (e.t < start || e.t > start + span) continue;
        const ex = x(e.t);
        if (ex - lastPx < 1) continue;
        lastPx = ex;
        const ey = y + h - 3 - Math.min(1, e[k] * 1.6) * (h - 10);
        if (!started) { ctx.moveTo(ex, ey); started = true; } else ctx.lineTo(ex, ey);
      }
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }

  drawClips(ctx, C, x, W, y, h, now) {
    const { start, span } = this.view;
    const top = y + 7, bh = h - 14;
    const bandCol = { bass: C.bass, mid: C.mid, high: C.high };
    const current = this.engine.current && this.engine.current.segment;

    ctx.font = '600 10px "Inter Tight", sans-serif';
    for (const seg of this.engine.segments) {
      const end = seg.end == null ? now : seg.end;
      if (end < start || seg.start > start + span) continue;
      const x0 = x(seg.start), x1 = x(end);
      const w = Math.max(1, x1 - x0);
      const isCur = seg === current;
      const clip = this.engine.clipById(seg.clipId);

      if (seg.story) { this.drawStoryBlock(ctx, C, seg.story, x0, x1, top, bh, isCur); continue; }

      ctx.fillStyle = isCur ? C.ink : C.paper;
      ctx.fillRect(x0, top, w, bh);

      // Thumbnail tile
      let textX = x0 + 5;
      if (clip && clip.thumb && w > 30) {
        const th = bh - 8, tw = Math.min(w - 8, th * 16 / 9);
        ctx.save();
        ctx.beginPath(); ctx.rect(x0 + 4, top + 5, tw, th); ctx.clip();
        ctx.drawImage(clip.thumb, x0 + 4, top + 5, th * 16 / 9, th);
        ctx.restore();
        textX = x0 + 8 + tw;
      }
      if (clip && x1 - textX > 26) {
        ctx.save();
        ctx.beginPath(); ctx.rect(textX, top, x1 - textX - 3, bh); ctx.clip();
        ctx.fillStyle = isCur ? C.paper : C.ink;
        ctx.fillText(clip.name, textX, top + 14);
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillStyle = isCur ? 'rgba(255,255,255,0.7)' : C.ink3;
        ctx.fillText(`${ClipTransitions.get(seg.transition).label} · in ${seg.inPoint.toFixed(1)}s`, textX, top + 27);
        ctx.font = '600 10px "Inter Tight", sans-serif';
        ctx.restore();
      }

      // Band stripe along the bottom
      ctx.fillStyle = bandCol[seg.band] || C.ink;
      ctx.fillRect(x0, top + bh - 3, w, 3);

      ctx.strokeStyle = C.ink;
      ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.max(1, Math.round(w) - 1), bh - 1);

      this.drawTransitionMark(ctx, C, seg, x0, x(seg.start + (seg.blendSec || 0)), top, bh);
    }

    // Story Mode: outlines of blocks still to come (track mode plan).
    if (this.engine.settings.storyMode) {
      for (const b of this.engine.storyBlocks()) {
        if (b.start <= now || b.start > start + span) continue;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = C.live;
        ctx.strokeRect(Math.round(x(b.start)) + 0.5, top + 0.5, Math.max(1, x(b.end) - x(b.start) - 1), bh - 1);
        ctx.restore();
        ctx.fillStyle = C.live;
        ctx.font = '700 9px "JetBrains Mono", monospace';
        ctx.fillText(({ hook: 'HOOK', result: 'RESULT', cta: 'CTA' })[b.role], x(b.start) + 5, top + 13);
        ctx.font = '600 10px "Inter Tight", sans-serif';
      }
    }

    // Upcoming cut points (ghost markers), from the live beat clock. The
    // next one is exact; later ones assume the global interval, since the
    // clips (and their paces) haven't been picked yet.
    const st = this.engine.status();
    if (st.state === 'running' && st.position >= 0 && st.bpm > 0 && st.nextCutPos != null) {
      const beatSec = 60 / st.bpm;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(26,26,26,0.45)';
      for (let k = 0; k < 24; k++) {
        const t = now + (st.nextCutPos + k * st.globalBeats - st.position) * beatSec;
        if (t > start + span) break;
        if (this.app.isTrackMode() && t > this.app.trackSource.duration) break;
        const gx = Math.round(x(t)) + 0.5;
        ctx.beginPath(); ctx.moveTo(gx, top); ctx.lineTo(gx, top + bh); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // Fixed story block on the clip lane: solid, labelled, live-red edge.
  drawStoryBlock(ctx, C, role, x0, x1, top, bh, isCur) {
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = C.ink;
    ctx.fillRect(x0, top, w, bh);
    ctx.fillStyle = C.live;
    ctx.fillRect(x0, top, Math.min(4, w), bh);
    if (w > 30) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, top, w - 2, bh); ctx.clip();
      ctx.fillStyle = C.paper;
      ctx.font = '700 10px "JetBrains Mono", monospace';
      ctx.fillText(({ hook: 'HOOK', result: 'RESULT / CLIMAX', cta: 'CTA' })[role], x0 + 9, top + 14);
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(isCur ? 'story · on air' : 'story · once', x0 + 9, top + 27);
      ctx.restore();
    }
    ctx.strokeStyle = C.ink;
    ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.max(1, Math.round(w) - 1), bh - 1);
    ctx.font = '600 10px "Inter Tight", sans-serif';
  }

  // Voice lane: the take's waveform at its offset on the master timeline.
  drawVoice(ctx, C, x, W, y, h) {
    const v = this.app.voice;
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, y, W, h);
    ctx.fillStyle = 'rgba(26,26,26,0.16)';
    ctx.fillRect(0, y, W, 1);
    const x0 = x(v.offset), x1 = x(v.offset + v.duration);
    if (x1 < 0 || x0 > W) return;
    ctx.fillStyle = C.steel;
    ctx.fillRect(Math.max(0, x0), y + 4, Math.min(W, x1) - Math.max(0, x0), h - 8);
    const n = v.peaks.length / 2, mid = y + h / 2, amp = h / 2 - 6;
    ctx.fillStyle = C.ink;
    for (let px = Math.max(0, Math.floor(x0)); px < Math.min(W, x1); px++) {
      const i = Math.floor(((px - x0) / (x1 - x0)) * n);
      const mn = v.peaks[i * 2] || 0, mx = v.peaks[i * 2 + 1] || 0;
      ctx.fillRect(px, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
    }
    ctx.strokeStyle = C.ink;
    ctx.strokeRect(Math.round(x0) + 0.5, y + 4.5, Math.max(1, Math.round(x1 - x0) - 1), h - 9);
  }

  // Jump = solid bar; crossfade = X over the blend; blur = hatched blend.
  drawTransitionMark(ctx, C, seg, x0, xb, top, bh) {
    const blendW = Math.max(0, xb - x0);
    ctx.save();
    ctx.strokeStyle = C.live;
    ctx.fillStyle = C.live;
    if (seg.transition === 'jump' || blendW < 3) {
      ctx.fillRect(x0 - 1, top - 4, 3, bh + 4);
    } else if (seg.transition === 'crossfade') {
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0, top + bh); ctx.lineTo(xb, top);
      ctx.moveTo(x0, top); ctx.lineTo(xb, top + bh);
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.rect(x0, top, blendW, bh); ctx.clip();
      ctx.lineWidth = 1;
      for (let i = -bh; i < blendW; i += 4) {
        ctx.beginPath(); ctx.moveTo(x0 + i, top + bh); ctx.lineTo(x0 + i + bh, top); ctx.stroke();
      }
    }
    ctx.restore();
  }
}

function fmtTime(t, tenths) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}

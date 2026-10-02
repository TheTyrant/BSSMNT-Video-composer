class DJVisualizerApp {
  // Number keys for visualization modes, in menu order; 0 = clip editor.
  static MODE_KEYS = {
    Digit1: 'spectrum', Digit2: 'particles', Digit3: 'rings', Digit4: 'waves', Digit5: 'mandala',
    Digit6: 'tunnel', Digit7: 'galaxy', Digit8: 'polygons', Digit9: 'layers', Digit0: 'clips',
  };

  constructor() {
    this.audioProcessor = new AudioProcessor();
    this.visualizer = new DJVisualizer();
    this.isRunning = false;
    
    this.startBtn = null;
    this.fullscreenBtn = null;
    this.deviceStatusSpan = null;
    this.bpmCounter = null;
    this.fpsCounter = null;
    this.lastFrameTime = 0;
    this.frameCount = 0;

    // Audio source (mic vs. uploaded track file)
    this.audioSourceMode = 'mic'; // 'mic' | 'file'
    this.trackSource = new TrackSource(this.audioProcessor);

    // Voice Over: its own chain, follows the master timeline (D-38)
    this.voice = new VoiceTrack(this);

    // EQ (D-51): Use = 'sensitivity' (band faders, today's behaviour),
    // 'dynamic' (analysis EQ curve) or 'blend' (both).
    this.eq = new AnalysisEQ();

    // Session record (per-frame analysis log) and .mnt project file (D-56, D-57)
    this.record = new SessionRecord();
    this.project = new ProjectFile(this);
    this.eqMode = 'sensitivity';
    this.musicMuted = false;

    // Clip auto-editor + bottom timeline panel
    this.clipEngine = new ClipEngine(this.visualizer);
    this.visualizer.clipEngine = this.clipEngine;
    this.clipEngine.clock = () => this.masterTime();
    this.clipEngine.isAdvancing = () => this.visualizer.currentMode === 'clips' && this.timelineRolling();
    this.clipEngine.songDuration = () => (this.isTrackMode() ? this.trackSource.duration : 0);
    this.timeline = new TimelinePanel(this);
    this.sessionStart = null;   // live-mode session clock (performance.now at start)
    this.sessionElapsed = 0;

    // Gain controls
    this.bassGain = 1.0;
    this.midGain = 1.0;
    this.highGain = 1.0;
  }

  async init() {
    // Modular tab sidebar (v2.1, D-42)
    // Left tabs (stack up to 2 panels) and the right Auto-Editor sidebar.
    // Both start closed and only span the viewport row (D-48).
    [['panel-audio', 'Ctrl+1'], ['customMediaSection', 'Ctrl+2'], ['panel-output', 'Ctrl+3'], ['panel-autoedit', 'Shift+A']]
      .forEach(([id, key]) => { const el = document.getElementById(id); if (el) el.dataset.key = key; });
    this.sidebar = new Sidebar('sidebar', 'tabPanels', 'tabRail', { maxOpen: 1 });
    this.sidebar.init();
    this.rightbar = new Sidebar('rightbar', 'rightPanels', 'rightRail', { maxOpen: 1 });
    this.rightbar.init();

    // Initialize DOM elements
    this.startBtn = document.getElementById('start');
    this.fullscreenBtn = document.getElementById('fullscreen');
    this.audioInputSelect = document.getElementById('audioInputSelect');
    this.deviceStatusSpan = document.getElementById('deviceStatus');
    this.bpmCounter = document.getElementById('bpmCounter');
    this.beatIndicator = document.getElementById('beatIndicator');
    this.fpsCounter = document.getElementById('fpsCounter');

    // Audio source toggle + file playback + timeline DOM elements
    this.micSourceControls = document.getElementById('micSourceControls');
    this.fileSourceControls = document.getElementById('fileSourceControls');
    this.audioFileInput = document.getElementById('audioFileUpload');
    this.audioFileStatus = document.getElementById('audioFileStatus');
    this.audioDropZone = document.getElementById('audioDropZone');
    this.popOutBtn = document.getElementById('popOutOutput');

    // Set up event listeners
    this.startBtn.addEventListener('click', () => this.toggleAudio());
    this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    this.audioInputSelect.addEventListener('change', () => this.onDeviceSelectionChange());

    // Audio source mode toggle (Microphone <-> Audio File)
    document.getElementById('audioSourceMic').addEventListener('change', (e) => {
      if (e.target.checked) this.setAudioSourceMode('mic');
    });
    document.getElementById('audioSourceFile').addEventListener('change', (e) => {
      if (e.target.checked) this.setAudioSourceMode('file');
    });

    this.audioFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.loadAudioFile(file);
    });
    this.wireDropZone(this.audioDropZone, (file) => this.loadAudioFile(file));

    document.getElementById('helpBtn').addEventListener('click', () => this.toggleHelp());

    this.popOutBtn.addEventListener('click', () => {
      window.open('output.html', 'djVisualizerOutput', 'width=1280,height=720');
    });

    // Set up gain controls
    this.setupGainControls();
    
    // Set up keyboard shortcuts for live performance
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.code === 'KeyO')) {
        e.preventDefault();
        const fail = (err) => { if (err && err.name !== 'AbortError') alert('Project: ' + (err.message || err)); };
        if (e.code === 'KeyO') this.project.openPicker().catch(fail);
        else this.project.save(e.shiftKey).catch(fail);
        return;
      }
      // Only real text entry blocks shortcuts. Sliders, checkboxes, file
      // pickers, buttons and selects keep focus after a click, and Space
      // must still mean play/stop there.
      const typing = t.tagName === 'TEXTAREA' || t.isContentEditable ||
        (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'file', 'button', 'submit'].includes(t.type));
      if (typing) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (e.repeat) return;
        // Drop focus so the focused control isn't also activated on keyup.
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        this.toggleAudio();
        return;
      }

      // Selects use letters/digits for type-ahead; leave those alone.
      if (t.tagName === 'SELECT') return;

      // Panels (D-52): Ctrl+1/2/3 = Audio / Assets / Output. Alt+1/2/3 does
      // the same, because many browsers keep Ctrl+digit for switching tabs.
      const digit = e.code.replace('Numpad', 'Digit');
      const panelKeys = { Digit1: 'audio', Digit2: 'assets', Digit3: 'output' };
      if ((e.ctrlKey || e.metaKey || e.altKey) && panelKeys[digit]) {
        e.preventDefault();
        this.sidebar.toggle(panelKeys[digit]);
        return;
      }
      // Leave every other browser shortcut alone (Ctrl+R, Ctrl+F, …).
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Shift+A: Auto-Editor (edit controls), right sidebar.
      if (e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        this.rightbar.toggle('autoedit');
        return;
      }

      // 1–9 and 0: visualization modes in menu order; 0 = Clip Auto-Editor.
      if (!e.shiftKey && DJVisualizerApp.MODE_KEYS[digit]) {
        e.preventDefault();
        this.switchVisualizationMode(DJVisualizerApp.MODE_KEYS[digit]);
        return;
      }

      switch(e.code) {
        case 'KeyF':
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case 'KeyR':
          e.preventDefault();
          this.resetGains();
          break;
        case 'Slash':
        case 'Question':
          e.preventDefault();
          this.toggleHelp();
          break;
        case 'Escape':
          e.preventDefault();
          this.hideHelp();
          break;
      }
    });

    // Initialize visualizer
    this.visualizer.init();

    // Set up audio data callback with gain adjustment
    this.audioProcessor.onDataUpdate = (data) => {
      // Apply gain adjustments
      const adjustedData = {
        ...data,
        bass: data.bass * this.sensitivity('bass'),
        mid: data.mid * this.sensitivity('mid'),
        high: data.high * this.sensitivity('high')
      };
      this.visualizer.updateAudioData(adjustedData);
      console.log(`Received BPM data: ${data.bpm}`);
      this.updateBPM(data.bpm);
      this.updateFPS();

      // Clip auto-editor consumes the same adjusted data + the visualizer's
      // beat clock updated just above.
      this.clipEngine.update(adjustedData);
      if (this.timelineRolling()) {
        this.record.capture(this.masterTime(), adjustedData, this.visualizer);
        this.project.markDirty();
      }
      this.timeline.onAudioFrame(adjustedData);

      // Auto Fade Music follows the master time every frame while it's on.
      const st = this.clipEngine.settings;
      if (st.storyMode && st.storyFade) this.applyMusicLevel();
    };

    this.visualModeSelect = document.getElementById('visualMode');
    this.visualModeSelect.addEventListener('change', () => {
      this.clipEngine.setActive(this.visualModeSelect.value === 'clips' && this.timelineRolling());
    });

    this.timeline.init();

    // Files dropped outside a drop target must not make the browser open
    // the file (which would replace the app and lose the session).
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      MediaLibrary.captureDrop(e);
      this.openIfProject(e.dataTransfer.files);
    });

    // Header quick pickers: SRC / MODE dropdowns + activity light (D-50)
    this.headerPickers = new HeaderPickers(this);
    this.headerPickers.init();

    // 03 Assets: asset bin + selected-asset properties (v2.1, D-44)
    this.assetPanel = new AssetPanel(this);
    this.assetPanel.init();

    // Project file (.mnt): 03 Output › Project, Ctrl+S / Ctrl+Shift+S / Ctrl+O
    this.project.init();
    this.clipEngine.on((type) => { if (type !== 'beat' && type !== 'select') this.project.markDirty(); });
    this.voice.on(() => this.project.markDirty());
    this.eq.on(() => this.project.markDirty());
    ['input', 'change'].forEach(t => document.addEventListener(t, (e) => {
      if (e.target && e.target.closest && e.target.closest('#sidebar, #rightbar, .channels') && e.target.id !== 'projectName') this.project.markDirty();
    }, true));
    // Choosers go through the picker that remembers files, so projects can reconnect them.
    const MEDIA = { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv'], 'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'] };
    MediaLibrary.usePicker(document.getElementById('assetUpload'), MEDIA, (files) => this.assetPanel.addAndSelect(files));
    MediaLibrary.usePicker(document.getElementById('clipUpload'), MEDIA, (files) => this.addDroppedFiles(files));
    MediaLibrary.usePicker(this.audioFileInput, { 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] }, (files) => this.loadAudioFile(files[0]));

    // EQ section of 02 Assets: Sensitivity / Dynamic tabs + Use radios
    this.eqPanel = new EqPanel(this);
    this.eqPanel.init();

    this.setupVoice();

    // Check permissions and populate audio devices
    await this.checkAudioPermissions();
    await this.populateAudioDevices();
    this.populateVoiceMics();
  }

  // ---- Voice + Music (v2.1 step 6) ----------------------------------------

  setupVoice() {
    const $ = (id) => document.getElementById(id);
    const v = this.voice;
    this.voiceUI = {
      record: $('voiceRecord'), importInput: $('voiceImport'), mic: $('voiceMic'),
      status: $('voiceStatus'), controls: $('voiceControls'), volume: $('voiceVolume'),
      volumeValue: $('voiceVolumeValue'), normalize: $('voiceNormalize'), offset: $('voiceOffset'),
      download: $('voiceDownload'), remove: $('voiceRemove'), recBadge: $('recBadge'),
      muteMaster: $('muteMaster'), muteVoice: $('muteVoice'),
    };
    const ui = this.voiceUI;
    const fail = (e) => { console.error(e); alert('Voice: ' + (e.message || e)); };

    ui.record.addEventListener('click', () => {
      (v.recording ? v.stopRecording() : v.startRecording(ui.mic.value)).catch(fail);
    });
    ui.importInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) v.importFile(f).catch(fail);
    });
    ui.volume.addEventListener('input', () => {
      v.setVolume(ui.volume.value / 100);
      ui.volumeValue.textContent = `${ui.volume.value}%`;
    });
    ui.normalize.addEventListener('change', () => v.setNormalize(ui.normalize.checked));
    ui.offset.addEventListener('change', () => v.setOffset(parseFloat(ui.offset.value) || 0));
    ui.download.addEventListener('click', () => { v.downloadTake(); this.updateVoiceUI(); });
    ui.remove.addEventListener('click', () => { if (v.confirmReplace()) v.unload(); });
    v.on(() => this.updateVoiceUI());
    setInterval(() => {
      if (v.recording) ui.recBadge.textContent = `REC ${fmtTime(v.recordElapsed(), false)}`;
    }, 200);

    // Track mutes live on the timeline tracks (D-49). A muted track is
    // silent now and will be left out of exports.
    ui.muteMaster.addEventListener('click', () => {
      this.musicMuted = !this.musicMuted;
      ui.muteMaster.setAttribute('aria-pressed', String(this.musicMuted));
      this.applyMusicLevel();
    });
    ui.muteVoice.addEventListener('click', () => {
      v.setMuted(!v.muted);
      ui.muteVoice.setAttribute('aria-pressed', String(v.muted));
    });
    this.updateVoiceUI();
    this.updateMusicUI();
  }

  async populateVoiceMics() {
    try {
      const mics = await this.voice.listMics();
      const sel = this.voiceUI.mic;
      while (sel.options.length > 1) sel.remove(1);
      mics.forEach((m, i) => sel.add(new Option(m.label || `Microphone ${i + 1}`, m.deviceId)));
    } catch (e) { /* no device access yet: default mic still works */ }
  }

  updateVoiceUI() {
    const v = this.voice, ui = this.voiceUI;
    ui.record.innerHTML = v.recording ? '&#x25A0; Stop' : '&#x25CF; Record';
    ui.record.classList.toggle('is-live', v.recording);
    ui.recBadge.hidden = !v.recording;
    ui.controls.hidden = !v.isLoaded;
    ui.download.hidden = !v.takeBlob;
    ui.offset.value = v.offset.toFixed(1);
    ui.status.textContent = v.recording ? `Recording from ${fmtTime(v.recordStart, true)}…`
      : v.isLoaded ? `${v.name} · ${fmtTime(v.duration, true)} · starts ${fmtTime(v.offset, true)}`
      : 'No voice track';
  }

  // ---- Adding media (D-53, D-54) ------------------------------------------

  // Files dropped on the timeline / Action Editor: add them, open 02 Assets
  // with the first one selected so it's visibly "in the bin", and say what
  // happened (including anything that couldn't be used).
  // A .mnt among the files opens as a project instead of being added.
  openIfProject(files) {
    const p = Array.from(files || []).find(f => /\.mnt$/i.test(f.name));
    if (!p) return false;
    this.project.open(p).catch(e => alert('Project: ' + (e.message || e)));
    return true;
  }

  addDroppedFiles(files) {
    if (this.openIfProject(files)) return { added: [], rejected: [] };
    const { added, rejected } = this.clipEngine.addFiles(files);
    if (added.length) {
      this.clipEngine.select(added[0].id);
      this.sidebar.open('assets');
    }
    this.notify(this.addedMessage(added, rejected));
    return { added, rejected };
  }

  addedMessage(added, rejected) {
    const parts = [];
    if (added.length) parts.push(`Added ${added.length} file${added.length === 1 ? '' : 's'} to 02 Assets`);
    if (rejected.length) parts.push(`Not a video or image: ${rejected.join(', ')}`);
    return parts.join(' · ') || 'Nothing to add';
  }

  notify(text, ms = 4000) {
    this.notice = { text, until: performance.now() + ms };
  }

  // ---- EQ (D-51) ---------------------------------------------------------

  // Band sensitivity applies in Sensitivity and Blend; in Dynamic only the
  // EQ curve shapes the analysis, so the faders count as 1.0.
  sensitivity(band) {
    if (this.eqMode === 'dynamic') return 1;
    return this[band + 'Gain'];
  }

  setEqMode(mode) {
    this.eqMode = mode;
    this.eq.setEnabled(mode !== 'sensitivity');
  }

  // Splice the Dynamic EQ into the current analysis graph (built by the
  // frozen AudioProcessor or by TrackSource; neither file's logic changes).
  attachEq() {
    const p = this.audioProcessor;
    if (!p.audioContext || !p.sourceNode || !p.analyserNode) return;
    const track = this.trackSource.isLoaded;
    this.eq.attach({
      ctx: p.audioContext, source: p.sourceNode, analyser: p.analyserNode,
      dry: track ? this.trackSource.dryGain : null,
      monitor: track ? this.trackSource.musicGain : null,
    });
  }

  // Music mute and (step 7) story fades act on the music bus after the
  // analyser (D-36). Only the track file plays through BSSMNT; live input
  // comes from the DJ's own rig, so there is nothing to mute there.
  applyMusicLevel() {
    const level = this.musicMuted ? 0 : this.storyFadeLevel(this.masterTime());
    this.trackSource.setMusicLevel(level, 0.05);
  }

  // Auto Fade Music to Story Blocks (D-37): the music fades out over 1 bar
  // into each story block, stays down during it and fades back in over
  // 1 bar after it (2 s before BPM is known). Evaluated from the master
  // time, so seek, pause and stop need no extra bookkeeping.
  storyFadeLevel(t) {
    const st = this.clipEngine.settings;
    if (!(st.storyMode && st.storyFade && this.isTrackMode())) return 1;
    const bpm = this.visualizer.audioData.bpm || 0;
    const fade = bpm > 0 ? MusicalTime.beatsToMs(MusicalTime.toBeats(1, 'bar'), bpm) / 1000 : 2;
    let level = 1;
    for (const b of this.clipEngine.storyBlocks()) {
      let l = 1;
      if (t >= b.start && t < b.end) l = 0;
      else if (t < b.start && t >= b.start - fade) l = (b.start - t) / fade;
      else if (t >= b.end && t < b.end + fade) l = (t - b.end) / fade;
      level = Math.min(level, l);
    }
    return level;
  }

  updateMusicUI() {
    const live = this.audioSourceMode !== 'file';
    this.voiceUI.muteMaster.disabled = live;
    this.voiceUI.muteMaster.title = live
      ? 'Live input: the music plays from your own rig, so BSSMNT has nothing to mute.'
      : 'Mutes the track for a voice-only result. BPM and cuts keep following the music.';
  }

  async checkAudioPermissions() {
    try {
      // Check if we already have permission
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
      console.log('Microphone permission status:', permissionStatus.state);
      
      if (permissionStatus.state === 'denied') {
        this.deviceStatusSpan.textContent = 'Microphone access denied';
        console.warn('Microphone permission denied');
        return false;
      } else if (permissionStatus.state === 'granted') {
        this.deviceStatusSpan.textContent = 'Microphone access granted';
        return true;
      } else {
        this.deviceStatusSpan.textContent = 'Click Start to request audio access';
        return null; // Permission will be requested when needed
      }
    } catch (error) {
      console.warn('Could not check microphone permissions:', error);
      this.deviceStatusSpan.textContent = 'Ready to request audio access';
      return null;
    }
  }

  async populateAudioDevices() {
    if (!navigator.mediaDevices) {
      console.error('MediaDevices API not supported in this browser');
      this.deviceStatusSpan.textContent = 'MediaDevices API not supported';
      return;
    }

    try {
      console.log('Enumerating audio input devices...');
      const inputs = await this.audioProcessor.listInputs();
      console.log('Available audio inputs:', inputs);
      
      // Clear existing options except the first one
      while (this.audioInputSelect.children.length > 1) {
        this.audioInputSelect.removeChild(this.audioInputSelect.lastChild);
      }
      
      if (inputs.length === 0) {
        console.warn('No audio input devices detected');
        this.deviceStatusSpan.textContent = 'No audio devices found';
        return;
      }
      
      // Add all available inputs to the dropdown
      inputs.forEach(input => {
        const option = document.createElement('option');
        option.value = input.deviceId;
        option.textContent = input.label;
        
        // Mark DJ devices with a special indicator
        if (input.isDJ) {
          option.textContent = `🎧 ${input.label}`;
        }
        
        this.audioInputSelect.appendChild(option);
      });
      
      // Auto-select preferred input (prioritizes DJ devices)
      const preferredInput = this.audioProcessor.findDJInput(inputs);
      if (preferredInput) {
        this.audioInputSelect.value = preferredInput.deviceId;
        this.selectedDeviceId = preferredInput.deviceId;
        this.deviceStatusSpan.textContent = `Ready: ${preferredInput.label}`;
        console.log('Auto-selected preferred input:', preferredInput.label);
      } else if (inputs.length > 0) {
        // Default to first available input if no DJ device found
        this.audioInputSelect.value = inputs[0].deviceId;
        this.selectedDeviceId = inputs[0].deviceId;
        this.deviceStatusSpan.textContent = `Ready: ${inputs[0].label}`;
        console.log('Auto-selected first available input:', inputs[0].label);
      }
      
    } catch (error) {
      console.error('Error enumerating audio devices:', error);
      this.deviceStatusSpan.textContent = 'Error detecting devices';
      this.selectedDeviceId = null;
    }
  }

  onDeviceSelectionChange() {
    const selectedValue = this.audioInputSelect.value;
    
    if (selectedValue === '') {
      // Auto-select mode
      this.selectedDeviceId = null;
      this.deviceStatusSpan.textContent = 'Auto-select mode';
    } else {
      // Specific device selected
      this.selectedDeviceId = selectedValue;
      const selectedOption = this.audioInputSelect.selectedOptions[0];
      this.deviceStatusSpan.textContent = `Selected: ${selectedOption.textContent.replace('🎧 ', '')}`;
    }
    
    console.log('Device selection changed to:', this.selectedDeviceId || 'auto-select');
    
    // If audio is currently running, restart with new device
    if (this.isRunning) {
      console.log('Restarting audio with new device...');
      this.restartAudioWithNewDevice();
    }
  }

  async restartAudioWithNewDevice() {
    try {
      // Stop current audio
      this.audioProcessor.stop();
      
      // Small delay to ensure cleanup
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Start with new device
      await this.audioProcessor.startAudio(this.selectedDeviceId);
      this.attachEq();
      this.visualizer.start();
      
      console.log('Audio restarted with new device');
    } catch (error) {
      console.error('Failed to restart audio with new device:', error);
      this.stopAudio();
      alert('Failed to switch audio device. Please try again.');
    }
  }

  async toggleAudio() {
    // In file mode, the source is already connected as soon as it's loaded
    // (see loadAudioFile) -- Start/Stop here just plays/pauses the track,
    // it doesn't re-request a source the way mic mode does.
    if (this.audioSourceMode === 'file') {
      if (!this.trackSource.isLoaded) {
        this.audioFileInput.click();
        return;
      }
      if (!this.trackSource.isPlaying) {
        await this.trackSource.play();
        this.isRunning = true;
        this.visualizer.start();
        this.clipEngine.setActive(this.visualizer.currentMode === 'clips');
        this.setStartButton('Pause', true);
      } else {
        this.trackSource.pause();
        this.clipEngine.setActive(false);
        this.setStartButton('Play', false);
      }
      return;
    }

    if (!this.isRunning) {
      await this.startAudio();
    } else {
      this.stopAudio();
    }
  }

  setStartButton(label, live) {
    this.startBtn.textContent = label;
    this.startBtn.classList.toggle('is-live', live);
  }

  setAudioSourceMode(mode) {
    if (this.isRunning || this.trackSource.isLoaded) {
      this.stopAudio();
    }
    this.audioSourceMode = mode;
    this.micSourceControls.classList.toggle('hidden', mode !== 'mic');
    this.fileSourceControls.classList.toggle('hidden', mode !== 'file');
    this.setStartButton(mode === 'file' ? 'Play' : 'Start Audio', false);
    this.audioFileStatus.textContent = 'No file selected';
    this.resetSession();
    this.updateMusicUI();
  }

  wireDropZone(zoneEl, onFile) {
    if (!zoneEl) return;
    zoneEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      zoneEl.classList.add('drag-over');
    });
    zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drag-over'));
    zoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      zoneEl.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  async loadAudioFile(file, { autoplay = true, keepSession = false } = {}) {
    this.audioFileStatus.textContent = `Loading: ${file.name}...`;
    try {
      await this.trackSource.load(file);
      this.attachEq();
      this.audioFileStatus.textContent = `Loaded: ${file.name}`;
      if (!keepSession) this.resetSession();
      this.timeline.loadTrackWaveform(file);
      this.applyMusicLevel();
      this.project.markDirty();

      this.visualizer.start();
      if (!autoplay) {
        this.isRunning = false;
        this.setStartButton('Play', false);
        this.deviceStatusSpan.textContent = `Ready: ${file.name}`;
        return;
      }
      this.isRunning = true;
      this.setStartButton('Pause', true);
      this.deviceStatusSpan.textContent = `Playing: ${file.name}`;

      await this.trackSource.play();
    } catch (error) {
      console.error('Failed to load audio file:', error);
      this.audioFileStatus.textContent = `Failed to load: ${file.name}`;
      alert('Failed to load audio file: ' + error.message);
    }
  }

  // ---- master timeline --------------------------------------------------
  // Track mode: bounded by the loaded file, time = playback position.
  // Live mode: unbounded, time = seconds since the session started.

  isTrackMode() {
    return this.audioSourceMode === 'file' && this.trackSource.isLoaded;
  }

  masterTime() {
    if (this.isTrackMode()) return this.trackSource.currentTime;
    if (this.sessionStart == null) return this.sessionElapsed || 0;
    return (performance.now() - this.sessionStart) / 1000;
  }

  timelineRolling() {
    return this.isTrackMode() ? this.trackSource.isPlaying : this.isRunning;
  }

  resetSession() {
    this.sessionStart = null;
    this.sessionElapsed = 0;
    this.record.clear();
    this.clipEngine.reset();
    this.timeline.resetSession();
  }

  seekMaster(seconds) {
    if (!this.isTrackMode()) return;
    this.trackSource.seek(seconds);
    this.record.breakContinuity();
    this.clipEngine.seekTo(this.trackSource.currentTime);
  }

  transportStop() {
    if (this.isTrackMode()) {
      this.trackSource.pause();
      this.clipEngine.setActive(false);
      this.setStartButton('Play', false);
      this.seekMaster(0);
    } else if (this.isRunning) {
      this.stopAudio();
    }
  }

  async startAudio() {
    try {
      // Update UI to show attempting to start
      this.deviceStatusSpan.textContent = 'Requesting audio access...';
      this.startBtn.textContent = 'Starting...';
      this.startBtn.disabled = true;
      
      // Use selected device or let the system auto-select
      await this.audioProcessor.startAudio(this.selectedDeviceId);
      this.attachEq();
      this.visualizer.start();
      this.isRunning = true;
      this.setStartButton('Stop', true);
      this.startBtn.disabled = false;

      // Live session clock: a fresh, unbounded timeline per start.
      this.resetSession();
      this.sessionStart = performance.now();
      this.clipEngine.setActive(this.visualizer.currentMode === 'clips');
      
      // Update status to show active device
      const currentDevice = this.selectedDeviceId ? 
        this.audioInputSelect.selectedOptions[0]?.textContent.replace('🎧 ', '') : 
        'Auto-selected device';
      this.deviceStatusSpan.textContent = `Active: ${currentDevice}`;
      
      console.log('DJ Visualizer started with device:', currentDevice);
    } catch (error) {
      console.error('Failed to start audio:', error);
      this.setStartButton('Start', false);
      this.startBtn.disabled = false;

      // Provide specific error messages based on error type
      let errorMessage = 'Failed to start audio: ';
      let statusMessage = 'Audio failed';
      
      if (error.name === 'NotAllowedError') {
        errorMessage += 'Microphone access denied. Please click the microphone icon in your browser\'s address bar and allow access.';
        statusMessage = 'Permission denied';
      } else if (error.name === 'NotFoundError') {
        errorMessage += 'No audio input device found. Please connect a microphone or audio device.';
        statusMessage = 'No device found';
      } else if (error.name === 'NotReadableError') {
        errorMessage += 'Audio device is busy. Please close other applications using the microphone.';
        statusMessage = 'Device busy';
      } else if (error.name === 'OverconstrainedError') {
        errorMessage += 'Selected audio device is not available. Try selecting a different device.';
        statusMessage = 'Device unavailable';
      } else {
        errorMessage += error.message || 'Unknown error occurred.';
        statusMessage = 'Error occurred';
      }
      
      this.deviceStatusSpan.textContent = statusMessage;
      alert(errorMessage);
    }
  }

  stopAudio() {
    // Track mode owns an <audio> element the processor doesn't know about;
    // unload() tears that down and then calls audioProcessor.stop().
    this.eq.detach();
    if (this.trackSource.isLoaded) this.trackSource.unload();
    else this.audioProcessor.stop();
    this.visualizer.stop();
    this.clipEngine.setActive(false);

    // Freeze the live session clock so the timeline holds its recording.
    if (this.sessionStart != null) {
      this.sessionElapsed = (performance.now() - this.sessionStart) / 1000;
      this.sessionStart = null;
    }

    this.isRunning = false;
    this.setStartButton('Start', false);

    // Update status to show ready state
    const selectedDevice = this.selectedDeviceId ? 
      this.audioInputSelect.selectedOptions[0]?.textContent.replace('🎧 ', '') : 
      'Auto-select mode';
    this.deviceStatusSpan.textContent = `Ready: ${selectedDevice}`;
    
    console.log('DJ Visualizer stopped');
  }

  setupGainControls() {
    const bassSlider = document.getElementById('bassGain');
    const midSlider = document.getElementById('midGain');
    const highSlider = document.getElementById('highGain');
    const bassValue = document.getElementById('bassValue');
    const midValue = document.getElementById('midValue');
    const highValue = document.getElementById('highValue');
    
    bassSlider.addEventListener('input', (e) => {
      this.bassGain = parseFloat(e.target.value);
      bassValue.textContent = this.bassGain.toFixed(1);
    });
    
    midSlider.addEventListener('input', (e) => {
      this.midGain = parseFloat(e.target.value);
      midValue.textContent = this.midGain.toFixed(1);
    });
    
    highSlider.addEventListener('input', (e) => {
      this.highGain = parseFloat(e.target.value);
      highValue.textContent = this.highGain.toFixed(1);
    });
  }
  
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      
      switch(e.code) {
        case 'Space':
          e.preventDefault();
          this.toggleAudio();
          break;
        case 'KeyF':
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4':
        case 'Digit5':
        case 'Digit6':
        case 'Digit7':
        case '6': case '7': case '8': case '9':
          e.preventDefault();
          this.switchVisualizationMode(parseInt(e.key) - 1);
          break;
      }
    });
  }
  
  switchVisualizationMode(index) {
    const visualModeSelect = document.getElementById('visualMode');
    if (index < visualModeSelect.options.length) {
      visualModeSelect.selectedIndex = index;
      visualModeSelect.dispatchEvent(new Event('change'));
    }
  }
  
  async refreshAudioDevices() {
    console.log('Refreshing audio device list...');
    await this.populateAudioDevices();
  }
  
  
  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error('Error entering fullscreen:', err);
      });
      this.fullscreenBtn.textContent = 'Exit Fullscreen';
    } else {
      document.exitFullscreen();
      this.fullscreenBtn.textContent = 'Fullscreen';
    }
  }
  
  switchVisualizationMode(mode) {
    const visualModeSelect = document.getElementById('visualMode');
    if (visualModeSelect) {
      visualModeSelect.value = mode;
      visualModeSelect.dispatchEvent(new Event('change'));
    }
  }

  resetGains() {
    this.bassGain = 1.0;
    this.midGain = 1.0;
    this.highGain = 1.0;
    
    // Update UI sliders
    const bassSlider = document.getElementById('bassGain');
    const midSlider = document.getElementById('midGain');
    const highSlider = document.getElementById('highGain');
    
    if (bassSlider) {
      bassSlider.value = 1.0;
      document.getElementById('bassValue').textContent = '1.0';
    }
    if (midSlider) {
      midSlider.value = 1.0;
      document.getElementById('midValue').textContent = '1.0';
    }
    if (highSlider) {
      highSlider.value = 1.0;
      document.getElementById('highValue').textContent = '1.0';
    }
  }

  updateBPM(bpm) {
    if (this.bpmCounter) {
      this.bpmCounter.textContent = `${bpm || '--'}`;
      console.log(`UI BPM Display: ${bpm || '--'}`);
    }
    
    // Flash beat indicator when BPM is detected
    if (bpm > 0 && this.beatIndicator) {
      this.beatIndicator.classList.add('flash');
      setTimeout(() => {
        this.beatIndicator.classList.remove('flash');
      }, 150);
    }
  }

  toggleHelp() {
    const helpOverlay = document.getElementById('helpOverlay');
    if (helpOverlay) {
      helpOverlay.style.display = helpOverlay.style.display === 'none' ? 'flex' : 'none';
    }
  }

  hideHelp() {
    const helpOverlay = document.getElementById('helpOverlay');
    if (helpOverlay) {
      helpOverlay.style.display = 'none';
    }
  }

  updateFPS() {
    this.frameCount++;
    const currentTime = performance.now();
    
    if (currentTime - this.lastFrameTime >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / (currentTime - this.lastFrameTime));
      this.fpsCounter.textContent = `${fps}`;
      this.frameCount = 0;
      this.lastFrameTime = currentTime;
    }
  }

  destroy() {
    this.stopAudio();
    this.voice.unload();
    this.visualizer.destroy();
  }
}

// Initialize the app when the page loads.
// Declared with `var` (not `let`) so it becomes a `window` property --
// the pop-out output window (see output.js) reaches into this instance
// via `window.opener.djApp`, which only works for var/function bindings.
var djApp;

document.addEventListener('DOMContentLoaded', async () => {
  djApp = new DJVisualizerApp();
  await djApp.init();
});

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  if (djApp) {
    djApp.destroy();
  }
});

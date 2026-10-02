class DJVisualizerApp {
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

    // Clip auto-editor + bottom timeline panel
    this.clipEngine = new ClipEngine(this.visualizer);
    this.visualizer.clipEngine = this.clipEngine;
    this.clipEngine.clock = () => this.masterTime();
    this.clipEngine.isAdvancing = () => this.visualizer.currentMode === 'clips' && this.timelineRolling();
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
    this.sidebar = new Sidebar();
    this.sidebar.init();

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

      switch(e.code) {
        case 'KeyF':
          e.preventDefault();
          this.toggleFullscreen();
          break;
        case 'Digit1':
          e.preventDefault();
          this.switchVisualizationMode('spectrum');
          break;
        case 'Digit2':
          e.preventDefault();
          this.switchVisualizationMode('particles');
          break;
        case 'Digit3':
          e.preventDefault();
          this.switchVisualizationMode('rings');
          break;
        case 'Digit4':
          e.preventDefault();
          this.switchVisualizationMode('waves');
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
        bass: data.bass * this.bassGain,
        mid: data.mid * this.midGain,
        high: data.high * this.highGain
      };
      this.visualizer.updateAudioData(adjustedData);
      console.log(`Received BPM data: ${data.bpm}`);
      this.updateBPM(data.bpm);
      this.updateFPS();

      // Clip auto-editor consumes the same adjusted data + the visualizer's
      // beat clock updated just above.
      this.clipEngine.update(adjustedData);
      this.timeline.onAudioFrame(adjustedData);
    };

    this.visualModeSelect = document.getElementById('visualMode');
    this.visualModeSelect.addEventListener('change', () => {
      this.clipEngine.setActive(this.visualModeSelect.value === 'clips' && this.timelineRolling());
    });

    this.timeline.init();

    // 03 Assets: asset bin + selected-asset properties (v2.1, D-44)
    this.assetPanel = new AssetPanel(this);
    this.assetPanel.init();

    // Check permissions and populate audio devices
    await this.checkAudioPermissions();
    await this.populateAudioDevices();
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

  async loadAudioFile(file) {
    this.audioFileStatus.textContent = `Loading: ${file.name}...`;
    try {
      await this.trackSource.load(file);
      this.audioFileStatus.textContent = `Loaded: ${file.name}`;
      this.resetSession();
      this.timeline.loadTrackWaveform(file);

      this.isRunning = true;
      this.visualizer.start();
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
    this.clipEngine.reset();
    this.timeline.resetSession();
  }

  seekMaster(seconds) {
    if (!this.isTrackMode()) return;
    this.trackSource.seek(seconds);
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

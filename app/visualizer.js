class DJVisualizer {
  constructor() {
    this.p5Instance = null;
    this.audioData = {
      rms: 0,
      bass: 0,
      mid: 0,
      high: 0,
      spectrum: [],
      bpm: 0
    };
    this.w = 0;
    this.h = 0;
    this.currentMode = 'spectrum';
    this.asciify = null;
    this.particles = [];
    this.time = 0;
    this.isRunning = false;
    
    // Beat sync state
    this.lastBeatTime = 0;
    this.beatFlash = 0;
    this.beatPulse = 0;
    this.bpmInterval = 500; // Default 120 BPM
    this.polygonCollageStarted = false;
    
    // Snake game state
    this.snake = {
      body: [{x: 10, y: 10}],
      direction: {x: 1, y: 0},
      nextDirection: {x: 1, y: 0}
    };
    this.food = {x: 15, y: 15};
    this.gridSize = 20;
    this.snowflakes = [];
    
    // Media Layers: background + 3 beat-reactive layers (bass/mid/high).
    // Background has no enabled/justify/stack — it's a fixed base layer, always
    // drawn first and full-bleed. Bass/mid/high are independently toggleable,
    // auto-fit within the canvas, and positioned via justify + stack order.
    this.layers = {
      background: { media: null, type: null, url: null },
      bass:  { media: null, type: null, url: null, enabled: true,  justify: 'center', stack: 'middle', isSmall: false },
      mid:   { media: null, type: null, url: null, enabled: false, justify: 'center', stack: 'top',    isSmall: false },
      high:  { media: null, type: null, url: null, enabled: false, justify: 'center', stack: 'bottom', isSmall: false }
    };
    // A layer's fitted width under this fraction of canvas width counts as "small" --
    // used to auto-suggest left/right justify instead of letting small layers pile
    // up on top of each other in the center (e.g. two side-by-side character layers).
    this.smallLayerThreshold = 0.35;

    // Polygon visualization state
    this.polygonPoints = [];
    this.sampleRate = 8;
    this.frames = 0;
    this.shapePoints = 4;
    this.backgroundImage = null;
    
    // Frequency band colors (consistent across all modes)
    this.colors = {
      bass: [255, 80, 80],     // Red for bass (20-250Hz)
      mid: [80, 255, 120],     // Green for mid (250-4kHz)  
      high: [80, 160, 255]     // Blue for high (4k-20kHz)
    };
  }

  init() {
    // Initialize spectrum visualizer
    this.initSpectrumVisualizer();
    
    // Initialize frequency band displays
    this.bassFill = document.querySelector(".bass-fill");
    this.midFill = document.querySelector(".mid-fill");
    this.highFill = document.querySelector(".high-fill");
    
    // Initialize visualization mode selector
    this.visualModeSelect = document.getElementById('visualMode');
    this.visualModeSelect.addEventListener('change', (e) => {
      const previousMode = this.currentMode;
      this.currentMode = e.target.value;
      console.log('Visualization mode changed to:', this.currentMode);
      this.initializeParticles();
      if (this.currentMode === 'snake') {
        this.initializeSnake();
      }
      // Swap surfaces immediately, not only on the next running frame --
      // otherwise the p5 canvas can stay on top of the spectrum bars
      // while audio is stopped.
      this.applyModeSurface();
      // Note: layer videos loop continuously once loaded regardless of the
      // active mode (not paused when leaving 'layers' mode). Fine for a rough
      // demo; revisit if this becomes a real performance/battery concern.
    });

    // Media Layers: wire up upload inputs + (for reactive layers) enabled toggle,
    // justify select, and stack-order select.
    ['background', 'bass', 'mid', 'high'].forEach(layerName => {
      const fileInput = document.getElementById(`layerUpload-${layerName}`);
      if (fileInput) {
        fileInput.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) this.loadLayerMedia(layerName, file);
        });

        const dropZone = fileInput.closest('.layer-upload-group');
        if (dropZone) {
          dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
          });
          dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
          dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) this.loadLayerMedia(layerName, file);
          });
        }
      }

      if (layerName === 'background') return;

      const enabledCheckbox = document.getElementById(`layerEnabled-${layerName}`);
      if (enabledCheckbox) {
        this.layers[layerName].enabled = enabledCheckbox.checked;
        enabledCheckbox.addEventListener('change', (e) => {
          this.layers[layerName].enabled = e.target.checked;
          // Toggling a layer changes which layers are "small + enabled",
          // so re-run the side-by-side suggestion, not just at load time.
          this.autoAssignJustify();
        });
      }

      const justifySelect = document.getElementById(`layerJustify-${layerName}`);
      if (justifySelect) {
        justifySelect.value = this.layers[layerName].justify;
        justifySelect.addEventListener('change', (e) => {
          this.layers[layerName].justify = e.target.value;
        });
      }

      const stackSelect = document.getElementById(`layerStack-${layerName}`);
      if (stackSelect) {
        stackSelect.value = this.layers[layerName].stack;
        stackSelect.addEventListener('change', (e) => {
          this.assignStackPosition(layerName, e.target.value);
        });
      }
    });

    this.p5Instance = new p5((p) => {
      p.setup = () => {
        // The stage is the frame at the display size (D-63).
        const container = document.getElementById('stage') || document.querySelector('.visualizer-container');
        this.w = container.clientWidth;
        this.h = container.clientHeight;
        const canvas = p.createCanvas(this.w, this.h, p.WEBGL);
        canvas.parent('p5-canvas');
        p.frameRate(60);
        
        this.initializeParticles();
        this.initializeSnake();

        // The viewport also resizes when the bottom timeline panel is
        // dragged, which doesn't fire a window resize.
        if (window.ResizeObserver) {
          new ResizeObserver(() => p.windowResized()).observe(container);
        }
      };

      p.windowResized = () => {
        const container = document.getElementById('stage') || document.querySelector('.visualizer-container');
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!w || !h || (w === this.w && h === this.h)) return;
        this.w = w;
        this.h = h;
        p.resizeCanvas(this.w, this.h);
      };

      p.draw = () => {
        // Media Layers and the clip editor render even when audio isn't
        // running, so uploads are visible immediately -- other modes still
        // gate on isRunning since they're purely audio-reactive.
        if (this.isRunning || this.currentMode === 'layers' || this.currentMode === 'clips') {
          this.draw(p);
        } else {
          // Show static state when not running
          p.background(0);
        }
      };
    });
  }

  initializeParticles() {
    this.particles = [];
    for (let i = 0; i < 50; i++) {
      this.particles.push({
        x: Math.random() * this.w - this.w/2,
        y: Math.random() * this.h - this.h/2,
        z: Math.random() * 200 - 100,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        vz: (Math.random() - 0.5) * 2,
        size: Math.random() * 5 + 2
      });
    }
  }

  initializeSnake() {
    // Reset snake game state
    this.snake = {
      body: [{x: 10, y: 10}],
      direction: {x: 1, y: 0},
      nextDirection: {x: 1, y: 0}
    };
    this.food = {x: 15, y: 15};
    this.snowflakes = [];
    this.lastMoveTime = 0;
    
    // Initialize snowflakes
    for (let i = 0; i < 20; i++) {
      this.snowflakes.push({
        x: Math.random() * (this.w / this.gridSize),
        y: Math.random() * (this.h / this.gridSize),
        speed: Math.random() * 0.5 + 0.1,
        size: Math.random() * 3 + 1
      });
    }
  }

  loadLayerMedia(layerName, file) {
    if (!this.p5Instance) return;

    // Jump to Media Layers mode so the upload is visible right away, instead
    // of silently loading behind whatever visualization happens to be active.
    // (Clip editor mode can overlay layers, so it's left alone.)
    if (this.visualModeSelect && this.visualModeSelect.value !== 'layers' && this.visualModeSelect.value !== 'clips') {
      this.visualModeSelect.value = 'layers';
      this.visualModeSelect.dispatchEvent(new Event('change'));
    }

    const layer = this.layers[layerName];
    this.clearLayerMedia(layerName);

    // Kept so the pop-out output window (app/output.js) can independently
    // load its own copy of this media in its own p5/WebGL renderer -- p5.Image
    // and p5.MediaElement objects are tied to the renderer that created them,
    // so sharing this.media directly across windows breaks p5's texture pipeline.
    layer.file = file;

    const url = URL.createObjectURL(file);
    layer.url = url;
    const statusEl = document.getElementById(`layerStatus-${layerName}`);

    // Some systems report no MIME type for common video files; fall back
    // to the extension (D-54).
    const isVideo = file.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|ogv|3gp|avi)$/i.test(file.name);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name);
    if (isVideo) {
      layer.type = 'video';
      const video = this.p5Instance.createVideo([url], () => {
        video.volume(0);
        video.hide();
        video.loop();
        layer.media = video;
        // Rotated phone video: draw through a 2D copy so the rotation flag
        // is honoured on every GPU path (D-54).
        VideoOrientation.detect(file).then((rot) => {
          if (layer.media !== video) return;
          layer.rotation = rot;
          if (rot) layer.bridge = VideoOrientation.bridge(this.p5Instance, video);
        });
        this.evaluateLayerSize(layerName);
        if (statusEl) statusEl.textContent = `Loaded: ${file.name}`;
      });
    } else if (isImage) {
      layer.type = 'image';
      this.p5Instance.loadImage(
        url,
        (img) => {
          layer.media = img;
          this.evaluateLayerSize(layerName);
          if (statusEl) statusEl.textContent = `Loaded: ${file.name}`;
        },
        () => {
          if (statusEl) statusEl.textContent = `Failed to load: ${file.name}`;
          URL.revokeObjectURL(url);
          layer.url = null;
        }
      );
    } else {
      if (statusEl) statusEl.textContent = 'Unsupported file type';
      URL.revokeObjectURL(url);
      layer.url = null;
    }
  }

  clearLayerMedia(layerName) {
    const layer = this.layers[layerName];
    if (layer.bridge) { layer.bridge.remove(); layer.bridge = null; }
    layer.rotation = 0;
    if (layer.type === 'video' && layer.media) {
      layer.media.stop();
      layer.media.remove();
    }
    if (layer.url) {
      URL.revokeObjectURL(layer.url);
      layer.url = null;
    }
    layer.media = null;
    layer.type = null;
    layer.file = null;
    layer.isSmall = false;
  }

  // Size detector: flags a reactive layer "small" once loaded, based on its
  // auto-fit width relative to the canvas. Small + enabled layers get an
  // auto-suggested justify so they don't default into an overlapping pile
  // (this only runs at load time -- it's a starting suggestion, not a lock;
  // the justify dropdown always stays user-editable afterward).
  evaluateLayerSize(layerName) {
    const layer = this.layers[layerName];
    if (!layer.media || !this.w) return;

    const mediaW = layer.media.width || 1;
    const mediaH = layer.media.height || 1;
    const fitScale = Math.min(this.w / mediaW, this.h / mediaH) * 0.8;
    const fittedWidth = mediaW * fitScale;

    layer.isSmall = (fittedWidth / this.w) < this.smallLayerThreshold;

    if (layerName !== 'background') {
      this.autoAssignJustify();
    }
  }

  autoAssignJustify() {
    const order = ['bass', 'mid', 'high'];
    const smallEnabled = order.filter(name => {
      const l = this.layers[name];
      return l.enabled && l.isSmall && l.media;
    });

    if (smallEnabled.length === 2) {
      // Two small reactive layers -- side by side, e.g. the original
      // drummer + singer pairing, instead of stacked on top of each other.
      this.setJustify(smallEnabled[0], 'left');
      this.setJustify(smallEnabled[1], 'right');
    } else if (smallEnabled.length >= 3) {
      const spread = ['left', 'center', 'right'];
      smallEnabled.forEach((name, i) => this.setJustify(name, spread[i]));
    }
    // 0 or 1 small layers: leave justify as-is, no adjustment needed.
  }

  setJustify(layerName, value) {
    this.layers[layerName].justify = value;
    const select = document.getElementById(`layerJustify-${layerName}`);
    if (select) select.value = value;
  }

  // Strict 3-way stack assignment: bass/mid/high always occupy top/middle/bottom
  // with no ties. Picking a position already held by another layer bumps that
  // layer into the position being vacated.
  assignStackPosition(layerName, newPosition) {
    const order = ['bass', 'mid', 'high'];
    const conflictingLayer = order.find(
      name => name !== layerName && this.layers[name].stack === newPosition
    );

    if (conflictingLayer) {
      this.layers[conflictingLayer].stack = this.layers[layerName].stack;
      const conflictSelect = document.getElementById(`layerStack-${conflictingLayer}`);
      if (conflictSelect) conflictSelect.value = this.layers[conflictingLayer].stack;
    }

    this.layers[layerName].stack = newPosition;
  }

  initSpectrumVisualizer() {
    this.spectrumContainer = document.getElementById('spectrum-visualizer');
    this.spectrumBars = [];
  }

  updateAudioData(data) {
    this.audioData = { ...data };
    
    // Update BPM sync timing
    if (data.bpm > 0) {
      this.bpmInterval = 60000 / data.bpm; // Convert BPM to milliseconds
      
      // Check for beat sync pulse
      const currentTime = Date.now();
      const timeSinceLastBeat = currentTime - this.lastBeatTime;
      
      if (timeSinceLastBeat >= this.bpmInterval * 0.9) { // Trigger slightly early
        this.lastBeatTime = currentTime;
        this.beatFlash = 1.0; // Full flash intensity
        this.beatPulse = 1.0; // Full pulse
      }
    }
    
    // Decay beat effects
    this.beatFlash *= 0.85; // Fast decay for flash
    this.beatPulse *= 0.92; // Slower decay for pulse
    
    // Debug: Log audio data occasionally
    if (Math.random() < 0.01) {
      console.log('Audio data:', {
        rms: this.audioData.rms,
        bass: this.audioData.bass,
        mid: this.audioData.mid,
        high: this.audioData.high,
        bpm: this.audioData.bpm,
        beatPulse: this.beatPulse.toFixed(2),
        spectrumLength: this.audioData.spectrum?.length || 0
      });
    }
  }

  updateFrequencyDisplay() {
    if (!this.isRunning) {
      // Reset frequency displays when stopped
      if (this.bassFill) this.bassFill.style.height = '0%';
      if (this.midFill) this.midFill.style.height = '0%';
      if (this.highFill) this.highFill.style.height = '0%';
      return;
    }
    
    // Update frequency band displays with beat sync
    const bassIntensity = Math.min(100, this.audioData.bass * 100 * (1 + this.beatPulse * 0.3));
    const midIntensity = Math.min(100, this.audioData.mid * 100 * (1 + this.beatPulse * 0.2));
    const highIntensity = Math.min(100, this.audioData.high * 100 * (1 + this.beatPulse * 0.25));
    
    if (this.bassFill) {
      this.bassFill.style.height = `${bassIntensity}%`;
    }
    if (this.midFill) {
      this.midFill.style.height = `${midIntensity}%`;
    }
    if (this.highFill) {
      this.highFill.style.height = `${highIntensity}%`;
    }
  }

  draw(p) {
    this.time += 0.01;
    
    // Update frequency band displays (always show these)
    this.updateFrequencyDisplay();
    
    // Handle spectrum mode separately (HTML-based)
    this.applyModeSurface();
    if (this.currentMode === 'spectrum') {
      this.updateSpectrumBars();
      return;
    }
    
    // Clear canvas and draw based on selected mode
    // For polygons, don't clear background to create collage effect
    if (this.currentMode === 'polygons') {
      // Only clear on first draw or when switching modes
      if (!this.polygonCollageStarted) {
        p.background(0);
        this.polygonCollageStarted = true;
      }
    } else if (this.currentMode === 'layers' || this.currentMode === 'clips') {
      // Full clear every frame -- the background layer (once loaded) redraws
      // full-bleed on top of this anyway, but we don't want the motion-trail
      // alpha clear ghosting behind layers as the bass rattle jitters them.
      p.background(0);
      this.polygonCollageStarted = false;
    } else {
      p.background(0, 0, 0, 30);
      this.polygonCollageStarted = false;
    }
    
    // Draw visualization based on current mode
    switch (this.currentMode) {
      case 'particles':
        this.drawFloatingParticles3D(p);
        break;
      case 'rings':
        this.drawFrequencyRings3D(p);
        break;
      case 'waves':
        this.drawAudioWaves(p);
        break;
      case 'mandala':
        this.drawMandala(p);
        break;
      case 'tunnel':
        this.drawTunnel(p);
        break;
      case 'galaxy':
        this.drawGalaxy(p);
        break;
      case 'polygons':
        this.drawAudioPolygons(p);
        break;
      case 'layers':
        this.drawMediaLayers(p);
        break;
      case 'clips':
        if (this.clipEngine) this.clipEngine.draw(p);
        break;
      default:
        this.drawFloatingParticles3D(p);
    }
  }

  updateSpectrumBars() {
    if (!this.audioData.spectrum || this.audioData.spectrum.length === 0) return;
    
    // Create bars if they don't exist
    if (this.spectrumBars.length === 0) {
      this.createSpectrumBars();
    }
    
    // Update bar heights
    for (let i = 0; i < this.spectrumBars.length && i < this.audioData.spectrum.length; i++) {
      const value = this.audioData.spectrum[i];
      const height = (value * 100);
      this.spectrumBars[i].style.height = `${height}%`;
    }
  }

  createSpectrumBars() {
    if (!this.audioData.spectrum) return;
    
    // Clear existing bars
    this.spectrumContainer.innerHTML = '';
    this.spectrumBars = [];
    
    const numBars = Math.min(this.audioData.spectrum.length, 256); // Limit for performance
    
    for (let i = 0; i < numBars; i++) {
      const bar = document.createElement('div');
      this.spectrumContainer.appendChild(bar);
      this.spectrumBars.push(bar);
    }
  }

  drawCreativeVisuals(p) {
    // Only draw if audio is active
    if (!this.audioData.isActive || this.audioData.rms < 0.001) {
      return;
    }

    // Draw subtle creative elements over the spectrum
    this.drawFloatingParticles(p);
    this.drawFrequencyRings(p);
  }

  drawFloatingParticles(p) {
    // Bass-driven particles
    if (this.audioData.bass > 0.05) {
      p.fill(255, 107, 107, 100);
      for (let i = 0; i < 3; i++) {
        const x = p.random(this.w * 0.1, this.w * 0.3);
        const y = p.random(this.h * 0.7, this.h * 0.9);
        const size = this.audioData.bass * 20;
        p.ellipse(x, y, size, size);
      }
    }

    // Mid-driven particles
    if (this.audioData.mid > 0.1) {
      p.fill(78, 205, 196, 120);
      for (let i = 0; i < 5; i++) {
        const x = p.random(this.w * 0.4, this.w * 0.6);
        const y = p.random(this.h * 0.3, this.h * 0.7);
        const size = this.audioData.mid * 15;
        p.ellipse(x, y, size, size);
      }
    }

    // High sparkles
    if (this.audioData.high > 0.08) {
      p.fill(69, 183, 209, 150);
      for (let i = 0; i < 8; i++) {
        const x = p.random(this.w * 0.7, this.w * 0.9);
        const y = p.random(this.h * 0.1, this.h * 0.4);
        const size = this.audioData.high * 10;
        p.ellipse(x, y, size, size);
      }
    }
  }

  drawFrequencyRings(p) {
    // Central frequency ring
    p.push();
    p.translate(this.w / 2, this.h / 2);
    p.noFill();
    p.strokeWeight(2);
    
    // RMS-driven main ring
    const mainRadius = this.audioData.rms * 100;
    p.stroke(255, 255, 255, 100);
    p.ellipse(0, 0, mainRadius * 2, mainRadius * 2);
    
    // Frequency-specific rings
    if (this.audioData.bass > 0.03) {
      p.stroke(255, 107, 107, 80);
      p.ellipse(0, 0, (mainRadius + this.audioData.bass * 30) * 2, (mainRadius + this.audioData.bass * 30) * 2);
    }
    
    if (this.audioData.mid > 0.05) {
      p.stroke(78, 205, 196, 80);
      p.ellipse(0, 0, (mainRadius + this.audioData.mid * 25) * 2, (mainRadius + this.audioData.mid * 25) * 2);
    }
    
    if (this.audioData.high > 0.04) {
      p.stroke(69, 183, 209, 80);
      p.ellipse(0, 0, (mainRadius + this.audioData.high * 20) * 2, (mainRadius + this.audioData.high * 20) * 2);
    }
    
    p.pop();
  }

  drawCenterPulse(p) {
    // RMS-driven center circle - the "heart" that unifies all frequencies
    const r = p.map(this.audioData.rms, 0, 0.3, 20, Math.min(this.w, this.h) / 2, true);
    
    p.push();
    p.translate(this.w / 2, this.h / 2);
    
    // Main pulse circle
    p.fill(255, 200);
    p.ellipse(0, 0, r * 2, r * 2);
    
    // Add subtle frequency-colored rings around the center
    const bassRing = p.map(this.audioData.bass, 0, 0.10, 0, 30);
    const midRing = p.map(this.audioData.mid, 0, 0.05, 0, 20);
    const highRing = p.map(this.audioData.high, 0, 0.02, 0, 15);
    
    p.noFill();
    p.strokeWeight(2);
    
    p.stroke(255, 80, 80, 150);
    p.ellipse(0, 0, (r + bassRing) * 2, (r + bassRing) * 2);
    
    p.stroke(80, 255, 120, 150);
    p.ellipse(0, 0, (r + midRing) * 2, (r + midRing) * 2);
    
    p.stroke(120, 160, 255, 150);
    p.ellipse(0, 0, (r + highRing) * 2, (r + highRing) * 2);
    
    p.pop();
  }

  drawFrequencyBars(p) {
    // Three-band bars that work as puzzle pieces
    const barW = this.w / 6;
    const maxH = this.h * 0.6;
    
    // Less sensitive scaling for better dynamic range
    const bassH = p.constrain(p.map(this.audioData.bass, 0, 0.25, 0, maxH), 0, maxH);
    const midH = p.constrain(p.map(this.audioData.mid, 0, 0.30, 0, maxH), 0, maxH);
    const highH = p.constrain(p.map(this.audioData.high, 0, 0.20, 0, maxH), 0, maxH);

    p.noStroke();

    // Bass - Left side (warm red)
    p.fill(255, 80, 80);
    p.rect(this.w * 0.2 - barW / 2, this.h - bassH, barW, bassH);

    // Mid - Center (vibrant green)
    p.fill(80, 255, 120);
    p.rect(this.w * 0.5 - barW / 2, this.h - midH, barW, midH);

    // High - Right side (cool blue)
    p.fill(120, 160, 255);
    p.rect(this.w * 0.8 - barW / 2, this.h - highH, barW, highH);

    // Add frequency labels for DJ context
    this.drawFrequencyLabels(p);
  }

  drawFrequencyLabels(p) {
    p.fill(255, 150);
    p.textAlign(p.CENTER);
    p.textSize(12);
    
    const labelY = this.h - 10;
    
    p.text('BASS', this.w * 0.2, labelY);
    p.text('MID', this.w * 0.5, labelY);
    p.text('HIGH', this.w * 0.8, labelY);
  }

  drawFloatingParticles3D(p) {
    // Always show particles - create dynamic club atmosphere
    
    // Update particles based on audio with fallback animation
    for (let particle of this.particles) {
      const bassBoost = this.audioData.bass || Math.sin(this.time * 2) * 0.1;
      const midBoost = this.audioData.mid || Math.sin(this.time * 3) * 0.1;
      const highBoost = this.audioData.high || Math.sin(this.time * 4) * 0.1;
      
      particle.x += particle.vx + bassBoost * 5;
      particle.y += particle.vy + midBoost * 3;
      particle.z += particle.vz + highBoost * 4;
      
      // Wrap around screen
      if (particle.x > this.w/2) particle.x = -this.w/2;
      if (particle.x < -this.w/2) particle.x = this.w/2;
      if (particle.y > this.h/2) particle.y = -this.h/2;
      if (particle.y < -this.h/2) particle.y = this.h/2;
      if (particle.z > 100) particle.z = -100;
      if (particle.z < -100) particle.z = 100;
    }
    
    // Draw particles with frequency-based colors and enhanced dynamics
    const numParticles = this.particles.length;
    for (let i = 0; i < numParticles; i++) {
      const particle = this.particles[i];
      p.push();
      p.translate(particle.x, particle.y, particle.z);
      
      // Color particles based on frequency bands with enhanced intensity
      let color, intensity, sizeMultiplier;
      if (i < numParticles * 0.33) {
        // Bass particles (red) - bottom third
        intensity = Math.min(this.audioData.bass * 2, 1); // Double sensitivity
        color = [...this.colors.bass, 100 + intensity * 155];
        sizeMultiplier = 1 + intensity * 3; // More dramatic size changes
      } else if (i < numParticles * 0.66) {
        // Mid particles (green) - middle third  
        intensity = Math.min(this.audioData.mid * 1.8, 1);
        color = [...this.colors.mid, 100 + intensity * 155];
        sizeMultiplier = 1 + intensity * 2.5;
      } else {
        // High particles (blue) - top third
        intensity = Math.min(this.audioData.high * 2.5, 1); // Highest sensitivity
        color = [...this.colors.high, 100 + intensity * 155];
        sizeMultiplier = 1 + intensity * 4; // Most dramatic for high
      }
      
      p.fill(...color);
      p.noStroke();
      
      const baseSize = particle.size + this.audioData.rms * 15;
      const dynamicSize = baseSize * sizeMultiplier;
      p.sphere(dynamicSize);
      p.pop();
    }
  }

  drawFrequencyRings3D(p) {
    const rings = 12;
    for (let i = 0; i < rings; i++) {
      p.push();
      p.rotateX(this.time + i * 0.1);
      p.rotateY(this.time * 0.5 + i * 0.2);
      
      // Use audio data or fallback animation
      const bassIntensity = this.audioData.bass || Math.sin(this.time * 2 + i) * 0.3;
      const midIntensity = this.audioData.mid || Math.sin(this.time * 3 + i) * 0.3;
      const highIntensity = this.audioData.high || Math.sin(this.time * 4 + i) * 0.3;
      
      // Color rings based on frequency bands
      let color, intensity, baseRadius;
      if (i < rings * 0.33) {
        // Bass rings (red) - inner rings
        intensity = bassIntensity;
        color = [...this.colors.bass, 100 + intensity * 155];
        baseRadius = 40 + i * 20;
      } else if (i < rings * 0.66) {
        // Mid rings (green) - middle rings
        intensity = midIntensity;
        color = [...this.colors.mid, 100 + intensity * 155];
        baseRadius = 40 + i * 20;
      } else {
        // High rings (blue) - outer rings
        intensity = highIntensity;
        color = [...this.colors.high, 100 + intensity * 155];
        baseRadius = 40 + i * 20;
      }
      
      p.stroke(...color);
      p.strokeWeight(2 + intensity * 4);
      p.noFill();
      
      const radius = baseRadius + intensity * 100;
      p.circle(0, 0, radius);
      p.pop();
    }
  }

  drawAudioWaves(p) {
    // Dynamic waveform visualization for club atmosphere
    p.stroke(255, 100);
    p.strokeWeight(2);
    p.noFill();
    
    const waveHeight = this.h * 0.3;
    const centerY = 0;
    
    // Bass wave (bottom)
    p.stroke(...this.colors.bass, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 10) {
      const bassWave = Math.sin(x * 0.01 + this.time * 5) * (this.audioData.bass || 0.1) * waveHeight;
      p.vertex(x, centerY + bassWave + 100);
    }
    p.endShape();
    
    // Mid wave (center)
    p.stroke(...this.colors.mid, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 8) {
      const midWave = Math.sin(x * 0.015 + this.time * 3) * (this.audioData.mid || 0.1) * waveHeight;
      p.vertex(x, centerY + midWave);
    }
    p.endShape();
    
    // High wave (top)
    p.stroke(...this.colors.high, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 6) {
      const highWave = Math.sin(x * 0.02 + this.time * 7) * (this.audioData.high || 0.1) * waveHeight;
      p.vertex(x, centerY + highWave - 100);
    }
    p.endShape();
  }

  drawMandala(p) {
    // Rotating mandala pattern for hypnotic club visuals
    p.push();
    p.rotateZ(this.time * 0.5);
    
    const layers = 8;
    for (let layer = 0; layer < layers; layer++) {
      p.push();
      p.rotateZ(layer * 0.3 + this.time);
      
      const spokes = 12;
      for (let i = 0; i < spokes; i++) {
        p.push();
        p.rotateZ((i / spokes) * p.TWO_PI);
        
        // Color based on frequency bands
        let color, intensity;
        if (layer < layers * 0.33) {
          intensity = this.audioData.bass || Math.sin(this.time * 2) * 0.3;
          color = [...this.colors.bass, 100 + intensity * 155];
        } else if (layer < layers * 0.66) {
          intensity = this.audioData.mid || Math.sin(this.time * 3) * 0.3;
          color = [...this.colors.mid, 100 + intensity * 155];
        } else {
          intensity = this.audioData.high || Math.sin(this.time * 4) * 0.3;
          color = [...this.colors.high, 100 + intensity * 155];
        }
        
        p.stroke(...color);
        p.strokeWeight(1 + intensity * 3);
        
        const radius = 50 + layer * 30 + intensity * 50;
        p.line(0, 0, radius, 0);
        p.pop();
      }
      p.pop();
    }
    p.pop();
  }

  drawTunnel(p) {
    // 3D tunnel effect for immersive club experience
    const rings = 20;
    for (let i = 0; i < rings; i++) {
      p.push();
      p.translate(0, 0, -i * 50 + (this.time * 100) % (rings * 50));
      
      // Color based on depth and frequency
      let color, intensity;
      const depth = i / rings;
      if (depth < 0.33) {
        intensity = this.audioData.bass || Math.sin(this.time * 2) * 0.3;
        color = [...this.colors.bass, 50 + intensity * 100];
      } else if (depth < 0.66) {
        intensity = this.audioData.mid || Math.sin(this.time * 3) * 0.3;
        color = [...this.colors.mid, 50 + intensity * 100];
      } else {
        intensity = this.audioData.high || Math.sin(this.time * 4) * 0.3;
        color = [...this.colors.high, 50 + intensity * 100];
      }
      
      p.stroke(...color);
      p.strokeWeight(2 + intensity * 4);
      p.noFill();
      
      const radius = 100 + intensity * 80;
      p.circle(0, 0, radius);
      p.pop();
    }
  }

  drawGalaxy(p) {
    // Spiral galaxy effect with frequency-reactive arms and fallback animation
    const arms = 4;
    const pointsPerArm = 50;
    
    for (let arm = 0; arm < arms; arm++) {
      p.push();
      p.rotateZ(this.time * 0.2 + (arm / arms) * p.TWO_PI);
      
      for (let i = 0; i < pointsPerArm; i++) {
        const t = i / pointsPerArm;
        const angle = t * p.TWO_PI * 3; // 3 full rotations
        const radius = t * 200;
        
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        
        // Color based on distance from center with fallback animation
        let color, intensity;
        if (t < 0.33) {
          intensity = this.audioData.bass || Math.sin(this.time * 2 + i) * 0.3;
          color = [...this.colors.bass, 100 + intensity * 155];
        } else if (t < 0.66) {
          intensity = this.audioData.mid || Math.sin(this.time * 3 + i) * 0.3;
          color = [...this.colors.mid, 100 + intensity * 155];
        } else {
          intensity = this.audioData.high || Math.sin(this.time * 4 + i) * 0.3;
          color = [...this.colors.high, 100 + intensity * 155];
        }
        
        p.push();
        p.translate(x, y, 0);
        p.fill(...color);
        p.noStroke();
        
        const size = 2 + intensity * 8;
        p.sphere(size);
        p.pop();
      }
      p.pop();
    }
  }

  // Bass/mid/high draw in bottom -> middle -> top order so "top" ends up
  // frontmost. Only enabled layers with media loaded are drawn. Also used by
  // the clip auto-editor to overlay layers on top of clips.
  drawReactiveLayers(p) {
    const stackOrder = { bottom: 0, middle: 1, top: 2 };
    ['bass', 'mid', 'high']
      .filter(name => this.layers[name].enabled && this.layers[name].media)
      .sort((a, b) => stackOrder[this.layers[a].stack] - stackOrder[this.layers[b].stack])
      .forEach(name => this.drawSingleLayer(p, name, { reactive: true }));
  }

  drawMediaLayers(p) {
    const hasAnyMedia = this.layers.background.media || this.layers.bass.media ||
      this.layers.mid.media || this.layers.high.media;

    if (!hasAnyMedia) {
      p.push();
      p.fill(255, 120);
      p.textAlign(p.CENTER, p.CENTER);
      p.textSize(16);
      p.text('Upload images for Background, Bass, Mid, and High to begin', 0, 0);
      p.pop();
      return;
    }

    // Background is drawn first, full-bleed (cover-fit, not contain-fit,
    // so it fills the frame edge to edge with no letterboxing), static.
    this.drawSingleLayer(p, 'background', { reactive: false });

    this.drawReactiveLayers(p);

    // BPM beat flash overlay across the whole composite
    if (this.beatFlash > 0.05) {
      p.push();
      p.noStroke();
      p.fill(255, this.beatFlash * 120);
      p.rect(-this.w / 2, -this.h / 2, this.w, this.h);
      p.pop();
    }
  }

  drawSingleLayer(p, layerName, { reactive }) {
    const layer = this.layers[layerName];
    if (!layer.media) return;

    const mediaW = layer.media.width || 1;
    const mediaH = layer.media.height || 1;

    let baseW, baseH;
    if (reactive) {
      // Contain-fit with margin: shrink to fit fully within the canvas,
      // leaving room to be positioned via justify.
      const fitScale = Math.min(this.w / mediaW, this.h / mediaH) * 0.8;
      baseW = mediaW * fitScale;
      baseH = mediaH * fitScale;
    } else {
      // Background: cover-fit, fills the full frame (may crop the image),
      // since it's meant to be a full backdrop, not a positioned element.
      const coverScale = Math.max(this.w / mediaW, this.h / mediaH);
      baseW = mediaW * coverScale;
      baseH = mediaH * coverScale;
    }

    // Justify sets horizontal anchor; vertical stays centered for now.
    let x = 0;
    if (reactive) {
      if (layer.justify === 'left') x = -this.w / 2 + baseW / 2;
      else if (layer.justify === 'right') x = this.w / 2 - baseW / 2;
    }

    let offsetX = 0, offsetY = 0;

    // Bass rattle: small, fast x/y jitter scaled to bass energy. On by
    // default per spec. No scale or rotation involved -- just shakes in place.
    if (reactive && layerName === 'bass') {
      const bass = this.audioData.bass || 0;
      const rattleAmplitude = 18; // px, tune to taste
      offsetX = (p.noise(this.time * 40) - 0.5) * 2 * rattleAmplitude * bass;
      offsetY = (p.noise(this.time * 40 + 500) - 0.5) * 2 * rattleAmplitude * bass;
    }

    p.push();
    p.translate(x + offsetX, offsetY);
    p.image(layer.bridge ? layer.bridge.frame() : layer.media, -baseW / 2, -baseH / 2, baseW, baseH);
    p.pop();
  }

  drawSnakeGame(p) {
    // Create flowing EQ-reactive graphic visualization
    p.camera();
    
    // Get audio intensities with fallback animations
    const bassIntensity = this.audioData.bass || Math.sin(this.time * 2) * 0.3;
    const midIntensity = this.audioData.mid || Math.sin(this.time * 3) * 0.3;
    const highIntensity = this.audioData.high || Math.sin(this.time * 4) * 0.3;
    
    // Draw flowing frequency streams
    this.drawFrequencyStreams(p, bassIntensity, midIntensity, highIntensity);
    
    // Draw interconnected frequency nodes
    this.drawFrequencyNodes(p, bassIntensity, midIntensity, highIntensity);
    
    // Draw frequency waves that flow across the screen
    this.drawFlowingWaves(p, bassIntensity, midIntensity, highIntensity);
  }

  drawFrequencyStreams(p, bassIntensity, midIntensity, highIntensity) {
    // Draw flowing streams that represent each frequency band
    p.strokeWeight(3);
    p.noFill();
    
    const streamCount = 5;
    const streamLength = 100;
    
    for (let stream = 0; stream < streamCount; stream++) {
      const streamOffset = (stream / streamCount) * p.TWO_PI;
      
      // Bass stream (red) - flows from bottom left
      p.stroke(...this.colors.bass, 150 + bassIntensity * 105);
      p.beginShape();
      for (let i = 0; i < streamLength; i++) {
        const t = i / streamLength;
        const x = p.lerp(-this.w/2, this.w/2, t) + Math.sin(this.time * 2 + streamOffset + t * 4) * bassIntensity * 50;
        const y = p.lerp(this.h/4, -this.h/4, t) + Math.cos(this.time * 1.5 + streamOffset + t * 3) * bassIntensity * 30;
        p.vertex(x, y);
      }
      p.endShape();
      
      // Mid stream (green) - flows horizontally
      p.stroke(...this.colors.mid, 150 + midIntensity * 105);
      p.beginShape();
      for (let i = 0; i < streamLength; i++) {
        const t = i / streamLength;
        const x = p.lerp(-this.w/2, this.w/2, t) + Math.sin(this.time * 2.5 + streamOffset + t * 5) * midIntensity * 40;
        const y = Math.sin(this.time * 3 + streamOffset + t * 6) * midIntensity * 60;
        p.vertex(x, y);
      }
      p.endShape();
      
      // High stream (blue) - flows from top right
      p.stroke(...this.colors.high, 150 + highIntensity * 105);
      p.beginShape();
      for (let i = 0; i < streamLength; i++) {
        const t = i / streamLength;
        const x = p.lerp(this.w/2, -this.w/2, t) + Math.sin(this.time * 3.5 + streamOffset + t * 7) * highIntensity * 35;
        const y = p.lerp(-this.h/4, this.h/4, t) + Math.cos(this.time * 4 + streamOffset + t * 8) * highIntensity * 45;
        p.vertex(x, y);
      }
      p.endShape();
    }
  }

  drawFrequencyNodes(p, bassIntensity, midIntensity, highIntensity) {
    // Draw interconnected nodes that pulse with each frequency
    const nodeCount = 12;
    const radius = Math.min(this.w, this.h) * 0.3;
    
    for (let i = 0; i < nodeCount; i++) {
      const angle = (i / nodeCount) * p.TWO_PI + this.time * 0.5;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      
      // Determine node color based on position
      let color, intensity, nodeSize;
      if (i < nodeCount * 0.33) {
        // Bass nodes
        color = this.colors.bass;
        intensity = bassIntensity;
        nodeSize = 8 + intensity * 20;
      } else if (i < nodeCount * 0.66) {
        // Mid nodes
        color = this.colors.mid;
        intensity = midIntensity;
        nodeSize = 6 + intensity * 15;
      } else {
        // High nodes
        color = this.colors.high;
        intensity = highIntensity;
        nodeSize = 4 + intensity * 12;
      }
      
      // Draw node
      p.push();
      p.translate(x, y, 0);
      p.fill(...color, 150 + intensity * 105);
      p.noStroke();
      p.sphere(nodeSize);
      
      // Draw connections to nearby nodes
      if (intensity > 0.1) {
        p.stroke(...color, 80 + intensity * 80);
        p.strokeWeight(1 + intensity * 3);
        for (let j = i + 1; j < Math.min(i + 3, nodeCount); j++) {
          const nextAngle = (j / nodeCount) * p.TWO_PI + this.time * 0.5;
          const nextX = Math.cos(nextAngle) * radius;
          const nextY = Math.sin(nextAngle) * radius;
          p.line(0, 0, 0, nextX - x, nextY - y, 0);
        }
      }
      
      p.pop();
    }
  }

  drawFlowingWaves(p, bassIntensity, midIntensity, highIntensity) {
    // Draw flowing waves that represent the EQ as a unified graphic
    p.strokeWeight(2);
    p.noFill();
    
    const wavePoints = 60;
    const waveHeight = this.h * 0.2;
    
    // Create layered waves that flow and interact
    for (let layer = 0; layer < 3; layer++) {
      const layerOffset = layer * 0.3;
      
      // Bass wave layer (bottom)
      p.stroke(...this.colors.bass, 100 + bassIntensity * 100);
      p.beginShape();
      for (let i = 0; i < wavePoints; i++) {
        const x = p.map(i, 0, wavePoints - 1, -this.w/2, this.w/2);
        const baseY = this.h/4 - layer * 30;
        const waveY = Math.sin(i * 0.2 + this.time * 3 + layerOffset) * bassIntensity * waveHeight;
        const flowY = Math.cos(i * 0.15 + this.time * 2) * bassIntensity * 20;
        p.vertex(x, baseY + waveY + flowY);
      }
      p.endShape();
      
      // Mid wave layer (center)
      p.stroke(...this.colors.mid, 100 + midIntensity * 100);
      p.beginShape();
      for (let i = 0; i < wavePoints; i++) {
        const x = p.map(i, 0, wavePoints - 1, -this.w/2, this.w/2);
        const baseY = -layer * 20;
        const waveY = Math.sin(i * 0.25 + this.time * 2.5 + layerOffset) * midIntensity * waveHeight;
        const flowY = Math.cos(i * 0.18 + this.time * 3.5) * midIntensity * 25;
        p.vertex(x, baseY + waveY + flowY);
      }
      p.endShape();
      
      // High wave layer (top)
      p.stroke(...this.colors.high, 100 + highIntensity * 100);
      p.beginShape();
      for (let i = 0; i < wavePoints; i++) {
        const x = p.map(i, 0, wavePoints - 1, -this.w/2, this.w/2);
        const baseY = -this.h/4 + layer * 30;
        const waveY = Math.sin(i * 0.3 + this.time * 4 + layerOffset) * highIntensity * waveHeight;
        const flowY = Math.cos(i * 0.22 + this.time * 4.5) * highIntensity * 15;
        p.vertex(x, baseY + waveY + flowY);
      }
      p.endShape();
    }
  }

  drawSnake(p) {
    const bassIntensity = Math.min(this.audioData.bass * 2, 1);
    p.fill(...this.colors.bass, 150 + bassIntensity * 105);
    p.noStroke();
    
    for (let i = 0; i < this.snake.body.length; i++) {
      const segment = this.snake.body[i];
      const x = segment.x * this.gridSize;
      const y = segment.y * this.gridSize;
      
      // Head is bigger and more reactive
      const sizeBoost = i === 0 ? bassIntensity * 6 : bassIntensity * 3;
      const segmentSize = this.gridSize - 2 + sizeBoost;
      
      p.rect(x - sizeBoost/2, y - sizeBoost/2, segmentSize, segmentSize);
    }
  }

  drawFood(p) {
    const midIntensity = Math.min(this.audioData.mid * 2, 1); // Double sensitivity
    p.fill(...this.colors.mid, 150 + midIntensity * 105);
    p.noStroke();
    
    const x = this.food.x * this.gridSize;
    const y = this.food.y * this.gridSize;
    const size = this.gridSize - 4 + midIntensity * 15; // More dramatic pulsing
    
    // Add glow effect when mid is high
    if (midIntensity > 0.3) {
      p.fill(...this.colors.mid, 50);
      p.ellipse(x + this.gridSize/2, y + this.gridSize/2, size * 1.8, size * 1.8);
      p.fill(...this.colors.mid, 150 + midIntensity * 105);
    }
    
    p.ellipse(x + this.gridSize/2, y + this.gridSize/2, size, size);
  }

  drawSnowflakes(p) {
    const highIntensity = Math.min(this.audioData.high * 2.5, 1); // Highest sensitivity
    p.fill(...this.colors.high, 100 + highIntensity * 155);
    p.noStroke();
    
    for (let flake of this.snowflakes) {
      const x = flake.x * this.gridSize;
      const y = flake.y * this.gridSize;
      const size = flake.size + highIntensity * 8; // Much more dramatic size changes
      
      // Add sparkle effect for high frequencies
      if (highIntensity > 0.4) {
        p.fill(...this.colors.high, 30);
        p.ellipse(x, y, size * 2, size * 2);
        p.fill(...this.colors.high, 100 + highIntensity * 155);
      }
      
      p.ellipse(x, y, size, size);
    }
  }

  drawAudioWaves(p) {
    // Dynamic waveform visualization with fallback animation
    p.stroke(255, 100);
    p.strokeWeight(2);
    p.noFill();
    
    const waveHeight = this.h * 0.3;
    const centerY = 0;
    
    // Bass wave (bottom) - use audio data or fallback animation
    const bassIntensity = this.audioData.bass || Math.sin(this.time * 2) * 0.3;
    p.stroke(...this.colors.bass, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 10) {
      const bassWave = Math.sin(x * 0.01 + this.time * 5) * bassIntensity * waveHeight;
      p.vertex(x, centerY + bassWave + 100);
    }
    p.endShape();
    
    // Mid wave (center) - use audio data or fallback animation
    const midIntensity = this.audioData.mid || Math.sin(this.time * 3) * 0.3;
    p.stroke(...this.colors.mid, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 8) {
      const midWave = Math.sin(x * 0.015 + this.time * 3) * midIntensity * waveHeight;
      p.vertex(x, centerY + midWave);
    }
    p.endShape();
    
    // High wave (top) - use audio data or fallback animation
    const highIntensity = this.audioData.high || Math.sin(this.time * 4) * 0.3;
    p.stroke(...this.colors.high, 200);
    p.beginShape();
    for (let x = -this.w/2; x < this.w/2; x += 6) {
      const highWave = Math.sin(x * 0.02 + this.time * 7) * highIntensity * waveHeight;
      p.vertex(x, centerY + highWave - 100);
    }
    p.endShape();
  }

  drawMandala(p) {
    // Rotating mandala pattern with fallback animation
    p.push();
    p.rotateZ(this.time * 0.5);
    
    const layers = 8;
    for (let layer = 0; layer < layers; layer++) {
      p.push();
      p.rotateZ(layer * 0.3 + this.time);
      
      const spokes = 12;
      for (let i = 0; i < spokes; i++) {
        p.push();
        p.rotateZ((i / spokes) * p.TWO_PI);
        
        // Color based on frequency bands with fallback animation
        let color, intensity;
        if (layer < layers * 0.33) {
          intensity = this.audioData.bass || Math.sin(this.time * 2 + layer) * 0.3;
          color = [...this.colors.bass, 100 + intensity * 155];
        } else if (layer < layers * 0.66) {
          intensity = this.audioData.mid || Math.sin(this.time * 3 + layer) * 0.3;
          color = [...this.colors.mid, 100 + intensity * 155];
        } else {
          intensity = this.audioData.high || Math.sin(this.time * 4 + layer) * 0.3;
          color = [...this.colors.high, 100 + intensity * 155];
        }
        
        p.stroke(...color);
        p.strokeWeight(1 + intensity * 3);
        
        const radius = 50 + layer * 30 + intensity * 50;
        p.line(0, 0, radius, 0);
        p.pop();
      }
      p.pop();
    }
    p.pop();
  }

  drawTunnel(p) {
    // 3D tunnel effect with fallback animation
    const rings = 20;
    for (let i = 0; i < rings; i++) {
      p.push();
      p.translate(0, 0, -i * 50 + (this.time * 100) % (rings * 50));
      
      // Color based on depth and frequency with fallback animation
      let color, intensity;
      const depth = i / rings;
      if (depth < 0.33) {
        intensity = this.audioData.bass || Math.sin(this.time * 2 + i) * 0.3;
        color = [...this.colors.bass, 50 + intensity * 100];
      } else if (depth < 0.66) {
        intensity = this.audioData.mid || Math.sin(this.time * 3 + i) * 0.3;
        color = [...this.colors.mid, 50 + intensity * 100];
      } else {
        intensity = this.audioData.high || Math.sin(this.time * 4 + i) * 0.3;
        color = [...this.colors.high, 50 + intensity * 100];
      }
      
      p.stroke(...color);
      p.strokeWeight(2 + intensity * 4);
      p.noFill();
      
      const radius = 100 + intensity * 80;
      p.circle(0, 0, radius);
      p.pop();
    }
  }


  drawAudioPolygons(p) {
    // Switch to 2D mode for polygon visualization
    p.camera();
    p.translate(-this.w/2, -this.h/2, 0);
    
    this.frames++;
    
    // BPM-responsive sampling rate - faster BPM = more frequent polygons
    const bpm = this.audioData.bpm || 120;
    const bpmMultiplier = Math.max(0.5, Math.min(2.0, bpm / 120)); // Scale between 0.5x and 2x
    const dynamicSampleRate = Math.floor(this.sampleRate / bpmMultiplier);
    
    if (this.frames >= dynamicSampleRate) {
      this.frames = 0;
      
      // Enhanced EQ responsiveness - only use real audio data, no fallbacks
      const bassIntensity = this.audioData.bass || 0;
      const midIntensity = this.audioData.mid || 0;
      const highIntensity = this.audioData.high || 0;
      
      // Create audio-reactive sampling points
      const centerX = this.w / 2;
      const centerY = this.h / 2;
      
      // Enhanced EQ-responsive point generation with musical variety
      const beatPulse = this.beatPulse || 0;
      const bpm = this.audioData.bpm || 120;
      const timePhase = (Date.now() / 1000) * (bpm / 60); // Musical time phase
      
      // Create varied polygon shapes based on frequency combinations
      const totalEnergy = bassIntensity + midIntensity + highIntensity;
      
      // Bass creates flowing, organic shapes in lower area
      if (bassIntensity > 0.02) {
        const numPoints = Math.floor(bassIntensity * 4 * (1 + beatPulse));
        const bassPattern = Math.sin(timePhase * 0.5) * 0.3 + 0.7; // Slow wave pattern
        
        for (let i = 0; i < numPoints; i++) {
          // Create flowing, wave-like patterns for bass
          const angle = (i / numPoints) * Math.PI * 2 + timePhase;
          const radius = bassIntensity * 200 * bassPattern;
          const x = centerX + Math.cos(angle) * radius + (Math.random() - 0.5) * 100;
          const y = this.h * 0.7 + Math.sin(angle * 2) * 50 + Math.random() * this.h * 0.25;
          
          this.polygonPoints.push({ 
            x: Math.max(0, Math.min(this.w, x)), 
            y: Math.max(0, Math.min(this.h, y)), 
            type: 'bass', 
            intensity: bassIntensity * (1 + beatPulse * 0.6),
            shape: 'flowing'
          });
        }
      }
      
      // Mid creates geometric, structured patterns in middle area
      if (midIntensity > 0.02) {
        const numPoints = Math.floor(midIntensity * 3 * (1 + beatPulse * 0.8));
        const midPattern = Math.cos(timePhase * 1.5) * 0.4 + 0.6; // Medium frequency pattern
        
        for (let i = 0; i < numPoints; i++) {
          // Create geometric, grid-like patterns for mids
          const gridSize = 80 + midIntensity * 120;
          const gridX = Math.floor(Math.random() * (this.w / gridSize)) * gridSize + (gridSize / 2);
          const gridY = this.h * 0.4 + Math.floor(Math.random() * 3) * (this.h * 0.2);
          
          // Add some organic variation to the grid
          const x = gridX + Math.sin(timePhase + i) * 30 * midPattern;
          const y = gridY + Math.cos(timePhase * 2 + i) * 20 * midPattern;
          
          this.polygonPoints.push({ 
            x: Math.max(0, Math.min(this.w, x)), 
            y: Math.max(0, Math.min(this.h, y)), 
            type: 'mid', 
            intensity: midIntensity * (1 + beatPulse * 0.4),
            shape: 'geometric'
          });
        }
      }
      
      // High creates sparkle, explosive patterns in upper area
      if (highIntensity > 0.02) {
        const numPoints = Math.floor(highIntensity * 5 * (1 + beatPulse * 1.2));
        const highPattern = Math.sin(timePhase * 3) * 0.5 + 0.5; // Fast, sparkly pattern
        
        for (let i = 0; i < numPoints; i++) {
          // Create explosive, radiating patterns for highs
          const burstAngle = Math.random() * Math.PI * 2;
          const burstRadius = highIntensity * 150 * highPattern * (1 + beatPulse);
          const burstX = centerX + Math.cos(burstAngle) * burstRadius;
          const burstY = this.h * 0.25 + Math.sin(burstAngle) * burstRadius * 0.5;
          
          // Add sparkle effect
          const sparkleOffset = Math.sin(timePhase * 8 + i) * 20;
          const x = burstX + sparkleOffset;
          const y = burstY + Math.cos(timePhase * 6 + i) * 15;
          
          this.polygonPoints.push({ 
            x: Math.max(0, Math.min(this.w, x)), 
            y: Math.max(0, Math.min(this.h, y)), 
            type: 'high', 
            intensity: highIntensity * (1 + beatPulse * 0.8),
            shape: 'explosive'
          });
        }
      }
      
      // Add special "harmony" polygons when multiple frequencies are strong
      if (totalEnergy > 0.15 && bassIntensity > 0.05 && midIntensity > 0.05) {
        const harmonyPoints = Math.floor(totalEnergy * 2 * (1 + beatPulse));
        for (let i = 0; i < harmonyPoints; i++) {
          // Create connecting lines between frequency zones
          const x = Math.random() * this.w;
          const y = this.h * 0.2 + Math.random() * this.h * 0.6;
          
          this.polygonPoints.push({ 
            x, y, 
            type: 'harmony', 
            intensity: totalEnergy * 0.7,
            shape: 'connecting'
          });
        }
      }
      
      // Draw polygons when we have enough points
      if (this.polygonPoints.length >= this.shapePoints) {
        this.drawPolygonShape(p);
      }
      
      // Limit points array size for performance
      if (this.polygonPoints.length > 100) {
        this.polygonPoints = this.polygonPoints.slice(-50);
      }
    }
  }
  
  drawPolygonShape(p) {
    // Get the most recent points
    const recentPoints = this.polygonPoints.slice(-this.shapePoints);
    
    // Determine dominant frequency type and shape variety
    const typeCount = { bass: 0, mid: 0, high: 0, harmony: 0 };
    const shapeCount = { flowing: 0, geometric: 0, explosive: 0, connecting: 0 };
    let totalIntensity = 0;
    
    recentPoints.forEach(point => {
      typeCount[point.type]++;
      if (point.shape) shapeCount[point.shape]++;
      totalIntensity += point.intensity;
    });
    
    // Enhanced EQ-based colors with BPM responsiveness
    let color;
    const bpm = this.audioData.bpm || 120;
    const bpmPulse = Math.sin((Date.now() / 1000) * (bpm / 60) * 2 * Math.PI) * 0.3 + 0.7; // BPM-synced pulse
    const baseOpacity = 120 + (bpmPulse * 80); // Opacity pulses with BPM
    const intensityBoost = totalIntensity * 120 * bpmPulse;
    
    // Pure EQ-based colors only - Bass=Red, Mid=Green, High=Blue
    if (typeCount.bass >= typeCount.mid && typeCount.bass >= typeCount.high) {
      // Pure Bass = Red with intensity variations
      const bassBoost = this.audioData.bass * 150 * bpmPulse;
      color = [255, 0, 0, Math.min(255, baseOpacity + bassBoost)];
    } else if (typeCount.mid >= typeCount.high) {
      // Pure Mid = Green with intensity variations
      const midBoost = this.audioData.mid * 150 * bpmPulse;
      color = [0, 255, 0, Math.min(255, baseOpacity + midBoost)];
    } else {
      // Pure High = Blue with intensity variations
      const highBoost = this.audioData.high * 150 * bpmPulse;
      color = [0, 0, 255, Math.min(255, baseOpacity + highBoost)];
    }
    
    // Mixed frequency colors using only EQ colors
    if (typeCount.bass > 0 && typeCount.mid > 0 && typeCount.high === 0) {
      // Bass + Mid = Red + Green = Yellow
      const mixIntensity = (this.audioData.bass + this.audioData.mid) * 75 * bpmPulse;
      color = [255, 255, 0, Math.min(255, baseOpacity + mixIntensity)];
    } else if (typeCount.mid > 0 && typeCount.high > 0 && typeCount.bass === 0) {
      // Mid + High = Green + Blue = Cyan
      const mixIntensity = (this.audioData.mid + this.audioData.high) * 75 * bpmPulse;
      color = [0, 255, 255, Math.min(255, baseOpacity + mixIntensity)];
    } else if (typeCount.bass > 0 && typeCount.high > 0 && typeCount.mid === 0) {
      // Bass + High = Red + Blue = Magenta
      const mixIntensity = (this.audioData.bass + this.audioData.high) * 75 * bpmPulse;
      color = [255, 0, 255, Math.min(255, baseOpacity + mixIntensity)];
    } else if (typeCount.bass > 0 && typeCount.mid > 0 && typeCount.high > 0) {
      // All frequencies = Red + Green + Blue = White
      const allIntensity = (this.audioData.bass + this.audioData.mid + this.audioData.high) * 50 * bpmPulse;
      color = [255, 255, 255, Math.min(255, baseOpacity + allIntensity)];
    }
    
    // Harmony polygons use blended EQ colors
    if (typeCount.harmony > 0) {
      const bassWeight = this.audioData.bass || 0;
      const midWeight = this.audioData.mid || 0;
      const highWeight = this.audioData.high || 0;
      const totalWeight = bassWeight + midWeight + highWeight;
      
      if (totalWeight > 0) {
        const r = (bassWeight / totalWeight) * 255;
        const g = (midWeight / totalWeight) * 255;
        const b = (highWeight / totalWeight) * 255;
        color = [r, g, b, Math.min(255, baseOpacity + intensityBoost)];
      } else {
        color = [128, 128, 128, baseOpacity]; // Gray fallback
      }
    }
    
    p.fill(...color);
    p.noStroke();
    
    // Draw varied polygon shapes based on musical characteristics
    const dominantShape = Object.keys(shapeCount).reduce((a, b) => shapeCount[a] > shapeCount[b] ? a : b);
    
    p.fill(...color);
    p.noStroke();
    
    // Create different polygon styles based on dominant shape
    if (dominantShape === 'flowing') {
      // Smooth, organic curves for bass
      p.beginShape();
      for (let i = 0; i < this.shapePoints && i < recentPoints.length; i++) {
        const point = recentPoints[recentPoints.length - 1 - i];
        if (i === 0) {
          p.vertex(point.x, point.y);
        } else {
          // Create smooth curves
          const prevPoint = recentPoints[recentPoints.length - i];
          const cpX = (point.x + prevPoint.x) / 2;
          const cpY = (point.y + prevPoint.y) / 2;
          p.quadraticVertex(cpX, cpY, point.x, point.y);
        }
      }
      p.endShape(p.CLOSE);
      
    } else if (dominantShape === 'geometric') {
      // Sharp, angular shapes for mids
      p.beginShape();
      for (let i = 0; i < this.shapePoints && i < recentPoints.length; i++) {
        const point = recentPoints[recentPoints.length - 1 - i];
        // Add angular variations
        const angleOffset = (i % 2) * 10 - 5;
        p.vertex(point.x + angleOffset, point.y + angleOffset);
      }
      p.endShape(p.CLOSE);
      
    } else if (dominantShape === 'explosive') {
      // Star-like, radiating shapes for highs
      const centerX = recentPoints.reduce((sum, p) => sum + p.x, 0) / recentPoints.length;
      const centerY = recentPoints.reduce((sum, p) => sum + p.y, 0) / recentPoints.length;
      
      p.beginShape();
      for (let i = 0; i < this.shapePoints && i < recentPoints.length; i++) {
        const point = recentPoints[recentPoints.length - 1 - i];
        // Create radiating spikes
        const angle = Math.atan2(point.y - centerY, point.x - centerX);
        const distance = Math.sqrt((point.x - centerX) ** 2 + (point.y - centerY) ** 2);
        const spikeLength = distance * (1 + Math.sin(i * Math.PI / 2) * 0.3);
        const spikeX = centerX + Math.cos(angle) * spikeLength;
        const spikeY = centerY + Math.sin(angle) * spikeLength;
        p.vertex(spikeX, spikeY);
      }
      p.endShape(p.CLOSE);
      
    } else if (dominantShape === 'connecting') {
      // Flowing connector lines for harmony
      p.strokeWeight(3 + totalIntensity * 5);
      p.stroke(...color);
      p.noFill();
      
      p.beginShape();
      p.noFill();
      for (let i = 0; i < this.shapePoints && i < recentPoints.length; i++) {
        const point = recentPoints[recentPoints.length - 1 - i];
        if (i === 0) {
          p.vertex(point.x, point.y);
        } else {
          p.vertex(point.x, point.y);
        }
      }
      p.endShape();
      
    } else {
      // Default polygon shape
      p.beginShape();
      for (let i = 0; i < this.shapePoints && i < recentPoints.length; i++) {
        const point = recentPoints[recentPoints.length - 1 - i];
        p.vertex(point.x, point.y);
      }
      p.endShape(p.CLOSE);
    }
  }

  // Helper function to convert HSL to RGB
  hslToRgb(h, s, l, a = 255) {
    h = h / 360;
    s = s / 100;
    l = l / 100;
    
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
  }

  start() {
    this.isRunning = true;
    console.log('Visualizer started');
  }

  stop() {
    this.isRunning = false;
    this.polygonCollageStarted = false; // Reset polygon collage when stopped
    console.log('Visualizer stopped');
  }
  
  drawFallbackParticles(p) {
    // Draw simple animated particles for testing when no audio data
    for (let particle of this.particles) {
      particle.x += particle.vx;
      particle.y += particle.vy;
      particle.z += particle.vz;
      
      // Wrap around screen
      if (particle.x > this.w/2) particle.x = -this.w/2;
      if (particle.x < -this.w/2) particle.x = this.w/2;
      if (particle.y > this.h/2) particle.y = -this.h/2;
      if (particle.y < -this.h/2) particle.y = this.h/2;
      if (particle.z > 100) particle.z = -100;
      if (particle.z < -100) particle.z = 100;
    }
    
    // Draw particles
    for (let particle of this.particles) {
      p.push();
      p.translate(particle.x, particle.y, particle.z);
      
      p.fill(255, 100, 100, 200);
      p.noStroke();
      
      p.sphere(particle.size);
      p.pop();
    }
  }

  // Spectrum mode draws HTML bars; every other mode draws on the p5 canvas.
  // Previously only the hide half ran, so after leaving spectrum mode once
  // the bars never came back.
  applyModeSurface() {
    if (this.currentMode === 'spectrum') {
      this.showSpectrumBars();
      this.hideP5Canvas();
    } else {
      this.hideSpectrumBars();
      this.showP5Canvas();
    }
  }

  hideSpectrumBars() {
    const spectrumContainer = document.getElementById('spectrum-visualizer');
    if (spectrumContainer) {
      spectrumContainer.style.display = 'none';
    }
  }

  showSpectrumBars() {
    const spectrumContainer = document.getElementById('spectrum-visualizer');
    if (spectrumContainer) {
      spectrumContainer.style.display = 'flex';
    }
  }

  hideP5Canvas() {
    const p5Container = document.getElementById('p5-canvas');
    if (p5Container) {
      p5Container.style.display = 'none';
    }
  }

  showP5Canvas() {
    const p5Container = document.getElementById('p5-canvas');
    if (p5Container) {
      p5Container.style.display = 'block';
    }
  }

  destroy() {
    Object.keys(this.layers).forEach(layerName => this.clearLayerMedia(layerName));
    if (this.p5Instance) {
      this.p5Instance.remove();
    }
  }
}

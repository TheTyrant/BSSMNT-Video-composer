// Voice Over (v2.1, D-38–D-41): record or import one voice track.
//
// Its own <audio> element and its own AudioContext:
//   element → normGain → volumeGain → speakers
// It is never connected to the analyser, the music bus or ClipEngine, so
// narration can't move BPM, bands or cuts, and nothing in the clip timing
// system can retime the voice (the brief's "critical separation").
//
// The voice follows the master timeline: voiceTime = masterTime − offset.
// A small rAF loop plays/pauses it with the transport and nudges it back
// if it drifts more than ~50 ms (seek, pause, stop all follow).
class VoiceTrack {
  constructor(app) {
    this.app = app;
    this.ctx = null;
    this.audio = null;
    this.url = null;
    this.name = '';
    this.offset = 0;          // master-timeline seconds where the voice starts
    this.duration = 0;
    this.volume = 1;          // 0–1.5
    this.normalize = false;
    this.stats = null;        // { loud, peak } linear, from analyze()
    this.peaks = null;        // Float32Array min/max pairs for the voice lane
    this.recorder = null;
    this.recording = false;
    this.recordStart = 0;
    this.takeBlob = null;     // last recorded take (not imported files)
    this.takeSaved = true;    // false until a take has been downloaded
    this.listeners = new Set();
    this.DRIFT = 0.05;
  }

  get isLoaded() { return !!this.audio; }
  on(fn) { this.listeners.add(fn); }
  emit(type) { this.listeners.forEach(fn => fn(type)); }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.normGain = this.ctx.createGain();
      this.volumeGain = this.ctx.createGain();
      this.normGain.connect(this.volumeGain);
      this.volumeGain.connect(this.ctx.destination);
      this.loop();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // ---- load / unload ---------------------------------------------------

  async load(blob, { offset = 0, name = 'Voice', isTake = false } = {}) {
    this.ensureContext();
    this.unload();
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    audio.src = url;
    audio.preload = 'auto';
    await new Promise((resolve, reject) => {
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', () => reject(new Error('This browser can’t decode that audio file.')), { once: true });
    });

    // Decode once for duration (recorded WebM reports Infinity), the
    // loudness stats behind Normalize, and the lane waveform.
    const buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    this.duration = buffer.duration;
    this.stats = VoiceTrack.analyze(buffer);
    this.peaks = VoiceTrack.peaksOf(buffer, 1600);

    const src = this.ctx.createMediaElementSource(audio);
    src.connect(this.normGain);
    this.src = src;
    this.audio = audio;
    this.url = url;
    this.name = name;
    this.offset = Math.max(0, offset);
    if (isTake) { this.takeBlob = blob; this.takeSaved = false; } else { this.takeBlob = null; this.takeSaved = true; }
    this.applyGains();
    this.emit('load');
  }

  unload() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      if (this.src) this.src.disconnect();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio = this.url = this.src = null;
    this.peaks = this.stats = null;
    this.duration = 0;
    this.emit('unload');
  }

  // A recorded take that was never downloaded would be lost (D-39, Q14).
  confirmReplace() {
    if (this.takeBlob && !this.takeSaved) {
      return window.confirm('Replace the current recorded take? It hasn’t been downloaded and will be lost.');
    }
    return true;
  }

  async importFile(file) {
    if (!this.confirmReplace()) return;
    await this.load(file, { offset: 0, name: file.name.replace(/\.[^.]+$/, '') });
  }

  // ---- recording -------------------------------------------------------

  async listMics() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  async startRecording(deviceId) {
    if (this.recording) return;
    if (!this.confirmReplace()) return;
    this.ensureContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true },
    });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    this.recordDone = new Promise(resolve => {
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
    });
    // The take is placed where the playhead was when Record was pressed (Q13).
    this.recordStart = this.app.masterTime();
    rec.start(250);
    this.recorder = rec;
    this.recording = true;
    this.emit('record');
  }

  async stopRecording() {
    if (!this.recording) return;
    this.recorder.stop();
    this.recording = false;
    const blob = await this.recordDone;
    this.recorder = null;
    this.emit('record');
    await this.load(blob, { offset: this.recordStart, name: 'Recorded take', isTake: true });
  }

  recordElapsed() {
    return this.recording ? Math.max(0, this.app.masterTime() - this.recordStart) : 0;
  }

  downloadTake() {
    if (!this.takeBlob) return;
    const ext = /mp4/.test(this.takeBlob.type) ? 'm4a' : 'webm';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(this.takeBlob);
    a.download = `voice-take.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.takeSaved = true;
  }

  // ---- level -----------------------------------------------------------

  setVolume(v) { this.volume = v; this.applyGains(); }
  setNormalize(on) { this.normalize = on; this.applyGains(); }
  setOffset(s) { this.offset = Math.max(0, s); this.emit('load'); }

  applyGains() {
    if (!this.ctx) return;
    this.normGain.gain.value = this.normalize && this.stats ? VoiceTrack.normGainFor(this.stats) : 1;
    this.volumeGain.gain.value = this.volume;
  }

  // Speech loudness = RMS over 50 ms windows, skipping near-silent ones
  // (below −50 dBFS), plus the sample peak.
  static analyze(buffer) {
    const data = buffer.getChannelData(0);
    const win = Math.max(1, Math.floor(buffer.sampleRate * 0.05));
    const gate = Math.pow(10, -50 / 20);
    let sum = 0, n = 0, peak = 0;
    for (let i = 0; i < data.length; i += win) {
      let s = 0;
      const end = Math.min(data.length, i + win);
      for (let j = i; j < end; j++) {
        const v = data[j];
        s += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(s / (end - i));
      if (rms > gate) { sum += rms * rms; n++; }
    }
    return { loud: n ? Math.sqrt(sum / n) : 0, peak };
  }

  // Gain that brings speech to about −16 dBFS RMS (≈ −16 LUFS for voice),
  // capped so the peak stays at or below −1 dBFS. Non-destructive (D-40).
  static normGainFor({ loud, peak }) {
    if (!loud || !peak) return 1;
    const target = Math.pow(10, -16 / 20);
    const ceiling = Math.pow(10, -1 / 20);
    return Math.min(target / loud, ceiling / peak);
  }

  static peaksOf(buffer, buckets) {
    const data = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / buckets));
    const out = new Float32Array(buckets * 2);
    for (let i = 0; i < buckets; i++) {
      let mn = 0, mx = 0;
      const end = Math.min(data.length, (i + 1) * size);
      for (let j = i * size; j < end; j++) {
        if (data[j] < mn) mn = data[j];
        if (data[j] > mx) mx = data[j];
      }
      out[i * 2] = mn;
      out[i * 2 + 1] = mx;
    }
    return out;
  }

  // ---- follow the master timeline -------------------------------------

  syncTo(masterTime, rolling) {
    const a = this.audio;
    if (!a) return;
    const vt = masterTime - this.offset;
    const inside = vt >= 0 && vt < this.duration;
    const now = performance.now();
    if (rolling && inside) {
      if (a.paused) {
        a.currentTime = vt;
        a.play().catch(() => {});
        this.grace = now + 400;   // let playback start before judging drift
      } else if (now > (this.grace || 0) && Math.abs(a.currentTime - vt) > this.DRIFT) {
        a.currentTime = vt;
        this.nudges = (this.nudges || 0) + 1;
        this.grace = now + 400;
      }
    } else if (!a.paused) {
      a.pause();
    }
  }

  loop() {
    requestAnimationFrame(() => this.loop());
    this.syncTo(this.app.masterTime(), this.app.timelineRolling());
  }
}

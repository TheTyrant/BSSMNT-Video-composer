// Plays an uploaded audio file through the existing AudioProcessor analysis
// loop WITHOUT modifying audioProcessor.js. It builds the same graph the mic
// path builds (source -> analyser, identical analyser settings), assigns the
// nodes onto the processor instance, and starts processor.updateAudioData().
// From there bandEnergy() / detectBeat() / onDataUpdate run exactly as they
// do for live input, so band levels and BPM are computed by the same code.
class TrackSource {
  constructor(audioProcessor) {
    this.processor = audioProcessor;
    this.audio = null;      // HTMLAudioElement for the loaded track
    this.url = null;
    this.file = null;
    this.musicGain = null;  // created per load (the AudioContext is recreated each time)
    this.musicLevel = 1;    // last level asked for; survives reloads
  }

  get isLoaded() { return !!this.audio; }
  get isPlaying() { return !!this.audio && !this.audio.paused && !this.audio.ended; }
  get currentTime() { return this.audio ? this.audio.currentTime : 0; }
  get duration() { return this.audio && isFinite(this.audio.duration) ? this.audio.duration : 0; }

  async load(file) {
    this.unload();
    const p = this.processor;

    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.src = url;
    audio.preload = 'auto';
    await new Promise((resolve, reject) => {
      audio.addEventListener('loadedmetadata', resolve, { once: true });
      audio.addEventListener('error', () => reject(new Error('Failed to load audio file. It may be an unsupported format.')), { once: true });
    });

    p.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (p.audioContext.state === 'suspended') await p.audioContext.resume();

    p.sourceNode = p.audioContext.createMediaElementSource(audio);

    // Must mirror AudioProcessor.startAudio()'s analyser config exactly so
    // band levels / BPM behave the same as with live input.
    p.analyserNode = p.audioContext.createAnalyser();
    p.analyserNode.fftSize = 1024;
    p.analyserNode.smoothingTimeConstant = 0.3;
    p.analyserNode.minDecibels = -90;
    p.analyserNode.maxDecibels = -10;

    p.sourceNode.connect(p.analyserNode);
    // Unlike mic input, route to the speakers -- the track should be heard.
    // Music bus (v2.1, D-36): mute and story fades act on this gain, which
    // sits AFTER the analyser, so BPM / bands / cuts always see the
    // full-level track.
    //
    // v2.2 (D-51): what you hear goes source → dryGain → musicGain →
    // speakers, separate from the analysis path (source → analyser). An
    // AnalyserNode doesn't need an output to work (the mic path never had
    // one). That split lets the Dynamic EQ shape only what the analysis
    // hears; with the EQ flat both paths carry the identical signal.
    this.musicGain = p.audioContext.createGain();
    this.musicGain.gain.value = this.musicLevel;
    this.dryGain = p.audioContext.createGain();
    p.sourceNode.connect(this.dryGain);
    this.dryGain.connect(this.musicGain);
    this.musicGain.connect(p.audioContext.destination);

    p.dataArray = new Uint8Array(p.analyserNode.frequencyBinCount);
    p.timeDataArray = new Uint8Array(p.analyserNode.fftSize);
    p.rms = p.bass = p.mid = p.high = 0;

    p.isRunning = true;
    p.updateAudioData();

    this.audio = audio;
    this.url = url;
    this.file = file;
    return audio;
  }

  // Music level 0..1 on the bus after the analyser. rampSec > 0 glides
  // there (setTargetAtTime), otherwise it's set immediately.
  setMusicLevel(v, rampSec = 0) {
    this.musicLevel = v;
    if (!this.musicGain) return;
    const ctx = this.processor.audioContext;
    const g = this.musicGain.gain;
    if (!ctx || rampSec <= 0) { g.value = v; return; }
    g.cancelScheduledValues(ctx.currentTime);
    g.setTargetAtTime(v, ctx.currentTime, rampSec / 3);
  }

  play() { return this.audio ? this.audio.play() : Promise.resolve(); }
  pause() { if (this.audio) this.audio.pause(); }
  seek(seconds) {
    if (!this.audio) return;
    this.audio.currentTime = Math.max(0, Math.min(this.duration, seconds));
  }

  // Tears down playback. processor.stop() closes the AudioContext and resets
  // the analysis state; it doesn't know about the <audio> element, so that
  // part is cleaned up here.
  unload() {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio = null;
      this.processor.stop();
    }
    this.musicGain = null;
    this.dryGain = null;
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.file = null;
  }
}

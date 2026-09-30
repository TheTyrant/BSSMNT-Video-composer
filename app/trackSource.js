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
    p.analyserNode.connect(p.audioContext.destination);

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
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.file = null;
  }
}

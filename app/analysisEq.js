// Dynamic EQ (v2.2, D-51): an ANALYSIS EQ.
//
// It shapes what the beat and band analysis hears (BPM, bass/mid/high,
// band-driven cuts and visuals), so cuts can lock to a chosen part of the
// mix (e.g. the kick). It never changes what you hear or what gets
// exported, except while "Listen" is on, which routes the EQ'd signal to
// the speakers instead of the dry music so you can hear what you're doing.
//
// Graph (built outside the frozen AudioProcessor, using its nodes):
//   source ─► [filters…] ─► analyser          (analysis path)
//          └► dryGain ─► musicGain ─► out     (what you hear, track mode)
//   Listen: last filter ─► listenGain ─► musicGain, dryGain = 0
// When the EQ is off (Use = Sensitivity) or flat, the filters are removed
// and source connects straight to the analyser, exactly as before.
class AnalysisEQ {
  constructor() {
    this.bands = AnalysisEQ.flatBands();
    this.enabled = false;   // Use = Dynamic or Blend
    this.listen = false;
    this.graph = null;      // { ctx, source, analyser, dry, monitor }
    this.nodes = new Map(); // band id -> BiquadFilterNode (live chain)
    this.listenGain = null;
    this.chainKey = '';
    this.listeners = new Set();
    // A silent context just to ask filters for their frequency response.
    this.respCtx = new OfflineAudioContext(1, 128, 48000);
    this.respFilters = new Map();
  }

  static flatBands() {
    return [
      { id: 'lowcut', label: 'Low cut', type: 'highpass', freq: 30, gain: 0, q: 0.71, on: false },
      { id: 'low', label: 'Low', type: 'peaking', freq: 90, gain: 0, q: 1 },
      { id: 'mid', label: 'Mid', type: 'peaking', freq: 900, gain: 0, q: 1 },
      { id: 'high', label: 'High', type: 'peaking', freq: 6000, gain: 0, q: 1 },
      { id: 'highcut', label: 'High cut', type: 'lowpass', freq: 16000, gain: 0, q: 0.71, on: false },
    ];
  }

  // Presets keep enough low end for the frozen beat detector, which
  // averages "bass" over roughly 0–2.9 kHz and needs it to jump on hits.
  // Measured on a real 97 BPM track: a hard low-pass at 160 Hz stopped BPM
  // locking entirely, so no preset removes whole regions (D-51).
  static PRESETS = {
    flat: { label: 'Flat', set: {} },
    kick: { label: 'Kick emphasis', set: { low: { freq: 60, gain: 9, q: 1.2 }, mid: { freq: 1200, gain: -8, q: 0.4 } } },
    snare: { label: 'Snare / clap', set: { mid: { freq: 3000, gain: 6, q: 0.8 } } },
    hats: { label: 'Hi-hats / presence', set: { high: { freq: 9000, gain: 8, q: 0.7 } } },
  };

  on(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach(fn => fn()); }

  band(id) { return this.bands.find(b => b.id === id); }
  isCut(b) { return b.type !== 'peaking'; }
  isActiveBand(b) { return this.isCut(b) ? b.on : b.gain !== 0; }
  get isFlat() { return !this.bands.some(b => this.isActiveBand(b)); }
  get active() { return this.enabled && !this.isFlat; }

  applyPreset(key) {
    this.bands = AnalysisEQ.flatBands();
    const p = AnalysisEQ.PRESETS[key];
    if (p) Object.entries(p.set).forEach(([id, v]) => Object.assign(this.band(id), v));
    this.changed();
  }

  setBand(id, values) {
    Object.assign(this.band(id), values);
    this.changed();
  }

  setEnabled(on) { this.enabled = on; this.changed(); }
  setListen(on) { this.listen = on; this.changed(); }

  // ---- graph -------------------------------------------------------------

  attach(graph) {
    this.detach();
    this.graph = graph;
    this.chainKey = '';
    this.sync();
  }

  detach() {
    if (this.graph) this.teardown();
    this.graph = null;
  }

  teardown() {
    this.nodes.forEach(n => { try { n.disconnect(); } catch (e) { /* already gone */ } });
    this.nodes.clear();
    if (this.listenGain) { try { this.listenGain.disconnect(); } catch (e) { /* gone */ } this.listenGain = null; }
  }

  changed() {
    this.sync();
    this.emit();
  }

  // Rebuild the chain only when its shape changes (which bands are in it,
  // or Listen); otherwise just move the filters' values, so dragging a
  // point doesn't click or drop audio.
  sync() {
    const g = this.graph;
    if (!g || !g.ctx || g.ctx.state === 'closed') return;
    const live = this.active ? this.bands.filter(b => this.isActiveBand(b)) : [];
    const key = live.map(b => b.id).join(',') + (this.listen && live.length && g.monitor ? '|L' : '');
    if (key === this.chainKey) {
      live.forEach(b => this.setParams(this.nodes.get(b.id), b, g.ctx.currentTime));
      return;
    }
    this.chainKey = key;
    this.teardown();
    try { g.source.disconnect(g.analyser); } catch (e) { /* wasn't connected */ }
    if (!live.length) {
      g.source.connect(g.analyser);
      if (g.dry) g.dry.gain.value = 1;
      return;
    }
    let prev = g.source;
    live.forEach(b => {
      const f = g.ctx.createBiquadFilter();
      f.type = b.type;
      this.setParams(f, b);
      prev.connect(f);
      prev = f;
      this.nodes.set(b.id, f);
    });
    prev.connect(g.analyser);
    if (this.listen && g.monitor && g.dry) {
      this.listenGain = g.ctx.createGain();
      prev.connect(this.listenGain);
      this.listenGain.connect(g.monitor);
      g.dry.gain.value = 0;
    } else if (g.dry) {
      g.dry.gain.value = 1;
    }
  }

  setParams(f, b, t) {
    if (!f) return;
    if (t != null) {
      f.frequency.setTargetAtTime(b.freq, t, 0.01);
      f.Q.setTargetAtTime(b.q, t, 0.01);
      f.gain.setTargetAtTime(b.gain, t, 0.01);
    } else {
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = b.gain;
    }
  }

  // Combined response in dB at the given frequencies (for drawing).
  response(freqs) {
    const out = new Float32Array(freqs.length);
    const mag = new Float32Array(freqs.length);
    const phase = new Float32Array(freqs.length);
    this.bands.filter(b => this.isActiveBand(b)).forEach(b => {
      let f = this.respFilters.get(b.id);
      if (!f) { f = this.respCtx.createBiquadFilter(); this.respFilters.set(b.id, f); }
      f.type = b.type;
      f.frequency.value = b.freq;
      f.Q.value = b.q;
      f.gain.value = b.gain;
      f.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < freqs.length; i++) out[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
    });
    return out;
  }

  describe() {
    if (this.isFlat) return 'Flat';
    return this.bands.filter(b => this.isActiveBand(b)).map(b => {
      const hz = b.freq >= 1000 ? `${(b.freq / 1000).toFixed(b.freq >= 10000 ? 0 : 1)}k` : `${Math.round(b.freq)}`;
      return this.isCut(b) ? `${b.label} ${hz}` : `${b.label} ${hz} ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)}dB`;
    }).join(' · ');
  }
}

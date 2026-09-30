// Musical timing math for the clip auto-editor.
//
// Everything is expressed in BEATS (quarter notes) and only converted to
// milliseconds at the last moment using the live BPM, so switch timing stays
// locked to the music's structure regardless of tempo.
//
// TIME SIGNATURE: this pass supports 4/4 only. That assumption lives in
// TIME_SIGNATURE below and the two helpers that read it -- nothing else in
// the codebase should hard-code "4 beats". A future signature-aware version
// only needs to make TIME_SIGNATURE configurable.
const MusicalTime = (() => {
  const TIME_SIGNATURE = { beatsPerBar: 4, noteValue: 4 };

  function beatsPerBar() { return TIME_SIGNATURE.beatsPerBar; }
  // In 4/4 a measure and a bar are the same length. Kept as its own function
  // so "measure" can diverge (e.g. phrase-length measures) without touching
  // callers.
  function beatsPerMeasure() { return TIME_SIGNATURE.beatsPerBar; }

  // Units a switch interval can be expressed in. `beats` may be a function so
  // bar/measure lengths always come from the time-signature helpers.
  const UNITS = {
    sixteenth: { label: '1/16', long: '16th note', beats: () => 0.25 },
    eighth:    { label: '1/8',  long: '8th note',  beats: () => 0.5 },
    beat:      { label: 'Beat', long: 'beat',      beats: () => 1 },
    half:      { label: '1/2',  long: 'half note', beats: () => 2 },
    bar:       { label: 'Bar',  long: 'bar',       beats: beatsPerBar },
    measure:   { label: 'Meas', long: 'measure',   beats: beatsPerMeasure },
  };

  function unitBeats(unit) {
    const u = UNITS[unit];
    if (!u) throw new Error(`Unknown musical unit: ${unit}`);
    return u.beats();
  }

  // "every 2 bars" -> 8 beats (in 4/4)
  function toBeats(count, unit) { return count * unitBeats(unit); }

  function beatMs(bpm) { return bpm > 0 ? 60000 / bpm : 0; }
  function beatsToMs(beats, bpm) { return beats * beatMs(bpm); }

  // Tempo multipliers for auto mode, named the way the brief names them:
  // single time = switch every beat, double = every 2 beats, and so on.
  const MULTIPLIERS = [
    { beats: 1,  label: 'Single time' },
    { beats: 2,  label: 'Double time' },
    { beats: 3,  label: 'Triple time' },
    { beats: 4,  label: 'Quad time' },
    { beats: 8,  label: 'Two bars' },
    { beats: 16, label: 'Four bars' },
  ];

  // Target minimum seconds between cuts for each auto "pace".
  const AUTO_PACES = {
    frantic: { label: 'Frantic', minSeconds: 0.35 },
    driving: { label: 'Driving', minSeconds: 0.9 },
    relaxed: { label: 'Relaxed', minSeconds: 1.8 },
    phrase:  { label: 'Phrase',  minSeconds: 3.6 },
  };

  // Auto-detect: the shortest multiplier whose real-time length reaches the
  // pace's minimum. Fast tempos land on double/triple time, slow tempos on
  // single time -- so the cut rate feels similar across genres.
  function autoMultiplier(bpm, pace = 'driving') {
    const minSeconds = (AUTO_PACES[pace] || AUTO_PACES.driving).minSeconds;
    const beatSec = bpm > 0 ? 60 / bpm : 0.5;
    return MULTIPLIERS.find(m => m.beats * beatSec >= minSeconds) || MULTIPLIERS[MULTIPLIERS.length - 1];
  }

  // Human label for an interval in beats, e.g. 8 -> "2 bars", 0.5 -> "1/8".
  function describeBeats(beats) {
    const bpb = beatsPerBar();
    if (beats >= bpb && beats % bpb === 0) {
      const bars = beats / bpb;
      return `${bars} bar${bars === 1 ? '' : 's'}`;
    }
    if (beats >= 1 && Number.isInteger(beats)) return `${beats} beat${beats === 1 ? '' : 's'}`;
    if (beats === 0.5) return '1/8 note';
    if (beats === 0.25) return '1/16 note';
    return `${beats} beats`;
  }

  // Bar.Beat position (1-based, like a DAW transport) from a beat index.
  function barBeat(beatIndex) {
    const bpb = beatsPerBar();
    const i = Math.max(0, Math.floor(beatIndex));
    return { bar: Math.floor(i / bpb) + 1, beat: (i % bpb) + 1 };
  }

  return {
    TIME_SIGNATURE, UNITS, MULTIPLIERS, AUTO_PACES,
    beatsPerBar, beatsPerMeasure, unitBeats, toBeats,
    beatMs, beatsToMs, autoMultiplier, describeBeats, barBeat,
  };
})();

if (typeof module !== 'undefined') module.exports = MusicalTime;

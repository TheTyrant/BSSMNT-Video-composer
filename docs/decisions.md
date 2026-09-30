# Decisions — porting v1 (`main`) → v2

Written retroactively after the v2 build (2026-09-30). Each entry records what was decided while porting from `main` to the `v2` branch, and why. File/function references are in [codemap.md](codemap.md); where this leads is in [roadmap.md](roadmap.md).

Format: **Context → Decision → Why → Consequences**. Status: *Accepted* unless noted.

---

## A. Branch, baseline and hard constraints

### D-01 · Build v2 on a fresh branch off `origin/main`
- **Context:** A local clone already existed, parked on an unpushed branch (`claude/media-layers-refactor-vcy0b6`, two commits ahead of `main`).
- **Decision:** Fetched, confirmed `main` == `origin/main` (`2276461`), created `v2` from `origin/main`, and **unset its upstream**.
- **Why:** The brief required branching off current `main` without building on a stale copy. Unsetting the upstream stops a bare `git push` from ever targeting `main`.
- **Consequences:** `main` is untouched. `v2` is pushed as its own branch.

### D-02 · `audioProcessor.js` is frozen, verified by hash
- **Context:** Hard constraint: live input, band levels and BPM must behave identically to `main`.
- **Decision:** No edits to `audioProcessor.js`. Before commit it was verified byte-identical to `main` (git blob `11f893b`).
- **Why:** Non-negotiable requirement carried over from earlier work; it is the performance-proven part of the app.
- **Consequences:** Every new audio need (track playback, waveform, future song analysis) must live **outside** this file. See D-04 and the roadmap's offline analysis module.

## B. Media Layers

### D-03 · Carry Media Layers into v2 from the unpushed branch
- **Context:** The brief listed Media Layers (background/bass/mid/high, justify/stack/rattle) as a core feature to preserve. Checking the repo showed it was **not on `main`**; it existed only on the local branch. `docs/media-layers-notes.md` did not exist anywhere.
- **Decision:** Cherry-picked `a1ff757` (Media Layers core, which doesn't touch audio) as-is. Brought in `f5252d8` (file playback, drag-drop, auto-justify on toggle, pop-out window) **without its `audioProcessor.js` changes**.
- **Why:** Preserves the feature the brief treats as core while respecting D-02.
- **Consequences:** v2 contains Media Layers; its history is kept via `cherry-pick -x`.

### D-04 · Track-file playback moved into `trackSource.js`
- **Context:** `f5252d8` added `startAudioFromFile()` *inside* `audioProcessor.js`.
- **Decision:** New `TrackSource` class builds the same graph (media element → analyser → speakers), assigns the nodes onto the processor instance, and calls the processor's own `updateAudioData()`.
- **Why:** `bandEnergy()` and `detectBeat()` run unchanged, so track mode analyses exactly like mic mode, with zero edits to the frozen file.
- **Consequences:** The analyser settings (fft 1024, smoothing 0.3, −90/−10 dB) are **duplicated** in `trackSource.js` and must be kept in sync by hand. Documented in the code and codemap.

### D-05 · Layer uploads no longer force-switch out of clip mode
- **Context:** `loadLayerMedia()` jumps the visual mode to `layers` on upload.
- **Decision:** Skip that jump when the current mode is `clips`.
- **Why:** Clip mode can overlay Media Layers (D-16), so uploading a layer shouldn't kick the user out of the editor.

## C. Clip auto-editor: timing

### D-06 · Reuse the visualizer's beat clock; no second detector
- **Context:** The brief said to consume `audioData.bpm` and the existing beat signals, not re-derive beat timing.
- **Decision:** `ClipEngine` advances one beat each time `DJVisualizer.lastBeatTime` changes, and interpolates sub-beat position from `bpmInterval`.
- **Why:** One source of truth, so clip cuts, beat flash and pulse all stay in lockstep.
- **Consequences:** That clock is a **BPM metronome** (it ticks at `60000/bpm` once BPM is known), not detected onsets, so its phase may not sit exactly on the kick. BPM takes several beats to lock at song start, and nothing cuts until then ("Listening for tempo…"). Better phase alignment for tracks is planned as offline analysis (roadmap Phase 1).

### D-07 · Timing expressed in beats; 4/4 isolated in one constant
- **Decision:** All intervals are stored as beats and converted to ms only at the last moment using live BPM. Units: 1/16, 1/8, beat, 1/2, bar, measure. `MusicalTime.TIME_SIGNATURE = { beatsPerBar: 4 }` is the only place 4/4 appears; `beatsPerBar()` and `beatsPerMeasure()` read it.
- **Why:** Keeps cuts locked to musical structure at any tempo (brief: "fours and fractions"), and lets a future time-signature version change one constant instead of hunting for literal `4`s.
- **Consequences:** Bar and measure are the same length in this pass (brief: 4/4 only). They are kept as separate units so "measure" can later diverge (e.g. phrase-length).

### D-08 · Auto timing = shortest tempo multiplier that meets a pace
- **Decision:** Multipliers are named as in the brief (single time = every beat, double = every 2 beats, triple = every 3, quad = 4, then 8 and 16). Auto picks the **shortest multiplier whose real duration ≥ the pace's minimum** (Frantic 0.35 s, Driving 0.9 s default, Relaxed 1.8 s, Phrase 3.6 s).
- **Why:** Makes the cut rate *feel* similar across tempos: 120 BPM → double time (1.0 s), 174 BPM → triple, 60 BPM → single.
- **Consequences:** Triple time drifts against 4/4 bars. It was kept because the brief asks for it explicitly. A user can always override manually, and the ×1–×4 quick buttons set manual mode.

### D-09 · Interval changes re-sync without an extra cut
- **Context:** Testing showed that changing the interval mid-song fired an immediate cut, because the slot index jumps.
- **Decision:** When the interval changes, adopt the new slot silently; the next boundary cuts as normal.
- **Why:** Tweaking settings live shouldn't produce stray cuts.

### D-10 · Pre-roll the next clip up to one beat early
- **Decision:** Choose, seek and play the next clip at `min(1 beat, interval/2)` before the cut.
- **Why:** Video seeks are asynchronous; pre-rolling means the incoming frame is decoded when the cut lands.
- **Consequences:** In "by band" order, the band is sampled up to a beat before the cut rather than exactly at it. That is acceptable for musical phrasing.

## D. Clip auto-editor: selection and transitions

### D-11 · Dominant band = each band relative to its own recent level
- **Context:** Raw bass/mid/high values are not comparable (bass reads much hotter).
- **Decision:** For each band, compute value ÷ (slow running average of that band); the highest ratio wins, with ~8 % hysteresis.
- **Why:** Detects which band is *currently excited*, rather than which is loudest in absolute terms (bass would nearly always win).
- **Consequences:** The app's High band is roughly >10.8 kHz (top 55 % of FFT bins), so hi-hats around 7–10 kHz count as Mid. This was found through the test track, whose hats were moved above 12 kHz. The band split itself is untouched (D-02).

### D-12 · Transitions as a registry with beat-based lengths
- **Decision:** `ClipTransitions.register(id, {label, glyph, lengthBeats, render})`. Shipped: jump (0 beats), crossfade (1), blur (0.5). Blend length = `lengthBeats` at live BPM, capped at 0.9 × interval.
- **Why:** The brief asked for an extensible set, not inline code. Beat-based lengths keep blends musical at any tempo, and the cap stops a blend from outlasting its clip.
- **Consequences:** Blur is faked with offset low-alpha copies (cheap, no shader), which is good enough for live use. A true shader blur is planned with the compositor upgrade (roadmap Phase 3).

## E. Open questions from the brief: how they were handled

The brief's four questions were not answered before the build. Rather than guess one answer, **every option was built with a default**, so the decision is a setting, not a rewrite. *Status: provisional, pending Omar's confirmation.*

| # | Question | What v2 does | Default |
|---|---|---|---|
| Q1 | Live/unbounded vs. bounded track timeline | Both, as distinct modes. **Track:** timeline = file length, click/drag seek, zoom. **Live:** unbounded session clock, rolling 30 s view, LIVE badge | Follows the audio source toggle |
| Q2 | Transitions auto by band vs. user-selected | Both: "Auto (by triggering band)" with an editable band → transition map, or one fixed transition | Auto: bass → jump, mid → crossfade, high → blur |
| Q3 | Export/render vs. live playback | **Live playback only** in v2. Export deferred to roadmap Phase 3 | Live |
| Q4 | Clip selection order | Sequential, Random, or By dominant band (clips tagged any/bass/mid/high; empty pool falls back to "any", then all) | Sequential; in-point Random |

## F. Timeline behaviour

### D-13 · The clip timeline is recorded as it plays
- **Decision:** Each cut appends a segment `{clipId, start, end, inPoint, transition, band, beat, blendSec}` against the master clock. Seeking back in track mode **discards** everything after the playhead and regenerates it live.
- **Why:** Matches the brief's live auto-edit concept and needs no planning model yet.
- **Consequences:** A given edit can't be replayed or edited. This is the main thing roadmap Phase 1 changes: a placement plan becomes the source of truth and the engine becomes its player.

### D-14 · Waveform decoded separately from playback
- **Decision:** `loadTrackWaveform()` decodes the file with an `OfflineAudioContext` purely for drawing.
- **Why:** Gives a DAW-style overview without involving the frozen processor.
- **Consequences:** Establishes the pattern for future offline song analysis.

### D-15 · Timeline drawn on a single 2D canvas
- **Decision:** Ruler, master lane and clip lane are one canvas redrawn at about 30 fps. Channel headers, bin and properties are DOM.
- **Why:** Hundreds of segments and beat lines are cheap on canvas and expensive as DOM nodes. It also keeps redraw decoupled from the 60 fps visual loop.
- **Consequences:** Row heights are duplicated in `TimelinePanel.ROWS` and CSS (`.ch-*`) and must match.

### D-16 · Clip editor is a visual mode; Media Layers can overlay it
- **Decision:** Added mode `clips` ("Clip Auto-Editor") to the existing mode list. An option draws the bass/mid/high layers on top (via the extracted `drawReactiveLayers()`). The engine only advances while in `clips` mode and the timeline is rolling.
- **Why:** Reuses the existing mode system instead of a parallel renderer, keeps all existing modes intact, and avoids decoding video when it isn't shown.

## G. UI redesign

### D-17 · Light brutalist palette; viewport stays black
- **Decision:** Ivory `#EDEAE4` base, sidebar a half-step darker `#E3DFD7`, faded steel `#D7DADC` for lanes and secondary panels, near-black `#1A1A1A` ink with hard 1–2 px rules, square corners, uppercase mono labels, numbered sections. Band colours (red/green/blue) and live red stay as small functional accents. **The canvas viewport stays black.**
- **Why:** The brief called for a tonal shift toward Blender 4-style clean surfaces with brutalist structure. The viewport stays black because every visual mode was designed on black, and a light canvas would wash them out.

### D-18 · Keep existing element IDs and groupings; restyle, don't rewire
- **Decision:** All IDs used by `app.js` / `visualizer.js` are preserved. Sidebar groupings stay (Audio, Visualization, EQ, Status, Media Layers, Output).
- **Why:** The brief said grouping stays unless the new work requires a change, and stable IDs keep the original logic working.
- **Two deliberate structural changes:**
  1. **EQ Sensitivity + EQ Levels were merged into one "EQ" mixer** of three channel strips (meter over fader), following the DAW channel-strip convention the brief references. Slider ranges and behaviour are unchanged.
  2. **The sidebar Timeline scrubber (from `f5252d8`) was replaced** by the bottom panel's master timeline, because the brief puts the timeline there.

### D-19 · Bottom editor modelled on Blender's Timeline + Action Editor
- **Decision:**
  - Transport bar (home / play-pause / stop, LCD readouts for time, bar.beat, BPM and dominant band, LIVE/TRACK badge).
  - Master timeline above: ruler, waveform, band energy, beat/bar grid.
  - Clip lane below: blocks with thumbnails, a band stripe and transition marks, plus dashed markers for upcoming cuts.
  - Clip bin row, and an Auto-Editor properties column (Blender "N-panel" style).
  - Draggable splitter.
- **Why:** Direct mapping of the brief's layout request.

### D-20 · Small behaviour fixes made during the restyle
- **Start button:** inline `style.backgroundColor = '#ff4444'` was replaced with an `.is-live` class so the palette controls it.
- **Keyboard shortcuts** now ignore focused buttons and selects as well as inputs, so Space doesn't double-toggle.
- **Track mode without a file:** Start now opens the file picker. Before, it silently fell back to the microphone.
- **BPM status:** reads just the number, since the row is already labelled.

### D-21 · Canvas resizes with the panel, not just the window
- **Decision:** A `ResizeObserver` on the viewport calls the p5 resize.
- **Why:** Dragging the editor splitter changes the viewport size without a window resize event.

### D-22 · Fonts and logo
- **Decision:**
  - UI in Inter Tight, labels and numbers in JetBrains Mono (Google Fonts, system fallbacks).
  - The logo `.brand-mark` uses **Boldonse** via a `--font-logo` token, reading "BSS" over "MNT", stacked with `line-height: 0.95`.
  - "Another Tag" was requested first but is not in the `1238-St-Website` repo (no file or reference in its tree or history), so it wasn't added.
- **Consequences:** Fonts load from Google, so offline shows fallback fonts. Self-hosting is a later option.

## H. Output, deployment, testing

### D-23 · Pop-out window doesn't mirror clip mode (yet)
- **Context:** The pop-out draws by proxying the control window's visualizer. p5 video textures can't cross renderers.
- **Decision:** In `clips` mode the pop-out shows a notice instead of throwing.
- **Why:** Mirroring needs time-synced local copies of every clip, which is real work. The control window's Fullscreen (F) covers projection in the meantime.
- **Status:** Known gap; roadmap Phase 4.

### D-24 · `vercel.json` switched to globs
- **Decision:** `*.html`, `styles/*.css`, `app/*.js` and `test-assets/*.html` replace the explicit file list.
- **Why:** The old list named each JS file, so new modules (and `output.html` from `f5252d8`) would not have deployed.

### D-25 · Test assets generated in-browser, not committed
- **Decision:** `test-assets/generate.html` makes six labelled 640×360 WebM clips (with an on-screen clock so in-points are visible) and a 32-bar, 120 BPM WAV whose sections lean bass → mid → high → all.
- **Why:** No binary blobs in the repo, license-free, reproducible. There was no ffmpeg on the build machine.
- **Consequences:** MediaRecorder WebMs report `duration = Infinity`, which broke random in-points. Fixed generally in `makeThumb()` with a seek-to-end probe, which also protects against real-world files with the same problem.

### D-26 · Verification approach
- **Decision:** Every milestone was verified with rendered screenshots, and end-to-end runs logged every cut (time, clip, transition, band, beat index).
- **Findings:**
  - All three transitions render correctly (mid-blend frames inspected).
  - Cuts land exactly on interval boundaries (beats 0/4/8/12 for one bar, every 2 beats, eighth notes).
  - Band-driven selection varies with the song's sections.
  - Seeking truncates correctly.
- **Note:** Under software-rendered headless testing (~6 fps), the frozen detector read 135–160 BPM on the 120 BPM track. With GPU rendering at 60 fps it converged to 120. BPM accuracy depends on frame rate, which is expected of a requestAnimationFrame-driven detector, and this is not a v2 change.

## I. Known carry-overs (pre-existing on `main`, not changed)
- Placeholder text drawn with `p.text()` in WebGL mode doesn't render, because no font is loaded (affects the Media Layers "Upload images…" prompt). v2 uses a DOM overlay for its own hints.
- `visualizer.js` has duplicate `drawAudioWaves` / `drawMandala` / `drawTunnel` definitions (the later ones win), plus unused snake-game code.
- `app.js` defines `switchVisualizationMode` twice (the string version wins) and has an unused `setupKeyboardShortcuts`.
- `README.md` clone URL still points at `philaconvalley/djVisualizer`.

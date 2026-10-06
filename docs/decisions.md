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

## H2. Changes after first test round (2026-10-01)

### D-27 · Spectrum bars and canvas swap on mode change
- **Context:** After leaving Spectrum mode once, the bars never came back (`showSpectrumBars()` was never called; pre-existing on `main`), and the p5 canvas could stay over them while audio was stopped.
- **Decision:** `DJVisualizer.applyModeSurface()` shows exactly one surface, called on mode change and every frame.

### D-28 · Clips show before tempo locks; undecodable clips are flagged
- **Decision:** The first clip goes on screen as soon as the timeline rolls; beat-locked cutting starts at the first beat once BPM locks. Clips the browser cannot decode get an error state (red card, ERR) and a viewport message, instead of silently never appearing.
- **Why:** In testing, nothing showed until BPM locked, and VS Code's Simple Browser can't decode H.264/AAC, so MP4 clips vanished without explanation.

### D-29 · Space works everywhere except text entry
- **Decision:** Space toggles play/stop unless focus is in a text/number field. Focused buttons, selects, sliders and file pickers no longer swallow it; the focused control is blurred so it isn't also activated.
- **Why:** After any click, focus stayed on a control and Space stopped working, which made the main shortcut unreliable.

### D-30 · Per-clip pace; cuts scheduled from each shot's start
- **Decision:** Each bin clip has a Pace (Global, Frantic, Driving, Relaxed, Phrase). A set pace decides how long that clip holds once it's cut in, overriding the global Auto/Manual timing. Scheduling changed from a shared global grid (`slot = floor(pos / interval)`) to `nextCutPos = cut position + hold`.
- **Why:** With mixed hold lengths, a global grid would cut a long-pace clip short at the next shared boundary. Scheduling from each shot's start keeps every clip's hold exact. With all clips on Global, cuts land exactly where they did before.
- **Consequences:** Mixing paces (especially triple time) can move cuts off bar lines; that is the user's choice. Ghost markers show the next cut exactly and later ones at the global interval, since later clips aren't chosen yet. D-09 (re-sync without an extra cut) still applies: if the on-screen clip's hold changes, the next cut is rescheduled from that shot's start.
- **Status:** Accepted as the v2.1 per-clip timing (D-31): the Pace lexicon stays. In v2.1 the control moves from the bin card into the asset properties panel (D-44).

## K. v2.2 — workspace rework *(Omar, 2026-10-02; in progress)*

### D-48 · Tabs-only sidebars; full-width timeline; Auto-Editor on the right *(Accepted — built)*
- **Decision:** The sidebars no longer run the full height or carry a rail. Each is **just its tabs**, floating at the sidebar's inner edge over the viewport, with no arrow/collapse buttons. Closed, a sidebar takes **zero width**; open, it is one panel wide and only in the viewport row. The **timeline runs the full window width** underneath, so slide-outs never take timeline space.
  - **Left tabs:** 01 Audio · 02 Assets · 03 Output (the 02 EQ tab is gone: the EQ moves into Assets, D-51). Up to **two panels stack**; opening a third closes the **top** one. A second click on a tab closes it.
  - **Right tab:** **AE · Auto-Editor** (moved out of the timeline area), same behaviour, one panel.
  - **All panels start closed** on every load (nothing persisted).
- **Why:** Omar: the sidebar "doesn't need the full tab rail, just the tabs", and the timeline must not be squeezed by slide-outs.
- **As built:** clip HUD and Status overlay moved in 62 px so the floating tabs don't cover them. CSS/JS links carry a `?v=` version so a reload can never mix old and new files (the cause of the "squeezed timeline" seen mid-change).
- **Verified:** closed → sidebars 0 px, viewport and timeline 1600/1600 px; Audio + Auto-Edit open → timeline still 1600 px; third tab closes the top panel; second click closes. Full v2.1 regression (16 checks) passes on this layout.

### D-49 · Mute lives on the tracks *(Accepted — built; export exclusion pending export)*
- **Decision:** The Music block left 01 Audio. **Master** and **Voice** track headers each have an **M** button. A muted track is silent now and will be **left out of exports**. Master mute is disabled in live mode (BSSMNT doesn't play the music there, D-36).
- **Verified:** M on Master → music bus 0 with BPM/bands still reading; M on Voice → voice gain 0, unmute restores.

### D-50 · Header quick pickers *(Accepted — built)*
- **Decision:** The header keeps its original readouts (`SRC LIVE`, `MODE Spectrum Bars`), no borders, with the same **▾ caret** to the right of each value. Clicking opens a dropdown: SRC = Live input / Track file (switching slides out **01 Audio**); MODE = every mode **with its own icon**. The same controls stay in 01 Audio. A **red activity light** next to SRC is on while audio with signal is coming in, with a ring on beats.
- **Verified:** mode menu lists 10 modes with icons and drives `#visualMode`; switching source either way opens 01 Audio; the light follows the live signal.

### D-51 · EQ inside 02 Assets: Sensitivity / Dynamic, with Blend *(Accepted — built)*
- **Decision (Omar):** 02 Assets reads top to bottom **EQ → Assets → Asset timing**. The EQ has two views on a **tab swap** (not stacked): **Sensitivity** (tooltip *Simple*: the existing band faders + meters, same IDs) and **Dynamic** (tooltip *Advanced*: an EQ curve). **Use** radio buttons pick what is applied: *Sensitivity* (default = today), *Dynamic*, or *Blend* (both). The left sidebar shows **one panel at a time** (the stacked "double tray" is removed for now).
- **Dynamic = an analysis EQ:** five points (low cut, low, mid, high, high cut) shape what the beat and band analysis hears. Drag a point to move it, scroll to change its width, double-click to reset; presets and Flat. The sound and exports are untouched; **Listen** (track mode) routes the EQ'd signal to the speakers. The graph shows the live spectrum the analysis sees and where the frozen analyser splits Bass | Mid | High (about 0–2.9 kHz | 2.9–10.8 kHz | above, at 48 kHz).
- **How it's wired (no change to audioProcessor.js):** `TrackSource` now feeds the speakers from the source through a dry gain, separate from the analyser branch; the EQ splices filters between source and analyser (also in live/mic mode). Flat or Use = Sensitivity means no filters at all: the original graph.
- **Finding, measured on CREAM (97 BPM):** a hard low-pass at 160 Hz ("Kick focus" as first built) stopped BPM locking entirely, because the frozen detector averages "bass" over about 0–2.9 kHz and needs that average to jump. Presets were replaced with shapes that keep detection working (Kick emphasis, Snare / clap, Hi-hats / presence); all lock as fast as flat. A warning appears on the graph if an applied EQ starves the detector of low end. **No EQ shape fixed the tempo reading** (flat and every preset read about 105–125 on the 97 BPM song, varying run to run), so Dynamic steers **band reactions and band-driven cuts**, not BPM accuracy; that needs offline song analysis (roadmap Phase 1.2).
- **Verified:** default = no filters, dry sound; Dynamic + a low-pass shape drops the analysis spectrum above the cut to 0 while the sound stays dry; Listen swaps dry for EQ'd and back; Blend applies faders + EQ, Dynamic counts faders as 1.0; dragging a point moves it and switches the preset to Custom. Full regression (16 checks) still passes.
- **Not built (open):** the per-asset dynamic EQ from the earlier layout sketch. The latest instruction names the bottom section "Asset timing", so it was left out pending confirmation.

### D-52 · Keyboard shortcuts *(Accepted — built)*
| Keys | Action |
|---|---|
| **Ctrl+1 / Ctrl+2 / Ctrl+3** | Toggle 01 Audio / 02 Assets / 03 Output |
| **Alt+1 / Alt+2 / Alt+3** | Same (fallback) |
| **Shift+A** | Toggle the Auto-Editor (edit controls) |
| **1–9** | Visualization modes in menu order (Spectrum, Particles, Rings, Waves, Mandala, Tunnel, Galaxy, Polygons, Media Layers) |
| **0** | Clip Auto-Editor |
| Space · F · R · ? · Esc | Unchanged (play/stop, fullscreen, reset gains, help) |

- **Why the Alt fallback:** browsers reserve Ctrl+1–9 for switching browser tabs (and VS Code uses them for editor groups), so a web page often never receives them. Ctrl works where the browser passes it through (e.g. a desktop build); Alt works in a normal tab.
- **As built:** number-pad digits work too. Plain-key shortcuts no longer fire while Ctrl/Alt/Cmd is held, so browser shortcuts like Ctrl+R / Ctrl+F aren't doubled up with app actions. Tab tooltips and the header MODE menu show each key; the help overlay (?) lists them.
- **Verified:** Ctrl+1/2/3 and Alt+2 toggle the right panels (second press closes); Shift+A toggles the Auto-Editor; 5…9, 0, Numpad 3, 1 select the matching modes.

### D-53 · Drag and drop for clips, anywhere it makes sense *(Accepted — built)*
- **Problem (Omar):** dropping clips "stopped working". Only the small drop zone in 02 Assets and the Action Editor row accepted files; a drop anywhere else (the asset list, the options, the timeline) was ignored, and in a normal browser a missed file drop makes the browser **open the file and replace the app**.
- **Decision:** the **whole 02 Assets panel** and the **whole bottom editor** (Clips lane, timeline, Action Editor) accept image and video files, highlighted while files are over them. Card reordering in the Action Editor stays an in-page drag and never adds files. A page-wide guard stops the browser from opening a dropped file anywhere else.
- **Verified with real OS-style file drops (DevTools drag events):** Action Editor, Clips lane, drop zone, asset list and options area each added exactly one asset; a drop on the viewport added nothing and the page stayed; dragging a card still reorders.

### D-54 · Timeline drops that reach the bin; rotated phone video *(Accepted — built)*
**1. Dropping on the Action Editor / timeline didn't add files (Omar, tested in VS Code and a live browser).**
- **Cause found in the code:** file drops on the bottom editor were ignored whenever a "card drag in progress" flag was set. That flag was cleared only by the card's `dragend`, which Chrome doesn't send if the Action Editor re-renders mid-drag (e.g. a thumbnail finishing). One missed `dragend` left every later timeline drop silently ignored; 02 Assets didn't check the flag, which matched what Omar saw. Separately, files whose MIME type the system leaves blank were filtered out without a word.
- **Decision:** card drags carry their own data type (`application/x-bssmnt-card`) and file drops never depend on the flag; any `dragend` clears it. Files are recognised by MIME type or, if blank, by extension. A timeline drop (or the Action Editor **+**) opens **02 Assets with the first new file selected**, so it's visibly in the bin, and a notice says what was added and names anything that isn't a video or image.
- **Verified with real OS-style file drops:** with the flag deliberately stuck, a drop on the Action Editor still added the file, opened 02 Assets and selected it; two files dropped on the Clips lane both landed; a non-media file was reported by name; card reordering still works.

**2. Phone videos rotated and stretched.**
- **Cause:** phones store portrait video as a landscape frame plus a "rotate 90°" flag (4 of 6 of Omar's phone clips checked: 1920×1080, rot 90). `<video>` and 2D canvas apply the flag; Chrome's hardware-decoded path into WebGL (which p5 draws with) can skip it, so the frame arrives sideways while its size reads as portrait: rotated and stretched. This test machine's headless Chrome takes the software path and applies the rotation, so the bug didn't reproduce here.
- **Decision (`app/videoOrientation.js`):** the rotation is read from the file header (MP4/MOV `tkhd` matrix). Only videos with a rotation flag are drawn through a per-video 2D canvas copy (`drawImage` applies the rotation; long edge capped at 1280 px), used by clips, Media Layers and the pop-out. Unrotated video is untouched. Asset status shows the detected rotation.
- **Verified:** rotation read as 90 for the phone clip and 0 for the WebMs; the bridge produces a 720×1280 portrait frame; the clip renders upright and in proportion as a clip and as a layer. **Needs Omar's confirmation on his GPU browser**, since the broken path can't be reproduced here.

### D-55 · Export = offline renderer from a session record *(Agreed — Omar, 2026-10-02; session record + .mnt built: D-56, D-57; renderer not built yet)*
- **Decision:** export is an **offline renderer** (faster than real time, no sitting through the song). It renders from a **session record**, not from a second, different analysis:
  - **Edit decision list:** every cut as already logged by the engine: clip, start/end on the master timeline, in-point, transition and blend length, triggering band, story role. Kept for one complete pass (today a backward seek discards it; the record must survive that).
  - **Per-frame analysis log:** the values the live analysis produced each frame: rms, bass/mid/high (after sensitivity / Dynamic EQ), spectrum (downsampled), BPM and the beat-clock state (beat edges, beatFlash/beatPulse). The visual modes replay these, so they react exactly as they did.
  - **Settings + media references + track mutes.** Muted tracks are left out of the mixdown (D-49).
- **No seeded randomness (Omar):** live playback keeps `Math.random`. The record stores the *outcomes* (which clip, which in-point), so cuts are exact; per-particle randomness inside some visual modes (e.g. Particles, Polygons) re-randomises in the render, with the same audio-driven behaviour. A seed would not have stopped live playback adapting to the music, but recording outcomes makes it unnecessary.
- **Two ways to fill the record, one renderer:**
  - **Live pass:** the record is written as the set plays (exact copy of what was seen).
  - **Fast pass (Omar: yes):** the **same frozen analysis code** (`AudioProcessor.bandEnergy/detectBeat`) run over a track or a recorded set, with the file decoded offline and a simulated 60 fps clock, much faster than real time. Not a second algorithm, so no second interpretation. May differ from a jittery live run by about a frame, which Omar accepts. `audioProcessor.js` stays unmodified.
- **First scope:** **all visual modes** (Omar), plus the Clip Auto-Editor, Media Layers, Story blocks and transitions. Spectrum Bars is HTML today and needs a canvas version for rendering.
- **Browsers:** Chrome and Edge first (full fast path: WebCodecs + streaming to disk). Firefox and Safari later through fallbacks (Origin Private File System instead of direct disk writes; a WebAssembly audio encoder if one is missing; ffmpeg.wasm or real-time capture as a last resort). Not locked out.
- **Libraries:** browser built-ins (WebCodecs, OfflineAudioContext, File System Access / OPFS, WebGL) + Mediabunny for reading and writing MP4/WebM (free, MPL-2.0). Avoid AGPL analysis libraries (e.g. Essentia.js) for a commercial product.
- **Speed test (`test-assets/render-speed.html`, run 2026-10-02 in headless Chrome with GPU, 1080p, 30 fps target):**

  | Stage | fps | × real time |
  |---|---|---|
  | Decode Omar's phone clip (H.264, rotation 90° applied) / a WebM | 195 / 711 | 6.5× / 23.7× |
  | Draw: Particles · Rings · Waves · Mandala · Tunnel · Galaxy · Polygons | 281 · 379 · 109 · **23** · 342 · 211 · 466 | 9.4 · 12.7 · 3.6 · **0.77** · 11.4 · 7.0 · 15.5 |
  | Galaxy draw + H.264 encode | 129 | 4.3× |
  | Clip pipeline (decode → composite → encode) | 108–129 | 3.6–4.3× |

  Rendering is feasible faster than real time with free browser technology. **Mandala** is the only mode slower than real time: its 96 spokes are drawn as separate WebGL lines, which p5 handles slowly. Batching them into one shape keeps the look identical and is a renderer task. Headless numbers are a floor; Omar should run the page in his own Chrome for his machine's figures.


### D-56 · Session record: kept across seeks, punch-in overwrite, per-frame log *(Accepted — built)*
- **Edit decision list:** cuts are no longer discarded on a backward seek. Each play-through after a seek is a **pass** that overwrites only the span it actually plays, like punching in on a DAW track: cuts before the seek point stay, the played stretch is re-recorded, and the rest of the earlier take stays (a cut that runs past the playhead keeps its tail, with start and in-point moved up). The cut on air when you seek is closed where playback actually was.
- **Per-frame analysis log** (`app/sessionRecord.js`): 60 frames/s on the master timeline, 144 bytes per frame (rms, bass/mid/high, BPM, beatFlash/beatPulse, beat edge, active, visual mode, 128-bin spectrum), stored in one-minute blocks; replaying a stretch overwrites its frames. About 31 MB per hour before compression.
- **Bug found and fixed during testing:** seeking away while a Story block played left that block recorded as running until the next seek (a later cut overwrote the already-closed end time). Cuts now only close a block that is still open; zero-length leftovers are dropped.
- **Verified:** play 16 s → seek to 5 s → play 4 s: the cut list stays continuous with no gaps or overlaps, the earlier take is kept before 5 s and after the replayed stretch, and 5 s onward belongs to the new pass. Story blocks are recorded exactly where they played. Full regression passes.
- **Note:** in live mode, Stop then Start still begins a new session (and a new record). Save before restarting.

### D-57 · .mnt project files *(Accepted — built)*
- **Decision (Omar):** projects save as a reopenable, editable **`.mnt`** file. It is a ZIP container: `project.json` (source, visual mode, Auto-Editor and Story settings, EQ and sensitivity, mutes, Media Layer settings, every asset with its per-asset settings, voice settings, the cut list and beat grid), `record/frames.bin` (the per-frame log), `thumbs/` and `media/voice.*`. Zipping uses fflate (MIT), loaded on demand.
- **Media is linked, not copied** (like Premiere/Resolve projects), so files stay small. Exception: the **voice track is stored inside**, because recorded takes exist nowhere else. On reopen, Chrome/Edge reconnect files automatically where the browser remembers them (file handles from drag-and-drop and the file picker, kept in IndexedDB); otherwise **03 Output › Project** lists what's missing with **Reconnect**, **Find in folder** and **Choose files** (matched by name and size). Missing assets show as **Offline** with their saved thumbnail and keep all their settings. A future launcher can store real file paths instead.
- **UI:** 03 Output › Project: name, **Save** (Ctrl+S), **Save as** (Ctrl+Shift+S), **Open** (Ctrl+O); a `.mnt` dropped anywhere opens it; a warning appears before closing with unsaved changes. Browsers without the save picker download the file instead.
- **Verified with real files:** a project (5 assets incl. a rotated phone clip, layers, Story, EQ Blend, sensitivity, voice with offset/volume/Normalize, 16 s recorded) saved as a 1.3 MB .mnt; reopened in a fresh app, all six media files were listed and reconnected by choosing them; every setting, asset, layer, EQ value, mute, voice setting, cut and recorded frame matched exactly; playing again recorded a new pass over the restored cuts. (pre-existing on `main`, not changed)

### D-58 · Position lock always available; Clip mode starts on a track *(Accepted — built; supersedes the Story Mode switch in D-33)*
- **Position lock (Omar):** the Free / Story switch is retired (commented out in the Auto-Editor panel). The **Position** option (Hook · Result / Climax · CTA) is always available in **02 Assets › Asset timing**, under "Position lock". There are **three positions in total**: a position held by another clip shows greyed out with who holds it, and once all three are used the option **fades and goes dead** on every clip that doesn't hold one (clips that hold one can still change or clear it). Nothing is silently moved from one clip to another any more. With no positions set, behaviour is exactly the old Free Mode. Auto Fade Music stays in the Auto-Editor panel ("to positioned clips"). Projects saved with Story Mode off open with positions available.
- **Clip Auto-Editor starts on a track (Omar):** choosing Clip Auto-Editor (mode menu, header MODE or the 0 key) switches SRC to **Track file** and, if no track is loaded, opens **01 Audio** and the **track file dialog**. Not during a project restore.
- **Verified:** menu and 0 key both switch SRC and open the dialog (stubbed in the test); no dialog when a track is already loaded; position options grey out as they are taken and the control goes dead at three; clearing one brings it back; positions work with no mode switch; full regression and project tests pass.


### D-59 · Auto Fade Music per locked clip, with shape presets *(Accepted — built; replaces the global Auto Fade switch)*
- **What (Omar):** every clip with a position lock (Hook / Result / CTA) has its own **Auto fade music** checkbox in **02 Assets › Asset timing › Position lock**. Ticking it reveals the extra controls: **four fade shapes shown as icons** (tooltip + screen-reader label only, no text on the buttons) and a **fade length** of ½, 1 or 2 bars.
- **Shapes:** *Linear* (straight ramp) · *Smooth* (S-curve) · *Snap* (music holds, then drops fast just before the clip) · *Duck* (dips to 30 % instead of silence). Music is fully down (or ducked) for the whole clip and comes back after it over the same length.
- **Global switch retired:** "Auto Fade Music to positioned clips" in the Auto-Editor panel is commented out. Projects saved with it on open with a Linear 1-bar fade on every locked clip.
- **Unchanged:** only the music bus fades (analysis keeps running, D-36); voice is never faded; track mode only (live mode has no known positions ahead of time).

### D-60 · Text: titles, credits and general text *(Accepted — built; first piece of the overlay system, the rest is roadmap only)*
- **Where:** new tab **04 Text** (Ctrl/Alt+4). Add **Title**, **Credits** or **Text**; each item has words, a lock and a look. The items sit on a **Text lane** in the timeline (shown once any text exists); click selects and opens 04 Text, drag retimes it.
- **Lock (timing):** *Start* (from the beginning) · *At time* (exact time; dragging on the lane sets this) · *End* (the last N seconds of the track). Defaults: Title = Start, 5 s; Credits = End, 15 s, rolling; Text = At time at the playhead, 4 s. In live mode there is no end, so items can be played with **Show now** (runs on the wall clock, so it works with the live clock stopped).
- **Look:** font (Display/Boldonse, Sans, Mono, Serif), size S/M/L/XL as a fraction of frame height (looks the same at any output size), colour, align, position (top / centre / lower third / bottom), backing (none / shadow / plate), animation (fade, rise, none; credits: roll, fade, none). Title: line 1 is the title, further lines are the subtitle. Credits: one line each, "# " makes a heading.
- **Drawn:** one `TextOverlay.render()` used by the viewport (a 2D canvas over the visual, hidden while nothing is on screen because an empty layer still costs compositing time), the pop-out output window, and later the offline renderer. Text draws over every visual mode. While 04 Text is open the selected item previews on screen even outside its time.
- **Saved** in `.mnt` projects (`project.text`).
- **Not built (by request):** the rest of the overlay system (visual modes over video) — roadmap only.
- **Verified:** title drawn inside its time and not outside; credits roll upward over the last 15 s; lane drag retimes (lock becomes At time); panel edits; save → reopen; pop-out shows the title; live Show now; fade icons revealed by the checkbox; fade levels per shape; existing regression, project and position suites.


### D-61 · Offline renderer and a fully offline app *(Accepted — built; v2.3 steps 3–4)*
- **Offline (Omar):** the app needs no internet. p5, Mediabunny, fflate and the fonts (Boldonse, Inter Tight, JetBrains Mono; latin + latin-ext) live in `vendor/` with their licences. The unused p5.asciify tag (a version that never existed, so it always failed) is removed. **Start BSS MNT.bat** runs `serve.js` (Node, no installs, this computer only) and opens the app. *(Since D-64, opening `index.html` from disk works too.)*
- **Export (03 Output › Export video):** size (1080p, 720p, 4K, 1080×1920, 1080×1080), range (whole timeline / played part only), 30 or 60 fps, quality (Standard / High / Max) → **MP4, H.264 + AAC**, written straight to the file picked in the save dialog (Chrome / Edge), with progress, speed, time left and cancel.
- **How it renders** (the D-55 design): it replays the session record, it doesn't re-analyse.
  - **Visual modes:** the app's own drawing code on a private p5 canvas at the export size, fed the recorded analysis frame by frame. Trail-based modes step at the live 60 Hz, so a 30 fps export looks like what was on screen. Randomness stays random (no seeding, as agreed).
  - **Spectrum Bars:** a canvas version, 64 bars (the on-screen 256 bars, two by two).
  - **Clips:** the cut list (which clip, in-point, transition, blend length) replayed with frame-accurate decoding (Mediabunny / WebCodecs; rotation from the file). Regular clips loop, story clips play once, as live.
  - **Media Layers:** the same layer settings; layer videos loop on the master time (live they loop on their own clock).
  - **Text:** drawn with the same `TextOverlay.render()`.
  - **Audio:** mixed offline in 10 s chunks — track (with per-clip Auto Fade), voice (offset, volume, normalize), story-clip sound; **muted tracks are left out**.
- **Limits:** parts of the timeline never played have no recorded motion and are shown still (the panel warns; the fast pass, step 5, will fill them). Live mode: the input sound isn't recorded, so a live export carries voice and clip sound only. WebM output and the Firefox / Safari fallbacks are not built (step 6).
- **Speed (this machine's GPU):** 3.1–4.6× real time at 720p for clips, Galaxy and Spectrum Bars, including encode.
- **Verified** (with all internet requests blocked): fonts, p5 and project zip load locally; panel export of the played part writes a valid 1280×720 H.264 + AAC MP4 of the right length; cuts land as recorded (hook = red clip, then green clip); title on screen 0–4 s and gone after; music silent under the hook with Auto Fade and back after; muted master → silent audio; Galaxy and Spectrum Bars export.


### D-62 · Fixes: audio after Clip mode, source switching keeps the track, text timing, text drag *(Accepted — built)*
- **Audio lost after Clip mode (Omar):** two causes. (1) Entering Clip mode from the live input switches SRC to Track (D-58) and nothing switched it back: now Clip mode remembers it left the live input, and leaving Clip mode returns to it (restarting it if it was running) unless a new track was picked while in Clip mode. (2) Auto Fade Music kept silencing the music under locked clips in every mode: it now only acts in Clip mode (live and in exports, which use the mode recorded at each moment).
- **Switching SRC keeps the track (Omar):** an if-this-then-that rule. Same source again → nothing changes. Leaving a loaded track → it is parked with its session (cuts, recorded motion, timeline view, position). Back to Track file with a parked track → it reloads, session restored, paused where it was, no file dialog. Nothing parked → asks for a file as before. Clip mode from the live input uses a parked track instead of asking. Loading a new track or opening a project replaces the parked one.
- **Text timing (Omar):** timing was right, but while 04 Text was open the selected item was previewed all the time, including during playback. Now during playback every item keeps strictly to its time, panel open or not; the preview only shows while paused, faded, with a tag saying when it is on screen.
- **Text drag handle (Omar):** while 04 Text is open, the selected base text has a dashed box on the viewport; dragging it places the text anywhere. Position becomes **Free** (x / y as fractions of the frame, so it lands in the same place at any export size); the preset positions are still in the list. Saved in projects.
- **Cut list hole after a seek (found while testing):** after a seek the clip on screen carried on but wasn't recorded until the next beat cut (none before BPM locks), so the punch-in overwrite could leave a stretch with no cut, which exported black. A seek now starts the new pass with a cut for the clip on screen. This was also the cause of the intermittent 0.13–0.16 s punch-in gap.
- **Verified:** live mic → Clip → Galaxy returns to the running mic; Track → Mic → Track keeps the same track, cuts and position with no dialog; Clip mode from the mic reuses the parked track and leaving returns to the mic; Auto Fade silent under the hook in Clip mode only; text with the panel open hidden outside 17–18 s during playback, faded preview with time tag when paused; drag sets Free and follows the pointer; Free survives save/restore; all earlier suites and the export suite.


### D-63 · Display size (header SIZE) and breakpoints *(Accepted — built)*
- **SIZE in the header (Omar)**, after SRC and MODE: **Original** (fills the viewport, as before) and every export size — 1080p, 720p, 4K (16:9), 1080×1920 (9:16), 1080×1080 (1:1), each with a shape icon. The viewport shows the frame at that shape, letterboxed and centred, and the visuals, clips, layers and text redraw at that size. It changes live, during playback or editing, without stopping anything. The export size follows it; a project remembers it.
- **Breakpoints, like a responsive website:** sizes with the same shape look the same (everything is laid out as fractions of the frame), so they share a layout. **Base** = landscape (16:9 and anything wider than 6:5), **Vertical** (narrower than 5:6), **Square** (in between). Text layout — position (incl. Free / dragged x-y), size, align, backing — edited while a breakpoint is on screen is kept **for that breakpoint only**; everything not changed there **follows Base**. Words, font, colour, animation and timing are shared by all sizes.
- **In 04 Text:** a bar above Look says which layout you are editing ("Base" or "Vertical · 9:16 · 2 changes for this size"), rows changed for this size get a red mark, **Reset** makes the size follow Base again. The drag handle turns red with "Runs off the frame at this size" when text goes past the edge.
- **Everywhere the same:** viewport, pop-out (by its own window shape) and export each pick the layout for their frame shape, so a vertical export uses the Vertical layout.
- **Not per breakpoint (yet):** Media Layer justify/stack and clip framing (clips cover-fit every shape, centred).
- **Verified:** six sizes in the menu with icons; Vertical / Square / 1080p frames at the right ratio, centred, visuals redrawn at the frame size, playback not interrupted; Original fills again; Base bar on 16:9; Vertical follows Base until changed; drag + XL on Vertical stored for Vertical only with marks; back on 16:9 the Base layout; Square follows Base; Vertical export (1080×1920) puts the text where it was dragged, a 16:9 export uses Base; project saves size + per-size layout; Reset.


### D-64 · Works opened from disk, and in Firefox *(Accepted — built; fixes Omar's Save / Export errors)*
- **The error:** opening `index.html` from disk (file://) in Firefox, Save failed loading `vendor/fflate.mjs` and Export failed loading `vendor/mediabunny.min.mjs`: browsers refuse module imports on file://.
- **Fix:** both libraries are now plain scripts (`vendor/fflate.js` = fflate's UMD build; `vendor/mediabunny.js` = Mediabunny bundled as a plain script, global `Mediabunny`), loaded on first use by `app/vendorLoader.js`. Plain scripts load from disk and from a server, in every browser.
- **Pop-out from disk:** browsers keep file:// pages apart, so `output.html` couldn't reach the main window. From disk the pop-out is now a blank window with the same page written into it, which counts as the main page and can mirror it. Served, it still opens `output.html`.
- **Firefox:** no save dialog for web pages → projects and exports download (exports auto-download; a link stays for another copy). No AAC encoder → exports use Opus sound (H.264 video). Exports build in memory there.
- **Found while testing:** opening a project right after loading the page asked "Unsaved changes will be lost": choosing the .mnt file in the Open picker counted as an edit. File pickers no longer mark the project changed (anything they add does that itself).
- **Verified:** Chrome from disk (save dialog removed, like Firefox): fonts and p5 load, Save downloads the .mnt, Export downloads a valid 1280×720 H.264 + AAC MP4, pop-out mirrors, the .mnt reopens. **Firefox 156 from disk:** app, fonts, both libraries, track + clips + recording, Save downloads, Export downloads a valid MP4 (H.264 + Opus), pop-out works, the .mnt reopens, no page errors. All earlier suites pass.


### D-65 · Projects carry their media; exports play in Windows Media Player *(Accepted — built; first-MVP closer)*
- **Reopening needed manual reconnecting (Omar):** browsers never reveal where a file lives on disk, so a project that only links media can't find it again by itself (and Firefox, opened from disk, has none of the reconnect shortcuts). **Pack media** (03 File › Project, on by default, remembered) puts the music, video and image files inside the .mnt: it reopens on any computer, in any browser, with nothing to reconnect. The panel says how much it adds. Off = linked as before.
- **Light on memory:** media is stored uncompressed and the .mnt is written as a stream (straight to disk in Chrome / Edge; Firefox downloads). Opening reads only the ZIP index and plays packed media straight from its slice of the .mnt — nothing is loaded whole. Saving over the open .mnt (Chrome / Edge) re-points the playing media at the new file without stopping. *(The 3.8 GB limit first shipped here was removed by D-66.)*
- **Unpacked projects in Firefox:** Find in folder now works there too (folder picker), matching every missing file by name and size.
- **Bug found and avoided:** fflate's *streaming* compressor (0.8.2 and the latest 0.8.3) writes corrupt data for some inputs ("invalid distance" on reading) — it hit the recorded-motion data. Every entry is now stored uncompressed (the recording costs ~8.6 KB/s); older projects, written with the one-shot compressor, still open.
- **Panel renames (Omar, in the page):** 01 Audio → **Input** (`panel-input`), 02 Assets → **Sound**, 03 Output → **File**, 04 Text → **Overlays** (`panel-overlays`). The sidebar now resolves a panel by any of its names or ids, old or new (`Sidebar.GROUPS`), so code that opens "audio" / "assets" / "output" / "text" keeps working whatever the tabs are called (the renames had stopped Open, export, shortcuts and selection from showing those panels).
- **Exports from Firefox wouldn't play in Windows Media Player (Omar, "avc1 unsupported"):** two causes. (1) Firefox has no AAC encoder, so its exports had Opus sound — now the bundled AAC encoder (`vendor/mediabunny-aac.js`, FFmpeg's AAC in WebAssembly, loaded only when the browser has none) gives AAC everywhere. (2) Firefox's H.264 encoder hands over malformed setup data (avcC: SPS / PPS start with a repeated byte, reserved bits 0), so Windows read the frame size as 34 × 4294967286 and refused the stream; VLC copes by reading the copies inside the stream. The renderer repairs the avcC as it is produced (a well-formed one, e.g. Chrome's, passes untouched). Windows now reads Firefox exports as H.264 High 1280×720, AAC, and decodes frames.
- **Verified:** Chrome — pack hint, streamed save holding all media (25.9 MB for 25.8 MB), fresh tab reopens with nothing to reconnect (track, 3 clips, image, both layers, text, cuts), files byte-for-byte, plays from the pack, save over the open file keeps playing, export from packed media, re-saved file reopens, Pack off stays small; real-click run ×3. Firefox 156 from disk — save downloads, export H.264 + AAC, reopen with nothing to reconnect, no errors. Windows Media Foundation reads the Firefox export as H.264 High + AAC and decodes a frame. All earlier suites pass.


### D-66 · No size limit on projects; nothing left out silently *(Accepted — built)*
- **The problem (Omar):** packed projects stopped at 3.8 GB because fflate can't write ZIP64, and past that the largest media were quietly linked instead of packed — so on reopening, files were missing. Not acceptable for media projects.
- **Fix:** our own ZIP writer and reader (`app/zip64.js`) with **ZIP64**: no limit on the project or on any file in it. Entries are stored and streamed (CRC-32 worked out on the way, data descriptors, ZIP64 fields wherever a size or offset passes 4 GB). Every connected file is packed — the size cap and the "largest files get linked" rule are gone. Old projects (compressed, D-57; streamed, D-65) still open.
- **Nothing dropped silently:** if a media file isn't connected when you save, the save says so and names it ("Reconnect … and save again"). Big saves show progress ("Saving… 45% (2.03 of 4.51 GB)").
- **Firefox (no save dialog):** projects and exports are first written to the browser's private disk area (OPFS) and downloaded from there, so a large project or a long export is never held in memory. The temporary copy is removed at the next save / export. If the browser won't grant enough space it says so (and suggests Chrome / Edge, which write straight to the chosen file).
- **Verified:** a project with a 4.5 GB file + clip, image, track and text — Chrome: saved 4.512 GB in 21 s with progress, reopened in 0.5 s with nothing missing, the 4.5 GB file byte-exact at start / 2.1 GB / 4 GB / 4.4 GB / end; Firefox from disk: saved (disk, then download) 4.505 GB in 56 s, reopened complete and byte-exact. Independent checks: Windows' .NET ZIP reader lists every entry of both files with the right sizes; Node's zlib CRC of the source equals the CRC stored in the .mnt. Saving with a file that isn't connected warns and names it. All earlier suites pass.


### D-67 · Pack or Link, with the file size before saving *(Accepted — built)*
- **Choice (Omar):** 03 File › Project has a **Media: Pack | Link** switch above Save (remembered). Hover text explains each: *Pack* copies the music, video and image files into the .mnt (one file to keep, move or share; reopens anywhere with nothing to reconnect; as big as the media). *Link* keeps the .mnt small, remembering each file's name, size and date; the media stays where it is and is found again on reopening (Reconnect / Find in folder), or pointed to once if it moved or on another computer.
- **Size before saving:** under the switch, "Project file: ≈ 25.9 MB — includes 25.8 MB of media" (Pack) or "≈ 91 KB — media linked (25.8 MB stays where it is)" (Link), updated as media is added; it also says when files aren't connected and so won't be included. The Save button's tooltip repeats it.
- **Accuracy:** Pack projected 25,906,370 B vs 25,911,928 B saved (0.02 %); Link ≈ 91 KB vs 95 KB.


### D-68 · Live mode records its input, so live exports have sound *(Accepted — built; untested in real-world use, labelled so in the app)*
- **What (Omar):** in live mode the input (mic / line in) is now recorded while the session clock runs — "Record input for export" in 01 Input (on by default, remembered), a blinking **REC** badge next to SRC while it records, and a status line ("Recorded 12.4 MB of input — included in exports and saved in the project").
- **How:** a MediaRecorder on the stream AudioProcessor already opened (raw input: echo cancellation, noise suppression, auto-gain off) — audioProcessor.js untouched. Opus in WebM, ~1 MB/min. The start time against the session clock is kept, so the export lines the sound up with the recorded motion. Each Start is a new live session and a new recording (as the live timeline already was).
- **Long sets:** written to the browser's disk area as 5-second segment files (the browser only commits a file when it's closed), never held in memory; the export reads it piece by piece as it mixes, so a 2-hour set is never decoded whole. Master mute applies.
- **Crash safety:** a recording that never finished (browser closed or crashed mid-set) is offered back on the next start — "Download it" / "Dismiss" in 01 Input; at most the last ~5 s are lost.
- **Saved in the project:** always packed into the .mnt (it's the only copy of the set), counted in the projected size, restored on open.
- **Verified:** Chrome — REC while running, take kept on stop (offset 0.11 s), live export carries the input in AAC with no warning, **sync: beep onsets in the export vs the recorded analysis 17–33 ms apart, mean 26 ms (under one frame at 30 fps)**, saved in the .mnt and counted in the projected size, reload mid-set → recording offered and downloadable, Dismiss clears it. Firefox 156 from disk — records, live export has AAC input sound, reload mid-set offers the recording.


### D-69 · Dark skin, and analyser-style EQ graph and session lanes *(Accepted — built)*
- **Dark skin (Omar):** a second skin with the colouring flipped — ivory lines, text and buttons on near-black; band colours a step brighter; dark form controls and scrollbars. **Chosen with the half-moon button in the header** (remembered), never taken from the computer's light / dark setting. Applied before the page draws, so it never flashes light. Every UI colour is a CSS variable (the few hard-coded ones — primary-button hover, the glass panels, the canvas line colours — now follow the skin; the timeline's canvas lines use ink / paper with alpha).
- **Analyser look (Omar, after iZotope Ozone's EQ):** inside the EQ graph and the timeline's **Master** and **Voice** lanes only — a deep navy "screen", a filled blue spectrum with a crisp top line, the EQ curve as a glowing blue → violet → pink → orange gradient with a soft fill to 0 dB, nodes tinted by where they sit on the curve with a white ring; the Master waveform in that gradient with the played part bright and the rest dim, band-energy lines glowing in brighter bass / mid / high; the Voice waveform in the same gradient. Shared code in `app/scope.js`; colours in `--scope-*` variables (the dark skin deepens the screen). The viewport stays black in both skins.
- **Roadmap:** hardware-inspired skins (MPC, Akai) — colour and feel only, no trademarks.


### D-70 · Windows launcher and the BASSMNTalphaV1 release *(Accepted — built)*
- **Launcher (Omar: Windows only for now; Mac on request, labelled untested):** an Electron app (`electron/main.js`) — the same Chromium engine the app was tested in is built in, so it behaves like Chrome. It loads `index.html` from the app folder (the file:// path, D-64), so no server or internet. Allowed: microphone / line in (live mode), the file save / open dialogs, fullscreen, the pop-out output window (opens as its own window); links to the web open in the system browser. Renderer sandboxed, no Node in the page; exports keep running when the window is in the background.
- **Security fuses:** run-as-Node, NODE_OPTIONS and inspect arguments are disabled and the app only loads from its own (integrity-checked) asar. Terminals in VS Code set ELECTRON_RUN_AS_NODE=1, which would turn Electron into plain Node — `npm start` (`electron/run.js`) clears it; the built app ignores it (fuse).
- **Build:** `npm run dist:win` (electron-builder) → `dist/BSSMNT-alphaV1-win-x64-Setup.exe` (installer, choose folder, desktop shortcut) and `dist/BSSMNT-alphaV1-win-x64.zip` (portable). Not code-signed (no certificate) → SmartScreen "More info → Run anyway". Icon: BSS / MNT in Boldonse with the red rule (`electron/icon.png`).
- **Release BASSMNTalphaV1 (GitHub):** tag `BASSMNTalphaV1` on `v2`; the source archive is for developers (needs `npm install` / `npm start` / `npm run dist:win`, or an editor such as VS Code) — said on the release; the Windows installer and zip attached as ready-to-run downloads.
- **Labelled untested:** live input recording (tooltip, REC badge tooltip and an "untested" tag by the switch).
- **Verified on the built app** (driven over DevTools): can't be run as Node; app, fonts, save dialog and video encoder present; live mode — microphone allowed, analysis running, input recorded; track + clip export H.264 + AAC (3.3× real time); packed project saves; pop-out opens as a second window; no page errors.
- **Roadmap:** live video input (cameras / capture cards as live assets, recorded for export, multi-cam on the beat).


### D-71 · Fix: choosing a track did nothing after using live mode *(Accepted — built)*
- **Reported (Omar):** after the live-input update, the editor "plays the video straight out" (no cuts) and audio wouldn't import in the dev environment.
- **Cause:** the Track file picker was never cleared after a pick. Browsers only report a *changed* pick, so choosing the same track again — e.g. after going live and switching back — fired nothing: no track loaded, no message. With no track there is no BPM, so the Clip Auto-Editor never cuts and the first clip plays straight through. (The voice and asset pickers already cleared themselves.)
- **Fix:** the Track file picker is cleared on every pick, so the same file always loads again.
- **Checked:** import after live running / live stopped / fresh now loads every time (Chrome; Electron app from source, including the native file dialog, which opens with the "Media" filter). Clip editing after live mode matches a fresh session (BPM lock 14 s, 12–13 cuts in 25 s, A/B/C rotating) and the build before the live work (041ddfc) in a side-by-side run. Note: cuts start once the tempo is found (about 14 s into this test track — "Listening for tempo…"); until then the first clip plays, as before.


### D-72 · Fix: Choose file did nothing inside VS Code's preview *(Accepted — built)*
- **Cause:** file pickers go through the browser's newer picker (it remembers files for reconnecting projects). Inside a frame — VS Code's Simple Browser, embeds — that dialog opens but the page may not read the chosen file; the error wasn't caught, so nothing loaded and nothing was said.
- **Fix:** that picker (and the save / open / folder dialogs) is used only in a top-level window; in a frame the standard picker is used. If it ever fails to read a file, the app switches to the standard picker and says to click again.
- **Verified** with a real click on Choose file and the real Windows dialog in VS Code's Simple Browser (VS Code 1.140): the track loaded and played.

### D-73 · Windows Media (ASF / WMV / WMA) converted on import *(Accepted — built)*
- **Why (Omar):** screen recordings arrive as .asf (WMV3 video, WMA audio); no browser engine decodes them, so they came in blank with no duration.
- **Desktop app:** FFmpeg is bundled (`resources/ffmpeg`, GPL — `vendor/licenses/NOTICE-ffmpeg.txt`). Adding an .asf / .wmv / .wma as a clip converts it to MP4 (H.264 + AAC), as the track to M4A (AAC), with progress; results are cached in the app's data folder (same file = instant). Source frame timing is kept (`-fps_mode vfr`): these recorders declare a 1000 fps timebase, and constant-rate output took 331 s and 76 MB for a 3½-min file instead of 8 s and 7.5 MB.
- **Browser:** a clear message (desktop app, or convert to MP4 first) instead of a blank clip.
- **Verified:** FFmpeg on Omar's recordings (WMV3 1280×892 / 2880×1776, WMA2); headless app flow with the bridge stubbed — clips ready with picture and duration, .asf as track plays, editor cuts and export renders from them.

### D-74 · Desktop fixes: closing, linked media, parked track *(Accepted — built)*
- **Couldn't close the app:** with unsaved changes the page asks before leaving; Electron cancelled the close silently. The launcher now shows "Unsaved changes — Close without saving / Cancel". The page's clean-up moved from beforeunload to pagehide, so Cancel no longer leaves a torn-down app.
- **Linked projects lost files (9 of 22):** browsers never expose file paths, so reopening relied on remembered permissions or name + size matching — which never matched converted .asf clips (the project stored the converted MP4). The desktop app now saves each file's **real path**, and for converted clips the **original .asf**; reopening loads them from disk (re-converting from the cache). Find in folder / Choose files match converted clips by their original.
- **No audio after reopening (browser):** saving with SRC on Live left the parked track (D-62) out of the project. The parked track and its session are now saved and restored parked.
- **Verified headless:** parked track saved and restored; Link save records paths and the .asf origin; reopen with the desktop bridge stubbed finds all three clips and the track with nothing to reconnect; earlier suites pass. The close dialog and real paths need the desktop app itself (not opened during testing).


### D-75 · Bug-fix update stays BASSMNTalphaV1 *(Accepted — Omar)*
- Bug fixes are released as an update of the same alpha, not a new version number: builds are named alphaV1 again (the alphaV1.1–1.3 names and the BASSMNTalphaV1.3 tag are withdrawn). Changes are listed in CHANGELOG.md.
- Every download carries **README-BSSMNT.txt** (getting started, all shortcuts, controls): next to the app in the installer and the zip, as its own release download, and in the source. The in-app help (?) now shows the current panel names and Save / Save as / Open.


### D-76 · File menu, tab order, New project, Open recent, Effects as a list *(Accepted — Omar)*
- **Tabs:** 01 File, 02 Input, 03 Sound, 04 Effects (Overlays renamed); Ctrl / Alt + 1–4 in that order. The sidebar still resolves the old names.
- **01 File** is a traditional list menu, the project name field on top: New project · Open… · Open recent (dropdown) · Save, with Pack / Link radios beside it and the projected size underneath · Save as… · Export video (expands; options are dropdowns) · Output window. Choosing Pack / Link is not an unsaved edit.
- **New project** asks if there are unsaved changes, finishes any live recording, and restarts the app fresh (all settings default; skin, Pack / Link and the recent list kept). Ctrl+N in the desktop app; Alt+N in browsers (they keep Ctrl+N).
- **Open recent:** the last 8 projects opened or saved — the file handle where the browser keeps one (Chrome / Edge / desktop), the real path in the desktop app; a missing file is dropped from the list with a message.
- **Name follows the file:** a reopened project is named after its .mnt (Save as used to leave the old name inside).
- **04 Effects:** Add title / Add credits / Add text as a list; every text option (lock, size, align, backing, font, position, animation) is a dropdown.


### D-77 · Fixes before showing: recent projects, REC badges, dark-skin strokes *(Accepted — built)*
- **Open recent** logs every project opened or saved. Where the browser gives no reusable handle or path (Firefox, VS Code's preview), a copy of the .mnt (up to 300 MB) is kept in the browser's storage so it reopens; larger ones open the Open dialog.
- **REC badges:** the header live-input badge and the timeline voice badge shared the id recBadge, so voice recording drove the header badge. The header one is now liveRecBadge.
- **Dark skin strokes:** 1 px → 0.5 px, the heavy 2–3 px lines → 1 px, and lines use --line (ivory at 48 %) so they read thin at 134 % scaling, where nothing can be thinner than one screen pixel. Focus rings unchanged. Light skin unchanged (--line = ink).
- **Basics check** (headless, every tab through its real controls): header SRC / MODE / SIZE / skin / help; 01 File name, New, Open, Open recent, Save, Pack / Link + size, Save as, Export (dropdowns, renders), Output window; 02 Input source, track, play / pause, mode, voice import / volume / normalize / offset, record-input; 03 Sound sensitivity + R, Dynamic tab, preset, Use = Blend, Flat, clips + image, Pace, Position, Auto fade, Media Layer, Importance; 04 Effects add three kinds, every dropdown, delete; Auto-Editor order / transition; timeline play / stop / home / mutes; keys Alt+1–4, Shift+A, digits, Space — 89 / 89 with file handles, 89 / 89 without; Firefox 157 save → new → open recent. Earlier suites pass.

## I. Known carry-overs (pre-existing on `main`, not changed)
- Placeholder text drawn with `p.text()` in WebGL mode doesn't render, because no font is loaded (affects the Media Layers "Upload images…" prompt). v2 uses a DOM overlay for its own hints.
- `visualizer.js` has duplicate `drawAudioWaves` / `drawMandala` / `drawTunnel` definitions (the later ones win), plus unused snake-game code.
- `app.js` defines `switchVisualizationMode` twice (the string version wins) and has an unused `setupKeyboardShortcuts`.
- `README.md` clone URL still points at `philaconvalley/djVisualizer`.

## J. v2.1 — the three final changes *(built and verified, 2026-10-02)*

Spec: [brief-v2.1.md](brief-v2.1.md). Build order: [roadmap.md › v2.1](roadmap.md#v21--creator-essentials--now). Code plan: [codemap.md §4.0](codemap.md#40-v21--creator-essentials-).

Each entry was *Proposed* and became *Accepted* (or was rewritten) when its build step landed. Q9–Q16 were built with their proposed answers and are marked Accepted. **One open conflict:** Q15 vs. "defaults change nothing" (see D-32).

### Guiding rules taken from the brief
1. **The master timeline and the existing beat clock are the only source of timing** (D-06). Nothing in v2.1 adds a second clock or a second timeline.
2. **Defaults change nothing.** Timing = Global, Importance = 1, Story Mode = off, no voice, music unmuted. That reproduces v2 exactly.
3. **Three separate concerns:** clip timing and Importance affect *which clip shows and for how long*. Story Mode affects *where the anchors sit and what the music does around them*. Voice is *a separate audio layer that nothing else can retime*.
4. `audioProcessor.js` stays frozen (D-02). All audio work goes around it, never into it.

### D-31 · Per-clip timing = the existing Pace lexicon *(Accepted — Omar, 2026-10-02)*
- **Context:** The brief lists "Beat, Bar, Measure, 4/4, 4/2" as examples. Omar clarified: use the language already in the app, and no 4/4, 4/2 or other musical labels.
- **Decision:** Per-clip timing is the **Pace** menu already on each clip (D-30): `Global` (follow the Auto-Editor panel; default) · Frantic · Driving · Relaxed · Phrase. These are the same `MusicalTime.AUTO_PACES` the main cuts use, and each resolves through `autoMultiplier()` to a whole-beat hold on the master beat clock.
- **Why:** One vocabulary for the global cut rate and per-clip holds makes cleaner edits: a clip set to Driving cuts exactly like the main timeline does on Driving. The beat clock is still the only clock.
- **Consequences:** Step 3a of the original plan (musical divisions) is dropped, and the per-clip timing control is done. What remains is moving it into the asset properties panel (D-44). Story assets don't show Pace (D-33).

### D-32 · Importance = place in the Action Editor stack, used as a selection weight *(Accepted — built in step 5)*
- **Decision:** Importance is the clip's **position in the Action Editor stack** (D-45). The top clip is 1, the next is 2, and so on. Dragging a clip to a new position renumbers the stack. Importance can also be typed in the properties panel, which moves the clip to that position. It changes only *which clip is picked*:
  - **Sequential:** plays in stack order (1, 2, 3, …). That is today's sequential behaviour, with the order now user-controlled.
  - **Random / By band:** weighted, with higher rank picked more often. Proposed weight = `N − importance + 1` (Q15). Still never the same clip twice in a row; By band applies the same weighting within the band's pool.
- **Why:** The brief's Importance is "weighting information for the automation". Omar wants it set by arranging the stack, the Canva-level way, instead of by typing numbers. Hold length stays with Pace, so screen time ≈ weight × hold.
- **As built:** weight = `N − rank + 1` *within the pool being picked from* (so a band pool of 3 weighs 3:2:1). **By band** also changes: v2 rotated through the band's pool in order; v2.1 makes it a weighted pick, as this entry specifies. Typing Importance in the properties panel moves the clip to that place. **Verified:** Sequential cut order = stack order (A B C D Getty Logo, repeating); after reordering, 6000 Random picks by position = 1525 / 1322 / 1182 / 947 / 677 / 347; By band (pool of 3) = 1242 / 1101 / 657.
- **⚠ Conflicts with the v2.1 rule "every new control defaults to today's behaviour"** (and exit criterion 1): with an untouched stack, Random and By band are no longer uniform/rotating. Built as Q15 proposes, flagged for Omar. Switching back to "uniform until the user reorders" is a one-line change in `weightedPick()`.
- **Consequences:** New clips are added to the bottom of the stack, which is upload order, so Sequential matches v2. Random weighting does change from v2's uniform pick. Q15 asks whether it should stay uniform until the user reorders. Future: Importance becomes overlap-based crossfade on the action line (roadmap Phase 1.4 note).

### D-33 · Story assets leave the automated pool; Free Mode ignores positions *(Accepted — built in step 7; the Story Mode switch is superseded by D-58)*
- **Decision:** Each asset has **Story Position** (in the asset properties panel, D-44): None · Hook · Result/Climax · CTA. Only one asset can hold each position; assigning a position that's taken moves it. The menu is shown only while Story Mode is on.
  - **Story Mode ON:** an asset with a position is removed from `choose()`'s pool and from the Action Editor stack (it shows as a fixed Story block instead). Its Pace and Importance controls are hidden (the brief excludes them).
  - **Story Mode OFF (Free Mode):** positions are remembered but ignored, and every clip is a regular clip again. Free Mode behaves exactly like v2.
- **Why:** Matches "static, single-use" and "Free Mode remains unrestricted", and toggling Story Mode never loses the user's assignments.
- **As built:** Story Mode is a Free / Story switch in the Auto-Editor panel. Story Position shows in the asset properties only in Story Mode. A story asset doesn't need to be an auto-edit clip. Story assets have no Importance, so they sit after the stack and **rejoin it at the bottom** when Story Mode is switched off (their roles are kept). **Verified:** with Hook / Result / CTA set, 3000 automated picks and every fill segment contained no story asset; Free Mode → no blocks, all clips back in the pool, roles kept.

### D-34 · Story blocks sit on the master timeline (overlay model) *(Accepted — built in step 7; Q9, Q10)*
- **Decision:** Story blocks occupy windows **on the song's own timeline**. The song keeps playing underneath and is not paused.
  - **Hook:** `[0, hookLen)`.
  - **CTA:** `[songEnd − ctaLen, songEnd)`.
  - **Result/Climax:** ends where CTA starts (or at `songEnd` if there's no CTA).
  - **Automated content:** fills everything between.
  The fill pauses during a block. When a block ends, beat-locked cutting re-syncs on the next master beat, the same way it does after a seek.
- **Block length:** a video plays its full length once. An image holds for a set time (pending Q9).
- **Why:** The master timeline stays the single source of truth, which is the brief's core rule. The beat clock, waveform, seek and band analysis all keep working through the blocks. The alternative (stop the song, insert the block, resume) would freeze the beat clock and break seek, and would amount to a second timeline.
- **As built:** if blocks would overlap on a short song, Result and CTA are clamped to start after the Hook. Beat edges keep being counted during a block, so the bar grid stays continuous. A story video is unmuted for its block (its own sound) and re-muted when it ends. **Verified on CREAM (195.5 s):** ALL = hook[0–6] → result[186.6–189.6] → cta[189.6–195.5]; no Result = hook → cta; no Hook = result → cta; no CTA = hook → result[192.5–195.5]. Playback: HOOK B D E RESULT CTA, each story block once.
- **Consequences:** "Once" means once per pass through the song. Seeking back before a block lets it play again; seeking into a block plays it from the matching offset. The four orderings in the brief all follow from these rules with no special cases. Story segments are flagged in the segment log and drawn as fixed blocks on the clip lane.

### D-35 · Story Mode in live (unbounded) mode *(Accepted — built in step 7; Q11)*
- **Context:** A live set has no known end, so CTA and Result can't be placed "at the end" automatically.
- **Decision:** In live mode, Hook plays automatically on Start. **Result** and **CTA** are fired by two transport buttons ("Result", "End with CTA"), each once. In track mode, all three are placed automatically.
- **Verified:** live Start → Hook on air (unmuted); "Result" fired the Result block once, then disabled itself; a second fire was refused. Auto Fade is disabled in live mode (D-36: BSSMNT doesn't play the music there).

### D-36 · Music bus: one gain node *after* the analyser *(Accepted — built in step 2b; mute UI in step 6e)*
- **Decision:** `TrackSource` routes `source → analyser → musicGain → speakers` (today it's `analyser → speakers`). Music mute (voice-only) and story fades both drive `musicGain`.
- **Why:** The analyser still sees the full-level track, so BPM, bands and cuts keep running while the music is faded or muted. This is "the existing audio architecture" the brief asks for: one extra node in the current graph, not a new audio system. `audioProcessor.js` is untouched.
- **Verified:** with the bus at 0 on a real track, bass/mid levels, BPM and cutting carried on unchanged (5 cuts during a 5 s mute).
- **Consequences:** Applies in **track mode** only. In mic/live mode, BSSMNT doesn't play the music (it comes from the DJ's own rig), so there's nothing to mute or fade. The controls say so instead of silently doing nothing.

### D-37 · Auto Fade Music = fades around each block *(Accepted — built in step 7, mechanism rewritten; Q12)*
- **Decision:** With **Auto Fade Music to Story Blocks** on, the music fades out over 1 bar into each block and fades back in over 1 bar after it. The ramps are scheduled on the AudioContext clock (`linearRampToValueAtTime`) and rebuilt on seek, play and stop. With it off, `musicGain` stays at 1 (or 0 if muted).
- **Why:** It follows the brief's "Music → fade → HOOK → music fades in → …" sequence. Fade lengths in bars keep the transitions musical at any tempo (D-07). With no BPM yet, the fades fall back to 2 s.
- **As built (mechanism changed):** instead of scheduling AudioContext ramps and rebuilding them on every seek, play, stop and plan change, the music level is computed from the master time each analysis frame (`storyFadeLevel(t)`: 0 inside a block, linear over 1 bar before and after, 2 s without BPM) and applied to `musicGain` with a short glide. Same fade shape, and seek/pause/stop can't leave a stale ramp behind. Only runs while Auto Fade is on, so with it off the music path is exactly as before.
- **Verified:** gain 0 inside the Hook, 0.58 partway into the 1-bar fade before Result, 1 well after a block; BPM and bass kept updating during fades; with Auto Fade off, gain stayed 1 inside a block.
- **Consequences:** If CTA is the last block, the music doesn't come back after it.

### D-38 · Voice is its own chain, never connected to the analyser *(Accepted — built in step 6)*
- **Decision:** New `VoiceTrack` module: its own `<audio>` element and its own AudioContext, `element → normGain → volumeGain → speakers`. It is **never connected to the analyser or to `musicGain`**.
- **Why:**
  - The track's AudioContext is recreated on every track load and closed by the frozen processor's `stop()`, so voice can't live inside it.
  - Keeping voice out of the analyser means narration never moves BPM, bands or cuts.
  - Clip timing has no code path to the voice track at all, which enforces the brief's "critical separation" structurally, not just by convention.
- **Sync:** voice follows the master clock (play, pause, stop and seek follow the transport) at `voiceTime = masterTime − voice.offset`, and is nudged back if drift exceeds ~50 ms. In live mode it starts when Start is pressed.
- **As built:** the voice runs its own small rAF loop reading `masterTime()` / `timelineRolling()`, instead of hooks in each transport function, so nothing can miss a sync. After a start or seek there is a 400 ms grace before drift is judged: a media element needs a moment to begin playing, and an instant re-check would stutter.
- **Verified (CREAM + an imported MP3):** voice within 10 ms of the master through play, seek to 30 s, pause, resume and stop (one nudge, at the seek). Separate AudioContext from the track. Muting the music left the voice playing and BPM/cuts running. Changing Pace and Importance on three clips left the voice offset and position exactly unchanged.

### D-39 · Recording and import *(Accepted — built in step 6)*
- **Record:**
  - Uses `getUserMedia` with echo cancellation and noise suppression on, plus `MediaRecorder` (WebM/Opus, or MP4/AAC where WebM isn't supported).
  - The voice mic has its own device picker, separate from the DJ input.
  - In track mode, a "use headphones" note warns that the speakers will bleed the music into the take.
  - A take is placed where the playhead was when Record was pressed.
- **Import:** any `audio/*` file the browser can decode. It starts at 0:00 by default.
- **One voice track** for v2.1: a new take or import replaces the current one (confirmed if it would discard a recording).
- **As built:** the Voice and Music controls live in the **01 Audio** tab. A red **REC mm:ss** badge shows in the transport bar while recording. An imported file's start can be nudged with **Starts at** (seconds). **Verified:** a 3.2 s take recorded at the 12.7 s playhead was placed at 12.7 s; re-importing over an undownloaded take asked first.

### D-40 · Normalize is non-destructive *(Accepted — built in step 6)*
- **Decision:** On load, the voice is decoded once (`decodeAudioData`) and two numbers are measured: speech loudness (RMS gated to skip silence) and peak. **Normalize** (on/off) sets `normGain` so speech sits at about −16 LUFS-equivalent, capped so the peak stays ≤ −1 dBFS. **Volume** (0–150 %) multiplies on top.
- **As built:** "−16 LUFS-equivalent" is approximated as −16 dBFS gated RMS (no K-weighting), which is close for speech. **Verified:** the applied gain equals `normGainFor(stats)`.
- **Why:** Volume and Normalize work independently of the music, as the brief asks. The original file is never rewritten. Normalize can be switched off to get the raw take back, and nothing is re-encoded.

### D-41 · Voice lane on the timeline *(Accepted — built in step 6)*
- **Decision:** A **Voice** row below the clip lane shows the voice waveform at its offset, using the same peaks approach as `loadTrackWaveform` (D-14). `TimelinePanel.ROWS` gains `voice`, and the matching `.ch-voice` height goes in CSS (D-15 invariant). The row is only drawn when a voice track exists.

### D-42 · Modular tab sidebar *(Accepted — built in step 3a)*
- **Decision:** Each sidebar section becomes a **tab** that slides its panel open. The whole sidebar collapses to a **tabs-only rail** (number + short label) and expands again; the open tab and collapsed state are remembered in localStorage (try/catch, per D-21 practice). New order:
  - **01 Audio:** source, device, start and fullscreen, plus **Visualization** (mode select) folded in.
  - **02 EQ:** the three channel strips, in their own slide-out.
  - **03 Assets:** the asset bin (D-44), replacing Media Layers.
  - **04 Output:** pop-out.
  Sections are built as modules, so adding or reordering a tab is a one-place change.
- **Why:** More room for the viewport and the editor. "Blender growth, Canva complexity": panels can be added later without the sidebar growing into a scroll.
- **Consequences:** Element IDs inside the sections stay the same (invariant 3), so `app.js` and `visualizer.js` wiring is untouched. The p5 canvas must resize when the sidebar collapses; the existing `ResizeObserver` (D-21) covers that.
- **As built:** clicking the open tab also collapses to the rail (as well as the « button); clicking any tab while collapsed slides its panel out. The topbar brand no longer tracks the sidebar width. **Verified:** canvas 1287 → 1539 px on collapse; tab and collapsed state survive a reload.

### D-43 · Status becomes a viewport overlay *(Accepted — built in step 3b; per-asset status lands in step 4b)*
- **Decision:** The **Status** section (Device, BPM + beat indicator, FPS) leaves the sidebar and becomes a **semi-transparent overlay in the top-right of the viewport**, styled like the old sidebar Status rows. Its IDs (`deviceStatus`, `bpmCounter`, `beatIndicator`, `fpsCounter`) move with it. The existing top-left `#viewportHud` (clip now showing) stays, restyled to match. Per-asset status (type, duration, resolution, decoded / ERR, ON AIR, layer or clip role) shows **under the selected asset** in 03 Assets.
- **Why:** Status is something you read while watching the picture, so it belongs on the picture. Asset status belongs with the asset.
- **Consequences:** The overlay is in the control window only; the pop-out stays canvas-only. FPS now reads as a bare number, since its row is labelled (same as BPM, D-20).

### D-44 · 03 Assets = the real asset bin, with per-item properties *(Accepted — built in step 4)*
- **Decision:** 03 Assets has a single drop zone + chooser for **images and video**, and a list of every asset with thumbnails. **Selecting** an asset shows its properties where the Bass/Mid/High upload slots used to be. The fields change with the item:
  - **Use as:** Auto-edit clip (default) and/or **Media Layer** slot (Background · Bass · Mid · High). Layer fields: enabled, justify, stack (bass/mid/high only), same behaviour and conflict-swap as today.
  - **Clip fields** (when used as a clip): Band tag, Pace (D-31), Importance (D-32).
  - **Story Position** (Story Mode on, D-33). This hides Pace and Importance.
  - **Status** (D-43). Remove.
- **Why:** One place to bring media in, and one place for every per-item action, instead of fixed upload slots plus a separate clip bin. The image engine from Media Layers is reused, not rebuilt.
- **Consequences:**
  - `DJVisualizer.layers` and `loadLayerMedia()` / `clearLayerMedia()` stay the engine. The asset bin calls them, so layer rendering, rattle and auto-justify are unchanged. The fixed `layerUpload-*` inputs go away, which is a deliberate exception to invariant 3. The `layerEnabled/Justify/Stack-*` controls move into the properties panel (keep the IDs if practical).
  - `output.js` loads its own copies of layer media, so check how it finds the files and keep the pop-out working.
  - Video assets are created once and shared, not decoded twice for clip and layer use, if the p5 media object allows it. Otherwise this is documented.
- **As built:**
  - **A video used as both clip and layer is decoded twice.** `loadLayerMedia(slot, file)` creates its own p5 media from the file, and sharing would mean changing that function. The brief says to keep it as the layer engine unchanged, so the cost (one extra decoder for that asset) was accepted. Images are cheap to load twice.
  - Assigning a layer slot uses `loadLayerMedia` as-is, so it still switches the view to Media Layers mode (except from Clip Auto-Editor mode, D-05), the same as uploading into a slot did before.
  - `visualizer.js` needed no edit: its `init()` already null-checks the removed inputs.
  - The first asset of a new upload is selected automatically, so its options show at once.
- **Verified (real files):** chooser + drag/drop; per-kind fields; Background / Bass / Mid layers render as before in the control window and the pop-out; enable + stack-swap through the panel; Remove releases the slot.

### D-45 · The bottom Bin becomes the Action Editor *(Accepted — built in step 5; story markers land in step 7c)*
- **Decision:** The bottom "Bin" row becomes the **Action Editor** (Blender's Action Editor analogue). It shows the auto-edit sequence: every asset used as a clip, as an **ordered stack** of cards. Selecting a card selects that asset everywhere and shows the same properties (D-44). **Dragging a card to a new position sets its Importance to that position** (D-32). Story blocks (Story Mode on) appear as fixed Hook / Result / CTA markers at the ends, not in the stack. Adding media happens in 03 Assets; dropping files onto the Action Editor still works as a shortcut.
- **Why:** It keeps the simplicity of the bin row while making it the place where the sequence is shaped. That's "more useful while maintaining simplicity".
- **As built:** cards show the stack number, thumb, length ("Still" for images) and tags (kind, Pace if set, band if set, layer). Clicking a card selects it and opens 03 Assets. The per-card Band/Pace menus and ✕ moved to the asset properties panel (D-44). Keyboard: Alt+←/→ moves the focused card, Enter selects it. The stack is horizontal, so the codemap's Alt+↑/↓ became ←/→.
- **Future:** see the roadmap Phase 1.4 note. On the action line, Importance becomes overlap-driven crossfade (fractional Importance, e.g. 1 vs 1.000…).

### D-46 · Images play as auto-edit clips *(Accepted — built in step 5d)*
- **Decision:** An image used as a clip holds for its Pace like a video, with no motion (motion is Phase 1.1). It is drawn cover-fit through the same `drawClip` path and transitions. "Random in-point" and "resume" don't apply to images.
- **Why:** The brief's "regular video/image clips". It reuses the image loading Media Layers already does.
- **Verified:** an image on Relaxed held 8 beats while Global clips held 3, on the same beat grid; the viewport HUD shows "In: Still".

### Open questions (block the steps shown)

*Resolved by Omar 2026-10-02:* **Q5** images → yes, through the asset bin (D-44, D-46). **Q6 / Q7** → no musical labels; keep the Pace lexicon (D-31). **Q8** → Importance = stack position (D-32).

| # | Question | Proposed answer | Blocks |
|---|---|---|---|
| **Q9** | Story block length and sound: does a video block play its full length with its own audio? How long does an image block hold? | **Video:** full length, once, **with its own audio** (that's what the music fades make room for). **Image:** holds 3 s, editable in its properties. ***Accepted** (built in step 7)* | 7b |
| **Q10** | Do story blocks sit *on* the song (music continues underneath, D-34), or does the song **pause** while a block plays? | **On the song** (overlay). Pausing breaks the beat clock and seek, and amounts to a second timeline. ***Accepted** (built in step 7)* | 7b, 7d |
| **Q11** | Story Mode in live mode, where the end isn't known? | **Hook auto on Start; Result and CTA fired by buttons** (D-35). ***Accepted** (built in step 7)* | 7b |
| **Q12** | Fade shape: fade to silence, or duck to a lower level? Length? | **Fade to silence, 1 bar out / 1 bar in**, a single on/off toggle. ***Accepted** (built in step 7)* | 7d |
| **Q13** | Where does a voice track start? | **Recorded:** at the playhead when Record was pressed. **Imported:** at 0:00, with a start-offset nudge. ***Accepted** (built in step 6)* | 6b–6c |
| **Q14** | A recorded take is lost on reload (nothing persists). Add a "Download take" button? | **Yes**, one button. ***Accepted** (built in step 6)* | 6c |
| **Q15** | Is stack position 1 the *most* important (picked most often)? And should Random stay uniform until the user reorders? | **Yes, 1 = top = most weight** (`N − pos + 1`). Weighting is on from the start, since the stack is visible. ***Accepted** (built in step 5c) — but see the conflict noted in D-32* | 5c |
| **Q16** | Can one asset be both an auto-edit clip and a Media Layer at once? | **Yes.** "Use as" is two independent switches. ***Accepted** (built in step 4)* | 4c |

### D-47 · v2.1 verification (step 8)
One fresh session per check, with real files: the six test WebMs, CREAM (97 BPM, 195.5 s), an imported MP3 as voice, and Chrome's fake mic for a recorded take.

| Exit criterion | Result |
|---|---|
| Defaults identical to v2 | Same default session on the pre-v2.1 build (`11bbba1`) and on v2.1: same order ABCD…, same 2-beat grid from beat 0, settings identical apart from the two new Story flags (off), music bus at 1, no voice. The baseline stepped to 3-beat holds mid-run because the untouched detector read 146 BPM there (108 in the v2.1 run); that is detector variance, not a v2.1 change. **Exception, flagged:** Random / By band are weighted by the stack (Q15/D-32) |
| 03 Assets + Media Layers | Chooser and drag/drop; per-kind fields; an asset drives the Bass layer through `loadLayerMedia`; pop-out still mirrors layers |
| Sidebar + Status overlay | Collapse to rail: canvas 1287 → 1539 px; tabs reopen; state survives reload; overlay reads device / BPM / FPS |
| Pace + Importance | Mixed paces (Relaxed / Frantic / Global) cut only on whole master beats; reorder renumbers the stack; 6000 Random picks 1525 / 1322 / 1182 / 947 / 677 / 347 |
| Story Mode | All four orderings placed and played at their block times; fill never contains a story asset; each block once per pass (HOOK … RESULT CTA, counts 1 / 1 / 1); Free Mode removes blocks and keeps roles |
| Auto Fade Music | 0 inside blocks, 0.58 partway into a 1-bar fade, 1 elsewhere; BPM/bands keep updating; off → untouched |
| Voice | Within 10 ms of the master through play / seek / pause / stop; Volume + Normalize; mute music → voice only with BPM 120 still reading |
| Voice vs clip timing | Pace on every clip + a reorder during playback: voice offset unchanged, no nudges, drift −8 ms |

**Noted, not changed (outside v2.1):** the frozen BPM detector reads this 97 BPM song as anything from 97 to ~146 BPM in different runs. It's in `audioProcessor.js`, so it stays as is; offline song analysis (roadmap Phase 1.2) is the planned fix.

### Not changing in v2.1 (boundary check)
- No export or render (Q3 stays "live playback only"). "Voice-only result" means voice-only **playback** until Phase 3 export, which will mix voice and the music bus.
- No plan model, no drag-to-place story blocks (the brief: "the user does not need a second timeline").
- No new transitions or visual modes. Layout changes are limited to D-42–D-45 (tab sidebar, status overlay, asset bin, Action Editor). The aesthetic pass is a separate step.

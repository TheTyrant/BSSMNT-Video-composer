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

## I. Known carry-overs (pre-existing on `main`, not changed)
- Placeholder text drawn with `p.text()` in WebGL mode doesn't render, because no font is loaded (affects the Media Layers "Upload images…" prompt). v2 uses a DOM overlay for its own hints.
- `visualizer.js` has duplicate `drawAudioWaves` / `drawMandala` / `drawTunnel` definitions (the later ones win), plus unused snake-game code.
- `app.js` defines `switchVisualizationMode` twice (the string version wins) and has an unused `setupKeyboardShortcuts`.
- `README.md` clone URL still points at `philaconvalley/djVisualizer`.

## J. v2.1 — the three final changes *(proposed, 2026-10-02)*

Spec: [brief-v2.1.md](brief-v2.1.md). Build order: [roadmap.md › v2.1](roadmap.md#v21--creator-essentials--now). Code plan: [codemap.md §4.0](codemap.md#40-v21--creator-essentials-).

Everything in this section is **Proposed**. Each entry becomes *Accepted* (or is rewritten) when its build step lands. The open questions at the end block specific steps. Answers will be recorded here.

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

### D-33 · Story assets leave the automated pool; Free Mode ignores positions *(Accepted — built in step 7)*
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

### Not changing in v2.1 (boundary check)
- No export or render (Q3 stays "live playback only"). "Voice-only result" means voice-only **playback** until Phase 3 export, which will mix voice and the music bus.
- No plan model, no drag-to-place story blocks (the brief: "the user does not need a second timeline").
- No new transitions or visual modes. Layout changes are limited to D-42–D-45 (tab sidebar, status overlay, asset bin, Action Editor). The aesthetic pass is a separate step.

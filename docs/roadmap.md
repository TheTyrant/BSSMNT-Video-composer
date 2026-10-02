# Roadmap — from DJ visualizer to assisted music-video creation

**Product direction:** *"Blender growth model with Canva level complexity."* BSSMNT streamlines video production for **DJs, social media content creators and video hobbyists**. It aims for Blender's growth path: a serious editor that grows feature by feature, built on one consistent model. It keeps Canva's level of complexity: every feature has to be usable by someone who has never opened an NLE. When the two conflict, the simpler control wins, and the depth goes behind it (defaults first, detail on demand).

**Where this is going:** an assisted music-video tool that works in two modes from one timeline:

- **Production:** load a song and a bin of video clips and still images; the system places them along the song's structure; the creator refines the result and renders a finished video.
- **Realtime editing:** the same engine runs live off a DJ set or mic, cutting on the beat, with the performer able to steer it and keep what they played as an editable timeline.

"Assisted" means the system does the first pass (placement, timing, transitions from the music) and the creator stays in control of every decision it makes.

Module and function plans for each phase are in [codemap.md §4](codemap.md#4-planned-functions-by-roadmap-phase). Reasoning for what exists today is in [decisions.md](decisions.md).

> No dates are set. Phases are ordered by dependency; each has exit criteria so "done" is testable.

---

## Phase 0 — v2: beat-locked clip auto-editor ✅

What exists on the `v2` branch:
- Light brutalist UI: sidebar, black viewport, and a bottom editor with a master timeline, clip lane, clip bin and Auto-Editor panel.
- Video clips in a bin, switched in sync with the music on the existing BPM beat clock.
- Musical timing: auto (single/double/triple time by tempo) or manual (every N × 1/16 … bar/measure), 4/4.
- Transitions: jump cut, crossfade, blur (extensible registry), chosen automatically by band or fixed.
- Clip order: sequential, random, or by dominant band.
- Timeline modes: track (bounded, seekable) and live (unbounded).
- Media Layers, and all existing visual modes, preserved.

**Limits that shape the next phases:**
- Video only; still images can't go in the clip bin yet.
- The edit is recorded as it plays, so it can't be planned ahead, edited or replayed. Seeking back regenerates it.
- Timing comes from a realtime BPM metronome, so phase can drift from the actual kick, and it takes a few beats to lock.
- No export. The pop-out window doesn't show clip mode.
- Nothing persists between sessions.

**Open decisions carried forward** (defaults are in place; see decisions.md §E):
- Q1 keep both timeline modes?
- Q2 default transition policy?
- Q3 export format?
- Q4 default clip order?

---

## v2.1 — Creator essentials ✅ *(steps 0–8 built and verified 2026-10-02; step 9, aesthetics, is next)*

**Spec:** [brief-v2.1.md](brief-v2.1.md) asks for three changes: **per-clip timing + Importance**, **Story Mode**, and **Voice record/import**. Omar then added the **workspace changes** below (2026-10-02, D-42–D-46). After that comes an aesthetic pass, and then the roadmap resumes at Phase 1.

**Workspace changes added by Omar:**
- **Per-clip timing keeps the existing Pace lexicon** (Global · Frantic · Driving · Relaxed · Phrase), the same values the main Auto-Editor cuts already use. No 4/4, 4/2 or other musical labels. Already built (D-30/D-31).
- **Sidebar becomes modular tabs:** each section is a tab that slides its panel out, and the whole sidebar can collapse to a tabs-only rail. **01 Audio** (Visualization folds in here) · **02 EQ** · **03 Assets** · **04 Output**.
- **Status leaves the sidebar** and becomes a semi-transparent overlay in the top-right of the viewport, styled like the old sidebar Status. Per-asset status shows under the selected asset.
- **03 Assets (was Media Layers) becomes the real asset bin:** drag/drop or choose images and video. Selecting an asset shows *its* options where the Bass/Mid/High layer controls were. The options change with the item (image/video, auto-edit clip or Media Layer, story asset). Media Layers keeps working as an option on an asset.
- **The bottom "Bin" becomes the Action Editor** (like Blender's): the auto-edit sequence as a stack. Selecting an item gives the same per-item options, and **dragging to reorder sets Importance to the item's place in the stack**.

**Boundary:** no other new features. The master timeline and the existing beat clock stay the only source of timing. Every new control defaults to today's behaviour.

Function-level plans are in [codemap.md §4.0](codemap.md#40-v21--creator-essentials-). Interpretations and open questions (Q9–Q16 still open) are in [decisions.md §J](decisions.md#j-v21--the-three-final-changes-proposed-2026-10-02).

### Build order

Steps are ordered by dependency. Each ends with a working app and a docs update.

| Step | Group | What | Depends on |
|---|---|---|---|
| **0** ✅ | Housekeeping | Commit the test-round fixes (D-27–D-29) and per-clip Pace (D-30), so v2.1 starts from a clean tree | — |
| **1** ✅ | Docs | This plan: brief saved, roadmap, codemap §4.0, decisions §J | — |
| **2** ✅ | Foundation | **2a** Asset model: one list of typed assets (`kind: video/image`) with `role` (clip / layer), `band`, `pace` ✅, `importance`, `story` (defaults = today). **2b** Music bus: a gain node *after* the analyser in `TrackSource` | 0 |
| **3** ✅ | Sidebar | **3a** Modular tab sidebar: 01 Audio (+ Visualization) · 02 EQ · 03 Assets · 04 Output, slide-out panels, collapsible to a tabs-only rail (state remembered). **3b** Status → semi-transparent viewport overlay (top-right); removed from the sidebar | 0 |
| **4** ✅ | Asset bin | **4a** 03 Assets: drag/drop + chooser for images and video, asset list, selection. **4b** Selected-asset properties panel (replaces the Bass/Mid/High upload slots); options change per item; per-asset status under it. **4c** Media Layers become an asset option (background / bass / mid / high + enabled, justify, stack), driving the existing `loadLayerMedia` engine | 2a, 3a |
| **5** ✅ | Action Editor + ① | **5a** The bottom Bin becomes the Action Editor: the auto-edit sequence as an ordered stack; selecting an item opens the same properties. **5b** Drag to reorder → Importance = place in the stack. **5c** Importance weights `choose()`; Sequential plays in stack order. **5d** Images play as auto-edit clips (hold = Pace). Per-clip Pace already done (D-30) | 4 |
| **6** ✅ | ③ Voice | **6a** `VoiceTrack` on its own chain. **6b** Import. **6c** Record. **6d** Volume + Normalize. **6e** Music mute (uses 2b). **6f** Voice lane on the timeline | 2b |
| **7** ✅ | ② Story Mode | **7a** Story Mode toggle + Story Position in asset properties. **7b** Story assets leave the automated pool; Hook / Result / CTA placement. **7c** Story blocks on the clip lane. **7d** Auto Fade Music (uses 2b) | 2b, 5 |
| **8** ✅ | Verify + docs | End-to-end test of every Story combination, voice + music + mute, Importance reorder, sidebar collapse; update codemap/decisions; screenshots | 3–7 |
| **9** | Aesthetics | Visual pass (separate brief) | 8 |

The workspace (3–5) comes first because every per-item control from ①–③ lives in the asset properties panel. Voice (6) is independent. Story Mode (7) has the most open questions, so it goes last.

### Exit criteria
Verified in step 8 with real files (the six test WebMs, the CREAM 97 BPM instrumental, an imported MP3 voice, a fake-mic take). Details in [decisions.md D-47](decisions.md#d-47--v21-verification-step-8).
- [x] With every new control at its default, cuts, clip order and audio are identical to v2. *Same session run on the pre-v2.1 build and on v2.1: same order (ABCD…), same beat grid, music bus at 1, no voice. **One flagged exception:** Random / By band order is now weighted by the stack (Q15, see D-32).*
- [x] Images and videos go into 03 Assets by drag/drop or chooser. Selecting one shows only the options that apply to it. Any asset can still drive a Media Layer exactly as before.
- [x] Sidebar tabs open and close their panels, the sidebar collapses to a tab rail and back, and Status reads correctly in the viewport overlay.
- [x] Each clip has a Pace and an Importance. Cuts stay on the master beat grid. Reordering the Action Editor stack updates Importance, and higher-Importance clips are chosen measurably more often. *(6000 Random picks: 1525 / 1322 / 1182 / 947 / 677 / 347 by stack position.)*
- [x] In Story Mode, all four Hook / Result / CTA combinations in the brief place correctly, each story asset appears exactly once, and story assets never appear in the automated fill.
- [x] Auto Fade Music fades the music around each story block when on, and does nothing when off. BPM and bands keep tracking during a fade.
- [x] Voice can be recorded or imported, has its own volume and Normalize, and plays in sync on seek, pause and stop. Muting music leaves voice only.
- [x] Changing any clip's timing or Importance never changes the voice track.

Screenshots: [assets panel](screenshots/v2.1-assets-panel.png) · [Action Editor](screenshots/v2.1-action-editor.png) · [Story Hook](screenshots/v2.1-story-hook.png) · [Story end](screenshots/v2.1-story-end.png).

---

## v2.2 — Workspace rework ✅ *(2026-10-02, decisions section K)*

Supersedes parts of the v2.1 layout (the v2.1 table below describes it as it was first built):
- **Tabs-only sidebars** (no rail, closed by default, one left panel at a time): **01 Audio · 02 Assets · 03 Output** on the left, **AE Auto-Editor** on the right. The timeline runs the full width underneath (D-48).
- **Track mutes** (M) on Master and Voice; muted tracks will be left out of exports (D-49).
- **Header pickers:** SRC / MODE dropdowns with an icon per mode and an activity light (D-50).
- **EQ inside 02 Assets:** Sensitivity / Dynamic tabs with Use = Sensitivity, Dynamic or Blend; Dynamic is an analysis-only EQ (D-51).
- **Shortcuts** (D-52), **drag-and-drop** anywhere sensible (D-53), **timeline drops reach the bin + rotated phone video fix** (D-54).

---

## v2.3 — Offline export ⬜ *(next; design agreed 2026-10-02, decisions D-55)*

**Goal:** export the finished video faster than real time, matching what was seen, with muted tracks left out.

| Step | What |
|---|---|
| 1 🟡 | **Speed test** on real files: decode, draw each visual mode, encode at 1080p. *Built (`test-assets/render-speed.html`) and run here: 3.6–4.3× real time for the full clip pipeline; every mode faster than real time except Mandala (0.77×, fix: batch its lines). Still to run on Omar's machine.* |
| 2 ✅ | **Session record + .mnt project files:** the cut list is kept across seeks with punch-in overwrite; per-frame analysis log; projects save/open as `.mnt` with linked media and reconnect (D-56, D-57) |
| 3 | **Renderer (all visual modes):** frame loop at the export frame rate replaying the record through the existing drawing code (Spectrum Bars gets a canvas version); clips decoded frame-accurately (WebCodecs via Mediabunny, rotation from D-54); GPU encode; audio mixdown with mutes, fades, voice and story sound; streamed to disk with progress, time left and cancel |
| 4 | **Output panel:** format (MP4 H.264+AAC / WebM), size (16:9, 9:16, 1:1 at 720p/1080p/4K), frame rate, quality, range |
| 5 | **Fast pass:** the same frozen analysis run over a track or recorded set at high speed, filling the record without real-time playback |
| 6 | **Firefox / Safari fallbacks:** OPFS output + download, WebAssembly audio encoding where needed |

**Exit criteria:**
- [ ] An export matches the live session's cuts, in-points, transitions and audio-reactive motion.
- [ ] Muted tracks are absent from the exported audio; unmuted voice and story sound are present and in sync.
- [ ] A 3-minute 1080p export finishes faster than real time on the target machine; a 2-hour project exports without running out of memory.
- [ ] Every visual mode exports.

---

## Phase 1 — Systematic placement of video + stills along the song ⬜ *(after v2.1)*

**Goal:** drop video clips **and static images** into the bin as today, and have them **systematically placed along the time of the song**, as a plan you can see, edit and replay, not just a live recording.

### 1.1 Stills become first-class
- *(v2.1 step 5d already lets images play as clips, holding for their Pace. Phase 1 adds motion and plan-driven durations.)*
- The bin accepts images alongside video, as one typed asset list (video / image).
- Stills get a duration from the placement plan, plus motion so they read as footage: Ken Burns, push-in, pan, and a beat "punch" on downbeats.
- Thumbnails for both kinds; filmstrips for video.

### 1.2 Understand the song before playing it (track mode)
- An offline analysis pass on load (in a worker, separate from the frozen realtime processor) finds:
  - beats and downbeats, so bar 1 is really bar 1;
  - song sections (intro / verse / build / drop / breakdown / outro);
  - energy and per-band curves.
- A section lane on the timeline shows the analysis, and the user can correct section boundaries.
- Live mode keeps the realtime beat clock; it has no future to analyse.

### 1.3 Placement engine
- Builds a full plan over the song: which asset goes where, for how long, with which in-point and transition.
- Rule inputs, all adjustable, building on today's settings:
  - **Section → pool:** e.g. the drop pulls from "high-energy" clips; the verse from stills.
  - **Energy → cut density:** faster cuts where energy rises, longer holds in breakdowns. This extends today's auto pace.
  - **Band → transition:** today's map, applied at plan time.
  - **Variety:** avoid repeats, spread assets evenly, respect the minimum shot length.
  - **Stills vs. video balance:** e.g. a ratio or per-section preference.
- Deterministic with a seed: **Re-roll** produces a new plan, and the same seed produces the same plan.

### 1.4 The plan is the timeline

> **Future build note (Omar, 2026-10-02): Importance becomes overlap.** Once clips sit on the Action Editor's line as placed blocks, Importance stops being only a stack rank and also works as **automatic crossfade**. Where two clips overlap on the action line, the overlap sets a fractional Importance (e.g. 1 vs 1.000…) that weights the blend between them. The more they overlap, the closer their weights and the longer the crossfade. Design this together with the plan model and the blend system (transitions registry, D-12).

- The clip lane shows the plan before playback.
- Edit it directly: drag to move, trim edges, split, swap asset, change transition, and **lock** a segment so re-rolls keep it.
- Re-roll a selected range only.
- Playback replays the plan exactly, so seeking back no longer regenerates it. Undo/redo throughout.

### 1.5 Keep the work
- Save and load a project: song reference, bin references, plan, settings and seed. Media stays on the user's disk; missing files can be relinked.

**Exit criteria:**
- [ ] A song plus a mixed bin of videos and stills produces a complete plan in seconds, visibly aligned to sections and downbeats.
- [ ] Re-roll, lock and range re-roll work; the same seed gives the same plan.
- [ ] Manual edits survive playback and seek, and undo/redo covers them.
- [ ] A project saved, closed and reopened plays back identically.
- [ ] Live mode still auto-cuts exactly as in v2.

---

## Phase 2 — Organise the bin, widen input/output for creators ⬜

**Goal:** make the bin workable at real project sizes (hundreds of assets), and let creators bring media in and get results out in the ways they already work.

### 2.1 Bin organisation
- Folders and collections; tags (today's bass/mid/high become ordinary tags alongside mood, colour, subject); ratings and favourites.
- Search, sort and filter; grid/list views; hover-scrub filmstrips; multi-select; drag from bin to timeline.
- Smart collections (e.g. "all stills tagged *night*", "clips over 5 s").
- Automatic metadata: duration, resolution, fps, orientation, dominant colour, motion amount. This feeds placement rules (e.g. high-motion clips for drops).

### 2.2 More inputs
- **Controllers:** MIDI mapping (the DDJ's pads and faders to cut / hold / next / interval / transition).
- **Live video sources:** camera and screen capture as bin assets.
- **Other apps:** OSC input (TouchOSC, Resolume, Ableton).
- **Import:** folder import, drag from OS, and (optionally) import from URL or cloud storage.

### 2.3 More outputs
- **Record:** real-time capture of the output canvas to a video file.
- **Hand-off to editors:** export the plan as an edit list (EDL / FCPXML / OpenTimelineIO) so creators can finish in Premiere, Resolve or Final Cut with the original media.
- **Stage:** pop-out output that mirrors clip mode (closes the v2 gap); desktop build adds NDI / Spout / Syphon for VJ software and streaming.
- **Stills:** export a frame or contact sheet.

**Exit criteria:**
- [ ] A 300-asset bin stays responsive; assets can be found in a few seconds by folder, tag or search.
- [ ] A DDJ controller can drive the live editor without touching the mouse.
- [ ] A plan exported to at least one NLE (via OTIO/FCPXML) opens with correct cuts and media links.
- [ ] Clip mode shows in the pop-out window on a second screen.

---

## Phase 3 — Production: render finished videos ⬜

**Goal:** the plan becomes a finished music video file, frame-accurate and not limited to real-time speed.

- Offline, deterministic renderer: every source is seeked to the exact frame time, so output is identical every render, and faster or slower than real time as the machine allows.
- Render settings: resolution presets (16:9, 9:16 vertical, 1:1), fps, quality; song audio muxed in.
- Compositor upgrade to shader-based transitions (true blur, luma wipes, glitch) and per-segment colour/LUT, so quality matches what creators expect from an editor.
- Title/text layers and simple overlays (artist, track name, lyrics timing as a later add-on).
- Progress, cancel, and render a selected range for previews.

**Exit criteria:**
- [ ] A 3–4 minute song renders to MP4 (and/or WebM) matching the timeline frame-for-frame, with synced audio.
- [ ] Vertical and horizontal renders come from the same project.
- [ ] The rendered output matches what the viewport shows during playback.

---

## Phase 4 — Realtime editing and performance ⬜

**Goal:** the same engine as an instrument: live cutting that a performer can steer, and a performance that becomes editable afterwards.

- **Performer overrides on top of the auto-editor:** punch in a specific asset, hold the current shot, queue next, force a cut, change interval on the fly.
- **Tighter sync:** follow Ableton Link or MIDI Clock when available, with latency compensation, instead of relying only on bass-onset BPM.
- **Record the performance:** a live set is captured as a timeline (Phase 1 model) that can be edited and rendered (Phase 3) afterwards. Live and production meet here.
- **Cue points and scenes:** prepared bin collections and settings switchable during a set.
- **Stage reliability:** multi-window output, no dropped frames at 1080p60 on target hardware, recovery if a source file stalls.

**Exit criteria:**
- [ ] A full DJ set can be performed with controller overrides, recorded, then opened as an editable timeline and rendered.
- [ ] Beat sync holds within a frame over a 60-minute set when Link or MIDI Clock is present.

---

## Cross-cutting tracks (run alongside the phases)

| Track | When | Notes |
|---|---|---|
| **Tooling:** Vite + TypeScript, unit tests for timing and placement math, UI tests | Start of Phase 1 | Placement logic is too important to leave untested; the script-tag setup won't scale |
| **UI framework** for editor panels (Svelte/SolidJS suggested) | During Phase 2 | Bin organisation is where hand-built DOM stops being maintainable |
| **Desktop build** (Tauri or Electron) | Phase 2 → 4 | Needed for NDI/Spout, native file access, Link; the web build stays for quick use |
| **Performance budget:** 60 fps viewport, timeline redraw under 4 ms | Always | Measure on the performance machine, not just dev laptops |
| **Constraint:** `audioProcessor.js` stays frozen | Always | New analysis lives in separate modules (decisions D-02, D-14) |
| **Docs:** update codemap and decisions each phase | Always | These three files are the project's memory |

---

## Sequencing at a glance

```
Phase 0  v2 auto-editor (live, video-only, recorded timeline)          ✅
   │
v2.1     tab sidebar · asset bin · Action Editor (Importance) · Voice · Story Mode   ✅  → aesthetics (step 9) ← now
   │         (story anchors, music bus and voice lane carry into the plan model)
Phase 1  stills + song analysis + placement plan + editable timeline    ⬜
   │         (the plan model unlocks everything below)
Phase 2  bin organisation + inputs (MIDI/OSC/camera) + outputs (record, NLE hand-off, pop-out)
   │
Phase 3  offline render/export (production)
   │
Phase 4  realtime performance on the same timeline (record set → edit → render)
```

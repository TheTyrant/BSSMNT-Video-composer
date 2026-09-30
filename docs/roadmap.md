# Roadmap — from DJ visualizer to assisted music-video creation

**Where this is going:** an assisted music-video tool that works in two modes from one timeline:

- **Production:** load a song and a bin of video clips and still images; the system places them along the song's structure; the creator refines the result and renders a finished video.
- **Realtime editing:** the same engine runs live off a DJ set or mic, cutting on the beat, with the performer able to steer it and keep what they played as an editable timeline.

"Assisted" means the system does the first pass (placement, timing, transitions from the music) and the creator stays in control of every decision it makes.

Module and function plans for each phase are in [codemap.md §4](codemap.md#4-planned-functions-by-roadmap-phase). Reasoning for what exists today is in [decisions.md](decisions.md).

> No dates are set. Phases are ordered by dependency; each has exit criteria so "done" is testable.

---

## Phase 0 — v2: beat-locked clip auto-editor ✅ *(current)*

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

## Phase 1 — Systematic placement of video + stills along the song ⬜ *(next)*

**Goal:** drop video clips **and static images** into the bin as today, and have them **systematically placed along the time of the song**, as a plan you can see, edit and replay, not just a live recording.

### 1.1 Stills become first-class
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
Phase 1  stills + song analysis + placement plan + editable timeline    ⬜  ← next
   │         (the plan model unlocks everything below)
Phase 2  bin organisation + inputs (MIDI/OSC/camera) + outputs (record, NLE hand-off, pop-out)
   │
Phase 3  offline render/export (production)
   │
Phase 4  realtime performance on the same timeline (record set → edit → render)
```

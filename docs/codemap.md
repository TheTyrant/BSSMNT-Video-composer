# Codemap — 1238 DJ Visualizer (v2)

Where things live, how data moves, and which functions own what. The second half maps the **planned** functions and suggested frameworks for each roadmap phase (see [roadmap.md](roadmap.md)). Reasoning behind current choices is in [decisions.md](decisions.md).

> Status legend: **✅ built** · **🟡 partial / stubbed** · **⬜ planned**

---

## 1. Repository layout

```
index.html                 Control window: sidebar, viewport, bottom editor panel
output.html                Pop-out output window (canvas only, for projector)
styles/
  styles.css               All app styling. Design tokens live in :root
app/
  audioProcessor.js        FROZEN — mic capture, FFT, band energy, BPM detection
  trackSource.js           Track-file playback routed through the frozen processor
  visualizer.js            p5 (WebGL) renderer, all visual modes, Media Layers, beat clock
  musicalTime.js           Beats / bars / measures math, 4/4 constant, auto tempo multiplier
  transitions.js           Transition registry (jump cut, crossfade, blur)
  clipEngine.js            Clip auto-editor: clip bin data, beat-locked switching, segment log
  timelinePanel.js         Bottom editor UI: master timeline, clip lane, bin, properties, HUD
  app.js                   App controller: wiring, audio source modes, master clock, shortcuts
  output.js                Pop-out window renderer (mirrors control window state)
test-assets/
  generate.html            Makes labelled test clips (WebM) + a 120 BPM test track (WAV) in-browser
docs/
  codemap.md · decisions.md · roadmap.md · screenshots/
netlify.toml · vercel.json Static deploy configs (vercel uses globs: *.html, app/*.js, styles/*.css)
```

**No build step.** Plain `<script>` tags, global classes, loaded in this order (order matters — later files reference earlier globals):

```
p5 (CDN) → audioProcessor → visualizer → trackSource → musicalTime → transitions → clipEngine → timelinePanel → app
```

External runtime dependencies: p5.js 1.9.0 (cdnjs), p5.asciify (unpkg, currently unused), Google Fonts (Boldonse, Inter Tight, JetBrains Mono — falls back to system fonts offline).

---

## 2. Runtime data flow

```
                ┌─────────────────────────── AudioProcessor (FROZEN) ───────────────────────────┐
 mic ──getUserMedia──►│ sourceNode → analyserNode (fft 1024)                                     │
 track ─TrackSource──►│ updateAudioData() [rAF loop]                                              │
                      │   → bandEnergy() → bass/mid/high → detectBeat() → bpm                     │
                      │   → onDataUpdate({ rms, bass, mid, high, spectrum, bpm, isActive })      │
                └──────────────────────────────────────┬─────────────────────────────────────────┘
                                                       ▼
                               DJVisualizerApp.onDataUpdate (app.js)
                               applies gain sliders (bass/mid/high × gain)
                                 │
          ┌──────────────────────┼─────────────────────────┬──────────────────────────┐
          ▼                      ▼                         ▼                          ▼
 DJVisualizer.updateAudioData   updateBPM / updateFPS     ClipEngine.update          TimelinePanel.onAudioFrame
 • stores audioData             (status readouts)         • reads viz beat clock     • records band energy history
 • BPM metronome:                                          • advances beat index
   lastBeatTime, bpmInterval,                              • cuts on interval slots
   beatFlash, beatPulse                                    • logs segments
          │                                                        │
          ▼                                                        ▼
 p5 draw loop → DJVisualizer.draw(p) ──mode 'clips'──► ClipEngine.draw(p) → ClipTransitions[id].render()
```

**Master timeline clock** (`app.masterTime()`): track mode = `<audio>.currentTime` (bounded by file duration); live mode = seconds since `startAudio()` (unbounded, frozen on stop).

**Beat clock source of truth:** `DJVisualizer.lastBeatTime` / `bpmInterval`, derived from `audioData.bpm`. The clip engine never detects beats itself.

---

## 3. Module reference (current code)

### 3.1 `app/audioProcessor.js` — `class AudioProcessor` — ✅ **FROZEN**
Must remain byte-identical to `main` (hard constraint). Read, never edit.

| Function | Role |
|---|---|
| `listInputs()` | Enumerate audio inputs, clean labels, sort DJ devices first |
| `isDJDevice(label)` / `isBuiltInDevice(label)` / `findDJInput(inputs)` | Device classification / auto-pick (Pioneer DDJ-REV1 first) |
| `startAudio(deviceId)` | getUserMedia → AudioContext → analyser (fft 1024, smoothing 0.3, −90/−10 dB) → start loop |
| `updateAudioData()` | rAF loop: FFT + time data → RMS, bands, `detectBeat()`, fires `onDataUpdate` |
| `bandEnergy(spec, sr)` | Bass = bins 0–12 %, Mid = 12–45 %, High = 45–100 % of spectrum, with multipliers |
| `calculateRMS(timeData)` | RMS level |
| `detectBeat()` | Bass-rise peak detection → interval history (6) → BPM, half-tempo doubling, smoothing |
| `stop()` / `getAudioData()` | Teardown / snapshot |

> Note: "High" = top 55 % of FFT bins ≈ above ~10.8 kHz at 48 kHz. Hi-hats below that register as Mid.

### 3.2 `app/trackSource.js` — `class TrackSource` — ✅
Plays an uploaded track through the frozen processor by assigning `audioContext / sourceNode / analyserNode / dataArray` on the processor instance and calling its `updateAudioData()`.

| Member | Role |
|---|---|
| `load(file)` | `<audio>` + MediaElementSource → analyser (**config mirrors `startAudio()` — keep in sync**) → speakers |
| `play()` / `pause()` / `seek(s)` | Transport |
| `unload()` | Pause element, `processor.stop()`, revoke object URL |
| `isLoaded` / `isPlaying` / `currentTime` / `duration` | State getters |

### 3.3 `app/visualizer.js` — `class DJVisualizer` — ✅
| Area | Functions |
|---|---|
| Setup | `init()` (mode select, layer inputs, p5 instance, **ResizeObserver** on viewport), `start()`, `stop()`, `destroy()` |
| Beat clock | `updateAudioData(data)` → `lastBeatTime`, `bpmInterval`, `beatFlash`, `beatPulse` |
| Frame | `draw(p)` — clears, switches on `currentMode`: `spectrum · particles · rings · waves · mandala · tunnel · galaxy · polygons · layers · clips` |
| Visual modes | `drawFloatingParticles3D`, `drawFrequencyRings3D`, `drawAudioWaves`, `drawMandala`, `drawTunnel`, `drawGalaxy`, `drawAudioPolygons` + `drawPolygonShape`, spectrum via `updateSpectrumBars` / `createSpectrumBars` (HTML bars) |
| Media Layers | `loadLayerMedia`, `clearLayerMedia`, `evaluateLayerSize`, `autoAssignJustify`, `setJustify`, `assignStackPosition`, `drawMediaLayers`, `drawReactiveLayers` (shared with clip overlay), `drawSingleLayer` (bass rattle) |
| Meters | `updateFrequencyDisplay()` → sidebar `.bass-fill/.mid-fill/.high-fill` heights |
| Legacy/unused | `drawSnakeGame` family, `drawCreativeVisuals`, `drawCenterPulse`, `drawFrequencyBars`, `drawFallbackParticles`, `hslToRgb`; duplicate `drawAudioWaves/drawMandala/drawTunnel` (later definitions win) |

### 3.4 `app/musicalTime.js` — `MusicalTime` (module object) — ✅
| Export | Role |
|---|---|
| `TIME_SIGNATURE` | `{ beatsPerBar: 4, noteValue: 4 }` — **the only place 4/4 lives** |
| `beatsPerBar()` / `beatsPerMeasure()` | Read the signature (bar == measure in 4/4) |
| `UNITS` | `sixteenth 0.25 · eighth 0.5 · beat 1 · half 2 · bar · measure` (beats) |
| `unitBeats(unit)` / `toBeats(count, unit)` | "every 2 bars" → 8 beats |
| `beatMs(bpm)` / `beatsToMs(beats, bpm)` | Convert at the last moment |
| `MULTIPLIERS` | Single / Double / Triple / Quad time, Two bars, Four bars |
| `AUTO_PACES` | `frantic 0.35s · driving 0.9s · relaxed 1.8s · phrase 3.6s` (min seconds per cut) |
| `autoMultiplier(bpm, pace)` | Shortest multiplier whose real length ≥ pace minimum |
| `describeBeats(beats)` / `barBeat(index)` | Labels ("2 bars") / DAW position (bar.beat) |

### 3.5 `app/transitions.js` — `ClipTransitions` (registry) — ✅
`register(id, { label, glyph, lengthBeats, render(p, t, from, to, draw) })`, `get(id)`, `list()`, `ids()`.

| id | lengthBeats | Render |
|---|---|---|
| `jump` | 0 | Incoming only |
| `crossfade` | 1 | Outgoing full, incoming fades up (ease in-out) |
| `blur` | 0.5 | Both clips smeared horizontally by offset low-alpha copies, bell-shaped over t |

Blend length is converted with live BPM and capped at 0.9 × switch interval (in `ClipEngine.cut`).

### 3.6 `app/clipEngine.js` — `class ClipEngine` — ✅
State: `clips[]`, `settings`, `bandTransitions`, `segments[]` (`{clipId, start, end, inPoint, transition, band, beat, blendSec}`), `beats[]` (`{time, index}`), `current`, `outgoing`, `pending`, `transition`.

| Function | Role |
|---|---|
| `addFiles(list)` / `addClip(file)` | Video only. p5 `createVideo`, muted/looping/hidden |
| `makeThumb(clip)` | Poster frame via separate `<video>`; also resolves `Infinity` durations (seek-to-end probe) |
| `removeClip(id)` / `setClipBand(id, band)` / `clipById(id)` | Bin management; band tag = `any · bass · mid · high` |
| `update(audioData)` | Per frame: `trackBands()`, detect viz beat edge → `beatIndex++`, compute position, cut on slot change, pre-roll |
| `intervalBeats(bpm)` | Auto (`autoMultiplier`) or manual (`toBeats(count, unit)`) |
| `trackBands(d)` | Dominant band = highest ratio of value ÷ its own running average, with hysteresis |
| `choose()` | Next clip: `sequential` · `random` · `band` (pool by tag → `any` → all) |
| `prepare(clip, …)` | In-point (`random · resume · start`), seek, play |
| `cut(bpm, interval)` | Close segment, open new, pick transition (`band` map or fixed), start blend |
| `retire(clip)` | Save `lastPos`, pause unless current/pending |
| `seekTo(s)` | Truncate segments/beats after `s`, force cut next frame |
| `setActive(bool)` / `pauseAll()` / `reset()` | Lifecycle |
| `draw(p)` | Cover-fit clip render, active transition render, optional Media Layers overlay |
| `status()` / `nowShowing()` / `beatPhase()` | For UI |
| `on(fn)` / `emit(type)` | Events: `clips · cut · beat · seek · reset` |

### 3.7 `app/timelinePanel.js` — `class TimelinePanel` — ✅
Single 2D canvas redrawn ~30 fps. Row heights `ROWS = { ruler 28, master 72, clips 64 }` **must match** `.ch-*` heights in `styles.css`.

| Function | Role |
|---|---|
| `init()` | Wire transport, props, bin, canvas, splitter; start `loop()` |
| `onAudioFrame(d)` / `resetSession()` | Band energy history (truncates on seek-back) |
| `loadTrackWaveform(file)` | Separate decode (OfflineAudioContext) → 2400 min/max peaks. Drawing only |
| `initProps()` / `syncProps()` / `updateReadout()` | Auto-Editor panel ↔ `engine.settings` |
| `initBin()` / `renderBin()` / `markShowing()` | Bin cards, drag-drop, ON AIR badge (polled in `loop()`) |
| `initCanvasInteraction()` | Track mode: click/drag seek, wheel pan, Ctrl/Cmd+wheel zoom, dbl-click fit |
| `initSplitter()` | Resizable editor height (localStorage, try/catch) |
| `updateView()` | Track = fit/zoom window; Live = rolling 30 s window |
| `updateHeader()` / `updateHud()` | LCD readouts, mode badge, summary; viewport HUD + hints |
| `draw()` → `drawRuler` · `drawMaster` · `drawClips` · `drawTransitionMark` | Ruler, waveform + energy, beat/bar grid, segments, ghost cut markers, playhead |

### 3.8 `app/app.js` — `class DJVisualizerApp` — ✅
| Area | Functions |
|---|---|
| Boot | `init()` — DOM refs, listeners, shortcuts, `onDataUpdate` fan-out, `timeline.init()` |
| Devices | `checkAudioPermissions`, `populateAudioDevices`, `onDeviceSelectionChange`, `restartAudioWithNewDevice` |
| Source modes | `setAudioSourceMode('mic'|'file')`, `loadAudioFile(file)`, `wireDropZone` |
| Transport | `toggleAudio`, `startAudio`, `stopAudio`, `transportStop`, `setStartButton` |
| Master timeline | `isTrackMode`, `masterTime`, `timelineRolling`, `resetSession`, `seekMaster` |
| Misc | `setupGainControls`, `resetGains`, `updateBPM`, `updateFPS`, `toggleFullscreen`, `toggleHelp/hideHelp`, `switchVisualizationMode`, `destroy` |

Global `var djApp` (must stay `var` — `output.js` reads `window.opener.djApp`).

### 3.9 `app/output.js` + `output.html` — 🟡
Pop-out canvas. Proxies the control window's `DJVisualizer` and loads its own copies of layer media (p5 textures can't cross renderers). **Clip mode is not mirrored** — shows a notice.

### 3.10 `styles/styles.css` — ✅
Tokens in `:root`: `--surface #EDEAE4 · --panel #E3DFD7 · --steel #D7DADC · --ink #1A1A1A · --bass/--mid/--high · --live`, fonts `--font-logo` (Boldonse, `.brand-mark` "BSS / MNT") · `--font-ui` · `--font-mono`, layout `--topbar-h · --sidebar-w · --editor-h`. Viewport stays black.

### 3.11 Invariants
1. `audioProcessor.js` is never modified.
2. No code outside `musicalTime.js` hard-codes beats-per-bar.
3. Element IDs used by `app.js` / `visualizer.js` are stable (see `index.html`).
4. Timeline row heights in JS and CSS match.
5. New transitions go through `ClipTransitions.register()`, never inline in the engine.

---

## 4. Planned functions by roadmap phase

Names below are proposed signatures, not existing code. Framework suggestions are **suggestions**, to be confirmed as decisions when adopted.

### Phase 1 — Systematic placement of video + stills along the song ⬜

**Goal:** everything in the bin (video *and* still images) is laid out along the song's timeline by the system, then editable.

| Module (proposed) | Functions | Notes |
|---|---|---|
| `app/assets.js` — `AssetStore` | `addFiles(files)`, `addStill(file)`, `addVideo(file)`, `probe(asset)` → `{duration, width, height, hasAlpha}`, `thumbnail(asset, t)`, `filmstrip(asset, n)`, `remove(id)` | Generalises `ClipEngine.clips` to typed assets `{id, kind: 'video'|'image', …}` |
| `app/stillRenderer.js` | `drawStill(p, asset, t, motion)`, motions: `kenBurns`, `pushIn`, `pan`, `beatPunch` | Gives stills duration + motion so they behave like clips |
| `app/songAnalysis.js` — `SongAnalyzer` | `analyze(file)` → `{bpm, beats[], downbeats[], sections[], energyCurve, bandCurves}`; `detectDownbeats()`, `detectSections()` (intro/verse/drop…), `energyAt(t)` | **Offline, separate from AudioProcessor** (same pattern as `loadTrackWaveform`). Live mode keeps using the realtime beat clock |
| `app/placement.js` — `PlacementEngine` | `buildPlan(song, assets, rules)` → `Segment[]`; `ruleSectionPool(section)`, `ruleCutDensity(energy)`, `ruleTransitionForBand(band)`, `fillGaps()`, `avoidRepeats()`, `reroll(range)` | Deterministic given a seed, so a plan can be regenerated identically |
| `app/timelineModel.js` — `Timeline` | `segments`, `insert`, `move`, `trim`, `split`, `lock(id)`, `setTransition(id, t)`, `toJSON()` / `fromJSON()`, `undo()` / `redo()` | Source of truth; `ClipEngine` becomes a *player* of this model instead of recording as it goes |
| `ClipEngine` changes | `playPlan(timeline)`, `segmentAt(t)`, `prerollNext(t)`; live mode keeps `update()` auto-cutting | Fixes "seek back regenerates" — replays the plan |
| `TimelinePanel` changes | segment drag/trim handles, lock icon, section lane, still vs video block styling | |
| `app/project.js` | `saveProject()`, `loadProject()`, `relinkMissingMedia()` | Media stays local; project stores references + hashes |

Suggested frameworks:
- **Song analysis:** [Essentia.js](https://mtg.github.io/essentia.js/) (beat tracker, onset, key, segmentation, WASM) — most complete; lighter alternatives [Meyda](https://meyda.js.org/) (features) + `web-audio-beat-detector` (tempo). Run in a **Web Worker**.
- **Persistence:** IndexedDB via **Dexie** or `idb-keyval` for bin + projects; File System Access API for relinking originals.
- **Undo/redo + state:** **Immer** patches (or a small command stack); a tiny store (Zustand vanilla or custom emitter) instead of scattered class state.
- **Language/tooling (when the codebase grows past script tags):** **Vite** + **TypeScript**, tests with **Vitest** (placement/timing math) and **Playwright** (UI).

### Phase 2 — Bin organisation + more creator I/O ⬜

| Module (proposed) | Functions | Notes |
|---|---|---|
| `app/bin/binModel.js` | `createFolder`, `moveTo(folder)`, `tag(asset, tags)`, `rate(asset, n)`, `search(query)`, `sortBy(field)`, `smartCollection(rule)` | Folders, tags (bass/mid/high become ordinary tags), favourites |
| `app/bin/binView.js` | grid/list toggle, filmstrip hover-scrub, multi-select, drag to timeline | |
| `app/bin/metadata.js` | `readMetadata(file)` (codec, fps, rotation, colour space), `dominantColor(asset)`, `motionScore(asset)` | Feeds smarter placement |
| `app/io/inputs.js` | `connectMidi()`, `mapMidi(control, action)`, `connectOsc(url)`, `addCameraInput(deviceId)`, `addScreenInput()`, `importFromUrl(url)` | Live sources become bin assets |
| `app/io/outputs.js` | `recordCanvas(opts)`, `exportFrames(range)`, `sendNdi()`/`sendSpout()` (desktop), `mirrorClipsToPopout()` | |
| `app/io/interchange.js` | `exportEdl()`, `exportFcpxml()`, `exportOtio()`, `importOtio()` | Hand off to Premiere / Resolve / FCP |

Suggested frameworks:
- **MIDI:** Web MIDI API via **WEBMIDI.js** (map DDJ controller pads/faders).
- **OSC:** `osc-js` over a WebSocket bridge (TouchOSC, Resolume, Ableton).
- **Metadata / probing:** **mediainfo.js** (WASM); **WebCodecs** for fast frame thumbnails.
- **Interchange:** **OpenTimelineIO** schema (write JSON directly; OTIO has adapters to EDL/FCPXML).
- **Desktop I/O (NDI, Spout/Syphon, file system):** **Tauri** (lighter) or **Electron** (more native video plugins available).
- **UI at this size:** migrate the editor panel to a component framework — **Svelte** or **SolidJS** (small, fast, good for canvas-heavy apps); React only if team familiarity outweighs size.

### Phase 3 — Production output (render/export) ⬜

| Module (proposed) | Functions | Notes |
|---|---|---|
| `app/render/offlineRenderer.js` | `renderTimeline(timeline, {fps, width, height})`, `renderFrame(t)`, `seekAllSourcesTo(t)` | Deterministic, frame-by-frame (not real time); decoupled from rAF |
| `app/render/encoder.js` | `encodeVideo(frames)`, `muxWithAudio(track)`, `progress()` / `cancel()` | |
| Compositor upgrade | shader transitions (`blurShader`, `lumaWipe`, `glitch`), colour/LUT per segment | Move blur from offset-copies to a real shader |

Suggested frameworks:
- **Encode:** **WebCodecs** + **mp4-muxer** / **webm-muxer** (fast, in-browser); fallback **ffmpeg.wasm** (slower, universal).
- **Compositor:** keep p5 short-term; for production quality move to **PixiJS** (2D, filters) or **regl / Three.js** (custom GLSL transitions). **gl-transitions** collection plugs into either.

### Phase 4 — Realtime editing / performance ⬜

| Module (proposed) | Functions | Notes |
|---|---|---|
| `app/perform/liveEditor.js` | `punchIn(assetId)`, `holdCurrent()`, `queueNext(assetId)`, `forceCut()`, `setIntervalLive(beats)` | Performer overrides on top of the auto-editor |
| `app/perform/cues.js` | `addCue(t)`, `jumpToCue(n)`, `recordPerformance()` → timeline | A live set becomes an editable timeline |
| `app/perform/sync.js` | `syncToLink()`, `syncToMidiClock()`, `latencyCompensate(ms)` | Tighter tempo than bass-onset BPM |
| Output mirroring | `mirrorClipsToPopout()` with time-synced local clip copies | Required for projector use in clip mode |

Suggested frameworks:
- **Tempo sync:** Ableton **Link** (desktop bridge, e.g. via Tauri/Electron native module) or **MIDI Clock** through WEBMIDI.js.
- **Low-latency output:** OffscreenCanvas + worker rendering; `BroadcastChannel` for multi-window state.

---

## 5. Where to change what (quick index)

| I want to… | Go to |
|---|---|
| Change colours / fonts / panel sizes | `styles.css` `:root` |
| Add a transition | `transitions.js` → `ClipTransitions.register()` |
| Add a timing unit or pace | `musicalTime.js` → `UNITS` / `AUTO_PACES` |
| Support another time signature | `musicalTime.js` → `TIME_SIGNATURE` (only place) |
| Change how the next clip is picked | `clipEngine.js` → `choose()` |
| Change what the timeline draws | `timelinePanel.js` → `draw*()` |
| Add a visual mode | `visualizer.js` → `draw()` switch + `<option>` in `index.html` |
| Touch audio analysis | **Don't** — `audioProcessor.js` is frozen; add analysis in a separate module |

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
  trackSource.js           Track-file playback routed through the frozen processor (+ music bus)
  voiceTrack.js            Voice Over: record/import, own audio chain, follows the master timeline
  visualizer.js            p5 (WebGL) renderer, all visual modes, Media Layers, beat clock
  musicalTime.js           Beats / bars / measures math, 4/4 constant, auto tempo multiplier
  transitions.js           Transition registry (jump cut, crossfade, blur)
  clipEngine.js            Clip auto-editor: clip bin data, beat-locked switching, segment log
  voiceTrack.js            ⬜ v2.1 — voice-over record/import, volume, normalize (own audio chain)
  timelinePanel.js         Bottom editor UI: master timeline, clip lane, bin, properties, HUD
  sidebar.js               Modular tab sidebar: rail built from .side-panel sections, collapse to rail
  assetPanel.js            03 Assets: image/video bin, asset list, selected-asset properties + status
  app.js                   App controller: wiring, audio source modes, master clock, shortcuts
  output.js                Pop-out window renderer (mirrors control window state)
test-assets/
  generate.html            Makes labelled test clips (WebM) + a 120 BPM test track (WAV) in-browser
docs/
  codemap.md · decisions.md · roadmap.md · brief-v2.1.md (current spec) · screenshots/
netlify.toml · vercel.json Static deploy configs (vercel uses globs: *.html, app/*.js, styles/*.css)
```

**No build step.** Plain `<script>` tags, global classes, loaded in this order (order matters — later files reference earlier globals):

```
p5 (CDN) → audioProcessor → visualizer → trackSource → voiceTrack → musicalTime → transitions → clipEngine → timelinePanel → sidebar → assetPanel → app
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
| `load(file)` | `<audio>` + MediaElementSource → analyser (**config mirrors `startAudio()` — keep in sync**) → `musicGain` → speakers |
| `setMusicLevel(v, rampSec)` / `musicGain` / `musicLevel` | Music bus after the analyser (v2.1 step 2b, D-36). Level survives reloads; mute and story fades use it |
| `play()` / `pause()` / `seek(s)` | Transport |
| `unload()` | Pause element, `processor.stop()`, revoke object URL, drop `musicGain` |
| `isLoaded` / `isPlaying` / `currentTime` / `duration` | State getters |

### 3.2b `app/voiceTrack.js` — `class VoiceTrack` — ✅ *(v2.1 step 6)*
Own `<audio>` + own AudioContext: `element → normGain → volumeGain → speakers`. Never connected to the analyser, `musicGain` or `ClipEngine` (invariant 7).

| Function | Role |
|---|---|
| `load(blob, {offset, name, isTake})` / `unload()` | Decodes once (`decodeAudioData`) for duration, Normalize stats and lane peaks |
| `importFile(file)` | Starts at 0:00 (Q13); asks before discarding an undownloaded take |
| `listMics()` / `startRecording(deviceId)` / `stopRecording()` | getUserMedia (echo cancellation + noise suppression) + MediaRecorder; the take is placed at the playhead when Record was pressed |
| `downloadTake()` | Saves the last take (Q14) |
| `setVolume(0–1.5)` / `setNormalize(on)` / `setOffset(s)` / `applyGains()` | Volume × Normalize gain |
| `analyze(buffer)` / `normGainFor(stats)` / `peaksOf(buffer, n)` | Gated RMS (50 ms windows above −50 dBFS) + peak → gain to ≈ −16 dBFS RMS, peak ≤ −1 dBFS |
| `syncTo(masterTime, rolling)` / `loop()` | Own rAF loop: plays/pauses with the transport at `masterTime − offset`; re-seeks if drift > 50 ms (400 ms grace after a start or seek) |

App side (`app.js`): `setupVoice()`, `updateVoiceUI()`, `populateVoiceMics()`, `applyMusicLevel()` (mute → `trackSource.setMusicLevel`), `updateMusicUI()` (mute disabled in live mode). The UI lives in **01 Audio** (Voice + Music blocks); REC badge in the transport bar.

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
State: `assets[]` (every imported image/video, fields in §4.0), `clips` (getter: assets with `asClip`, sorted by `importance`), `selectedId`, `nextCutPos` / `segStartPos` / `holdBeats` (cut schedule, in beats), `settings`, `bandTransitions`, `segments[]` (`{clipId, start, end, inPoint, transition, band, beat, blendSec}`), `beats[]` (`{time, index}`), `current`, `outgoing`, `pending`, `transition`.

| Function | Role |
|---|---|
| `addFiles(list)` / `addAsset(file)` | `video/*` and `image/*`. `loadVideoAsset` (p5 `createVideo`, muted/looping/hidden) / `loadImageAsset` (p5 `loadImage` + thumb) |
| `makeThumb(clip)` | Poster frame via separate `<video>`; also resolves `Infinity` durations (seek-to-end probe) |
| `removeAsset(id)` / `setClipBand(id, band)` / `clipById(id)` | Asset management; band tag = `any · bass · mid · high`. Removing releases its Media Layer slot |
| `setAssetAsClip(id, on)` / `moveClip(id, i)` / `setClipImportance(id, n)` / `renumber()` | "Use as: Auto-edit clip"; Importance = position in `stack` 1..N (story assets sit after it) |
| `setAssetLayer(id, slot)` | "Use as: Media Layer": calls `viz.loadLayerMedia` / `clearLayerMedia`; one asset per slot |
| `select(id)` | Shared selection (03 Assets + Action Editor); emits `select` |
| `update(audioData)` | Per frame: `trackBands()`; on viz beat edges `beatIndex++` (also during story blocks); **story block** at the master time → `playStory()` and stop; leaving one → `endStory()` + re-sync; first clip goes on screen immediately; cut when position reaches `nextCutPos`; pre-roll |
| `intervalFor(clip, bpm)` | A clip's hold: its own `pace` if set, else the global interval |
| `setClipPace(id, pace)` | Per-clip pace: `global` or a `MusicalTime.AUTO_PACES` key |
| `intervalBeats(bpm)` | Auto (`autoMultiplier`) or manual (`toBeats(count, unit)`) |
| `trackBands(d)` | Dominant band = highest ratio of value ÷ its own running average, with hysteresis |
| `regularPool()` | Ready assets used as clips, in stack order (story assets leave it in Story Mode, step 7) |
| `choose()` | Next clip. **Sequential:** next one down the stack, wrapping. **Random / By band:** `weightedPick()` (band pool by tag → `any` → all) |
| `weightedPick(pool, exclude)` | Weight = N − rank + 1 within the pool (top of the stack most often); never the current clip twice in a row |
| `prepare(clip, bpm)` | In-point (`random · resume · start`), seek, play. Images: in-point 0, nothing to seek (D-46) |
| `cut(bpm, atPos)` | Close segment, open new, schedule `nextCutPos = atPos + hold`, pick transition (`band` map or fixed), start blend |
| `retire(clip)` | Save `lastPos`, pause unless current/pending |
| `seekTo(s)` | Truncate segments/beats after `s`, force cut next frame |
| `setActive(bool)` / `pauseAll()` / `reset()` | Lifecycle |
| `draw(p)` | Cover-fit clip render (video **and image** through the same `drawClip`), active transition render, optional Media Layers overlay |
| `status()` / `nowShowing()` / `beatPhase()` | For UI (`status().story` = role on air) |
| `stack` (getter) | Clips minus story assets while Story Mode is on = the Action Editor stack; `renumber()` gives it 1..N |
| `setStoryMode(on)` / `setClipStory(id, role)` / `setStoryHold(id, s)` | Story Mode toggle; one asset per role; image block hold (Q9) |
| `storyAssets()` / `storyLength(a)` | Ready assets by role (Story Mode only); video = full length, image = `storyHold` |
| `storyPlan(songDur)` / `liveStoryBlocks()` / `storyBlocks()` / `storyBlockAt(t)` | Track mode: HOOK `[0, len)`, CTA `[end − len, end)`, RESULT ending where CTA starts (clamped after HOOK). Live mode: HOOK at 0 + fired blocks |
| `fireStory(role)` | Live mode: Result / CTA once per session (Q11) |
| `playStory(block)` / `endStory()` | Jump cut to the story asset (segment flagged `story`); a video block plays once from the matching offset, unmuted (Q9), kept on the master time; on exit it is re-muted and cutting re-syncs on the master beat |
| `on(fn)` / `emit(type)` | Events: `clips · cut · beat · seek · reset` |

### 3.7 `app/timelinePanel.js` — `class TimelinePanel` — ✅
Single 2D canvas redrawn ~30 fps. Row heights `ROWS = { ruler 28, master 72, clips 64, voice 40 }` **must match** `.ch-*` heights in `styles.css`. The voice row (and `.ch-voice`) only exists while a voice track is loaded; `resizeCanvas()` sets the canvas height.

| Function | Role |
|---|---|
| `init()` | Wire transport, props, bin, canvas, splitter; start `loop()` |
| `onAudioFrame(d)` / `resetSession()` | Band energy history (truncates on seek-back) |
| `loadTrackWaveform(file)` | Separate decode (OfflineAudioContext) → 2400 min/max peaks. Drawing only |
| `initProps()` / `syncProps()` / `updateReadout()` | Auto-Editor panel ↔ `engine.settings` |
| `initBin()` / `renderBin()` / `markShowing()` | **Action Editor** (step 5): the auto-edit clips as an ordered stack (number = Importance), ON AIR badge (polled in `loop()`). Click → `engine.select()` + open 03 Assets. Files dropped here are still added as assets |
| `insertIndexAt(x)` / `showInsert(slot)` / `reorderTo(id, slot)` | Drag-to-reorder (HTML5 drag events) → `engine.moveClip()`. Keyboard: Alt+←/→ on a focused card, Enter selects |
| `initCanvasInteraction()` | Track mode: click/drag seek, wheel pan, Ctrl/Cmd+wheel zoom, dbl-click fit |
| `initSplitter()` | Resizable editor height (localStorage, try/catch) |
| `updateView()` | Track = fit/zoom window; Live = rolling 30 s window |
| `updateHeader()` / `updateHud()` | LCD readouts, mode badge, summary; viewport HUD + hints |
| `draw()` → `drawRuler` · `drawMaster` · `drawClips` (+ `drawStoryBlock`, dashed outlines of upcoming story blocks) · `drawVoice` · `drawTransitionMark` |
| `storyHint()` / `storyCard(a, label)` | Story Mode panel text; fixed Hook / Result / CTA markers at the ends of the Action Editor | Ruler, waveform + energy, beat/bar grid, segments, ghost cut markers, playhead |

### 3.7b `app/sidebar.js` — `class Sidebar` — ✅ *(v2.1 step 3a)*
Builds a rail button per `#tabPanels > .side-panel` (`data-tab`, `data-num`, `data-label`); one panel open at a time.

| Function | Role |
|---|---|
| `init()` | Restore `{open, collapsed}` from localStorage (`djv.sidebar`, try/catch), build rail + « button |
| `onTab(tab)` | Open a tab; clicking the open tab collapses to the rail |
| `open(tab)` / `toggleCollapsed()` / `apply()` | Programmatic open (e.g. select an asset → 03 Assets), collapse, render + persist |

Tabs: **01 Audio** (source, device, start/fullscreen, Visualization) · **02 EQ** · **03 Assets** · **04 Output**. The canvas follows the width change through the viewport `ResizeObserver` (D-21).

**Status overlay** (step 3b): `#statusOverlay` in `.visualizer-container`, top-right, holds `deviceStatus` / `bpmCounter` / `beatIndicator` / `fpsCounter` (IDs unchanged). `#viewportHud` (top-left, clip on air) uses the same `.status-item` rows.

### 3.7c `app/assetPanel.js` — `class AssetPanel` — ✅ *(v2.1 step 4)*
The 03 Assets tab. Drop zone + `#assetUpload` chooser (`image/*,video/*`, multiple) → `engine.addFiles()`; the first new asset is selected.

| Function | Role |
|---|---|
| `render()` → `renderList()` / `renderProps(asset)` | Re-rendered on engine `clips` / `select` events |
| `renderProps(a)` | Fields per item: **Use as** (Auto-edit clip checkbox `#propAsClip`; Media Layer `#propLayer`: none/background/bass/mid/high), layer controls for bass/mid/high, **Clip** fields when used as a clip (`#propBand`, `#propPace`, `#propImportance`), **Status**, **Remove** |
| `layerControls(slot)` | `layerEnabled/Justify/Stack-<slot>` (old IDs kept) bound to `visualizer.layers[slot]`, `autoAssignJustify()`, `assignStackPosition()` |
| `fillStatus(a)` / `refreshStatus()` | Per-asset status rows (type, length, size, decode, on air, role), refreshed 4×/s |

### 3.8 `app/app.js` — `class DJVisualizerApp` — ✅
| Area | Functions |
|---|---|
| Boot | `init()` — `Sidebar` first, then DOM refs, listeners, shortcuts, `onDataUpdate` fan-out, `timeline.init()` |
| Devices | `checkAudioPermissions`, `populateAudioDevices`, `onDeviceSelectionChange`, `restartAudioWithNewDevice` |
| Source modes | `setAudioSourceMode('mic'|'file')`, `loadAudioFile(file)`, `wireDropZone` |
| Transport | `toggleAudio`, `startAudio`, `stopAudio`, `transportStop`, `setStartButton` |
| Master timeline | `isTrackMode`, `masterTime`, `timelineRolling`, `resetSession`, `seekMaster`; `clipEngine.songDuration` hook (track length, 0 live) |
| Music bus | `applyMusicLevel()` (mute × `storyFadeLevel(t)`), `updateMusicUI()` |
| Misc | `setupGainControls`, `resetGains`, `updateBPM`, `updateFPS`, `toggleFullscreen`, `toggleHelp/hideHelp`, `switchVisualizationMode`, `destroy` |

Global `var djApp` (must stay `var` — `output.js` reads `window.opener.djApp`).

### 3.9 `app/output.js` + `output.html` — 🟡
Pop-out canvas. Proxies the control window's `DJVisualizer` and loads its own copies of layer media (p5 textures can't cross renderers). **Clip mode is not mirrored** — shows a notice.

### 3.10 `styles/styles.css` — ✅
Tokens in `:root`: `--surface #EDEAE4 · --panel #E3DFD7 · --steel #D7DADC · --ink #1A1A1A · --bass/--mid/--high · --live`, fonts `--font-logo` (Boldonse, `.brand-mark` "BSS / MNT") · `--font-ui` · `--font-mono`, layout `--topbar-h · --sidebar-w · --editor-h`. Viewport stays black.

### 3.11 Invariants
1. `audioProcessor.js` is never modified.
2. No code outside `musicalTime.js` hard-codes beats-per-bar.
3. Element IDs used by `app.js` / `visualizer.js` are stable (see `index.html`). *Exception (v2.1, D-44):* the fixed `layerUpload-*` / `layerStatus-*` inputs are gone; `layerEnabled/Justify/Stack-<slot>` exist only while that slot's asset is selected (the visualizer already null-checks them).
4. Timeline row heights in JS and CSS match.
5. New transitions go through `ClipTransitions.register()`, never inline in the engine.
6. *(v2.1)* Music fades and mutes happen **after** the analyser (`musicGain`), never before it, so analysis always sees the full-level track.
7. *(v2.1)* The voice chain is never connected to the analyser or `musicGain`, and nothing in `clipEngine.js` references the voice track.
8. *(v2.1)* Every new per-clip field has a default that reproduces v2 behaviour (`pace: 'global'`, `asClip: true`, `layer: null`, `importance` = upload order, `story: 'none'`).

---

## 4. Planned functions by roadmap phase

Names below are proposed signatures, not existing code. Framework suggestions are **suggestions**, to be confirmed as decisions when adopted.

### 4.0 v2.1 — Creator essentials ✅ *(steps 2–8 built; step 9 aesthetics next)*

Spec: [brief-v2.1.md](brief-v2.1.md). Decisions: D-31–D-46; open questions Q9–Q16 ([decisions.md §J](decisions.md#j-v21--the-three-final-changes-proposed-2026-10-02)). Step numbers match [roadmap.md › v2.1](roadmap.md#v21--creator-essentials--now). **No new libraries:** everything uses Web Audio, MediaRecorder and the existing p5 setup.

**Audio graph after v2.1**

```
 track <audio> ─► MediaElementSource ─► analyser ─┬─► AudioProcessor loop (FROZEN, reads analyser)
   (TrackSource, ctx recreated per load)          └─► musicGain ─► speakers      ◄── mute · story fades
                                                       (step 2b)

 voice <audio> ─► normGain ─► volumeGain ─► speakers       (VoiceTrack, own AudioContext, step 6a)
   ▲ slaved to app.masterTime() − offset; never touches analyser / musicGain / ClipEngine
```

**Asset model after v2.1** (one entry per imported file; `ClipEngine.clips[]` becomes the assets used as clips)

```
{ id, name, file, url, media, el, duration, width, height, thumb, lastPos, ready, error,
  kind:       'video' | 'image',                    // step 2a / 4a
  asClip:     true,                                 // "Use as: Auto-edit clip" (D-44)
  layer:      null | 'background'|'bass'|'mid'|'high', // "Use as: Media Layer" → visualizer.layers
  band:       'any' | 'bass' | 'mid' | 'high',      // existing
  pace:       'global' | AUTO_PACES key,            // ✅ built (D-30/D-31) — keep as is
  importance: 1..N,                                 // = position in the Action Editor stack (D-32)
  story:      'none' | 'hook' | 'result' | 'cta',   // ignored unless settings.storyMode
  storyHold:  seconds                               // image story blocks only (Q9)
}
```

| Step | Where | Functions / changes |
|---|---|---|
| 2a ✅ | `clipEngine.js` (kept in the engine: `assets[]` + `clips` getter) | Asset list with the fields above; `addFiles()` accepts `video/*` and `image/*`; `setClipImportance(id, n)` / `moveClip(id, toIndex)` renumber the stack; `setClipStory(id, role)` enforces one asset per role; `setAssetLayer(id, slot)` calls `viz.loadLayerMedia(slot, file)` / `clearLayerMedia`. Emits `'clips'` |
| 2b ✅ | `trackSource.js` | `load()` creates `this.musicGain` between analyser and destination; `setMusicLevel(v, rampSec?)`. `unload()` drops it |
| 3a ✅ | `index.html`, `styles.css`, new `app/sidebar.js` | Tab rail + slide-out panels; sections registered as modules `{num, label, el}`; `open(tab)`, `toggleCollapsed()`; localStorage in try/catch. Order: 01 Audio (+ Visualization) · 02 EQ · 03 Assets · 04 Output |
| 3b ✅ | `index.html`, `styles.css` | `.status-overlay` (top-right of `.visualizer-container`, semi-transparent) holding `deviceStatus` / `bpmCounter` / `beatIndicator` / `fpsCounter` (same IDs); `#viewportHud` restyled to match |
| 4a ✅ | `index.html`, `app/assetPanel.js` | 03 Assets: drop zone + `<input accept="image/*,video/*" multiple>`, asset list with thumbs, `select(id)` (shared selection with the Action Editor) |
| 4b ✅ | same | `renderProps(asset)`: fields shown per D-44 (kind, Use as, layer fields, band, Pace, Importance, Story Position, status, Remove) |
| 4c ✅ | `index.html`, `assetPanel.js` | Layer upload slots removed from the HTML. `visualizer.js` needed **no change**: its `init()` already skips missing `layerUpload-*` / `layerEnabled-*` elements. Layer controls bound from the properties panel. Pop-out verified (it reads `visualizer.layers[slot].file`, which `loadLayerMedia` still sets) |
| 5a ✅ | `timelinePanel.js`, `index.html` | Bottom "Bin" → **Action Editor**: `renderStack()` (ordered by importance), card click → `select(id)`, file drop still adds assets |
| 5b ✅ | `timelinePanel.js` | Drag-reorder (HTML5 drag events, keyboard Alt+←/→ since the stack is horizontal) → `engine.moveClip(id, i)` |
| 5c ✅ | `clipEngine.js` | `choose()` → `regularPool()` (ready, `asClip`; story exclusion lands in 7b). Sequential = stack order; random/band = `weightedPick(pool)` with weight `N − rank + 1` within the pool (Q15) |
| 5d ✅ | `clipEngine.js` | Images as clips: `drawClip` handles `p5.Image`; `prepare()`/`retire()` skip video calls for images; in-point ignored |
| 6a ✅ | `app/voiceTrack.js` (new) — `class VoiceTrack` | `constructor(app)`, `load(blob|file, {offset})`, `unload()`, `syncTo(masterTime, playing)` (called from the app's frame loop; drift > 50 ms → seek), `setVolume(v)`, `setNormalize(on)`, `get duration/offset/isLoaded` |
| 6b ✅ | `voiceTrack.js`, `index.html` | `importFile(file)`; **Voice** block inside the 01 Audio tab: import button, status line |
| 6c ✅ | `voiceTrack.js` | `listMics()`, `startRecording(deviceId)` (getUserMedia echoCancellation/noiseSuppression + MediaRecorder), `stopRecording()` → `load(blob, {offset: recordStartMasterTime})`, `downloadTake()` (Q14); record indicator in transport bar |
| 6d ✅ | `voiceTrack.js` | `analyze(buffer)` → `{rmsGated, peak}`; `normGainFor(stats)` → target ≈ −16 LUFS-eq, peak ≤ −1 dBFS; Volume slider 0–150 %, Normalize checkbox |
| 6e ✅ | `app.js`, `index.html` | **Music** mute toggle → `trackSource.setMusicLevel(0/1)`; disabled with a hint in mic mode (D-36) |
| 6f ✅ | `timelinePanel.js`, `styles.css`, `index.html` | `ROWS.voice`, `.ch-voice` channel header, `drawVoice()` (peaks at offset), `loadVoiceWaveform(buffer)` |
| 6* ✅ | `app.js` | Owns `this.voice = new VoiceTrack(this)`; `destroy()` unloads it. *As built:* no transport hooks are needed, because `VoiceTrack` runs its own rAF loop reading `app.masterTime()` / `app.timelineRolling()`, so play, pause, stop and seek are all followed from one place |
| 7a ✅ | `clipEngine.js`, `timelinePanel.js`, `index.html` | `settings.storyMode`, `settings.storyFade`; Auto-Editor panel **"Story Mode"** block (toggle + Auto Fade Music checkbox); Story Position in asset properties (only in Story Mode); Pace/Importance hidden for story assets |
| 7b ✅ | `clipEngine.js` | `storyPlan(songDur)` → `[{role, clip, start, end}]` per D-34 (track mode); `storyBlockAt(t)`; `update()` plays a block (not `choose()`) while `masterTime` is inside one, then `nextCutPos = null` to re-sync; segments carry `story: role`; live mode: `fireStory(role)` (Q11); `seekTo()` re-evaluates blocks |
| 7c ✅ | `timelinePanel.js` | `drawClips()` renders story blocks (fixed, labelled HOOK / RESULT / CTA) and, in track mode, ghost outlines of upcoming blocks from `storyPlan()` |
| 7d ✅ | `app.js` (+ `trackSource.setMusicLevel`) | *As built:* `storyFadeLevel(t)` computes the music level from the master time (0 inside a block, linear over 1 bar before/after, 2 s before BPM is known) and `applyMusicLevel()` applies it to `musicGain` every analysis frame while Auto Fade is on. Seek, pause, stop and plan changes need no bookkeeping. Mute overrides it |

**Test focus (step 8) — ✅ all passed, see decisions D-47:** all four story orderings from the brief, plus Story Mode off. Sidebar collapse/expand resizes the canvas. Media Layers driven from asset properties look identical to before. Reorder updates Importance. Story assets never appear in the fill. Importance histogram over ~200 cuts. Cuts stay on master beats with mixed timings. Voice in sync after seek, pause and stop, unaffected by any timing or Importance change. BPM reading unchanged while music is muted or faded.

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
| Change a clip's timing options *(v2.1)* | `musicalTime.js` → `CLIP_TIMINGS` |
| Change how Importance weights picks *(v2.1)* | `clipEngine.js` → `weightedPick()` / `weightedRoundRobin()` |
| Change where story blocks go *(v2.1)* | `clipEngine.js` → `storyPlan()` |
| Fade / mute the music *(v2.1)* | `trackSource.js` → `musicGain` (after the analyser only) |
| Anything voice *(v2.1)* | `voiceTrack.js` |

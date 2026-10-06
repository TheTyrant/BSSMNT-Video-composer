BSS MNT — Video Composer  ·  alpha (BASSMNTalphaV1)
=====================================================

A beat-locked video composer and DJ visualizer. Load a song (or go live
from a mic / line in), add your clips, and the Auto-Editor cuts them on
the beat. Add titles and credits, then export an MP4. Everything runs on
your computer, offline.


GETTING STARTED
---------------
1. 01 Input: choose LIVE INPUT (mic / line in) or TRACK FILE (a song).
2. 02 Sound › Assets: drop in videos and images (or click to choose).
   Screen recordings (.asf / .wmv) are converted automatically.
3. MODE (top bar): pick Clip Auto-Editor (key 0), then press Space to play.
   Cuts start once the tempo is found ("Listening for tempo…").
4. Play the song through once — what you see is recorded for the export.
5. 03 File › Export video: pick a size and press Export MP4.
6. 03 File › Project: Save (Ctrl+S). Choose PACK (media inside the file,
   opens anywhere) or LINK (small file, media stays where it is).


KEYBOARD SHORTCUTS
------------------
Space              Play / pause (track) · start / stop (live)
F                  Fullscreen
1 – 9              Visual modes in menu order:
                     1 Spectrum Bars   2 Floating Particles   3 Frequency Rings
                     4 Wave Forms      5 Mandala              6 Tunnel Vision
                     7 Galaxy          8 Polygon Collage      9 Media Layers
0                  Clip Auto-Editor
Ctrl+1             01 Input panel        (Alt+1 also works)
Ctrl+2             02 Sound panel        (EQ, assets, asset timing)
Ctrl+3             03 File panel         (project, export, output window)
Ctrl+4             04 Overlays panel     (titles, credits, text)
Shift+A            Auto-Editor controls (right side)
Ctrl+S             Save project
Ctrl+Shift+S       Save project as…
Ctrl+O             Open project
R                  Reset the bass / mid / high sensitivity to 1.0
?                  Show / hide help
Esc                Close help
Clicking a panel tab a second time closes it.


CONTROLS AT A GLANCE
--------------------
Top bar      SRC (Live / Track) · MODE (visual mode) · SIZE (frame shape:
             Original, 16:9, 9:16, 1:1) · half-moon = dark / light skin · ?
Timeline     Play / pause, stop, back to start. Click the ruler to jump.
             M on Master / Voice mutes that track (muted = left out of
             exports). Drag text blocks on the Text lane to retime them.
Action       The clip stack: drag to reorder. Top = most important (shown
Editor       most often).
02 Sound     EQ (Sensitivity / Dynamic), the asset list, and the selected
             asset's options: Pace (how long it holds), Position lock
             (Hook / Result / CTA, three in total) with Auto fade music.
04 Overlays  + Title, + Credits, + Text. Lock to Start / At time / End.
             Drag the dashed box on screen to place text. Layout can
             differ per frame shape (Base / Vertical / Square).
Live mode    "Record input for export" keeps the sound of a live set for
             the export (untested in real-world use).


GOOD TO KNOW (alpha)
--------------------
- Windows may say "Windows protected your PC": click More info → Run anyway
  (the app isn't code-signed yet).
- The tempo detector misreads some songs; cuts follow what it detects.
- Parts of the song you haven't played export as a still picture.
- The pop-out output window doesn't show the Clip Auto-Editor yet — use
  Fullscreen (F) instead.
- Closing with unsaved changes asks before closing.

Third-party software and licences: see the "licenses" notes that come with
the app (p5.js, Mediabunny, fflate, fonts, FFmpeg).

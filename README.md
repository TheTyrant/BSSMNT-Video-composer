# BSS MNT — Video Composer *(v2, alpha: BASSMNTalphaV1)*

A beat-locked video composer and DJ visualizer that runs entirely on your computer. Play a track (or go live from a mic / line in), let the auto-editor cut your clips on the beat, add titles and credits, then export a finished MP4 — rendered offline on your machine, no internet, no uploads.

Built on the open-source *JS DJ Audio Visualizer* (credited below). Performed live at [Indy Hall](https://www.indyhall.org/) in Philadelphia, driving real-time visuals off a Pioneer DDJ-REV1.

## What it does
- **Ten visual modes** reacting to the music (Spectrum Bars, Particles, Rings, Waves, Mandala, Tunnel, Galaxy, Polygons, Media Layers, Clip Auto-Editor).
- **Clip Auto-Editor:** cuts your videos and images on the beat, with per-clip pace and importance, jump / crossfade / blur transitions, and **position locks** (Hook · Result · CTA) with music auto-fade.
- **Voice track:** record or import narration over the music, with volume, normalize and mute.
- **Text:** titles, rolling credits and free text, timed on the timeline, draggable on screen, with per-size layouts.
- **Display size + breakpoints:** see the frame at 16:9, 9:16 or 1:1 live; lay text out per shape like a responsive website.
- **Offline export:** MP4 (H.264 + AAC) at 720p / 1080p / 4K, vertical or square, faster than real time on a GPU; replays exactly what was recorded (cuts, motion, text, fades, voice; muted tracks left out).
- **Live mode recording** *(untested in real-world use)*: records the live input so live exports have sound; crash-safe.
- **Projects (.mnt):** save and reopen everything. **Pack** puts the media inside (any size, opens anywhere) or **Link** keeps the file small; the projected file size shows before you save.
- **Screen recordings (.asf / .wmv / .wma):** the desktop app converts them on import (bundled FFmpeg); linked projects in the desktop app reopen media from its real location.
- **Dynamic EQ** for what the analysis hears, an analyser-style EQ graph and session lanes, and a **dark skin** (header button).

## Get the app (Windows)
The ready-to-run desktop app (installer or portable zip) is available to supporters:

- **Monthly — Patreon ($7–15/month):** the prebuilt app, every update, plus early and in-progress builds as BSS MNT develops.
- **Lifetime — one-time purchase:** the prebuilt app with all future updates included.
- **Free — build it yourself:** the full source is right here. See [Run from source](#run-from-source-developers) below.

The app isn't code-signed yet, so Windows SmartScreen may say *"Windows protected your PC"* — click **More info → Run anyway**. **macOS:** not built yet (on request, and it will be marked untested).

## Run from source (developers)
The source is free for anyone who wants to build it themselves with Node.js tooling (or an editor such as VS Code):

```sh
git clone https://github.com/TheTyrant/BSSMNT-Video-composer.git
cd BSSMNT-Video-composer   # v2 is the default branch
                           # (or download the BASSMNTalphaV1 source zip from Releases)
npm install                # Electron + electron-builder (dev tools)
npm start                  # run the desktop app from source
npm run dist:win           # build the Windows installer + zip into dist/
```

No build step is needed for the web version itself — everything it uses is in this folder (`vendor/` holds the libraries and fonts), so it runs offline:
- open `index.html` in Chrome, Edge or Firefox (works straight from disk), or
- `node serve.js` → `http://127.0.0.1:8765` (Windows: **Start BSS MNT.bat**).

**Browsers:** Chrome and Edge (recommended — they save straight to your disk) and Firefox (tested: 156; projects and exports go to your Downloads folder). Safari isn't supported.

Source releases: [Releases](https://github.com/TheTyrant/BSSMNT-Video-composer/releases).

## Controls and shortcuts
See **[README-BSSMNT.txt](README-BSSMNT.txt)** (also included with every download) and the in-app help (**?**). Main keys: **Space** play/pause · **F** fullscreen · **1–9** visual modes · **0** Clip Auto-Editor · **Ctrl+1–4** File / Input / Sound / Effects · **Ctrl+N** new project (browser Alt+N) · **Shift+A** Auto-Editor · **Ctrl+S / Ctrl+Shift+S / Ctrl+O** save / save as / open · **R** reset sensitivity · **?** help.

Changes: [CHANGELOG.md](CHANGELOG.md).

## Known limits (alpha)
- The BPM detector misreads some tracks (e.g. 97 BPM read as 105–145); cuts follow what it detects.
- Play a track through once before exporting — unplayed parts have no recorded motion and export still.
- Live-mode input recording is **untested in real-world use**.
- The pop-out output window doesn't mirror the Clip Auto-Editor yet (use Fullscreen).
- Windows only for now; not code-signed.

## Documentation
- [docs/roadmap.md](docs/roadmap.md) — what's built, what's next
- [docs/decisions.md](docs/decisions.md) — every design decision (D-01 … D-77)
- [docs/codemap.md](docs/codemap.md) — where everything lives in the code

## Project Structure
```
index.html, output.html   the app and the pop-out output window
app/                      app modules (audioProcessor.js is the original analysis engine, kept unchanged)
styles/styles.css         light + dark skins
vendor/                   p5, Mediabunny (+ AAC encoder), fflate, fonts, licences
electron/                 desktop launcher (main.js, run.js, icon)
docs/                     roadmap, decisions, codemap
serve.js, Start BSS MNT.bat   local server for the web version
test-assets/              generators and the render speed test
```

## Contributing
Contributions are welcome! Please open issues or submit pull requests for new features, bug fixes, or improvements.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/YourFeature`)
3. Commit your changes (`git commit -am 'Add new feature'`)
4. Push to the branch (`git push origin feature/YourFeature`)
5. Open a pull request

## License
MIT License. See [LICENSE](LICENSE) for details.

## Authors
- Waskar Paulino ([traksaw](https://github.com/traksaw)) — original JS DJ Audio Visualizer
- Omar ([TheTyrant](https://github.com/TheTyrant)) — BSS MNT v2

## Acknowledgments
- Inspired by the DJ and web audio community
- Built with the Web Audio API and Canvas
- p5.js, Mediabunny (+ its AAC encoder, FFmpeg), fflate, Boldonse / Inter Tight / JetBrains Mono — licences in [vendor/licenses/](vendor/licenses/)

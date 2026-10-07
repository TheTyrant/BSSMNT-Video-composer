# Changelog

## BASSMNTalphaV1 — bug-fix update (2026-10-06)
Same version (alpha V1); fixes and one import addition.

### Fixed
- **The desktop app couldn't be closed** when a project had unsaved changes. It now asks *Close without saving / Cancel*.
- **Linked projects lost media on reopening** (e.g. 9 of 22 videos). The desktop app now remembers where each file is (including the original .asf of converted recordings) and reopens it from there.
- **Reopened projects had no audio** when they were saved with SRC on Live: the parked track is now saved with the project.
- **Choose file did nothing** inside VS Code's preview; it now uses the standard file dialog there.
- **Re-choosing the same song** after using live mode did nothing; it now loads.
- **Open recent didn't list projects** opened or saved in browsers without file handles (Firefox, VS Code's preview). Every project is now logged; where needed a copy (up to 300 MB) is kept so it reopens.
- **Voice recording's REC timer** drove the live-input REC badge in the header (two controls shared an id); each badge is now separate.
- **Pack / Link** radio clicks were undone by the unsaved-changes tracker; fixed. A reopened project now takes its file's name.
- **Dark skin lines** were heavy: thinner (0.5 px / 1 px) and a softer tone.
- **Export stopped with "Decoder error."** when any frame of any clip couldn't be decoded. It now retries, holds that clip's last good picture where it can't, finishes the export, and names the clip.
- **A long clip locked as CTA (or Hook / Result) took over the whole project** — e.g. a screen recording longer than the song made the CTA start at 0:00 and squeezed out Result. A locked clip now plays at most a quarter of the song (30 s live); the clip's options say when it's cut short.

### Added
- **File menu** (01 File, now the first tab): New project, Open…, Open recent, Save with Pack / Link and the file size, Save as…, Export video (options in dropdowns), Output window — a list like traditional software, with the project name on top. Tabs are now 01 File, 02 Input, 03 Sound, 04 Effects (was Overlays); Ctrl / Alt + 1–4 follow that order.
- **New project** (Ctrl+N in the desktop app, Alt+N in a browser) — asks first if there are unsaved changes.
- **Effects** (was Overlays) is a list too, and every option is a dropdown instead of rows of buttons.
- A reopened project takes its file's name.
- **Screen recordings (.asf / .wmv / .wma)** are converted on import in the desktop app (bundled FFmpeg), instead of arriving blank. The browser version explains why it can't play them.
- **README-BSSMNT.txt** with controls and shortcuts, included with every download.

## BASSMNTalphaV1 (2026-10-03)
First alpha for testers: Windows launcher, offline export, projects with packed or linked media, live input recording (untested), dark skin, text and credits, display sizes.

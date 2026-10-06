# Changelog

## BASSMNTalphaV1 — bug-fix update (2026-10-06)
Same version (alpha V1); fixes and one import addition.

### Fixed
- **The desktop app couldn't be closed** when a project had unsaved changes. It now asks *Close without saving / Cancel*.
- **Linked projects lost media on reopening** (e.g. 9 of 22 videos). The desktop app now remembers where each file is (including the original .asf of converted recordings) and reopens it from there.
- **Reopened projects had no audio** when they were saved with SRC on Live: the parked track is now saved with the project.
- **Choose file did nothing** inside VS Code's preview; it now uses the standard file dialog there.
- **Re-choosing the same song** after using live mode did nothing; it now loads.

### Added
- **Screen recordings (.asf / .wmv / .wma)** are converted on import in the desktop app (bundled FFmpeg), instead of arriving blank. The browser version explains why it can't play them.
- **README-BSSMNT.txt** with controls and shortcuts, included with every download.

## BASSMNTalphaV1 (2026-10-03)
First alpha for testers: Windows launcher, offline export, projects with packed or linked media, live input recording (untested), dark skin, text and credits, display sizes.

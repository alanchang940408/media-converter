# Next round (requested 2026-10-01)

## 0. (2026-10-02, user request) MPG / WMV / AVI as OUTPUT formats
Input already works (ffmpeg decodes all of them). Add them as output containers end-to-end
(src/shared/types + videoRules, ffmpeg args/muxers, presets, preset editor UI, i18n, tests):
- `mpg` → MPEG-PS (`-f mpeg`, or `-f dvd` for DVD-compliant): video `mpeg2video` (+ `mpeg1video`), audio `mp2` / `ac3`.
- `wmv` → ASF (`-f asf`): video `wmv2` (ffmpeg has no WMV9/VC-1 encoder — say so in the UI), audio `wmav2`.
- `avi` → AVI (`-f avi`): video `mpeg4` with `-vtag xvid` (Xvid-compatible), `mjpeg`, optionally `h264`; audio `mp3` / `pcm`.
- New VideoCodecId values (e.g. `mpeg2`, `mpeg1`, `mpeg4`, `wmv2`, `mjpeg`) and AudioCodecId (`mp2`, `ac3`, `wmav2`); rate control mapping (qscale/bitrate) and sensible defaults.
- Built-in presets: MPEG-2 DVD NTSC 720×480 / PAL 720×576, MPEG-2 1080p, WMV 720p, AVI Xvid 720p, AVI MJPEG (editing-friendly).
- Integration tests encode each and verify with ffprobe; e2e one of each.

## Later (after the items above): "Send to Media Converter" panel for Premiere Pro + After Effects
- User has BOTH hosts on this machine: Premiere Pro CC 2019 and After Effects 2023 → no UXP; build ONE CEP extension (shared HTML/JS panel; host-specific ExtendScript for PPRO and AEFT).
- Panel: preset dropdown (read Media Converter's presets) + "Export & convert". Host renders an intermediate (PR: sequence.exportAsMediaDirect with a ProRes/DNxHR .epr; AE: render queue item + output module template), then hands the file to Media Converter.
- Media Converter side: a command interface (CLI args / second-instance message: files + presetIds + output dir + start) — unit/e2e testable without Adobe.
- Testing: AE 2023 supports `AfterFX.exe -r script.jsx` → automate the AE path here; PR 2019 has no CLI scripting → user tests the panel manually.
- Install: package as a self-signed ZXP (ZXPSignCmd) instead of asking the user to enable PlayerDebugMode in the registry.
- Until then the recommended workflow is a watch folder: export a ProRes/DNxHR master from PR/AE into it.

## 1. Rename / copy-only mode (no re-encode)
Bulk file operations that never touch file contents (like a batch renamer).
- New preset kind `file` (category `file`): `{ operation: 'copy' | 'move' | 'rename' }`.
  - copy → write a byte-identical copy to the output folder with the templated name
  - move → move to the output folder with the templated name
  - rename → rename in place (same folder)
- Works for ANY file type (not only supported media) when this mode is used for a folder.
- Same name template + tokens as conversions, plus `{exifdate}` (photo taken date, fallback mtime) and `{mdate}` (file modified date).
- `{counter}` order must be deterministic: natural sort by name (option: by modified date / EXIF date).
- Preview table before running: old name → new name, conflicts highlighted; nothing happens until the user confirms.
- Conflict policy reused (rename / overwrite / skip); never two outputs with the same name.
- Undo for move/rename: keep a journal (userData) of the last operation; "Undo last rename" restores original names/locations.
- Built-in presets: "Copy & rename", "Rename in place", "Move & rename".

## 2. Preserve folder structure
- When a folder is added, each job remembers `relativeDir` (path of the file's folder relative to the added root).
- `OutputTarget.preserveStructure: boolean` — when an output folder is set and this is on, output = `<dir>/<relativeDir>/<name>.<ext>`; create folders as needed.
- Default on for folder adds with an explicit output folder; option in the add flow, job editor output row and settings default.
- Watch folders with "include subfolders" keep the structure inside Output (same rule).

## Also pending from round 2
- Review workflow (main-process correctness, UI/UX + zh-TW/en/ja copy, packaging) → fixes.
- `npm run dist` → NSIS installer + portable; test install on this machine.
- Verify HEIC / JPEG XL input with real files (user to provide an iPhone HEIC).
- App name still "Media Converter" (placeholder) — user to decide before packaging.

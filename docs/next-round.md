# Next round (requested 2026-10-01)

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

# Media Converter

Desktop batch converter for anyone: an Adobe Media Encoder–style encode queue (video/audio via a bundled ffmpeg) combined with XnConvert-style image action chains (via sharp/libvips). Electron + electron-vite + React + TypeScript. UI languages: zh-TW (default), en, ja.

## Commands
- `npm run dev` — Electron app with HMR
- `npm run dev:web` — renderer only in a browser at http://localhost:5199, backed by `src/renderer/src/mockApi.ts` (no Electron)
- `npm run typecheck` / `npm test` (vitest, `tests/**`; `tests/renderer/**` imports renderer code and is type-checked by `tsconfig.web.json`) / `npm run e2e` (Playwright `_electron`, `e2e/**`, needs `npm run build` first)
- `npm run fetch-ffmpeg` — download ffmpeg/ffprobe into `resources/bin/<platform>-<arch>/` (bundled into the installer)
- `npm run dist` — Windows NSIS installer + portable exe into `release/`

## Architecture
- `src/shared/` — the contract. `types.ts` (data model), `api.ts` (`MediaApi` = `window.api`, IPC channel names), `media.ts` (extension → kind). Pure TS, no Node/DOM imports; imported by every layer with relative paths.
- `src/main/contracts.ts` — `FfmpegEngine` / `ImageEngine` interfaces. Engines never import Electron so they run under plain Node in vitest.
- `src/main/ffmpeg/` — probe, capability/hw-encoder detection, preset → args, encode runner (progress via `-progress pipe:1`), frame extraction. `paths.ts` resolves binaries: custom → bundled → PATH.
- `src/main/image/` — sharp action pipeline, output formats, preview, watermark rendering (text rendered with sharp/Pango, also used as the PNG overlay for video watermarks).
- `src/main/` (core) — `index.ts` app/window lifecycle, `ipc.ts` (single `mc:invoke` channel dispatching `MediaApi` methods), `protocol.ts` (`media://` local-file protocol with Range), `store.ts` (JSON persistence in userData), `queue/` (job queue, output naming/conflicts, temp-file-then-rename), `presets/` (built-ins + user presets), `watch/` (chokidar watch folders).
- `src/preload/index.ts` — exposes `window.api` via contextBridge (sandboxed, CommonJS output `index.cjs`).
- `src/renderer/` — React UI (zustand store, `i18n/` dictionaries, dark AME-like theme, light theme optional).

## Conventions
- Output files are written to a temp name next to the target, then renamed on success; partial files are deleted on failure/cancel. Engines must pass explicit formats (`-f <muxer>`, sharp `.toFormat()`), never infer from the temp extension.
- Paths may contain spaces and CJK characters — never build shell strings; always `spawn(bin, argsArray)` with `windowsHide: true`.
- Hardware encoders: `hw: 'auto'` picks a working GPU encoder (NVENC → QSV → AMF → VideoToolbox) and falls back to software if the GPU encode fails.
- User-facing strings go through i18n (`t('key')`); add keys to all three dictionaries.

// Contract between Media Converter and the Adobe Premiere Pro / After Effects panel ("Send to Media Converter").
// Transport is a folder, no network: <userData>/bridge/ (Windows: %APPDATA%\Media Converter\bridge\).
//
//   bridge/info.json            written by Media Converter on startup and whenever presets/locale change (atomic write)
//   bridge/inbox/<id>.json      written by the panel (write "<id>.json.tmp" then rename); Media Converter consumes and
//                               deletes it, then writes bridge/results/<id>.json
//   bridge/intermediates/       where the panel renders intermediate masters; Media Converter may delete files here
//                               (and only here) after their jobs finished successfully when deleteAfter is true
//
// The panel launches info.exePath when Media Converter is not running; pending inbox files are processed on startup.

export const BRIDGE_VERSION = 1

export interface BridgePreset {
  id: string
  kind: 'video' | 'image'
  /** Display name in the app's current UI language. */
  name: string
  names?: Partial<Record<'zh-TW' | 'en' | 'ja', string>>
  category: string
  builtIn: boolean
  /** Short human summary, e.g. "MP4 · H.264 · 1920×1080". */
  summary: string
}

export interface BridgeInfo {
  bridgeVersion: number
  appVersion: string
  /** Absolute path of the Media Converter executable (packaged) — the panel launches it when needed. */
  exePath: string
  /** UI language of the app ('zh-TW' | 'en' | 'ja'). */
  locale: string
  updatedAt: number
  /** Video presets only (the panel sends rendered video). */
  presets: BridgePreset[]
  lastVideoPresetId: string
  /** Output folder the app would use by default (null = next to the source). */
  defaultOutputDir: string | null
}

export interface BridgeRequest {
  bridgeVersion: number
  /** Unique id (also the file name). */
  id: string
  /** 'premiere' | 'aftereffects' — informational. */
  host: string
  /** Absolute paths of rendered intermediates (or any media files). */
  files: string[]
  /** One job per file × preset. Unknown ids are reported in the result and skipped. */
  presetIds: string[]
  /** null = next to the source (for intermediates that means bridge/intermediates — so the panel should always send one). */
  outputDir: string | null
  /** Output file name template (same tokens as the app); null = app default. */
  nameTemplate?: string | null
  /** Delete each intermediate after all of its jobs succeeded. Only honoured for files inside bridge/intermediates/. */
  deleteAfter: boolean
  /** Start the queue right away (restricted to these jobs). */
  start: boolean
  createdAt: number
}

export interface BridgeResult {
  id: string
  /** 'accepted' = jobs queued; 'rejected' = nothing queued (see errors). */
  status: 'accepted' | 'rejected'
  jobIds: string[]
  errors: string[]
  handledAt: number
}

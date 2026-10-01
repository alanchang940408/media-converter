// Shared contract between main process, preload and renderer.
// Pure types only — no runtime code, no Node/DOM imports.

export type Locale = 'zh-TW' | 'en' | 'ja'
export type LocalizedText = Partial<Record<Locale, string>>

export type MediaKind = 'video' | 'audio' | 'image'

export interface MediaInfo {
  path: string
  kind: MediaKind
  sizeBytes: number
  /** Container / image format name as reported by ffprobe or sharp (e.g. "mov,mp4,m4a", "jpeg"). */
  format?: string
  durationSec?: number
  width?: number
  height?: number
  fps?: number
  videoCodec?: string
  audioCodec?: string
  pixFmt?: string
  /** Display rotation in degrees from stream side data / EXIF (0, 90, 180, 270). Width/height are already the *displayed* size. */
  rotation?: number
  hasAudio: boolean
  hasAlpha?: boolean
  audioChannels?: number
  audioSampleRate?: number
  /** Bits per sample of the source audio (16, 24, 32…), when known. */
  audioBitDepth?: number
  bitrateKbps?: number
  /** Animated images (gif/webp): number of frames. */
  frameCount?: number
  /** Photos: EXIF DateTimeOriginal (fallback CreateDate) as epoch ms, local wall-clock time. */
  takenAt?: number
}

// ───────────────────────────── Overlays / watermark ─────────────────────────────

export type Anchor =
  | 'top-left' | 'top' | 'top-right'
  | 'left' | 'center' | 'right'
  | 'bottom-left' | 'bottom' | 'bottom-right'

interface WatermarkBase {
  anchor: Anchor
  /** Margin from the anchored edges, in % of the output frame's shorter side. */
  marginPct: number
  /** 0..1 */
  opacity: number
}

export interface ImageWatermark extends WatermarkBase {
  type: 'image'
  /** Absolute path to a PNG/JPEG/WebP/SVG logo. */
  path: string
  /** Logo width as % of the output frame width (aspect preserved). */
  scalePct: number
}

export interface TextWatermark extends WatermarkBase {
  type: 'text'
  /** Supports tokens: {name} (source file name without ext), {date} (YYYY-MM-DD). */
  text: string
  /** Font size as % of the output frame height. */
  fontSizePct: number
  /** #rrggbb */
  color: string
  fontFamily?: string
  bold?: boolean
  shadow?: boolean
  /** Optional box behind the text, #rrggbb or null. Box uses the same opacity. */
  background?: string | null
}

export type Watermark = ImageWatermark | TextWatermark

// ───────────────────────────── Video / audio presets ─────────────────────────────

export type VideoContainer = 'mp4' | 'mov' | 'mkv' | 'webm' | 'gif'
export type AudioContainer = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg'
export type OutputContainer = VideoContainer | AudioContainer

export type VideoCodecId = 'h264' | 'hevc' | 'av1' | 'vp9' | 'prores' | 'dnxhr' | 'gif' | 'copy' | 'none'
export type AudioCodecId = 'aac' | 'mp3' | 'opus' | 'pcm' | 'flac' | 'copy' | 'none'

/** 'auto' = best working hardware encoder for the codec, falling back to software. */
export type HwAccel = 'auto' | 'none' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox'

export type RateControl =
  /** Constant quality on the x264 CRF scale (0 = lossless … 51 = worst; 18 ≈ visually lossless, 23 = default). Engine maps it per encoder. */
  | { mode: 'crf'; crf: number }
  | { mode: 'vbr'; bitrateKbps: number; maxKbps?: number }
  | { mode: 'cbr'; bitrateKbps: number }

export type EncodeSpeed = 'fast' | 'balanced' | 'quality'

/**
 * How to fit the source into width×height when both are set.
 * fit     = scale to fit inside the box, keep aspect (result may be smaller on one axis)
 * pad     = fit inside, then letterbox/pillarbox to exactly width×height (black bars)
 * crop    = fill the box, keep aspect, centre-crop the overflow
 * stretch = ignore aspect
 */
export type ScaleMode = 'fit' | 'pad' | 'crop' | 'stretch'

export type ProResProfile = 'proxy' | 'lt' | 'standard' | 'hq' | '4444' | '4444xq'
export type DnxhrProfile = 'lb' | 'sq' | 'hq' | 'hqx' | '444'

export interface GifSettings {
  fps: number
  /** Output width in px; height keeps aspect. null = source width. */
  width: number | null
  /** 2..256 */
  colors: number
  dither: 'none' | 'bayer' | 'floyd_steinberg' | 'sierra2_4a'
  /** 0 = loop forever, -1 = play once, n = repeat n times */
  loop: number
}

export interface VideoPresetSettings {
  container: OutputContainer
  video: {
    codec: VideoCodecId
    hw: HwAccel
    rate: RateControl
    speed: EncodeSpeed
    /** prores: ProResProfile, dnxhr: DnxhrProfile, h264: 'baseline'|'main'|'high'. Ignored otherwise. */
    profile?: string | null
    /** null = keep source. If only one is set the other follows aspect ratio. Values are rounded to even numbers. */
    width: number | null
    height: number | null
    scaleMode: ScaleMode
    /** Never scale above the source size. */
    noUpscale: boolean
    /** null = keep source frame rate */
    fps: number | null
    /** 10-bit output for hevc/av1 (yuv420p10le / p010). Ignored for 8-bit-only codecs. */
    tenBit?: boolean
    gif?: GifSettings
  }
  audio: {
    codec: AudioCodecId
    bitrateKbps?: number | null
    /** null = keep source */
    sampleRate?: number | null
    /** null = keep source, 1 = mono, 2 = stereo */
    channels?: number | null
    /** EBU R128 loudness normalisation to -16 LUFS (single-pass loudnorm). */
    normalize?: boolean
  }
  watermark?: Watermark | null
  /** mp4/mov: move moov atom to the front for web playback. */
  faststart?: boolean
  /** Drop global metadata (-map_metadata -1). */
  stripMetadata?: boolean
}

export interface Trim {
  inSec: number
  outSec: number
}

// ───────────────────────────── Image (XnConvert-style) ─────────────────────────────

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'tiff' | 'gif'

export interface ImageOutputSettings {
  /** 'keep' = same format as the source (falls back to png if the source format cannot be written). */
  format: ImageFormat | 'keep'
  /** 1..100, used by jpeg/webp/avif/tiff(jpeg compression). */
  quality: number
  /** webp/avif lossless mode. */
  lossless?: boolean
  /** jpeg progressive / png interlaced. */
  progressive?: boolean
  /** jpeg/avif: '4:4:4' disables chroma subsampling. */
  chromaSubsampling?: '4:2:0' | '4:4:4'
  /** png zlib level 0..9 */
  pngCompression?: number
  /** Keep EXIF/XMP/ICC metadata. When false only the ICC profile is kept (converted to sRGB). */
  keepMetadata: boolean
  /** Background used when flattening alpha into a format without alpha (jpeg). #rrggbb */
  background?: string
  /** Write this DPI into the output metadata (null = untouched). */
  dpi?: number | null
}

interface ImageActionBase {
  id: string
  enabled: boolean
}

export type ResizeMode =
  /** fit inside width×height keeping aspect */
  | 'fit'
  /** cover width×height keeping aspect, centre-crop overflow */
  | 'fill'
  /** exactly width×height, ignore aspect */
  | 'stretch'
  /** scale by percent */
  | 'percent'
  /** longest edge = size */
  | 'longEdge'
  /** shortest edge = size */
  | 'shortEdge'
  /** width only, height follows aspect */
  | 'width'
  /** height only, width follows aspect */
  | 'height'

export type ImageAction =
  | (ImageActionBase & {
      type: 'resize'
      mode: ResizeMode
      width?: number
      height?: number
      percent?: number
      size?: number
      /** Do not enlarge smaller images. */
      withoutEnlargement: boolean
      kernel?: 'lanczos3' | 'mitchell' | 'cubic' | 'nearest'
    })
  | (ImageActionBase & {
      type: 'crop'
      /** rect = explicit pixel rectangle; aspect = largest centred (gravity) crop of the given ratio; edges = remove px from each edge */
      mode: 'rect' | 'aspect' | 'edges'
      left?: number
      top?: number
      width?: number
      height?: number
      /** e.g. "1:1", "4:3", "16:9", "9:16" */
      aspect?: string
      gravity?: Anchor | 'attention' | 'entropy'
      edges?: { top: number; right: number; bottom: number; left: number }
    })
  | (ImageActionBase & {
      type: 'rotate'
      /** Degrees clockwise. Non-multiples of 90 expand the canvas filled with `background`. */
      angle: number
      background?: string
    })
  | (ImageActionBase & { type: 'flip'; axis: 'horizontal' | 'vertical' })
  /** Apply EXIF orientation and reset it. */
  | (ImageActionBase & { type: 'autoOrient' })
  | (ImageActionBase & {
      type: 'adjust'
      /** -100..100, 0 = unchanged */
      brightness: number
      /** -100..100 */
      contrast: number
      /** -100..100 (-100 = grayscale) */
      saturation: number
      /** -180..180 degrees */
      hue: number
      /** 0.1..3, 1 = unchanged */
      gamma: number
    })
  | (ImageActionBase & { type: 'grayscale' })
  | (ImageActionBase & { type: 'sepia' })
  | (ImageActionBase & { type: 'invert' })
  | (ImageActionBase & { type: 'sharpen'; sigma: number })
  | (ImageActionBase & { type: 'blur'; sigma: number })
  /** Add a border / padding around the image. */
  | (ImageActionBase & {
      type: 'canvas'
      top: number
      right: number
      bottom: number
      left: number
      /** px or % of the shorter side */
      unit: 'px' | 'pct'
      color: string
    })
  /** Auto-trim uniform borders. */
  | (ImageActionBase & { type: 'trim'; threshold: number })
  | (ImageActionBase & { type: 'watermark'; watermark: Watermark })

export type ImageActionType = ImageAction['type']

// ───────────────────────────── Presets ─────────────────────────────

export type PresetCategory = 'web' | 'social' | 'editing' | 'archive' | 'device' | 'gif' | 'audio' | 'image' | 'file' | 'custom'

interface PresetBase {
  id: string
  /** Fallback name (English). */
  name: string
  /** Localised names for built-ins; renderer shows names[locale] ?? name. */
  names?: LocalizedText
  description?: string
  descriptions?: LocalizedText
  category: PresetCategory
  builtIn: boolean
}

export interface VideoPreset extends PresetBase {
  kind: 'video'
  settings: VideoPresetSettings
}

export interface ImagePreset extends PresetBase {
  kind: 'image'
  actions: ImageAction[]
  output: ImageOutputSettings
}

/**
 * File operations that never touch file contents (batch rename / copy / move). Applies to ANY file type.
 * copy   → byte-identical copy into the output folder with the templated name
 * move   → move into the output folder with the templated name
 * rename → rename in place (output folder is ignored)
 */
export type FileOperation = 'copy' | 'move' | 'rename'

export interface FilePreset extends PresetBase {
  kind: 'file'
  operation: FileOperation
}

export type Preset = VideoPreset | ImagePreset | FilePreset
export type PresetKind = Preset['kind']

// ───────────────────────────── Output / naming ─────────────────────────────

export type ConflictPolicy = 'rename' | 'overwrite' | 'skip'

export interface OutputTarget {
  /** null = next to the source file */
  dir: string | null
  /**
   * File name template without extension. Tokens:
   * {name} source base name · {ext} source extension (no dot) · {preset} preset name ·
   * {date} YYYY-MM-DD · {time} HHmmss · {counter} / {counter:3} running number (zero padded) ·
   * {width} {height} output size · {parent} source parent folder name ·
   * {exifdate} YYYY-MM-DD / {exiftime} HHmmss photo taken (fallback: file modified) · {mdate} file modified YYYY-MM-DD
   */
  nameTemplate: string
  conflict: ConflictPolicy
  /**
   * Only when `dir` is set: recreate the job's `relativeDir` below `dir` (keeps the subfolder layout of an added folder
   * or a watch folder). Missing (older queue/preset data) = false.
   */
  preserveStructure?: boolean
}

// ───────────────────────────── Jobs / queue ─────────────────────────────

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface Job {
  id: string
  /** 'file' = rename / copy / move without touching contents (any file type). */
  kind: 'video' | 'image' | 'file'
  /** Absolute source path. */
  source: string
  /**
   * Folder of the source relative to the folder the user added (or the watch folder), using the OS separator;
   * '' when the file sits directly in that folder; undefined when the file was added on its own.
   */
  relativeDir?: string
  sourceInfo?: MediaInfo
  presetId: string
  /** Preset display name snapshot at add time (already localised by main using current locale). */
  presetName: string
  /** Present when kind === 'video' (also used for audio-only encodes). Settings are a snapshot; editing a job edits this copy. */
  video?: { settings: VideoPresetSettings; trim?: Trim | null }
  /** Present when kind === 'image'. */
  image?: { actions: ImageAction[]; output: ImageOutputSettings }
  /** Present when kind === 'file'. */
  file?: { operation: FileOperation }
  output: OutputTarget
  /** Final resolved output path (set when the job starts). */
  outputPath?: string
  status: JobStatus
  /** 0..1 */
  progress: number
  /** encode speed relative to realtime, e.g. 2.4 */
  speed?: number
  fps?: number
  etaSec?: number
  elapsedSec?: number
  /** Encoder actually used, e.g. "h264_nvenc" or "libx264" or "sharp". */
  encoder?: string
  /** Human readable error (first meaningful ffmpeg/sharp error line). */
  error?: string
  /** Last ~40 log lines (ffmpeg stderr), for the details view. */
  logTail?: string[]
  outputSizeBytes?: number
  watchFolderId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

/** Fields of a queued job the UI may change. */
export interface JobPatch {
  presetId?: string
  video?: { settings?: VideoPresetSettings; trim?: Trim | null }
  image?: { actions?: ImageAction[]; output?: ImageOutputSettings }
  file?: { operation?: FileOperation }
  output?: Partial<OutputTarget>
}

export interface QueueSnapshot {
  jobs: Job[]
  /** Queue started (AME's green ▶). Jobs only begin while running. */
  running: boolean
}

export interface JobProgress {
  id: string
  progress: number
  speed?: number
  fps?: number
  etaSec?: number
  elapsedSec?: number
}

export type QueueEvent =
  /** Full state — sent after any structural change (add/remove/reorder/status change). */
  | { type: 'snapshot'; state: QueueSnapshot }
  /** Throttled (≤ 5/s per job) progress for running jobs. */
  | { type: 'progress'; items: JobProgress[] }
  | { type: 'finished'; summary: { done: number; failed: number; cancelled: number; skipped: number } }

export interface AddJobsRequest {
  /**
   * Files and/or folders. Folders are expanded (recursively if `recursive`) in natural name order (2 before 10), which
   * also defines {counter}. Unsupported files are ignored and reported — except in file mode, which accepts every file.
   */
  paths: string[]
  recursive?: boolean
  /**
   * File mode: when set, EVERY file (any type, hidden/system files and our temp files excluded) becomes a 'file' job with
   * this FilePreset; videoPresetId / imagePresetId / imageOverride are ignored.
   */
  filePresetId?: string | null
  /** Sort order used for expansion and {counter}. Default 'name'. */
  sortBy?: 'name' | 'modified' | 'taken'
  /** Preset applied to video & audio sources (null → settings.lastVideoPresetId). */
  videoPresetId?: string | null
  /** Preset applied to image sources (null → settings.lastImagePresetId). */
  imagePresetId?: string | null
  /** Ad-hoc image action chain instead of a stored preset. */
  imageOverride?: { actions: ImageAction[]; output: ImageOutputSettings } | null
  output?: Partial<OutputTarget>
  watchFolderId?: string
}

export interface AddJobsResult {
  jobs: Job[]
  /** Paths that were ignored (unsupported type, unreadable). */
  ignored: string[]
}

// ───────────────────────────── File operations (rename / copy / move) ─────────────────────────────

/** One row of the "old name → new name" table shown before file jobs run. Computed without touching any file. */
export interface FileOpPreviewItem {
  jobId: string
  source: string
  /** Resolved destination (null when status is 'skip'). */
  target: string | null
  /**
   * ok        → target is free
   * renamed   → name was taken, " (n)" appended (conflict 'rename')
   * overwrite → an existing file will be replaced (conflict 'overwrite')
   * skip      → name taken and conflict 'skip'
   * unchanged → target equals the source (nothing to do)
   */
  status: 'ok' | 'renamed' | 'overwrite' | 'skip' | 'unchanged'
}

/** The most recent run of move/rename jobs that can be undone (copies are not journaled — delete them instead). */
export interface FileOpUndoInfo {
  id: string
  finishedAt: number
  count: number
  operations: { move: number; rename: number }
}

export interface FileOpUndoResult {
  restored: number
  failed: { path: string; error: string }[]
}

// ───────────────────────────── Watch folders ─────────────────────────────

export interface WatchFolder {
  id: string
  path: string
  enabled: boolean
  /** One output per preset (AME allows several outputs per watch folder). Video presets apply to video/audio files, image presets to images. */
  presetIds: string[]
  /** null = "<path>/Output". The output folder is always excluded from watching. */
  outputDir: string | null
  includeSubfolders: boolean
  /** After all outputs for a source succeed: keep it in place, or move it to "<path>/Source". */
  afterProcess: 'keep' | 'move'
  /** Also process files already present when the watch starts (each file is processed once; tracked by path+size+mtime). */
  processExisting: boolean
}

// ───────────────────────────── Settings / system ─────────────────────────────

export interface AppSettings {
  language: 'auto' | Locale
  theme: 'dark' | 'light' | 'system'
  /** Simultaneous video encodes (1..4). */
  videoConcurrency: number
  /** Simultaneous image jobs (1..16). */
  imageConcurrency: number
  /** Start encoding as soon as jobs are added. */
  autoStart: boolean
  defaultOutputDir: string | null
  defaultNameTemplate: string
  conflict: ConflictPolicy
  /** Global hardware preference; a preset's hw:'auto' resolves through this. 'auto' = use GPU when available. */
  preferredHw: HwAccel
  lastVideoPresetId: string
  lastImagePresetId: string
  lastFilePresetId: string
  /** Default for OutputTarget.preserveStructure when folders are added with an output folder. */
  preserveStructure: boolean
  notifyOnFinish: boolean
  /** Keep the computer awake while the queue is encoding. */
  preventSleep: boolean
  /** Remove finished jobs from the queue automatically. */
  removeFinished: boolean
  /** Custom ffmpeg binary (folder or ffmpeg executable); null = bundled. */
  ffmpegPath: string | null
}

export interface EncoderCapabilities {
  ffmpegPath: string
  ffprobePath: string
  ffmpegVersion: string
  /** 'bundled' | 'custom' | 'system' (found on PATH) */
  ffmpegSource: 'bundled' | 'custom' | 'system' | 'missing'
  /** Encoders compiled into ffmpeg (subset we care about), e.g. ["libx264","libx265","h264_nvenc",...]. */
  compiledEncoders: string[]
  /** Hardware encoders that passed a real test encode on this machine. */
  workingHwEncoders: string[]
  /** Convenience: which hw families work for at least h264. */
  hw: { nvenc: boolean; qsv: boolean; amf: boolean; videotoolbox: boolean }
}

export interface AppInfo {
  name: string
  version: string
  /** process.platform, e.g. "win32", "darwin", "linux" */
  platform: string
  arch: string
  /** Resolved UI locale. */
  locale: Locale
  userDataDir: string
  electronVersion: string
  sharpVersion?: string
  libvipsVersion?: string
}

export interface ImagePreviewResult {
  /** data: URLs, browser-displayable */
  before: string
  after: string
  /** Full-resolution output size after the action chain. */
  outWidth: number
  outHeight: number
}

export type FileKindFilter = 'media' | 'video' | 'image' | 'audio' | 'watermark' | 'presets'

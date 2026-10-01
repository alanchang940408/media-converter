// Interfaces between the main-process modules.
//   src/main/ffmpeg/index.ts  must `export const ffmpegEngine: FfmpegEngine`
//   src/main/image/index.ts   must `export const imageEngine: ImageEngine`
// The queue / IPC layer only talks to the engines through these interfaces.
// Engines must not import Electron (so they run under plain Node in vitest).
import type {
  EncoderCapabilities,
  ImageAction,
  ImageOutputSettings,
  MediaInfo,
  Trim,
  VideoPresetSettings,
  Watermark,
} from '../shared/types'

// ───────────────────────────── ffmpeg engine ─────────────────────────────

export interface EncodeProgress {
  /** 0..1 */
  fraction: number
  fps?: number
  speed?: number
  etaSec?: number
  elapsedSec: number
}

export interface VideoOverlay {
  /** PNG with alpha, already sized for the output frame. */
  pngPath: string
  /** Top-left position in output-frame pixels. */
  left: number
  top: number
}

export interface VideoEncodeRequest {
  source: string
  info: MediaInfo
  settings: VideoPresetSettings
  trim?: Trim | null
  /** Exact path to write. May be a temporary name whose extension does not match — always pass an explicit muxer (-f). */
  dest: string
  overlay?: VideoOverlay | null
  caps: EncoderCapabilities
  /** Global hardware preference from AppSettings.preferredHw; used when settings.video.hw === 'auto'. */
  preferredHw: VideoPresetSettings['video']['hw']
  signal: AbortSignal
  onProgress: (p: EncodeProgress) => void
  onLog?: (line: string) => void
}

export interface VideoEncodeResult {
  /** Encoder actually used (after any hardware → software fallback), e.g. "h264_nvenc", "libx264", "prores_ks", "gif". */
  encoder: string
  args: string[]
}

/** Thrown by encode() on non-zero exit. `message` = first meaningful error line; `logTail` = last ~40 stderr lines. */
export class EncodeError extends Error {
  constructor(
    message: string,
    public readonly logTail: string[],
    public readonly exitCode: number | null,
  ) {
    super(message)
    this.name = 'EncodeError'
  }
}

export interface FfmpegEngine {
  probe(path: string): Promise<MediaInfo>
  /** Detect compiled + working hardware encoders (test-encodes a tiny clip per hw encoder). Cached; `force` re-detects. */
  detectCapabilities(force?: boolean): Promise<EncoderCapabilities>
  /** File extension (no dot) for the preset's container, e.g. "mp4", "gif", "m4a". */
  outputExtension(settings: VideoPresetSettings): string
  /** Output frame size after scaling (even numbers), or null for audio-only outputs. */
  computeOutputSize(info: MediaInfo, settings: VideoPresetSettings): { width: number; height: number } | null
  /** Pure: build the ffmpeg argument list (without the ffmpeg binary itself). Also returns the encoder chosen. */
  buildArgs(req: Omit<VideoEncodeRequest, 'signal' | 'onProgress' | 'onLog'>): { args: string[]; encoder: string }
  /**
   * Run the encode. Resolves on success. On hardware-encoder failure, retries once with the software encoder.
   * On abort: kills ffmpeg, rejects with an Error whose name is 'AbortError'. Never leaves the process running.
   */
  encode(req: VideoEncodeRequest): Promise<VideoEncodeResult>
  /** Decode one frame at `timeSec` scaled to fit maxWidth (or exactly width×height when given). Returns JPEG (default) or PNG bytes. */
  extractFrame(
    path: string,
    timeSec: number,
    opts?: { maxWidth?: number; width?: number; height?: number; format?: 'jpeg' | 'png' },
  ): Promise<Buffer>
  /** Decode a still image that sharp cannot read (bmp, tga, heic, exr, dds…) to PNG bytes. */
  decodeImageToPng(path: string): Promise<Buffer>
}

// ───────────────────────────── image engine ─────────────────────────────

export interface ImageProcessRequest {
  source: string
  actions: ImageAction[]
  output: ImageOutputSettings
  /** Exact path to write (may be a temporary name) — always set the output format explicitly. */
  dest: string
  signal?: AbortSignal
}

export interface ImageProcessResult {
  width: number
  height: number
  bytes: number
  /** sharp output format actually written, e.g. "jpeg" */
  format: string
}

export interface WatermarkLayer {
  /** PNG with alpha (opacity baked in). */
  png: Buffer
  left: number
  top: number
  width: number
  height: number
}

export interface ImageEngine {
  /** Includes `takenAt` (EXIF DateTimeOriginal, local wall clock) when the photo has one. */
  probe(path: string): Promise<MediaInfo>
  /**
   * EXIF taken time of ANY file (epoch ms, local wall clock) without decoding it — header read only.
   * undefined when there is none (non-photos, stripped metadata). Never throws.
   */
  readTakenAt(path: string): Promise<number | undefined>
  /** Extension (no dot) the output will have, e.g. "jpg", "png", "webp". Resolves format 'keep' against the source. */
  outputExtension(output: ImageOutputSettings, sourcePath: string): string
  process(req: ImageProcessRequest): Promise<ImageProcessResult>
  /** Before/after preview (fit within maxSize px). Images are browser-displayable (jpeg/png/webp/gif). */
  preview(req: {
    source: string
    actions: ImageAction[]
    output: ImageOutputSettings
    maxSize: number
  }): Promise<{ before: Buffer; beforeMime: string; after: Buffer; afterMime: string; outWidth: number; outHeight: number }>
  /** JPEG thumbnail of an image file fitting maxSize. */
  thumbnail(path: string, maxSize: number): Promise<Buffer>
  /** Render a watermark positioned for a frame of frameW×frameH (used for video overlays). `vars` fills text tokens. */
  renderWatermarkLayer(
    wm: Watermark,
    frameW: number,
    frameH: number,
    vars?: { name?: string; date?: string },
  ): Promise<WatermarkLayer>
  /** Composite a watermark onto an encoded image buffer (e.g. a video frame for preview). Returns JPEG. */
  compositeWatermark(input: Buffer, wm: Watermark, vars?: { name?: string; date?: string }): Promise<Buffer>
}

// ffprobe → MediaInfo
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { MediaInfo, MediaKind } from '../../shared/types'
import { classifyPath } from '../../shared/media'
import { getFfmpegPaths } from './paths'
import { isSpawnError, runCapture } from './proc'

interface FfprobeStream {
  index?: number
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  /** "num:den", e.g. "32:27"; "0:1" / absent when unknown */
  sample_aspect_ratio?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  nb_frames?: string
  channels?: number
  sample_rate?: string
  sample_fmt?: string
  bits_per_raw_sample?: string
  bits_per_sample?: number
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: Array<{ side_data_type?: string; rotation?: number | string }>
}

export interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string }
}

const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '' || v === 'N/A') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** MediaInfo as this engine produces it (the pixel aspect fields are now part of the shared contract). */
export type ProbedMediaInfo = MediaInfo

/** "32:27" → 1.185…; undefined for unknown ("0:1", "N/A"), garbage or square (1:1) pixels. */
export function parseSampleAspect(r?: string): number | undefined {
  const m = /^\s*(\d+)\s*[:/]\s*(\d+)\s*$/.exec(r ?? '')
  if (!m) return undefined
  const v = Number(m[1]) / Number(m[2])
  if (!Number.isFinite(v) || v <= 0 || Math.abs(v - 1) < 1e-3) return undefined
  return v
}

/** "30000/1001" → 29.97 (3 decimals); undefined for 0/0 or garbage. */
export function parseRate(r?: string): number | undefined {
  if (!r) return undefined
  const [a, b] = r.split('/').map(Number)
  const v = b === undefined ? a : b ? a / b : NaN
  if (!Number.isFinite(v) || v <= 0) return undefined
  return Math.round(v * 1000) / 1000
}

/** Clockwise display rotation (0/90/180/270). Display-matrix rotation is counter-clockwise; the legacy `rotate` tag is clockwise. */
export function streamRotation(s: FfprobeStream): number {
  let cw: number | undefined
  const sd = s.side_data_list?.find((d) => d.rotation !== undefined && d.rotation !== '')
  if (sd) {
    const r = num(sd.rotation)
    if (r !== undefined) cw = -r
  }
  if (cw === undefined) cw = num(s.tags?.rotate)
  if (cw === undefined) return 0
  return (((Math.round(cw / 90) * 90) % 360) + 360) % 360
}

export function pixFmtHasAlpha(pixFmt?: string): boolean {
  return !!pixFmt && /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d)/.test(pixFmt)
}

/**
 * Source sample depth for lossless/PCM audio: bits_per_raw_sample (flac/alac), else bits_per_sample (pcm), else the
 * sample format. Lossy codecs (aac, mp3, opus…) decode to float, which says nothing about quality → undefined.
 */
export function audioBitDepth(s: FfprobeStream): number | undefined {
  if (!/^(pcm_|flac|alac|wavpack|tta|truehd|mlp)/.test(s.codec_name ?? '')) return undefined
  const raw = num(s.bits_per_raw_sample) || (s.bits_per_sample ? s.bits_per_sample : undefined)
  if (raw) return raw
  const m = /^(s|u)(8|16|32|64)|^(flt|dbl)/.exec(s.sample_fmt ?? '')
  if (!m) return undefined
  return m[3] ? (m[3] === 'flt' ? 32 : 64) : Number(m[2])
}

/** Pure mapping of ffprobe JSON to MediaInfo (exported for tests). */
export function mapProbe(json: FfprobeOutput, path: string, sizeBytes: number): ProbedMediaInfo {
  const streams = json.streams ?? []
  const fmt = json.format ?? {}
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  if (!video && !audio) throw new Error(`No audio or video stream found in ${basename(path)}`)

  const formatName = fmt.format_name
  let kind: MediaKind = video ? 'video' : 'audio'
  if (video && (classifyPath(path) === 'image' || /^image2$|_pipe$/.test(formatName ?? ''))) kind = 'image'

  const info: ProbedMediaInfo = {
    path,
    kind,
    sizeBytes: sizeBytes || num(fmt.size) || 0,
    format: formatName,
    hasAudio: !!audio,
  }

  const duration = num(fmt.duration) ?? num(video?.duration) ?? num(audio?.duration)
  if (duration !== undefined && duration > 0) info.durationSec = duration
  const br = num(fmt.bit_rate)
  if (br !== undefined && br > 0) info.bitrateKbps = Math.round(br / 1000)

  if (video) {
    const rotation = streamRotation(video)
    const swap = rotation === 90 || rotation === 270
    const parsedSar = parseSampleAspect(video.sample_aspect_ratio)
    const sar = parsedSar === undefined ? undefined : swap ? 1 / parsedSar : parsedSar
    const w = video.width
    const h = video.height
    if (w && h) {
      const sw = swap ? h : w
      const sh = swap ? w : h
      // width/height are what a player shows: rotated, and widened/narrowed by a non-square pixel aspect
      info.width = sar === undefined ? sw : Math.max(1, Math.round(sw * sar))
      info.height = sh
      if (sar !== undefined) {
        info.storageWidth = sw
        info.storageHeight = sh
      }
    }
    info.rotation = rotation
    if (sar !== undefined) info.sampleAspectRatio = sar
    const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)
    if (fps !== undefined) info.fps = fps
    info.videoCodec = video.codec_name
    info.pixFmt = video.pix_fmt
    info.hasAlpha = pixFmtHasAlpha(video.pix_fmt)
    const frames = num(video.nb_frames)
    if (kind === 'image' && frames !== undefined) info.frameCount = frames
  }
  if (audio) {
    info.audioCodec = audio.codec_name
    if (audio.channels) info.audioChannels = audio.channels
    const sr = num(audio.sample_rate)
    if (sr) info.audioSampleRate = sr
    const depth = audioBitDepth(audio)
    if (depth) info.audioBitDepth = depth
  }
  return info
}

function missingMessage(bin: string): string {
  return `ffprobe was not found (${bin}). Install ffmpeg or choose an ffmpeg folder in Settings.`
}

function firstErrorLine(stderr: string): string {
  return stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ''
}

export async function probe(path: string): Promise<ProbedMediaInfo> {
  const { ffprobe } = getFfmpegPaths()
  let res
  try {
    res = await runCapture(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
      timeoutMs: 60_000,
    })
  } catch (e) {
    if (isSpawnError(e)) throw new Error(missingMessage(ffprobe))
    throw e
  }
  if (res.timedOut) throw new Error(`Timed out while reading ${basename(path)}`)
  if (res.code !== 0) {
    throw new Error(`Cannot read ${basename(path)}: ${firstErrorLine(res.stderr) || `ffprobe exited with code ${res.code}`}`)
  }
  let json: FfprobeOutput
  try {
    json = JSON.parse(res.stdout.toString('utf8')) as FfprobeOutput
  } catch {
    throw new Error(`Cannot read ${basename(path)}: unexpected ffprobe output`)
  }
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    /* fall back to format.size */
  }
  return mapProbe(json, path, size)
}

// Small cache for the duration lookups done by extractFrame (keyed by path + size + mtime).
const durationCache = new Map<string, number | null>()

export async function probeDuration(path: string): Promise<number | null> {
  let key = path
  try {
    const st = await stat(path)
    key = `${path}|${st.size}|${st.mtimeMs}`
  } catch {
    /* missing file: let ffmpeg report it */
  }
  if (durationCache.has(key)) return durationCache.get(key) ?? null
  const { ffprobe } = getFfmpegPaths()
  let d: number | null = null
  try {
    const res = await runCapture(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], {
      timeoutMs: 30_000,
    })
    const v = num(res.stdout.toString('utf8').trim())
    d = res.code === 0 && v !== undefined && v > 0 ? v : null
  } catch {
    d = null
  }
  if (durationCache.size > 256) durationCache.clear()
  durationCache.set(key, d)
  return d
}

// Small formatting / path helpers for the renderer (no Node imports).
import type { MediaInfo } from '../../../shared/types'
import { pictureGeometry, ratioLabel } from '../../../shared/media'
import type { TFunc } from '../i18n'

export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

const pad = (n: number, w = 2): string => String(Math.floor(n)).padStart(w, '0')

/** 00:01:23 */
export function formatDuration(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--:--'
  const s = Math.round(sec)
  return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}

/** hh:mm:ss.ff (frames) */
export function formatTimecode(sec: number, fps = 30): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const f = Math.max(1, Math.round(fps))
  const totalFrames = Math.round(sec * f)
  const frames = totalFrames % f
  const whole = Math.floor(totalFrames / f)
  return `${pad(whole / 3600)}:${pad((whole % 3600) / 60)}:${pad(whole % 60)}.${pad(frames)}`
}

/** Parse "hh:mm:ss.ff", "mm:ss", "ss.s" into seconds. Returns null when invalid. */
export function parseTimecode(text: string, fps = 30): number | null {
  const s = text.trim()
  if (!s) return null
  const m = /^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const parts = s.split(':')
  let h = 0
  let min = 0
  let rest = parts[parts.length - 1]
  if (parts.length === 3) {
    h = Number(parts[0])
    min = Number(parts[1])
  } else if (parts.length === 2) {
    min = Number(parts[0])
  }
  let secs = 0
  if (rest.includes('.') && parts.length > 1) {
    const [ss, ff] = rest.split('.')
    secs = Number(ss) + Number(ff) / Math.max(1, Math.round(fps))
  } else {
    secs = Number(rest)
  }
  const total = h * 3600 + min * 60 + secs
  return Number.isFinite(total) ? total : null
}

/** Remaining time: "12s", "3:05", "1:02:03" */
export function formatEta(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`
  return `${Math.floor(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return i > 0 ? path.slice(0, i) : path
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[a-z]:/i.test(dir) ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

/** Keep the start and the end of a long path: "D:\Footage\…\clip.mov" */
export function truncateMiddle(text: string, max = 40): string {
  if (text.length <= max) return text
  const keep = max - 1
  const head = Math.ceil(keep * 0.4)
  const tail = keep - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  prores: 'ProRes',
  dnxhd: 'DNxHD',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  flac: 'FLAC',
  pcm_s16le: 'PCM 16-bit',
  pcm_s24le: 'PCM 24-bit',
}

export function codecLabel(c?: string): string {
  if (!c) return ''
  return CODEC_LABEL[c] ?? c
}

export function formatLabel(info: MediaInfo): string {
  const f = (info.format ?? '').split(',')[0]
  return f ? f.toUpperCase() : ''
}

/** "1920×1080 · 00:01:23 · H.264" / "4000×3000 · JPEG · 3.2 MB" / "00:45:10 · PCM · 48 kHz" */
export function sourceInfoLine(info?: MediaInfo, t?: TFunc): string {
  if (!info) return ''
  const parts: string[] = []
  if (info.kind === 'image') {
    if (info.width && info.height) parts.push(`${info.width}×${info.height}`)
    const f = formatLabel(info)
    if (f) parts.push(f)
    if (info.frameCount && info.frameCount > 1) parts.push(t ? t('media.frames', { n: info.frameCount }) : `${info.frameCount} fr`)
    parts.push(formatBytes(info.sizeBytes))
    return parts.join(' · ')
  }
  if (info.kind === 'video') {
    if (info.width && info.height) {
      const g = pictureGeometry(info)
      const display = `${g.width}×${g.height}`
      if (g.sar === 1) parts.push(display)
      else {
        const stored = `${g.storageWidth}×${g.storageHeight}`
        const sar = ratioLabel(g.sar)
        parts.push(t ? t('media.anamorphicSize', { stored, display, sar }) : `${stored} → ${display} (${sar})`)
      }
    }
    parts.push(formatDuration(info.durationSec))
    if (info.videoCodec) parts.push(codecLabel(info.videoCodec))
    if (info.fps) parts.push(`${Math.round(info.fps * 100) / 100} fps`)
    return parts.join(' · ')
  }
  parts.push(formatDuration(info.durationSec))
  if (info.audioCodec) parts.push(codecLabel(info.audioCodec))
  if (info.audioSampleRate) parts.push(`${info.audioSampleRate / 1000} kHz`)
  if (info.audioChannels) {
    const n = info.audioChannels
    if (t) parts.push(n === 1 ? t('video.mono') : n === 2 ? t('video.stereo') : t('media.channels', { n }))
    else parts.push(n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} ch`)
  }
  return parts.join(' · ')
}

let seq = 0
export function uid(prefix = 'id'): string {
  seq = (seq + 1) % 1e6
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

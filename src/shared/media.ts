// File-type classification shared by main and renderer. Pure, no Node/DOM imports.
import type { MediaInfo, MediaKind } from './types'

export const VIDEO_EXTS = [
  'mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2v', 'ts', 'mts', 'm2ts',
  'mxf', '3gp', '3g2', 'ogv', 'vob', 'dv', 'f4v', 'y4m',
] as const

export const AUDIO_EXTS = [
  'mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'alac', 'ac3', 'eac3', 'mka', 'amr',
] as const

/** Read with sharp; formats sharp cannot decode (bmp, tga, heic, exr, …) fall back to an ffmpeg decode. */
export const IMAGE_EXTS = [
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'avif', 'gif', 'tif', 'tiff', 'svg', 'heic', 'heif', 'bmp', 'tga',
  'exr', 'hdr', 'jp2', 'j2k', 'jxl', 'ico', 'dds', 'pcx', 'ppm', 'pgm', 'pbm', 'qoi',
] as const

/** Logos for watermarks. */
export const WATERMARK_EXTS = ['png', 'webp', 'svg', 'jpg', 'jpeg', 'avif', 'gif'] as const

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function baseNameOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

const VIDEO = new Set<string>(VIDEO_EXTS)
const AUDIO = new Set<string>(AUDIO_EXTS)
const IMAGE = new Set<string>(IMAGE_EXTS)

/** Classify by extension only (cheap). Returns null for unsupported files. */
export function classifyPath(path: string): MediaKind | null {
  const ext = extOf(path)
  if (VIDEO.has(ext)) return 'video'
  if (AUDIO.has(ext)) return 'audio'
  if (IMAGE.has(ext)) return 'image'
  return null
}

// ───────────────────────────── picture geometry ─────────────────────────────

type GeometryFields = Pick<MediaInfo, 'width' | 'height' | 'sampleAspectRatio' | 'storageWidth' | 'storageHeight'>

export interface PictureGeometry {
  /** Displayed size (0 when unknown). */
  width: number
  height: number
  /** Stored frame size (= displayed size for square pixels). */
  storageWidth: number
  storageHeight: number
  /** Pixel aspect, 1 for square / unknown. */
  sar: number
}

/** Valid non-square pixel aspect, else 1. */
export function pixelAspect(info: Pick<MediaInfo, 'sampleAspectRatio'>): number {
  const s = info.sampleAspectRatio
  return typeof s === 'number' && Number.isFinite(s) && s > 0 && Math.abs(s - 1) >= 1e-3 ? s : 1
}

/**
 * Displayed and stored frame size of a source. MediaInfo.width/height are the displayed size; for non-square pixels
 * storageWidth/storageHeight hold the stored frame. Entries saved before those fields existed carried the *stored* size
 * in width/height next to sampleAspectRatio — they are read that way here.
 */
export function pictureGeometry(info: GeometryFields): PictureGeometry {
  const w = info.width ?? 0
  const h = info.height ?? 0
  const sar = pixelAspect(info)
  if (sar === 1) return { width: w, height: h, storageWidth: w, storageHeight: h, sar }
  if (info.storageWidth && info.storageHeight) {
    return { width: w, height: h, storageWidth: info.storageWidth, storageHeight: info.storageHeight, sar }
  }
  return { width: w ? Math.round(w * sar) : 0, height: h, storageWidth: w, storageHeight: h, sar }
}

/** The same MediaInfo with width/height as the displayed size (converts entries saved before storageWidth existed). */
export function withDisplaySize<T extends MediaInfo>(info: T): T {
  if (info.storageWidth !== undefined || !info.width || !info.height || pixelAspect(info) === 1) return info
  const g = pictureGeometry(info)
  return { ...info, width: g.width, height: g.height, storageWidth: g.storageWidth, storageHeight: g.storageHeight }
}

/** "4:3", "8:9", "32:27" for a pixel aspect (smallest denominator ≤ 100 that matches), else 3 decimals. */
export function ratioLabel(x: number): string {
  for (let d = 1; d <= 100; d++) {
    const n = Math.round(x * d)
    if (n > 0 && Math.abs(n / d - x) < 1e-4) return `${n}:${d}`
  }
  return x.toFixed(3)
}

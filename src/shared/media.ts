// File-type classification shared by main and renderer. Pure, no Node/DOM imports.
import type { MediaKind } from './types'

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

// Pure Range-aware file responses for the media:// protocol (no Electron import, unit-testable).
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { classifyPath, extOf } from '../shared/media'

export const MEDIA_SCHEME = 'media'

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  m2v: 'video/mpeg',
  ts: 'video/mp2t',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mxf: 'application/mxf',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  mka: 'audio/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  heif: 'image/heif',
  jxl: 'image/jxl',
}

export function mimeFor(path: string): string {
  return MIME[extOf(path)] ?? 'application/octet-stream'
}

/** Absolute file path from a media:// URL, or null when malformed. */
export function pathFromMediaUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== `${MEDIA_SCHEME}:`) return null
    const raw = u.pathname.replace(/^\/+/, '')
    if (!raw) return null
    const p = decodeURIComponent(raw)
    return isAbsolute(p) ? p : null
  } catch {
    return null
  }
}

/** Parse a single "bytes=a-b" range; null = not satisfiable / unsupported. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    // suffix: last N bytes
    const n = Number(m[2])
    if (n === 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start > end || start >= size) return null
  return { start, end }
}

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

export async function handleMediaRequest(request: Request): Promise<Response> {
  const path = pathFromMediaUrl(request.url)
  if (!path) return text(400, 'Bad request')
  if (!classifyPath(path)) return text(403, 'Forbidden')
  const st = await stat(path).catch(() => null)
  if (!st || !st.isFile()) return text(404, 'Not found')
  const size = st.size
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(path),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  }
  const isHead = request.method === 'HEAD'
  const rangeHeader = request.headers.get('range')
  if (rangeHeader && size > 0) {
    const r = parseRange(rangeHeader, size)
    if (!r) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
    headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`
    headers['Content-Length'] = String(r.end - r.start + 1)
    const body = isHead ? null : (Readable.toWeb(createReadStream(path, { start: r.start, end: r.end })) as ReadableStream)
    return new Response(body, { status: 206, headers })
  }
  headers['Content-Length'] = String(size)
  const body = isHead || size === 0 ? null : (Readable.toWeb(createReadStream(path)) as ReadableStream)
  return new Response(body, { status: 200, headers })
}

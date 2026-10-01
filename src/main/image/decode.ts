// Source decoding: sharp first, ffmpeg (single frame → PNG) for formats the bundled libvips cannot read.
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import sharp, { type Metadata, type SharpOptions } from 'sharp'
import { getFfmpegPaths } from '../ffmpeg/paths'
import { extOf } from '../../shared/media'
import { abortError, throwIfAborted } from './util'

// libvips' operation cache keeps source files open; on Windows that blocks moving/deleting a source
// right after conversion (watch folders move processed files). Keep the memory cache, hold no files.
sharp.cache({ files: 0 })

/** Options for every sharp() call that opens user data. */
export const SHARP_OPTS = { failOn: 'none', limitInputPixels: false } as const satisfies SharpOptions

/** Extensions the libvips bundled with sharp cannot decode at all (no loader compiled in). */
const FFMPEG_ONLY = new Set(['bmp', 'tga', 'dds', 'pcx', 'ico', 'qoi', 'exr', 'hdr', 'jxl', 'jp2', 'j2k', 'ppm', 'pgm', 'pbm'])

export interface DecodedSource {
  path: string
  /** What to hand to sharp(): the original path, or PNG bytes decoded by ffmpeg. */
  input: string | Buffer
  viaFfmpeg: boolean
  meta: Metadata
  /** Reported format: sharp's name (heif split into avif/heic) or the extension for ffmpeg decodes. */
  format: string
  /** EXIF orientation 1..8 (always 1 for ffmpeg decodes). */
  orientation: number
}

function formatName(meta: Metadata): string {
  if (meta.format === 'heif') return meta.compression === 'hevc' ? 'heic' : 'avif'
  return String(meta.format)
}

// Small cache so repeated previews of a BMP/TGA/HEIC don't respawn ffmpeg every time.
const ffCache = new Map<string, Buffer>()
const FF_CACHE_MAX = 4

async function cacheKey(path: string): Promise<string> {
  const st = await stat(path)
  return `${path}|${st.size}|${st.mtimeMs}`
}

/** Decode the first frame of any ffmpeg-readable image to PNG bytes. */
export function ffmpegDecodeToPng(path: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const { ffmpeg } = getFfmpegPaths()
    const args = ['-v', 'error', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 8192) err += d.toString()
    })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(new Error(`ffmpeg could not be started (${e.message})`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (aborted) return reject(abortError())
      const buf = Buffer.concat(out)
      if (code === 0 && buf.length > 0) return resolve(buf)
      const line = err.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      reject(new Error(`Cannot decode image${line ? `: ${line}` : ''}`))
    })
  })
}

async function decodeWithFfmpeg(path: string, signal?: AbortSignal): Promise<Buffer> {
  const key = await cacheKey(path)
  const hit = ffCache.get(key)
  if (hit) {
    ffCache.delete(key)
    ffCache.set(key, hit)
    return hit
  }
  const buf = await ffmpegDecodeToPng(path, signal)
  ffCache.set(key, buf)
  while (ffCache.size > FF_CACHE_MAX) ffCache.delete(ffCache.keys().next().value as string)
  return buf
}

/** Open a source image, choosing sharp or the ffmpeg fallback. */
export async function openSource(path: string, signal?: AbortSignal): Promise<DecodedSource> {
  throwIfAborted(signal)
  const ext = extOf(path)
  if (!FFMPEG_ONLY.has(ext)) {
    let meta: Metadata | null = null
    try {
      meta = await sharp(path, SHARP_OPTS).metadata()
    } catch {
      meta = null
    }
    // HEIC (HEVC) is detected by libheif but this libvips build only decodes AV1 (AVIF).
    if (meta && !(meta.format === 'heif' && meta.compression === 'hevc')) {
      return { path, input: path, viaFfmpeg: false, meta, format: formatName(meta), orientation: meta.orientation ?? 1 }
    }
  }
  const png = await decodeWithFfmpeg(path, signal)
  throwIfAborted(signal)
  const meta = await sharp(png, SHARP_OPTS).metadata()
  return { path, input: png, viaFfmpeg: true, meta, format: ext || 'unknown', orientation: 1 }
}

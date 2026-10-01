// Single-frame decoding for thumbnails / previews.
import { basename } from 'node:path'
import { getFfmpegPaths } from './paths'
import { probeDuration } from './probe'
import { fmtSec, isSpawnError, runCapture } from './proc'

export interface FrameOptions {
  maxWidth?: number
  width?: number
  height?: number
  format?: 'jpeg' | 'png'
}

const FRAME_TIMEOUT_MS = 60_000

/** Scale filter for a frame grab: exact width×height, one exact side, or fit within maxWidth without upscaling. */
export function frameScaleFilter(opts: FrameOptions): string | null {
  const w = opts.width && opts.width > 0 ? Math.round(opts.width) : null
  const h = opts.height && opts.height > 0 ? Math.round(opts.height) : null
  if (w && h) return `scale=${w}:${h}:flags=bicubic`
  if (w) return `scale=${w}:-2:flags=bicubic`
  if (h) return `scale=-2:${h}:flags=bicubic`
  if (opts.maxWidth && opts.maxWidth > 0) return `scale='min(iw,${Math.round(opts.maxWidth)})':-2:flags=bicubic`
  return null
}

export function frameArgs(path: string, timeSec: number, opts: FrameOptions): string[] {
  const args = ['-hide_banner', '-nostdin', '-v', 'error']
  if (timeSec > 0) args.push('-ss', fmtSec(timeSec))
  args.push('-i', path, '-frames:v', '1', '-an', '-sn', '-dn')
  const vf = frameScaleFilter(opts)
  if (vf) args.push('-vf', vf)
  if ((opts.format ?? 'jpeg') === 'png') args.push('-c:v', 'png')
  else args.push('-c:v', 'mjpeg', '-q:v', '3')
  args.push('-f', 'image2pipe', 'pipe:1')
  return args
}

async function grab(args: string[], path: string): Promise<{ buf: Buffer; error: string }> {
  const { ffmpeg } = getFfmpegPaths()
  try {
    const res = await runCapture(ffmpeg, args, { timeoutMs: FRAME_TIMEOUT_MS })
    if (res.timedOut) return { buf: Buffer.alloc(0), error: `Timed out decoding ${basename(path)}` }
    const error = res.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? ''
    return { buf: res.code === 0 ? res.stdout : Buffer.alloc(0), error }
  } catch (e) {
    if (isSpawnError(e)) throw new Error(`ffmpeg was not found (${ffmpeg}). Install ffmpeg or choose an ffmpeg folder in Settings.`)
    throw e
  }
}

export async function extractFrame(path: string, timeSec: number, opts: FrameOptions = {}): Promise<Buffer> {
  let t = Number.isFinite(timeSec) && timeSec > 0 ? timeSec : 0
  if (t > 0) {
    const d = await probeDuration(path)
    if (d !== null) t = Math.min(t, Math.max(0, d - 0.05))
  }
  let res = await grab(frameArgs(path, t, opts), path)
  // Seeking past the only frame (still image, cover art) yields nothing: retry from the start.
  if (!res.buf.length && t > 0) res = await grab(frameArgs(path, 0, opts), path)
  if (!res.buf.length) throw new Error(`Could not decode a frame from ${basename(path)}${res.error ? `: ${res.error}` : ''}`)
  return res.buf
}

export async function decodeImageToPng(path: string): Promise<Buffer> {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', path, '-frames:v', '1', '-an', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']
  const res = await grab(args, path)
  if (!res.buf.length) throw new Error(`Could not decode ${basename(path)}${res.error ? `: ${res.error}` : ''}`)
  return res.buf
}

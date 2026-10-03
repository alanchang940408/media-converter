// Runs an encode: progress parsing, log tail, abort, hardware → software fallback.
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { EncodeError, type VideoEncodeRequest, type VideoEncodeResult } from '../contracts'
import { buildArgs, hwFamilyOf, type BuildOptions } from './args'
import { getFfmpegPaths } from './paths'
import { spawnTracked } from './proc'
import { LineSplitter, ProgressParser, RingBuffer, pickErrorLine, progressFromSample } from './progress'

export function abortError(): Error {
  const e = new Error('Encode cancelled')
  e.name = 'AbortError'
  return e
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError'
}

/** Expected output duration in seconds (trimmed duration when trimming), or null when unknown. */
export function expectedDuration(req: Pick<VideoEncodeRequest, 'info' | 'trim'>): number | null {
  const total = req.info.durationSec ?? null
  const trim = req.trim
  if (trim && trim.outSec > trim.inSec) {
    const start = Math.max(0, trim.inSec)
    let len = trim.outSec - start
    if (total !== null) len = Math.min(len, Math.max(0, total - start))
    return len > 0 ? len : null
  }
  return total && total > 0 ? total : null
}

/** Run ffmpeg once with the given args. Resolves on exit 0; rejects with EncodeError / AbortError. */
function runOnce(args: string[], req: VideoEncodeRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    if (req.signal.aborted) {
      reject(abortError())
      return
    }
    const { ffmpeg } = getFfmpegPaths()
    const ring = new RingBuffer(40)
    const totalSec = expectedDuration(req)
    const started = Date.now()
    const progress = new ProgressParser()
    const stderrLines = new LineSplitter()
    let aborted = false
    let settled = false

    let child: ReturnType<typeof spawnTracked>
    try {
      // SVT-AV1 logs straight to stderr; keep only its errors.
      child = spawnTracked(ffmpeg, args, { SVT_LOG: process.env.SVT_LOG ?? '1' })
    } catch (e) {
      reject(new EncodeError(e instanceof Error ? e.message : String(e), [], null))
      return
    }

    const log = (line: string): void => {
      ring.push(line)
      try {
        req.onLog?.(line)
      } catch {
        /* listener errors must not break the encode */
      }
    }
    const onAbort = (): void => {
      aborted = true
      child.kill()
    }
    req.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.setEncoding('utf8')
    let lastFraction = 0
    child.stdout?.on('data', (chunk: string) => {
      for (const sample of progress.push(chunk)) {
        if (aborted) continue
        try {
          const state = progressFromSample(sample, totalSec, (Date.now() - started) / 1000, lastFraction)
          lastFraction = state.fraction
          req.onProgress(state)
        } catch {
          /* ignore listener errors */
        }
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of stderrLines.push(chunk)) log(line)
    })

    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      req.signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }

    child.once('error', (e: NodeJS.ErrnoException) => {
      const msg = e.code === 'ENOENT' ? `ffmpeg was not found (${ffmpeg}). Install ffmpeg or choose an ffmpeg folder in Settings.` : e.message
      log(msg)
      finish(new EncodeError(msg, ring.toArray(), null))
    })
    child.once('close', (code) => {
      for (const line of stderrLines.flush()) log(line)
      if (aborted || req.signal.aborted) return finish(abortError())
      if (code === 0) return finish(null)
      const tail = ring.toArray()
      finish(new EncodeError(pickErrorLine(tail, code), tail, code))
    })
  })
}

/**
 * ffmpeg on Windows retries a failed open with the ANSI code page, so a missing CJK path is reported as
 * "Illegal byte sequence". Check inputs up front to give a clear message instead.
 */
async function assertInputsExist(req: VideoEncodeRequest): Promise<void> {
  const inputs: Array<[string, string]> = [['Source file not found', req.source]]
  if (req.overlay) inputs.push(['Watermark image not found', req.overlay.pngPath])
  for (const [label, path] of inputs) {
    try {
      await access(path, constants.R_OK)
    } catch {
      throw new EncodeError(`${label}: ${path}`, [], null)
    }
  }
}

/**
 * ffmpeg binaries (by path) that cannot request the MJPEG full colour range with format=…:color_ranges=pc (builds older
 * than 7.1): their MJPEG jobs go straight to the legacy yuvj422p path after the first failure.
 */
const legacyMjpegBins = new Set<string>()

/** True when an MJPEG encode failed because the ffmpeg build does not know the format filter's color_ranges option. */
export function needsLegacyMjpeg(encoder: string, err: unknown): boolean {
  return encoder === 'mjpeg' && err instanceof EncodeError && err.logTail.some((l) => /color_ranges/i.test(l))
}

function logLine(req: VideoEncodeRequest, msg: string): void {
  try {
    req.onLog?.(msg)
  } catch {
    /* ignore */
  }
}

export async function encode(req: VideoEncodeRequest): Promise<VideoEncodeResult> {
  if (req.signal.aborted) throw abortError()
  await assertInputsExist(req)
  const bin = getFfmpegPaths().ffmpeg
  const opts: BuildOptions = { legacyMjpeg: legacyMjpegBins.has(bin) }
  const first = buildArgs(req, opts)
  try {
    await runOnce(first.args, req)
    return { encoder: first.encoder, args: first.args }
  } catch (err) {
    if (isAbortError(err) || req.signal.aborted) throw isAbortError(err) ? err : abortError()
    if (!opts.legacyMjpeg && needsLegacyMjpeg(first.encoder, err)) {
      legacyMjpegBins.add(bin)
      logLine(req, 'This ffmpeg build cannot request the MJPEG colour range (needs ffmpeg 7.1+), retrying with yuvj422p')
      const legacy = buildArgs(req, { ...opts, legacyMjpeg: true })
      await runOnce(legacy.args, req)
      return { encoder: legacy.encoder, args: legacy.args }
    }
    if (!hwFamilyOf(first.encoder)) throw err
    logLine(req, `Hardware encoder ${first.encoder} failed, retrying with software`)
    const settings = { ...req.settings, video: { ...req.settings.video, hw: 'none' as const } }
    const sw = buildArgs({ ...req, settings }, opts)
    await runOnce(sw.args, req)
    return { encoder: sw.encoder, args: sw.args }
  }
}

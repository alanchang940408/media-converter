// Parsing of `-progress pipe:1` output and ffmpeg stderr.

export interface ProgressSample {
  /** Output timestamp in seconds (undefined while ffmpeg reports N/A). */
  outTimeSec?: number
  fps?: number
  speed?: number
  /** progress=end */
  end: boolean
}

const numOrUndef = (v?: string): number | undefined => {
  if (v === undefined || v === '' || v === 'N/A') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** "01:02:03.500000" (optionally negative) → seconds. */
export function parseClock(v?: string): number | undefined {
  if (!v) return undefined
  const m = /^(-)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim())
  if (!m) return undefined
  const s = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
  return m[1] ? -s : s
}

/** One key=value block (terminated by a `progress=` line) → sample. out_time_us and out_time_ms are both microseconds. */
export function parseProgressBlock(kv: Record<string, string>): ProgressSample {
  const us = numOrUndef(kv.out_time_us) ?? numOrUndef(kv.out_time_ms)
  let outTimeSec = us !== undefined ? us / 1e6 : parseClock(kv.out_time)
  if (outTimeSec !== undefined && outTimeSec < 0) outTimeSec = 0
  const fps = numOrUndef(kv.fps)
  const speedRaw = kv.speed?.trim().replace(/x$/, '')
  const speed = numOrUndef(speedRaw)
  return {
    outTimeSec,
    fps: fps !== undefined && fps > 0 ? fps : undefined,
    speed: speed !== undefined && speed > 0 ? speed : undefined,
    end: kv.progress === 'end',
  }
}

/** Incremental parser for the progress stream; feed raw stdout chunks, get completed blocks back. */
export class ProgressParser {
  private buf = ''
  private kv: Record<string, string> = {}

  push(chunk: string): ProgressSample[] {
    this.buf += chunk
    const lines = this.buf.split(/\r?\n/)
    this.buf = lines.pop() ?? ''
    const out: ProgressSample[] = []
    for (const line of lines) {
      const i = line.indexOf('=')
      if (i <= 0) continue
      const key = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim()
      this.kv[key] = value
      if (key === 'progress') {
        out.push(parseProgressBlock(this.kv))
        this.kv = {}
      }
    }
    return out
  }
}

/** Splits a text stream into lines (\n, \r\n or bare \r). */
export class LineSplitter {
  private buf = ''

  push(chunk: string): string[] {
    this.buf += chunk
    const parts = this.buf.split(/\r\n|\n|\r/)
    this.buf = parts.pop() ?? ''
    return parts.filter((l) => l.trim() !== '')
  }

  flush(): string[] {
    const rest = this.buf.trim() ? [this.buf] : []
    this.buf = ''
    return rest
  }
}

/** Fixed-size buffer of the most recent lines. */
export class RingBuffer {
  private items: string[] = []
  constructor(private readonly size = 40) {}

  push(line: string): void {
    this.items.push(line)
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size)
  }

  toArray(): string[] {
    return [...this.items]
  }
}

export interface ProgressState {
  fraction: number
  fps?: number
  speed?: number
  etaSec?: number
  elapsedSec: number
}

/**
 * Turn a sample into EncodeProgress fields. `totalSec` is the expected output duration (null = unknown).
 * `floor` is the last reported fraction: progress never moves backwards (ffmpeg reports out_time=N/A during the
 * +faststart moov rewrite, which would otherwise read as 0).
 */
export function progressFromSample(sample: ProgressSample, totalSec: number | null, elapsedSec: number, floor = 0): ProgressState {
  let fraction = floor
  if (sample.end) fraction = 1
  else if (totalSec && totalSec > 0 && sample.outTimeSec !== undefined) fraction = Math.max(floor, Math.min(1, Math.max(0, sample.outTimeSec / totalSec)))
  const state: ProgressState = { fraction, elapsedSec }
  if (sample.fps !== undefined) state.fps = sample.fps
  if (sample.speed !== undefined) state.speed = sample.speed
  if (fraction >= 1) state.etaSec = 0
  else if (fraction > 0.01) state.etaSec = (elapsedSec * (1 - fraction)) / fraction
  return state
}

// Lines that only summarise a failure that was already explained earlier in the log.
const GENERIC = [
  /^Conversion failed!?$/i,
  /Task finished with error code/i,
  /Terminating thread with return code/i,
  /Error sending frames to consumers/i,
  /Could not open encoder before EOF/i,
  /Nothing was written into output file/i,
  /Error while filtering/i,
  /Error while processing the decoded data/i,
  /^Error opening output files?:/i,
  /^Error opening input files?:/i,
  /Error while opening encoder/i,
]

const ERRORISH = /error|invalid|failed|fail to|cannot|can't|could not|couldn't|not supported|unsupported|no such|unable|denied|does not|incorrect|not found|too many|out of memory|unknown encoder|unrecognized|no device|not implemented/i

/** Remove the "[component @ 0x…] " prefix ffmpeg puts in front of log lines. */
export function stripLogPrefix(line: string): string {
  let s = line.trim()
  // Prefixes can nest: "[vost#0:0/libx264 @ 0x..] [enc:libx264 @ 0x..] msg"
  while (/^\[[^\]]*\]\s*/.test(s)) s = s.replace(/^\[[^\]]*\]\s*/, '')
  return s || line.trim()
}

/** Most relevant error line of an ffmpeg log: the first specific error, else the first generic one, else the last line. */
export function pickErrorLine(lines: string[], exitCode: number | null): string {
  const candidates = lines.map((l) => l.trim()).filter(Boolean)
  const errorish = candidates.filter((l) => ERRORISH.test(l))
  const specific = errorish.find((l) => !GENERIC.some((g) => g.test(stripLogPrefix(l))))
  const chosen = specific ?? errorish[0] ?? candidates[candidates.length - 1]
  if (chosen) return stripLogPrefix(chosen)
  return `ffmpeg exited with code ${exitCode ?? 'unknown'}`
}

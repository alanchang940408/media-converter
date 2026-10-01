// Child-process helpers shared by the ffmpeg engine modules.
// Every spawned ffmpeg/ffprobe is tracked so nothing outlives the parent process.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

const active = new Set<ChildProcess>()
let exitHooked = false

function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', () => {
    for (const child of active) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  })
}

/** spawn() with windowsHide, piped stdout/stderr, ignored stdin, and process tracking. */
export function spawnTracked(bin: string, args: string[], extraEnv?: Record<string, string>): ChildProcess {
  hookExit()
  const opts: SpawnOptions = {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  }
  const child = spawn(bin, args, opts)
  active.add(child)
  const forget = (): void => {
    active.delete(child)
  }
  child.once('exit', forget)
  child.once('error', forget)
  return child
}

/** PIDs of ffmpeg/ffprobe processes this module started that are still running. */
export function activePids(): number[] {
  return [...active].map((c) => c.pid).filter((p): p is number => typeof p === 'number')
}

export interface CaptureResult {
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
}

/**
 * Run a binary to completion, collecting stdout (bytes) and stderr (text, last 64 KB).
 * Rejects only when the process cannot be spawned (e.g. ENOENT); non-zero exits resolve with `code`.
 */
export function runCapture(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnTracked(bin, args)
    } catch (err) {
      reject(err)
      return
    }
    const out: Buffer[] = []
    let err = ''
    let timedOut = false
    let settled = false
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      err += d
      if (err.length > 65536) err = err.slice(-65536)
    })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, opts.timeoutMs)
      : null
    child.once('error', (e) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out), stderr: err, timedOut })
    })
  })
}

export function isSpawnError(e: unknown): e is NodeJS.ErrnoException {
  return !!e && typeof e === 'object' && typeof (e as NodeJS.ErrnoException).code === 'string' && 'syscall' in e
}

/** Format seconds for ffmpeg time options (max 3 decimals, no exponent). */
export function fmtSec(sec: number): string {
  const s = Math.max(0, sec)
  return String(Math.round(s * 1000) / 1000)
}

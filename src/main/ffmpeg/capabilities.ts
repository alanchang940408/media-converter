// Compiled-encoder listing + real test encodes for hardware encoders.
import type { EncoderCapabilities } from '../../shared/types'
import { HW_PRIORITY } from '../../shared/videoRules'
import { getFfmpegPaths, type FfmpegPaths } from './paths'
import { runCapture } from './proc'

const SOFTWARE_ENCODERS = [
  'libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9', 'prores_ks', 'dnxhd', 'gif',
  'aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le', 'pcm_s24le',
]

/** Hardware encoders worth test-encoding: h264/hevc/av1 × every family, plus ProRes on VideoToolbox. */
export const HW_TEST_ENCODERS: string[] = [
  ...['h264', 'hevc', 'av1'].flatMap((codec) => HW_PRIORITY.map((family) => `${codec}_${family}`)),
  'prores_videotoolbox',
]

const WANTED = new Set([...SOFTWARE_ENCODERS, ...HW_TEST_ENCODERS])

/** Encoder names from `ffmpeg -encoders` output, limited to the ones the engine cares about. */
export function parseEncoderList(text: string): string[] {
  const found: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line)
    if (m && WANTED.has(m[1]) && !found.includes(m[1])) found.push(m[1])
  }
  return found
}

export function parseVersion(text: string): string {
  return /ffmpeg version (\S+)/.exec(text)?.[1] ?? ''
}

const TEST_TIMEOUT_MS = 15_000
const TEST_PARALLEL = 3

async function testEncoder(ffmpeg: string, encoder: string): Promise<boolean> {
  try {
    const res = await runCapture(
      ffmpeg,
      ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.2',
        '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-'],
      { timeoutMs: TEST_TIMEOUT_MS },
    )
    return res.code === 0 && !res.timedOut
  } catch {
    return false
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function emptyCaps(paths: FfmpegPaths, source: EncoderCapabilities['ffmpegSource']): EncoderCapabilities {
  return {
    ffmpegPath: paths.ffmpeg,
    ffprobePath: paths.ffprobe,
    ffmpegVersion: '',
    ffmpegSource: source,
    compiledEncoders: [],
    workingHwEncoders: [],
    hw: { nvenc: false, qsv: false, amf: false, videotoolbox: false },
  }
}

async function detect(paths: FfmpegPaths): Promise<EncoderCapabilities> {
  let versionText: string
  let encodersText: string
  try {
    const v = await runCapture(paths.ffmpeg, ['-version'], { timeoutMs: TEST_TIMEOUT_MS })
    versionText = v.stdout.toString('utf8') || v.stderr
    const e = await runCapture(paths.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: TEST_TIMEOUT_MS })
    encodersText = e.stdout.toString('utf8')
  } catch {
    // Binary cannot be spawned (ENOENT, EACCES…): report it instead of throwing.
    return emptyCaps(paths, 'missing')
  }
  const caps = emptyCaps(paths, paths.source)
  caps.ffmpegVersion = parseVersion(versionText)
  caps.compiledEncoders = parseEncoderList(encodersText)
  const hwCompiled = HW_TEST_ENCODERS.filter((e) => caps.compiledEncoders.includes(e))
  const ok = await mapLimit(hwCompiled, TEST_PARALLEL, (e) => testEncoder(paths.ffmpeg, e))
  caps.workingHwEncoders = hwCompiled.filter((_, i) => ok[i])
  for (const family of HW_PRIORITY) caps.hw[family] = caps.workingHwEncoders.includes(`h264_${family}`)
  return caps
}

let cache: { key: string; promise: Promise<EncoderCapabilities> } | null = null

export function detectCapabilities(force = false): Promise<EncoderCapabilities> {
  const paths = getFfmpegPaths()
  const key = `${paths.source}|${paths.ffmpeg}`
  if (!force && cache && cache.key === key) return cache.promise
  const promise = detect(paths)
  cache = { key, promise }
  promise.catch(() => {
    if (cache?.promise === promise) cache = null
  })
  return promise
}

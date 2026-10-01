// Locate ffmpeg / ffprobe. Order: custom (settings) → bundled (resources/bin) → system PATH.
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FfmpegPaths {
  ffmpeg: string
  ffprobe: string
  source: 'bundled' | 'custom' | 'system'
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

/** Folder that holds the bundled binaries, e.g. resources/bin/win32-x64 in dev or <resources>/bin when packaged. */
export function bundledBinDir(): string {
  const packagedResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const isPackaged = !!packagedResources && !/node_modules[\\/]electron[\\/]dist/.test(packagedResources)
  if (isPackaged) return join(packagedResources!, 'bin')
  // dev / tests: <repo>/resources/bin/<platform>-<arch>
  const here = dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'resources', 'bin', `${process.platform}-${process.arch}`)
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  return join(process.cwd(), 'resources', 'bin', `${process.platform}-${process.arch}`)
}

let customPath: string | null = null

/** Called by the settings store whenever AppSettings.ffmpegPath changes. */
export function setCustomFfmpegPath(p: string | null): void {
  customPath = p && p.trim() ? p.trim() : null
  cached = null
}

let cached: FfmpegPaths | null = null

export function getFfmpegPaths(): FfmpegPaths {
  if (cached) return cached
  if (customPath) {
    let dir = customPath
    try {
      if (statSync(customPath).isFile()) dir = dirname(customPath)
    } catch {
      /* fall through to bundled */
    }
    const ff = join(dir, exe('ffmpeg'))
    if (existsSync(ff)) {
      cached = { ffmpeg: ff, ffprobe: join(dir, exe('ffprobe')), source: 'custom' }
      return cached
    }
  }
  const bin = bundledBinDir()
  const bundled = join(bin, exe('ffmpeg'))
  if (existsSync(bundled)) {
    cached = { ffmpeg: bundled, ffprobe: join(bin, exe('ffprobe')), source: 'bundled' }
    return cached
  }
  // Rely on PATH lookup by spawn().
  cached = { ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe'), source: 'system' }
  return cached
}

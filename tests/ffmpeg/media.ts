// Generates small real media files for the integration tests.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr || r.error}`)
}

export interface Sources {
  dir: string
  /** 3 s 1280x720 30 fps h264 + 48 kHz stereo aac, CJK + space file name */
  video: string
  /** 3 s 48 kHz stereo pcm_s16le */
  audio: string
  /** 200x80 semi-transparent RGBA png */
  logo: string
  cleanup: () => void
}

export function makeSources(prefix: string): Sources {
  const dir = mkdtempSync(join(tmpdir(), `mc-${prefix}-`))
  const video = join(dir, '測試 影片.mov')
  const audio = join(dir, '音訊 tone.wav')
  const logo = join(dir, 'logo 水印.png')
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15',
    '-c:a', 'aac', '-ac', '2', '-b:a', '128k', '-shortest', video,
  ])
  ff(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=3', '-ac', '2', '-c:a', 'pcm_s16le', audio])
  ff(['-f', 'lavfi', '-i', 'color=c=red@0.8:s=200x80,format=rgba', '-frames:v', '1', logo])
  return {
    dir,
    video,
    audio,
    logo,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* windows may still hold a handle briefly */
      }
    },
  }
}

/** Optional: run the integration tests against another ffmpeg folder (e.g. MC_TEST_FFMPEG=C:\ffmpeg\bin). */
export function applyTestFfmpegOverride(set: (p: string | null) => void): void {
  const p = process.env.MC_TEST_FFMPEG
  if (p) set(p)
}

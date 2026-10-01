#!/usr/bin/env node
// Generate small synthetic test media with ffmpeg (used by the E2E global setup; also handy for manual testing).
//
//   node scripts/make-test-media.mjs [outDir] [--force]      default outDir: test-media/
//
// Files (names deliberately contain spaces and CJK characters):
//   video    範例 影片 clip.mov      3 s 1280×720 H.264 + AAC
//   prores   prores sample.mov       2 s 1280×720 ProRes 422 Proxy + PCM
//   png      透明 logo.png           640×480 RGBA with a transparent background
//   jpeg     photo 4000x3000.jpg     4000×3000 JPEG
//   gif      animated.gif            2 s 320×240 animated GIF
//   flat     watermark base.mp4      4 s 1280×720 flat grey H.264 + AAC (watermark visibility checks)
// A manifest.json with absolute paths is written next to them.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name)

/** ffmpeg/ffprobe: $FFMPEG_PATH (file or folder) → PATH → resources/bin/<platform>-<arch>. */
export function resolveFfmpeg() {
  const fromEnv = process.env.FFMPEG_PATH
  if (fromEnv) {
    const dir = existsSync(fromEnv) && statSync(fromEnv).isFile() ? dirname(fromEnv) : fromEnv
    return { ffmpeg: join(dir, exe('ffmpeg')), ffprobe: join(dir, exe('ffprobe')) }
  }
  const onPath = spawnSync(exe('ffmpeg'), ['-hide_banner', '-version'], { windowsHide: true })
  if (!onPath.error && onPath.status === 0) return { ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe') }
  const bundled = join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`)
  if (existsSync(join(bundled, exe('ffmpeg')))) return { ffmpeg: join(bundled, exe('ffmpeg')), ffprobe: join(bundled, exe('ffprobe')) }
  throw new Error('ffmpeg not found: install it, set FFMPEG_PATH, or run "npm run fetch-ffmpeg"')
}

const LAVFI = ['-f', 'lavfi', '-i']

/** name → ffmpeg args (inputs + encode, without the output path). Sources carry their own duration (palettegen needs EOF); the muxer is always explicit. */
const SPECS = {
  video: {
    file: '範例 影片 clip.mov',
    args: [...LAVFI, 'testsrc2=size=1280x720:rate=30:duration=3', ...LAVFI, 'sine=frequency=440:sample_rate=48000:duration=3',
      '-t', '3', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-f', 'mov'],
  },
  prores: {
    file: 'prores sample.mov',
    args: [...LAVFI, 'testsrc=size=1280x720:rate=25:duration=2', ...LAVFI, 'sine=frequency=660:sample_rate=48000:duration=2',
      '-t', '2', '-map', '0:v', '-map', '1:a',
      '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le',
      '-c:a', 'pcm_s16le', '-f', 'mov'],
  },
  png: {
    file: '透明 logo.png',
    args: [...LAVFI, "color=c=black@0:s=640x480,format=rgba,geq=r='255*X/W':g='255*Y/H':b='160':a='if(lt(hypot(X-W/2,Y-H/2),H/2.6),255,0)'",
      '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', '-update', '1', '-f', 'image2'],
  },
  jpeg: {
    file: 'photo 4000x3000.jpg',
    args: [...LAVFI, 'testsrc2=size=4000x3000:rate=1',
      '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-pix_fmt', 'yuvj420p', '-update', '1', '-f', 'image2'],
  },
  gif: {
    file: 'animated.gif',
    args: [...LAVFI, 'testsrc=size=320x240:rate=10:duration=2',
      '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse', '-loop', '0', '-f', 'gif'],
  },
  flat: {
    file: 'watermark base.mp4',
    args: [...LAVFI, 'color=c=0x808080:size=1280x720:rate=30:duration=4', ...LAVFI, 'sine=frequency=330:sample_rate=48000:duration=4',
      '-t', '4', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-f', 'mp4'],
  },
}

function run(bin, args) {
  return new Promise((ok, ko) => {
    const p = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000) })
    p.on('error', ko)
    p.on('close', (code) => (code === 0 ? ok() : ko(new Error(`${bin} exited ${code}: ${err.trim().split('\n').slice(-5).join('\n')}`))))
  })
}

/**
 * Create the test files in outDir (existing non-empty files are kept unless `force`).
 * @param {string} outDir
 * @param {{ force?: boolean, ffmpeg?: string, log?: (msg: string) => void }} [opts]
 */
export async function makeTestMedia(outDir, opts = {}) {
  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })
  const ffmpeg = opts.ffmpeg ?? resolveFfmpeg().ffmpeg
  const log = opts.log ?? (() => {})
  const manifest = { dir }
  for (const [key, spec] of Object.entries(SPECS)) {
    const dest = join(dir, spec.file)
    manifest[key] = dest
    if (!opts.force && existsSync(dest) && statSync(dest).size > 0) continue
    // write to a temp name, rename on success, so an interrupted run never leaves a truncated file
    const tmp = join(dir, `.partial-${key}`)
    rmSync(tmp, { force: true })
    log(`making ${spec.file}`)
    await run(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...spec.args, tmp])
    rmSync(dest, { force: true })
    renameSync(tmp, dest)
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

const invokedDirectly = (() => {
  const a = process.argv[1] ? resolve(process.argv[1]) : ''
  const me = fileURLToPath(import.meta.url)
  return process.platform === 'win32' ? a.toLowerCase() === me.toLowerCase() : a === me
})()

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const outDir = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'test-media')
  makeTestMedia(outDir, { force, log: (m) => console.log(m) })
    .then((m) => console.log(JSON.stringify(m, null, 2)))
    .catch((err) => {
      console.error(err.message ?? err)
      process.exit(1)
    })
}

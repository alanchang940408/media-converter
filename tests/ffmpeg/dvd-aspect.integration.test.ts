// Real-ffmpeg checks for non-square-pixel output: DVD-Video watermarks must look right when *played* (displayed at
// 16:9 / 4:3), anamorphic sources must pick the DVD frame by their displayed aspect, and MJPEG must be full range
// without the deprecated yuvj pixel formats.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { VideoOverlay } from '../../src/main/contracts'
import { ffmpegEngine, getFfmpegPaths, setCustomFfmpegPath } from '../../src/main/ffmpeg'
import type { ProbedMediaInfo } from '../../src/main/ffmpeg/probe'
import { imageEngine } from '../../src/main/image'
import { getBuiltinPreset } from '../../src/main/presets/builtin'
import type { TextWatermark, VideoPreset, VideoPresetSettings } from '../../src/shared/types'
import { fakeCaps } from './fixtures'
import { applyTestFfmpegOverride, ff } from './media'

let dir = ''
let dark = '' // 2 s 1920×1080 black + stereo audio
let dv43 = '' // 2 s 720×480 stored at 8:9 pixels → 4:3 displayed (DV NTSC 4:3)
let hdv = '' // 2 s 1440×1080 stored at 4:3 pixels → 16:9 displayed (HDV)
const info: Record<string, ProbedMediaInfo> = {}

beforeAll(async () => {
  applyTestFfmpegOverride(setCustomFfmpegPath)
  dir = mkdtempSync(join(tmpdir(), 'mc-dvd-aspect-'))
  dark = join(dir, '黑底 16x9.mov')
  dv43 = join(dir, 'DV 4x3 anamorphic.mov')
  hdv = join(dir, 'HDV 16x9 anamorphic.mov')
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2']
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
  ff(['-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=2', ...audio, ...h264, '-c:a', 'aac', '-ac', '2', '-shortest', dark])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x480:r=30000/1001:d=2,setsar=8/9', ...h264, dv43])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1440x1080:r=25:d=2,setsar=4/3', ...h264, hdv])
  for (const p of [dark, dv43, hdv]) info[p] = await ffmpegEngine.probe(p)
})

afterAll(() => {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* windows may still hold a handle briefly */
  }
})

const builtin = (id: string): VideoPresetSettings => (getBuiltinPreset(id) as VideoPreset).settings

function streamInfo(path: string): Record<string, string | number> {
  const r = spawnSync(getFfmpegPaths().ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', path], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  return (JSON.parse(r.stdout) as { streams: Array<Record<string, string | number>> }).streams[0]
}

async function encode(name: string, source: string, settings: VideoPresetSettings, overlay: VideoOverlay | null = null) {
  const dest = join(dir, `${name}.part`)
  const logs: string[] = []
  const result = await ffmpegEngine.encode({
    source,
    info: info[source],
    settings,
    trim: null,
    dest,
    overlay,
    caps: fakeCaps(),
    preferredHw: 'none',
    signal: new AbortController().signal,
    onProgress: () => {},
    onLog: (l) => logs.push(l),
  })
  return { result, dest, logs }
}

/** Bounding box of the bright (luma > 128) pixels of a frame. */
async function brightBox(png: Buffer): Promise<{ x: number; y: number; w: number; h: number; frameW: number; frameH: number }> {
  const { data, info: m } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (data[(y * m.width + x) * m.channels] > 128) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, frameW: m.width, frameH: m.height }
}

describe('DVD-Video watermark is laid out for the displayed frame', () => {
  // white text on a white box: a solid rectangle whose displayed size and position can be measured
  const wm: TextWatermark = {
    type: 'text',
    text: 'DVD 浮水印 TEST',
    fontSizePct: 9,
    color: '#ffffff',
    background: '#ffffff',
    anchor: 'bottom-right',
    marginPct: 5,
    opacity: 1,
  }

  for (const [id, std] of [['mpeg2-dvd-ntsc', 'NTSC'], ['mpeg2-dvd-pal', 'PAL']] as const) {
    it(`${std} 16:9: the watermark box keeps its size and margins when played`, async () => {
      const settings: VideoPresetSettings = { ...builtin(id), watermark: wm }
      // exactly what the queue does
      const size = ffmpegEngine.computeOutputSize(info[dark], settings)!
      expect(size.sar).toBeCloseTo(std === 'NTSC' ? 32 / 27 : 64 / 45, 10)
      const layer = await imageEngine.renderWatermarkLayer(wm, size.width, size.height, { name: 'x' }, { sampleAspect: size.sar })
      const png = join(dir, `${std} overlay.png`)
      writeFileSync(png, layer.png)
      const { dest } = await encode(`dvd ${std} watermark`, dark, settings, { pngPath: png, left: layer.left, top: layer.top })
      expect(streamInfo(dest)).toMatchObject({ width: size.width, height: size.height, display_aspect_ratio: '16:9' })

      // what a player shows: the frame stretched to its display aspect
      const dw = Math.round(size.width * size.sar!)
      const frame = await ffmpegEngine.extractFrame(dest, 1, { width: dw, height: size.height, format: 'png' })
      const box = await brightBox(frame)
      expect([box.frameW, box.frameH]).toEqual([dw, size.height])
      // the same watermark laid out on a square-pixel frame of the displayed size
      const shown = await imageEngine.renderWatermarkLayer(wm, dw, size.height, { name: 'x' })
      const tol = 4
      expect(Math.abs(box.w - shown.width), `width ${box.w} vs ${shown.width}`).toBeLessThanOrEqual(tol)
      expect(Math.abs(box.h - shown.height), `height ${box.h} vs ${shown.height}`).toBeLessThanOrEqual(tol)
      expect(Math.abs(box.x - shown.left), `left ${box.x} vs ${shown.left}`).toBeLessThanOrEqual(tol)
      expect(Math.abs(box.y - shown.top), `top ${box.y} vs ${shown.top}`).toBeLessThanOrEqual(tol)
      // the old storage-size overlay would have been stretched by the pixel aspect: far outside the tolerance
      expect(shown.width * size.sar! - shown.width).toBeGreaterThan(5 * tol)
    })
  }
})

describe('anamorphic sources pick the DVD frame by their displayed aspect', () => {
  it('probe reports the pixel aspect of non-square sources', () => {
    expect(info[dv43]).toMatchObject({ width: 720, height: 480 })
    expect(info[dv43].sampleAspectRatio).toBeCloseTo(8 / 9, 6)
    expect(info[hdv]).toMatchObject({ width: 1440, height: 1080 })
    expect(info[hdv].sampleAspectRatio).toBeCloseTo(4 / 3, 6)
    expect(info[dark].sampleAspectRatio).toBeUndefined()
  })

  it('DV 720×480 at 8:9 (looks 4:3) → 4:3 DVD frame, not 16:9', async () => {
    const s = builtin('mpeg2-dvd-ntsc')
    expect(ffmpegEngine.computeOutputSize(info[dv43], s)).toEqual({ width: 720, height: 480, sar: 8 / 9 })
    const { dest } = await encode('dvd from dv43', dv43, s)
    expect(streamInfo(dest)).toMatchObject({ width: 720, height: 480, display_aspect_ratio: '4:3' })
  })

  it('HDV 1440×1080 at 4:3 (looks 16:9) → 16:9 DVD frame, not 4:3', async () => {
    const s = builtin('mpeg2-dvd-pal')
    expect(ffmpegEngine.computeOutputSize(info[hdv], s)).toEqual({ width: 720, height: 576, sar: 64 / 45 })
    const { dest } = await encode('dvd from hdv', hdv, s)
    expect(streamInfo(dest)).toMatchObject({ width: 720, height: 576, display_aspect_ratio: '16:9' })
    // the picture fills the frame (no letterbox): a full-height source in a matching aspect
    const frame = await ffmpegEngine.extractFrame(dest, 1, { width: 1024, height: 576, format: 'png' })
    const { data, info: m } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true })
    const rowMean = (y: number): number => {
      let sum = 0
      for (let x = 0; x < m.width; x++) sum += data[(y * m.width + x) * m.channels]
      return sum / m.width
    }
    expect(rowMean(4)).toBeGreaterThan(20) // testsrc2 content, not a black bar
  })
})

describe('MJPEG colour range', () => {
  it('full range (pc) MJPEG without the deprecated yuvj pixel format warning', async () => {
    const { result, dest, logs } = await encode('mjpeg range', dark, builtin('avi-mjpeg'))
    expect(result.encoder).toBe('mjpeg')
    expect(result.args.join(' ')).toContain('color_ranges=pc')
    expect(result.args.join(' ')).not.toContain('yuvj')
    const v = streamInfo(dest)
    expect(v).toMatchObject({ codec_name: 'mjpeg', color_range: 'pc', width: 1920, height: 1080 })
    // the mjpeg decoder reports its frames as yuvj422p; 4:2:2 is what matters
    expect(String(v.pix_fmt)).toMatch(/^yuvj?422p$/)
    expect(logs.join('\n')).not.toMatch(/deprecated pixel format/i)
    // black stays black (full-range levels: Y = 0, not the limited-range 16)
    const frame = await ffmpegEngine.extractFrame(dest, 1, { width: 192, height: 108, format: 'png' })
    const { data } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true })
    expect(Math.max(...data)).toBeLessThanOrEqual(6)
  })
})

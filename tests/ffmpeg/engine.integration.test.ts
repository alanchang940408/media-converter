// Real-ffmpeg: capability detection, probing, frames, hardware encoders, abort, fallback, errors.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EncodeError, type VideoEncodeRequest } from '../../src/main/contracts'
import { activePids, ffmpegEngine, getFfmpegPaths, setCustomFfmpegPath } from '../../src/main/ffmpeg'
import type { EncoderCapabilities, MediaInfo, VideoPresetSettings } from '../../src/shared/types'
import { fakeCaps, preset } from './fixtures'
import { applyTestFfmpegOverride, ff, makeSources, type Sources } from './media'

let src: Sources
let vInfo: MediaInfo
let caps: EncoderCapabilities

beforeAll(async () => {
  applyTestFfmpegOverride(setCustomFfmpegPath)
  src = makeSources('eng')
  vInfo = await ffmpegEngine.probe(src.video)
  caps = await ffmpegEngine.detectCapabilities()
})

afterAll(() => {
  expect(activePids()).toEqual([])
  src?.cleanup()
})

function request(name: string, settings: VideoPresetSettings, o: Partial<VideoEncodeRequest> = {}): VideoEncodeRequest & { logs: string[] } {
  const logs: string[] = []
  return {
    source: src.video,
    info: vInfo,
    settings,
    trim: { inSec: 0, outSec: 1 },
    dest: join(src.dir, name),
    overlay: null,
    caps,
    preferredHw: 'auto',
    signal: new AbortController().signal,
    onProgress: () => {},
    onLog: (l) => logs.push(l),
    logs,
    ...o,
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('detectCapabilities', () => {
  it('finds ffmpeg (bundled or system) and its encoders', () => {
    const paths = getFfmpegPaths()
    expect(caps.ffmpegSource).toBe(paths.source)
    expect(caps.ffmpegPath).toBe(paths.ffmpeg)
    expect(caps.ffprobePath).toBe(paths.ffprobe)
    expect(caps.ffmpegVersion).not.toBe('')
    for (const e of ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9', 'prores_ks', 'dnxhd', 'gif', 'aac', 'libmp3lame', 'libopus']) {
      expect(caps.compiledEncoders, e).toContain(e)
    }
    // Every working hw encoder must also be compiled; hw flags follow h264.
    for (const e of caps.workingHwEncoders) expect(caps.compiledEncoders).toContain(e)
    expect(caps.hw.nvenc).toBe(caps.workingHwEncoders.includes('h264_nvenc'))
    expect(caps.hw.qsv).toBe(caps.workingHwEncoders.includes('h264_qsv'))
    expect(caps.hw.amf).toBe(caps.workingHwEncoders.includes('h264_amf'))
    console.log('[caps] working hw encoders:', caps.workingHwEncoders.join(', ') || '(none)')
  })

  it('caches the result; force re-detects', async () => {
    expect(ffmpegEngine.detectCapabilities()).toBe(ffmpegEngine.detectCapabilities())
    const again = await ffmpegEngine.detectCapabilities()
    expect(again).toBe(caps)
    const forced = await ffmpegEngine.detectCapabilities(true)
    expect(forced).not.toBe(caps)
    expect(forced.workingHwEncoders.sort()).toEqual([...caps.workingHwEncoders].sort())
  })
})

describe('probe', () => {
  it('rotated file reports the displayed (swapped) size', async () => {
    const rotated = join(src.dir, 'rotated 旋轉.mp4')
    ff(['-display_rotation', '90', '-i', src.video, '-c', 'copy', rotated])
    const info = await ffmpegEngine.probe(rotated)
    expect(info.width).toBe(720)
    expect(info.height).toBe(1280)
    expect(info.rotation).toBe(270) // display matrix rotates 90° counter-clockwise = 270° clockwise
  })

  it('a re-encode of a rotated source comes out upright at the displayed size', async () => {
    const rotated = join(src.dir, 'rotated 旋轉.mp4')
    const info = await ffmpegEngine.probe(rotated)
    const r = request('rotated out.mp4', preset({ video: { width: 360, speed: 'fast' } }), { source: rotated, info, preferredHw: 'none' })
    await ffmpegEngine.encode(r)
    const out = await ffmpegEngine.probe(r.dest)
    expect(out).toMatchObject({ width: 360, height: 640, rotation: 0 })
  })

  it('missing file → readable error', async () => {
    await expect(ffmpegEngine.probe(join(src.dir, '不存在.mp4'))).rejects.toThrow(/不存在\.mp4/)
  })

  it('png image still returns something sensible', async () => {
    const info = await ffmpegEngine.probe(src.logo)
    expect(info).toMatchObject({ kind: 'image', width: 200, height: 80, hasAlpha: true, hasAudio: false })
  })
})

describe('frames', () => {
  it('extractFrame returns a JPEG of the requested width', async () => {
    const buf = await ffmpegEngine.extractFrame(src.video, 1.5, { maxWidth: 320 })
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
    const meta = await sharp(buf).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(320)
    expect(meta.height).toBe(180)
  })

  it('maxWidth never upscales; exact size and png work; t past the end is clamped', async () => {
    const big = await sharp(await ffmpegEngine.extractFrame(src.video, 0, { maxWidth: 4000 })).metadata()
    expect(big.width).toBe(1280)
    const exact = await ffmpegEngine.extractFrame(src.video, 100, { width: 200, height: 100, format: 'png' })
    expect([...exact.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const meta = await sharp(exact).metadata()
    expect([meta.width, meta.height]).toEqual([200, 100])
  })

  it('extractFrame on a still image ignores the seek', async () => {
    const buf = await ffmpegEngine.extractFrame(src.logo, 5, { maxWidth: 100 })
    expect(buf[0]).toBe(0xff)
    expect((await sharp(buf).metadata()).width).toBe(100)
  })

  it('decodeImageToPng decodes a BMP', async () => {
    const bmp = join(src.dir, 'still 圖.bmp')
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48', '-frames:v', '1', bmp])
    const png = await ffmpegEngine.decodeImageToPng(bmp)
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await sharp(png).metadata()).width).toBe(64)
  })
})

describe('hardware encoders', () => {
  it('h264_nvenc', async (ctx) => {
    if (!caps.workingHwEncoders.includes('h264_nvenc')) return ctx.skip()
    const r = request('nvenc h264.mp4', preset({ video: { hw: 'nvenc' } }))
    const res = await ffmpegEngine.encode(r)
    expect(res.encoder).toBe('h264_nvenc')
    expect((await ffmpegEngine.probe(r.dest)).videoCodec).toBe('h264')
  })

  it('hevc_nvenc (10-bit)', async (ctx) => {
    if (!caps.workingHwEncoders.includes('hevc_nvenc')) return ctx.skip()
    const r = request('nvenc hevc.mp4', preset({ video: { codec: 'hevc', hw: 'nvenc', tenBit: true } }))
    const res = await ffmpegEngine.encode(r)
    expect(res.encoder).toBe('hevc_nvenc')
    const out = await ffmpegEngine.probe(r.dest)
    expect(out.videoCodec).toBe('hevc')
    expect(out.pixFmt).toBe('yuv420p10le')
  })

  it('nvenc vbr', async (ctx) => {
    if (!caps.workingHwEncoders.includes('h264_nvenc')) return ctx.skip()
    const r = request('nvenc vbr.mp4', preset({ video: { hw: 'nvenc', rate: { mode: 'vbr', bitrateKbps: 3000 } } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe('h264_nvenc')
  })

  it("hw 'auto' + preferred 'auto' picks the first working family", async (ctx) => {
    const first = ['nvenc', 'qsv', 'amf', 'videotoolbox'].map((f) => `h264_${f}`).find((e) => caps.workingHwEncoders.includes(e))
    if (!first) return ctx.skip()
    const r = request('auto.mp4', preset({ video: { hw: 'auto' } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe(first)
  })

  it('h264_qsv', async (ctx) => {
    if (!caps.workingHwEncoders.includes('h264_qsv')) return ctx.skip()
    const r = request('qsv h264.mp4', preset({ video: { hw: 'qsv' } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe('h264_qsv')
    expect((await ffmpegEngine.probe(r.dest)).videoCodec).toBe('h264')
  })

  it('hevc_qsv', async (ctx) => {
    if (!caps.workingHwEncoders.includes('hevc_qsv')) return ctx.skip()
    const r = request('qsv hevc.mp4', preset({ video: { codec: 'hevc', hw: 'qsv' } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe('hevc_qsv')
  })

  it('hevc_qsv 10-bit (p010le + main10)', async (ctx) => {
    if (!caps.workingHwEncoders.includes('hevc_qsv')) return ctx.skip()
    const r = request('qsv hevc10.mkv', preset({ container: 'mkv', video: { codec: 'hevc', hw: 'qsv', tenBit: true } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe('hevc_qsv')
    expect((await ffmpegEngine.probe(r.dest)).pixFmt).toBe('yuv420p10le')
  })

  it('av1_nvenc 10-bit', async (ctx) => {
    if (!caps.workingHwEncoders.includes('av1_nvenc')) return ctx.skip()
    const r = request('nvenc av1.mp4', preset({ video: { codec: 'av1', hw: 'nvenc', tenBit: true } }))
    expect((await ffmpegEngine.encode(r)).encoder).toBe('av1_nvenc')
    const out = await ffmpegEngine.probe(r.dest)
    expect(out.videoCodec).toBe('av1')
    expect(out.pixFmt).toBe('yuv420p10le')
  })

  it('h264_nvenc cbr + baseline profile + overlay', async (ctx) => {
    if (!caps.workingHwEncoders.includes('h264_nvenc')) return ctx.skip()
    const r = request('nvenc cbr.mp4', preset({ video: { hw: 'nvenc', profile: 'baseline', rate: { mode: 'cbr', bitrateKbps: 2000 } } }), {
      overlay: { pngPath: src.logo, left: 16, top: 16 },
    })
    expect((await ffmpegEngine.encode(r)).encoder).toBe('h264_nvenc')
    expect((await ffmpegEngine.probe(r.dest)).videoCodec).toBe('h264')
  })

  it('a failing hw encoder falls back to software once', async () => {
    // Claim AMF works on a machine where it does not (no AMD GPU / amfrt64.dll).
    if (caps.workingHwEncoders.includes('h264_amf')) return
    const r = request('fallback.mp4', preset({ video: { hw: 'amf', speed: 'fast' } }), { caps: fakeCaps(['h264_amf']) })
    const res = await ffmpegEngine.encode(r)
    expect(res.encoder).toBe('libx264')
    expect(res.args).toContain('libx264')
    expect(r.logs).toContain('Hardware encoder h264_amf failed, retrying with software')
    expect((await ffmpegEngine.probe(r.dest)).videoCodec).toBe('h264')
  })
})

describe('abort and errors', () => {
  it('abort mid-encode kills ffmpeg and rejects with AbortError', async () => {
    const ac = new AbortController()
    let sawProgress = false
    const r = request('abort.mp4', preset({ video: { width: 3840, height: 2160, scaleMode: 'stretch', speed: 'quality' } }), {
      trim: null,
      preferredHw: 'none',
      signal: ac.signal,
      onProgress: () => {
        sawProgress = true
      },
    })
    const p = ffmpegEngine.encode(r)
    const started = Date.now()
    while (activePids().length === 0 && Date.now() - started < 10_000) await new Promise((res) => setTimeout(res, 20))
    const [pid] = activePids()
    expect(pid).toBeTypeOf('number')
    while (!sawProgress && Date.now() - started < 10_000) await new Promise((res) => setTimeout(res, 20))
    ac.abort()
    const err = await p.then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.name).toBe('AbortError')
    expect(activePids()).toEqual([])
    expect(isRunning(pid)).toBe(false)
  })

  it('an already-aborted signal never spawns ffmpeg', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = request('never.mp4', preset(), { signal: ac.signal })
    await expect(ffmpegEngine.encode(r)).rejects.toMatchObject({ name: 'AbortError' })
    expect(activePids()).toEqual([])
  })

  it('a missing source (CJK path) is reported clearly before spawning', async () => {
    const missing = join(src.dir, 'missing 檔案.mov')
    const r = request('broken.mp4', preset(), { source: missing, preferredHw: 'none' })
    const err = await ffmpegEngine.encode(r).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(EncodeError)
    expect((err as EncodeError).message).toBe(`Source file not found: ${missing}`)
  })

  it('a failing ffmpeg run rejects with EncodeError (message, logTail, exitCode)', async () => {
    const corrupt = join(src.dir, 'corrupt 壞.mov')
    writeFileSync(corrupt, Buffer.alloc(4096, 0x5a))
    const r = request('corrupt out.mp4', preset({ video: { speed: 'fast' } }), { source: corrupt, preferredHw: 'none' })
    const err = await ffmpegEngine.encode(r).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(EncodeError)
    const e = err as EncodeError
    // the demuxer's specific cause ("moov atom not found") beats the generic "Invalid data found…" summary
    expect(e.message).toMatch(/moov atom not found|invalid data/i)
    expect(e.message).not.toMatch(/^\[/) // component prefix stripped
    expect(e.logTail.length).toBeGreaterThan(0)
    expect(e.logTail.length).toBeLessThanOrEqual(40)
    expect(e.exitCode).not.toBe(0)
    expect(e.exitCode).not.toBeNull()
    expect(r.logs.length).toBeGreaterThan(0)
    expect(activePids()).toEqual([])
  })
})

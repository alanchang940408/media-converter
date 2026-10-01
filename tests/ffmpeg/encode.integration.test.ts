// Real-ffmpeg encodes (software encoders). Sources are generated into a temp dir.
import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { EncodeProgress, VideoEncodeRequest } from '../../src/main/contracts'
import { ffmpegEngine, setCustomFfmpegPath } from '../../src/main/ffmpeg'
import type { MediaInfo, VideoPresetSettings } from '../../src/shared/types'
import { fakeCaps, preset } from './fixtures'
import { applyTestFfmpegOverride, ff, makeSources, type Sources } from './media'

let src: Sources
let vInfo: MediaInfo
let aInfo: MediaInfo
const caps = fakeCaps()

beforeAll(async () => {
  applyTestFfmpegOverride(setCustomFfmpegPath)
  src = makeSources('enc')
  vInfo = await ffmpegEngine.probe(src.video)
  aInfo = await ffmpegEngine.probe(src.audio)
})

afterAll(() => src?.cleanup())

type Opts = Partial<Pick<VideoEncodeRequest, 'info' | 'source' | 'trim' | 'overlay' | 'caps' | 'preferredHw'>>

async function encodeTo(name: string, settings: VideoPresetSettings, o: Opts = {}) {
  const dest = join(src.dir, name)
  const progress: EncodeProgress[] = []
  const logs: string[] = []
  const result = await ffmpegEngine.encode({
    source: o.source ?? src.video,
    info: o.info ?? vInfo,
    settings,
    trim: o.trim ?? null,
    dest,
    overlay: o.overlay ?? null,
    caps: o.caps ?? caps,
    preferredHw: o.preferredHw ?? 'none',
    signal: new AbortController().signal,
    onProgress: (p) => progress.push(p),
    onLog: (l) => logs.push(l),
  })
  const out = await ffmpegEngine.probe(dest)
  return { result, out, progress, logs, dest }
}

function streamField(path: string, entry: string, select = 'v:0'): string {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', select, '-show_entries', entry, '-of', 'default=nw=1:nk=1', path], {
    windowsHide: true,
    encoding: 'utf8',
  })
  return r.stdout.trim()
}

const fast = { speed: 'fast' as const }

describe('source probing', () => {
  it('probes the generated CJK-named sources', () => {
    expect(vInfo).toMatchObject({ kind: 'video', width: 1280, height: 720, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true })
    expect(vInfo.durationSec).toBeCloseTo(3, 0)
    expect(aInfo).toMatchObject({ kind: 'audio', audioCodec: 'pcm_s16le', audioSampleRate: 48000, audioChannels: 2, hasAudio: true })
    expect(aInfo.width).toBeUndefined()
  })
})

describe('video encodes', () => {
  it('h264 software to a temp name with a mismatched extension (explicit muxer) + progress', async () => {
    const { result, out, progress, dest } = await encodeTo('輸出 h264.mp4.part', preset({ faststart: true }))
    expect(result.encoder).toBe('libx264')
    expect(result.args[result.args.length - 1]).toBe(dest)
    expect(out).toMatchObject({ kind: 'video', videoCodec: 'h264', width: 1280, height: 720, audioCodec: 'aac', pixFmt: 'yuv420p' })
    expect(out.format).toContain('mp4')
    expect(out.durationSec).toBeCloseTo(3, 0)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1].fraction).toBe(1)
    for (let i = 1; i < progress.length; i++) expect(progress[i].fraction).toBeGreaterThanOrEqual(progress[i - 1].fraction)
    expect(statSync(dest).size).toBeGreaterThan(10_000)
  })

  it('hevc (libx265) in mp4 with hvc1 tag', async () => {
    const { result, out, dest } = await encodeTo('hevc.mp4', preset({ video: { codec: 'hevc', ...fast } }))
    expect(result.encoder).toBe('libx265')
    expect(out.videoCodec).toBe('hevc')
    expect(streamField(dest, 'stream=codec_tag_string')).toBe('hvc1')
  })

  it('hevc 10-bit', async () => {
    const { out } = await encodeTo('hevc10.mkv', preset({ container: 'mkv', video: { codec: 'hevc', tenBit: true, ...fast } }), {
      trim: { inSec: 0, outSec: 1 },
    })
    expect(out.videoCodec).toBe('hevc')
    expect(out.pixFmt).toBe('yuv420p10le')
  })

  it('prores hq → yuv422p10le + pcm', async () => {
    const { result, out } = await encodeTo('prores hq.mov', preset({ container: 'mov', video: { codec: 'prores', profile: 'hq' }, audio: { codec: 'pcm' } }))
    expect(result.encoder).toBe('prores_ks')
    expect(out).toMatchObject({ videoCodec: 'prores', pixFmt: 'yuv422p10le', audioCodec: 'pcm_s16le', width: 1280, height: 720 })
    expect(streamField(join(src.dir, 'prores hq.mov'), 'stream=profile')).toMatch(/HQ/i)
  })

  it('dnxhr hq', async () => {
    const { result, out } = await encodeTo('dnxhr.mov', preset({ container: 'mov', video: { codec: 'dnxhr', profile: 'hq' }, audio: { codec: 'pcm' } }))
    expect(result.encoder).toBe('dnxhd')
    expect(out).toMatchObject({ videoCodec: 'dnxhd', pixFmt: 'yuv422p', width: 1280, height: 720 })
  })

  it('vp9 webm (short)', async () => {
    const { result, out } = await encodeTo('vp9.webm', preset({ container: 'webm', video: { codec: 'vp9', width: 640, ...fast }, audio: { codec: 'opus' } }), {
      trim: { inSec: 0, outSec: 1 },
    })
    expect(result.encoder).toBe('libvpx-vp9')
    expect(out).toMatchObject({ videoCodec: 'vp9', audioCodec: 'opus', width: 640, height: 360 })
    expect(out.durationSec!).toBeLessThan(1.3)
  })

  it('av1 (svt-av1) in mp4', async () => {
    const { result, out } = await encodeTo('av1.mp4', preset({ video: { codec: 'av1', ...fast } }), { trim: { inSec: 0, outSec: 1.5 } })
    expect(result.encoder).toBe('libsvtav1')
    expect(out).toMatchObject({ videoCodec: 'av1', width: 1280, height: 720 })
  })

  it('av1 vbr (svt-av1 accepts the bitrate mode)', async () => {
    const { out } = await encodeTo('av1 vbr.mkv', preset({ container: 'mkv', video: { codec: 'av1', width: 640, rate: { mode: 'vbr', bitrateKbps: 800 }, ...fast } }), {
      trim: { inSec: 0, outSec: 1 },
    })
    expect(out.videoCodec).toBe('av1')
  })

  it('h264 vbr and cbr', async () => {
    const vbr = await encodeTo('vbr.mp4', preset({ video: { rate: { mode: 'vbr', bitrateKbps: 1500 }, ...fast } }), { trim: { inSec: 0, outSec: 1 } })
    expect(vbr.out.videoCodec).toBe('h264')
    const cbr = await encodeTo('cbr.mkv', preset({ container: 'mkv', video: { rate: { mode: 'cbr', bitrateKbps: 1500 }, ...fast } }), { trim: { inSec: 0, outSec: 1 } })
    expect(cbr.out.videoCodec).toBe('h264')
  })

  it('gif with palette', async () => {
    const gif = { fps: 10, width: 320, colors: 64, dither: 'bayer' as const, loop: 0 }
    const { result, out } = await encodeTo('anim 動畫.gif', preset({ container: 'gif', video: { codec: 'gif', gif }, audio: { codec: 'none' } }))
    expect(result.encoder).toBe('gif')
    expect(out).toMatchObject({ videoCodec: 'gif', width: 320, height: 180, hasAudio: false })
  })

  it('gif with an overlay', async () => {
    const gif = { fps: 8, width: 480, colors: 128, dither: 'sierra2_4a' as const, loop: 0 }
    const { out } = await encodeTo('overlay.gif', preset({ container: 'gif', video: { codec: 'gif', gif }, audio: { codec: 'none' } }), {
      overlay: { pngPath: src.logo, left: 10, top: 10 },
      trim: { inSec: 0, outSec: 1 },
    })
    expect(out).toMatchObject({ videoCodec: 'gif', width: 480, height: 270 })
  })

  it('prores 4444 keeps alpha; frames decode from a 10-bit source', async () => {
    const alphaSrc = join(src.dir, 'alpha 透明.mov')
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1,format=yuva420p', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', alphaSrc])
    const info = await ffmpegEngine.probe(alphaSrc)
    expect(info.hasAlpha).toBe(true)
    const { out, dest } = await encodeTo('alpha out.mov', preset({ container: 'mov', video: { codec: 'prores', profile: '4444' }, audio: { codec: 'pcm' } }), {
      source: alphaSrc,
      info,
    })
    // the ProRes decoder reports 4444 as 12-bit (yuva444p12le) regardless of the 10-bit encoder input
    expect(out).toMatchObject({ videoCodec: 'prores', hasAlpha: true, hasAudio: false })
    expect(out.pixFmt).toMatch(/^yuva444p1[02]le$/)
    expect(streamField(dest, 'stream=profile')).toMatch(/4444/)
    const jpeg = await ffmpegEngine.extractFrame(dest, 0.5, { maxWidth: 160 })
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8])
    expect((await sharp(jpeg).metadata()).width).toBe(160)
  })

  it('stream copy into mkv', async () => {
    const { result, out } = await encodeTo('copy.mkv', preset({ container: 'mkv', video: { codec: 'copy' }, audio: { codec: 'copy' } }))
    expect(result.encoder).toBe('copy')
    expect(out).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720 })
  })
})

describe('audio outputs', () => {
  const audioOnly = (container: VideoPresetSettings['container'], codec: VideoPresetSettings['audio']['codec']) =>
    preset({ container, video: { codec: 'none' }, audio: { codec, bitrateKbps: null } })

  it('mp3 / m4a / wav / flac / ogg from a video source', async () => {
    const cases: Array<[string, VideoPresetSettings['container'], VideoPresetSettings['audio']['codec'], string, string]> = [
      ['a.mp3', 'mp3', 'mp3', 'mp3', 'libmp3lame'],
      ['a.m4a', 'm4a', 'aac', 'aac', 'aac'],
      ['a.wav', 'wav', 'pcm', 'pcm_s16le', 'pcm_s16le'],
      ['a.flac', 'flac', 'flac', 'flac', 'flac'],
      ['a.ogg', 'ogg', 'opus', 'opus', 'libopus'],
    ]
    for (const [name, container, codec, probed, encoder] of cases) {
      const { result, out } = await encodeTo(name, audioOnly(container, codec))
      expect(result.encoder, name).toBe(encoder)
      expect(out.kind, name).toBe('audio')
      expect(out.audioCodec, name).toBe(probed)
      expect(out.width, name).toBeUndefined()
      expect(out.durationSec!, name).toBeGreaterThan(2.7)
      expect(out.durationSec!, name).toBeLessThan(3.3)
    }
  })

  it('loudness normalisation keeps the source sample rate', async () => {
    const { out } = await encodeTo('norm.mp3', preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3', normalize: true } }))
    expect(out.audioSampleRate).toBe(48000)
  })

  it('audio-only source → mp4 (audio-only file)', async () => {
    const { result, out } = await encodeTo('from wav.mp4', preset(), { source: src.audio, info: aInfo })
    expect(result.encoder).toBe('aac')
    expect(out).toMatchObject({ kind: 'audio', audioCodec: 'aac', hasAudio: true })
    expect(out.format).toContain('mp4')
    expect(out.videoCodec).toBeUndefined()
  })
})

describe('filters', () => {
  it('pad to 1080x1920', async () => {
    const { out } = await encodeTo('pad.mp4', preset({ video: { width: 1080, height: 1920, scaleMode: 'pad', ...fast } }), { trim: { inSec: 0, outSec: 1 } })
    expect(out).toMatchObject({ width: 1080, height: 1920 })
  })

  it('crop to 1080x1920', async () => {
    const { out } = await encodeTo('crop.mp4', preset({ video: { width: 1080, height: 1920, scaleMode: 'crop', ...fast } }), { trim: { inSec: 0, outSec: 1 } })
    expect(out).toMatchObject({ width: 1080, height: 1920 })
  })

  it('pad with noUpscale keeps the requested aspect without enlarging', async () => {
    const small = join(src.dir, 'small 小.mp4')
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', small])
    const info = await ffmpegEngine.probe(small)
    const settings = preset({ video: { width: 1080, height: 1920, scaleMode: 'pad', noUpscale: true, ...fast } })
    expect(ffmpegEngine.computeOutputSize(info, settings)).toEqual({ width: 640, height: 1138 })
    const { out } = await encodeTo('pad small.mp4', settings, { source: small, info })
    expect(out).toMatchObject({ width: 640, height: 1138 })
  })

  it('fps change', async () => {
    const { out } = await encodeTo('fps.mp4', preset({ video: { fps: 15, width: 640, ...fast } }), { trim: { inSec: 0, outSec: 1 } })
    expect(out.fps).toBe(15)
    expect(out.width).toBe(640)
  })

  it('PNG overlay is composited at the requested position', async () => {
    const overlay = { pngPath: src.logo, left: 100, top: 50 }
    const { out, dest } = await encodeTo('overlay.mp4', preset({ video: fast }), { overlay })
    expect(out).toMatchObject({ width: 1280, height: 720, videoCodec: 'h264' })
    const frame = await ffmpegEngine.extractFrame(dest, 1, { format: 'png', width: 1280, height: 720 })
    const { data } = await sharp(frame).extract({ left: 200, top: 90, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
    expect(data[0]).toBeGreaterThan(170)
    expect(data[1]).toBeLessThan(90)
    expect(data[2]).toBeLessThan(90)
  })

  it('trim 1.0 → 2.5 s', async () => {
    const { out, progress } = await encodeTo('trim.mp4', preset({ video: fast }), { trim: { inSec: 1, outSec: 2.5 } })
    expect(Math.abs(out.durationSec! - 1.5)).toBeLessThan(0.15)
    expect(progress[progress.length - 1].fraction).toBe(1)
  })
})

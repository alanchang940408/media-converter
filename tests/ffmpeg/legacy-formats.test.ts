// Real-ffmpeg encodes of the MPG / WMV / AVI built-in presets, verified with ffprobe (container, codecs, size, duration).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ffmpegEngine, getFfmpegPaths, setCustomFfmpegPath } from '../../src/main/ffmpeg'
import { getBuiltinPreset } from '../../src/main/presets/builtin'
import type { MediaInfo, VideoPreset, VideoPresetSettings } from '../../src/shared/types'
import { ALL_HW, fakeCaps, preset } from './fixtures'
import { applyTestFfmpegOverride, ff } from './media'

interface ProbeJson {
  format: { format_name: string; duration?: string }
  streams: Array<{
    codec_type: string
    codec_name: string
    codec_tag_string?: string
    width?: number
    height?: number
    pix_fmt?: string
    display_aspect_ratio?: string
    avg_frame_rate?: string
    sample_rate?: string
    channels?: number
  }>
}

let dir = ''
let wide = '' // 2 s 1920×1080 30 fps + 48 kHz stereo
let narrow = '' // 2 s 640×480 25 fps (4:3) + 44.1 kHz stereo
let odd = '' // 2 s 640×360 15 fps + 96 kHz 5.1
const info: Record<string, MediaInfo> = {}

beforeAll(async () => {
  applyTestFfmpegOverride(setCustomFfmpegPath)
  dir = mkdtempSync(join(tmpdir(), 'mc-legacy-'))
  wide = join(dir, '來源 16x9.mov')
  narrow = join(dir, '來源 4x3.mov')
  odd = join(dir, '來源 15fps 5.1.mkv')
  const audio = (rate: number) => ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${rate}:duration=2`]
  const h264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=2', ...audio(48000), ...h264, '-c:a', 'aac', '-ac', '2', '-shortest', wide])
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=25:d=2', ...audio(44100), ...h264, '-c:a', 'aac', '-ac', '2', '-shortest', narrow])
  ff([
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=2', ...audio(96000),
    '-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]', '-map', '0:v', '-map', '[a]',
    ...h264, '-c:a', 'pcm_s24le', '-shortest', odd,
  ])
  for (const p of [wide, narrow, odd]) info[p] = await ffmpegEngine.probe(p)
})

afterAll(() => {
  try {
    if (dir) rmSync(dir, { recursive: true, force: true })
  } catch {
    /* windows may still hold a handle briefly */
  }
})

function ffprobe(path: string): ProbeJson {
  const r = spawnSync(getFfmpegPaths().ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  return JSON.parse(r.stdout) as ProbeJson
}

const builtin = (id: string): VideoPresetSettings => (getBuiltinPreset(id) as VideoPreset).settings

async function encode(name: string, settings: VideoPresetSettings, source = wide) {
  // Temp-style name with a mismatched extension: the muxer must come from -f, not from the file name.
  const dest = join(dir, `${name}.part`)
  const logs: string[] = []
  const result = await ffmpegEngine.encode({
    source,
    info: info[source],
    settings,
    trim: null,
    dest,
    overlay: null,
    // every GPU encoder "works": legacy codecs must still go to the CPU encoders
    caps: fakeCaps(ALL_HW),
    preferredHw: 'auto',
    signal: new AbortController().signal,
    onProgress: () => {},
    onLog: (l) => logs.push(l),
  })
  const probe = ffprobe(dest)
  const v = probe.streams.find((s) => s.codec_type === 'video')
  const a = probe.streams.find((s) => s.codec_type === 'audio')
  return { result, probe, v, a, dest, logs, duration: Number(probe.format.duration) }
}

describe('legacy built-in presets (real encodes)', () => {
  it('DVD MPEG-2 NTSC: DVD program stream, 720×480 16:9, 29.97 fps, AC-3 48 kHz', async () => {
    const { result, probe, v, a, duration } = await encode('dvd ntsc', builtin('mpeg2-dvd-ntsc'))
    expect(result.encoder).toBe('mpeg2video')
    expect(result.args).toContain('dvd')
    expect(probe.format.format_name).toBe('mpeg')
    expect(probe.streams.some((s) => s.codec_name === 'dvd_nav_packet')).toBe(true)
    expect(v).toMatchObject({ codec_name: 'mpeg2video', width: 720, height: 480, display_aspect_ratio: '16:9', pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001' })
    expect(a).toMatchObject({ codec_name: 'ac3', sample_rate: '48000', channels: 2 })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })

  it('DVD MPEG-2 PAL: 720×576 16:9, 25 fps', async () => {
    const { probe, v, a, duration } = await encode('dvd pal', builtin('mpeg2-dvd-pal'))
    expect(probe.format.format_name).toBe('mpeg')
    expect(v).toMatchObject({ codec_name: 'mpeg2video', width: 720, height: 576, display_aspect_ratio: '16:9', avg_frame_rate: '25/1' })
    expect(a).toMatchObject({ codec_name: 'ac3', sample_rate: '48000' })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })

  it('DVD from a 4:3 source gets a 4:3 frame (and 25 → 29.97 fps)', async () => {
    const { v, a } = await encode('dvd 4x3', builtin('mpeg2-dvd-ntsc'), narrow)
    expect(v).toMatchObject({ width: 720, height: 480, display_aspect_ratio: '4:3', avg_frame_rate: '30000/1001' })
    expect(a).toMatchObject({ codec_name: 'ac3', sample_rate: '48000' }) // resampled from 44.1 kHz
  })

  it('MPEG-2 1080p: MPEG-2 program stream, 1920×1080, MP2', async () => {
    const { result, probe, v, a, duration } = await encode('mpeg2 1080p', builtin('mpeg2-1080p'))
    expect(result.encoder).toBe('mpeg2video')
    expect(result.args[result.args.indexOf('-f') + 1]).toBe('vob')
    expect(probe.format.format_name).toBe('mpeg')
    expect(v).toMatchObject({ codec_name: 'mpeg2video', width: 1920, height: 1080, pix_fmt: 'yuv420p' })
    expect(a).toMatchObject({ codec_name: 'mp2', sample_rate: '48000', channels: 2 })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })

  it('WMV 720p: ASF, WMV2 1280×720, WMA 2', async () => {
    const { result, probe, v, a, duration, dest } = await encode('wmv 720p', builtin('wmv-720p'))
    expect(result.encoder).toBe('wmv2')
    expect(probe.format.format_name).toBe('asf')
    expect(v).toMatchObject({ codec_name: 'wmv2', codec_tag_string: 'WMV2', width: 1280, height: 720 })
    expect(a).toMatchObject({ codec_name: 'wmav2', sample_rate: '48000', channels: 2 })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
    expect(statSync(dest).size).toBeGreaterThan(10_000)
  })

  it('AVI Xvid 720p: AVI, MPEG-4 Part 2 tagged XVID, MP3', async () => {
    const { result, probe, v, a, duration } = await encode('avi xvid', builtin('avi-xvid-720p'))
    expect(result.encoder).toBe('mpeg4')
    expect(probe.format.format_name).toBe('avi')
    expect(v).toMatchObject({ codec_name: 'mpeg4', codec_tag_string: 'XVID', width: 1280, height: 720, pix_fmt: 'yuv420p' })
    expect(a).toMatchObject({ codec_name: 'mp3', sample_rate: '48000' })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })

  it('AVI MJPEG: AVI, full-range 4:2:2 Motion JPEG at the source size, PCM', async () => {
    const { result, probe, v, a, duration } = await encode('avi mjpeg', builtin('avi-mjpeg'))
    expect(result.encoder).toBe('mjpeg')
    expect(probe.format.format_name).toBe('avi')
    expect(v).toMatchObject({ codec_name: 'mjpeg', width: 1920, height: 1080, pix_fmt: 'yuvj422p' })
    expect(a).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000' })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })
})

describe('legacy formats with awkward sources', () => {
  it('WMV from a 15 fps, 96 kHz 5.1 source: WMA is downmixed to stereo 48 kHz', async () => {
    const { v, a } = await encode('wmv odd', builtin('wmv-720p'), odd)
    expect(v).toMatchObject({ codec_name: 'wmv2', width: 640, height: 360 })
    expect(a).toMatchObject({ codec_name: 'wmav2', sample_rate: '48000', channels: 2 })
  })

  it('MPEG-1 from a 15 fps source snaps to a standard MPEG rate; MP2 gets stereo 48 kHz', async () => {
    const s = preset({ container: 'mpg', video: { codec: 'mpeg1', hw: 'auto', rate: { mode: 'crf', crf: 23 } }, audio: { codec: 'mp2', bitrateKbps: 200 } })
    const { result, probe, v, a, duration } = await encode('mpeg1 odd', s, odd)
    expect(result.encoder).toBe('mpeg1video')
    expect(result.args[result.args.indexOf('-f') + 1]).toBe('mpeg')
    expect(probe.format.format_name).toBe('mpeg')
    expect(v).toMatchObject({ codec_name: 'mpeg1video', width: 640, height: 360, avg_frame_rate: '24000/1001' })
    expect(a).toMatchObject({ codec_name: 'mp2', sample_rate: '48000', channels: 2 })
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
  })

  it('MPEG-2 in MKV and AC-3 in AVI', async () => {
    const mkv = await encode('mpeg2 mkv', preset({ container: 'mkv', video: { codec: 'mpeg2', width: 640, rate: { mode: 'vbr', bitrateKbps: 3000 } }, audio: { codec: 'ac3' } }))
    expect(mkv.probe.format.format_name).toContain('matroska')
    expect(mkv.v).toMatchObject({ codec_name: 'mpeg2video', width: 640, height: 360 })
    expect(mkv.a?.codec_name).toBe('ac3')
    const ac3 = await encode('xvid ac3', preset({ container: 'avi', video: { codec: 'mpeg4', width: 640 }, audio: { codec: 'ac3' } }))
    expect(ac3.probe.format.format_name).toBe('avi')
    expect(ac3.a?.codec_name).toBe('ac3')
  })
})

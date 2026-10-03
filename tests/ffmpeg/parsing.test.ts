import { describe, expect, it } from 'vitest'
import { parseEncoderList, parseVersion, HW_TEST_ENCODERS } from '../../src/main/ffmpeg/capabilities'
import { frameArgs, frameScaleFilter } from '../../src/main/ffmpeg/frames'
import { mapProbe, parseRate, pixFmtHasAlpha, streamRotation, type FfprobeOutput } from '../../src/main/ffmpeg/probe'
import {
  LineSplitter,
  ProgressParser,
  RingBuffer,
  parseClock,
  parseProgressBlock,
  pickErrorLine,
  progressFromSample,
  stripLogPrefix,
} from '../../src/main/ffmpeg/progress'
import { expectedDuration } from '../../src/main/ffmpeg/runner'
import { videoInfo } from './fixtures'

describe('progress parsing', () => {
  const block = [
    'frame=45', 'fps=29.97', 'stream_0_0_q=28.0', 'bitrate=1234.5kbits/s', 'total_size=262144',
    'out_time_us=1500000', 'out_time_ms=1500000', 'out_time=00:00:01.500000', 'dup_frames=0', 'drop_frames=0',
    'speed=2.3x', 'progress=continue',
  ].join('\n') + '\n'

  it('parses a complete block', () => {
    const p = new ProgressParser()
    const [s] = p.push(block)
    expect(s).toEqual({ outTimeSec: 1.5, fps: 29.97, speed: 2.3, end: false })
  })

  it('handles chunks split mid-line and CRLF', () => {
    const p = new ProgressParser()
    const text = block.replace(/\n/g, '\r\n') + 'out_time_us=3000000\r\nspeed=N/A\r\nprogress=end\r\n'
    const samples = []
    for (let i = 0; i < text.length; i += 7) samples.push(...p.push(text.slice(i, i + 7)))
    expect(samples).toHaveLength(2)
    expect(samples[0].outTimeSec).toBe(1.5)
    expect(samples[1]).toEqual({ outTimeSec: 3, fps: undefined, speed: undefined, end: true })
  })

  it('out_time_ms is microseconds too; N/A and negative times', () => {
    expect(parseProgressBlock({ out_time_ms: '2500000', progress: 'continue' }).outTimeSec).toBe(2.5)
    expect(parseProgressBlock({ out_time_us: 'N/A', out_time: '00:01:02.250000', progress: 'continue' }).outTimeSec).toBe(62.25)
    expect(parseProgressBlock({ out_time_us: '-23000', progress: 'continue' }).outTimeSec).toBe(0)
    expect(parseProgressBlock({ out_time_us: 'N/A', out_time: 'N/A', fps: '0.00', speed: 'N/A', progress: 'continue' })).toEqual({
      outTimeSec: undefined, fps: undefined, speed: undefined, end: false,
    })
  })

  it('parseClock', () => {
    expect(parseClock('01:02:03.5')).toBe(3723.5)
    expect(parseClock('-00:00:00.023000')).toBeCloseTo(-0.023)
    expect(parseClock('garbage')).toBeUndefined()
  })

  it('progressFromSample: fraction, clamp, eta', () => {
    expect(progressFromSample({ outTimeSec: 2.5, end: false }, 10, 5)).toEqual({ fraction: 0.25, elapsedSec: 5, etaSec: 15 })
    expect(progressFromSample({ outTimeSec: 20, end: false }, 10, 5).fraction).toBe(1)
    expect(progressFromSample({ outTimeSec: 0.05, end: false }, 10, 1).etaSec).toBeUndefined()
    expect(progressFromSample({ outTimeSec: 5, end: false }, null, 1).fraction).toBe(0)
    expect(progressFromSample({ end: true }, null, 3)).toEqual({ fraction: 1, elapsedSec: 3, etaSec: 0 })
    // never moves backwards: out_time=N/A (e.g. during the +faststart rewrite) keeps the previous fraction
    expect(progressFromSample({ end: false }, 10, 4, 0.41).fraction).toBe(0.41)
    expect(progressFromSample({ outTimeSec: 1, end: false }, 10, 4, 0.41).fraction).toBe(0.41)
    expect(progressFromSample({ outTimeSec: 1, fps: 30, speed: 2, end: false }, 4, 1)).toMatchObject({ fps: 30, speed: 2 })
  })

  it('expectedDuration uses the trimmed length, clamped to the source', () => {
    expect(expectedDuration({ info: videoInfo({ durationSec: 10 }) })).toBe(10)
    expect(expectedDuration({ info: videoInfo({ durationSec: 10 }), trim: { inSec: 1, outSec: 2.5 } })).toBe(1.5)
    expect(expectedDuration({ info: videoInfo({ durationSec: 10 }), trim: { inSec: 8, outSec: 20 } })).toBe(2)
    expect(expectedDuration({ info: videoInfo({ durationSec: undefined }) })).toBeNull()
    expect(expectedDuration({ info: videoInfo({ durationSec: 10 }), trim: { inSec: 5, outSec: 5 } })).toBe(10)
  })
})

describe('log helpers', () => {
  it('LineSplitter handles \\r progress-style lines and partial chunks', () => {
    const s = new LineSplitter()
    expect(s.push('first li')).toEqual([])
    expect(s.push('ne\r\nsecond\rthird\n\nfou')).toEqual(['first line', 'second', 'third'])
    expect(s.flush()).toEqual(['fou'])
  })

  it('RingBuffer keeps the last N lines', () => {
    const r = new RingBuffer(3)
    for (const l of ['a', 'b', 'c', 'd', 'e']) r.push(l)
    expect(r.toArray()).toEqual(['c', 'd', 'e'])
  })

  it('stripLogPrefix removes nested component prefixes', () => {
    expect(stripLogPrefix('[vost#0:0/libx264 @ 000001] [enc:libx264 @ 0002] Error while opening encoder')).toBe('Error while opening encoder')
    expect(stripLogPrefix('plain line')).toBe('plain line')
  })

  it('pickErrorLine prefers the specific cause over generic summaries', () => {
    const amf = [
      '[AMF @ 000001c2875a0f40] DLL amfrt64.dll failed to open',
      '[h264_amf @ 000001c285a8ffc0] Failed to create  hardware device context (AMF) : Unknown error occurred',
      '[vost#0:0/h264_amf @ 000001c285ab1180] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height',
      '[vf#0:0 @ 0000] Error sending frames to consumers: Unknown error occurred',
      '[vf#0:0 @ 0000] Task finished with error code: -1 (Unknown error occurred)',
      'Conversion failed!',
    ]
    expect(pickErrorLine(amf, 1)).toBe('DLL amfrt64.dll failed to open')

    const missing = [
      '[in#0 @ 0000] Error opening input: No such file or directory',
      'Error opening input file C:\\nope.mp4.',
      'Error opening input files: No such file or directory',
    ]
    expect(pickErrorLine(missing, 2)).toBe('Error opening input: No such file or directory')

    expect(pickErrorLine(['Conversion failed!'], 1)).toBe('Conversion failed!')
    expect(pickErrorLine(['some warning', 'last line'], 1)).toBe('last line')
    expect(pickErrorLine([], 3)).toBe('ffmpeg exited with code 3')
  })
})

describe('capabilities parsing', () => {
  it('parses the encoder list (only the encoders we care about)', () => {
    const text = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)',
      ' V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)',
      ' VFS... prores_ks            Apple ProRes (iCodec Pro) (codec prores)',
      ' V..... mjpeg_qsv            MJPEG (Intel Quick Sync Video acceleration) (codec mjpeg)',
      ' A....D libopus              libopus Opus (codec opus)',
      ' A..X.D opus                 Opus',
    ].join('\r\n')
    expect(parseEncoderList(text)).toEqual(['libx264', 'h264_nvenc', 'h264_qsv', 'prores_ks', 'libopus'])
  })

  it('tests h264/hevc/av1 on every hw family plus prores_videotoolbox', () => {
    expect(HW_TEST_ENCODERS).toHaveLength(13)
    expect(HW_TEST_ENCODERS).toContain('av1_amf')
    expect(HW_TEST_ENCODERS).toContain('hevc_videotoolbox')
    expect(HW_TEST_ENCODERS).toContain('prores_videotoolbox')
  })

  it('parses the version', () => {
    expect(parseVersion('ffmpeg version 8.1.2-full_build-www.gyan.dev Copyright (c) 2000-2026')).toBe('8.1.2-full_build-www.gyan.dev')
    expect(parseVersion('nonsense')).toBe('')
  })
})

describe('probe mapping', () => {
  const base = (streams: FfprobeOutput['streams'], format: FfprobeOutput['format'] = {}): FfprobeOutput => ({
    streams,
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '3.000000', bit_rate: '2500000', size: '937500', ...format },
  })
  const v = { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001' }
  const a = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }

  it('maps a regular video', () => {
    const info = mapProbe(base([v, a]), 'C:/x/clip.mp4', 1234)
    expect(info).toMatchObject({
      kind: 'video', width: 1920, height: 1080, fps: 29.97, durationSec: 3, videoCodec: 'h264', audioCodec: 'aac',
      pixFmt: 'yuv420p', hasAlpha: false, hasAudio: true, audioChannels: 2, audioSampleRate: 48000, bitrateKbps: 2500,
      sizeBytes: 1234, rotation: 0,
    })
  })

  it('display-matrix rotation (counter-clockwise) swaps the displayed size', () => {
    const info = mapProbe(base([{ ...v, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, a]), 'p.mov', 1)
    expect(info).toMatchObject({ width: 1080, height: 1920, rotation: 90 })
    const ccw = mapProbe(base([{ ...v, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }]), 'p.mov', 1)
    expect(ccw).toMatchObject({ width: 1080, height: 1920, rotation: 270 })
    const flip = mapProbe(base([{ ...v, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] }]), 'p.mov', 1)
    expect(flip).toMatchObject({ width: 1920, height: 1080, rotation: 180 })
  })

  it('legacy rotate tag (clockwise)', () => {
    const info = mapProbe(base([{ ...v, tags: { rotate: '90' } }]), 'p.mp4', 1)
    expect(info).toMatchObject({ width: 1080, height: 1920, rotation: 90 })
    expect(streamRotation({ tags: { rotate: '-90' } })).toBe(270)
  })

  it('ignores cover art: an mp3 with a picture is audio', () => {
    const cover = { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }
    const info = mapProbe(base([{ ...a, codec_name: 'mp3' }, cover], { format_name: 'mp3' }), 'song.mp3', 1)
    expect(info.kind).toBe('audio')
    expect(info.width).toBeUndefined()
    expect(info.videoCodec).toBeUndefined()
  })

  it('fps falls back to r_frame_rate; duration falls back to the stream', () => {
    const info = mapProbe(base([{ ...v, avg_frame_rate: '0/0', r_frame_rate: '25/1', duration: '7.5' }], { duration: undefined }), 'x.mkv', 1)
    expect(info.fps).toBe(25)
    expect(info.durationSec).toBe(7.5)
  })

  it('alpha detection', () => {
    for (const f of ['yuva420p', 'yuva444p10le', 'rgba', 'bgra', 'argb', 'gbrap', 'ya8', 'rgba64le']) expect(pixFmtHasAlpha(f), f).toBe(true)
    for (const f of ['yuv420p', 'gray', 'pal8', 'nv12', 'yuv422p10le', 'gbrp', undefined]) expect(pixFmtHasAlpha(f), String(f)).toBe(false)
  })

  it('images still map to something sensible', () => {
    const png = { codec_type: 'video', codec_name: 'png', width: 200, height: 80, pix_fmt: 'rgba', avg_frame_rate: '0/0', r_frame_rate: '25/1' }
    const info = mapProbe({ streams: [png], format: { format_name: 'png_pipe' } }, 'logo.png', 10)
    expect(info).toMatchObject({ kind: 'image', width: 200, height: 80, hasAlpha: true, hasAudio: false })
  })

  it('throws when there is no audio or video stream', () => {
    expect(() => mapProbe({ streams: [{ codec_type: 'subtitle' }], format: {} }, 'subs.mkv', 1)).toThrow(/No audio or video stream/)
  })

  it('parseRate', () => {
    expect(parseRate('24000/1001')).toBe(23.976)
    expect(parseRate('0/0')).toBeUndefined()
    expect(parseRate('30')).toBe(30)
    expect(parseRate(undefined)).toBeUndefined()
  })
})

describe('frame args', () => {
  it('scale filter variants', () => {
    expect(frameScaleFilter({ maxWidth: 320 })).toBe("scale='min(iw,320)':-2:flags=bicubic")
    expect(frameScaleFilter({ width: 200, height: 100 })).toBe('scale=200:100:flags=bicubic')
    expect(frameScaleFilter({ width: 200 })).toBe('scale=200:-2:flags=bicubic')
    expect(frameScaleFilter({ height: 100 })).toBe('scale=-2:100:flags=bicubic')
    expect(frameScaleFilter({})).toBeNull()
  })

  it('jpeg vs png output to a pipe', () => {
    const j = frameArgs('C:/a b/測試.mov', 1.25, { maxWidth: 320 })
    expect(j.slice(j.indexOf('-ss'), j.indexOf('-ss') + 4)).toEqual(['-ss', '1.25', '-i', 'C:/a b/測試.mov'])
    expect(j).toContain('mjpeg')
    expect(j.slice(-3)).toEqual(['-f', 'image2pipe', 'pipe:1'])
    const p = frameArgs('x.mov', 0, { format: 'png' })
    expect(p).not.toContain('-ss')
    expect(p).toContain('png')
  })
})

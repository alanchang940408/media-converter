// MPG / WMV / AVI output: container rules, encoder options, DVD-Video, audio constraints (pure, no ffmpeg needed).
import { describe, expect, it } from 'vitest'
import {
  buildArgs,
  computeOutputSize,
  crfArgs,
  dvdAspect,
  dvdFilters,
  dvdOutputSize,
  dvdRateArgs,
  formatFilter,
  mpegFrameRate,
  muxerFor,
  muxerForSettings,
  outputExtension,
  qscaleFor,
  resolveVideoEncoder,
  sourceDisplayAspect,
  sourceSampleAspect,
  supportedAudioKbps,
  supportedSampleRate,
  type BuildRequest,
} from '../../src/main/ffmpeg/args'
import type { ProbedMediaInfo } from '../../src/main/ffmpeg/probe'
import { needsLegacyMjpeg } from '../../src/main/ffmpeg/runner'
import { EncodeError } from '../../src/main/contracts'
import { getBuiltinPreset } from '../../src/main/presets/builtin'
import type { VideoPreset, VideoPresetSettings } from '../../src/shared/types'
import {
  OUTPUT_CONTAINERS,
  allowedAudioCodecs,
  allowedVideoCodecs,
  defaultCodecsFor,
  dvdStandard,
  validateVideoSettings,
} from '../../src/shared/videoRules'
import { ALL_HW, fakeCaps, preset, val, vals, videoInfo } from './fixtures'

const DEST = 'C:/out/輸出 file.tmp'

function req(settings: VideoPresetSettings, o: Partial<BuildRequest> = {}): BuildRequest {
  return { source: 'C:/media/測試 影片.mov', info: videoInfo(), settings, dest: DEST, caps: fakeCaps(), preferredHw: 'auto', ...o }
}
const build = (settings: VideoPresetSettings, o: Partial<BuildRequest> = {}, legacyMjpeg = false) =>
  buildArgs(req(settings, o), { legacyMjpeg })
const vf = (args: string[]) => val(args, '-vf')

const mpg = (video: Partial<VideoPresetSettings['video']> = {}, audio: Partial<VideoPresetSettings['audio']> = {}) =>
  preset({ container: 'mpg', video: { codec: 'mpeg2', ...video }, audio: { codec: 'mp2', ...audio } })
const wmv = (video: Partial<VideoPresetSettings['video']> = {}, audio: Partial<VideoPresetSettings['audio']> = {}) =>
  preset({ container: 'wmv', video: { codec: 'wmv2', ...video }, audio: { codec: 'wmav2', ...audio } })
const avi = (video: Partial<VideoPresetSettings['video']> = {}, audio: Partial<VideoPresetSettings['audio']> = {}) =>
  preset({ container: 'avi', video: { codec: 'mpeg4', ...video }, audio: { codec: 'mp3', ...audio } })
const dvd = (std: 'ntsc' | 'pal', video: Partial<VideoPresetSettings['video']> = {}, audio: Partial<VideoPresetSettings['audio']> = {}) =>
  mpg({ profile: `dvd-${std}`, rate: { mode: 'vbr', bitrateKbps: 6000, maxKbps: 9000 }, ...video }, { codec: 'ac3', ...audio })
const builtin = (id: string): VideoPresetSettings => (getBuiltinPreset(id) as VideoPreset).settings

describe('container / codec rules', () => {
  it('allowed codecs per legacy container', () => {
    expect(allowedVideoCodecs('mpg')).toEqual(['mpeg2', 'mpeg1', 'copy'])
    expect(allowedAudioCodecs('mpg')).toEqual(['mp2', 'ac3', 'copy', 'none'])
    expect(allowedVideoCodecs('wmv')).toEqual(['wmv2', 'copy'])
    expect(allowedAudioCodecs('wmv')).toEqual(['wmav2', 'copy', 'none'])
    expect(allowedVideoCodecs('avi')).toEqual(['mpeg4', 'mjpeg', 'h264', 'copy'])
    expect(allowedAudioCodecs('avi')).toEqual(['mp3', 'ac3', 'pcm', 'copy', 'none'])
    // MPEG-2 and AC-3 are also offered in MKV, not in MOV / MP4
    expect(allowedVideoCodecs('mkv')).toContain('mpeg2')
    expect(allowedAudioCodecs('mkv')).toContain('ac3')
    expect(allowedVideoCodecs('mov')).not.toContain('mpeg2')
    expect(allowedVideoCodecs('mp4')).not.toContain('mpeg4')
    for (const c of ['mpeg2', 'mpeg1', 'mpeg4', 'wmv2', 'mjpeg'] as const) {
      expect(allowedVideoCodecs('mp4'), c).not.toContain(c)
      expect(allowedVideoCodecs('webm'), c).not.toContain(c)
    }
  })

  it('default codecs when switching container', () => {
    expect(defaultCodecsFor('mpg')).toEqual({ video: 'mpeg2', audio: 'mp2' })
    expect(defaultCodecsFor('wmv')).toEqual({ video: 'wmv2', audio: 'wmav2' })
    expect(defaultCodecsFor('avi')).toEqual({ video: 'mpeg4', audio: 'mp3' })
    for (const c of OUTPUT_CONTAINERS) {
      const d = defaultCodecsFor(c)
      expect(allowedVideoCodecs(c), c).toContain(d.video)
      expect(allowedAudioCodecs(c), c).toContain(d.audio)
    }
  })

  it('OUTPUT_CONTAINERS lists every container exactly once', () => {
    expect([...OUTPUT_CONTAINERS].sort()).toEqual(['avi', 'flac', 'gif', 'm4a', 'mkv', 'mov', 'mp3', 'mp4', 'mpg', 'ogg', 'wav', 'webm', 'wmv'])
  })

  it('validation: clean legacy settings have no issues', () => {
    expect(validateVideoSettings(mpg())).toEqual([])
    expect(validateVideoSettings(mpg({ codec: 'mpeg1' }))).toEqual([])
    expect(validateVideoSettings(wmv())).toEqual([])
    expect(validateVideoSettings(avi())).toEqual([])
    expect(validateVideoSettings(avi({ codec: 'mjpeg' }, { codec: 'pcm' }))).toEqual([])
    expect(validateVideoSettings(avi({ codec: 'h264' }))).toEqual([])
    expect(validateVideoSettings(dvd('ntsc'))).toEqual([])
    expect(validateVideoSettings(dvd('pal'))).toEqual([])
  })

  it('validation: hw on a legacy codec is a warning (CPU is used), hw auto is silent', () => {
    expect(validateVideoSettings(mpg({ hw: 'nvenc' }))).toEqual([
      { level: 'warning', code: 'hwNotSupportedForCodec', params: { hw: 'nvenc', codec: 'mpeg2' } },
    ])
    expect(validateVideoSettings(wmv({ hw: 'auto' }))).toEqual([])
  })

  it('validation: codec / container mismatches, profiles, DVD outside mpg', () => {
    expect(validateVideoSettings(preset({ container: 'mp4', video: { codec: 'wmv2' } })).map((i) => i.code)).toEqual(['videoCodecNotInContainer'])
    expect(validateVideoSettings(wmv({}, { codec: 'mp3' })).map((i) => i.code)).toEqual(['audioCodecNotInContainer'])
    expect(validateVideoSettings(mpg({ profile: 'dvd-secam' }))).toEqual([{ level: 'error', code: 'invalidProfile', params: { profile: 'dvd-secam' } }])
    expect(validateVideoSettings(preset({ container: 'mkv', video: { codec: 'mpeg2', profile: 'dvd-pal' } }))).toEqual([{ level: 'warning', code: 'dvdNeedsMpg' }])
    expect(validateVideoSettings(avi({ tenBit: true })).map((i) => i.code)).toEqual(['tenBitIgnored'])
    expect(validateVideoSettings(wmv({ rate: { mode: 'cbr', bitrateKbps: 0 } })).map((i) => i.code)).toEqual(['bitrateRequired'])
  })

  it('dvdStandard only for mpeg2 + DVD profile in mpg', () => {
    expect(dvdStandard(dvd('ntsc'))).toBe('ntsc')
    expect(dvdStandard(dvd('pal'))).toBe('pal')
    expect(dvdStandard(mpg())).toBeNull()
    expect(dvdStandard(mpg({ codec: 'mpeg1', profile: 'dvd-ntsc' }))).toBeNull()
    expect(dvdStandard(preset({ container: 'mkv', video: { codec: 'mpeg2', profile: 'dvd-ntsc' } }))).toBeNull()
  })
})

describe('extensions and muxers', () => {
  it('extension per container', () => {
    expect(outputExtension(mpg())).toBe('mpg')
    expect(outputExtension(wmv())).toBe('wmv')
    expect(outputExtension(avi())).toBe('avi')
  })

  it('mpg picks the program-stream flavour; wmv → asf; avi → avi', () => {
    expect(muxerFor('mpg')).toBe('mpeg')
    expect(muxerFor('wmv')).toBe('asf')
    expect(muxerFor('avi')).toBe('avi')
    expect(muxerForSettings(mpg())).toBe('vob')
    expect(muxerForSettings(mpg({ codec: 'mpeg1' }))).toBe('mpeg')
    expect(muxerForSettings(dvd('ntsc'))).toBe('dvd')
    expect(muxerForSettings(mpg({ codec: 'copy' }), { videoCodec: 'mpeg2video' })).toBe('vob')
    expect(muxerForSettings(mpg({ codec: 'copy' }), { videoCodec: 'mpeg1video' })).toBe('mpeg')
    expect(muxerForSettings(wmv())).toBe('asf')
    expect(muxerForSettings(avi())).toBe('avi')
    expect(muxerForSettings(preset({ container: 'mkv', video: { codec: 'mpeg2' } }))).toBe('matroska')
  })

  it('buildArgs ends with the explicit muxer and the destination', () => {
    const cases: Array<[VideoPresetSettings, string]> = [[mpg(), 'vob'], [mpg({ codec: 'mpeg1' }), 'mpeg'], [dvd('pal'), 'dvd'], [wmv(), 'asf'], [avi(), 'avi']]
    for (const [s, muxer] of cases) {
      const { args } = build(s)
      expect(args.slice(-3), muxer).toEqual(['-f', muxer, DEST])
    }
  })
})

describe('software-only legacy encoders', () => {
  it("hw 'auto' / explicit families resolve to the CPU encoder even when every GPU encoder works", () => {
    const caps = fakeCaps(ALL_HW)
    const sw = { mpeg2: 'mpeg2video', mpeg1: 'mpeg1video', mpeg4: 'mpeg4', wmv2: 'wmv2', mjpeg: 'mjpeg' } as const
    for (const [codec, enc] of Object.entries(sw)) {
      for (const hw of ['auto', 'none', 'nvenc', 'qsv', 'amf', 'videotoolbox'] as const) {
        for (const pref of ['auto', 'nvenc', 'none'] as const) {
          expect(resolveVideoEncoder(codec as keyof typeof sw, hw, pref, caps), `${codec}/${hw}/${pref}`).toEqual({ encoder: enc, family: null })
        }
      }
    }
    const { args, encoder } = build(builtin('wmv-720p'), { caps })
    expect(encoder).toBe('wmv2')
    expect(val(args, '-c:v')).toBe('wmv2')
  })
})

describe('rate control', () => {
  it('quality (CRF scale) → qscale', () => {
    expect([14, 18, 20, 23, 28, 35, 51, 0].map(qscaleFor)).toEqual([2, 2, 3, 4, 6, 14, 31, 2])
    for (const enc of ['mpeg1video', 'mpeg2video', 'mpeg4', 'wmv2', 'mjpeg']) expect(crfArgs(enc, 23), enc).toEqual(['-q:v', '4'])
  })

  it('crf mode emits -q:v only', () => {
    const { args } = build(avi({ rate: { mode: 'crf', crf: 20 } }))
    expect(val(args, '-q:v')).toBe('3')
    expect(args).not.toContain('-crf')
    expect(args).not.toContain('-b:v')
    expect(args).not.toContain('-bufsize')
  })

  it('bitrate modes for mpeg4 / wmv2 / mjpeg use the generic VBR / CBR flags', () => {
    const v = build(wmv({ rate: { mode: 'vbr', bitrateKbps: 4000 } })).args
    expect([val(v, '-b:v'), val(v, '-maxrate'), val(v, '-bufsize')]).toEqual(['4000k', '6000k', '8000k'])
    const c = build(avi({ codec: 'mjpeg', rate: { mode: 'cbr', bitrateKbps: 20000 } }, { codec: 'pcm' })).args
    expect([val(c, '-b:v'), val(c, '-minrate'), val(c, '-maxrate')]).toEqual(['20000k', '20000k', '20000k'])
    expect(c).not.toContain('-q:v')
  })

  it('MPEG-1/2 quality mode is capped at the level peak rate with a declared VBV buffer', () => {
    const hd = build(mpg({ rate: { mode: 'crf', crf: 20 } })).args // 1920×1080 source
    expect([val(hd, '-q:v'), val(hd, '-maxrate'), val(hd, '-bufsize')]).toEqual(['3', '80000k', '9781248'])
    expect(hd).not.toContain('-b:v')
    const sd = build(mpg({ codec: 'mpeg1', width: 640, rate: { mode: 'crf', crf: 23 } })).args
    expect([val(sd, '-q:v'), val(sd, '-maxrate'), val(sd, '-bufsize')]).toEqual(['4', '15000k', '1835008'])
  })

  it('MPEG-1/2 bitrate modes cap the VBV buffer (SD 224 KiB, HD MP@HL)', () => {
    const sd = build(mpg({ width: 720, height: 480, scaleMode: 'stretch', rate: { mode: 'vbr', bitrateKbps: 5000 } })).args
    expect(val(sd, '-bufsize')).toBe('1835008')
    const hd = build(mpg({ rate: { mode: 'vbr', bitrateKbps: 20000, maxKbps: 25000 } })).args // 1920×1080 source
    expect([val(hd, '-b:v'), val(hd, '-maxrate'), val(hd, '-bufsize')]).toEqual(['20000k', '25000k', '9781248'])
    const small = build(mpg({ codec: 'mpeg1', width: 352, height: 240, scaleMode: 'stretch', rate: { mode: 'cbr', bitrateKbps: 500 } })).args
    expect(val(small, '-bufsize')).toBe('1000000')
    expect(val(small, '-minrate')).toBe('500k')
  })
})

describe('encoder options per codec', () => {
  it('MPEG-2: B-frames, rd macroblock decision, yuv420p, vob muxer', () => {
    const { args, encoder } = build(mpg())
    expect(encoder).toBe('mpeg2video')
    expect(val(args, '-c:v')).toBe('mpeg2video')
    expect(val(args, '-bf')).toBe('2')
    expect(val(args, '-mbd')).toBe('rd')
    expect(args).not.toContain('-g')
    expect(args).not.toContain('-tag:v')
    expect(vf(args)).toBe('format=yuv420p')
    expect(val(args, '-c:a')).toBe('mp2')
    expect(val(args, '-b:a')).toBe('192k')
  })

  it('MPEG-4 in AVI: Xvid FourCC, long GOP, no B-frames', () => {
    const { args, encoder } = build(avi())
    expect(encoder).toBe('mpeg4')
    expect(val(args, '-tag:v')).toBe('XVID')
    expect(val(args, '-g')).toBe('250')
    expect(args).not.toContain('-bf')
    expect(val(args, '-c:a')).toBe('libmp3lame')
  })

  it('WMV2 in ASF with WMA 2 audio', () => {
    const { args } = build(wmv())
    expect(val(args, '-c:v')).toBe('wmv2')
    expect(val(args, '-g')).toBe('250')
    expect(args).not.toContain('-tag:v')
    expect(val(args, '-c:a')).toBe('wmav2')
    expect(val(args, '-b:a')).toBe('192k')
    expect(build(wmv({}, { bitrateKbps: null })).args).toContain('128k')
  })

  it('MJPEG: full-range 4:2:2 (yuv422p + colour range pc, not the deprecated yuvj422p), qscale, no speed options', () => {
    const s = avi({ codec: 'mjpeg', rate: { mode: 'crf', crf: 18 }, speed: 'quality' }, { codec: 'pcm' })
    const { args } = build(s)
    expect(vf(args)).toBe('format=pix_fmts=yuv422p:color_ranges=pc')
    expect(val(args, '-color_range')).toBe('pc')
    expect(args.join(' ')).not.toContain('yuvj')
    expect(val(args, '-q:v')).toBe('2')
    expect(args).not.toContain('-mbd')
    expect(args).not.toContain('-g')
    expect(val(args, '-c:a')).toBe('pcm_s16le')
    // the colour range also ends a watermark graph
    const wm = build(s, { overlay: { pngPath: 'logo.png', left: 4, top: 6 } }).args
    expect(val(wm, '-filter_complex')).toBe('[0:V:0][1:v:0]overlay=4:6:format=auto,format=pix_fmts=yuv422p:color_ranges=pc[vout]')
  })

  it('MJPEG legacy path (ffmpeg < 7.1): yuvj422p, no explicit colour range', () => {
    const s = avi({ codec: 'mjpeg', width: 1280 }, { codec: 'pcm' })
    const { args } = build(s, {}, true)
    expect(vf(args)).toBe('scale=1280:720:flags=lanczos,setsar=1,format=yuvj422p')
    expect(args).not.toContain('-color_range')
    // the switch only affects MJPEG
    expect(build(avi(), {}, true).args).toEqual(build(avi()).args)
    expect(formatFilter('mpeg4', 'yuv420p')).toBe('format=yuv420p')
    expect(formatFilter('mjpeg', 'yuv422p')).toBe('format=pix_fmts=yuv422p:color_ranges=pc')
    expect(formatFilter('mjpeg', 'yuvj422p', { legacyMjpeg: true })).toBe('format=yuvj422p')
  })

  it('falls back to the legacy MJPEG path only when the ffmpeg build lacks color_ranges', () => {
    // what ffmpeg 6.x / 7.0 print for the modern format filter
    const old = new EncodeError('Option not found', [
      "[Parsed_format_0 @ 000001] Option 'color_ranges' not found",
      "[AVFilterGraph @ 000002] Error initializing filter 'format' with args 'pix_fmts=yuv422p:color_ranges=pc'",
      'Error opening output files: Option not found',
    ], 1)
    expect(needsLegacyMjpeg('mjpeg', old)).toBe(true)
    expect(needsLegacyMjpeg('mpeg4', old)).toBe(false)
    expect(needsLegacyMjpeg('mjpeg', new EncodeError('No space left on device', ['av_interleaved_write_frame(): No space left on device'], 1))).toBe(false)
    expect(needsLegacyMjpeg('mjpeg', new Error('color_ranges'))).toBe(false)
  })

  it('H.264 in AVI keeps the regular x264 options', () => {
    const { args } = build(avi({ codec: 'h264', rate: { mode: 'crf', crf: 21 } }))
    expect(val(args, '-c:v')).toBe('libx264')
    expect(val(args, '-crf')).toBe('21')
    expect(args).not.toContain('-tag:v')
    expect(val(args, '-f')).toBe('avi')
  })

  it('speed maps to macroblock decision / trellis for mpegvideo encoders', () => {
    const sp = (speed: 'fast' | 'balanced' | 'quality') => build(mpg({ speed })).args
    expect(sp('fast')).not.toContain('-mbd')
    expect(val(sp('balanced'), '-mbd')).toBe('rd')
    expect(sp('balanced')).not.toContain('-trellis')
    const q = sp('quality')
    expect([val(q, '-mbd'), val(q, '-trellis'), val(q, '-cmp'), val(q, '-subcmp')]).toEqual(['rd', '1', '2', '2'])
    expect(build(wmv({ speed: 'quality' })).args).toContain('-trellis')
  })

  it('scaling keeps the usual filters (setsar after scale)', () => {
    const { args } = build(builtin('avi-xvid-720p'))
    expect(vf(args)).toBe('scale=1280:720:flags=lanczos,setsar=1,format=yuv420p')
    expect(computeOutputSize(videoInfo(), builtin('wmv-720p'))).toEqual({ width: 1280, height: 720 })
    expect(computeOutputSize(videoInfo(), builtin('avi-mjpeg'))).toEqual({ width: 1920, height: 1080 })
  })
})

describe('MPEG-1/2 frame rates', () => {
  it('snaps requested and non-standard source rates to standard MPEG rates', () => {
    expect(mpegFrameRate(29.97, 30)).toBe('30000/1001')
    expect(mpegFrameRate(23.976, null)).toBe('24000/1001')
    expect(mpegFrameRate(59.94, null)).toBe('60000/1001')
    expect(mpegFrameRate(25, 30)).toBe('25')
    expect(mpegFrameRate(null, 30)).toBeNull()
    expect(mpegFrameRate(null, 29.97)).toBeNull()
    expect(mpegFrameRate(null, 25)).toBeNull()
    expect(mpegFrameRate(null, 15)).toBe('24000/1001')
    expect(mpegFrameRate(null, 120)).toBe('60')
    expect(mpegFrameRate(null, 12.5)).toBe('24000/1001')
    expect(mpegFrameRate(null, undefined)).toBeNull()
  })

  it('lands in the filter chain for mpeg1/mpeg2 only', () => {
    const fifteen = videoInfo({ fps: 15 })
    expect(vf(build(mpg({ codec: 'mpeg1' }), { info: fifteen }).args)).toBe('fps=24000/1001,format=yuv420p')
    expect(vf(build(mpg({ fps: 29.97 })).args)).toBe('fps=30000/1001,format=yuv420p')
    expect(vf(build(mpg()).args)).toBe('format=yuv420p')
    // other codecs keep the plain fps value
    expect(vf(build(avi({ fps: 29.97 })).args)).toBe('fps=29.97,format=yuv420p')
    expect(vf(build(avi(), { info: fifteen }).args)).toBe('format=yuv420p')
  })
})

describe('DVD-Video', () => {
  it('NTSC: letterboxed 16:9 720×480 at 29.97 fps, DVD rate control, ac3 48 kHz, dvd muxer', () => {
    const { args, encoder } = build(dvd('ntsc'))
    expect(encoder).toBe('mpeg2video')
    expect(vf(args)).toBe(
      "scale=w='if(gte(dar,16/9),720,round(720*dar/(16/9)/2)*2)':h='if(gte(dar,16/9),round(480*(16/9)/dar/2)*2,480)':flags=lanczos," +
        'pad=720:480:(ow-iw)/2:(oh-ih)/2:black,setdar=16/9,fps=30000/1001,format=yuv420p',
    )
    expect(vf(args)).not.toContain('setsar')
    expect([val(args, '-b:v'), val(args, '-maxrate'), val(args, '-bufsize')]).toEqual(['6000k', '9000k', '1835008'])
    expect(val(args, '-g')).toBe('18')
    expect(val(args, '-bf')).toBe('2')
    expect([val(args, '-c:a'), val(args, '-b:a'), val(args, '-ar')]).toEqual(['ac3', '192k', '48000'])
    expect([val(args, '-packetsize'), val(args, '-muxrate')]).toEqual(['2048', '10080000'])
    expect(args.slice(-3)).toEqual(['-f', 'dvd', DEST])
  })

  it('PAL: 720×576 at 25 fps, GOP 15', () => {
    const { args } = build(dvd('pal'))
    expect(vf(args)).toContain('pad=720:576:')
    expect(vf(args)).toContain('fps=25,')
    expect(val(args, '-g')).toBe('15')
  })

  it('4:3-ish sources get a 4:3 frame; unknown size defaults to 16:9', () => {
    expect(dvdFilters({ width: 640, height: 480 }, 'ntsc')[2]).toBe('setdar=4/3')
    expect(dvdFilters({ width: 1080, height: 1920 }, 'pal')[2]).toBe('setdar=4/3')
    expect(dvdFilters({ width: 720, height: 480 }, 'ntsc')[2]).toBe('setdar=16/9') // 3:2 storage (likely anamorphic 16:9)
    expect(dvdFilters({}, 'ntsc')[2]).toBe('setdar=16/9')
  })

  it('frame size is the DVD standard whatever the width / height / fps fields say', () => {
    const odd = dvd('ntsc', { width: 1920, height: 1080, scaleMode: 'fit', noUpscale: true, fps: 60 })
    expect(computeOutputSize(videoInfo(), odd)).toEqual({ width: 720, height: 480, sar: 32 / 27 })
    expect(computeOutputSize(videoInfo({ width: 320, height: 240 }), dvd('pal'))).toEqual({ width: 720, height: 576, sar: 16 / 15 })
    expect(vf(build(odd).args)).toContain('fps=30000/1001')
    expect(vf(build(odd).args)).not.toContain('fps=60')
  })

  it('rate control stays within DVD limits', () => {
    expect(dvdRateArgs({ mode: 'crf', crf: 23 })).toEqual(['-b:v', '6000k', '-maxrate', '9000k', '-bufsize', '1835008'])
    expect(dvdRateArgs({ mode: 'crf', crf: 14 })).toEqual(['-b:v', '8000k', '-maxrate', '9000k', '-bufsize', '1835008'])
    expect(dvdRateArgs({ mode: 'crf', crf: 35 })).toEqual(['-b:v', '2000k', '-maxrate', '9000k', '-bufsize', '1835008'])
    expect(dvdRateArgs({ mode: 'vbr', bitrateKbps: 12000, maxKbps: 15000 })).toEqual(['-b:v', '9000k', '-maxrate', '9000k', '-bufsize', '1835008'])
    expect(dvdRateArgs({ mode: 'vbr', bitrateKbps: 5000 })).toEqual(['-b:v', '5000k', '-maxrate', '9000k', '-bufsize', '1835008'])
    expect(dvdRateArgs({ mode: 'cbr', bitrateKbps: 20000 })).toEqual(['-b:v', '9000k', '-minrate', '9000k', '-maxrate', '9000k', '-bufsize', '1835008'])
  })

  it('DVD audio: always 48 kHz, AC-3 ≤ 448 kbps, MP2 allowed', () => {
    const ac3 = build(dvd('ntsc', {}, { bitrateKbps: 640, sampleRate: 44100 })).args
    expect([val(ac3, '-b:a'), val(ac3, '-ar')]).toEqual(['448k', '48000'])
    const mp2 = build(dvd('pal', {}, { codec: 'mp2', bitrateKbps: 224 }), { info: videoInfo({ audioSampleRate: 44100 }) }).args
    expect([val(mp2, '-c:a'), val(mp2, '-b:a'), val(mp2, '-ar')]).toEqual(['mp2', '224k', '48000'])
  })

  it('pixel aspect: stored 720x480 / 720x576 displays at exactly 16:9 or 4:3', () => {
    const wide = videoInfo()
    const narrow = videoInfo({ width: 640, height: 480 })
    expect(dvdOutputSize(wide, 'ntsc')).toEqual({ width: 720, height: 480, sar: 32 / 27 })
    expect(dvdOutputSize(narrow, 'ntsc')).toEqual({ width: 720, height: 480, sar: 8 / 9 })
    expect(dvdOutputSize(wide, 'pal')).toEqual({ width: 720, height: 576, sar: 64 / 45 })
    expect(dvdOutputSize(narrow, 'pal')).toEqual({ width: 720, height: 576, sar: 16 / 15 })
    for (const [info, std, dar] of [[wide, 'ntsc', 16 / 9], [narrow, 'ntsc', 4 / 3], [wide, 'pal', 16 / 9], [narrow, 'pal', 4 / 3]] as const) {
      const o = dvdOutputSize(info, std)
      expect((o.width * o.sar) / o.height).toBeCloseTo(dar, 10)
    }
    // displayed widths the watermark is laid out on: 853.3 / 640 (NTSC), 1024 / 768 (PAL)
    expect(720 * (32 / 27)).toBeCloseTo(853.333, 3)
    expect(720 * (64 / 45)).toBeCloseTo(1024, 10)
    // non-DVD outputs keep square pixels (no sar field)
    expect(computeOutputSize(wide, mpg())).toEqual({ width: 1920, height: 1080 })
    expect(computeOutputSize(wide, builtin('avi-xvid-720p'))).toEqual({ width: 1280, height: 720 })
  })

  it('16:9 vs 4:3 follows the source displayed aspect, including its pixel aspect', () => {
    const anam = (o: Partial<ProbedMediaInfo>): ProbedMediaInfo => videoInfo(o)
    // DV NTSC 4:3 (720x480 at 8:9 = 640x480 shown): the 3:2 storage alone would pick 16:9
    const dv43 = anam({ width: 720, height: 480, sampleAspectRatio: 8 / 9 })
    expect(sourceDisplayAspect(dv43)).toBeCloseTo(4 / 3, 10)
    expect(dvdAspect(dv43)).toEqual([4, 3])
    expect(dvdFilters(dv43, 'ntsc')[2]).toBe('setdar=4/3')
    expect(computeOutputSize(dv43, dvd('ntsc'))).toEqual({ width: 720, height: 480, sar: 8 / 9 })
    // DV PAL 16:9 (720x576 at 64:45 = 1024x576 shown): the 5:4 storage alone would pick 4:3
    const dv169 = anam({ width: 720, height: 576, sampleAspectRatio: 64 / 45 })
    expect(dvdAspect(dv169)).toEqual([16, 9])
    expect(dvdFilters(dv169, 'pal')[2]).toBe('setdar=16/9')
    // HDV 1440x1080 at 4:3 = 1920x1080 shown
    const hdv = anam({ width: 1440, height: 1080, sampleAspectRatio: 4 / 3 })
    expect(dvdAspect(hdv)).toEqual([16, 9])
    expect(computeOutputSize(hdv, dvd('pal'))).toEqual({ width: 720, height: 576, sar: 64 / 45 })
    // the scale expression itself uses ffmpeg's own dar (which includes the sar)
    expect(build(dvd('ntsc'), { info: hdv }).args.join(' ')).toContain('setdar=16/9')
    expect(build(dvd('ntsc'), { info: dv43 }).args.join(' ')).toContain('setdar=4/3')
    // unknown / square / garbage pixel aspect = storage aspect
    expect(sourceSampleAspect(videoInfo())).toBe(1)
    expect(sourceSampleAspect(anam({ sampleAspectRatio: 0 }))).toBe(1)
    expect(sourceSampleAspect(anam({ sampleAspectRatio: Number.NaN }))).toBe(1)
    expect(sourceDisplayAspect({})).toBeNull()
    expect(dvdAspect({})).toEqual([16, 9])
  })

  it('watermark overlay keeps the DVD aspect flag', () => {
    const { args } = build(dvd('ntsc'), { overlay: { pngPath: 'logo.png', left: 10, top: 10 } })
    const graph = val(args, '-filter_complex')!
    expect(graph).toContain('setdar=16/9,fps=30000/1001[base];[base][1:v:0]overlay=10:10:format=auto,format=yuv420p[vout]')
  })
})

describe('legacy audio constraints', () => {
  it('bitrates snap to what MP2 / AC-3 accept', () => {
    expect(supportedAudioKbps('mp2', 200)).toBe(192)
    expect(supportedAudioKbps('mp2', 500)).toBe(384)
    expect(supportedAudioKbps('ac3', 200)).toBe(192)
    expect(supportedAudioKbps('ac3', 640)).toBe(640)
    expect(supportedAudioKbps('ac3', 640, true)).toBe(448)
    expect(supportedAudioKbps('wmav2', 150)).toBe(150)
    expect(val(build(mpg({}, { bitrateKbps: 200 })).args, '-b:a')).toBe('192k')
  })

  it('sample rates: MP2 / AC-3 at 48 / 44.1 / 32 kHz, WMA up to 48 kHz', () => {
    expect(supportedSampleRate('mp2', 22050)).toBe(32000)
    expect(supportedSampleRate('ac3', 96000)).toBe(48000)
    expect(supportedSampleRate('wmav2', 96000)).toBe(48000)
    expect(supportedSampleRate('wmav2', 22050)).toBe(22050)
    // sources the encoder can't take are resampled even when "keep source" is chosen
    expect(val(build(mpg(), { info: videoInfo({ audioSampleRate: 22050 }) }).args, '-ar')).toBe('32000')
    expect(val(build(wmv(), { info: videoInfo({ audioSampleRate: 96000 }) }).args, '-ar')).toBe('48000')
    expect(build(mpg(), { info: videoInfo({ audioSampleRate: 44100 }) }).args).not.toContain('-ar')
    expect(build(wmv(), { info: videoInfo({ audioSampleRate: 22050 }) }).args).not.toContain('-ar')
    expect(val(build(mpg({}, { sampleRate: 22050 })).args, '-ar')).toBe('32000')
  })

  it('MP2 / WMA downmix multichannel sources to stereo; AC-3 keeps 5.1; explicit channels win', () => {
    const six = videoInfo({ audioChannels: 6 })
    expect(val(build(mpg(), { info: six }).args, '-ac')).toBe('2')
    expect(val(build(wmv(), { info: six }).args, '-ac')).toBe('2')
    expect(build(mpg({}, { codec: 'ac3' }), { info: six }).args).not.toContain('-ac')
    expect(build(avi(), { info: six }).args).not.toContain('-ac')
    expect(vals(build(wmv({}, { channels: 1 }), { info: six }).args, '-ac')).toEqual(['1'])
    expect(build(wmv()).args).not.toContain('-ac')
  })
})

describe('built-in legacy presets', () => {
  const cases: Array<[string, string, string, string]> = [
    ['mpeg2-dvd-ntsc', 'mpeg2video', 'dvd', 'ac3'],
    ['mpeg2-dvd-pal', 'mpeg2video', 'dvd', 'ac3'],
    ['mpeg2-1080p', 'mpeg2video', 'vob', 'mp2'],
    ['wmv-720p', 'wmv2', 'asf', 'wmav2'],
    ['avi-xvid-720p', 'mpeg4', 'avi', 'libmp3lame'],
    ['avi-mjpeg', 'mjpeg', 'avi', 'pcm_s16le'],
  ]

  it('build with the expected encoder, muxer and audio codec, without validation issues', () => {
    for (const [id, enc, muxer, aenc] of cases) {
      const s = builtin(id)
      expect(validateVideoSettings(s), id).toEqual([])
      expect(s.video.hw, id).toBe('auto')
      const { args, encoder } = build(s, { caps: fakeCaps(ALL_HW) })
      expect(encoder, id).toBe(enc)
      expect(val(args, '-f'), id).toBe(muxer)
      expect(val(args, '-c:a'), id).toBe(aenc)
    }
  })

  it('DVD presets mirror the standard in their frame fields (so the UI size readout matches)', () => {
    expect(builtin('mpeg2-dvd-ntsc').video).toMatchObject({ codec: 'mpeg2', profile: 'dvd-ntsc', width: 720, height: 480, fps: 29.97, scaleMode: 'pad', noUpscale: false })
    expect(builtin('mpeg2-dvd-pal').video).toMatchObject({ codec: 'mpeg2', profile: 'dvd-pal', width: 720, height: 576, fps: 25 })
    expect(builtin('mpeg2-dvd-ntsc').audio).toMatchObject({ codec: 'ac3', sampleRate: 48000 })
    expect(builtin('avi-mjpeg').video).toMatchObject({ codec: 'mjpeg', width: null, height: null, rate: { mode: 'crf', crf: 18 } })
  })
})

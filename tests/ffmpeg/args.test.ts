import { describe, expect, it } from 'vitest'
import {
  buildArgs,
  computeOutputSize,
  crfArgs,
  hwFamilyOf,
  outputExtension,
  resolveVideoEncoder,
  type BuildRequest,
} from '../../src/main/ffmpeg/args'
import type { HwAccel, MediaInfo, OutputContainer, VideoCodecId, VideoPresetSettings } from '../../src/shared/types'
import { ALL_HW, audioInfo, fakeCaps, preset, val, vals, videoInfo } from './fixtures'

const DEST = 'C:/out/輸出 file.tmp'

function req(settings: VideoPresetSettings, o: Partial<BuildRequest> = {}): BuildRequest {
  return {
    source: 'C:/media/測試 影片.mov',
    info: videoInfo(),
    settings,
    dest: DEST,
    caps: fakeCaps(),
    preferredHw: 'auto',
    ...o,
  }
}

const build = (settings: VideoPresetSettings, o: Partial<BuildRequest> = {}) => buildArgs(req(settings, o))
const vf = (args: string[]) => val(args, '-vf')
const graph = (args: string[]) => val(args, '-filter_complex')

describe('outputExtension', () => {
  it('maps every container', () => {
    const map: Record<OutputContainer, string> = {
      mp4: 'mp4', mov: 'mov', mkv: 'mkv', webm: 'webm', gif: 'gif', mp3: 'mp3', m4a: 'm4a', wav: 'wav', flac: 'flac', ogg: 'ogg',
    }
    for (const [c, ext] of Object.entries(map)) expect(outputExtension(preset({ container: c as OutputContainer }))).toBe(ext)
  })
})

describe('buildArgs: global structure', () => {
  it('starts with the global options and ends with -f <muxer> <dest>', () => {
    const { args } = build(preset())
    expect(args.slice(0, 8)).toEqual(['-hide_banner', '-nostdin', '-y', '-v', 'warning', '-progress', 'pipe:1', '-nostats'])
    expect(args.slice(-3)).toEqual(['-f', 'mp4', DEST])
    expect(val(args, '-i')).toBe('C:/media/測試 影片.mov')
  })

  it('uses an explicit muxer for every container', () => {
    const cases: Array<[OutputContainer, VideoCodecId, VideoPresetSettings['audio']['codec'], string]> = [
      ['mp4', 'h264', 'aac', 'mp4'],
      ['mov', 'prores', 'pcm', 'mov'],
      ['mkv', 'h264', 'aac', 'matroska'],
      ['webm', 'vp9', 'opus', 'webm'],
      ['gif', 'gif', 'none', 'gif'],
      ['mp3', 'none', 'mp3', 'mp3'],
      ['m4a', 'none', 'aac', 'ipod'],
      ['wav', 'none', 'pcm', 'wav'],
      ['flac', 'none', 'flac', 'flac'],
      ['ogg', 'none', 'opus', 'ogg'],
    ]
    for (const [container, codec, audio, muxer] of cases) {
      const { args } = build(preset({ container, video: { codec }, audio: { codec: audio } }))
      expect(val(args, '-f'), container).toBe(muxer)
      expect(args[args.length - 1]).toBe(DEST)
    }
  })

  it('maps the first non-cover-art video stream and the optional first audio stream', () => {
    const { args } = build(preset())
    expect(vals(args, '-map')).toEqual(['0:V:0', '0:a:0?'])
  })

  it('metadata: copy by default, strip on request', () => {
    expect(val(build(preset()).args, '-map_metadata')).toBe('0')
    expect(val(build(preset({ stripMetadata: true })).args, '-map_metadata')).toBe('-1')
  })

  it('faststart only for mp4/mov/m4a', () => {
    expect(val(build(preset({ faststart: true })).args, '-movflags')).toBe('+faststart')
    expect(val(build(preset({ container: 'mov', faststart: true })).args, '-movflags')).toBe('+faststart')
    expect(val(build(preset({ container: 'm4a', faststart: true, video: { codec: 'none' }, audio: { codec: 'aac' } })).args, '-movflags')).toBe('+faststart')
    expect(build(preset({ container: 'mkv', faststart: true })).args).not.toContain('-movflags')
    expect(build(preset({ faststart: false })).args).not.toContain('-movflags')
  })
})

describe('encoder resolution', () => {
  const allWorking = fakeCaps(ALL_HW)
  const expected: Record<VideoCodecId, Record<string, string>> = {
    h264: { none: 'libx264', auto: 'h264_nvenc', nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', videotoolbox: 'h264_videotoolbox' },
    hevc: { none: 'libx265', auto: 'hevc_nvenc', nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', videotoolbox: 'hevc_videotoolbox' },
    av1: { none: 'libsvtav1', auto: 'av1_nvenc', nvenc: 'av1_nvenc', qsv: 'av1_qsv', amf: 'av1_amf', videotoolbox: 'libsvtav1' },
    vp9: { none: 'libvpx-vp9', auto: 'libvpx-vp9', nvenc: 'libvpx-vp9', qsv: 'libvpx-vp9', amf: 'libvpx-vp9', videotoolbox: 'libvpx-vp9' },
    prores: { none: 'prores_ks', auto: 'prores_videotoolbox', nvenc: 'prores_ks', qsv: 'prores_ks', amf: 'prores_ks', videotoolbox: 'prores_videotoolbox' },
    dnxhr: { none: 'dnxhd', auto: 'dnxhd', nvenc: 'dnxhd', qsv: 'dnxhd', amf: 'dnxhd', videotoolbox: 'dnxhd' },
    gif: { none: 'gif', auto: 'gif', nvenc: 'gif', qsv: 'gif', amf: 'gif', videotoolbox: 'gif' },
    copy: { none: 'copy', auto: 'copy', nvenc: 'copy', qsv: 'copy', amf: 'copy', videotoolbox: 'copy' },
    none: { none: 'none', auto: 'none', nvenc: 'none', qsv: 'none', amf: 'none', videotoolbox: 'none' },
  }

  it('every codec × hw choice with all hw encoders working', () => {
    for (const [codec, byHw] of Object.entries(expected)) {
      for (const [hw, enc] of Object.entries(byHw)) {
        expect(resolveVideoEncoder(codec as VideoCodecId, hw as HwAccel, 'auto', allWorking).encoder, `${codec}/${hw}`).toBe(enc)
      }
    }
  })

  it('every codec × hw choice with no working hw encoder falls back to software', () => {
    const none = fakeCaps([], [...ALL_HW, 'libx264', 'libx265', 'libsvtav1'])
    for (const hw of ['auto', 'nvenc', 'qsv', 'amf', 'videotoolbox'] as HwAccel[]) {
      expect(resolveVideoEncoder('h264', hw, 'auto', none).encoder).toBe('libx264')
      expect(resolveVideoEncoder('hevc', hw, 'auto', none).encoder).toBe('libx265')
      expect(resolveVideoEncoder('av1', hw, 'auto', none).encoder).toBe('libsvtav1')
      expect(resolveVideoEncoder('prores', hw, 'auto', none).encoder).toBe('prores_ks')
    }
  })

  it("hw 'auto' follows the global preference", () => {
    const caps = fakeCaps(['h264_nvenc', 'h264_qsv', 'hevc_qsv'])
    expect(resolveVideoEncoder('h264', 'auto', 'none', caps).encoder).toBe('libx264')
    expect(resolveVideoEncoder('h264', 'auto', 'qsv', caps).encoder).toBe('h264_qsv')
    expect(resolveVideoEncoder('h264', 'auto', 'amf', caps).encoder).toBe('libx264')
    expect(resolveVideoEncoder('h264', 'auto', 'auto', caps).encoder).toBe('h264_nvenc')
    // nvenc has no working hevc encoder here → next family in priority order
    expect(resolveVideoEncoder('hevc', 'auto', 'auto', caps).encoder).toBe('hevc_qsv')
    expect(resolveVideoEncoder('av1', 'auto', 'auto', caps).encoder).toBe('libsvtav1')
  })

  it('explicit family is used only when that encoder works', () => {
    const caps = fakeCaps(['h264_nvenc'])
    expect(resolveVideoEncoder('h264', 'nvenc', 'none', caps)).toEqual({ encoder: 'h264_nvenc', family: 'nvenc' })
    expect(resolveVideoEncoder('h264', 'qsv', 'auto', caps)).toEqual({ encoder: 'libx264', family: null })
    expect(resolveVideoEncoder('hevc', 'nvenc', 'auto', caps)).toEqual({ encoder: 'libx265', family: null })
  })

  it('av1 falls back to libaom-av1 when SVT-AV1 is not compiled', () => {
    const caps = fakeCaps([], ['libx264', 'libaom-av1'])
    expect(resolveVideoEncoder('av1', 'none', 'auto', caps).encoder).toBe('libaom-av1')
    const { args, encoder } = build(preset({ container: 'mkv', video: { codec: 'av1' } }), { caps })
    expect(encoder).toBe('libaom-av1')
    expect(val(args, '-c:v')).toBe('libaom-av1')
    expect(val(args, '-b:v')).toBe('0')
  })

  it('buildArgs for every codec × hw choice × caps (all working / none working)', () => {
    const containerFor: Record<string, OutputContainer> = { h264: 'mp4', hevc: 'mp4', av1: 'mkv', vp9: 'webm', prores: 'mov', dnxhr: 'mov', gif: 'gif', copy: 'mkv' }
    const audioFor: Record<string, VideoPresetSettings['audio']['codec']> = { webm: 'opus', mov: 'pcm', gif: 'none' }
    const noneWorking = fakeCaps([], [...ALL_HW, 'libx264', 'libx265', 'libsvtav1'])
    for (const [codec, byHw] of Object.entries(expected)) {
      if (codec === 'none') continue
      const container = containerFor[codec]
      for (const hw of Object.keys(byHw) as HwAccel[]) {
        const s = preset({ container, video: { codec: codec as VideoCodecId, hw }, audio: { codec: audioFor[container] ?? 'aac' } })
        const all = build(s, { caps: allWorking })
        expect(all.encoder, `${codec}/${hw}`).toBe(byHw[hw])
        expect(val(all.args, '-c:v'), `${codec}/${hw}`).toBe(byHw[hw])
        const sw = build(s, { caps: noneWorking })
        expect(hwFamilyOf(sw.encoder), `${codec}/${hw} sw`).toBeNull()
        expect(sw.args[sw.args.length - 1]).toBe(DEST)
      }
    }
  })

  it('buildArgs returns and uses the resolved encoder', () => {
    const { args, encoder } = build(preset({ video: { hw: 'nvenc' } }), { caps: fakeCaps(['h264_nvenc']) })
    expect(encoder).toBe('h264_nvenc')
    expect(val(args, '-c:v')).toBe('h264_nvenc')
  })
})

describe('rate control', () => {
  it('crf mapping per encoder', () => {
    expect(crfArgs('libx264', 23)).toEqual(['-crf', '23'])
    expect(crfArgs('libx265', 23)).toEqual(['-crf', '28'])
    expect(crfArgs('libsvtav1', 23)).toEqual(['-crf', '31'])
    expect(crfArgs('libaom-av1', 23)).toEqual(['-crf', '31', '-b:v', '0'])
    expect(crfArgs('libvpx-vp9', 23)).toEqual(['-crf', '31', '-b:v', '0'])
    expect(crfArgs('h264_nvenc', 23)).toEqual(['-rc', 'vbr', '-cq', '23', '-b:v', '0'])
    expect(crfArgs('hevc_nvenc', 23)).toEqual(['-rc', 'vbr', '-cq', '25', '-b:v', '0'])
    expect(crfArgs('av1_nvenc', 23)).toEqual(['-rc', 'vbr', '-cq', '31', '-b:v', '0'])
    expect(crfArgs('h264_qsv', 23)).toEqual(['-global_quality', '23'])
    expect(crfArgs('hevc_qsv', 23)).toEqual(['-global_quality', '23'])
    expect(crfArgs('h264_amf', 23)).toEqual(['-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-qp_b', '23'])
    expect(crfArgs('hevc_amf', 23)).toEqual(['-rc', 'cqp', '-qp_i', '23', '-qp_p', '23'])
    expect(crfArgs('av1_amf', 23)).toEqual(['-rc', 'cqp', '-qp_i', '124', '-qp_p', '124', '-qp_b', '124'])
    expect(crfArgs('h264_videotoolbox', 23)).toEqual(['-q:v', '63'])
  })

  it('crf values are clamped to each encoder range', () => {
    expect(crfArgs('libx264', 80)).toEqual(['-crf', '51'])
    expect(crfArgs('libx265', 50)).toEqual(['-crf', '51'])
    expect(crfArgs('libsvtav1', 0)).toEqual(['-crf', '1'])
    expect(crfArgs('libsvtav1', 51)).toEqual(['-crf', '63'])
    expect(crfArgs('libvpx-vp9', 60)).toEqual(['-crf', '59', '-b:v', '0'])
    expect(crfArgs('h264_nvenc', 0)).toEqual(['-rc', 'vbr', '-cq', '1', '-b:v', '0'])
    expect(crfArgs('h264_qsv', 0)).toEqual(['-global_quality', '1'])
    expect(crfArgs('h264_videotoolbox', 0)).toEqual(['-q:v', '100'])
  })

  it('crf args land in the command line', () => {
    const { args } = build(preset({ video: { codec: 'hevc', rate: { mode: 'crf', crf: 20 } } }))
    expect(val(args, '-crf')).toBe('25')
  })

  it('vbr: target, 1.5× maxrate by default, 2× bufsize', () => {
    const { args } = build(preset({ video: { rate: { mode: 'vbr', bitrateKbps: 4000 } } }))
    expect(val(args, '-b:v')).toBe('4000k')
    expect(val(args, '-maxrate')).toBe('6000k')
    expect(val(args, '-bufsize')).toBe('8000k')
    expect(args).not.toContain('-crf')
    const custom = build(preset({ video: { rate: { mode: 'vbr', bitrateKbps: 4000, maxKbps: 5000 } } })).args
    expect(val(custom, '-maxrate')).toBe('5000k')
  })

  it('cbr: bitrate = minrate = maxrate', () => {
    const { args } = build(preset({ video: { rate: { mode: 'cbr', bitrateKbps: 3000 } } }))
    expect(val(args, '-b:v')).toBe('3000k')
    expect(val(args, '-minrate')).toBe('3000k')
    expect(val(args, '-maxrate')).toBe('3000k')
    expect(val(args, '-bufsize')).toBe('6000k')
  })

  it('hardware rate-control modes', () => {
    const caps = fakeCaps(ALL_HW)
    const nvVbr = build(preset({ video: { hw: 'nvenc', rate: { mode: 'vbr', bitrateKbps: 4000 } } }), { caps }).args
    expect(val(nvVbr, '-rc')).toBe('vbr')
    expect(val(nvVbr, '-b:v')).toBe('4000k')
    const nvCbr = build(preset({ video: { hw: 'nvenc', rate: { mode: 'cbr', bitrateKbps: 4000 } } }), { caps }).args
    expect(val(nvCbr, '-rc')).toBe('cbr')
    const amfVbr = build(preset({ video: { hw: 'amf', rate: { mode: 'vbr', bitrateKbps: 4000 } } }), { caps }).args
    expect(val(amfVbr, '-rc')).toBe('vbr_peak')
    const amfCbr = build(preset({ video: { hw: 'amf', rate: { mode: 'cbr', bitrateKbps: 4000 } } }), { caps }).args
    expect(val(amfCbr, '-rc')).toBe('cbr')
    const qsvCrf = build(preset({ video: { hw: 'qsv', rate: { mode: 'crf', crf: 21 } } }), { caps }).args
    expect(val(qsvCrf, '-global_quality')).toBe('21')
    const vt = build(preset({ video: { hw: 'videotoolbox', rate: { mode: 'vbr', bitrateKbps: 4000 } } }), { caps }).args
    expect(val(vt, '-b:v')).toBe('4000k')
    expect(vt).not.toContain('-maxrate')
  })

  it('svt-av1 bitrate modes use plain -b:v (no maxrate / CBR support)', () => {
    for (const rate of [{ mode: 'vbr', bitrateKbps: 2000 }, { mode: 'cbr', bitrateKbps: 2000 }] as const) {
      const { args } = build(preset({ container: 'mkv', video: { codec: 'av1', rate } }))
      expect(val(args, '-b:v')).toBe('2000k')
      expect(args).not.toContain('-maxrate')
      expect(args).not.toContain('-minrate')
    }
  })

  it('vp9 crf uses -b:v 0, vbr uses maxrate', () => {
    const crf = build(preset({ container: 'webm', video: { codec: 'vp9' }, audio: { codec: 'opus' } })).args
    expect(val(crf, '-crf')).toBe('31')
    expect(val(crf, '-b:v')).toBe('0')
    const vbr = build(preset({ container: 'webm', video: { codec: 'vp9', rate: { mode: 'vbr', bitrateKbps: 1000 } }, audio: { codec: 'opus' } })).args
    expect(val(vbr, '-b:v')).toBe('1000k')
    expect(val(vbr, '-maxrate')).toBe('1500k')
  })

  it('prores / dnxhr / gif / copy ignore rate control', () => {
    const rate = { mode: 'vbr', bitrateKbps: 4000 } as const
    for (const [container, codec] of [['mov', 'prores'], ['mov', 'dnxhr'], ['gif', 'gif'], ['mp4', 'copy']] as const) {
      const { args } = build(preset({ container, video: { codec, rate }, audio: { codec: container === 'gif' ? 'none' : 'aac' } }))
      expect(args, codec).not.toContain('-b:v')
      expect(args, codec).not.toContain('-crf')
      expect(args, codec).not.toContain('-maxrate')
    }
  })
})

describe('speed presets', () => {
  const caps = fakeCaps(ALL_HW)
  const speedOf = (codec: VideoCodecId, hw: HwAccel, speed: 'fast' | 'balanced' | 'quality', container: OutputContainer = 'mkv') =>
    build(preset({ container, video: { codec, hw, speed } }), { caps, preferredHw: 'none' }).args

  it('x264 / x265', () => {
    expect(val(speedOf('h264', 'none', 'fast'), '-preset')).toBe('veryfast')
    expect(val(speedOf('h264', 'none', 'balanced'), '-preset')).toBe('medium')
    expect(val(speedOf('hevc', 'none', 'quality'), '-preset')).toBe('slow')
  })

  it('nvenc', () => {
    expect(val(speedOf('h264', 'nvenc', 'fast'), '-preset')).toBe('p2')
    expect(val(speedOf('h264', 'nvenc', 'balanced'), '-preset')).toBe('p4')
    expect(val(speedOf('hevc', 'nvenc', 'quality'), '-preset')).toBe('p6')
    expect(val(speedOf('h264', 'nvenc', 'fast'), '-tune')).toBe('hq')
  })

  it('qsv / amf', () => {
    expect(val(speedOf('h264', 'qsv', 'fast'), '-preset')).toBe('veryfast')
    expect(val(speedOf('h264', 'qsv', 'balanced'), '-preset')).toBe('medium')
    expect(val(speedOf('h264', 'qsv', 'quality'), '-preset')).toBe('slower')
    expect(val(speedOf('h264', 'amf', 'fast'), '-quality')).toBe('speed')
    expect(val(speedOf('h264', 'amf', 'balanced'), '-quality')).toBe('balanced')
    expect(val(speedOf('h264', 'amf', 'quality'), '-quality')).toBe('quality')
  })

  it('svt-av1 / vp9', () => {
    expect(val(speedOf('av1', 'none', 'fast'), '-preset')).toBe('10')
    expect(val(speedOf('av1', 'none', 'balanced'), '-preset')).toBe('8')
    expect(val(speedOf('av1', 'none', 'quality'), '-preset')).toBe('5')
    const vp9 = speedOf('vp9', 'none', 'fast', 'webm')
    expect(val(vp9, '-deadline')).toBe('good')
    expect(val(vp9, '-cpu-used')).toBe('5')
    expect(val(vp9, '-row-mt')).toBe('1')
    expect(val(speedOf('vp9', 'none', 'balanced', 'webm'), '-cpu-used')).toBe('2')
    expect(val(speedOf('vp9', 'none', 'quality', 'webm'), '-cpu-used')).toBe('1')
  })
})

describe('computeOutputSize', () => {
  const src = videoInfo({ width: 1920, height: 1080 })
  const size = (video: Partial<VideoPresetSettings['video']>, info: MediaInfo = src, container: OutputContainer = 'mp4') =>
    computeOutputSize(info, preset({ container, video }))

  it('keeps the source size when nothing is set', () => {
    expect(size({})).toEqual({ width: 1920, height: 1080 })
  })

  it('one side set → other follows aspect', () => {
    expect(size({ width: 1280 })).toEqual({ width: 1280, height: 720 })
    expect(size({ height: 720 })).toEqual({ width: 1280, height: 720 })
    expect(size({ width: 1000 })).toEqual({ width: 1000, height: 562 })
  })

  it('every scale mode into 1080×1920', () => {
    expect(size({ width: 1080, height: 1920, scaleMode: 'fit' })).toEqual({ width: 1080, height: 608 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'pad' })).toEqual({ width: 1080, height: 1920 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'crop' })).toEqual({ width: 1080, height: 1920 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'stretch' })).toEqual({ width: 1080, height: 1920 })
  })

  it('rounds odd values to even numbers ≥ 2', () => {
    expect(size({ width: 1001, height: 501, scaleMode: 'stretch' })).toEqual({ width: 1002, height: 502 })
    expect(size({ width: 1 })).toEqual({ width: 2, height: 2 })
    const odd = videoInfo({ width: 1281, height: 721 })
    expect(size({}, odd)).toEqual({ width: 1280, height: 720 })
  })

  it('noUpscale', () => {
    const small = videoInfo({ width: 640, height: 360 })
    expect(size({ width: 1920, noUpscale: true }, small)).toEqual({ width: 640, height: 360 })
    expect(size({ width: 1920, noUpscale: false }, small)).toEqual({ width: 1920, height: 1080 })
    expect(size({ width: 1920, height: 1080, scaleMode: 'fit', noUpscale: true }, small)).toEqual({ width: 640, height: 360 })
    // pad/crop/stretch keep the requested aspect but shrink the box so the content stays at 100 %
    expect(size({ width: 1080, height: 1920, scaleMode: 'pad', noUpscale: true }, small)).toEqual({ width: 640, height: 1138 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'crop', noUpscale: true }, small)).toEqual({ width: 202, height: 360 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'stretch', noUpscale: true }, small)).toEqual({ width: 202, height: 360 })
    // downscaling is unaffected
    expect(size({ width: 1280, noUpscale: true })).toEqual({ width: 1280, height: 720 })
    expect(size({ width: 1080, height: 1920, scaleMode: 'pad', noUpscale: true })).toEqual({ width: 1080, height: 1920 })
  })

  it('rotated sources use the displayed size', () => {
    const portrait = videoInfo({ width: 1080, height: 1920, rotation: 90 })
    expect(size({ width: 540 }, portrait)).toEqual({ width: 540, height: 960 })
    expect(size({ width: 1920, height: 1080, scaleMode: 'fit' }, portrait)).toEqual({ width: 608, height: 1080 })
  })

  it('gif uses gif.width and keeps aspect', () => {
    const gif = { fps: 12, width: 480, colors: 256, dither: 'bayer' as const, loop: 0 }
    expect(size({ codec: 'gif', gif }, src, 'gif')).toEqual({ width: 480, height: 270 })
    expect(size({ codec: 'gif', gif: { ...gif, width: null } }, src, 'gif')).toEqual({ width: 1920, height: 1080 })
    // the generic width/height are ignored for gif
    expect(size({ codec: 'gif', gif, width: 100, height: 100 }, src, 'gif')).toEqual({ width: 480, height: 270 })
  })

  it('null when the output has no video', () => {
    expect(size({ codec: 'none' }, src, 'mp3')).toBeNull()
    expect(size({ codec: 'none' }, src, 'mp4')).toBeNull()
    expect(size({}, audioInfo())).toBeNull()
  })

  it('copy returns the source size', () => {
    expect(size({ codec: 'copy', width: 640 })).toEqual({ width: 1920, height: 1080 })
  })

  it('unknown source size: only a fixed box is predictable', () => {
    const unknown = videoInfo({ width: undefined, height: undefined })
    expect(size({ width: 1080, height: 1920, scaleMode: 'pad' }, unknown)).toEqual({ width: 1080, height: 1920 })
    expect(size({ width: 1280 }, unknown)).toBeNull()
  })
})

describe('filters', () => {
  it('no scale filter when the size does not change', () => {
    const { args } = build(preset())
    expect(vf(args)).toBe('format=yuv420p')
    expect(args).not.toContain('-filter_complex')
  })

  it('fit', () => {
    const { args } = build(preset({ video: { width: 1080, height: 1920, scaleMode: 'fit' } }))
    expect(vf(args)).toBe('scale=1080:608:flags=lanczos,setsar=1,format=yuv420p')
  })

  it('pad', () => {
    const { args } = build(preset({ video: { width: 1080, height: 1920, scaleMode: 'pad' } }))
    expect(vf(args)).toBe(
      'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p',
    )
  })

  it('crop', () => {
    const { args } = build(preset({ video: { width: 1080, height: 1920, scaleMode: 'crop' } }))
    expect(vf(args)).toBe('scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos,crop=1080:1920,setsar=1,format=yuv420p')
  })

  it('stretch', () => {
    const { args } = build(preset({ video: { width: 1080, height: 1920, scaleMode: 'stretch' } }))
    expect(vf(args)).toBe('scale=1080:1920:flags=lanczos,setsar=1,format=yuv420p')
  })

  it('pad with noUpscale keeps the content at 100 %', () => {
    const { args } = build(preset({ video: { width: 1080, height: 1920, scaleMode: 'pad', noUpscale: true } }), {
      info: videoInfo({ width: 640, height: 360 }),
    })
    expect(vf(args)).toContain('pad=640:1138:')
  })

  it('noUpscale suppresses the scale filter entirely when the source is smaller', () => {
    const { args } = build(preset({ video: { width: 3840, noUpscale: true } }))
    expect(vf(args)).toBe('format=yuv420p')
  })

  it('fps', () => {
    expect(vf(build(preset({ video: { fps: 24 } })).args)).toBe('fps=24,format=yuv420p')
    expect(vf(build(preset({ video: { fps: 25, width: 1280 } })).args)).toBe('scale=1280:720:flags=lanczos,fps=25,setsar=1,format=yuv420p')
  })

  it('unknown source size uses ffmpeg-side expressions', () => {
    const info = videoInfo({ width: undefined, height: undefined })
    expect(vf(build(preset({ video: { width: 1280 } }), { info }).args)).toBe('scale=1280:-2:flags=lanczos,setsar=1,format=yuv420p')
    expect(vf(build(preset({ video: { width: 1280, height: 720, scaleMode: 'fit' } }), { info }).args)).toContain('force_original_aspect_ratio=decrease')
  })

  it('overlay uses -filter_complex after scaling', () => {
    const overlay = { pngPath: 'C:/tmp/水印 logo.png', left: 20.4, top: 30 }
    const { args } = build(preset({ video: { width: 1280 } }), { overlay })
    expect(vals(args, '-i')).toEqual(['C:/media/測試 影片.mov', 'C:/tmp/水印 logo.png'])
    expect(graph(args)).toBe('[0:V:0]scale=1280:720:flags=lanczos,setsar=1[base];[base][1:v:0]overlay=20:30:format=auto,format=yuv420p[vout]')
    expect(vals(args, '-map')).toEqual(['[vout]', '0:a:0?'])
    expect(args).not.toContain('-vf')
  })

  it('overlay without scaling', () => {
    const { args } = build(preset(), { overlay: { pngPath: 'logo.png', left: 0, top: 0 } })
    expect(graph(args)).toBe('[0:V:0][1:v:0]overlay=0:0:format=auto,format=yuv420p[vout]')
  })

  it('overlay is ignored for copy and audio-only outputs', () => {
    const overlay = { pngPath: 'logo.png', left: 0, top: 0 }
    const copy = build(preset({ video: { codec: 'copy' } }), { overlay }).args
    expect(vals(copy, '-i')).toHaveLength(1)
    const mp3 = build(preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3' } }), { overlay }).args
    expect(vals(mp3, '-i')).toHaveLength(1)
  })
})

describe('trim', () => {
  it('input seek + output duration', () => {
    const { args } = build(preset(), { trim: { inSec: 1, outSec: 2.5 } })
    const ss = args.indexOf('-ss')
    const i = args.indexOf('-i')
    expect(ss).toBeGreaterThan(-1)
    expect(ss).toBeLessThan(i)
    expect(args[ss + 1]).toBe('1')
    const t = args.indexOf('-t')
    expect(t).toBeGreaterThan(i)
    expect(args[t + 1]).toBe('1.5')
  })

  it('trim from 0 has no -ss', () => {
    const { args } = build(preset(), { trim: { inSec: 0, outSec: 4.25 } })
    expect(args).not.toContain('-ss')
    expect(val(args, '-t')).toBe('4.25')
  })

  it('invalid trim is ignored', () => {
    const { args } = build(preset(), { trim: { inSec: 3, outSec: 2 } })
    expect(args).not.toContain('-ss')
    expect(args).not.toContain('-t')
  })

  it('trim works with overlay (seek only applies to the source)', () => {
    const { args } = build(preset(), { trim: { inSec: 2, outSec: 3 }, overlay: { pngPath: 'logo.png', left: 1, top: 1 } })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args.lastIndexOf('-i')).toBeLessThan(args.indexOf('-t'))
  })
})

describe('gif', () => {
  const gif = { fps: 12, width: 480, colors: 128, dither: 'bayer' as const, loop: 0 }

  it('single palette graph', () => {
    const { args, encoder } = build(preset({ container: 'gif', video: { codec: 'gif', gif }, audio: { codec: 'none' } }))
    expect(encoder).toBe('gif')
    expect(graph(args)).toBe(
      '[0:V:0]scale=480:270:flags=lanczos,fps=12,setsar=1,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[vout]',
    )
    expect(vals(args, '-map')).toEqual(['[vout]'])
    expect(val(args, '-c:v')).toBe('gif')
    expect(val(args, '-loop')).toBe('0')
    expect(val(args, '-f')).toBe('gif')
    expect(args).toContain('-an')
  })

  it('other dithers, loop, colour clamp, source width', () => {
    const { args } = build(
      preset({ container: 'gif', video: { codec: 'gif', gif: { fps: 10, width: null, colors: 2, dither: 'floyd_steinberg', loop: -1 } }, audio: { codec: 'aac' } }),
    )
    expect(graph(args)).toBe('[0:V:0]fps=10,split[a][b];[a]palettegen=max_colors=4:stats_mode=diff[p];[b][p]paletteuse=dither=floyd_steinberg[vout]')
    expect(val(args, '-loop')).toBe('-1')
    expect(args).toContain('-an')
    expect(vals(args, '-map')).toEqual(['[vout]'])
  })

  it('gif with overlay', () => {
    const { args } = build(preset({ container: 'gif', video: { codec: 'gif', gif }, audio: { codec: 'none' } }), {
      overlay: { pngPath: 'logo.png', left: 5, top: 6 },
    })
    expect(graph(args)).toBe(
      '[0:V:0]scale=480:270:flags=lanczos,fps=12,setsar=1[base];[base][1:v:0]overlay=5:6:format=auto,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[vout]',
    )
  })

  it('gif from an audio file throws', () => {
    expect(() => build(preset({ container: 'gif', video: { codec: 'gif', gif }, audio: { codec: 'none' } }), { info: audioInfo() })).toThrow(/GIF/)
  })
})

describe('audio', () => {
  it('audio-only containers', () => {
    const cases: Array<[OutputContainer, VideoPresetSettings['audio']['codec'], string, string]> = [
      ['mp3', 'mp3', 'libmp3lame', 'mp3'],
      ['m4a', 'aac', 'aac', 'ipod'],
      ['wav', 'pcm', 'pcm_s16le', 'wav'],
      ['flac', 'flac', 'flac', 'flac'],
      ['ogg', 'opus', 'libopus', 'ogg'],
    ]
    for (const [container, codec, enc, muxer] of cases) {
      const { args, encoder } = build(preset({ container, video: { codec: 'none' }, audio: { codec, bitrateKbps: null } }))
      expect(encoder, container).toBe(enc)
      expect(val(args, '-c:a')).toBe(enc)
      expect(args).toContain('-vn')
      expect(vals(args, '-map')).toEqual(['0:a:0?'])
      expect(args).not.toContain('-c:v')
      expect(args).not.toContain('-vf')
      expect(val(args, '-f')).toBe(muxer)
    }
  })

  it('default and explicit bitrates', () => {
    expect(val(build(preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3', bitrateKbps: null } })).args, '-b:a')).toBe('192k')
    expect(val(build(preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3', bitrateKbps: 320 } })).args, '-b:a')).toBe('320k')
    expect(val(build(preset({ container: 'ogg', video: { codec: 'none' }, audio: { codec: 'opus', bitrateKbps: null } })).args, '-b:a')).toBe('128k')
    expect(build(preset({ container: 'flac', video: { codec: 'none' }, audio: { codec: 'flac', bitrateKbps: 999 } })).args).not.toContain('-b:a')
  })

  it('pcm follows the source bit depth', () => {
    const wav = preset({ container: 'wav', video: { codec: 'none' }, audio: { codec: 'pcm' } })
    expect(build(wav, { info: audioInfo({ audioCodec: 'pcm_s24le' }) }).encoder).toBe('pcm_s24le')
    expect(build(wav, { info: audioInfo({ audioCodec: 'pcm_f32le' }) }).encoder).toBe('pcm_s24le')
    expect(build(wav, { info: audioInfo({ audioCodec: 'pcm_s16le' }) }).encoder).toBe('pcm_s16le')
    expect(build(wav, { info: audioInfo({ audioCodec: 'mp3' }) }).encoder).toBe('pcm_s16le')
    // 24-bit FLAC/ALAC sources keep their depth via audioBitDepth
    expect(build(wav, { info: audioInfo({ audioCodec: 'flac', audioBitDepth: 24 }) }).encoder).toBe('pcm_s24le')
    expect(build(wav, { info: audioInfo({ audioCodec: 'flac', audioBitDepth: 16 }) }).encoder).toBe('pcm_s16le')
  })

  it('audio source into mp4 makes an audio-only file', () => {
    const { args, encoder } = build(preset(), { info: audioInfo() })
    expect(encoder).toBe('aac')
    expect(args).toContain('-vn')
    expect(vals(args, '-map')).toEqual(['0:a:0?'])
    expect(args).not.toContain('-c:v')
    expect(val(args, '-f')).toBe('mp4')
  })

  it('audio-only output from a source without audio throws', () => {
    const silent = videoInfo({ hasAudio: false, audioCodec: undefined })
    expect(() => build(preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3' } }), { info: silent })).toThrow(/no audio/)
  })

  it('video source without audio → -an, no audio map', () => {
    const { args } = build(preset(), { info: videoInfo({ hasAudio: false }) })
    expect(args).toContain('-an')
    expect(vals(args, '-map')).toEqual(['0:V:0'])
  })

  it('audio none → -an', () => {
    const { args } = build(preset({ audio: { codec: 'none' } }))
    expect(args).toContain('-an')
    expect(vals(args, '-map')).toEqual(['0:V:0'])
  })

  it('sample rate / channels / normalize', () => {
    const a = build(preset({ audio: { codec: 'aac', sampleRate: 44100, channels: 1 } })).args
    expect(val(a, '-ar')).toBe('44100')
    expect(val(a, '-ac')).toBe('1')
    const n = build(preset({ audio: { codec: 'aac', normalize: true } })).args
    expect(val(n, '-af')).toBe('loudnorm=I=-16:TP=-1.5:LRA=11')
    expect(val(n, '-ar')).toBe('48000') // loudnorm would otherwise output 192 kHz
    const none = build(preset()).args
    expect(none).not.toContain('-ar')
    expect(none).not.toContain('-ac')
    expect(none).not.toContain('-af')
  })

  it('sample rates are clamped to what the encoder supports', () => {
    const opus = build(preset({ container: 'webm', video: { codec: 'vp9' }, audio: { codec: 'opus', sampleRate: 44100 } })).args
    expect(val(opus, '-ar')).toBe('48000')
    const mp3 = build(preset({ container: 'mp3', video: { codec: 'none' }, audio: { codec: 'mp3', normalize: true } }), {
      info: audioInfo({ audioSampleRate: 96000 }),
    }).args
    expect(val(mp3, '-ar')).toBe('48000')
  })

  it('audio copy', () => {
    const { args } = build(preset({ audio: { codec: 'copy', normalize: true, sampleRate: 44100 } }))
    expect(val(args, '-c:a')).toBe('copy')
    expect(args).not.toContain('-af')
    expect(args).not.toContain('-ar')
  })
})

describe('copy', () => {
  it('stream copy has no filters or encoder options', () => {
    const { args, encoder } = build(preset({ video: { codec: 'copy', width: 640, fps: 24, hw: 'nvenc' }, audio: { codec: 'copy' } }), {
      caps: fakeCaps(ALL_HW),
    })
    expect(encoder).toBe('copy')
    expect(val(args, '-c:v')).toBe('copy')
    expect(val(args, '-c:a')).toBe('copy')
    expect(args).not.toContain('-vf')
    expect(args).not.toContain('-filter_complex')
    expect(args).not.toContain('-preset')
    expect(vals(args, '-map')).toEqual(['0:V:0', '0:a:0?'])
  })

  it('copy with trim', () => {
    const { args } = build(preset({ video: { codec: 'copy' } }), { trim: { inSec: 1, outSec: 2 } })
    expect(val(args, '-ss')).toBe('1')
    expect(val(args, '-t')).toBe('1')
  })
})

describe('pixel formats and profiles', () => {
  const caps = fakeCaps(ALL_HW)
  const pix = (args: string[]) => (vf(args) ?? graph(args) ?? '').match(/format=([a-z0-9]+)(?!.*format=)/)?.[1]

  it('8-bit defaults', () => {
    expect(pix(build(preset()).args)).toBe('yuv420p')
    expect(pix(build(preset({ video: { hw: 'qsv' } }), { caps }).args)).toBe('nv12')
    expect(pix(build(preset({ video: { hw: 'nvenc' } }), { caps }).args)).toBe('yuv420p')
  })

  it('tenBit for hevc / av1 / vp9', () => {
    expect(pix(build(preset({ video: { codec: 'hevc', tenBit: true } })).args)).toBe('yuv420p10le')
    expect(pix(build(preset({ container: 'mkv', video: { codec: 'av1', tenBit: true } })).args)).toBe('yuv420p10le')
    expect(pix(build(preset({ container: 'webm', video: { codec: 'vp9', tenBit: true }, audio: { codec: 'opus' } })).args)).toBe('yuv420p10le')
    const nv = build(preset({ video: { codec: 'hevc', hw: 'nvenc', tenBit: true } }), { caps }).args
    expect(pix(nv)).toBe('p010le')
    expect(val(nv, '-profile:v')).toBe('main10')
    expect(pix(build(preset({ video: { codec: 'hevc', hw: 'qsv', tenBit: true } }), { caps }).args)).toBe('p010le')
    expect(pix(build(preset({ container: 'mkv', video: { codec: 'av1', hw: 'nvenc', tenBit: true } }), { caps }).args)).toBe('p010le')
  })

  it('tenBit is ignored for h264', () => {
    expect(pix(build(preset({ video: { tenBit: true } })).args)).toBe('yuv420p')
  })

  it('h264 profile', () => {
    expect(val(build(preset({ video: { profile: 'high' } })).args, '-profile:v')).toBe('high')
    expect(val(build(preset({ video: { profile: 'baseline', hw: 'amf' } }), { caps }).args, '-profile:v')).toBe('constrained_baseline')
    expect(build(preset({ video: { profile: 'bogus' } })).args).not.toContain('-profile:v')
  })

  it('hevc in mp4/mov gets the hvc1 tag and quiet x265 logging', () => {
    const mp4 = build(preset({ video: { codec: 'hevc' } })).args
    expect(val(mp4, '-tag:v')).toBe('hvc1')
    expect(val(mp4, '-x265-params')).toBe('log-level=error')
    expect(val(build(preset({ container: 'mov', video: { codec: 'hevc', hw: 'nvenc' } }), { caps }).args, '-tag:v')).toBe('hvc1')
    expect(build(preset({ container: 'mkv', video: { codec: 'hevc' } })).args).not.toContain('-tag:v')
  })

  it('prores_ks profiles', () => {
    const cases: Array<[string | null, string, string]> = [
      ['proxy', '0', 'yuv422p10le'],
      ['lt', '1', 'yuv422p10le'],
      ['standard', '2', 'yuv422p10le'],
      ['hq', '3', 'yuv422p10le'],
      ['4444', '4', 'yuv444p10le'],
      ['4444xq', '5', 'yuv444p10le'],
      [null, '2', 'yuv422p10le'],
    ]
    for (const [profile, idx, fmt] of cases) {
      const { args, encoder } = build(preset({ container: 'mov', video: { codec: 'prores', profile }, audio: { codec: 'pcm' } }))
      expect(encoder).toBe('prores_ks')
      expect(val(args, '-profile:v'), String(profile)).toBe(idx)
      expect(val(args, '-vendor')).toBe('apl0')
      expect(pix(args), String(profile)).toBe(fmt)
    }
  })

  it('prores 4444 keeps alpha when the source has it', () => {
    const s = preset({ container: 'mov', video: { codec: 'prores', profile: '4444' }, audio: { codec: 'pcm' } })
    expect(pix(build(s, { info: videoInfo({ hasAlpha: true, pixFmt: 'yuva444p10le' }) }).args)).toBe('yuva444p10le')
    const hq = preset({ container: 'mov', video: { codec: 'prores', profile: 'hq' }, audio: { codec: 'pcm' } })
    expect(pix(build(hq, { info: videoInfo({ hasAlpha: true }) }).args)).toBe('yuv422p10le')
  })

  it('dnxhr profiles', () => {
    const cases: Array<[string | null, string, string]> = [
      ['lb', 'dnxhr_lb', 'yuv422p'],
      ['sq', 'dnxhr_sq', 'yuv422p'],
      ['hq', 'dnxhr_hq', 'yuv422p'],
      ['hqx', 'dnxhr_hqx', 'yuv422p10le'],
      ['444', 'dnxhr_444', 'yuv444p10le'],
      [null, 'dnxhr_hq', 'yuv422p'],
    ]
    for (const [profile, name, fmt] of cases) {
      const { args, encoder } = build(preset({ container: 'mov', video: { codec: 'dnxhr', profile }, audio: { codec: 'pcm' } }))
      expect(encoder).toBe('dnxhd')
      expect(val(args, '-profile:v')).toBe(name)
      expect(pix(args)).toBe(fmt)
    }
  })

  it('pcm audio in mov', () => {
    const { args } = build(preset({ container: 'mov', video: { codec: 'prores' }, audio: { codec: 'pcm' } }))
    expect(val(args, '-c:a')).toBe('pcm_s16le')
  })
})

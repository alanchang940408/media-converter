// Non-square-pixel (anamorphic) sources: MediaInfo carries the displayed size, square-pixel outputs are laid out on it.
import { describe, expect, it } from 'vitest'
import { buildArgs, computeOutputSize, dvdAspect, scaleFilters, type BuildRequest } from '../../src/main/ffmpeg/args'
import { mapProbe, type FfprobeOutput } from '../../src/main/ffmpeg/probe'
import { getBuiltinPreset } from '../../src/main/presets/builtin'
import { pictureGeometry, ratioLabel, withDisplaySize } from '../../src/shared/media'
import type { MediaInfo, VideoPreset, VideoPresetSettings } from '../../src/shared/types'
import { fakeCaps, preset, val, videoInfo } from './fixtures'

const builtin = (id: string): VideoPresetSettings => (getBuiltinPreset(id) as VideoPreset).settings

function probed(w: number, h: number, sar?: string, rotation?: number): MediaInfo {
  const json: FfprobeOutput = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: w,
        height: h,
        sample_aspect_ratio: sar,
        avg_frame_rate: '25/1',
        side_data_list: rotation !== undefined ? [{ side_data_type: 'Display Matrix', rotation }] : undefined,
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2' },
  }
  return mapProbe(json, 'C:/media/anamorphic 素材.mov', 1000)
}

const hdv = (): MediaInfo => probed(1440, 1080, '4:3')
const dvNtsc43 = (): MediaInfo => probed(720, 480, '8:9')
const dvNtsc169 = (): MediaInfo => probed(720, 480, '32:27')

describe('probe: displayed size of non-square-pixel sources', () => {
  it('HDV 1440×1080 at 4:3 is displayed 1920×1080', () => {
    expect(hdv()).toMatchObject({ width: 1920, height: 1080, storageWidth: 1440, storageHeight: 1080 })
    expect(hdv().sampleAspectRatio).toBeCloseTo(4 / 3, 10)
  })

  it('DV NTSC 720×480 at 8:9 is displayed 640×480; at 32:27 853×480', () => {
    expect(dvNtsc43()).toMatchObject({ width: 640, height: 480, storageWidth: 720, storageHeight: 480 })
    expect(dvNtsc169()).toMatchObject({ width: 853, height: 480, storageWidth: 720 })
  })

  it('square pixels (1:1, 0:1 unknown, absent) keep the stored size and no storage fields', () => {
    for (const sar of ['1:1', '0:1', undefined]) {
      const i = probed(1920, 1080, sar)
      expect(i).toMatchObject({ width: 1920, height: 1080 })
      expect(i.storageWidth).toBeUndefined()
      expect(i.sampleAspectRatio).toBeUndefined()
    }
  })

  it('rotation and pixel aspect together: HDV shot portrait (90°) shows 810×1440 (9:16)', () => {
    const i = probed(1440, 1080, '4:3', -90)
    expect(i.rotation).toBe(90)
    expect(i).toMatchObject({ width: 810, height: 1440, storageWidth: 1080, storageHeight: 1440 })
    expect(i.sampleAspectRatio).toBeCloseTo(3 / 4, 10)
    expect(i.width! / i.height!).toBeCloseTo(9 / 16, 10)
    // 180° keeps the orientation and the pixel aspect
    expect(probed(1440, 1080, '4:3', 180)).toMatchObject({ width: 1920, height: 1080, storageWidth: 1440 })
  })
})

describe('output size follows the displayed size', () => {
  it('HDV: "match source" → 1920×1080 square pixels, 720p → 1280×720', () => {
    expect(computeOutputSize(hdv(), builtin('h264-match'))).toEqual({ width: 1920, height: 1080 })
    expect(computeOutputSize(hdv(), builtin('h264-720p'))).toEqual({ width: 1280, height: 720 })
  })

  it('DV: 640×480 and 852×480 (rounded down to even) at source size; one side follows the displayed aspect', () => {
    expect(computeOutputSize(dvNtsc43(), builtin('h264-match'))).toEqual({ width: 640, height: 480 })
    expect(computeOutputSize(dvNtsc169(), builtin('h264-match'))).toEqual({ width: 852, height: 480 })
    expect(computeOutputSize(dvNtsc43(), preset({ video: { height: 960 } }))).toEqual({ width: 1280, height: 960 })
  })

  it('rotated anamorphic source fits a box by its displayed (portrait) aspect', () => {
    const portrait = probed(1440, 1080, '4:3', -90)
    expect(computeOutputSize(portrait, builtin('h264-match'))).toEqual({ width: 810, height: 1440 })
    expect(computeOutputSize(portrait, preset({ video: { width: 1280, height: 720, scaleMode: 'fit' } }))).toEqual({ width: 406, height: 720 })
  })

  it('stream copy keeps the stored frame and its pixel aspect', () => {
    const copy = preset({ video: { codec: 'copy' } })
    const s = computeOutputSize(hdv(), copy)!
    expect([s.width, s.height]).toEqual([1440, 1080])
    expect(s.sar).toBeCloseTo(4 / 3, 10)
    expect(computeOutputSize(videoInfo(), copy)).toEqual({ width: 1920, height: 1080 })
  })

  it('DVD outputs keep their own pixel-aspect handling', () => {
    const dvd = preset({ container: 'mpg', video: { codec: 'mpeg2', profile: 'dvd-ntsc' }, audio: { codec: 'ac3' } })
    expect(dvdAspect(dvNtsc43())).toEqual([4, 3])
    expect(dvdAspect(hdv())).toEqual([16, 9])
    expect(computeOutputSize(dvNtsc43(), dvd)).toEqual({ width: 720, height: 480, sar: 8 / 9 })
  })

  it('jobs saved before storageWidth existed (stored size + pixel aspect) give the same result', () => {
    const legacy = videoInfo({ width: 1440, height: 1080, sampleAspectRatio: 4 / 3 })
    expect(computeOutputSize(legacy, builtin('h264-match'))).toEqual({ width: 1920, height: 1080 })
    const fixed = withDisplaySize(legacy)
    expect(fixed).toMatchObject({ width: 1920, height: 1080, storageWidth: 1440, storageHeight: 1080 })
    expect(withDisplaySize(fixed)).toBe(fixed)
    expect(withDisplaySize(videoInfo())).toEqual(videoInfo())
    expect(pictureGeometry(fixed)).toEqual(pictureGeometry(legacy))
  })
})

describe('filters: anamorphic sources are always resampled to square pixels', () => {
  const req = (info: MediaInfo, settings: VideoPresetSettings): BuildRequest => ({
    source: 'C:/media/anamorphic 素材.mov',
    info,
    settings,
    dest: 'C:/out/輸出.tmp',
    caps: fakeCaps(),
    preferredHw: 'none',
  })
  const vf = (info: MediaInfo, settings: VideoPresetSettings): string => val(buildArgs(req(info, settings)).args, '-vf') ?? ''

  it('"match source" scales HDV to 1920×1080 and sets square pixels (square sources are left alone)', () => {
    expect(vf(hdv(), builtin('h264-match'))).toMatch(/^scale=1920:1080:flags=lanczos,.*setsar=1/)
    expect(vf(hdv(), builtin('h264-720p'))).toMatch(/^scale=1280:720:flags=lanczos,.*setsar=1/)
    expect(vf(videoInfo(), builtin('h264-match'))).not.toContain('scale=')
    expect(vf(videoInfo(), builtin('h264-match'))).not.toContain('setsar')
  })

  it('pad / crop boxes are computed from the displayed aspect, not ffmpeg’s stored aspect', () => {
    const box = (scaleMode: 'pad' | 'crop', width: number, height: number) => preset({ video: { width, height, scaleMode } })
    const pad = box('pad', 1280, 1280)
    expect(scaleFilters(hdv(), pad, computeOutputSize(hdv(), pad))).toEqual([
      'scale=1280:720:flags=lanczos',
      'pad=1280:1280:(ow-iw)/2:(oh-ih)/2:black',
    ])
    const crop = box('crop', 1080, 1080)
    expect(scaleFilters(hdv(), crop, computeOutputSize(hdv(), crop))).toEqual(['scale=1920:1080:flags=lanczos', 'crop=1080:1080'])
    expect(vf(hdv(), crop)).toContain('setsar=1')
  })
})

describe('pixel aspect labels', () => {
  it('common pixel aspects are shown as ratios', () => {
    expect([4 / 3, 8 / 9, 32 / 27, 64 / 45, 16 / 15].map(ratioLabel)).toEqual(['4:3', '8:9', '32:27', '64:45', '16:15'])
    expect(ratioLabel(Math.PI)).toBe('3.142')
  })
})

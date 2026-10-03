// Renderer side of non-square-pixel (anamorphic) sources: the source info line and the output-size estimate.
// Type-checked with the web project (tsconfig.web.json), so it imports no main-process code.
import { describe, expect, it } from 'vitest'
import { sourceInfoLine } from '../../src/renderer/src/lib/format'
import { computeVideoOutputSize } from '../../src/renderer/src/lib/videoSize'
import { makeT } from '../../src/renderer/src/i18n'
import type { MediaInfo, VideoPresetSettings } from '../../src/shared/types'

const base: MediaInfo = { path: 'C:/media/HDV 素材.m2t', kind: 'video', sizeBytes: 1, durationSec: 2, hasAudio: false, videoCodec: 'h264' }
// as probe reports them: width/height = displayed size, storage* = stored frame
const hdv: MediaInfo = { ...base, width: 1920, height: 1080, storageWidth: 1440, storageHeight: 1080, sampleAspectRatio: 4 / 3 }
const dv: MediaInfo = { ...base, width: 640, height: 480, storageWidth: 720, storageHeight: 480, sampleAspectRatio: 8 / 9 }
// saved before storageWidth existed: stored size + pixel aspect
const legacyHdv: MediaInfo = { ...base, width: 1440, height: 1080, sampleAspectRatio: 4 / 3 }
const square: MediaInfo = { ...base, width: 1920, height: 1080 }

const settings = (video: Partial<VideoPresetSettings['video']> = {}): VideoPresetSettings =>
  ({ container: 'mp4', video: { codec: 'h264', width: null, height: null, scaleMode: 'fit', noUpscale: false, ...video } }) as unknown as VideoPresetSettings

describe('UI: anamorphic source size', () => {
  it('the output estimate uses the displayed size (new and legacy entries alike)', () => {
    expect(computeVideoOutputSize(hdv, settings())).toEqual({ width: 1920, height: 1080 })
    expect(computeVideoOutputSize(legacyHdv, settings())).toEqual({ width: 1920, height: 1080 })
    expect(computeVideoOutputSize(hdv, settings({ width: 1280, height: 720 }))).toEqual({ width: 1280, height: 720 })
    expect(computeVideoOutputSize(dv, settings())).toEqual({ width: 640, height: 480 })
    expect(computeVideoOutputSize(dv, settings({ height: 960 }))).toEqual({ width: 1280, height: 960 })
    expect(computeVideoOutputSize(square, settings())).toEqual({ width: 1920, height: 1080 })
  })

  it('the source info line shows stored → displayed size and the pixel aspect', () => {
    const t = ((key: string, p?: Record<string, string | number>) => `${key}:${p?.stored}|${p?.display}|${p?.sar}`) as never
    expect(sourceInfoLine(hdv, t)).toContain('media.anamorphicSize:1440×1080|1920×1080|4:3')
    expect(sourceInfoLine(legacyHdv, t)).toContain('media.anamorphicSize:1440×1080|1920×1080|4:3')
    expect(sourceInfoLine(dv)).toContain('720×480 → 640×480 (8:9)')
    expect(sourceInfoLine(square)).toMatch(/^1920×1080 · /)
    expect(sourceInfoLine(hdv, makeT('zh-TW'))).toContain('1440×1080 → 顯示為 1920×1080（像素比 4:3）')
  })
})

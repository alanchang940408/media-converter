// Shared builders for the ffmpeg engine tests.
import type { EncoderCapabilities, MediaInfo, VideoPresetSettings } from '../../src/shared/types'

export const SOFTWARE = [
  'libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9', 'prores_ks', 'dnxhd', 'gif',
  'aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le', 'pcm_s24le',
]

export const ALL_HW = [
  'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv',
  'h264_amf', 'hevc_amf', 'av1_amf', 'h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox',
]

export function fakeCaps(working: string[] = [], compiled: string[] = [...SOFTWARE, ...working]): EncoderCapabilities {
  return {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ffmpegVersion: 'test',
    ffmpegSource: 'system',
    compiledEncoders: compiled,
    workingHwEncoders: working,
    hw: {
      nvenc: working.includes('h264_nvenc'),
      qsv: working.includes('h264_qsv'),
      amf: working.includes('h264_amf'),
      videotoolbox: working.includes('h264_videotoolbox'),
    },
  }
}

export function videoInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: 'C:/media/測試 影片.mov',
    kind: 'video',
    sizeBytes: 1_000_000,
    format: 'mov,mp4,m4a,3gp,3g2,mj2',
    durationSec: 10,
    width: 1920,
    height: 1080,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    pixFmt: 'yuv420p',
    rotation: 0,
    hasAudio: true,
    hasAlpha: false,
    audioChannels: 2,
    audioSampleRate: 48000,
    ...o,
  }
}

export function audioInfo(o: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: 'C:/media/tone.wav',
    kind: 'audio',
    sizeBytes: 500_000,
    format: 'wav',
    durationSec: 10,
    audioCodec: 'pcm_s16le',
    hasAudio: true,
    audioChannels: 2,
    audioSampleRate: 48000,
    ...o,
  }
}

type VideoPart = Partial<VideoPresetSettings['video']>
type AudioPart = Partial<VideoPresetSettings['audio']>

export function preset(
  o: Partial<Omit<VideoPresetSettings, 'video' | 'audio'>> & { video?: VideoPart; audio?: AudioPart } = {},
): VideoPresetSettings {
  const { video, audio, ...rest } = o
  return {
    container: 'mp4',
    faststart: false,
    stripMetadata: false,
    watermark: null,
    ...rest,
    video: {
      codec: 'h264',
      hw: 'none',
      rate: { mode: 'crf', crf: 23 },
      speed: 'balanced',
      profile: null,
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: false,
      fps: null,
      tenBit: false,
      ...video,
    },
    audio: { codec: 'aac', bitrateKbps: 192, sampleRate: null, channels: null, normalize: false, ...audio },
  }
}

/** Value following a flag (first occurrence). */
export function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

/** All values following every occurrence of a flag. */
export function vals(args: string[], flag: string): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1])
  })
  return out
}

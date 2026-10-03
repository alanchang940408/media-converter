// Container / codec / hardware compatibility rules. Pure — used by the ffmpeg engine and the preset editor UI.
import type { AudioCodecId, HwAccel, Mpeg2Profile, OutputContainer, VideoCodecId, VideoPresetSettings } from './types'

export const AUDIO_ONLY_CONTAINERS: readonly OutputContainer[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg']

/** Older video containers kept for compatibility with legacy players / software (software encoders only). */
export const LEGACY_VIDEO_CONTAINERS: readonly OutputContainer[] = ['avi', 'mpg', 'wmv']

/** Every output container (e.g. for validating stored presets). */
export const OUTPUT_CONTAINERS: readonly OutputContainer[] = [
  'mp4', 'mov', 'mkv', 'webm', 'gif', 'mpg', 'wmv', 'avi', 'mp3', 'm4a', 'wav', 'flac', 'ogg',
]

export function isAudioOnlyContainer(c: OutputContainer): boolean {
  return AUDIO_ONLY_CONTAINERS.includes(c)
}

const VIDEO_CODECS: Record<OutputContainer, VideoCodecId[]> = {
  mp4: ['h264', 'hevc', 'av1', 'copy'],
  mov: ['h264', 'hevc', 'prores', 'dnxhr', 'copy'],
  // MPEG-2 in MKV is well supported; in MOV only XDCAM variants are, so it is not offered there.
  mkv: ['h264', 'hevc', 'av1', 'vp9', 'prores', 'dnxhr', 'mpeg2', 'copy'],
  webm: ['vp9', 'av1', 'copy'],
  gif: ['gif'],
  mpg: ['mpeg2', 'mpeg1', 'copy'],
  // ffmpeg has no WMV9 / VC-1 encoder: WMV2 (Windows Media Video 8) is the best available.
  wmv: ['wmv2', 'copy'],
  avi: ['mpeg4', 'mjpeg', 'h264', 'copy'],
  mp3: ['none'],
  m4a: ['none'],
  wav: ['none'],
  flac: ['none'],
  ogg: ['none'],
}

const AUDIO_CODECS: Record<OutputContainer, AudioCodecId[]> = {
  mp4: ['aac', 'mp3', 'opus', 'copy', 'none'],
  mov: ['aac', 'pcm', 'mp3', 'copy', 'none'],
  mkv: ['aac', 'mp3', 'opus', 'pcm', 'flac', 'ac3', 'copy', 'none'],
  webm: ['opus', 'copy', 'none'],
  gif: ['none'],
  mpg: ['mp2', 'ac3', 'copy', 'none'],
  wmv: ['wmav2', 'copy', 'none'],
  avi: ['mp3', 'ac3', 'pcm', 'copy', 'none'],
  mp3: ['mp3', 'copy'],
  m4a: ['aac', 'copy'],
  wav: ['pcm'],
  flac: ['flac'],
  ogg: ['opus'],
}

export function allowedVideoCodecs(c: OutputContainer): VideoCodecId[] {
  return VIDEO_CODECS[c] ?? []
}

export function allowedAudioCodecs(c: OutputContainer): AudioCodecId[] {
  return AUDIO_CODECS[c] ?? []
}

/** Sensible codecs to switch to when the user changes container in the editor. */
export function defaultCodecsFor(c: OutputContainer): { video: VideoCodecId; audio: AudioCodecId } {
  switch (c) {
    case 'mp4': return { video: 'h264', audio: 'aac' }
    case 'mov': return { video: 'prores', audio: 'pcm' }
    case 'mkv': return { video: 'h264', audio: 'aac' }
    case 'webm': return { video: 'vp9', audio: 'opus' }
    case 'gif': return { video: 'gif', audio: 'none' }
    case 'mpg': return { video: 'mpeg2', audio: 'mp2' }
    case 'wmv': return { video: 'wmv2', audio: 'wmav2' }
    case 'avi': return { video: 'mpeg4', audio: 'mp3' }
    case 'mp3': return { video: 'none', audio: 'mp3' }
    case 'm4a': return { video: 'none', audio: 'aac' }
    case 'wav': return { video: 'none', audio: 'pcm' }
    case 'flac': return { video: 'none', audio: 'flac' }
    case 'ogg': return { video: 'none', audio: 'opus' }
  }
}

/** Hardware families that can encode a codec (ffmpeg encoder names are `${codec}_${family}`, prores → prores_videotoolbox). */
export const HW_CODECS: Record<Exclude<HwAccel, 'auto' | 'none'>, VideoCodecId[]> = {
  nvenc: ['h264', 'hevc', 'av1'],
  qsv: ['h264', 'hevc', 'av1'],
  amf: ['h264', 'hevc', 'av1'],
  videotoolbox: ['h264', 'hevc', 'prores'],
}

/** Order tried for hw: 'auto'. */
export const HW_PRIORITY: Exclude<HwAccel, 'auto' | 'none'>[] = ['nvenc', 'qsv', 'amf', 'videotoolbox']

export function hwEncoderName(codec: VideoCodecId, family: Exclude<HwAccel, 'auto' | 'none'>): string | null {
  if (!HW_CODECS[family].includes(codec)) return null
  return `${codec}_${family}`
}

export const PRORES_PROFILES = ['proxy', 'lt', 'standard', 'hq', '4444', '4444xq'] as const
export const DNXHR_PROFILES = ['lb', 'sq', 'hq', 'hqx', '444'] as const
export const H264_PROFILES = ['baseline', 'main', 'high'] as const
/** MPEG-2 profiles: DVD-Video NTSC / PAL (only in mpg). No profile = standard MPEG-2. */
export const MPEG2_PROFILES = ['dvd-ntsc', 'dvd-pal'] as const satisfies readonly Mpeg2Profile[]

/** Legacy codecs that only have software encoders here (hw is ignored; hw 'auto' silently uses the CPU). */
export const LEGACY_VIDEO_CODECS: readonly VideoCodecId[] = ['mpeg2', 'mpeg1', 'mpeg4', 'wmv2', 'mjpeg']

/** DVD-Video standards: frame size, exact frame rate, max GOP length. */
export const DVD_STANDARDS = {
  ntsc: { width: 720, height: 480, fps: 29.97, rate: '30000/1001', gop: 18 },
  pal: { width: 720, height: 576, fps: 25, rate: '25', gop: 15 },
} as const

/** 'ntsc' / 'pal' when the settings produce a DVD-Video compliant MPG (mpeg2 + DVD profile in mpg), else null. */
export function dvdStandard(s: Pick<VideoPresetSettings, 'container' | 'video'>): 'ntsc' | 'pal' | null {
  if (s.container !== 'mpg' || s.video.codec !== 'mpeg2') return null
  if (s.video.profile === 'dvd-ntsc') return 'ntsc'
  if (s.video.profile === 'dvd-pal') return 'pal'
  return null
}

export interface VideoIssue {
  level: 'error' | 'warning'
  /** i18n key suffix: UI shows t(`videoIssue.${code}`, params) */
  code:
    | 'videoCodecNotInContainer'
    | 'audioCodecNotInContainer'
    | 'copyIgnoresFilters'
    | 'hwNotSupportedForCodec'
    | 'tenBitIgnored'
    | 'bitrateRequired'
    | 'invalidProfile'
    | 'gifLarge'
    | 'watermarkIgnored'
    | 'dvdNeedsMpg'
  params?: Record<string, string | number>
}

export function validateVideoSettings(s: VideoPresetSettings): VideoIssue[] {
  const issues: VideoIssue[] = []
  const v = s.video
  const a = s.audio
  if (!allowedVideoCodecs(s.container).includes(v.codec)) {
    issues.push({ level: 'error', code: 'videoCodecNotInContainer', params: { codec: v.codec, container: s.container } })
  }
  if (!allowedAudioCodecs(s.container).includes(a.codec)) {
    issues.push({ level: 'error', code: 'audioCodecNotInContainer', params: { codec: a.codec, container: s.container } })
  }
  if (v.codec === 'copy' && (v.width || v.height || v.fps)) {
    issues.push({ level: 'warning', code: 'copyIgnoresFilters' })
  }
  if ((v.codec === 'copy' || v.codec === 'none') && s.watermark) {
    issues.push({ level: 'warning', code: 'watermarkIgnored' })
  }
  if (v.hw !== 'auto' && v.hw !== 'none' && v.codec !== 'none' && v.codec !== 'copy' && !hwEncoderName(v.codec, v.hw)) {
    issues.push({ level: 'warning', code: 'hwNotSupportedForCodec', params: { hw: v.hw, codec: v.codec } })
  }
  if (v.tenBit && !['hevc', 'av1', 'vp9'].includes(v.codec)) {
    issues.push({ level: 'warning', code: 'tenBitIgnored', params: { codec: v.codec } })
  }
  if ((v.rate.mode === 'vbr' || v.rate.mode === 'cbr') && !(v.rate.bitrateKbps > 0) && !['prores', 'dnxhr', 'gif', 'copy', 'none'].includes(v.codec)) {
    issues.push({ level: 'error', code: 'bitrateRequired' })
  }
  if (v.codec === 'prores' && v.profile && !(PRORES_PROFILES as readonly string[]).includes(v.profile)) {
    issues.push({ level: 'error', code: 'invalidProfile', params: { profile: v.profile } })
  }
  if (v.codec === 'dnxhr' && v.profile && !(DNXHR_PROFILES as readonly string[]).includes(v.profile)) {
    issues.push({ level: 'error', code: 'invalidProfile', params: { profile: v.profile } })
  }
  if (v.codec === 'h264' && v.profile && !(H264_PROFILES as readonly string[]).includes(v.profile)) {
    issues.push({ level: 'error', code: 'invalidProfile', params: { profile: v.profile } })
  }
  if (v.codec === 'mpeg2' && v.profile) {
    if (!(MPEG2_PROFILES as readonly string[]).includes(v.profile)) {
      issues.push({ level: 'error', code: 'invalidProfile', params: { profile: v.profile } })
    } else if (s.container !== 'mpg') {
      issues.push({ level: 'warning', code: 'dvdNeedsMpg' })
    }
  }
  if (v.codec === 'gif' && v.gif && ((v.gif.width ?? 0) > 960 || v.gif.fps > 30)) {
    issues.push({ level: 'warning', code: 'gifLarge' })
  }
  return issues
}

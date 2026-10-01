// Container / codec / hardware compatibility rules. Pure — used by the ffmpeg engine and the preset editor UI.
import type { AudioCodecId, HwAccel, OutputContainer, VideoCodecId, VideoPresetSettings } from './types'

export const AUDIO_ONLY_CONTAINERS: readonly OutputContainer[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg']

export function isAudioOnlyContainer(c: OutputContainer): boolean {
  return AUDIO_ONLY_CONTAINERS.includes(c)
}

const VIDEO_CODECS: Record<OutputContainer, VideoCodecId[]> = {
  mp4: ['h264', 'hevc', 'av1', 'copy'],
  mov: ['h264', 'hevc', 'prores', 'dnxhr', 'copy'],
  mkv: ['h264', 'hevc', 'av1', 'vp9', 'prores', 'dnxhr', 'copy'],
  webm: ['vp9', 'av1', 'copy'],
  gif: ['gif'],
  mp3: ['none'],
  m4a: ['none'],
  wav: ['none'],
  flac: ['none'],
  ogg: ['none'],
}

const AUDIO_CODECS: Record<OutputContainer, AudioCodecId[]> = {
  mp4: ['aac', 'mp3', 'opus', 'copy', 'none'],
  mov: ['aac', 'pcm', 'mp3', 'copy', 'none'],
  mkv: ['aac', 'mp3', 'opus', 'pcm', 'flac', 'copy', 'none'],
  webm: ['opus', 'copy', 'none'],
  gif: ['none'],
  mp3: ['mp3', 'copy'],
  m4a: ['aac', 'copy'],
  wav: ['pcm'],
  flac: ['flac'],
  ogg: ['opus'],
}

export function allowedVideoCodecs(c: OutputContainer): VideoCodecId[] {
  return VIDEO_CODECS[c]
}

export function allowedAudioCodecs(c: OutputContainer): AudioCodecId[] {
  return AUDIO_CODECS[c]
}

/** Sensible codecs to switch to when the user changes container in the editor. */
export function defaultCodecsFor(c: OutputContainer): { video: VideoCodecId; audio: AudioCodecId } {
  switch (c) {
    case 'mp4': return { video: 'h264', audio: 'aac' }
    case 'mov': return { video: 'prores', audio: 'pcm' }
    case 'mkv': return { video: 'h264', audio: 'aac' }
    case 'webm': return { video: 'vp9', audio: 'opus' }
    case 'gif': return { video: 'gif', audio: 'none' }
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
  if (v.codec === 'gif' && v.gif && ((v.gif.width ?? 0) > 960 || v.gif.fps > 30)) {
    issues.push({ level: 'warning', code: 'gifLarge' })
  }
  return issues
}

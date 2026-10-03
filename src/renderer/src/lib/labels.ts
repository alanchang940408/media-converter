// Display labels and one-line summaries for presets / codecs.
import type {
  AudioCodecId,
  FileOperation,
  ImageAction,
  ImageOutputSettings,
  OutputContainer,
  Preset,
  VideoCodecId,
  VideoPresetSettings,
} from '../../../shared/types'
import { dvdStandard, isAudioOnlyContainer } from '../../../shared/videoRules'
import type { MessageKey, TFunc } from '../i18n'

export const CONTAINER_LABEL: Record<OutputContainer, string> = {
  mp4: 'MP4',
  mov: 'QuickTime (MOV)',
  mkv: 'Matroska (MKV)',
  webm: 'WebM',
  gif: 'GIF',
  avi: 'AVI',
  mpg: 'MPEG (MPG)',
  wmv: 'Windows Media (WMV)',
  mp3: 'MP3',
  m4a: 'M4A (AAC)',
  wav: 'WAV',
  flac: 'FLAC',
  ogg: 'Ogg (Opus)',
}

const VIDEO_CODEC_LABEL: Record<VideoCodecId, string> = {
  h264: 'H.264 (AVC)',
  hevc: 'H.265 (HEVC)',
  av1: 'AV1',
  vp9: 'VP9',
  prores: 'Apple ProRes',
  dnxhr: 'Avid DNxHR',
  // The part before " (…)" doubles as the short name in preset summaries.
  mpeg2: 'MPEG-2',
  mpeg1: 'MPEG-1',
  mpeg4: 'Xvid (MPEG-4 Part 2)',
  wmv2: 'WMV2 (Windows Media Video 8)',
  mjpeg: 'MJPEG (Motion JPEG)',
  gif: 'GIF',
  copy: '',
  none: '',
}

const AUDIO_CODEC_LABEL: Record<AudioCodecId, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  pcm: 'PCM',
  flac: 'FLAC',
  mp2: 'MP2 (MPEG Layer II)',
  ac3: 'Dolby Digital (AC-3)',
  wmav2: 'WMA (Windows Media Audio 2)',
  copy: '',
  none: '',
}

export function videoCodecLabel(c: VideoCodecId, t: TFunc): string {
  if (c === 'copy') return t('codec.copy')
  if (c === 'none') return t('codec.noVideo')
  return VIDEO_CODEC_LABEL[c]
}

export function audioCodecLabel(c: AudioCodecId, t: TFunc): string {
  if (c === 'copy') return t('codec.copy')
  if (c === 'none') return t('codec.noAudio')
  return AUDIO_CODEC_LABEL[c]
}

export function videoSummary(s: VideoPresetSettings, t: TFunc): string {
  const parts: string[] = [s.container.toUpperCase()]
  if (isAudioOnlyContainer(s.container)) {
    parts.push(audioCodecLabel(s.audio.codec, t))
    if (s.audio.bitrateKbps && ['aac', 'mp3', 'opus'].includes(s.audio.codec)) parts.push(`${s.audio.bitrateKbps} kbps`)
    if (s.audio.sampleRate) parts.push(`${s.audio.sampleRate / 1000} kHz`)
    return parts.join(' · ')
  }
  parts.push(VIDEO_CODEC_LABEL[s.video.codec] ? VIDEO_CODEC_LABEL[s.video.codec].replace(/ \(.*\)$/, '') : videoCodecLabel(s.video.codec, t))
  const dvd = dvdStandard(s)
  if (dvd) parts.push(`DVD ${dvd.toUpperCase()}`)
  if (s.container === 'gif' && s.video.gif) {
    parts.push(`${s.video.gif.width ?? t('common.source')}px`, `${s.video.gif.fps} fps`)
  } else if (s.video.width || s.video.height) {
    parts.push(`${s.video.width ?? t('common.auto')}×${s.video.height ?? t('common.auto')}`)
  } else if (s.video.codec !== 'copy') {
    parts.push(t('common.sourceSize'))
  }
  return parts.join(' · ')
}

export function imageFormatLabel(f: ImageOutputSettings['format'], t: TFunc): string {
  return f === 'keep' ? t('imgOut.keep') : f.toUpperCase()
}

export function imageSummary(actions: ImageAction[], output: ImageOutputSettings, t: TFunc): string {
  const parts = [imageFormatLabel(output.format, t)]
  if (['jpeg', 'webp', 'avif', 'tiff'].includes(output.format) && !output.lossless) parts.push(`Q${output.quality}`)
  if (output.lossless) parts.push(t('imgOut.losslessShort'))
  const n = actions.filter((a) => a.enabled).length
  parts.push(n ? t('presets.actionsCount', { n }) : t('presets.noActions'))
  return parts.join(' · ')
}

export function fileOpSummary(op: FileOperation, t: TFunc): string {
  return t(`fileop.summary.${op}` as MessageKey)
}

export function presetSummary(p: Preset, t: TFunc): string {
  if (p.kind === 'video') return videoSummary(p.settings, t)
  if (p.kind === 'image') return imageSummary(p.actions, p.output, t)
  return fileOpSummary(p.operation, t)
}

export const tk = (k: string): MessageKey => k as MessageKey

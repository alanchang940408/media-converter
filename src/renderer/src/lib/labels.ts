// Display labels and one-line summaries for presets / codecs.
import type {
  AudioCodecId,
  ImageAction,
  ImageOutputSettings,
  OutputContainer,
  Preset,
  VideoCodecId,
  VideoPresetSettings,
} from '../../../shared/types'
import { isAudioOnlyContainer } from '../../../shared/videoRules'
import type { MessageKey, TFunc } from '../i18n'

export const CONTAINER_LABEL: Record<OutputContainer, string> = {
  mp4: 'MP4',
  mov: 'QuickTime (MOV)',
  mkv: 'Matroska (MKV)',
  webm: 'WebM',
  gif: 'GIF',
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

export function presetSummary(p: Preset, t: TFunc): string {
  return p.kind === 'video' ? videoSummary(p.settings, t) : imageSummary(p.actions, p.output, t)
}

export const tk = (k: string): MessageKey => k as MessageKey

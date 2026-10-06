// Preset list for the Adobe panel (bridge/info.json): video presets with a localized name, a one-line summary
// such as "MP4 · H.264 · 1920×1080" (mirrors the renderer's videoSummary, without importing renderer code) and the
// output extension. No Electron imports (the ffmpeg args module is pure).
import type { BridgePreset } from '../../shared/bridge'
import type { AudioCodecId, Locale, Preset, VideoCodecId, VideoPresetSettings } from '../../shared/types'
import { dvdStandard, isAudioOnlyContainer } from '../../shared/videoRules'
import { outputExtension } from '../ffmpeg/args'
import { t } from '../i18n'

const VIDEO_CODEC_SHORT: Record<VideoCodecId, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
  vp9: 'VP9',
  prores: 'Apple ProRes',
  dnxhr: 'Avid DNxHR',
  mpeg2: 'MPEG-2',
  mpeg1: 'MPEG-1',
  mpeg4: 'Xvid',
  wmv2: 'WMV2',
  mjpeg: 'MJPEG',
  gif: 'GIF',
  copy: '',
  none: '',
}

const AUDIO_CODEC_SHORT: Record<AudioCodecId, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  pcm: 'PCM',
  flac: 'FLAC',
  mp2: 'MP2',
  ac3: 'AC-3',
  wmav2: 'WMA',
  copy: '',
  none: '',
}

export function videoPresetSummary(s: VideoPresetSettings, locale: Locale): string {
  const tr = (key: Parameters<typeof t>[0]): string => t(key, undefined, locale)
  const parts: string[] = [s.container.toUpperCase()]
  if (isAudioOnlyContainer(s.container)) {
    const a = s.audio.codec
    parts.push(a === 'copy' ? tr('bridge.sum.copy') : a === 'none' ? tr('bridge.sum.noAudio') : AUDIO_CODEC_SHORT[a])
    if (s.audio.bitrateKbps && ['aac', 'mp3', 'opus'].includes(a)) parts.push(`${s.audio.bitrateKbps} kbps`)
    if (s.audio.sampleRate) parts.push(`${s.audio.sampleRate / 1000} kHz`)
    return parts.join(' · ')
  }
  const v = s.video.codec
  parts.push(v === 'copy' ? tr('bridge.sum.copy') : v === 'none' ? tr('bridge.sum.noVideo') : VIDEO_CODEC_SHORT[v])
  const dvd = dvdStandard(s)
  if (dvd) parts.push(`DVD ${dvd.toUpperCase()}`)
  if (s.container === 'gif' && s.video.gif) {
    parts.push(`${s.video.gif.width ?? tr('bridge.sum.source')}px`, `${s.video.gif.fps} fps`)
  } else if (s.video.width || s.video.height) {
    parts.push(`${s.video.width ?? tr('bridge.sum.auto')}×${s.video.height ?? tr('bridge.sum.auto')}`)
  } else if (v !== 'copy') {
    parts.push(tr('bridge.sum.sourceSize'))
  }
  return parts.join(' · ')
}

/** Video (and audio-only) presets as the panel sees them, in the app's preset order. */
export function bridgePresets(presets: readonly Preset[], locale: Locale): BridgePreset[] {
  const out: BridgePreset[] = []
  for (const p of presets) {
    if (p.kind !== 'video') continue
    out.push({
      id: p.id,
      kind: 'video',
      name: p.names?.[locale] ?? p.name,
      ...(p.names && Object.keys(p.names).length ? { names: { ...p.names } } : {}),
      category: p.category,
      builtIn: p.builtIn,
      summary: videoPresetSummary(p.settings, locale),
      // exactly the extension the queue gives the output (the panel shows "name.ext" and spots duplicate names)
      ext: outputExtension(p.settings),
      // full settings so the panel can let Premiere Pro / After Effects write the final file directly
      settings: structuredClone(p.settings),
    })
  }
  return out
}

// Friendly names and grouping for the FFmpeg encoders shown in Settings → Performance.
// Labels are product / format names (not translated); the raw encoder name is shown next to them.

export type EncoderGroup = 'video' | 'hw' | 'audio'

/** Software encoders in display order. */
const SOFTWARE_VIDEO: Record<string, string> = {
  libx264: 'H.264',
  libx265: 'H.265 (HEVC)',
  libsvtav1: 'AV1 (SVT-AV1)',
  'libaom-av1': 'AV1 (libaom)',
  'libvpx-vp9': 'VP9',
  prores_ks: 'Apple ProRes',
  dnxhd: 'Avid DNxHR',
  mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1',
  mpeg4: 'MPEG-4 Part 2 (Xvid)',
  wmv2: 'WMV2 (Windows Media Video 8)',
  mjpeg: 'Motion JPEG',
  gif: 'GIF',
}

const AUDIO: Record<string, string> = {
  aac: 'AAC',
  libfdk_aac: 'AAC (FDK)',
  libmp3lame: 'MP3',
  mp3: 'MP3',
  libopus: 'Opus',
  opus: 'Opus',
  libvorbis: 'Vorbis',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  pcm_s16le: 'PCM 16-bit',
  pcm_s24le: 'PCM 24-bit',
  pcm_s32le: 'PCM 32-bit',
  pcm_f32le: 'PCM 32-bit float',
  mp2: 'MP2',
  mp2fixed: 'MP2',
  ac3: 'Dolby Digital (AC-3)',
  eac3: 'Dolby Digital Plus (E-AC-3)',
  wmav2: 'WMA (Windows Media Audio 2)',
  wmav1: 'WMA (Windows Media Audio 1)',
}

const HW_CODEC: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2: 'MPEG-2',
  mjpeg: 'Motion JPEG',
  prores: 'ProRes',
}

const HW_FAMILY: Record<string, string> = {
  nvenc: 'NVENC',
  qsv: 'Quick Sync',
  amf: 'AMF',
  videotoolbox: 'VideoToolbox',
  vaapi: 'VA-API',
  mf: 'Media Foundation',
}

const HW_FAMILY_ORDER = Object.keys(HW_FAMILY)
const HW_CODEC_ORDER = Object.keys(HW_CODEC)
const HW_NAME = /^([a-z0-9]+)_(nvenc|qsv|amf|videotoolbox|vaapi|mf)$/
const AUDIO_PATTERN = /^(pcm_|wmav|lib(fdk_aac|mp3lame|opus|vorbis)$)/

const own = (map: Record<string, string>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

const isAudio = (name: string): boolean => own(AUDIO, name) !== undefined || AUDIO_PATTERN.test(name)

export function encoderGroup(name: string): EncoderGroup {
  if (HW_NAME.test(name)) return 'hw'
  return isAudio(name) ? 'audio' : 'video'
}

/** "H.264", "HEVC · NVENC", "MP2"… — the raw name when the encoder is not known. */
export function encoderLabel(name: string): string {
  const hw = HW_NAME.exec(name)
  if (hw) return `${own(HW_CODEC, hw[1]) ?? hw[1].toUpperCase()} · ${HW_FAMILY[hw[2]]}`
  return own(SOFTWARE_VIDEO, name) ?? own(AUDIO, name) ?? name
}

function rank(name: string): number[] {
  const hw = HW_NAME.exec(name)
  if (hw) {
    const c = HW_CODEC_ORDER.indexOf(hw[1])
    return [c < 0 ? 99 : c, HW_FAMILY_ORDER.indexOf(hw[2])]
  }
  const list = Object.keys(isAudio(name) ? AUDIO : SOFTWARE_VIDEO)
  const i = list.indexOf(name)
  return [i < 0 ? 999 : i, 0]
}

/** Known encoders in a stable, meaningful order (codec, then GPU family); unknown ones last, by name. */
export function sortEncoders(list: string[]): string[] {
  return [...list].sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b)
  })
}

export function splitEncoders(list: string[]): Record<EncoderGroup, string[]> {
  const out: Record<EncoderGroup, string[]> = { video: [], hw: [], audio: [] }
  for (const e of list) out[encoderGroup(e)].push(e)
  return { video: sortEncoders(out.video), hw: sortEncoders(out.hw), audio: sortEncoders(out.audio) }
}

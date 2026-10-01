// Preset → ffmpeg arguments. Everything here is pure (no I/O) so it can be unit-tested exhaustively.
import type {
  AudioCodecId,
  EncoderCapabilities,
  GifSettings,
  HwAccel,
  MediaInfo,
  OutputContainer,
  VideoCodecId,
  VideoPresetSettings,
} from '../../shared/types'
import { HW_PRIORITY, hwEncoderName, isAudioOnlyContainer } from '../../shared/videoRules'
import type { VideoEncodeRequest } from '../contracts'
import { fmtSec } from './proc'

export type BuildRequest = Omit<VideoEncodeRequest, 'signal' | 'onProgress' | 'onLog'>
export type HwFamily = Exclude<HwAccel, 'auto' | 'none'>

const EXTENSIONS: Record<OutputContainer, string> = {
  mp4: 'mp4', mov: 'mov', mkv: 'mkv', webm: 'webm', gif: 'gif',
  mp3: 'mp3', m4a: 'm4a', wav: 'wav', flac: 'flac', ogg: 'ogg',
}

const MUXERS: Record<OutputContainer, string> = {
  mp4: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm', gif: 'gif',
  mp3: 'mp3', m4a: 'ipod', wav: 'wav', flac: 'flac', ogg: 'ogg',
}

export function outputExtension(settings: VideoPresetSettings): string {
  return EXTENSIONS[settings.container] ?? 'mp4'
}

export function muxerFor(container: OutputContainer): string {
  return MUXERS[container] ?? container
}

export const DEFAULT_GIF: GifSettings = { fps: 15, width: null, colors: 256, dither: 'sierra2_4a', loop: 0 }

// ───────────────────────────── output size ─────────────────────────────

const even = (x: number): number => Math.max(2, Math.round(x / 2) * 2)
const evenDown = (x: number): number => Math.max(2, Math.floor(x / 2) * 2)

function sourceHasVideo(info: MediaInfo): boolean {
  return info.kind !== 'audio'
}

/** True when the encode produces a video stream. */
export function outputHasVideo(info: MediaInfo, settings: VideoPresetSettings): boolean {
  return !isAudioOnlyContainer(settings.container) && settings.video.codec !== 'none' && sourceHasVideo(info)
}

/**
 * Output frame size. Semantics:
 * - only width or height set → the other side follows the source aspect.
 * - both set: fit = inside the box keeping aspect; pad = exactly the box (bars); crop = exactly the box (centre crop);
 *   stretch = exactly the box.
 * - noUpscale: no source axis is ever enlarged. For fit/one-side the scale factor is capped at 1; for pad/crop/stretch
 *   the requested box is shrunk proportionally (keeping its aspect) until the content is shown at ≤ 100 %.
 * - copy returns the source size untouched. Everything else is rounded to even numbers ≥ 2.
 */
export function computeOutputSize(info: MediaInfo, settings: VideoPresetSettings): { width: number; height: number } | null {
  if (!outputHasVideo(info, settings)) return null
  const sw = info.width ?? 0
  const sh = info.height ?? 0
  const v = settings.video
  if (v.codec === 'copy') return sw && sh ? { width: sw, height: sh } : null
  if (!sw || !sh) {
    // Unknown source size: only a fully specified box is predictable.
    const fixedBox = v.width && v.height && v.codec !== 'gif' && v.scaleMode !== 'fit'
    return fixedBox ? { width: even(v.width!), height: even(v.height!) } : null
  }
  const noUp = v.noUpscale
  // Keeping the source size: odd sizes are rounded *down* so nothing is enlarged.
  const src = { width: evenDown(sw), height: evenDown(sh) }
  const oneSide = (w: number | null, h: number | null): { width: number; height: number } => {
    if (w) return noUp && w >= sw ? src : { width: even(w), height: even((sh * w) / sw) }
    if (h) return noUp && h >= sh ? src : { width: even((sw * h) / sh), height: even(h) }
    return src
  }

  if (v.codec === 'gif') {
    const gif = v.gif ?? DEFAULT_GIF
    return oneSide(gif.width && gif.width > 0 ? gif.width : null, null)
  }
  const W = v.width && v.width > 0 ? v.width : null
  const H = v.height && v.height > 0 ? v.height : null
  if (!W || !H) return oneSide(W, H)

  const sx = W / sw
  const sy = H / sh
  switch (v.scaleMode) {
    case 'pad': {
      const k = Math.min(sx, sy)
      const shrink = noUp && k > 1 ? 1 / k : 1
      return { width: even(W * shrink), height: even(H * shrink) }
    }
    case 'crop':
    case 'stretch': {
      const k = Math.max(sx, sy)
      const shrink = noUp && k > 1 ? 1 / k : 1
      return { width: even(W * shrink), height: even(H * shrink) }
    }
    case 'fit':
    default: {
      let k = Math.min(sx, sy)
      if (noUp && k > 1) k = 1
      return { width: even(sw * k), height: even(sh * k) }
    }
  }
}

// ───────────────────────────── encoder choice ─────────────────────────────

export function softwareEncoder(codec: VideoCodecId, caps?: Pick<EncoderCapabilities, 'compiledEncoders'>): string {
  switch (codec) {
    case 'h264': return 'libx264'
    case 'hevc': return 'libx265'
    case 'av1': {
      const compiled = caps?.compiledEncoders ?? []
      return !compiled.includes('libsvtav1') && compiled.includes('libaom-av1') ? 'libaom-av1' : 'libsvtav1'
    }
    case 'vp9': return 'libvpx-vp9'
    case 'prores': return 'prores_ks'
    case 'dnxhr': return 'dnxhd'
    case 'gif': return 'gif'
    case 'copy': return 'copy'
    case 'none': return 'none'
  }
}

export function hwFamilyOf(encoder: string): HwFamily | null {
  const m = /_(nvenc|qsv|amf|videotoolbox)$/.exec(encoder)
  return m ? (m[1] as HwFamily) : null
}

/**
 * hw 'none' → software. hw 'auto' → global preference: 'none' = software, a family = that family if its encoder works,
 * 'auto' = first working family in HW_PRIORITY. An explicit family is used only when its encoder works.
 */
export function resolveVideoEncoder(
  codec: VideoCodecId,
  hw: HwAccel,
  preferredHw: HwAccel,
  caps: Pick<EncoderCapabilities, 'compiledEncoders' | 'workingHwEncoders'>,
): { encoder: string; family: HwFamily | null } {
  const sw = { encoder: softwareEncoder(codec, caps), family: null }
  if (codec === 'copy' || codec === 'none' || codec === 'gif') return sw
  const working = (family: HwFamily): string | null => {
    const name = hwEncoderName(codec, family)
    return name && caps.workingHwEncoders.includes(name) ? name : null
  }
  let family: HwFamily | null = null
  if (hw === 'auto') {
    if (preferredHw === 'auto') family = HW_PRIORITY.find((f) => working(f)) ?? null
    else if (preferredHw !== 'none' && working(preferredHw)) family = preferredHw
  } else if (hw !== 'none' && working(hw)) {
    family = hw
  }
  return family ? { encoder: working(family)!, family } : sw
}

// ───────────────────────────── video encoder options ─────────────────────────────

type EncKind = 'x264' | 'x265' | 'svtav1' | 'aom' | 'vpx' | 'nvenc' | 'qsv' | 'amf' | 'vt' | 'prores_ks' | 'prores_vt' | 'dnxhd' | 'gif' | 'copy'

function encKind(encoder: string): EncKind {
  switch (encoder) {
    case 'libx264': return 'x264'
    case 'libx265': return 'x265'
    case 'libsvtav1': return 'svtav1'
    case 'libaom-av1': return 'aom'
    case 'libvpx-vp9': return 'vpx'
    case 'prores_ks': return 'prores_ks'
    case 'prores_videotoolbox': return 'prores_vt'
    case 'dnxhd': return 'dnxhd'
    case 'gif': return 'gif'
    case 'copy': return 'copy'
  }
  switch (hwFamilyOf(encoder)) {
    case 'nvenc': return 'nvenc'
    case 'qsv': return 'qsv'
    case 'amf': return 'amf'
    case 'videotoolbox': return 'vt'
    default: return 'x264'
  }
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(x)))
const kb = (n: number): string => `${Math.max(1, Math.round(n))}k`

/**
 * Constant-quality mapping. Input is on the x264 CRF scale (0..51, 23 = default). Rationale per encoder:
 *   libx264        crf as is
 *   libx265        crf + 5        (x265 at CRF n+5 ≈ x264 at n)
 *   libsvtav1      round(crf × 1.35), 1..63   (AV1 63-step scale; 23 → 31)
 *   libaom-av1     round(crf × 1.35), 0..63  + -b:v 0 (pure constant-quality mode)
 *   libvpx-vp9     crf + 8, 0..63 + -b:v 0   (23 → 31, libvpx's recommended range)
 *   *_nvenc        -rc vbr -cq q -b:v 0; h264 q = crf, hevc q = crf + 2, av1 q = round(crf × 1.35); 1..51 (av1 1..63)
 *   *_qsv          -global_quality crf, 1..51 (ICQ)
 *   *_amf          -rc cqp -qp_i/-qp_p(/-qp_b) q; h264/hevc q = crf (0..51), av1 q = round(crf × 1.35) × 4 (0..255)
 *   *_videotoolbox -q:v round(100 − crf × 1.6), 1..100 (higher = better; 23 → 63)
 */
export function crfArgs(encoder: string, crf: number): string[] {
  const c = clamp(crf, 0, 51)
  const codec = encoder.split('_')[0]
  switch (encKind(encoder)) {
    case 'x264': return ['-crf', String(c)]
    case 'x265': return ['-crf', String(clamp(c + 5, 0, 51))]
    case 'svtav1': return ['-crf', String(clamp(c * 1.35, 1, 63))]
    case 'aom': return ['-crf', String(clamp(c * 1.35, 0, 63)), '-b:v', '0']
    case 'vpx': return ['-crf', String(clamp(c + 8, 0, 63)), '-b:v', '0']
    case 'nvenc': {
      const q = codec === 'av1' ? clamp(c * 1.35, 1, 63) : clamp(codec === 'hevc' ? c + 2 : c, 1, 51)
      return ['-rc', 'vbr', '-cq', String(q), '-b:v', '0']
    }
    case 'qsv': return ['-global_quality', String(clamp(c, 1, 51))]
    case 'amf': {
      const q = codec === 'av1' ? clamp(Math.round(c * 1.35) * 4, 0, 255) : c
      const args = ['-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)]
      if (codec !== 'hevc') args.push('-qp_b', String(q))
      return args
    }
    case 'vt': return ['-q:v', String(clamp(100 - c * 1.6, 1, 100))]
    default: return []
  }
}

function rateArgs(encoder: string, rate: VideoPresetSettings['video']['rate']): string[] {
  const kind = encKind(encoder)
  if (['prores_ks', 'prores_vt', 'dnxhd', 'gif', 'copy'].includes(kind)) return []
  if (rate.mode === 'crf') return crfArgs(encoder, rate.crf)
  const b = rate.bitrateKbps > 0 ? rate.bitrateKbps : 5000
  if (kind === 'vt') return ['-b:v', kb(b)]
  // SVT-AV1 rejects -maxrate outside CRF mode and has no CBR for random-access GOPs → plain target-bitrate VBR.
  if (kind === 'svtav1') return ['-b:v', kb(b)]
  const max = rate.mode === 'vbr' ? (rate.maxKbps && rate.maxKbps > 0 ? rate.maxKbps : b * 1.5) : b
  const common =
    rate.mode === 'vbr'
      ? ['-b:v', kb(b), '-maxrate', kb(max), '-bufsize', kb(b * 2)]
      : ['-b:v', kb(b), '-minrate', kb(b), '-maxrate', kb(b), '-bufsize', kb(b * 2)]
  if (kind === 'nvenc') return ['-rc', rate.mode === 'vbr' ? 'vbr' : 'cbr', ...common]
  if (kind === 'amf') return ['-rc', rate.mode === 'vbr' ? 'vbr_peak' : 'cbr', ...common]
  return common
}

function speedArgs(encoder: string, speed: VideoPresetSettings['video']['speed']): string[] {
  const i = speed === 'fast' ? 0 : speed === 'quality' ? 2 : 1
  switch (encKind(encoder)) {
    case 'x264':
    case 'x265': return ['-preset', ['veryfast', 'medium', 'slow'][i]]
    case 'nvenc': return ['-preset', ['p2', 'p4', 'p6'][i], '-tune', 'hq']
    case 'qsv': return ['-preset', ['veryfast', 'medium', 'slower'][i]]
    case 'amf': return ['-quality', ['speed', 'balanced', 'quality'][i]]
    case 'svtav1': return ['-preset', ['10', '8', '5'][i]]
    case 'vpx': return ['-deadline', 'good', '-cpu-used', ['5', '2', '1'][i], '-row-mt', '1']
    case 'aom': return ['-cpu-used', ['8', '6', '4'][i], '-row-mt', '1']
    default: return []
  }
}

const PRORES_INDEX: Record<string, number> = { proxy: 0, lt: 1, standard: 2, hq: 3, '4444': 4, '4444xq': 5 }
const PRORES_VT_NAME: Record<string, string> = { proxy: 'proxy', lt: 'lt', standard: 'standard', hq: 'hq', '4444': '4444', '4444xq': 'xq' }
const DNXHR = ['lb', 'sq', 'hq', 'hqx', '444']

function proresProfile(p?: string | null): string {
  return p && p in PRORES_INDEX ? p : 'standard'
}

function dnxhrProfile(p?: string | null): string {
  return p && DNXHR.includes(p) ? p : 'hq'
}

/** Pixel format for the end of the filter chain, or null to let ffmpeg negotiate. */
export function pixelFormatFor(encoder: string, codec: VideoCodecId, settings: VideoPresetSettings, info: MediaInfo): string | null {
  const kind = encKind(encoder)
  const family = hwFamilyOf(encoder)
  if (kind === 'copy' || kind === 'gif' || kind === 'prores_vt') return null
  if (kind === 'prores_ks') {
    const p = proresProfile(settings.video.profile)
    if (p === '4444' || p === '4444xq') return info.hasAlpha ? 'yuva444p10le' : 'yuv444p10le'
    return 'yuv422p10le'
  }
  if (kind === 'dnxhd') {
    const p = dnxhrProfile(settings.video.profile)
    return p === '444' ? 'yuv444p10le' : p === 'hqx' ? 'yuv422p10le' : 'yuv422p'
  }
  const tenBit = !!settings.video.tenBit && (codec === 'hevc' || codec === 'av1' || codec === 'vp9')
  if (tenBit) return family ? 'p010le' : 'yuv420p10le'
  return family === 'qsv' ? 'nv12' : 'yuv420p'
}

function profileArgs(encoder: string, codec: VideoCodecId, settings: VideoPresetSettings): string[] {
  const kind = encKind(encoder)
  const p = settings.video.profile
  if (kind === 'prores_ks') return ['-profile:v', String(PRORES_INDEX[proresProfile(p)]), '-vendor', 'apl0']
  if (kind === 'prores_vt') return ['-profile:v', PRORES_VT_NAME[proresProfile(p)]]
  if (kind === 'dnxhd') return ['-profile:v', `dnxhr_${dnxhrProfile(p)}`]
  if (codec === 'h264' && p && ['baseline', 'main', 'high'].includes(p)) {
    return ['-profile:v', kind === 'amf' && p === 'baseline' ? 'constrained_baseline' : p]
  }
  if (codec === 'hevc' && settings.video.tenBit && hwFamilyOf(encoder)) return ['-profile:v', 'main10']
  return []
}

function videoCodecArgs(encoder: string, codec: VideoCodecId, settings: VideoPresetSettings): string[] {
  if (encoder === 'copy') return ['-c:v', 'copy']
  const args = ['-c:v', encoder]
  args.push(...speedArgs(encoder, settings.video.speed))
  args.push(...rateArgs(encoder, settings.video.rate))
  args.push(...profileArgs(encoder, codec, settings))
  if (encoder === 'libx265') args.push('-x265-params', 'log-level=error')
  if (codec === 'hevc' && (settings.container === 'mp4' || settings.container === 'mov')) args.push('-tag:v', 'hvc1')
  return args
}

// ───────────────────────────── filters ─────────────────────────────

/** Scale (+pad/crop) filters for the chosen size. Empty when no scaling is needed. */
export function scaleFilters(info: MediaInfo, settings: VideoPresetSettings, out: { width: number; height: number } | null): string[] {
  const v = settings.video
  const sw = info.width ?? 0
  const sh = info.height ?? 0
  const W = v.codec !== 'gif' && v.width && v.width > 0 ? even(v.width) : null
  const H = v.codec !== 'gif' && v.height && v.height > 0 ? even(v.height) : null
  if (!out) {
    // Source size unknown: let ffmpeg compute it from expressions.
    if (v.codec === 'gif') {
      const gw = (v.gif ?? DEFAULT_GIF).width
      return gw ? [`scale=${even(gw)}:-2:flags=lanczos`] : []
    }
    if (W && H) {
      if (v.scaleMode === 'fit') return [`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`]
      if (v.scaleMode === 'pad') {
        return [`scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`]
      }
      if (v.scaleMode === 'crop') return [`scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos`, `crop=${W}:${H}`]
      return [`scale=${W}:${H}:flags=lanczos`]
    }
    if (W) return [`scale=${W}:-2:flags=lanczos`]
    if (H) return [`scale=-2:${H}:flags=lanczos`]
    return []
  }
  const { width: ow, height: oh } = out
  if (v.codec !== 'gif' && W && H && (v.scaleMode === 'pad' || v.scaleMode === 'crop')) {
    if (v.scaleMode === 'pad') {
      // Content already fits exactly (same aspect, same size) → nothing to do.
      if (ow === sw && oh === sh) return []
      return [`scale=${ow}:${oh}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`, `pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:black`]
    }
    if (ow === sw && oh === sh) return []
    return [`scale=${ow}:${oh}:force_original_aspect_ratio=increase:force_divisible_by=2:flags=lanczos`, `crop=${ow}:${oh}`]
  }
  if (ow === sw && oh === sh) return []
  return [`scale=${ow}:${oh}:flags=lanczos`]
}

function gifPaletteChain(gif: GifSettings): string {
  const colors = clamp(gif.colors || 256, 4, 256) // palettegen accepts 4..256
  const dither = gif.dither === 'bayer' ? 'bayer:bayer_scale=3' : gif.dither || 'sierra2_4a'
  return `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=${dither}`
}

// ───────────────────────────── audio ─────────────────────────────

const OPUS_RATES = [48000, 24000, 16000, 12000, 8000]
const MP3_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000]

function nearest(list: number[], v: number): number {
  return list.reduce((best, r) => (Math.abs(r - v) < Math.abs(best - v) ? r : best), list[0])
}

/** Clamp a sample rate to what the audio encoder accepts. */
export function supportedSampleRate(encoder: string, rate: number): number {
  if (encoder === 'libopus') return OPUS_RATES.includes(rate) ? rate : 48000
  if (encoder === 'libmp3lame') return nearest(MP3_RATES, rate)
  if (encoder === 'aac') return Math.min(rate, 96000)
  return rate
}

function audioEncoderName(codec: AudioCodecId, info: MediaInfo): string {
  switch (codec) {
    case 'aac': return 'aac'
    case 'mp3': return 'libmp3lame'
    case 'opus': return 'libopus'
    // Keep high-resolution sources (24/32-bit, float, hi-res FLAC/ALAC) at 24-bit; everything else 16-bit.
    case 'pcm': {
      const hiRes = (info.audioBitDepth ?? 0) > 16 || /^pcm_(s24|s32|f32|f64)/.test(info.audioCodec ?? '')
      return hiRes ? 'pcm_s24le' : 'pcm_s16le'
    }
    case 'flac': return 'flac'
    case 'copy': return 'copy'
    case 'none': return 'none'
  }
}

const DEFAULT_AUDIO_KBPS: Partial<Record<string, number>> = { aac: 192, libmp3lame: 192, libopus: 128 }

function audioArgs(settings: VideoPresetSettings, info: MediaInfo): { args: string[]; encoder: string | null } {
  const a = settings.audio
  if (a.codec === 'none' || settings.container === 'gif' || !info.hasAudio) return { args: ['-an'], encoder: null }
  const encoder = audioEncoderName(a.codec, info)
  if (encoder === 'copy') return { args: ['-c:a', 'copy'], encoder: 'copy' }
  const args = ['-c:a', encoder]
  const defKbps = DEFAULT_AUDIO_KBPS[encoder]
  if (defKbps) args.push('-b:a', kb(a.bitrateKbps && a.bitrateKbps > 0 ? a.bitrateKbps : defKbps))
  let rate = a.sampleRate && a.sampleRate > 0 ? a.sampleRate : null
  // loudnorm resamples to 192 kHz internally — pin the output rate back to the source rate.
  if (!rate && a.normalize) rate = info.audioSampleRate ?? 48000
  if (rate) args.push('-ar', String(supportedSampleRate(encoder, rate)))
  if (a.channels && a.channels > 0) args.push('-ac', String(a.channels))
  if (a.normalize) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11')
  return { args, encoder }
}

// ───────────────────────────── buildArgs ─────────────────────────────

export function buildArgs(req: BuildRequest): { args: string[]; encoder: string } {
  const { info, settings, trim, overlay } = req
  const v = settings.video
  const container = settings.container
  const srcVideo = sourceHasVideo(info)
  if (container === 'gif' && !srcVideo) throw new Error('GIF output needs a video source (this file has no video stream).')
  const hasVideo = outputHasVideo(info, settings)
  const audio = audioArgs(settings, info)
  if (!hasVideo) {
    if (!info.hasAudio) throw new Error('The source has no audio stream to encode.')
    if (!audio.encoder) throw new Error('Nothing to encode: video is disabled and audio is set to none.')
  }

  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'warning', '-progress', 'pipe:1', '-nostats']

  // Trim: input seek + output duration.
  let duration: number | null = null
  if (trim && trim.outSec > trim.inSec) {
    if (trim.inSec > 0) args.push('-ss', fmtSec(trim.inSec))
    duration = trim.outSec - Math.max(0, trim.inSec)
  }
  args.push('-i', req.source)

  let encoder = audio.encoder ?? 'none'
  const videoArgs: string[] = []
  if (hasVideo) {
    const codec = v.codec
    const choice = resolveVideoEncoder(codec, v.hw, req.preferredHw, req.caps)
    encoder = choice.encoder
    if (encoder === 'copy') {
      args.push('-map', '0:V:0')
      videoArgs.push('-c:v', 'copy')
    } else {
      const isGif = codec === 'gif'
      const out = computeOutputSize(info, settings)
      const pre = scaleFilters(info, settings, out)
      const scaled = pre.length > 0
      const fps = isGif ? ((v.gif ?? DEFAULT_GIF).fps || v.fps) : v.fps
      if (fps && fps > 0) pre.push(`fps=${fps}`)
      if (scaled) pre.push('setsar=1')
      const pix = pixelFormatFor(encoder, codec, settings, info)
      const useOverlay = !!overlay
      if (useOverlay) args.push('-i', overlay!.pngPath)

      if (useOverlay || isGif) {
        const head = pre.length ? `[0:V:0]${pre.join(',')}` : '[0:V:0]'
        let graph: string
        if (useOverlay) {
          const ov = `overlay=${Math.round(overlay!.left)}:${Math.round(overlay!.top)}:format=auto`
          const base = pre.length ? `${head}[base];[base]` : head
          graph = `${base}[1:v:0]${ov}`
          if (isGif) graph += `,${gifPaletteChain(v.gif ?? DEFAULT_GIF)}`
          else if (pix) graph += `,format=${pix}`
        } else {
          graph = `${head}${pre.length ? ',' : ''}${gifPaletteChain(v.gif ?? DEFAULT_GIF)}`
        }
        args.push('-filter_complex', `${graph}[vout]`, '-map', '[vout]')
      } else {
        args.push('-map', '0:V:0')
        if (pix) pre.push(`format=${pix}`)
        if (pre.length) videoArgs.push('-vf', pre.join(','))
      }
      videoArgs.push(...videoCodecArgs(encoder, codec, settings))
      if (isGif) videoArgs.push('-loop', String((v.gif ?? DEFAULT_GIF).loop ?? 0))
    }
  } else {
    videoArgs.push('-vn')
  }
  if (audio.encoder) args.push('-map', '0:a:0?')
  if (duration !== null) args.push('-t', fmtSec(duration))
  args.push(...videoArgs, ...audio.args)
  args.push('-map_metadata', settings.stripMetadata ? '-1' : '0')
  if (settings.faststart && (container === 'mp4' || container === 'mov' || container === 'm4a')) args.push('-movflags', '+faststart')
  args.push('-f', muxerFor(container), req.dest)
  return { args, encoder }
}

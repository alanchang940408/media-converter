// Output format resolution, encoder options and metadata policy.
import type { Sharp } from 'sharp'
import type { ImageFormat, ImageOutputSettings } from '../../shared/types'
import { extOf } from '../../shared/media'
import { clamp, num, parseColor, WHITE } from './util'

/** Source extensions whose format we can also write (format 'keep'). */
const KEEPABLE: Record<string, ImageFormat> = {
  jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg',
  png: 'png', webp: 'webp', avif: 'avif', tif: 'tiff', tiff: 'tiff', gif: 'gif',
}

const EXTENSION: Record<ImageFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', avif: 'avif', tiff: 'tiff', gif: 'gif' }

/**
 * 'keep' resolves by the source *extension* (sync, so outputExtension() and process() always agree);
 * anything we cannot write (bmp, heic, svg…) becomes png.
 */
export function resolveFormat(output: ImageOutputSettings, sourcePath: string): ImageFormat {
  if (output.format && output.format !== 'keep') return output.format
  return KEEPABLE[extOf(sourcePath)] ?? 'png'
}

export function extensionFor(format: ImageFormat): string {
  return EXTENSION[format]
}

export const ANIMATABLE: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['gif', 'webp'])

/**
 * strip     = drop EXIF/XMP, convert to sRGB and attach an sRGB profile
 * keep      = keep EXIF/XMP/ICC untouched (pixels stay in the source profile)
 * keepNoIcc = CMYK sources: keep EXIF/XMP, convert to sRGB (a CMYK profile cannot ride along with RGB pixels)
 */
export type MetaMode = 'strip' | 'keep' | 'keepNoIcc'

/** Metadata flags for lossless intermediates between actions. */
export function applyIntermediateMeta(img: Sharp, mode: MetaMode): Sharp {
  if (mode === 'keep') return img.keepMetadata()
  if (mode === 'keepNoIcc') return img.keepExif().keepXmp()
  return img
}

/** Metadata for the final encode. `gray` images skip the sRGB transform (it would add colour bands). */
export function applyOutputMeta(img: Sharp, mode: MetaMode, opts: { dpi?: number | null; gray: boolean }): Sharp {
  let p = img
  if (mode === 'keep') p = p.keepMetadata()
  else if (mode === 'keepNoIcc') p = p.keepExif().keepXmp()
  if (mode !== 'keep' && !opts.gray) p = p.withIccProfile('srgb')
  const dpi = num(opts.dpi, 0)
  if (dpi > 0) p = p.withDensity(clamp(dpi, 1, 100000))
  return p
}

export interface EncodeOptions {
  hasAlpha: boolean
  /** Animated output (gif/webp). */
  anim?: { loop: number; delay?: number[] }
}

/** Always sets the format explicitly — dest may be a temp name like "x.jpg.part". */
export function applyEncoder(img: Sharp, format: ImageFormat, output: ImageOutputSettings, opts: EncodeOptions): Sharp {
  const quality = Math.round(clamp(num(output.quality, 85), 1, 100))
  const anim = opts.anim ? { loop: opts.anim.loop, ...(opts.anim.delay ? { delay: opts.anim.delay } : {}) } : {}
  switch (format) {
    case 'jpeg': {
      const p = opts.hasAlpha ? img.flatten({ background: parseColor(output.background, WHITE) }) : img
      const progressive = !!output.progressive
      // mozjpeg defaults spelled out, because `mozjpeg: true` would force progressive scans
      return p.jpeg({
        quality,
        progressive,
        chromaSubsampling: output.chromaSubsampling ?? '4:2:0',
        trellisQuantisation: true,
        overshootDeringing: true,
        optimiseScans: progressive,
        optimiseCoding: true,
        quantisationTable: 3,
        force: true,
      })
    }
    case 'png':
      return img.png({
        compressionLevel: Math.round(clamp(num(output.pngCompression, 6), 0, 9)),
        progressive: !!output.progressive,
        force: true,
      })
    case 'webp':
      return img.webp({ quality, lossless: !!output.lossless, effort: 4, ...anim, force: true })
    case 'avif': {
      const lossless = !!output.lossless
      return img.avif({
        quality,
        lossless,
        chromaSubsampling: lossless ? '4:4:4' : (output.chromaSubsampling ?? '4:2:0'),
        effort: 4,
        force: true,
      })
    }
    case 'tiff':
      // The TIFF JPEG codec cannot carry alpha: transparent images stay lossless (LZW).
      if (quality < 100 && !opts.hasAlpha) return img.tiff({ compression: 'jpeg', quality, force: true })
      return img.tiff({ compression: 'lzw', predictor: 'horizontal', force: true })
    case 'gif':
      return img.gif({ ...anim, force: true })
  }
}

/** Browser mime type for an encoded format. */
export function mimeFor(format: ImageFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : `image/${format}`
}

// Image engine: XnConvert-style action chains on sharp/libvips, ffmpeg fallback decoding, watermarks.
// No Electron imports — runs under plain Node (vitest).
import { stat, unlink } from 'node:fs/promises'
import sharp from 'sharp'
import type { ImageFormat, MediaInfo } from '../../shared/types'
import type { ImageEngine, ImageProcessRequest, ImageProcessResult } from '../contracts'
import { baseNameOf } from '../../shared/media'
import { type DecodedSource, openSource, SHARP_OPTS } from './decode'
import { extensionFor, mimeFor, resolveFormat } from './output'
import { buildOutput } from './pipeline'
import { abortError, throwIfAborted, today } from './util'
import { compositeWatermark, renderWatermarkLayer, type WatermarkVars } from './watermark'

const ROTATION: Record<number, number> = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 }
const DISPLAYABLE: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['jpeg', 'png', 'webp', 'gif'])

const varsFor = (source: string): WatermarkVars => ({ name: baseNameOf(source), date: today() })

const fitBox = (maxSize: number): number => (Number.isFinite(maxSize) && maxSize > 0 ? Math.round(maxSize) : 1024)

async function probe(path: string): Promise<MediaInfo> {
  const st = await stat(path)
  const src = await openSource(path)
  const m = src.meta
  const swap = src.orientation >= 5 && src.orientation <= 8
  const pages = m.pages && m.pages > 1 ? m.pages : 1
  return {
    path,
    kind: 'image',
    sizeBytes: st.size,
    format: src.format,
    width: swap ? m.height : m.width,
    height: swap ? m.width : m.height,
    rotation: ROTATION[src.orientation] ?? 0,
    hasAudio: false,
    hasAlpha: !!m.hasAlpha,
    frameCount: pages,
    pixFmt: `${m.space}${m.depth === 'ushort' ? '16' : ''}`,
  }
}

async function processImage(req: ImageProcessRequest): Promise<ImageProcessResult> {
  const { signal } = req
  throwIfAborted(signal)
  const src = await openSource(req.source, signal)
  const format = resolveFormat(req.output, req.source)
  const built = await buildOutput({ src, actions: req.actions ?? [], output: req.output, format, vars: varsFor(req.source), signal })
  throwIfAborted(signal)
  const info = await built.pipeline.toFile(req.dest)
  if (signal?.aborted) {
    await unlink(req.dest).catch(() => undefined)
    throw abortError()
  }
  return { width: built.width, height: built.height, bytes: info.size, format }
}

/** Fit an encoded result into maxSize and make sure a browser can show it. */
async function displayable(encoded: Buffer, format: ImageFormat, w: number, h: number, maxSize: number): Promise<{ buf: Buffer; mime: string }> {
  if (DISPLAYABLE.has(format) && w <= maxSize && h <= maxSize) return { buf: encoded, mime: mimeFor(format) }
  const img = sharp(encoded, SHARP_OPTS)
  const meta = await img.metadata()
  const shrink = w > maxSize || h > maxSize
  const p = shrink ? img.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true }) : img
  // lossless when transcoding at full size (tiff/avif) or with alpha; high-quality jpeg for downscaled photos
  if (meta.hasAlpha || !shrink) return { buf: await p.png({ compressionLevel: 3 }).toBuffer(), mime: 'image/png' }
  return { buf: await p.jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer(), mime: 'image/jpeg' }
}

async function beforeImage(src: DecodedSource, maxSize: number): Promise<{ buf: Buffer; mime: string }> {
  const p = sharp(src.input, SHARP_OPTS).autoOrient().resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  if (src.meta.hasAlpha) return { buf: await p.png({ compressionLevel: 3 }).toBuffer(), mime: 'image/png' }
  return { buf: await p.jpeg({ quality: 88 }).toBuffer(), mime: 'image/jpeg' }
}

export const imageEngine: ImageEngine = {
  probe,

  outputExtension(output, sourcePath) {
    return extensionFor(resolveFormat(output, sourcePath))
  },

  process: processImage,

  async preview(req) {
    const maxSize = fitBox(req.maxSize)
    const src = await openSource(req.source)
    const format = resolveFormat(req.output, req.source)
    // Full-resolution chain (px parameters stay correct) + the real encoder, first frame only for animations.
    const built = await buildOutput({ src, actions: req.actions ?? [], output: req.output, format, vars: varsFor(req.source), stillOnly: true })
    const encoded = await built.pipeline.toBuffer()
    const [after, before] = await Promise.all([displayable(encoded, format, built.width, built.height, maxSize), beforeImage(src, maxSize)])
    return { before: before.buf, beforeMime: before.mime, after: after.buf, afterMime: after.mime, outWidth: built.width, outHeight: built.height }
  },

  async thumbnail(path, maxSize) {
    const box = fitBox(maxSize)
    const src = await openSource(path)
    return sharp(src.input, SHARP_OPTS)
      .autoOrient()
      .resize(box, box, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer()
  },

  renderWatermarkLayer,
  compositeWatermark,
}

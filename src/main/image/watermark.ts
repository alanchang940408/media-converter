// Watermark rendering (text via sharp/Pango, image logos incl. SVG). Also used as the PNG overlay for video.
import sharp, { type OverlayOptions, type Sharp } from 'sharp'
import type { ImageWatermark, TextWatermark, Watermark } from '../../shared/types'
import type { WatermarkLayer } from '../contracts'
import { extOf } from '../../shared/media'
import { openSource, SHARP_OPTS } from './decode'
import { anchorFractions, clamp, num, parseColor, today, toHex, TRANSPARENT, WHITE } from './util'

export interface WatermarkVars {
  name?: string
  date?: string
}

/** Pango family list (comma separated) that has CJK coverage on Windows, macOS and Linux. */
export const DEFAULT_FONT_FAMILIES = 'Microsoft JhengHei, Yu Gothic, PingFang TC, Noto Sans CJK TC, Segoe UI, sans-serif'

interface RgbaImage {
  data: Buffer
  width: number
  height: number
}

export function substituteTokens(text: string, vars?: WatermarkVars): string {
  return text.replace(/\{name\}/g, vars?.name ?? '').replace(/\{date\}/g, vars?.date ?? today())
}

export function escapeMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function fontFamilies(custom?: string): string {
  // keep only characters that are safe inside a Pango font description
  const c = (custom ?? '').replace(/[<>&"]/g, '').trim()
  return c ? `${c}, ${DEFAULT_FONT_FAMILIES}` : DEFAULT_FONT_FAMILIES
}

async function toRgba(img: Sharp): Promise<RgbaImage> {
  const { data, info } = await img.ensureAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`Unexpected watermark channel count ${info.channels}`)
  return { data, width: info.width, height: info.height }
}

const rawInput = (im: RgbaImage): { input: Buffer; raw: { width: number; height: number; channels: 4 } } => ({
  input: im.data,
  raw: { width: im.width, height: im.height, channels: 4 },
})

/** Shrink to fit inside maxW×maxH (never enlarges). */
async function fitInside(im: RgbaImage, maxW: number, maxH: number): Promise<RgbaImage> {
  if (im.width <= maxW && im.height <= maxH) return im
  return toRgba(sharp(im.data, { raw: { width: im.width, height: im.height, channels: 4 } }).resize(maxW, maxH, { fit: 'inside' }))
}

async function renderText(wm: TextWatermark, frameW: number, frameH: number, vars?: WatermarkVars): Promise<RgbaImage | null> {
  const text = substituteTokens(wm.text ?? '', vars)
  if (!text.trim()) return null
  const px = Math.max(1, Math.round((clamp(num(wm.fontSizePct, 5), 0.1, 100) / 100) * frameH))
  const color = toHex(parseColor(wm.color, WHITE))
  const { fx } = anchorFractions(wm.anchor)
  const markup = `<span foreground="${color}"${wm.bold ? ' weight="bold"' : ''}>${escapeMarkup(text)}</span>`
  // dpi 72 → 1pt = 1px, so the size in the font description is the em size in pixels
  const { data, info } = await sharp({
    text: { text: markup, font: `${fontFamilies(wm.fontFamily)} ${px}`, rgba: true, dpi: 72, align: fx === 0 ? 'left' : fx === 1 ? 'right' : 'centre' },
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`Unexpected text channel count ${info.channels}`)
  const glyphs: RgbaImage = { data, width: info.width, height: info.height }
  const tw = glyphs.width
  const th = glyphs.height

  // Layout relative to the text origin: optional box, optional blurred shadow, then the text.
  const pad = wm.background ? Math.max(1, Math.round(px * 0.3)) : 0
  const shadow = wm.shadow ? { d: Math.max(1, Math.round(px * 0.06)), sigma: Math.max(0.5, px * 0.05) } : null
  const spread = shadow ? Math.ceil(shadow.sigma * 3) : 0
  const rects = [{ x: 0, y: 0, w: tw, h: th }]
  if (pad) rects.push({ x: -pad, y: -pad, w: tw + 2 * pad, h: th + 2 * pad })
  if (shadow) rects.push({ x: shadow.d - spread, y: shadow.d - spread, w: tw + 2 * spread, h: th + 2 * spread })
  const minX = Math.min(...rects.map((r) => r.x))
  const minY = Math.min(...rects.map((r) => r.y))
  const W = Math.max(...rects.map((r) => r.x + r.w)) - minX
  const H = Math.max(...rects.map((r) => r.y + r.h)) - minY
  const ox = -minX
  const oy = -minY

  const layers: OverlayOptions[] = []
  if (wm.background) {
    const bg = parseColor(wm.background, { r: 0, g: 0, b: 0, alpha: 1 })
    layers.push({ input: { create: { width: tw + 2 * pad, height: th + 2 * pad, channels: 4, background: bg } }, left: ox - pad, top: oy - pad })
  }
  if (shadow) {
    // black copy of the glyph alpha, padded so the blur has room, then blurred
    const sw = tw + 2 * spread
    const sh = th + 2 * spread
    const buf = Buffer.alloc(sw * sh * 4)
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        buf[((y + spread) * sw + x + spread) * 4 + 3] = Math.round(glyphs.data[(y * tw + x) * 4 + 3] * 0.6)
      }
    }
    const blurred = await toRgba(sharp(buf, { raw: { width: sw, height: sh, channels: 4 } }).blur(shadow.sigma))
    layers.push({ ...rawInput(blurred), left: ox + shadow.d - spread, top: oy + shadow.d - spread })
  }
  layers.push({ ...rawInput(glyphs), left: ox, top: oy })
  return toRgba(sharp({ create: { width: W, height: H, channels: 4, background: TRANSPARENT } }).composite(layers))
}

async function renderLogo(wm: ImageWatermark, frameW: number): Promise<RgbaImage> {
  const targetW = Math.max(1, Math.round((clamp(num(wm.scalePct, 20), 0.1, 1000) / 100) * frameW))
  if (extOf(wm.path) === 'svg' || extOf(wm.path) === 'svgz') {
    // rasterise the vector at (about) the target size instead of scaling a 72 dpi bitmap
    const meta = await sharp(wm.path).metadata()
    const density = clamp((72 * targetW) / Math.max(1, meta.width || targetW), 1, 100000)
    return toRgba(sharp(wm.path, { density }).resize({ width: targetW }))
  }
  const src = await openSource(wm.path)
  return toRgba(sharp(src.input, SHARP_OPTS).autoOrient().resize({ width: targetW }))
}

/** Multiply alpha by opacity (in place). */
function bakeOpacity(im: RgbaImage, opacity: number): void {
  const o = clamp(num(opacity, 1), 0, 1)
  if (o >= 1) return
  for (let i = 3; i < im.data.length; i += 4) im.data[i] = Math.round(im.data[i] * o)
}

export async function renderWatermarkLayer(
  wm: Watermark,
  frameW: number,
  frameH: number,
  vars?: WatermarkVars,
): Promise<WatermarkLayer> {
  const fw = Math.max(1, Math.round(frameW))
  const fh = Math.max(1, Math.round(frameH))
  const margin = Math.round((clamp(num(wm.marginPct, 0), 0, 50) / 100) * Math.min(fw, fh))
  let im = wm.type === 'text' ? await renderText(wm, fw, fh, vars) : await renderLogo(wm, fw)
  if (!im) {
    // nothing to draw (empty text): a single transparent pixel keeps callers simple
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: TRANSPARENT } }).png().toBuffer()
    return { png, left: 0, top: 0, width: 1, height: 1 }
  }
  // larger than the frame (minus margins) → scale down
  const maxW = fw - 2 * margin >= 1 ? fw - 2 * margin : fw
  const maxH = fh - 2 * margin >= 1 ? fh - 2 * margin : fh
  im = await fitInside(im, maxW, maxH)
  bakeOpacity(im, wm.opacity)

  const { fx, fy } = anchorFractions(wm.anchor)
  const pos = (frame: number, size: number, f: number): number => {
    const p = f === 0 ? margin : f === 1 ? frame - size - margin : Math.round((frame - size) / 2)
    return clamp(p, 0, Math.max(0, frame - size))
  }
  const png = await sharp(im.data, { raw: { width: im.width, height: im.height, channels: 4 } }).png().toBuffer()
  return { png, left: pos(fw, im.width, fx), top: pos(fh, im.height, fy), width: im.width, height: im.height }
}

/** Composite a watermark onto an encoded image (e.g. a video frame). Returns JPEG. */
export async function compositeWatermark(input: Buffer, wm: Watermark, vars?: WatermarkVars): Promise<Buffer> {
  const meta = await sharp(input, SHARP_OPTS).metadata()
  const w = meta.autoOrient?.width ?? meta.width
  const h = meta.autoOrient?.height ?? meta.height
  const layer = await renderWatermarkLayer(wm, w, h, vars)
  return sharp(input, SHARP_OPTS)
    .autoOrient()
    .composite([{ input: layer.png, left: layer.left, top: layer.top }])
    .flatten({ background: WHITE })
    .jpeg({ quality: 90 })
    .toBuffer()
}

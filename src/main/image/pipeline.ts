// XnConvert-style action chain. Every enabled action runs strictly in order: sharp reorders operations
// inside one pipeline, so each action is its own pipeline and the result is materialised losslessly
// (PNG level 0 for stills so EXIF/XMP/ICC can ride along, raw RGBA for animation frames).
import sharp, { type Channels, type FitEnum, type Sharp } from 'sharp'
import type { ImageAction, ImageFormat, ImageOutputSettings, Watermark } from '../../shared/types'
import type { WatermarkLayer } from '../contracts'
import { type DecodedSource, SHARP_OPTS } from './decode'
import { ANIMATABLE, applyEncoder, applyIntermediateMeta, applyOutputMeta, type MetaMode } from './output'
import { anchorFractions, clamp, num, parseColor, type Rgba, throwIfAborted, TRANSPARENT, WHITE } from './util'
import { renderWatermarkLayer, type WatermarkVars } from './watermark'

type Stage =
  | { kind: 'src'; input: string | Buffer }
  | { kind: 'png'; buf: Buffer }
  | { kind: 'raw'; buf: Buffer; width: number; height: number; channels: Channels }

interface ImgState {
  stage: Stage
  width: number
  height: number
  hasAlpha: boolean
  /** 1–2 bands (b-w); colour operations convert as needed. */
  gray: boolean
  /** 16-bit samples (only possible on the untouched source; intermediates are 8-bit). */
  depth16: boolean
  /** EXIF orientation that autoOrient would apply. */
  orientation: number
  /** The stage still carries the EXIF orientation tag (so sharp's autoOrient() can read it). */
  tagged: boolean
}

interface ChainCtx {
  meta: MetaMode
  inter: 'png' | 'raw'
  vars: WatermarkVars
  signal?: AbortSignal
  wmCache: Map<string, Promise<WatermarkLayer>>
}

const SEPIA: [[number, number, number], [number, number, number], [number, number, number]] = [
  [0.393, 0.769, 0.189],
  [0.349, 0.686, 0.168],
  [0.272, 0.534, 0.131],
]

/** sharp's EXIF table: rotate first, then mirror horizontally. */
const ORIENT: Record<number, { rot: number; flop: boolean }> = {
  1: { rot: 0, flop: false },
  2: { rot: 0, flop: true },
  3: { rot: 180, flop: false },
  4: { rot: 180, flop: true },
  5: { rot: 90, flop: true },
  6: { rot: 90, flop: false },
  7: { rot: 270, flop: true },
  8: { rot: 270, flop: false },
}

function open(stage: Stage): Sharp {
  if (stage.kind === 'raw') {
    return sharp(stage.buf, { ...SHARP_OPTS, raw: { width: stage.width, height: stage.height, channels: stage.channels } })
  }
  return sharp(stage.kind === 'src' ? stage.input : stage.buf, SHARP_OPTS)
}

async function materialize(img: Sharp, ctx: ChainCtx, prev: ImgState, patch?: Partial<ImgState>): Promise<ImgState> {
  throwIfAborted(ctx.signal)
  let stage: Stage
  let width: number
  let height: number
  let channels: number
  if (ctx.inter === 'raw') {
    const { data, info } = await img.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
    stage = { kind: 'raw', buf: data, width: info.width, height: info.height, channels: info.channels }
    ;({ width, height, channels } = info)
  } else {
    const { data, info } = await applyIntermediateMeta(img, ctx.meta).png({ compressionLevel: 0, force: true }).toBuffer({ resolveWithObject: true })
    stage = { kind: 'png', buf: data }
    ;({ width, height, channels } = info)
  }
  const keepsTag = ctx.inter === 'png' && ctx.meta !== 'strip'
  return {
    ...prev,
    tagged: keepsTag && prev.tagged,
    ...patch,
    stage,
    width,
    height,
    hasAlpha: channels === 2 || channels === 4,
    gray: channels <= 2,
    depth16: false,
  }
}

/**
 * How an action affects colour. sharp converts every output to sRGB unless told otherwise, so grey
 * images are kept single-band explicitly: 'preserve' stays grey if the input was grey.
 */
type Colour = 'preserve' | 'color' | 'gray'

function run(st: ImgState, ctx: ChainCtx, fn: (img: Sharp) => Sharp, patch?: Partial<ImgState>, colour: Colour = 'preserve'): Promise<ImgState> {
  const input = open(st.stage)
  // colour-introducing ops on grey input (coloured canvas/background) must already work in sRGB
  let img = fn(colour === 'color' && st.gray ? input.pipelineColourspace('srgb') : input)
  if (colour === 'gray' || (colour === 'preserve' && st.gray)) img = img.toColourspace('b-w')
  return materialize(img, ctx, st, patch)
}

const neutral = (c: Rgba): boolean => c.r === c.g && c.g === c.b

const posInt = (v: unknown): number | undefined => {
  const n = num(v, 0)
  return n > 0 ? Math.max(1, Math.round(n)) : undefined
}

function parseAspect(s: string | undefined): number | null {
  if (!s) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s)
  const r = m ? Number(m[1]) / Number(m[2]) : Number(s)
  return Number.isFinite(r) && r > 0 ? r : null
}

/** Exponent steps for out = in^e using sharp.gamma (each step limited to 1/3..3). */
function gammaSteps(gamma: number): number[] {
  let e = 1 / clamp(gamma, 0.1, 3)
  const steps: number[] = []
  while (e > 3 + 1e-9) {
    steps.push(3)
    e /= 3
  }
  if (Math.abs(e - 1) > 1e-6) steps.push(e)
  return steps
}

async function applyAction(st: ImgState, a: ImageAction, ctx: ChainCtx): Promise<ImgState> {
  const W = st.width
  const H = st.height
  switch (a.type) {
    case 'resize': {
      let w: number | undefined
      let h: number | undefined
      let fit: keyof FitEnum = 'inside'
      switch (a.mode) {
        case 'fit':
          w = posInt(a.width)
          h = posInt(a.height)
          break
        case 'fill':
        case 'stretch':
          w = posInt(a.width)
          h = posInt(a.height)
          if (w && h) fit = a.mode === 'fill' ? 'cover' : 'fill'
          break
        case 'percent': {
          const p = num(a.percent, 100)
          if (!(p > 0) || p === 100) return st
          if (p > 100 && a.withoutEnlargement) return st
          w = Math.max(1, Math.round((W * p) / 100))
          h = Math.max(1, Math.round((H * p) / 100))
          fit = 'fill'
          break
        }
        case 'longEdge':
        case 'shortEdge': {
          const s = posInt(a.size)
          if (!s) return st
          const widthIsEdge = a.mode === 'longEdge' ? W >= H : W <= H
          if (widthIsEdge) w = s
          else h = s
          break
        }
        case 'width':
          w = posInt(a.width ?? a.size)
          break
        case 'height':
          h = posInt(a.height ?? a.size)
          break
      }
      if (!w && !h) return st
      return run(st, ctx, (img) =>
        img.resize({ width: w, height: h, fit, position: 'centre', kernel: a.kernel ?? 'lanczos3', withoutEnlargement: !!a.withoutEnlargement }),
      )
    }

    case 'crop': {
      if (a.mode === 'aspect') {
        const r = parseAspect(a.aspect)
        if (!r) return st
        const cw = W / H > r ? Math.max(1, Math.min(W, Math.round(H * r))) : W
        const ch = W / H > r ? H : Math.max(1, Math.min(H, Math.round(W / r)))
        if (cw === W && ch === H) return st
        if (a.gravity === 'attention' || a.gravity === 'entropy') {
          const position = a.gravity === 'attention' ? sharp.strategy.attention : sharp.strategy.entropy
          return run(st, ctx, (img) => img.resize({ width: cw, height: ch, fit: 'cover', position }))
        }
        const { fx, fy } = anchorFractions(a.gravity)
        const left = Math.round((W - cw) * fx)
        const top = Math.round((H - ch) * fy)
        return run(st, ctx, (img) => img.extract({ left, top, width: cw, height: ch }))
      }
      let left: number
      let top: number
      let width: number
      let height: number
      if (a.mode === 'edges') {
        const e = a.edges ?? { top: 0, right: 0, bottom: 0, left: 0 }
        const px = (v: unknown): number => Math.max(0, Math.round(num(v, 0)))
        left = Math.min(px(e.left), W - 1)
        top = Math.min(px(e.top), H - 1)
        width = Math.max(1, W - left - px(e.right))
        height = Math.max(1, H - top - px(e.bottom))
      } else {
        left = clamp(Math.round(num(a.left, 0)), 0, W - 1)
        top = clamp(Math.round(num(a.top, 0)), 0, H - 1)
        width = clamp(Math.round(num(a.width, W - left)), 1, W - left)
        height = clamp(Math.round(num(a.height, H - top)), 1, H - top)
      }
      if (left === 0 && top === 0 && width === W && height === H) return st
      return run(st, ctx, (img) => img.extract({ left, top, width, height }))
    }

    case 'rotate': {
      const angle = ((num(a.angle, 0) % 360) + 360) % 360
      if (angle === 0) return st
      if (angle % 90 === 0) return run(st, ctx, (img) => img.rotate(angle))
      const background = parseColor(a.background, st.hasAlpha ? TRANSPARENT : WHITE)
      return run(st, ctx, (img) => img.rotate(angle, { background }), undefined, neutral(background) ? 'preserve' : 'color')
    }

    case 'flip':
      return run(st, ctx, (img) => (a.axis === 'vertical' ? img.flip() : img.flop()))

    case 'autoOrient': {
      const o = ORIENT[st.orientation] ? st.orientation : 1
      if (o === 1) return st
      if (st.tagged) return run(st, ctx, (img) => img.autoOrient(), { orientation: 1, tagged: false })
      // tag already stripped by an earlier stage: apply the remembered orientation by hand.
      // sharp runs flop before an explicit rotate, and flop∘rot(r) = rot(-r)∘flop.
      const { rot, flop } = ORIENT[o]
      return run(st, ctx, (img) => (flop ? img.flop().rotate((360 - rot) % 360) : img.rotate(rot)), { orientation: 1, tagged: false })
    }

    case 'adjust': {
      const brightness = clamp(num(a.brightness, 0), -100, 100)
      const contrast = clamp(num(a.contrast, 0), -100, 100)
      const saturation = clamp(num(a.saturation, 0), -100, 100)
      const hue = Math.round(clamp(num(a.hue, 0), -180, 180))
      const gamma = clamp(num(a.gamma, 1), 0.1, 3)
      let s = st
      if (brightness !== 0 || contrast !== 0 || saturation !== 0 || hue !== 0) {
        const k = 1 + contrast / 100
        const mid = st.depth16 ? 32768 : 128
        s = await run(s, ctx, (img) => {
          let p = img
          if (contrast !== 0) p = p.linear(k, mid * (1 - k))
          if (brightness !== 0 || saturation !== 0 || hue !== 0) {
            p = p.modulate({ brightness: 1 + brightness / 100, saturation: 1 + saturation / 100, hue: ((hue % 360) + 360) % 360 })
          }
          return p
        })
      }
      for (const e of gammaSteps(gamma)) {
        // sharp.gamma(a, b): in^a before, in^(1/b) after — both limited to 1..3
        s = await run(s, ctx, (img) => (e >= 1 ? img.gamma(e, 1) : img.gamma(1, 1 / e)))
      }
      return s
    }

    case 'grayscale':
      return run(st, ctx, (img) => img.grayscale(), undefined, 'gray')

    case 'sepia':
      return run(st, ctx, (img) => img.recomb(SEPIA), undefined, 'color')

    case 'invert':
      return run(st, ctx, (img) => img.negate({ alpha: false }))

    case 'sharpen': {
      const sigma = num(a.sigma, 0)
      if (!(sigma > 0)) return st
      return run(st, ctx, (img) => img.sharpen({ sigma: clamp(sigma, 0.01, 1000) }))
    }

    case 'blur': {
      const sigma = num(a.sigma, 0)
      if (!(sigma > 0)) return st
      return run(st, ctx, (img) => img.blur(clamp(sigma, 0.3, 1000)))
    }

    case 'canvas': {
      const base = Math.min(W, H)
      const px = (v: unknown): number => Math.max(0, Math.round(a.unit === 'pct' ? (num(v, 0) / 100) * base : num(v, 0)))
      const e = { top: px(a.top), right: px(a.right), bottom: px(a.bottom), left: px(a.left) }
      if (!e.top && !e.right && !e.bottom && !e.left) return st
      const background = parseColor(a.color, WHITE)
      return run(st, ctx, (img) => img.extend({ ...e, background }), undefined, neutral(background) ? 'preserve' : 'color')
    }

    case 'trim':
      return run(st, ctx, (img) => img.trim({ threshold: Math.max(0, num(a.threshold, 10)) }))

    case 'watermark': {
      const layer = await watermarkLayer(a.watermark, W, H, ctx)
      return run(st, ctx, (img) => {
        const p = img.composite([{ input: layer.png, left: layer.left, top: layer.top }])
        // composite adds an alpha band; drop it again for opaque images
        return st.hasAlpha ? p : p.removeAlpha()
      }, undefined, 'color')
    }
  }
  return st
}

function watermarkLayer(wm: Watermark, w: number, h: number, ctx: ChainCtx): Promise<WatermarkLayer> {
  const key = `${w}x${h}|${JSON.stringify(wm)}`
  let p = ctx.wmCache.get(key)
  if (!p) {
    p = renderWatermarkLayer(wm, w, h, ctx.vars)
    ctx.wmCache.set(key, p)
  }
  return p
}

async function runChain(st0: ImgState, actions: ImageAction[], ctx: ChainCtx): Promise<ImgState> {
  let st = st0
  for (const a of actions) {
    throwIfAborted(ctx.signal)
    st = await applyAction(st, a, ctx)
  }
  throwIfAborted(ctx.signal)
  return st
}

/**
 * Actions whose result depends only on the frame size and their parameters, so applying them to every
 * frame yields equally sized frames. Frames are processed one by one (not via sharp's own multi-page
 * support), which also makes canvas, crop edges and free-angle rotate safe. trim and attention/entropy
 * crops depend on frame content and could produce different sizes per frame.
 */
function animationSafe(a: ImageAction, orientation: number): boolean {
  switch (a.type) {
    case 'trim':
      return false
    case 'crop':
      return a.gravity !== 'attention' && a.gravity !== 'entropy'
    case 'autoOrient':
      return orientation <= 1
    default:
      return true
  }
}

export interface BuiltOutput {
  /** Pipeline with format + metadata applied; call toFile()/toBuffer(). */
  pipeline: Sharp
  width: number
  height: number
  format: ImageFormat
  animated: boolean
  frames: number
}

export interface BuildRequest {
  src: DecodedSource
  actions: ImageAction[]
  output: ImageOutputSettings
  format: ImageFormat
  vars: WatermarkVars
  signal?: AbortSignal
  /** Preview: never assemble animations, process the first frame only. */
  stillOnly?: boolean
}

export function shouldAnimate(src: DecodedSource, format: ImageFormat, actions: ImageAction[]): boolean {
  const pages = src.meta.pages ?? 1
  if (pages <= 1 || src.viaFfmpeg) return false
  if (src.meta.format !== 'gif' && src.meta.format !== 'webp') return false
  if (!ANIMATABLE.has(format)) return false
  return actions.every((a) => animationSafe(a, src.orientation))
}

export async function buildOutput(req: BuildRequest): Promise<BuiltOutput> {
  const actions = req.actions.filter((a) => a && a.enabled)
  if (!req.stillOnly && shouldAnimate(req.src, req.format, actions)) return buildAnimated(req, actions)
  return buildStill(req, actions)
}

async function buildStill(req: BuildRequest, actions: ImageAction[]): Promise<BuiltOutput> {
  const { src, output } = req
  const meta: MetaMode = !output.keepMetadata ? 'strip' : src.meta.space === 'cmyk' ? 'keepNoIcc' : 'keep'
  const ctx: ChainCtx = { meta, inter: 'png', vars: req.vars, signal: req.signal, wmCache: new Map() }
  const orientation = src.orientation >= 1 && src.orientation <= 8 ? src.orientation : 1
  let st: ImgState = {
    stage: { kind: 'src', input: src.input },
    width: src.meta.width,
    height: src.meta.height,
    hasAlpha: !!src.meta.hasAlpha,
    gray: src.meta.space === 'b-w' || src.meta.space === 'grey16',
    depth16: src.meta.depth === 'ushort',
    orientation,
    tagged: orientation > 1,
  }
  st = await runChain(st, actions, ctx)
  // Encoding straight from the source with a DPI would carry its EXIF (incl. orientation) along.
  if (st.stage.kind === 'src' && meta === 'strip' && num(output.dpi, 0) > 0) st = await materialize(open(st.stage), ctx, st)
  let img = applyOutputMeta(open(st.stage), meta, { dpi: output.dpi, gray: st.gray })
  // grey stays single-band (smaller files) unless a coloured jpeg background has to show through alpha
  const flattenColour = st.hasAlpha && req.format === 'jpeg' && !neutral(parseColor(output.background, WHITE))
  if (st.gray && !flattenColour) img = img.toColourspace('b-w')
  img = applyEncoder(img, req.format, output, { hasAlpha: st.hasAlpha })
  return { pipeline: img, width: st.width, height: st.height, format: req.format, animated: false, frames: 1 }
}

async function buildAnimated(req: BuildRequest, actions: ImageAction[]): Promise<BuiltOutput> {
  const { src, signal } = req
  const { data, info } = await sharp(src.input, { ...SHARP_OPTS, animated: true })
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  const pages = Math.max(1, info.pages ?? src.meta.pages ?? 1)
  const fw = info.width
  const fh = info.pageHeight ?? Math.round(info.height / pages)
  const frameBytes = fw * fh * 4
  const ctx: ChainCtx = { meta: 'strip', inter: 'raw', vars: req.vars, signal, wmCache: new Map() }
  const frames: Buffer[] = new Array(pages)
  let ow = 0
  let oh = 0

  const processFrame = async (i: number): Promise<void> => {
    throwIfAborted(signal)
    const st0: ImgState = {
      stage: { kind: 'raw', buf: data.subarray(i * frameBytes, (i + 1) * frameBytes), width: fw, height: fh, channels: 4 },
      width: fw,
      height: fh,
      hasAlpha: true,
      gray: false,
      depth16: false,
      orientation: 1,
      tagged: false,
    }
    const st = await runChain(st0, actions, ctx)
    const out = await open(st.stage).toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true })
    if (i === 0) {
      ow = out.info.width
      oh = out.info.height
    } else if (out.info.width !== ow || out.info.height !== oh) {
      throw new Error('Animation frames ended up with different sizes')
    }
    frames[i] = out.data
  }

  // first frame alone fixes the output size, the rest run a few at a time
  await processFrame(0)
  let next = 1
  const worker = async (): Promise<void> => {
    while (next < pages) await processFrame(next++)
  }
  await Promise.all(Array.from({ length: Math.min(4, pages - 1) }, worker))
  throwIfAborted(signal)

  const delay = src.meta.delay && src.meta.delay.length === pages ? src.meta.delay : undefined
  const img = sharp(Buffer.concat(frames), { raw: { width: ow, height: oh * pages, channels: 4, pageHeight: oh } })
  const pipeline = applyEncoder(img, req.format, req.output, { hasAlpha: true, anim: { loop: src.meta.loop ?? 0, delay } })
  return { pipeline, width: ow, height: oh, format: req.format, animated: true, frames: pages }
}

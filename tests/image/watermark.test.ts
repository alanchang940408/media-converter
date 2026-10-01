import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { imageEngine } from '../../src/main/image'
import { escapeMarkup, substituteTokens } from '../../src/main/image/watermark'
import type { TextWatermark, Watermark } from '../../src/shared/types'
import type { WatermarkLayer } from '../../src/main/contracts'
import { type Fixtures, makeFixtures, near, pixelAt, pixels, RED } from './fixtures'

let fx: Fixtures
const SAMPLES = resolve(__dirname, '../../test-output/image-samples')

beforeAll(async () => {
  fx = await makeFixtures()
  mkdirSync(SAMPLES, { recursive: true })
})
afterAll(() => fx?.cleanup())

const text = (over: Partial<TextWatermark>): TextWatermark => ({
  type: 'text',
  text: 'Sample',
  fontSizePct: 10,
  color: '#ff2050',
  anchor: 'bottom-right',
  marginPct: 3,
  opacity: 1,
  ...over,
})

/** Alpha statistics of a layer PNG. */
async function alphaStats(layer: WatermarkLayer): Promise<{ opaque: number; max: number; mask: Buffer }> {
  const px = await pixels(layer.png)
  expect(px.channels).toBe(4)
  const mask = Buffer.alloc(px.width * px.height)
  let opaque = 0
  let max = 0
  for (let i = 0; i < mask.length; i++) {
    const a = px.data[i * 4 + 3]
    mask[i] = a
    if (a > 128) opaque++
    if (a > max) max = a
  }
  return { opaque, max, mask }
}

/** Render a layer onto a frame-sized dark-grey backdrop and save it as a sample PNG. */
async function saveOnFrame(layer: WatermarkLayer, w: number, h: number, name: string): Promise<void> {
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: '#2b2f36' } })
    .composite([{ input: layer.png, left: layer.left, top: layer.top }])
    .png()
    .toBuffer()
  writeFileSync(join(SAMPLES, name), png)
}

describe('text watermark', () => {
  it('tokens and markup escaping', () => {
    expect(substituteTokens('{name} – {date}', { name: '旅行 照片', date: '2026-10-01' })).toBe('旅行 照片 – 2026-10-01')
    expect(substituteTokens('{date}')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(escapeMarkup('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&apos;&lt;/b&gt;')
  })

  it('renders Chinese glyphs (not empty, not tofu) near the bottom-right anchor', async () => {
    const W = 960
    const H = 540
    const zh = await imageEngine.renderWatermarkLayer(text({ text: '浮水印測試 {name}' }), W, H, { name: '旅行照片' })
    const margin = Math.round(0.03 * H)
    expect(zh.left + zh.width).toBe(W - margin)
    expect(zh.top + zh.height).toBe(H - margin)
    // font size = 10% of frame height = 54 px → the text box is at least that tall
    expect(zh.height).toBeGreaterThanOrEqual(40)
    const s = await alphaStats(zh)
    expect(s.opaque).toBeGreaterThan(zh.width * zh.height * 0.05)
    await saveOnFrame(zh, W, H, 'watermark_zh.png')

    // tofu boxes would look the same for any CJK string; real glyphs differ
    const a = await imageEngine.renderWatermarkLayer(text({ text: '浮水印', anchor: 'top-left' }), W, H)
    const b = await imageEngine.renderWatermarkLayer(text({ text: '測試字', anchor: 'top-left' }), W, H)
    const ma = (await alphaStats(a)).mask
    const mb = (await alphaStats(b)).mask
    const n = Math.min(ma.length, mb.length)
    let diff = 0
    for (let i = 0; i < n; i++) if (Math.abs(ma[i] - mb[i]) > 100) diff++
    expect(diff / n).toBeGreaterThan(0.05)
  })

  it('renders Japanese text with shadow and background box', async () => {
    const W = 960
    const H = 540
    const plain = await imageEngine.renderWatermarkLayer(text({ text: '透かしテスト ひらがな', anchor: 'top-left', color: '#ffffff' }), W, H)
    const boxed = await imageEngine.renderWatermarkLayer(
      text({ text: '透かしテスト ひらがな', anchor: 'top-left', color: '#ffffff', shadow: true, background: '#1060c0', bold: true, opacity: 0.8 }),
      W,
      H,
    )
    expect(boxed.width).toBeGreaterThan(plain.width)
    expect(boxed.height).toBeGreaterThan(plain.height)
    const margin = Math.round(0.03 * H)
    expect([boxed.left, boxed.top]).toEqual([margin, margin])
    // box corner: background colour with alpha = opacity
    const corner = await pixelAt(boxed.png, 1, 1)
    expect(near(corner, [16, 96, 192], 2)).toBe(true)
    expect(Math.abs(corner[3] - 204)).toBeLessThanOrEqual(2)
    expect((await alphaStats(plain)).opaque).toBeGreaterThan(plain.width * plain.height * 0.05)
    await saveOnFrame(plain, W, H, 'watermark_ja.png')
    await saveOnFrame(boxed, W, H, 'watermark_ja_box_shadow.png')
  })

  it('bakes opacity into alpha', async () => {
    const half = await imageEngine.renderWatermarkLayer(text({ text: 'OPACITY', opacity: 0.5 }), 640, 360)
    const s = await alphaStats(half)
    expect(s.max).toBeGreaterThan(110)
    expect(s.max).toBeLessThanOrEqual(128)
  })

  it('scales down text larger than the frame', async () => {
    const layer = await imageEngine.renderWatermarkLayer(text({ text: '非常長的浮水印文字非常長的浮水印文字', fontSizePct: 40, marginPct: 5 }), 320, 180)
    const margin = Math.round(0.05 * 180)
    expect(layer.width).toBeLessThanOrEqual(320 - 2 * margin)
    expect(layer.left).toBeGreaterThanOrEqual(0)
    expect(layer.top).toBeGreaterThanOrEqual(0)
  })

  it('empty text yields a 1×1 transparent layer', async () => {
    const layer = await imageEngine.renderWatermarkLayer(text({ text: '   ' }), 640, 360)
    expect([layer.width, layer.height]).toEqual([1, 1])
    expect((await pixelAt(layer.png, 0, 0))[3]).toBe(0)
  })

  it('markup characters render literally instead of breaking Pango', async () => {
    const layer = await imageEngine.renderWatermarkLayer(text({ text: '<b>A & B</b> "q" \'s\'' }), 640, 360)
    expect(layer.width).toBeGreaterThan(50)
  })
})

describe('image watermark', () => {
  const logo = (over: Partial<Watermark>): Watermark => ({ type: 'image', path: fx.logo, scalePct: 10, anchor: 'top-left', marginPct: 5, opacity: 1, ...over }) as Watermark

  it('anchors: top-left vs bottom-right vs center', async () => {
    const W = 400
    const H = 200
    const margin = Math.round(0.05 * 200)
    const tl = await imageEngine.renderWatermarkLayer(logo({ anchor: 'top-left' }), W, H)
    expect([tl.width, tl.height]).toEqual([40, 40])
    expect([tl.left, tl.top]).toEqual([margin, margin])
    const br = await imageEngine.renderWatermarkLayer(logo({ anchor: 'bottom-right' }), W, H)
    expect([br.left, br.top]).toEqual([W - 40 - margin, H - 40 - margin])
    const c = await imageEngine.renderWatermarkLayer(logo({ anchor: 'center' }), W, H)
    expect([c.left, c.top]).toEqual([180, 80])
    const top = await imageEngine.renderWatermarkLayer(logo({ anchor: 'top' }), W, H)
    expect([top.left, top.top]).toEqual([180, margin])
    const right = await imageEngine.renderWatermarkLayer(logo({ anchor: 'right' }), W, H)
    expect([right.left, right.top]).toEqual([W - 40 - margin, 80])
    expect(near(await pixelAt(tl.png, 20, 20), [...RED, 255], 0)).toBe(true)
  })

  it('opacity and scale-down when larger than the frame', async () => {
    const half = await imageEngine.renderWatermarkLayer(logo({ opacity: 0.5 }), 400, 200)
    expect(Math.abs((await pixelAt(half.png, 5, 5))[3] - 128)).toBeLessThanOrEqual(1)
    const huge = await imageEngine.renderWatermarkLayer(logo({ scalePct: 300, marginPct: 0 }), 400, 200)
    expect(huge.width).toBeLessThanOrEqual(400)
    expect(huge.height).toBeLessThanOrEqual(200)
    expect([huge.width, huge.height, huge.left, huge.top]).toEqual([200, 200, 0, 0])
  })

  it('SVG logos are rasterised at the target size', async () => {
    const layer = await imageEngine.renderWatermarkLayer(logo({ path: fx.logoSvg, scalePct: 50, marginPct: 0 }), 800, 600)
    expect([layer.width, layer.height]).toEqual([400, 200])
    expect(near(await pixelAt(layer.png, 200, 100), [0, 0, 255, 255], 1)).toBe(true)
  })

  it('compositeWatermark returns a JPEG with the watermark drawn', async () => {
    const frame = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#ffffff' } }).png().toBuffer()
    const jpg = await imageEngine.compositeWatermark(frame, logo({ anchor: 'bottom-right', marginPct: 0, scalePct: 25 }))
    const m = await sharp(jpg).metadata()
    expect(m.format).toBe('jpeg')
    expect([m.width, m.height]).toEqual([320, 180])
    expect(near(await pixelAt(jpg, 300, 170), RED, 12)).toBe(true)
    expect(near(await pixelAt(jpg, 10, 10), [255, 255, 255], 3)).toBe(true)
    const withText = await imageEngine.compositeWatermark(frame, text({ text: '影片 プレビュー', color: '#000000' }))
    writeFileSync(join(SAMPLES, 'composite_text.jpg'), withText)
  })
})

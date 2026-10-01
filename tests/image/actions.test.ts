import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { imageEngine } from '../../src/main/image'
import type { ImageAction, ImageOutputSettings } from '../../src/shared/types'
import { act, BLUE, type Fixtures, GREEN, makeFixtures, near, out, pixelAt, pixels, quadrantRaw, RED, tmpPath, WHITE } from './fixtures'

let fx: Fixtures
let k = 0

beforeAll(async () => {
  fx = await makeFixtures()
})
afterAll(() => fx?.cleanup())

/** Run a chain and return the written file path + result. */
async function runChain(source: string, actions: ImageAction[], output: Partial<ImageOutputSettings> = {}) {
  const dest = tmpPath(fx, `out-${++k}.png.part`)
  const res = await imageEngine.process({ source, actions, output: out(output), dest })
  return { dest, res }
}

describe('resize', () => {
  it('fit keeps aspect inside the box', async () => {
    const { res } = await runChain(fx.quad, [act({ type: 'resize', mode: 'fit', width: 60, height: 60, withoutEnlargement: false })])
    expect([res.width, res.height]).toEqual([60, 40])
  })

  it('fill covers the box and centre-crops', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'resize', mode: 'fill', width: 60, height: 60, withoutEnlargement: false })])
    expect([res.width, res.height]).toEqual([60, 60])
    expect(near(await pixelAt(dest, 2, 2), RED)).toBe(true)
    expect(near(await pixelAt(dest, 57, 2), GREEN)).toBe(true)
  })

  it('stretch ignores aspect', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'resize', mode: 'stretch', width: 50, height: 100, withoutEnlargement: false })])
    expect([res.width, res.height]).toEqual([50, 100])
    expect(near(await pixelAt(dest, 5, 5), RED)).toBe(true)
    expect(near(await pixelAt(dest, 45, 95), WHITE)).toBe(true)
  })

  it('percent / longEdge / shortEdge / width / height', async () => {
    const cases: [ImageAction, number, number][] = [
      [act({ type: 'resize', mode: 'percent', percent: 50, withoutEnlargement: false }), 60, 40],
      [act({ type: 'resize', mode: 'longEdge', size: 60, withoutEnlargement: false }), 60, 40],
      [act({ type: 'resize', mode: 'shortEdge', size: 40, withoutEnlargement: false }), 60, 40],
      [act({ type: 'resize', mode: 'width', width: 30, withoutEnlargement: false }), 30, 20],
      [act({ type: 'resize', mode: 'height', height: 20, withoutEnlargement: false }), 30, 20],
      [act({ type: 'resize', mode: 'percent', percent: 200, withoutEnlargement: false }), 240, 160],
    ]
    for (const [a, w, h] of cases) {
      const { res } = await runChain(fx.quad, [a])
      expect([res.width, res.height], `${(a as { mode: string }).mode}`).toEqual([w, h])
    }
  })

  it('withoutEnlargement prevents upscaling', async () => {
    const a = await runChain(fx.quad, [act({ type: 'resize', mode: 'width', width: 500, withoutEnlargement: true })])
    expect([a.res.width, a.res.height]).toEqual([120, 80])
    const b = await runChain(fx.quad, [act({ type: 'resize', mode: 'percent', percent: 300, withoutEnlargement: true })])
    expect([b.res.width, b.res.height]).toEqual([120, 80])
    const c = await runChain(fx.quad, [act({ type: 'resize', mode: 'width', width: 500, withoutEnlargement: false })])
    expect([c.res.width, c.res.height]).toEqual([500, 333])
  })

  it('kernel nearest keeps hard edges, lanczos3 rings at them', async () => {
    const nearest = await runChain(fx.step, [act({ type: 'resize', mode: 'width', width: 80, withoutEnlargement: false, kernel: 'nearest' })])
    expect((await pixelAt(nearest.dest, 39, 5))[0]).toBe(100)
    expect((await pixelAt(nearest.dest, 40, 5))[0]).toBe(150)
    const lanczos = await runChain(fx.step, [act({ type: 'resize', mode: 'width', width: 80, withoutEnlargement: false, kernel: 'lanczos3' })])
    const v = (await pixelAt(lanczos.dest, 40, 5))[0]
    expect(v).toBeGreaterThan(100)
    expect(v).toBeLessThan(150)
  })
})

describe('crop', () => {
  it('rect extracts the region', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'crop', mode: 'rect', left: 60, top: 0, width: 60, height: 40 })])
    expect([res.width, res.height]).toEqual([60, 40])
    expect(await pixelAt(dest, 0, 0)).toEqual(GREEN)
    expect(await pixelAt(dest, 59, 39)).toEqual(GREEN)
  })

  it('rect clamps to the image bounds', async () => {
    const { res } = await runChain(fx.quad, [act({ type: 'crop', mode: 'rect', left: 100, top: 70, width: 500, height: 500 })])
    expect([res.width, res.height]).toEqual([20, 10])
  })

  it('aspect crops the largest rect positioned by gravity', async () => {
    const centre = await runChain(fx.quad, [act({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity: 'center' })])
    expect([centre.res.width, centre.res.height]).toEqual([80, 80])
    expect(await pixelAt(centre.dest, 0, 0)).toEqual(RED) // x 20 of the source
    expect(await pixelAt(centre.dest, 79, 0)).toEqual(GREEN) // x 99

    const left = await runChain(fx.quad, [act({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity: 'left' })])
    expect(await pixelAt(left.dest, 59, 0)).toEqual(RED)
    expect(await pixelAt(left.dest, 60, 0)).toEqual(GREEN)

    const right = await runChain(fx.quad, [act({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity: 'right' })])
    expect(await pixelAt(right.dest, 19, 0)).toEqual(RED) // x 59
    expect(await pixelAt(right.dest, 20, 0)).toEqual(GREEN)

    const tall = await runChain(fx.quad, [act({ type: 'crop', mode: 'aspect', aspect: '9:16', gravity: 'top-left' })])
    expect([tall.res.width, tall.res.height]).toEqual([45, 80])
  })

  it('aspect with attention / entropy strategy', async () => {
    for (const gravity of ['attention', 'entropy'] as const) {
      const { res } = await runChain(fx.quad, [act({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity })])
      expect([res.width, res.height]).toEqual([80, 80])
    }
  })

  it('edges removes pixels from each side', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'crop', mode: 'edges', edges: { top: 10, right: 20, bottom: 30, left: 40 } })])
    expect([res.width, res.height]).toEqual([60, 40])
    expect(await pixelAt(dest, 0, 0)).toEqual(RED) // source (40,10)
    expect(await pixelAt(dest, 59, 39)).toEqual(WHITE) // source (99,49)
  })
})

describe('rotate / flip / autoOrient', () => {
  it('rotate 90 clockwise', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'rotate', angle: 90 })])
    expect([res.width, res.height]).toEqual([80, 120])
    expect(await pixelAt(dest, 79, 0)).toEqual(RED) // old top-left → top-right
    expect(await pixelAt(dest, 0, 0)).toEqual(BLUE)
  })

  it('free angle expands the canvas with white (opaque) or transparent (alpha) fill', async () => {
    const opaque = await runChain(fx.quad, [act({ type: 'rotate', angle: 45 })])
    expect(opaque.res.width).toBeGreaterThan(130)
    expect(near(await pixelAt(opaque.dest, 0, 0), WHITE, 2)).toBe(true)

    const alpha = await runChain(fx.alpha, [act({ type: 'rotate', angle: 30 })])
    expect((await pixelAt(alpha.dest, 0, 0))[3]).toBe(0)

    const colored = await runChain(fx.quad, [act({ type: 'rotate', angle: -30, background: '#00ff00' })])
    expect(near(await pixelAt(colored.dest, 0, 0), GREEN, 2)).toBe(true)
  })

  it('flip horizontal / vertical', async () => {
    const h = await runChain(fx.quad, [act({ type: 'flip', axis: 'horizontal' })])
    expect(await pixelAt(h.dest, 0, 0)).toEqual(GREEN)
    const v = await runChain(fx.quad, [act({ type: 'flip', axis: 'vertical' })])
    expect(await pixelAt(v.dest, 0, 0)).toEqual(BLUE)
  })

  it('EXIF orientation 6 is applied only by autoOrient', async () => {
    const without = await runChain(fx.orient6, [])
    expect([without.res.width, without.res.height]).toEqual([120, 80])
    const { dest, res } = await runChain(fx.orient6, [act({ type: 'autoOrient' })])
    expect([res.width, res.height]).toEqual([80, 120])
    expect(near(await pixelAt(dest, 75, 5), RED, 12)).toBe(true)
    expect(near(await pixelAt(dest, 5, 5), BLUE, 12)).toBe(true)
    expect(near(await pixelAt(dest, 75, 115), GREEN, 12)).toBe(true)
    expect(near(await pixelAt(dest, 5, 115), WHITE, 12)).toBe(true)
    // the orientation tag must not survive (it would rotate the pixels a second time)
    const kept = await runChain(fx.orient6, [act({ type: 'autoOrient' })], { keepMetadata: true })
    expect((await sharp(kept.dest).metadata()).orientation ?? 1).toBe(1)
    // without autoOrient + keepMetadata, the tag is preserved alongside the untouched pixels
    const tagged = await runChain(fx.orient6, [], { keepMetadata: true, format: 'jpeg' })
    expect((await sharp(tagged.dest).metadata()).orientation).toBe(6)
  })

  it('all 8 orientations: later autoOrient (tag already stripped) matches sharp autoOrient', async () => {
    const qr = quadrantRaw()
    const q = await sharp(qr.data, { raw: qr.raw })
      .png()
      .toBuffer()
    for (let o = 1; o <= 8; o++) {
      const src = tmpPath(fx, `orient-${o}.png`)
      await sharp(q).withMetadata({ orientation: o }).png().toFile(src)
      const reference = await sharp(src).autoOrient().raw().toBuffer({ resolveWithObject: true })
      const direct = await runChain(src, [act({ type: 'autoOrient' })])
      // invert twice = identity, but materialises a stage first (strip mode drops the tag → manual path)
      const manual = await runChain(src, [act({ type: 'invert' }), act({ type: 'invert' }), act({ type: 'autoOrient' })])
      // keep mode: tag rides along in the intermediates → sharp's own autoOrient on the intermediate
      const keep = await runChain(src, [act({ type: 'invert' }), act({ type: 'invert' }), act({ type: 'autoOrient' })], { keepMetadata: true })
      for (const r of [direct, manual, keep]) {
        const px = await pixels(r.dest)
        expect([px.width, px.height], `orientation ${o}`).toEqual([reference.info.width, reference.info.height])
        expect(px.data.equals(reference.data), `orientation ${o} pixels`).toBe(true)
      }
    }
  })
})

describe('adjust', () => {
  const adjust = (o: Partial<{ brightness: number; contrast: number; saturation: number; hue: number; gamma: number }>): ImageAction =>
    act({ type: 'adjust', brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1, ...o })

  it('defaults are identity', async () => {
    const { dest } = await runChain(fx.quad, [adjust({})])
    const a = await pixels(dest)
    const b = await pixels(fx.quad)
    expect(a.data.equals(b.data)).toBe(true)
  })

  it('brightness', async () => {
    const up = await runChain(fx.gray, [adjust({ brightness: 50 })])
    const down = await runChain(fx.gray, [adjust({ brightness: -50 })])
    expect((await pixelAt(up.dest, 5, 5))[0]).toBeGreaterThan(150)
    expect((await pixelAt(down.dest, 5, 5))[0]).toBeLessThan(100)
  })

  it('contrast = linear(a, 128(1-a)) around mid grey', async () => {
    const r = await runChain(fx.step, [adjust({ contrast: 50 })])
    // 100 → 1.5*100 - 64 = 86, 150 → 161
    expect(near(await pixelAt(r.dest, 5, 5), [86, 86, 86], 1)).toBe(true)
    expect(near(await pixelAt(r.dest, 35, 5), [161, 161, 161], 1)).toBe(true)
  })

  it('saturation -100 → grey, hue rotates colour', async () => {
    const s = await runChain(fx.quad, [adjust({ saturation: -100 })])
    const [r, g, b] = await pixelAt(s.dest, 5, 5)
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(6)
    const h = await runChain(fx.quad, [adjust({ hue: 120 })])
    const [hr, hg] = await pixelAt(h.dest, 5, 5)
    expect(hg).toBeGreaterThan(hr)
  })

  it('gamma over the full 0.1..3 range', async () => {
    const v = async (gamma: number): Promise<number> => (await pixelAt((await runChain(fx.gray, [adjust({ gamma })])).dest, 3, 3))[0]
    // out = 255 * (128/255)^(1/g)
    expect(Math.abs((await v(2)) - 181)).toBeLessThanOrEqual(1)
    expect(Math.abs((await v(3)) - 203)).toBeLessThanOrEqual(1)
    expect(Math.abs((await v(0.5)) - 64)).toBeLessThanOrEqual(1)
    expect(Math.abs((await v(0.25)) - 16)).toBeLessThanOrEqual(1)
    expect(await v(0.1)).toBeLessThanOrEqual(1)
  })
})

describe('colour filters', () => {
  it('grayscale produces a single-band image that stays grey through later actions', async () => {
    const { dest } = await runChain(fx.quad, [act({ type: 'grayscale' })])
    expect((await sharp(dest).metadata()).channels).toBe(1)
    const later = await runChain(fx.quad, [act({ type: 'grayscale' }), act({ type: 'resize', mode: 'width', width: 60, withoutEnlargement: false })], { format: 'jpeg' })
    expect((await sharp(later.dest).metadata()).channels).toBe(1)
    const alpha = await runChain(fx.alpha, [act({ type: 'grayscale' })])
    expect((await sharp(alpha.dest).metadata()).channels).toBe(2)
    // a coloured canvas brings colour back
    const canvas = await runChain(fx.quad, [act({ type: 'grayscale' }), act({ type: 'canvas', top: 5, right: 5, bottom: 5, left: 5, unit: 'px', color: '#ff0000' })])
    expect((await sharp(canvas.dest).metadata()).channels).toBe(3)
    expect(await pixelAt(canvas.dest, 0, 0)).toEqual(RED)
  })

  it('grayscale with keepMetadata on a P3 source does not fail', async () => {
    const { dest } = await runChain(fx.meta, [act({ type: 'grayscale' })], { keepMetadata: true, format: 'jpeg' })
    const m = await sharp(dest).metadata()
    expect(m.channels).toBe(1)
    expect(m.exif).toBeTruthy()
  })

  it('sepia tints grey towards brown', async () => {
    const { dest } = await runChain(fx.gray, [act({ type: 'sepia' })])
    const [r, g, b] = await pixelAt(dest, 3, 3)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    // 0.393*128 + 0.769*128 + 0.189*128 ≈ 173
    expect(Math.abs(r - 173)).toBeLessThanOrEqual(2)
  })

  it('sepia after grayscale works (recomb converts back to sRGB)', async () => {
    const { dest } = await runChain(fx.quad, [act({ type: 'grayscale' }), act({ type: 'sepia' })])
    expect((await sharp(dest).metadata()).channels).toBe(3)
  })

  it('invert keeps alpha', async () => {
    const { dest } = await runChain(fx.alpha, [act({ type: 'invert' })])
    expect(await pixelAt(dest, 5, 5)).toEqual([0, 255, 255, 255])
    expect((await pixelAt(dest, 95, 5))[3]).toBe(0)
  })

  it('sharpen overshoots and blur smooths a step edge', async () => {
    const sharp1 = await runChain(fx.step, [act({ type: 'sharpen', sigma: 1.5 })])
    expect((await pixelAt(sharp1.dest, 19, 10))[0]).toBeLessThan(100)
    const blur = await runChain(fx.step, [act({ type: 'blur', sigma: 2 })])
    const v = (await pixelAt(blur.dest, 19, 10))[0]
    expect(v).toBeGreaterThan(100)
    expect(v).toBeLessThan(150)
    // tiny sigma is clamped to 0.3 instead of failing
    const tiny = await runChain(fx.step, [act({ type: 'blur', sigma: 0.05 })])
    expect(tiny.res.width).toBe(40)
  })
})

describe('canvas / trim', () => {
  it('canvas in px with colour', async () => {
    const { dest, res } = await runChain(fx.quad, [act({ type: 'canvas', top: 10, right: 20, bottom: 30, left: 40, unit: 'px', color: '#00ff00' })])
    expect([res.width, res.height]).toEqual([180, 120])
    expect(await pixelAt(dest, 0, 0)).toEqual(GREEN)
    expect(await pixelAt(dest, 45, 15)).toEqual(RED)
  })

  it('canvas in % of the shorter side', async () => {
    const { res } = await runChain(fx.quad, [act({ type: 'canvas', top: 10, right: 10, bottom: 10, left: 10, unit: 'pct', color: '#000000' })])
    expect([res.width, res.height]).toEqual([136, 96])
  })

  it('trim removes a uniform border', async () => {
    const { dest, res } = await runChain(fx.bordered, [act({ type: 'trim', threshold: 10 })])
    expect([res.width, res.height]).toEqual([20, 20])
    expect(near(await pixelAt(dest, 0, 0), RED, 0)).toBe(true)
  })
})

describe('watermark action', () => {
  it('composites a logo at the anchor', async () => {
    const { dest, res } = await runChain(fx.white, [
      act({ type: 'watermark', watermark: { type: 'image', path: fx.logo, scalePct: 10, anchor: 'bottom-right', marginPct: 0, opacity: 1 } }),
    ])
    expect([res.width, res.height]).toEqual([200, 100])
    expect(await pixelAt(dest, 190, 90)).toEqual(RED)
    expect(await pixelAt(dest, 10, 10)).toEqual(WHITE)
    expect((await sharp(dest).metadata()).channels).toBe(3) // opaque stays opaque
  })
})

describe('chain semantics', () => {
  it('order matters: crop→resize ≠ resize→crop', async () => {
    const crop = act({ type: 'crop', mode: 'rect', left: 0, top: 0, width: 30, height: 20 })
    const resize = act({ type: 'resize', mode: 'percent', percent: 50, withoutEnlargement: false })
    const a = await runChain(fx.quad, [crop, resize])
    const b = await runChain(fx.quad, [resize, crop])
    expect([a.res.width, a.res.height]).toEqual([15, 10])
    expect([b.res.width, b.res.height]).toEqual([30, 20])
    // grow canvas then crop vs crop then grow: different content at the same spot
    const canvas = act({ type: 'canvas', top: 0, right: 0, bottom: 0, left: 60, unit: 'px', color: '#000000' })
    const crop2 = act({ type: 'crop', mode: 'rect', left: 0, top: 0, width: 60, height: 40 })
    const c = await runChain(fx.quad, [canvas, crop2])
    const d = await runChain(fx.quad, [crop2, canvas])
    expect(await pixelAt(c.dest, 70 - 60, 5)).toEqual([0, 0, 0])
    expect(await pixelAt(d.dest, 70, 5)).toEqual(RED)
  })

  it('disabled actions are skipped', async () => {
    const a = act({ type: 'resize', mode: 'width', width: 10, withoutEnlargement: false })
    const { res } = await runChain(fx.quad, [{ ...a, enabled: false }])
    expect([res.width, res.height]).toEqual([120, 80])
  })

  it('handles CJK + space source paths', async () => {
    const { res } = await runChain(fx.quadJpg, [act({ type: 'resize', mode: 'width', width: 60, withoutEnlargement: false })], { format: 'jpeg' })
    expect([res.width, res.height, res.format]).toEqual([60, 40, 'jpeg'])
  })
})

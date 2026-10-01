import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { imageEngine } from '../../src/main/image'
import type { ImageAction, ImageOutputSettings } from '../../src/shared/types'
import { act, BLUE, type Fixtures, GREEN, makeFixtures, near, out, pixelAt, RED, tmpPath } from './fixtures'

let fx: Fixtures
let k = 0
const SAMPLES = resolve(__dirname, '../../test-output/image-samples')

beforeAll(async () => {
  fx = await makeFixtures()
  mkdirSync(SAMPLES, { recursive: true })
})
afterAll(() => fx?.cleanup())

async function run(source: string, actions: ImageAction[], output: Partial<ImageOutputSettings> = {}, signal?: AbortSignal) {
  const dest = tmpPath(fx, `eng-${++k}.part`)
  const res = await imageEngine.process({ source, actions, output: out(output), dest, signal })
  return { dest, res }
}

describe('probe', () => {
  it('reports displayed size and rotation for EXIF orientation 6', async () => {
    const info = await imageEngine.probe(fx.orient6)
    expect(info.kind).toBe('image')
    expect(info.format).toBe('jpeg')
    expect([info.width, info.height]).toEqual([80, 120])
    expect(info.rotation).toBe(90)
    expect(info.hasAudio).toBe(false)
    expect(info.sizeBytes).toBe(statSync(fx.orient6).size)
  })

  it('alpha, frame count, CJK path', async () => {
    const a = await imageEngine.probe(fx.alpha)
    expect([a.format, a.hasAlpha, a.frameCount]).toEqual(['png', true, 1])
    const g = await imageEngine.probe(fx.anim)
    expect([g.format, g.width, g.height, g.frameCount]).toEqual(['gif', 60, 40, 3])
    const q = await imageEngine.probe(fx.quadJpg)
    expect([q.width, q.height, q.rotation, q.hasAlpha]).toEqual([120, 80, 0, false])
  })

  it('BMP decodes via the ffmpeg fallback', async () => {
    const b = await imageEngine.probe(fx.bmp)
    expect([b.format, b.width, b.height]).toEqual(['bmp', 64, 48])
  })
})

describe('ffmpeg fallback formats', () => {
  it('processes a BMP (sharp cannot read it) through the full chain', async () => {
    await expect(sharp(fx.bmp).metadata()).rejects.toThrow()
    const { dest, res } = await run(fx.bmp, [act({ type: 'resize', mode: 'width', width: 32, withoutEnlargement: false })], { format: 'keep' })
    expect([res.width, res.height, res.format]).toEqual([32, 24, 'png'])
    expect((await sharp(dest).metadata()).format).toBe('png')
  })

  it('thumbnail and preview work for BMP', async () => {
    const t = await imageEngine.thumbnail(fx.bmp, 32)
    const m = await sharp(t).metadata()
    expect([m.format, m.width, m.height]).toEqual(['jpeg', 32, 24])
    const p = await imageEngine.preview({ source: fx.bmp, actions: [], output: out({ format: 'jpeg' }), maxSize: 100 })
    expect([p.outWidth, p.outHeight, p.afterMime]).toEqual([64, 48, 'image/jpeg'])
  })

  it('TGA decodes via the ffmpeg fallback too', async () => {
    const tga = tmpPath(fx, 'targa 圖.tga')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=50x30', '-frames:v', '1', tga], { windowsHide: true })
    expect(r.status).toBe(0)
    const info = await imageEngine.probe(tga)
    expect([info.format, info.width, info.height]).toEqual(['tga', 50, 30])
    const { res } = await run(tga, [act({ type: 'rotate', angle: 90 })], { format: 'webp' })
    expect([res.width, res.height, res.format]).toEqual([30, 50, 'webp'])
  })

  it('unreadable files fail with a readable error', async () => {
    const bad = tmpPath(fx, 'broken.tga')
    writeFileSync(bad, 'not an image at all')
    await expect(imageEngine.probe(bad)).rejects.toThrow(/Cannot decode image/)
  })
})

describe('animation', () => {
  it('animated GIF resize keeps every frame, delays and loop', async () => {
    const { dest, res } = await run(fx.anim, [act({ type: 'resize', mode: 'width', width: 30, withoutEnlargement: false })], { format: 'keep' })
    expect([res.width, res.height, res.format]).toEqual([30, 20, 'gif'])
    const m = await sharp(dest).metadata()
    expect(m.pages).toBe(3)
    expect([m.width, m.height]).toEqual([30, 20])
    expect(m.delay).toEqual([100, 150, 200])
    expect(m.loop).toBe(0)
    // frame colours survive in order
    for (const [page, colour] of [[0, RED], [1, GREEN], [2, BLUE]] as const) {
      const px = await sharp(dest, { page }).raw().toBuffer()
      expect(near(Array.from(px.subarray(0, 3)), colour, 8), `frame ${page}`).toBe(true)
    }
  })

  it('GIF → animated WebP with a watermark on every frame', async () => {
    const { dest } = await run(
      fx.anim,
      [act({ type: 'watermark', watermark: { type: 'image', path: fx.logo, scalePct: 20, anchor: 'top-left', marginPct: 0, opacity: 1 } }), act({ type: 'flip', axis: 'horizontal' })],
      { format: 'webp', quality: 90 },
    )
    const m = await sharp(dest).metadata()
    expect([m.format, m.pages]).toEqual(['webp', 3])
    // logo was at top-left, then flipped → top-right on every frame
    for (const page of [0, 1, 2]) {
      const frame = await sharp(dest, { page }).png().toBuffer()
      expect(near(await pixelAt(frame, 55, 3), RED, 30), `frame ${page}`).toBe(true)
    }
  })

  it('falls back to the first frame for non-animated outputs or unsafe actions', async () => {
    const png = await run(fx.anim, [], { format: 'png' })
    expect((await sharp(png.dest).metadata()).pages ?? 1).toBe(1)
    expect([png.res.width, png.res.height]).toEqual([60, 40])
    const trimmed = await run(fx.anim, [act({ type: 'trim', threshold: 10 })], { format: 'gif' })
    expect((await sharp(trimmed.dest).metadata()).pages ?? 1).toBe(1)
  })
})

describe('preview', () => {
  it('returns displayable before/after and the full-resolution output size', async () => {
    const actions = [
      act({ type: 'canvas', top: 20, right: 20, bottom: 20, left: 20, unit: 'px', color: '#ffffff' }),
      act({ type: 'watermark', watermark: { type: 'text', text: '預覽 プレビュー', fontSizePct: 12, color: '#000000', anchor: 'bottom', marginPct: 2, opacity: 0.9 } }),
    ]
    const p = await imageEngine.preview({ source: fx.quadJpg, actions, output: out({ format: 'jpeg', quality: 60 }), maxSize: 100 })
    expect([p.outWidth, p.outHeight]).toEqual([160, 120])
    expect(p.beforeMime).toBe('image/jpeg')
    expect(p.afterMime).toBe('image/jpeg')
    const after = await sharp(p.after).metadata()
    expect(Math.max(after.width, after.height)).toBe(100)
    const before = await sharp(p.before).metadata()
    expect([before.width, before.height]).toEqual([100, 67])
    writeFileSync(join(SAMPLES, 'preview_before.jpg'), p.before)
    writeFileSync(join(SAMPLES, 'preview_after.jpg'), p.after)
  })

  it('realistic sample: photo-like gradient, sepia + vignette canvas + text watermark', async () => {
    const W = 1600
    const H = 1066
    const buf = Buffer.alloc(W * H * 3)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3
        buf[i] = Math.round((x / W) * 255)
        buf[i + 1] = Math.round((y / H) * 255)
        buf[i + 2] = Math.round(128 + 127 * Math.sin((x + y) / 60))
      }
    }
    const photo = tmpPath(fx, '風景 photo.jpg')
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toFile(photo)
    const actions = [
      act({ type: 'resize', mode: 'longEdge', size: 1200, withoutEnlargement: true }),
      act({ type: 'sepia' }),
      act({ type: 'adjust', brightness: 5, contrast: 15, saturation: 0, hue: 0, gamma: 1.1 }),
      act({ type: 'canvas', top: 3, right: 3, bottom: 3, left: 3, unit: 'pct', color: '#f4efe6' }),
      act({ type: 'watermark', watermark: { type: 'text', text: '© {name} · {date}', fontSizePct: 4, color: '#ffffff', anchor: 'bottom-right', marginPct: 5, opacity: 0.85, shadow: true } }),
    ]
    const p = await imageEngine.preview({ source: photo, actions, output: out({ format: 'jpeg', quality: 70 }), maxSize: 640 })
    const pad = Math.round(0.03 * 800)
    expect([p.outWidth, p.outHeight]).toEqual([1200 + 2 * pad, 800 + 2 * pad])
    writeFileSync(join(SAMPLES, 'preview_photo_before.jpg'), p.before)
    writeFileSync(join(SAMPLES, 'preview_photo_after.jpg'), p.after)
  })

  it('small results are returned as encoded; tiff becomes png; alpha before is png', async () => {
    const small = await imageEngine.preview({ source: fx.quad, actions: [], output: out({ format: 'webp', quality: 50 }), maxSize: 500 })
    expect(small.afterMime).toBe('image/webp')
    expect((await sharp(small.after).metadata()).format).toBe('webp')
    const tiff = await imageEngine.preview({ source: fx.quad, actions: [], output: out({ format: 'tiff', quality: 80 }), maxSize: 500 })
    expect(tiff.afterMime).toBe('image/png')
    expect((await sharp(tiff.after).metadata()).format).toBe('png')
    const alpha = await imageEngine.preview({ source: fx.alpha, actions: [], output: out({ format: 'png' }), maxSize: 50 })
    expect(alpha.beforeMime).toBe('image/png')
    expect(alpha.afterMime).toBe('image/png')
  })

  it('before is auto-oriented for display; after follows the chain', async () => {
    const p = await imageEngine.preview({ source: fx.orient6, actions: [act({ type: 'autoOrient' })], output: out({ format: 'png' }), maxSize: 1000 })
    expect([p.outWidth, p.outHeight]).toEqual([80, 120])
    const before = await sharp(p.before).metadata()
    expect([before.width, before.height]).toEqual([80, 120])
  })

  it('animated sources preview their first frame', async () => {
    const p = await imageEngine.preview({ source: fx.anim, actions: [], output: out({ format: 'gif' }), maxSize: 200 })
    expect([p.outWidth, p.outHeight, p.afterMime]).toEqual([60, 40, 'image/gif'])
  })
})

describe('thumbnail', () => {
  it('auto-oriented JPEG fitting maxSize', async () => {
    const t = await imageEngine.thumbnail(fx.orient6, 60)
    const m = await sharp(t).metadata()
    expect([m.format, m.width, m.height]).toEqual(['jpeg', 40, 60])
    expect(near(await pixelAt(t, 38, 2), RED, 30)).toBe(true)
  })

  it('never enlarges and flattens alpha', async () => {
    const t = await imageEngine.thumbnail(fx.alpha, 400)
    const m = await sharp(t).metadata()
    expect([m.width, m.height, m.channels]).toEqual([100, 100, 3])
  })
})

describe('abort and file handling', () => {
  it('an already-aborted signal rejects with AbortError and writes nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    const dest = tmpPath(fx, 'aborted.png')
    await expect(imageEngine.process({ source: fx.quad, actions: [], output: out(), dest, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(dest)).toBe(false)
  })

  it('aborting mid-chain stops between stages', async () => {
    const big = tmpPath(fx, 'big.png')
    await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#000000', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
      .png({ compressionLevel: 1 })
      .toFile(big)
    const ac = new AbortController()
    const actions: ImageAction[] = Array.from({ length: 30 }, () => act({ type: 'blur', sigma: 3 }))
    const dest = tmpPath(fx, 'aborted-mid.png')
    const p = imageEngine.process({ source: big, actions, output: out(), dest, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(existsSync(dest)).toBe(false)
  })

  it('releases the source file right after processing (it can be moved / deleted)', async () => {
    const src = tmpPath(fx, 'movable 來源.jpg')
    copyFileSync(fx.quadJpg, src)
    await imageEngine.probe(src)
    await run(src, [act({ type: 'resize', mode: 'width', width: 50, withoutEnlargement: false })], { format: 'jpeg' })
    await imageEngine.thumbnail(src, 40)
    const moved = tmpPath(fx, 'moved 來源.jpg')
    renameSync(src, moved)
    unlinkSync(moved)
    expect(existsSync(moved)).toBe(false)
  })

  it('returns bytes matching the file on disk', async () => {
    const { dest, res } = await run(fx.quad, [], { format: 'jpeg', quality: 80 })
    expect(res.bytes).toBe(statSync(dest).size)
  })
})

// Test fixtures for the image engine, generated with sharp/ffmpeg into a temp dir.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import type { ImageAction, ImageOutputSettings } from '../../src/shared/types'

export const RED = [255, 0, 0]
export const GREEN = [0, 255, 0]
export const BLUE = [0, 0, 255]
export const WHITE = [255, 255, 255]

/** 120×80, quadrants: top-left red, top-right green, bottom-left blue, bottom-right white. */
export function quadrantRaw(w = 120, h = 80): { data: Buffer; raw: { width: number; height: number; channels: 3 } } {
  const data = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y < h / 2 ? (x < w / 2 ? RED : GREEN) : x < w / 2 ? BLUE : WHITE
      data.set(c, (y * w + x) * 3)
    }
  }
  return { data, raw: { width: w, height: h, channels: 3 } }
}

export const quadrant = (): Sharp => {
  const q = quadrantRaw()
  return sharp(q.data, { raw: q.raw })
}

export interface Fixtures {
  dir: string
  /** quadrant PNG with a CJK + space file name */
  quad: string
  /** quadrant JPEG (q100) with a CJK + space file name */
  quadJpg: string
  /** 100×100 RGBA: left half opaque red, right half fully transparent */
  alpha: string
  /** 32×32 solid #808080 */
  gray: string
  /** 40×20 gray step: left 100, right 150 */
  step: string
  /** 40×40 white with a 20×20 red square in the middle */
  bordered: string
  /** 200×100 white */
  white: string
  /** 64×64 noise (for size comparisons) */
  noise: string
  /** JPEG with EXIF (Copyright) and a Display P3 ICC profile */
  meta: string
  /** quadrant JPEG with EXIF orientation 6 */
  orient6: string
  /** 3-frame animated GIF, 60×40 (red, green, blue frames) */
  anim: string
  /** BMP made with ffmpeg (64×48) — sharp cannot decode BMP */
  bmp: string
  /** 20×20 opaque red logo */
  logo: string
  /** SVG logo 10×5 user units, blue */
  logoSvg: string
  cleanup: () => void
}

export function tmpPath(fx: Fixtures, name: string): string {
  return join(fx.dir, name)
}

export async function makeFixtures(): Promise<Fixtures> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-image-'))
  const p = (n: string): string => join(dir, n)
  const fx: Fixtures = {
    dir,
    quad: p('四象限 測試 圖.png'),
    quadJpg: p('照片 測試 圖片.jpg'),
    alpha: p('alpha.png'),
    gray: p('gray.png'),
    step: p('step.png'),
    bordered: p('bordered.png'),
    white: p('white.png'),
    noise: p('noise.png'),
    meta: p('meta.jpg'),
    orient6: p('orient 6.jpg'),
    anim: p('anim 動畫.gif'),
    bmp: p('bitmap 圖.bmp'),
    logo: p('logo.png'),
    logoSvg: p('logo.svg'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
  await quadrant().png().toFile(fx.quad)
  await quadrant().jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(fx.quadJpg)
  await quadrant().jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 6 }).toFile(fx.orient6)

  const a = Buffer.alloc(100 * 100 * 4)
  for (let y = 0; y < 100; y++) for (let x = 0; x < 50; x++) a.set([255, 0, 0, 255], (y * 100 + x) * 4)
  await sharp(a, { raw: { width: 100, height: 100, channels: 4 } }).png().toFile(fx.alpha)

  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#808080' } }).png().toFile(fx.gray)

  const s = Buffer.alloc(40 * 20)
  for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) s[y * 40 + x] = x < 20 ? 100 : 150
  await sharp(s, { raw: { width: 40, height: 20, channels: 1 } }).toColourspace('srgb').png().toFile(fx.step)

  await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ffffff' } })
    .composite([{ input: { create: { width: 20, height: 20, channels: 3, background: '#ff0000' } }, left: 10, top: 10 }])
    .png()
    .toFile(fx.bordered)

  await sharp({ create: { width: 200, height: 100, channels: 3, background: '#ffffff' } }).png().toFile(fx.white)
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#000000', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
    .png()
    .toFile(fx.noise)

  await sharp({ create: { width: 48, height: 32, channels: 3, background: '#3366cc' } })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Copyright: 'Media Converter test', Artist: 'tester' } })
    .withIccProfile('p3')
    .toFile(fx.meta)

  const frames = [RED, GREEN, BLUE].map((c) => {
    const b = Buffer.alloc(60 * 40 * 4)
    for (let i = 0; i < 60 * 40; i++) b.set([...c, 255], i * 4)
    return b
  })
  await sharp(Buffer.concat(frames), { raw: { width: 60, height: 120, channels: 4, pageHeight: 40 } })
    .gif({ delay: [100, 150, 200], loop: 0 })
    .toFile(fx.anim)

  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48', '-frames:v', '1', fx.bmp], { windowsHide: true })
  if (r.status !== 0) throw new Error(`ffmpeg failed to make the BMP fixture: ${r.stderr?.toString()}`)

  await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toFile(fx.logo)
  writeFileSync(
    fx.logoSvg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5" viewBox="0 0 10 5"><rect width="10" height="5" fill="#0000ff"/></svg>',
  )
  return fx
}

/** Raw pixels (channels as stored) of an image file or buffer. */
export async function pixels(input: string | Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height, channels: info.channels }
}

export async function pixelAt(input: string | Buffer, x: number, y: number): Promise<number[]> {
  const px = await pixels(input)
  const i = (y * px.width + x) * px.channels
  return Array.from(px.data.subarray(i, i + px.channels))
}

/** Assert-friendly: every channel within tol of expected (only compares the first expected.length channels). */
export function near(actual: number[], expected: number[], tol = 8): boolean {
  return expected.every((v, i) => Math.abs((actual[i] ?? -999) - v) <= tol)
}

let n = 0
export const id = (): string => `a${++n}`

export function out(over: Partial<ImageOutputSettings> = {}): ImageOutputSettings {
  return { format: 'png', quality: 90, keepMetadata: false, ...over }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Build an enabled action without having to spell out id/enabled. */
export function act(a: DistributiveOmit<ImageAction, 'id' | 'enabled'>): ImageAction {
  return { id: id(), enabled: true, ...a } as ImageAction
}

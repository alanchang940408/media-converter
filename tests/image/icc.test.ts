import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { embedIccInPng } from '../../src/main/image/decode'

// An orange PNG without a profile (what ffmpeg hands us for a HEIC), and the Display P3 profile an iPhone embeds.
async function fixtures(): Promise<{ png: Buffer; p3: Buffer }> {
  const create = { width: 8, height: 8, channels: 3 as const, background: { r: 200, g: 120, b: 60 } }
  const png = await sharp({ create }).png().toBuffer()
  const tagged = await sharp({ create }).withIccProfile('p3').png().toBuffer()
  const p3 = (await sharp(tagged).metadata()).icc
  if (!p3) throw new Error('sharp did not embed the p3 profile')
  return { png, p3 }
}

/** Pixel after a normal export (sharp converts from the embedded profile to sRGB and strips it), read back raw. */
async function srgbPixel(png: Buffer): Promise<number[]> {
  const exported = await sharp(png).png().toBuffer()
  const { data } = await sharp(exported).raw().toBuffer({ resolveWithObject: true })
  return [data[0], data[1], data[2]]
}

describe('embedIccInPng (ffmpeg-decoded HEIC keeps its colour profile)', () => {
  it('embeds the profile so sharp sees it', async () => {
    const { png, p3 } = await fixtures()
    expect((await sharp(png).metadata()).icc).toBeUndefined()
    const out = embedIccInPng(png, p3)
    const meta = await sharp(out).metadata()
    expect(meta.icc?.equals(p3)).toBe(true)
    expect([meta.width, meta.height]).toEqual([8, 8])
  })

  it('P3 pixels are converted to sRGB instead of being read as sRGB', async () => {
    const { png, p3 } = await fixtures()
    const asIs = await srgbPixel(png)
    const converted = await srgbPixel(embedIccInPng(png, p3))
    expect(asIs).toEqual([200, 120, 60])
    // The same numbers mean a more saturated colour in P3, so in sRGB red goes up and blue goes down.
    expect(converted[0]).toBeGreaterThan(asIs[0])
    expect(converted[2]).toBeLessThan(asIs[2])
  })

  it('replaces existing colour chunks and leaves non-PNG input untouched', async () => {
    const { p3 } = await fixtures()
    const srgbTagged = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#808080' } }).withIccProfile('srgb').png().toBuffer()
    const out = embedIccInPng(srgbTagged, p3)
    expect((await sharp(out).metadata()).icc?.equals(p3)).toBe(true)
    const notPng = Buffer.from('not a png at all, definitely not')
    expect(embedIccInPng(notPng, p3)).toBe(notPng)
  })
})

#!/usr/bin/env node
// Render the app icon from resources/icon.svg (and icon-small.svg for ≤ 32 px):
//   resources/icon.png  512 px  (window icon in dev / Linux)
//   build/icon.png     1024 px  (electron-builder: macOS icns + Linux)
//   build/icon.ico     16–256 px, PNG-compressed entries (electron-builder: Windows exe + NSIS)
//
//   node scripts/make-icons.mjs [--preview <png>]   --preview writes a contact sheet of every size
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const SMALL_MAX = 32

const full = readFileSync(join(ROOT, 'resources', 'icon.svg'))
const small = readFileSync(join(ROOT, 'resources', 'icon-small.svg'))

/** Rasterise at 4× (≥ 1024) and downsample with lanczos for clean edges at every size. */
async function render(svg, size) {
  const work = Math.max(1024, size * 4)
  const big = await sharp(svg, { density: (72 * work) / 1024 }).resize(work, work).png().toBuffer()
  return sharp(big).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9, palette: false }).toBuffer()
}

/** ICO container with PNG payloads (supported by Windows Vista+ for every size). */
export function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o) // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1) // height
    dir.writeUInt8(0, o + 2) // palette colours
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // colour planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((im) => im.png)])
}

/** Parse an ICO back into its PNG entries (sanity check). */
export function decodeIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an .ico file')
  const n = buf.readUInt16LE(4)
  const out = []
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16
    const size = buf.readUInt8(o) || 256
    const len = buf.readUInt32LE(o + 8)
    const at = buf.readUInt32LE(o + 12)
    out.push({ size, png: buf.subarray(at, at + len) })
  }
  return out
}

async function main() {
  mkdirSync(join(ROOT, 'build'), { recursive: true })
  writeFileSync(join(ROOT, 'build', 'icon.png'), await render(full, 1024))
  writeFileSync(join(ROOT, 'resources', 'icon.png'), await render(full, 512))

  const images = []
  for (const size of ICO_SIZES) images.push({ size, png: await render(size <= SMALL_MAX ? small : full, size) })
  const ico = encodeIco(images)
  writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)

  // verify the container round-trips and every entry decodes at its declared size
  for (const { size, png } of decodeIco(readFileSync(join(ROOT, 'build', 'icon.ico')))) {
    const meta = await sharp(png).metadata()
    if (meta.width !== size || meta.height !== size || meta.format !== 'png') throw new Error(`bad ico entry ${size}`)
  }
  console.log(`build/icon.ico: ${ICO_SIZES.join(', ')} px, ${ico.length} bytes`)
  console.log('build/icon.png: 1024 px, resources/icon.png: 512 px')

  const i = process.argv.indexOf('--preview')
  if (i > 0 && process.argv[i + 1]) await contactSheet(images, process.argv[i + 1])
}

/** Every ICO size at 1:1 and magnified 4× (nearest), on dark and light backgrounds. */
async function contactSheet(images, dest) {
  const pad = 16
  const rowH = 256 * 1 + pad * 2
  const width = images.reduce((w, im) => w + im.size + pad, pad) + images.slice(0, 4).reduce((w, im) => w + im.size * 4 + pad, 0)
  const layers = []
  for (const [row, bg] of [[0, '#1e1f24'], [1, '#f3f4f6']]) {
    layers.push({ input: { create: { width, height: rowH, channels: 4, background: bg } }, left: 0, top: row * rowH })
    let x = pad
    for (const im of images) {
      layers.push({ input: im.png, left: x, top: row * rowH + pad })
      x += im.size + pad
    }
    for (const im of images.slice(0, 4)) {
      const zoom = await sharp(im.png).resize(im.size * 4, im.size * 4, { kernel: 'nearest' }).png().toBuffer()
      layers.push({ input: zoom, left: x, top: row * rowH + pad })
      x += im.size * 4 + pad
    }
  }
  await sharp({ create: { width, height: rowH * 2, channels: 4, background: '#000' } }).composite(layers).png().toFile(dest)
  console.log(`preview: ${dest}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

// EXIF "taken" time: written with sharp .withExif(), read back by the image engine (probe + readTakenAt).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp, { type Sharp } from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { imageEngine } from '../../src/main/image'
import { takenAtFromExif } from '../../src/main/image/exif'

let dir: string
const p = (n: string): string => join(dir, n)
const base = (): Sharp => sharp({ create: { width: 16, height: 12, channels: 3, background: '#3366cc' } })
/**
 * Minimal little-endian TIFF structure (as in camera RAW files: CR2, NEF, ARW, DNG…): IFD0 → ExifIFD → DateTimeOriginal.
 * Not a decodable image — only the header matters for the date.
 */
function tiffExifHeader(date: string): Buffer {
  const b = Buffer.alloc(64 + 16)
  b.write('II', 0, 'latin1')
  b.writeUInt16LE(42, 2)
  b.writeUInt32LE(8, 4)
  // IFD0: one entry, ExifTag (0x8769, LONG) → offset 26
  b.writeUInt16LE(1, 8)
  b.writeUInt16LE(0x8769, 10)
  b.writeUInt16LE(4, 12)
  b.writeUInt32LE(1, 14)
  b.writeUInt32LE(26, 18)
  b.writeUInt32LE(0, 22)
  // Exif IFD: DateTimeOriginal (0x9003, ASCII, 20) → offset 44
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(0x9003, 28)
  b.writeUInt16LE(2, 30)
  b.writeUInt32LE(20, 32)
  b.writeUInt32LE(44, 36)
  b.writeUInt32LE(0, 40)
  b.write(date + String.fromCharCode(0), 44, 'latin1')
  return b
}

/** 2021-07-04 13:45:10 local wall-clock time */
const TAKEN = new Date(2021, 6, 4, 13, 45, 10).getTime()

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mc-exif-'))
  await base()
    .withExif({ IFD0: { Make: 'Test Cam' }, IFD2: { DateTimeOriginal: '2021:07:04 13:45:10' } })
    .jpeg()
    .toFile(p('相機 照片.jpg'))
  // only DateTimeDigitized (exiftool: CreateDate)
  await base().withExif({ IFD2: { DateTimeDigitized: '2018:02:03 04:05:06' } }).jpeg().toFile(p('digitized.jpg'))
  // both: DateTimeOriginal wins
  await base()
    .withExif({ IFD2: { DateTimeOriginal: '2021:07:04 13:45:10', DateTimeDigitized: '2018:02:03 04:05:06' } })
    .jpeg()
    .toFile(p('both.jpg'))
  await base().withExif({ IFD2: { DateTimeOriginal: '0000:00:00 00:00:00' } }).jpeg().toFile(p('zero.jpg'))
  await base().jpeg().toFile(p('plain.jpg'))
  // EXIF inside PNG (eXIf) and TIFF — read through sharp / the TIFF header
  await base().withExif({ IFD2: { DateTimeOriginal: '2021:07:04 13:45:10' } }).png().toFile(p('with exif.png'))
  writeFileSync(p('camera raw.CR2'), tiffExifHeader('2021:07:04 13:45:10'))
  writeFileSync(p('notes.txt'), 'not an image at all')
  writeFileSync(p('empty.jpg'), '')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('EXIF taken time', () => {
  it('probe fills MediaInfo.takenAt from DateTimeOriginal (local wall-clock time)', async () => {
    const info = await imageEngine.probe(p('相機 照片.jpg'))
    expect(info.takenAt).toBe(TAKEN)
    const d = new Date(info.takenAt!)
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2021, 7, 4, 13, 45, 10])
    // photos without a date have no takenAt at all
    expect('takenAt' in (await imageEngine.probe(p('plain.jpg')))).toBe(false)
  })

  it('readTakenAt: DateTimeOriginal, fallback DateTimeDigitized, placeholders ignored', async () => {
    expect(await imageEngine.readTakenAt(p('相機 照片.jpg'))).toBe(TAKEN)
    expect(await imageEngine.readTakenAt(p('both.jpg'))).toBe(TAKEN)
    expect(await imageEngine.readTakenAt(p('digitized.jpg'))).toBe(new Date(2018, 1, 3, 4, 5, 6).getTime())
    expect(await imageEngine.readTakenAt(p('zero.jpg'))).toBeUndefined()
    expect(await imageEngine.readTakenAt(p('plain.jpg'))).toBeUndefined()
  })

  it('readTakenAt works for PNG and TIFF-based camera RAW, and never throws for other files', async () => {
    expect(await imageEngine.readTakenAt(p('with exif.png'))).toBe(TAKEN)
    expect(await imageEngine.readTakenAt(p('camera raw.CR2'))).toBe(TAKEN)
    expect(await imageEngine.readTakenAt(p('notes.txt'))).toBeUndefined()
    expect(await imageEngine.readTakenAt(p('empty.jpg'))).toBeUndefined()
    expect(await imageEngine.readTakenAt(p('missing.jpg'))).toBeUndefined()
  })

  it('takenAtFromExif tolerates garbage', () => {
    expect(takenAtFromExif(undefined)).toBeUndefined()
    expect(takenAtFromExif(Buffer.from('Exif\0\0garbage that is not tiff'))).toBeUndefined()
    expect(takenAtFromExif(Buffer.alloc(3))).toBeUndefined()
  })
})

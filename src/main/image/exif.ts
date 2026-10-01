// "Photo taken" time from EXIF (DateTimeOriginal, fallback DateTimeDigitized a.k.a. CreateDate).
// Cheap: JPEG and TIFF-based files (incl. most camera RAW) are parsed from the first bytes only; other formats
// (PNG eXIf, WebP, HEIC/AVIF) go through sharp's header-only metadata(). No Electron imports.
import { open } from 'node:fs/promises'
import exifReader from 'exif-reader'
import sharp from 'sharp'
import { extOf, IMAGE_EXTS } from '../../shared/media'
import { SHARP_OPTS } from './decode'

const HEAD_BYTES = 256 * 1024
/** Formats whose EXIF block sharp/libvips can extract (header read, no decode). */
const SHARP_EXIF_EXTS = new Set<string>([...IMAGE_EXTS, 'dng'])

/** EXIF date (exif-reader encodes the wall-clock fields as UTC) → epoch ms of that wall-clock time in local time. */
function wallClock(d: unknown): number | undefined {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return undefined
  const y = d.getUTCFullYear()
  // "0000:00:00 00:00:00" placeholders parse to 1899
  if (y < 1900 || y > 9999) return undefined
  const local = new Date(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())
  const ms = local.getTime()
  return Number.isFinite(ms) ? ms : undefined
}

/** Parse an EXIF block ("Exif\0\0…" as returned by sharp, or a bare TIFF header) and return the taken time. */
export function takenAtFromExif(buf: Buffer | undefined | null): number | undefined {
  if (!buf || buf.length < 8) return undefined
  try {
    const ex = exifReader(buf)
    return wallClock(ex.Photo?.DateTimeOriginal) ?? wallClock(ex.Image?.DateTimeOriginal) ?? wallClock(ex.Photo?.DateTimeDigitized)
  } catch {
    return undefined
  }
}

const isTiffHeader = (b: Buffer): boolean =>
  b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))

/** The APP1 "Exif" payload of a JPEG, if it lies within `b`. */
function jpegExifSegment(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    // start of scan / end of image: no more metadata segments
    if (marker === 0xda || marker === 0xd9) return null
    const len = b.readUInt16BE(i + 2)
    if (len < 2) return null
    const start = i + 4
    const end = i + 2 + len
    if (marker === 0xe1 && end <= b.length && b.toString('latin1', start, start + 6) === 'Exif\0\0') return b.subarray(start, end)
    i = end
  }
  return null
}

async function readHead(path: string): Promise<Buffer | null> {
  let fh
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Taken time of any file (epoch ms, local wall clock), or undefined when it has no usable EXIF date. Never throws. */
export async function readTakenAt(path: string): Promise<number | undefined> {
  const head = await readHead(path)
  if (!head) return undefined
  const seg = jpegExifSegment(head)
  if (seg) {
    const t = takenAtFromExif(seg)
    if (t !== undefined) return t
  } else if (isTiffHeader(head)) {
    const t = takenAtFromExif(head)
    if (t !== undefined) return t
  }
  if (!SHARP_EXIF_EXTS.has(extOf(path))) return undefined
  try {
    const meta = await sharp(path, SHARP_OPTS).metadata()
    return takenAtFromExif(meta.exif)
  } catch {
    return undefined
  }
}

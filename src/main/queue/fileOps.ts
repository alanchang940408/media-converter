// File-system helpers for rename / copy / move jobs and their undo. Pure Node; the primitive operations are
// injectable so tests can simulate cross-volume moves (EXDEV) and locked files.
import { createReadStream, createWriteStream, type Stats } from 'node:fs'
import { copyFile, lstat, rename, rm, stat, unlink, utimes } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { pathKey, RENAME_TEMP_SUFFIX, TEMP_SUFFIX } from './outputPath'

export interface FileOpsFs {
  rename(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeFileOps: FileOpsFs = {
  rename: (a, b) => rename(a, b),
  copyFile: (a, b) => copyFile(a, b),
  unlink: (p) => unlink(p),
}

export interface CopyOptions {
  signal?: AbortSignal
  /** 0..1 while bytes are copied (large files only). */
  onProgress?: (fraction: number) => void
}

export class CopySizeError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Copy is incomplete: ${actual} of ${expected} bytes`)
    this.name = 'CopySizeError'
  }
}

/** Files at least this big are streamed (progress + cancel); smaller ones use the OS copy. */
const STREAM_COPY_MIN = 16 * 1024 * 1024
const RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

/** Intermediate name for a case-only rename of `source` (kept on crash so the file can be recovered). */
export function caseTempPath(source: string, tag: string): string {
  return `${source}.${tag}${RENAME_TEMP_SUFFIX}`
}

/**
 * Do two paths name the very same file (same volume + file id)? Catches aliases a path comparison misses: junctions /
 * symlinked folders, 8.3 short names, mapped drive vs UNC, trailing dots or spaces Windows drops. False when either
 * path is missing or the file system reports no file ids.
 */
export async function isSameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a, { bigint: true }).catch(() => null), stat(b, { bigint: true }).catch(() => null)])
  if (!sa || !sb || sa.ino === 0n || sb.ino === 0n) return false
  return sa.dev === sb.dev && sa.ino === sb.ino
}

export interface FileStamp {
  /** "dev:ino"; absent when the file system reports no file ids. */
  fileId?: string
  size: number
  mtimeMs: number
}

/** Identity + size + modified time of a file (null when missing). */
export async function fileStampOf(p: string): Promise<FileStamp | null> {
  const st = await stat(p, { bigint: true }).catch(() => null)
  if (!st) return null
  return { ...(st.ino !== 0n ? { fileId: `${st.dev}:${st.ino}` } : {}), size: Number(st.size), mtimeMs: Number(st.mtimeMs) }
}

/**
 * Is the file now at a journaled path a different one than the operation left there? Only when both file ids are known
 * and differ AND size or modified time changed (FAT / exFAT ids can change on rename; a same-id file was only edited).
 */
export function isReplacedFile(recorded: Partial<FileStamp>, now: FileStamp): boolean {
  if (!recorded.fileId || !now.fileId || recorded.fileId === now.fileId) return false
  if (typeof recorded.size !== 'number' || typeof recorded.mtimeMs !== 'number') return true
  return recorded.size !== now.size || Math.abs(recorded.mtimeMs - now.mtimeMs) > 2000
}

/** fs.rename that retries briefly while Windows readers (AV scanners, thumbnailers) hold the file. */
export async function renameWithRetry(fs: FileOpsFs, from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= attempts || !code || !RETRY_CODES.has(code)) throw err
      await sleep(100 * (attempt + 1))
    }
  }
}

async function unlinkWithRetry(fs: FileOpsFs, p: string, attempts = 8): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.unlink(p)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (attempt >= attempts || !code || !RETRY_CODES.has(code)) throw err
      await sleep(100 * (attempt + 1))
    }
  }
}

/** Byte-identical copy `src` → `dest` (dest is replaced), size verified, atime/mtime carried over. */
export async function copyData(fs: FileOpsFs, src: string, dest: string, st: Stats, opts: CopyOptions = {}): Promise<void> {
  if (opts.signal?.aborted) throw abortError()
  if (st.size < STREAM_COPY_MIN) {
    await fs.copyFile(src, dest)
  } else {
    let copied = 0
    const total = st.size
    const report = opts.onProgress
    await pipeline(
      createReadStream(src, { highWaterMark: 1 << 20 }),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          copied += chunk.length
          report?.(Math.min(0.99, copied / total))
          yield chunk
        }
      },
      createWriteStream(dest),
      { signal: opts.signal },
    )
  }
  if (opts.signal?.aborted) throw abortError()
  const out = await stat(dest)
  if (out.size !== st.size) throw new CopySizeError(st.size, out.size)
  await utimes(dest, st.atime, st.mtime).catch(() => undefined)
}

export interface RelocateOptions extends CopyOptions {
  /** Short unique tag for intermediate names (job id prefix). */
  tag: string
}

/**
 * Move / rename `from` → `to`. Same volume: atomic rename (replaces an existing `to` — callers decide whether that is
 * allowed). Other volume (EXDEV): copy to "<to>.mcpart", verify the size, rename onto `to`, then delete `from`.
 * Case-only renames (a.jpg → A.jpg on a case-insensitive file system) go through an intermediate name.
 * On failure `from` is left where it was. Resolves once the file is at `to` (the operation is committed).
 */
export async function relocate(fs: FileOpsFs, from: string, to: string, opts: RelocateOptions): Promise<void> {
  if (from === to) return
  if (opts.signal?.aborted) throw abortError()
  if (pathKey(from) === pathKey(to)) {
    const tmp = caseTempPath(from, opts.tag)
    await renameWithRetry(fs, from, tmp)
    try {
      // `to` was `from` spelled differently; a file still found there is a different one (a case-sensitive folder,
      // or names only our key folds together, e.g. the Kelvin sign and "k") → never replace it
      if (await lstat(to).then(() => true, () => false)) {
        throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}' -> '${to}'`), { code: 'EEXIST' })
      }
      await renameWithRetry(fs, tmp, to)
    } catch (err) {
      await renameWithRetry(fs, tmp, from).catch(() => undefined)
      throw err
    }
    return
  }
  try {
    await renameWithRetry(fs, from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  const st = await stat(from)
  const tmp = to + TEMP_SUFFIX
  try {
    await copyData(fs, from, tmp, st, opts)
    await renameWithRetry(fs, tmp, to)
  } catch (err) {
    await rm(tmp, { force: true, maxRetries: 4, retryDelay: 100 }).catch(() => undefined)
    throw err
  }
  try {
    await unlinkWithRetry(fs, from)
  } catch (err) {
    // the original could not be removed: drop the copy so the file is not duplicated
    await rm(to, { force: true, maxRetries: 4, retryDelay: 100 }).catch(() => undefined)
    throw err
  }
}

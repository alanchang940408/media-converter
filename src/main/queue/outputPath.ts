// Output file resolution: conflict policy, "never overwrite the source", cross-job reservations.
import { existsSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { ConflictPolicy, FileOpPreviewItem } from '../../shared/types'

export const TEMP_SUFFIX = '.mcpart'
/** Intermediate name used for case-only renames (a.jpg → A.jpg); never deleted automatically. */
export const RENAME_TEMP_SUFFIX = '.mcrename'

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

/** Normalised key for comparing paths (case-insensitive on Windows/macOS). */
export function pathKey(p: string): string {
  const abs = resolve(p)
  return caseInsensitive ? abs.toLowerCase() : abs
}

/** "name.ext" / "name (n).ext"; no dot at all when `ext` is empty (files without an extension). */
export function numberedName(baseName: string, ext: string, n: number): string {
  const stem = n === 0 ? baseName : `${baseName} (${n})`
  return ext ? `${stem}.${ext}` : stem
}

/** Exact extension of a path (case preserved, no dot); '' when the name has none. */
export function exactExt(path: string): string {
  const b = basename(path)
  const dot = b.lastIndexOf('.')
  return dot > 0 ? b.slice(dot + 1) : ''
}

/**
 * A job's `relativeDir` when it is safe to join below an output folder: relative, no "..", no drive / root.
 * Returns '' for "directly in the added folder" and null for unusable values.
 */
export function safeRelativeDir(rel: unknown): string | null {
  if (typeof rel !== 'string') return null
  if (!rel || rel === '.') return ''
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null
  const norm = normalize(rel).replace(/[\\/]+$/, '')
  if (!norm || norm === '.') return ''
  const parts = norm.split(/[\\/]/)
  if (parts.some((seg) => seg === '..')) return null
  return parts.join(sep)
}

export interface ResolveOutputOptions {
  dir: string
  /** Sanitised base name without extension. */
  baseName: string
  /** Extension without dot. */
  ext: string
  conflict: ConflictPolicy
  /** Source file; never chosen as the output. */
  source: string
  /** pathKey()s of outputs claimed by other running jobs. */
  reserved: ReadonlySet<string>
  /** Extra owner check (e.g. sources other jobs still have to read); treated like a reservation. */
  isTaken?: (key: string) => boolean
  exists?: (p: string) => boolean
}

export type ResolvedOutput = { path: string; skip: false } | { path: string; skip: true }

/**
 * rename    → "name.ext", "name (1).ext", "name (2).ext"…
 * overwrite → "name.ext" (replaced at the end); still renames if another job or the source owns it
 * skip      → skip when "name.ext" already exists
 * The source file and paths reserved by running jobs are never returned.
 */
export function resolveOutputPath(o: ResolveOutputOptions): ResolvedOutput {
  const exists = o.exists ?? existsSync
  const sourceKey = pathKey(o.source)
  const file = (n: number): string => join(o.dir, numberedName(o.baseName, o.ext, n))
  const first = file(0)
  const firstKey = pathKey(first)
  const isSource = firstKey === sourceKey
  const taken = (key: string): boolean => o.reserved.has(key) || (o.isTaken?.(key) ?? false)
  const isReserved = taken(firstKey)

  if (!isSource && !isReserved) {
    if (o.conflict === 'overwrite') return { path: first, skip: false }
    if (o.conflict === 'skip' && exists(first)) return { path: first, skip: true }
    if (!exists(first)) return { path: first, skip: false }
  } else if (o.conflict === 'skip' && isReserved && !isSource) {
    // another running job is producing exactly this file
    return { path: first, skip: true }
  }

  for (let n = 1; n < 100000; n++) {
    const candidate = file(n)
    const key = pathKey(candidate)
    if (key === sourceKey || taken(key)) continue
    if (!exists(candidate)) return { path: candidate, skip: false }
  }
  throw new Error(`No free output name for ${first}`)
}

export interface ResolveFileTargetOptions {
  dir: string
  /** Sanitised base name without extension. */
  baseName: string
  /** Extension without dot, case preserved; '' = no extension. */
  ext: string
  conflict: ConflictPolicy
  source: string
  /** copy keeps the source in place (it is occupied); move / rename free it. */
  operation: 'copy' | 'move' | 'rename'
  /** pathKey() owned by someone else (another job's output or pending source): never chosen, never overwritten. */
  isTaken: (key: string) => boolean
  /** Does a file exist at this path right now (as far as this resolution is concerned)? */
  exists: (p: string) => boolean
}

export interface FileTarget {
  status: FileOpPreviewItem['status']
  /** Destination (the source itself for 'unchanged', the blocked name for 'skip'). */
  path: string
}

/**
 * Destination of a rename / copy / move job.
 * unchanged → the rendered name is exactly the source (nothing to do)
 * ok        → free name (also a case-only rename of the source on a case-insensitive file system)
 * overwrite → an existing file that nobody else owns will be replaced (policy 'overwrite')
 * renamed   → " (n)" appended because the name was taken
 * skip      → taken and policy 'skip'
 */
export function resolveFileTarget(o: ResolveFileTargetOptions): FileTarget {
  const source = resolve(o.source)
  const sourceKey = pathKey(source)
  const file = (n: number): string => join(o.dir, numberedName(o.baseName, o.ext, n))
  const first = resolve(file(0))
  const firstKey = pathKey(first)
  if (first === source) return { status: 'unchanged', path: source }
  if (firstKey === sourceKey) {
    // same file, different spelling: a case-only rename (copying a file onto itself is a no-op)
    return o.operation === 'copy' ? { status: 'unchanged', path: source } : { status: 'ok', path: first }
  }
  if (!o.isTaken(firstKey)) {
    if (!o.exists(first)) return { status: 'ok', path: first }
    if (o.conflict === 'overwrite') return { status: 'overwrite', path: first }
    if (o.conflict === 'skip') return { status: 'skip', path: first }
  } else if (o.conflict === 'skip') {
    return { status: 'skip', path: first }
  }
  for (let n = 1; n < 100000; n++) {
    const candidate = resolve(file(n))
    const key = pathKey(candidate)
    if (key === sourceKey) {
      if (o.operation === 'copy') continue
      // the file already carries this numbered name
      if (candidate === source) return { status: 'unchanged', path: source }
      return { status: 'renamed', path: candidate }
    }
    if (o.isTaken(key) || o.exists(candidate)) continue
    return { status: 'renamed', path: candidate }
  }
  throw new Error(`No free output name for ${first}`)
}

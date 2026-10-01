// Output file resolution: conflict policy, "never overwrite the source", cross-job reservations.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ConflictPolicy } from '../../shared/types'

export const TEMP_SUFFIX = '.mcpart'

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

/** Normalised key for comparing paths (case-insensitive on Windows/macOS). */
export function pathKey(p: string): string {
  const abs = resolve(p)
  return caseInsensitive ? abs.toLowerCase() : abs
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
  const file = (n: number): string => join(o.dir, n === 0 ? `${o.baseName}.${o.ext}` : `${o.baseName} (${n}).${o.ext}`)
  const first = file(0)
  const firstKey = pathKey(first)
  const isSource = firstKey === sourceKey
  const isReserved = o.reserved.has(firstKey)

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
    if (key === sourceKey || o.reserved.has(key)) continue
    if (!exists(candidate)) return { path: candidate, skip: false }
  }
  throw new Error(`No free output name for ${first}`)
}

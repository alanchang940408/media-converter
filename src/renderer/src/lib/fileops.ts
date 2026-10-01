// Helpers for file operations (batch rename / copy / move): labels, icons, example names, path display.
import { Copy, FolderInput, PencilLine, type LucideIcon } from 'lucide-react'
import type { FileOperation, FileOpPreviewItem, FilePreset, Job, Preset } from '../../../shared/types'
import { renderNameTemplate } from '../../../shared/naming'
import { baseNameOf, extOf } from '../../../shared/media'
import type { MessageKey } from '../i18n'
import { dirName, fileName, joinPath } from './format'

export const FILE_OPS: FileOperation[] = ['rename', 'copy', 'move']

export const FILE_OP_ICON: Record<FileOperation, LucideIcon> = { copy: Copy, move: FolderInput, rename: PencilLine }

/** Short verb: "Copy" / "Move" / "Rename". */
export const FILE_OP_LABEL: Record<FileOperation, MessageKey> = {
  copy: 'fileop.op.copy',
  move: 'fileop.op.move',
  rename: 'fileop.op.rename',
}

/** One-line explanation of what the operation does. */
export const FILE_OP_DESC: Record<FileOperation, MessageKey> = {
  copy: 'fileop.opDesc.copy',
  move: 'fileop.opDesc.move',
  rename: 'fileop.opDesc.rename',
}

export const FILE_OP_STATUS_LABEL: Record<FileOpPreviewItem['status'], MessageKey> = {
  ok: 'fileop.status.ok',
  renamed: 'fileop.status.renamed',
  overwrite: 'fileop.status.overwrite',
  skip: 'fileop.status.skip',
  unchanged: 'fileop.status.unchanged',
}

/** Tokens that make sense for any file (no {width}/{height}). */
export const FILE_NAME_TOKENS = ['{name}', '{counter:3}', '{counter}', '{exifdate}', '{exiftime}', '{mdate}', '{date}', '{time}', '{parent}', '{ext}', '{preset}'] as const

export const DEFAULT_FILE_TEMPLATE = '{exifdate}_{counter:3}'

export function isFilePreset(p: Preset | null | undefined): p is FilePreset {
  return !!p && p.kind === 'file'
}

export function jobOperation(job: Job): FileOperation {
  return job.file?.operation ?? 'rename'
}

/** Extension with the dot, in its original case ('' when there is none). File operations keep it as is. */
export function dotExt(path: string): string {
  const base = fileName(path)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

/** "IMG_0001.JPG" → "<rendered template>.JPG", the way a file job would name it (dates fall back to now). */
export function exampleFileName(
  source: string,
  template: string,
  opts: { counter: number; preset: string; taken?: number; modified?: number; now?: Date },
): string {
  const name = renderNameTemplate(template, {
    name: baseNameOf(source),
    ext: extOf(source),
    preset: opts.preset,
    parent: fileName(dirName(source)),
    counter: opts.counter,
    now: opts.now ?? new Date(),
    taken: opts.taken != null ? new Date(opts.taken) : undefined,
    modified: opts.modified != null ? new Date(opts.modified) : undefined,
  })
  return name + dotExt(source)
}

/** Natural order ("2" before "10"), case-insensitive — the same order main uses for {counter}. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

const trimSep = (p: string): string => p.replace(/[\\/]+$/, '')

/** `p` relative to `root` when it lies inside it (case-insensitive, either separator), else null. */
export function relativeTo(p: string, root: string): string | null {
  const r = trimSep(root)
  if (!r) return null
  const head = p.slice(0, r.length)
  const next = p.charAt(r.length)
  if (head.toLowerCase() === r.toLowerCase() && (next === '\\' || next === '/')) return p.slice(r.length + 1)
  return null
}

/** Output folder a job will write into, including the recreated subfolder (null = next to the source). */
export function effectiveOutputDir(job: Pick<Job, 'output' | 'relativeDir'>): string | null {
  const dir = job.output.dir
  if (!dir) return null
  return job.output.preserveStructure && job.relativeDir ? joinPath(dir, job.relativeDir) : dir
}

/** Subfolder that will be recreated below the output folder, or null. */
export function recreatedSubfolder(job: Pick<Job, 'output' | 'relativeDir' | 'kind' | 'file'>): string | null {
  if (job.kind === 'file' && job.file?.operation === 'rename') return null
  return job.output.dir && job.output.preserveStructure && job.relativeDir ? job.relativeDir : null
}

/** Source shown as "<relativeDir>\name" when it came from a subfolder of an added folder. */
export function displaySource(source: string, relativeDir?: string): string {
  if (!relativeDir) return fileName(source)
  const sep = source.includes('\\') ? '\\' : '/'
  return relativeDir.replace(/[\\/]+$/, '') + sep + fileName(source)
}

/** Target shown relative to the output folder / the source folder when possible, else the full path. */
export function displayTarget(target: string, source: string, outputDir: string | null): string {
  if (dirName(target).toLowerCase() === dirName(source).toLowerCase()) return fileName(target)
  if (outputDir) {
    const rel = relativeTo(target, outputDir)
    if (rel) return rel
  }
  return target
}

/** Dropped / opened paths: no extension → most likely a folder (main expands folders and accepts files either way). */
export function entriesFromPaths(paths: string[]): { path: string; isFolder: boolean }[] {
  return paths.map((path) => ({ path, isFolder: !/\.[^\\/.]+$/.test(fileName(path)) }))
}

/** Rows that need the user's attention in the preview table. */
export function isAttention(status: FileOpPreviewItem['status']): boolean {
  return status === 'renamed' || status === 'overwrite' || status === 'skip'
}

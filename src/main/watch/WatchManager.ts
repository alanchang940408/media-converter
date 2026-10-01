// Watch folders (AME-style): new media dropped into a folder is queued with the folder's presets.
// No Electron imports — the queue, presets and stores are injected.
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync, type Stats } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { classifyPath } from '../../shared/media'
import type { AddJobsRequest, AddJobsResult, Job, WatchFolder } from '../../shared/types'
import { t } from '../i18n'
import type { JsonStore } from '../jsonStore'
import type { PresetLookup } from '../presets/store'
import { pathKey, RENAME_TEMP_SUFFIX, TEMP_SUFFIX } from '../queue/outputPath'

export interface WatchQueue {
  /** `internal.relativeDir`: folder of the file relative to the watch folder (kept below the output folder). */
  addJobs(req: AddJobsRequest, internal?: { relativeDir?: string }): Promise<AddJobsResult>
  getJobs(): Job[]
  onJobEnd(listener: (job: Job) => void): () => void
}

export interface WatchFolderFile {
  version: 1
  folders: WatchFolder[]
}

export interface ProcessedFile {
  version: 1
  /** "path|size|mtimeMs" → time it was queued */
  entries: Record<string, number>
}

export const emptyWatchFolderFile = (): WatchFolderFile => ({ version: 1, folders: [] })
export const emptyProcessedFile = (): ProcessedFile => ({ version: 1, entries: {} })

export interface WatchDeps {
  queue: WatchQueue
  presets: PresetLookup
  folders: JsonStore<WatchFolderFile>
  processed: JsonStore<ProcessedFile>
  /** Default { stabilityThreshold: 2000, pollInterval: 400 }. */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number }
  usePolling?: boolean
  onError?: (folder: WatchFolder, err: Error) => void
}

interface ActiveWatcher {
  watcher: FSWatcher
  signature: string
  ready: Promise<void>
}

interface PendingSource {
  folderId: string
  source: string
  /** Still adding jobs for this source (don't move yet). */
  adding: boolean
  jobs: Map<string, 'pending' | 'ok' | 'bad'>
}

const MAX_PROCESSED = 50000
const TEMP_EXTS = ['.tmp', '.temp', '.part', '.partial', '.crdownload', '.download', '.!ut', TEMP_SUFFIX, RENAME_TEMP_SUFFIX]
const JUNK_FILES = new Set(['thumbs.db', 'desktop.ini', '.ds_store'])

export function effectiveOutputDir(f: WatchFolder): string {
  return f.outputDir ? resolve(f.outputDir) : join(f.path, 'Output')
}

export function sourceArchiveDir(f: WatchFolder): string {
  return join(f.path, 'Source')
}

const isInside = (key: string, parentKey: string): boolean => key === parentKey || key.startsWith(parentKey.endsWith(sep) ? parentKey : parentKey + sep)

export function processedKey(path: string, st: { size: number; mtimeMs: number }): string {
  return `${pathKey(path)}|${st.size}|${st.mtimeMs}`
}

/** Chokidar `ignored` matcher for one watch folder. */
export function makeIgnored(f: WatchFolder): (p: string, stats?: Stats) => boolean {
  const rootKey = pathKey(f.path)
  const outKey = pathKey(effectiveOutputDir(f))
  const srcKey = pathKey(sourceArchiveDir(f))
  return (p, stats) => {
    const key = pathKey(p)
    if (key === rootKey) return false
    if (isInside(key, outKey) || isInside(key, srcKey)) return true
    const name = basename(p)
    const lower = name.toLowerCase()
    if (name.startsWith('.') || name.startsWith('~$') || JUNK_FILES.has(lower)) return true
    if (TEMP_EXTS.some((e) => lower.endsWith(e))) return true
    if (stats?.isFile() && !classifyPath(p)) return true
    return false
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function moveFile(src: string, dest: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(src, dest)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        await copyFile(src, dest)
        await unlink(src)
        return
      }
      // Windows: a reader (ffmpeg, AV scanner) may still hold the file briefly
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await sleep(200 * (attempt + 1))
    }
  }
}

function uniquePath(p: string): string {
  if (!existsSync(p)) return p
  const ext = extname(p)
  const stem = p.slice(0, p.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!existsSync(candidate)) return candidate
  }
}

export class WatchManager {
  private readonly watchers = new Map<string, ActiveWatcher>()
  private readonly pending = new Map<string, PendingSource>()
  private readonly inFlight = new Set<string>()
  private readonly tasks = new Set<Promise<unknown>>()
  private syncChain: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private closed = false

  constructor(private readonly deps: WatchDeps) {}

  list(): WatchFolder[] {
    return structuredClone(this.deps.folders.get().folders)
  }

  private folder(id: string): WatchFolder | undefined {
    return this.deps.folders.get().folders.find((f) => f.id === id)
  }

  /** Subscribe to job results, restore move-tracking from the queue and start all enabled watchers. */
  async start(): Promise<void> {
    this.closed = false
    if (!this.unsubscribe) this.unsubscribe = this.deps.queue.onJobEnd((job) => this.onJobEnd(job))
    this.restorePending()
    await this.sync()
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    const all = [...this.watchers.values()]
    this.watchers.clear()
    await Promise.all(all.map((w) => w.watcher.close().catch(() => undefined)))
    await Promise.allSettled([...this.tasks])
    await this.deps.processed.flush()
  }

  /** Resolves once every active watcher finished its initial scan (and initial files were handled). */
  async whenReady(): Promise<void> {
    await this.syncChain
    await Promise.all([...this.watchers.values()].map((w) => w.ready))
    await this.idle()
  }

  /** Resolves when no file events are being processed. */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }

  async save(input: WatchFolder): Promise<WatchFolder> {
    const path = resolve(String(input.path ?? ''))
    const st = input.path ? await stat(path).catch(() => null) : null
    if (!st?.isDirectory()) throw new Error(t('error.folderMissing', { path: input.path ?? '' }))
    const outputDir = input.outputDir && input.outputDir.trim() ? resolve(input.outputDir) : null
    if (outputDir && pathKey(outputDir) === pathKey(path)) throw new Error(t('error.outputIsWatchFolder'))
    // watch folders convert; batch rename / copy / move presets are not allowed there
    if ((Array.isArray(input.presetIds) ? input.presetIds : []).some((id) => this.deps.presets.get(id)?.kind === 'file')) {
      throw new Error(t('error.filePresetInWatch'))
    }
    const folders = this.deps.folders.get().folders
    const idx = input.id ? folders.findIndex((f) => f.id === input.id) : -1
    const clean: WatchFolder = {
      id: idx >= 0 ? input.id : randomUUID(),
      path,
      enabled: input.enabled !== false,
      presetIds: [...new Set((Array.isArray(input.presetIds) ? input.presetIds : []).filter((x) => typeof x === 'string' && x))],
      outputDir,
      includeSubfolders: !!input.includeSubfolders,
      afterProcess: input.afterProcess === 'move' ? 'move' : 'keep',
      processExisting: !!input.processExisting,
    }
    if (idx >= 0) folders[idx] = clean
    else folders.push(clean)
    this.deps.folders.save()
    await mkdir(effectiveOutputDir(clean), { recursive: true }).catch(() => undefined)
    await this.sync()
    return structuredClone(clean)
  }

  async delete(id: string): Promise<void> {
    const data = this.deps.folders.get()
    const next = data.folders.filter((f) => f.id !== id)
    if (next.length === data.folders.length) return
    data.folders = next
    this.deps.folders.save()
    await this.sync()
  }

  /** Bring running watchers in line with the stored folders. Serialized. */
  sync(): Promise<void> {
    const run = this.syncChain.then(() => this.doSync())
    this.syncChain = run.catch(() => undefined)
    return run
  }

  private async doSync(): Promise<void> {
    if (this.closed) return
    const wanted = new Map(this.deps.folders.get().folders.filter((f) => f.enabled).map((f) => [f.id, f]))
    for (const [id, w] of [...this.watchers]) {
      const f = wanted.get(id)
      if (!f || this.signature(f) !== w.signature) {
        this.watchers.delete(id)
        await w.watcher.close().catch(() => undefined)
      }
    }
    for (const f of wanted.values()) {
      if (this.watchers.has(f.id)) continue
      const st = await stat(f.path).catch(() => null)
      if (!st?.isDirectory()) {
        this.deps.onError?.(f, new Error(t('error.folderMissing', { path: f.path })))
        continue
      }
      this.watchers.set(f.id, this.createWatcher(f))
    }
  }

  private signature(f: WatchFolder): string {
    return JSON.stringify([pathKey(f.path), pathKey(effectiveOutputDir(f)), f.includeSubfolders, f.processExisting])
  }

  private createWatcher(f: WatchFolder): ActiveWatcher {
    const watcher = chokidarWatch(f.path, {
      ignored: makeIgnored(f),
      ignoreInitial: !f.processExisting,
      depth: f.includeSubfolders ? undefined : 0,
      awaitWriteFinish: this.deps.awaitWriteFinish ?? { stabilityThreshold: 2000, pollInterval: 400 },
      ignorePermissionErrors: true,
      persistent: true,
      usePolling: this.deps.usePolling ?? false,
    })
    const id = f.id
    const onFile = (p: string): void => {
      const task = this.handleFile(id, p)
      this.tasks.add(task)
      void task.finally(() => this.tasks.delete(task))
    }
    watcher.on('add', onFile)
    watcher.on('change', onFile)
    watcher.on('error', (err) => {
      const folder = this.folder(id)
      if (folder) this.deps.onError?.(folder, err instanceof Error ? err : new Error(String(err)))
    })
    const ready = new Promise<void>((res) => watcher.once('ready', () => res()))
    return { watcher, signature: this.signature(f), ready }
  }

  private isProcessed(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.deps.processed.get().entries, key)
  }

  private markProcessed(key: string): void {
    const data = this.deps.processed.get()
    data.entries[key] = Date.now()
    const keys = Object.keys(data.entries)
    if (keys.length > MAX_PROCESSED) {
      const drop = keys.sort((a, b) => data.entries[a] - data.entries[b]).slice(0, keys.length - MAX_PROCESSED)
      for (const k of drop) delete data.entries[k]
    }
    this.deps.processed.save()
  }

  private async handleFile(folderId: string, file: string): Promise<void> {
    const folder = this.folder(folderId)
    if (!folder || !folder.enabled || !this.watchers.has(folderId) || this.closed) return
    const kind = classifyPath(file)
    if (!kind) return
    const abs = resolve(file)
    const fileKey = pathKey(abs)
    if (this.inFlight.has(fileKey)) return
    this.inFlight.add(fileKey)
    try {
      const st = await stat(abs).catch(() => null)
      if (!st?.isFile()) return
      const key = processedKey(abs, st)
      if (this.isProcessed(key)) return
      const wantKind = kind === 'image' ? 'image' : 'video'
      const presets = folder.presetIds.map((id) => this.deps.presets.get(id)).filter((p) => p?.kind === wantKind)
      if (!presets.length) return
      this.markProcessed(key)

      // subfolders of the watch folder are recreated below the output folder (preserveStructure)
      const rawRel = relative(folder.path, dirname(abs))
      const rel = rawRel && !rawRel.startsWith('..') && !isAbsolute(rawRel) ? rawRel : ''
      const out = effectiveOutputDir(folder)

      const entryKey = `${folder.id}|${fileKey}`
      const entry: PendingSource | null =
        folder.afterProcess === 'move' ? { folderId: folder.id, source: abs, adding: true, jobs: new Map() } : null
      if (entry) this.pending.set(entryKey, entry)
      const jobIds: string[] = []
      try {
        for (const p of presets) {
          const res = await this.deps.queue.addJobs(
            {
              paths: [abs],
              videoPresetId: wantKind === 'video' ? p!.id : undefined,
              imagePresetId: wantKind === 'image' ? p!.id : undefined,
              output: { dir: out, preserveStructure: true },
              watchFolderId: folder.id,
            },
            { relativeDir: rel },
          )
          jobIds.push(...res.jobs.map((j) => j.id))
        }
      } finally {
        if (entry) {
          for (const id of jobIds) if (!entry.jobs.has(id)) entry.jobs.set(id, 'pending')
          entry.adding = false
          if (!entry.jobs.size) this.pending.delete(entryKey)
          else this.maybeMove(entryKey, entry)
        }
      }
    } catch (err) {
      this.deps.onError?.(folder, err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.inFlight.delete(fileKey)
    }
  }

  private onJobEnd(job: Job): void {
    if (!job.watchFolderId) return
    const entryKey = `${job.watchFolderId}|${pathKey(job.source)}`
    const entry = this.pending.get(entryKey)
    if (!entry) return
    entry.jobs.set(job.id, job.status === 'done' || job.status === 'skipped' ? 'ok' : 'bad')
    this.maybeMove(entryKey, entry)
  }

  /** Queue jobs survive restarts; rebuild "move when all done" tracking from them. */
  private restorePending(): void {
    const groups = new Map<string, PendingSource>()
    for (const job of this.deps.queue.getJobs()) {
      if (!job.watchFolderId) continue
      const folder = this.folder(job.watchFolderId)
      if (!folder || folder.afterProcess !== 'move') continue
      const entryKey = `${folder.id}|${pathKey(job.source)}`
      if (this.pending.has(entryKey)) continue
      let g = groups.get(entryKey)
      if (!g) groups.set(entryKey, (g = { folderId: folder.id, source: job.source, adding: false, jobs: new Map() }))
      g.jobs.set(job.id, job.status === 'done' || job.status === 'skipped' ? 'ok' : job.status === 'failed' || job.status === 'cancelled' ? 'bad' : 'pending')
    }
    for (const [key, g] of groups) {
      // all finished before the last quit → nothing left to do
      if ([...g.jobs.values()].every((s) => s === 'ok')) continue
      this.pending.set(key, g)
    }
  }

  private maybeMove(entryKey: string, entry: PendingSource): void {
    if (entry.adding || !entry.jobs.size) return
    if (![...entry.jobs.values()].every((s) => s === 'ok')) return
    this.pending.delete(entryKey)
    const task = this.moveToSource(entry).catch((err) => {
      const folder = this.folder(entry.folderId)
      if (folder) this.deps.onError?.(folder, err instanceof Error ? err : new Error(String(err)))
    })
    this.tasks.add(task)
    void task.finally(() => this.tasks.delete(task))
  }

  private async moveToSource(entry: PendingSource): Promise<void> {
    const folder = this.folder(entry.folderId)
    if (!folder || !existsSync(entry.source)) return
    const rel = relative(folder.path, entry.source)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
    const target = join(sourceArchiveDir(folder), rel)
    await mkdir(dirname(target), { recursive: true })
    await moveFile(entry.source, uniquePath(target))
  }
}

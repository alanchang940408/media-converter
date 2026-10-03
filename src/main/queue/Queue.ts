// The encode queue: jobs, scheduling (separate video / image / file-operation pools), output naming,
// temp-file-then-rename, progress aggregation and persistence. No Electron imports — OS integration goes through QueueEffects.
import { randomUUID } from 'node:crypto'
import { existsSync, type Stats } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { baseNameOf, classifyPath, extOf, withDisplaySize } from '../../shared/media'
import { renderNameTemplate, type NamingVars } from '../../shared/naming'
import type {
  AddJobsRequest,
  AddJobsResult,
  ConflictPolicy,
  EncoderCapabilities,
  FileOperation,
  FileOpPreviewItem,
  FileOpUndoInfo,
  FileOpUndoResult,
  FilePreset,
  ImagePreset,
  Job,
  JobPatch,
  JobProgress,
  Locale,
  MediaInfo,
  OutputTarget,
  Preset,
  QueueEvent,
  QueueSnapshot,
  VideoPreset,
} from '../../shared/types'
import type { EncodeProgress, FfmpegEngine, ImageEngine, OutputSize, VideoOverlay } from '../contracts'
import { t, type I18nKey } from '../i18n'
import type { JsonStore } from '../jsonStore'
import { DEFAULT_FILE_PRESET_ID } from '../presets/builtin'
import type { PresetLookup } from '../presets/store'
import type { SettingsAccess } from '../settings'
import { classify, jobError } from './errors'
import {
  caseTempPath,
  copyData,
  CopySizeError,
  type FileOpsFs,
  type FileStamp,
  fileStampOf,
  isReplacedFile,
  isSameFile,
  nodeFileOps,
  relocate,
  renameWithRetry,
} from './fileOps'
import { MAX_JOURNAL_RUNS, MemoryJournal, type FileOpJournalRun, type JournalStore } from './journal'
import {
  exactExt,
  pathKey,
  RENAME_TEMP_SUFFIX,
  resolveFileTarget,
  resolveOutputPath,
  safeRelativeDir,
  TEMP_SUFFIX,
  type FileTarget,
} from './outputPath'

export interface QueueEffects {
  /** Every queue event (pushed to the renderer). */
  onEvent?: (e: QueueEvent) => void
  /** Taskbar progress of the current run, 0..1, or null to clear. */
  setProgress?: (fraction: number | null) => void
  /** Hold (true) / release (false) the OS sleep blocker. */
  setPreventSleep?: (on: boolean) => void
  notify?: (title: string, body: string) => void
}

interface JobMeta {
  /** 1-based index within the add batch ({counter} token). */
  counter: number
}

export interface PersistedQueue {
  version: 1
  jobs: Job[]
  meta?: Record<string, JobMeta>
}

export function emptyQueue(): PersistedQueue {
  return { version: 1, jobs: [], meta: {} }
}

export interface QueueDeps {
  ffmpeg: FfmpegEngine
  image: ImageEngine
  store: JsonStore<PersistedQueue>
  settings: SettingsAccess
  presets: PresetLookup
  getCapabilities: () => Promise<EncoderCapabilities>
  effects?: QueueEffects
  /** Undo journal of move / rename runs (userData file-ops-journal.json); in-memory when omitted. */
  journal?: JournalStore
  /** File-system primitives used by file jobs (tests inject failures such as EXDEV). */
  fileOps?: Partial<FileOpsFs>
  /** Where watermark overlay PNGs go; default <os tmp>/media-converter. */
  tmpDir?: string
  /** Default 4. */
  probeConcurrency?: number
  /** Simultaneous rename / copy / move jobs; default 4. */
  fileConcurrency?: number
  /** Progress event throttle; default 200 ms (≤ 5/s). */
  progressIntervalMs?: number
}

/** Main-process-only extras for addJobs (not reachable over IPC). */
export interface AddJobsInternal {
  /** Watch folders: folder of the file relative to the watch folder (applied to every added file). */
  relativeDir?: string
}

type EndStatus = 'done' | 'failed' | 'cancelled' | 'skipped'
type Outcome =
  | { status: 'done' }
  | { status: 'skipped'; outputPath: string }
  | { status: 'failed'; error: unknown }
  | { status: 'aborted' }

interface ActiveJob {
  job: Job
  controller: AbortController
  /** Why it was aborted: stop → back to queued, cancel → cancelled, remove → gone. */
  reason: 'stop' | 'cancel' | 'remove' | null
  reserved: string | null
  /** File jobs: claimed a move / rename to another path, i.e. this job's source is about to become free. */
  vacating: boolean
  /** File jobs: position in claim order (set at the first claim, 0 before). A job only ever waits on lower ones. */
  claimSeq: number
  settled: boolean
  done: Promise<void>
}

interface RunStats {
  /** Jobs of this run (counted in the summary / taskbar). File jobs, and every job of a restricted run, must be in it to start. */
  ids: Set<string>
  /** Started for chosen jobs only (startQueue(ids), e.g. a batch rename): other queued jobs do not start. */
  restricted: boolean
  done: number
  failed: number
  cancelled: number
  skipped: number
}

/** How other jobs hold a path as their source. */
type SourceOwnership = { state: 'taken' } | { state: 'vacating'; entries: ActiveJob[] } | null

const FINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'skipped'])
const SIZE_TOKENS = /\{(width|height)\}/
const TAKEN_TOKENS = /\{exif(date|time)\}/

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const clone = <T>(v: T): T => structuredClone(v)
const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}
const isEncodeErrorLike = (err: unknown): err is Error & { logTail: string[] } =>
  err instanceof Error && Array.isArray((err as { logTail?: unknown }).logTail)
const isFileOperation = (v: unknown): v is FileOperation => v === 'copy' || v === 'move' || v === 'rename'

export function localizedPresetName(p: Preset, locale: Locale): string {
  return p.names?.[locale] ?? p.name
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules'])
const JUNK_FILES = new Set(['thumbs.db', 'ehthumbs.db', 'desktop.ini', '.ds_store'])

/** Hidden / system / our own temp files: never queued, not even in file mode. */
export function isHiddenOrSystemFile(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    JUNK_FILES.has(lower) ||
    lower.endsWith(TEMP_SUFFIX) ||
    lower.endsWith(RENAME_TEMP_SUFFIX)
  )
}

/** Natural order of two paths, folder by folder ("2" before "10"); fully deterministic (raw string as last resort). */
export function comparePathsNatural(a: string, b: string): number {
  const as = a.split(/[\\/]/)
  const bs = b.split(/[\\/]/)
  const n = Math.min(as.length, bs.length)
  for (let i = 0; i < n; i++) {
    const c = collator.compare(as[i], bs[i])
    if (c) return c
  }
  if (as.length !== bs.length) return as.length - bs.length
  return a < b ? -1 : a > b ? 1 : 0
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

export interface ExpandedFile {
  path: string
  /** Folder relative to the added folder ('' directly inside it); undefined when the file was added on its own. */
  relativeDir?: string
  /** Only for sortBy 'modified' / 'taken'. */
  mtimeMs?: number
  /** Only for sortBy 'taken' (photos with an EXIF date). */
  takenAt?: number
}

export interface ExpandOptions {
  recursive?: boolean
  /** 'media' = supported media only (others are reported as ignored); 'file' = every regular file except hidden/system/temp ones. */
  mode?: 'media' | 'file'
  sortBy?: 'name' | 'modified' | 'taken'
  /** EXIF taken time reader for sortBy 'taken'. */
  readTakenAt?: (path: string, st: Stats) => Promise<number | undefined>
}

/**
 * Expand files/folders into the files to queue, deterministically ordered: natural name order (folder by folder),
 * or by modified time / EXIF taken time (fallback: modified) with the natural order breaking ties.
 */
export async function expandPaths(
  paths: string[],
  options: boolean | ExpandOptions,
): Promise<{ files: string[]; entries: ExpandedFile[]; ignored: string[] }> {
  const opts: ExpandOptions = typeof options === 'boolean' ? { recursive: options } : options
  const fileMode = opts.mode === 'file'
  const recursive = !!opts.recursive
  const sortBy = opts.sortBy ?? 'name'
  const entries: ExpandedFile[] = []
  const ignored: string[] = []
  const seen = new Set<string>()

  const accept = (abs: string): boolean =>
    fileMode ? !isHiddenOrSystemFile(basename(abs)) : !!classifyPath(abs) && !abs.toLowerCase().endsWith(TEMP_SUFFIX)

  const addFile = (abs: string, original: string, relativeDir: string | undefined): void => {
    if (!accept(abs)) {
      ignored.push(original)
      return
    }
    const key = pathKey(abs)
    if (seen.has(key)) return
    seen.add(key)
    entries.push(relativeDir === undefined ? { path: abs } : { path: abs, relativeDir })
  }

  const walk = async (root: string, dir: string, depth: number): Promise<void> => {
    let list
    try {
      list = await readdir(dir, { withFileTypes: true })
    } catch {
      ignored.push(dir)
      return
    }
    list.sort((a, b) => collator.compare(a.name, b.name))
    const rel = relative(root, dir)
    for (const e of list) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      const abs = join(dir, e.name)
      if (e.isFile()) {
        // hidden / system files inside a folder are skipped silently in file mode
        if (fileMode && isHiddenOrSystemFile(e.name)) continue
        addFile(abs, abs, rel)
      } else if (e.isDirectory()) {
        if (recursive && depth < 32 && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(root, abs, depth + 1)
      } else if (e.isSymbolicLink()) {
        const st = await stat(abs).catch(() => null)
        if (st?.isFile() && !(fileMode && isHiddenOrSystemFile(e.name))) addFile(abs, abs, rel)
      }
    }
  }

  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const abs = resolve(p)
    const st = await stat(abs).catch(() => null)
    if (!st) ignored.push(p)
    else if (st.isDirectory()) await walk(abs, abs, 0)
    else if (st.isFile()) addFile(abs, p, undefined)
    else ignored.push(p)
  }

  if (sortBy === 'name') {
    entries.sort((a, b) => comparePathsNatural(a.path, b.path))
  } else {
    await mapLimit(entries, 8, async (e) => {
      const st = await stat(e.path).catch(() => null)
      e.mtimeMs = st ? st.mtimeMs : 0
      if (sortBy === 'taken' && st && opts.readTakenAt) {
        const taken = await opts.readTakenAt(e.path, st).catch(() => undefined)
        if (taken !== undefined) e.takenAt = taken
      }
    })
    const time = (e: ExpandedFile): number => (sortBy === 'taken' ? (e.takenAt ?? e.mtimeMs ?? 0) : (e.mtimeMs ?? 0))
    entries.sort((a, b) => time(a) - time(b) || comparePathsNatural(a.path, b.path))
  }
  return { files: entries.map((e) => e.path), entries, ignored }
}

export class Queue {
  private jobs: Job[]
  private meta: Record<string, JobMeta>
  private running = false
  private run: RunStats | null = null
  private readonly active = new Map<string, ActiveJob>()
  private readonly reserved = new Set<string>()
  /** Outputs written during the current run (pathKey → job id): never overwritten by another job of the same run. */
  private readonly runOutputs = new Map<string, string>()
  private readonly listeners = new Set<(e: QueueEvent) => void>()
  private readonly endListeners = new Set<(job: Job) => void>()
  private readonly probes = new Map<string, Promise<MediaInfo>>()
  private probeBacklog: string[] = []
  private probesRunning = 0
  private dirtyProgress = new Set<string>()
  private progressTimer: NodeJS.Timeout | null = null
  private lastProgressEmit = 0
  private snapshotTimer: NodeJS.Timeout | null = null
  private lastTaskbar: number | null = null
  private holdingPower = false
  private pumping = false
  private pumpAgain = false
  private staleTemps: string[] = []
  /** Case-only renames interrupted by a crash: intermediate name → original source. */
  private staleCaseRenames: { tmp: string; source: string }[] = []
  /** File jobs claim their target strictly in start order (= queue order). */
  private claimChain: Promise<void> = Promise.resolve()
  /** Last ActiveJob.claimSeq handed out. */
  private claimCounter = 0
  /** pathKey(source) → jobs with that source; rebuilt lazily after structural changes. */
  private srcIndex: Map<string, Job[]> | null = null
  /** "pathKey|size|mtimeMs" → EXIF taken time (null = none). */
  private readonly takenCache = new Map<string, number | null>()
  private readonly journal: JournalStore
  /** Journal record of the file-operation batch in progress. */
  private journalRun: FileOpJournalRun | null = null
  private readonly fs: FileOpsFs
  private readonly tmpDir: string
  private readonly progressInterval: number
  private readonly fileConcurrency: number

  constructor(private readonly deps: QueueDeps) {
    this.tmpDir = deps.tmpDir ?? join(tmpdir(), 'media-converter')
    this.progressInterval = deps.progressIntervalMs ?? 200
    this.fileConcurrency = Math.max(1, deps.fileConcurrency ?? 4)
    this.fs = { ...nodeFileOps, ...deps.fileOps }
    this.journal = deps.journal ?? new MemoryJournal()
    const data = deps.store.get()
    // a damaged queue.json must not take the app down: drop entries that are not jobs at all
    this.jobs = Array.isArray(data?.jobs)
      ? data.jobs.filter(
          (j) =>
            !!j &&
            typeof j.id === 'string' &&
            typeof j.source === 'string' &&
            (j.kind === 'video' || j.kind === 'image' || j.kind === 'file') &&
            !!j.output &&
            typeof j.output === 'object' &&
            typeof j.output.nameTemplate === 'string',
        )
      : []
    this.meta = data?.meta && typeof data.meta === 'object' ? data.meta : {}
    for (const job of this.jobs) {
      // jobs saved before MediaInfo carried the displayed size of non-square-pixel sources
      if (job.sourceInfo) job.sourceInfo = withDisplaySize(job.sourceInfo)
      if (job.status === 'running') {
        if (job.outputPath) this.staleTemps.push(job.outputPath + TEMP_SUFFIX)
        if (job.kind === 'file') this.staleCaseRenames.push({ tmp: caseTempPath(job.source, job.id.slice(0, 8)), source: job.source })
        this.resetForQueue(job)
      }
    }
    // batches interrupted by a quit / crash are closed (and become undoable)
    const journal = this.journal.get()
    let closed = false
    for (const r of journal.runs) {
      if (r.finishedAt === undefined) {
        r.finishedAt = Date.now()
        closed = true
      }
    }
    if (closed) this.journal.save()
    this.persist()
  }

  /** Clean up after a crash and probe restored jobs that have no media info yet. */
  async init(): Promise<void> {
    const temps = this.staleTemps
    this.staleTemps = []
    await Promise.all(temps.map((p) => rm(p, { force: true }).catch(() => undefined)))
    const cases = this.staleCaseRenames
    this.staleCaseRenames = []
    for (const c of cases) {
      if (!existsSync(c.source) && existsSync(c.tmp)) await rename(c.tmp, c.source).catch(() => undefined)
    }
    for (const job of this.jobs) if (!job.sourceInfo && !FINAL.has(job.status)) this.probeBacklog.push(job.id)
    this.pumpProbes()
  }

  private tr(key: I18nKey, params?: Record<string, string | number>): string {
    return t(key, params, this.deps.settings.locale())
  }

  // ───────────────────────────── read / subscribe ─────────────────────────────

  getSnapshot(): QueueSnapshot {
    return { jobs: clone(this.jobs), running: this.running }
  }

  getJobs(): Job[] {
    return clone(this.jobs)
  }

  isRunning(): boolean {
    return this.running
  }

  /** True while ffmpeg/sharp/file work is in flight or startable work is pending in a started queue. */
  hasActiveWork(): boolean {
    return this.active.size > 0 || (this.running && this.jobs.some((j) => this.isStartable(j)))
  }

  subscribe(listener: (e: QueueEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Called whenever a job reaches done / failed / cancelled / skipped. */
  onJobEnd(listener: (job: Job) => void): () => void {
    this.endListeners.add(listener)
    return () => this.endListeners.delete(listener)
  }

  // ───────────────────────────── adding ─────────────────────────────

  async addJobs(req: AddJobsRequest, internal: AddJobsInternal = {}): Promise<AddJobsResult> {
    const settings = this.deps.settings.get()
    const locale = this.deps.settings.locale()
    const fileMode = !!req.filePresetId
    if (fileMode && req.watchFolderId) throw new Error(this.tr('error.filePresetInWatch'))
    const filePreset = fileMode
      ? (this.pickPreset('file', req.filePresetId, settings.lastFilePresetId, DEFAULT_FILE_PRESET_ID) as FilePreset)
      : null
    const sortBy = req.sortBy === 'modified' || req.sortBy === 'taken' ? req.sortBy : 'name'
    const { entries, ignored } = await expandPaths(Array.isArray(req.paths) ? req.paths : [], {
      recursive: !!req.recursive,
      mode: fileMode ? 'file' : 'media',
      sortBy,
      readTakenAt: (p, st) => this.cachedTakenAt(p, st),
    })

    let videoPreset: VideoPreset | null = null
    let imagePreset: ImagePreset | null = null
    const getVideoPreset = (): VideoPreset =>
      (videoPreset ??= this.pickPreset('video', req.videoPresetId, settings.lastVideoPresetId, 'h264-match') as VideoPreset)
    const getImagePreset = (): ImagePreset =>
      (imagePreset ??= this.pickPreset('image', req.imagePresetId, settings.lastImagePresetId, 'img-jpeg-q90') as ImagePreset)

    const forcedRel = internal.relativeDir !== undefined ? (safeRelativeDir(internal.relativeDir) ?? '') : undefined
    const fromFolder = forcedRel !== undefined || entries.some((e) => e.relativeDir !== undefined)
    const o = req.output ?? {}
    const dir = o.dir !== undefined ? o.dir || null : settings.defaultOutputDir
    // preserveStructure: explicit value, else the settings default for folder adds with an output folder;
    // left unset without an output folder so the default still applies when one is chosen later (updateJob)
    const preserveStructure =
      typeof o.preserveStructure === 'boolean' ? o.preserveStructure : dir ? fromFolder && settings.preserveStructure : undefined
    const output: OutputTarget = {
      dir,
      nameTemplate: o.nameTemplate && o.nameTemplate.trim() ? o.nameTemplate : settings.defaultNameTemplate,
      conflict: o.conflict ?? settings.conflict,
      ...(preserveStructure !== undefined ? { preserveStructure } : {}),
    }

    const createdAt = Date.now()
    const added: Job[] = []
    let counter = 0
    for (const entry of entries) {
      const source = entry.path
      const relativeDir = forcedRel ?? entry.relativeDir
      const base = {
        id: randomUUID(),
        source,
        ...(relativeDir !== undefined ? { relativeDir } : {}),
        output: { ...output },
        status: 'queued' as const,
        progress: 0,
        createdAt,
        ...(req.watchFolderId ? { watchFolderId: req.watchFolderId } : {}),
      }
      let job: Job
      if (filePreset) {
        job = {
          ...base,
          kind: 'file',
          presetId: filePreset.id,
          presetName: localizedPresetName(filePreset, locale),
          file: { operation: filePreset.operation },
        }
      } else {
        const kind = classifyPath(source)
        if (!kind) continue
        if (kind === 'image') {
          if (req.imageOverride) {
            const basePreset = req.imagePresetId ? this.deps.presets.get(req.imagePresetId) : undefined
            job = {
              ...base,
              kind: 'image',
              presetId: basePreset?.id ?? 'custom',
              presetName: basePreset ? localizedPresetName(basePreset, locale) : t('preset.custom', undefined, locale),
              image: { actions: clone(req.imageOverride.actions), output: clone(req.imageOverride.output) },
            }
          } else {
            const p = getImagePreset()
            job = {
              ...base,
              kind: 'image',
              presetId: p.id,
              presetName: localizedPresetName(p, locale),
              image: { actions: clone(p.actions), output: clone(p.output) },
            }
          }
        } else {
          const p = getVideoPreset()
          job = { ...base, kind: 'video', presetId: p.id, presetName: localizedPresetName(p, locale), video: { settings: clone(p.settings) } }
        }
      }
      this.meta[job.id] = { counter: ++counter }
      added.push(job)
    }

    if (added.length) {
      this.jobs.push(...added)
      this.srcIndex = null
      // file jobs only run after the user confirmed the preview (startQueue), even in a running queue; a run limited to
      // chosen jobs only takes new conversions that start on their own (autoStart, watch folders)
      if (this.run && !fileMode && (!this.run.restricted || settings.autoStart || req.watchFolderId)) {
        for (const j of added) this.run.ids.add(j.id)
      }
      if (!req.watchFolderId) {
        const patch: Partial<typeof settings> = {}
        if (videoPreset && (videoPreset as VideoPreset).id !== settings.lastVideoPresetId) patch.lastVideoPresetId = (videoPreset as VideoPreset).id
        if (imagePreset && (imagePreset as ImagePreset).id !== settings.lastImagePresetId) patch.lastImagePresetId = (imagePreset as ImagePreset).id
        if (filePreset && filePreset.id !== settings.lastFilePresetId) patch.lastFilePresetId = filePreset.id
        if (Object.keys(patch).length) this.deps.settings.patch(patch)
      }
      this.changed()
      if (!fileMode) {
        for (const j of added) this.probeBacklog.push(j.id)
        this.pumpProbes()
        if (settings.autoStart || req.watchFolderId) this.start(true)
      }
    }
    return { jobs: clone(added), ignored }
  }

  private pickPreset(kind: Preset['kind'], requested: string | null | undefined, remembered: string, fallback: string): Preset {
    if (requested) {
      const p = this.deps.presets.get(requested)
      if (!p) throw new Error(this.tr('error.unknownPreset', { id: requested }))
      if (p.kind !== kind) throw new Error(this.tr('error.presetKind', { name: p.name }))
      return p
    }
    for (const id of [remembered, fallback]) {
      const p = id ? this.deps.presets.get(id) : undefined
      if (p && p.kind === kind) return p
    }
    throw new Error(this.tr('error.unknownPreset', { id: fallback }))
  }

  // ───────────────────────────── editing ─────────────────────────────

  updateJob(id: string, patch: JobPatch): Job {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) throw new Error(this.tr('error.jobNotFound'))
    if (job.status === 'running') throw new Error(this.tr('error.jobRunning'))
    const hasSettings = !!(patch.video?.settings || patch.image?.actions || patch.image?.output || patch.file?.operation)
    if (patch.presetId !== undefined && patch.presetId !== job.presetId) {
      const p = this.deps.presets.get(patch.presetId)
      if (p) {
        if (p.kind !== job.kind) throw new Error(this.tr('error.presetKind', { name: p.name }))
        if (!hasSettings) this.applyPresetTo(job, p)
        else {
          job.presetId = p.id
          job.presetName = localizedPresetName(p, this.deps.settings.locale())
        }
      } else {
        job.presetId = patch.presetId
      }
    }
    if (patch.video && job.kind === 'video') {
      const cur = job.video ?? { settings: clone(patch.video.settings!) }
      if (patch.video.settings) cur.settings = clone(patch.video.settings)
      if ('trim' in patch.video) cur.trim = patch.video.trim ? { ...patch.video.trim } : null
      job.video = cur
    }
    if (patch.image && job.kind === 'image' && job.image) {
      if (patch.image.actions) job.image.actions = clone(patch.image.actions)
      if (patch.image.output) job.image.output = clone(patch.image.output)
    }
    if (patch.file && job.kind === 'file' && isFileOperation(patch.file.operation)) {
      job.file = { operation: patch.file.operation }
    }
    if (patch.output) {
      const o = patch.output
      if ('dir' in o) job.output.dir = o.dir || null
      if (o.nameTemplate !== undefined) job.output.nameTemplate = o.nameTemplate.trim() ? o.nameTemplate : '{name}'
      if (o.conflict !== undefined) job.output.conflict = o.conflict
      if (o.preserveStructure !== undefined) job.output.preserveStructure = !!o.preserveStructure
      else if (job.output.dir && job.output.preserveStructure === undefined && job.relativeDir !== undefined) {
        // first output folder for a job from an added folder: same default as adding with an output folder
        job.output.preserveStructure = this.deps.settings.get().preserveStructure
      }
    }
    if (job.status === 'failed' || job.status === 'cancelled') this.requeue(job)
    this.changed()
    this.pump()
    return clone(job)
  }

  applyPreset(jobIds: string[], presetId: string): void {
    const p = this.deps.presets.get(presetId)
    if (!p) throw new Error(this.tr('error.unknownPreset', { id: presetId }))
    const ids = new Set(jobIds)
    let touched = false
    for (const job of this.jobs) {
      if (!ids.has(job.id) || job.kind !== p.kind || job.status === 'running') continue
      this.applyPresetTo(job, p)
      if (job.status === 'failed' || job.status === 'cancelled') this.requeue(job)
      touched = true
    }
    if (!touched) return
    this.deps.settings.patch(
      p.kind === 'video' ? { lastVideoPresetId: p.id } : p.kind === 'image' ? { lastImagePresetId: p.id } : { lastFilePresetId: p.id },
    )
    this.changed()
    this.pump()
  }

  private applyPresetTo(job: Job, p: Preset): void {
    job.presetId = p.id
    job.presetName = localizedPresetName(p, this.deps.settings.locale())
    if (p.kind === 'video') job.video = { settings: clone(p.settings), trim: job.video?.trim ?? null }
    else if (p.kind === 'image') job.image = { actions: clone(p.actions), output: clone(p.output) }
    else job.file = { operation: p.operation }
  }

  duplicateJobs(ids: string[]): void {
    const wanted = new Set(ids)
    const next: Job[] = []
    let added = 0
    for (const job of this.jobs) {
      next.push(job)
      if (!wanted.has(job.id)) continue
      const copy = clone(job)
      copy.id = randomUUID()
      copy.createdAt = Date.now()
      this.resetForQueue(copy)
      this.meta[copy.id] = { counter: this.meta[job.id]?.counter ?? 1 }
      if (this.run && copy.kind !== 'file' && !this.run.restricted) this.run.ids.add(copy.id)
      next.push(copy)
      added++
    }
    if (!added) return
    this.jobs = next
    this.srcIndex = null
    this.changed()
    this.pump()
  }

  reorderJobs(ids: string[]): void {
    const byId = new Map(this.jobs.map((j) => [j.id, j]))
    const ordered: Job[] = []
    for (const id of ids) {
      const j = byId.get(id)
      if (j) {
        ordered.push(j)
        byId.delete(id)
      }
    }
    // jobs missing from the request keep their relative order at the end
    for (const j of this.jobs) if (byId.has(j.id)) ordered.push(j)
    this.jobs = ordered
    this.changed()
  }

  async removeJobs(ids: string[]): Promise<void> {
    const set = new Set(ids)
    const waits: Promise<void>[] = []
    for (const id of set) {
      const entry = this.active.get(id)
      if (entry) {
        entry.reason = 'remove'
        entry.controller.abort()
        waits.push(entry.done)
      }
    }
    const before = this.jobs.length
    this.jobs = this.jobs.filter((j) => !set.has(j.id))
    this.srcIndex = null
    for (const id of set) {
      delete this.meta[id]
      this.run?.ids.delete(id)
    }
    if (this.jobs.length !== before) this.changed()
    await Promise.all(waits)
    this.pump()
  }

  retryJobs(ids: string[]): void {
    const set = new Set(ids)
    let touched = false
    for (const job of this.jobs) {
      if (!set.has(job.id) || !FINAL.has(job.status)) continue
      this.requeue(job)
      touched = true
    }
    if (!touched) return
    this.changed()
    // auto-start never picks up file jobs (they wait for the user's go after the preview)
    if (this.deps.settings.get().autoStart) this.start(true)
    else this.pump()
  }

  clearFinished(): void {
    const keep = this.jobs.filter((j) => !FINAL.has(j.status))
    if (keep.length === this.jobs.length) return
    for (const j of this.jobs) if (FINAL.has(j.status)) delete this.meta[j.id]
    this.jobs = keep
    this.srcIndex = null
    this.changed()
  }

  // ───────────────────────────── run control ─────────────────────────────

  /**
   * Start (or continue) the queue. A user start includes every queued job; `auto` starts (autoStart setting,
   * watch folders, retries) leave file jobs alone — those always wait for an explicit start after the preview.
   * With `only` (a batch rename's Run) just those queued jobs start: a restricted run that finishes when they are
   * through. A plain start during a restricted run widens it to the whole queue; `only` during a run adds those jobs.
   */
  start(auto = false, only?: readonly string[]): void {
    const want = only ? new Set(only) : null
    if (this.running) {
      if (!auto && this.run) {
        if (!want) this.run.restricted = false
        for (const j of this.jobs) if (j.status === 'queued' && (!want || want.has(j.id))) this.run.ids.add(j.id)
      }
      this.pump()
      return
    }
    this.running = true
    this.run = {
      ids: new Set(
        this.jobs.filter((j) => j.status === 'queued' && (want ? want.has(j.id) : !auto || j.kind !== 'file')).map((j) => j.id),
      ),
      restricted: !!want,
      done: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    }
    for (const id of this.active.keys()) if (!want || want.has(id)) this.run.ids.add(id)
    this.emitSnapshot()
    this.pump()
  }

  /** Stop starting jobs and abort running ones; they go back to 'queued'. Resolves when all processes ended. */
  async stop(): Promise<void> {
    this.running = false
    this.run = null
    this.runOutputs.clear()
    const waits: Promise<void>[] = []
    for (const entry of this.active.values()) {
      if (!entry.reason) entry.reason = 'stop'
      entry.controller.abort()
      waits.push(entry.done)
    }
    this.emitSnapshot()
    await Promise.all(waits)
    this.closeJournalRun()
    this.updateTaskbar()
    this.updatePower()
    this.emitSnapshot()
  }

  async cancelJobs(ids: string[]): Promise<void> {
    const waits: Promise<void>[] = []
    let touched = false
    for (const id of new Set(ids)) {
      const job = this.jobs.find((j) => j.id === id)
      if (!job) continue
      const entry = this.active.get(id)
      if (entry) {
        entry.reason = 'cancel'
        entry.controller.abort()
        waits.push(entry.done)
      } else if (job.status === 'queued') {
        job.status = 'cancelled'
        job.finishedAt = Date.now()
        this.countEnd(job, 'cancelled')
        this.fireEnd(job)
        touched = true
      }
    }
    if (touched) this.changed()
    await Promise.all(waits)
    this.pump()
  }

  /** Re-read settings (concurrency, removeFinished, preventSleep) after they change. */
  refresh(): void {
    const s = this.deps.settings.get()
    if (s.removeFinished) {
      const keep = this.jobs.filter((j) => j.status !== 'done')
      if (keep.length !== this.jobs.length) {
        for (const j of this.jobs) if (j.status === 'done') delete this.meta[j.id]
        this.jobs = keep
        this.srcIndex = null
        this.changed()
      }
    }
    this.updatePower()
    this.pump()
  }

  /** App quit: abort everything (jobs stay queued for next launch), delete temp files, flush to disk. */
  async shutdown(): Promise<void> {
    await this.stop()
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    if (this.progressTimer) clearTimeout(this.progressTimer)
    this.snapshotTimer = null
    this.progressTimer = null
    await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined)
    await this.deps.store.flush()
    await this.journal.flush()
  }

  // ───────────────────────────── scheduling ─────────────────────────────

  /** Queued and allowed to start now: file jobs need an explicit start (they are in the run), so does every job of a restricted run. */
  private isStartable(j: Job): boolean {
    return j.status === 'queued' && ((j.kind === 'file' || this.run?.restricted) ? !!this.run?.ids.has(j.id) : true)
  }

  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        this.pumpOnce()
      } while (this.pumpAgain)
    } finally {
      this.pumping = false
    }
  }

  private pumpOnce(): void {
    let file = 0
    for (const a of this.active.values()) if (a.job.kind === 'file') file++
    if (this.running) {
      const s = this.deps.settings.get()
      let video = 0
      let image = 0
      for (const a of this.active.values()) {
        if (a.job.kind === 'video') video++
        else if (a.job.kind === 'image') image++
      }
      for (const job of this.jobs) {
        if (video >= s.videoConcurrency && image >= s.imageConcurrency && file >= this.fileConcurrency) break
        if (!this.isStartable(job)) continue
        if (job.kind === 'video' && video < s.videoConcurrency) {
          video++
          this.startJob(job)
        } else if (job.kind === 'image' && image < s.imageConcurrency) {
          image++
          this.startJob(job)
        } else if (job.kind === 'file' && file < this.fileConcurrency) {
          file++
          this.startJob(job)
        }
      }
    }
    // a batch of file operations ended → its undo record is complete
    if (this.journalRun && file === 0 && !this.jobs.some((j) => j.kind === 'file' && this.isStartable(j))) this.closeJournalRun()
    if (this.running && this.active.size === 0 && !this.jobs.some((j) => this.isStartable(j))) this.finishRun()
  }

  private finishRun(): void {
    const run = this.run
    this.running = false
    this.run = null
    this.runOutputs.clear()
    this.closeJournalRun()
    this.updateTaskbar()
    this.updatePower()
    this.emitSnapshot()
    if (!run || run.done + run.failed + run.cancelled + run.skipped === 0) return
    const summary = { done: run.done, failed: run.failed, cancelled: run.cancelled, skipped: run.skipped }
    this.emit({ type: 'finished', summary })
    const s = this.deps.settings.get()
    if (s.notifyOnFinish && this.deps.effects?.notify) {
      const locale = this.deps.settings.locale()
      const body =
        summary.failed === 0 && summary.skipped === 0 && summary.cancelled === 0
          ? t('notify.allDone', summary, locale)
          : summary.skipped === 0 && summary.cancelled === 0
            ? t('notify.withFailures', summary, locale)
            : t('notify.summary', summary, locale)
      try {
        this.deps.effects.notify(t('notify.finishedTitle', undefined, locale), body)
      } catch (err) {
        console.error('[queue] notify failed:', err)
      }
    }
  }

  private startJob(job: Job): void {
    job.status = 'running'
    job.progress = 0
    job.startedAt = Date.now()
    for (const k of ['error', 'errorCode', 'errorParams', 'logTail', 'outputPath', 'encoder', 'speed', 'fps', 'etaSec', 'elapsedSec', 'outputSizeBytes', 'finishedAt'] as const) {
      delete job[k]
    }
    const entry: ActiveJob = {
      job,
      controller: new AbortController(),
      reason: null,
      reserved: null,
      vacating: false,
      claimSeq: 0,
      settled: false,
      done: Promise.resolve(),
    }
    this.active.set(job.id, entry)
    this.run?.ids.add(job.id)
    const work = job.kind === 'file' ? this.executeFile(job, entry) : this.execute(job, entry)
    entry.done = work.catch((err) => {
      console.error('[queue] unexpected error:', err)
      this.settle(job, entry, { status: 'failed', error: err })
    })
    this.changed()
  }

  /** Output folder of a job: next to the source, the output folder, or the output folder + the job's subfolder. */
  private outputDirFor(job: Job): string {
    const sourceDir = dirname(resolve(job.source))
    if (job.kind === 'file' && job.file?.operation === 'rename') return sourceDir
    if (!job.output.dir) return sourceDir
    const base = resolve(job.output.dir)
    if (!job.output.preserveStructure) return base
    const rel = safeRelativeDir(job.relativeDir)
    return rel ? join(base, rel) : base
  }

  private namingVars(job: Job, st: Stats | null, now: Date, takenAt: number | undefined, size?: { width: number; height: number } | null): NamingVars {
    return {
      name: baseNameOf(job.source),
      ext: extOf(job.source),
      preset: job.presetName,
      parent: basename(dirname(job.source)),
      width: size?.width,
      height: size?.height,
      counter: this.meta[job.id]?.counter ?? 1,
      now,
      ...(takenAt !== undefined ? { taken: new Date(takenAt) } : {}),
      ...(st ? { modified: st.mtime } : {}),
    }
  }

  /** EXIF taken time of a job's source, read only when the template needs it. */
  private async takenFor(job: Job, st: Stats): Promise<number | undefined> {
    if (!TAKEN_TOKENS.test(job.output.nameTemplate)) return undefined
    if (job.sourceInfo?.takenAt !== undefined) return job.sourceInfo.takenAt
    return this.cachedTakenAt(job.source, st)
  }

  private async cachedTakenAt(path: string, st: Stats): Promise<number | undefined> {
    const key = `${pathKey(path)}|${st.size}|${st.mtimeMs}`
    if (this.takenCache.has(key)) return this.takenCache.get(key) ?? undefined
    let taken: number | undefined
    try {
      taken = await this.deps.image.readTakenAt(path)
    } catch {
      taken = undefined
    }
    if (this.takenCache.size > 50000) this.takenCache.clear()
    this.takenCache.set(key, taken ?? null)
    return taken
  }

  private async execute(job: Job, entry: ActiveJob): Promise<void> {
    const signal = entry.controller.signal
    let tmp: string | null = null
    let overlayPng: string | null = null
    // never settle synchronously inside startJob()/pump()
    await Promise.resolve()
    try {
      const now = new Date()
      const settings = this.deps.settings.get()
      const st = await stat(job.source).catch(() => null)
      if (!st?.isFile()) throw jobError(this.tr('error.sourceMissing', { path: job.source }), 'sourceMissing')

      let info = job.sourceInfo
      let size: OutputSize | null = null
      let ext: string
      if (job.kind === 'video') {
        if (!job.video) throw new Error('Job has no video settings')
        if (!info) {
          info = await this.probeJob(job)
          job.sourceInfo = info
        }
        this.throwIfAborted(signal)
        size = this.deps.ffmpeg.computeOutputSize(info, job.video.settings)
        ext = this.deps.ffmpeg.outputExtension(job.video.settings)
      } else {
        if (!job.image) throw new Error('Job has no image settings')
        ext = this.deps.image.outputExtension(job.image.output, job.source)
      }

      const dir = this.outputDirFor(job)
      await mkdir(dir, { recursive: true })
      this.throwIfAborted(signal)

      const vars = this.namingVars(job, st, now, await this.takenFor(job, st), size)
      this.throwIfAborted(signal)
      const target = this.claimOutput(job, entry, dir, renderNameTemplate(job.output.nameTemplate, vars), ext)
      if (target.skip) {
        this.settle(job, entry, { status: 'skipped', outputPath: target.path })
        return
      }
      job.outputPath = target.path
      tmp = target.path + TEMP_SUFFIX
      this.changed()

      if (job.kind === 'video') {
        const vs = job.video!.settings
        let overlay: VideoOverlay | null = null
        if (vs.watermark && vs.video.codec !== 'copy' && vs.video.codec !== 'none' && size) {
          // Non-square output pixels (DVD-Video): lay the watermark out for the displayed frame, squeezed to stored pixels.
          const layer = await this.deps.image.renderWatermarkLayer(
            vs.watermark,
            size.width,
            size.height,
            { name: vars.name, date: ymd(now) },
            size.sar ? { sampleAspect: size.sar } : undefined,
          )
          await mkdir(this.tmpDir, { recursive: true })
          overlayPng = join(this.tmpDir, `${job.id}.png`)
          await writeFile(overlayPng, layer.png)
          overlay = { pngPath: overlayPng, left: layer.left, top: layer.top }
          this.throwIfAborted(signal)
        }
        const caps = await this.deps.getCapabilities()
        this.throwIfAborted(signal)
        const res = await this.deps.ffmpeg.encode({
          source: job.source,
          info: info!,
          settings: vs,
          trim: job.video!.trim ?? null,
          dest: tmp,
          overlay,
          caps,
          preferredHw: settings.preferredHw,
          signal,
          onProgress: (p) => this.onProgress(job, p),
          onLog: (line) => this.onLog(job, line),
        })
        job.encoder = res.encoder
      } else {
        const img = job.image!
        const res = await this.deps.image.process({ source: job.source, actions: img.actions, output: img.output, dest: tmp, signal })
        job.encoder = 'sharp'
        this.throwIfAborted(signal)
        if (SIZE_TOKENS.test(job.output.nameTemplate)) {
          // image output size is only known after processing
          const name = renderNameTemplate(job.output.nameTemplate, { ...vars, width: res.width, height: res.height })
          this.release(entry)
          const t2 = this.claimOutput(job, entry, dir, name, ext)
          if (t2.skip) {
            await rm(tmp, { force: true })
            tmp = null
            this.settle(job, entry, { status: 'skipped', outputPath: t2.path })
            return
          }
          job.outputPath = t2.path
        }
      }

      // an engine that ignored the signal still counts as cancelled
      this.throwIfAborted(signal)
      if ((await this.commit(job, entry, tmp, dir, ext)) === 'skipped') {
        await removeWithRetry(tmp)
        tmp = null
        this.settle(job, entry, { status: 'skipped', outputPath: job.outputPath! })
        return
      }
      tmp = null
      try {
        job.outputSizeBytes = (await stat(job.outputPath!)).size
      } catch {
        /* ignore */
      }
      this.settle(job, entry, { status: 'done' })
    } catch (err) {
      if (tmp) await removeWithRetry(tmp)
      tmp = null
      if (signal.aborted) this.settle(job, entry, { status: 'aborted' })
      else this.settle(job, entry, { status: 'failed', error: err })
    } finally {
      if (overlayPng) await removeWithRetry(overlayPng)
    }
  }

  private claimOutput(
    job: Job,
    entry: ActiveJob,
    dir: string,
    baseName: string,
    ext: string,
    conflict: ConflictPolicy = job.output.conflict,
  ): { path: string; skip: boolean } {
    const r = resolveOutputPath({
      dir,
      baseName,
      ext,
      conflict,
      source: job.source,
      reserved: this.reserved,
      // never write onto a file another job still has to read
      isTaken: (key) => this.isRunOutput(key, job) || this.sourceOwnership(key, job) !== null,
    })
    if (!r.skip) {
      entry.reserved = pathKey(r.path)
      this.reserved.add(entry.reserved)
    }
    return r
  }

  private release(entry: ActiveJob): void {
    if (entry.reserved) this.reserved.delete(entry.reserved)
    entry.reserved = null
  }

  /**
   * Move the finished temp file onto the final name. 'skipped' (temp file left to the caller) when policy 'skip' finds
   * that the name was taken while encoding.
   */
  private async commit(job: Job, entry: ActiveJob, tmp: string, dir: string, ext: string): Promise<'done' | 'skipped'> {
    let final = job.outputPath!
    if (existsSync(final)) {
      // the output folder may be another path to the source's folder (junction, short name, UNC…): never the source
      const isSource = await isSameFile(final, job.source)
      if (isSource || job.output.conflict !== 'overwrite') {
        // something else created the file while we were encoding: never clobber it
        const base = basename(final).slice(0, -(ext.length + 1))
        this.release(entry)
        const r = this.claimOutput(job, entry, dir, base, ext, isSource || job.output.conflict !== 'skip' ? 'rename' : 'skip')
        job.outputPath = r.path
        if (r.skip) return 'skipped'
        final = r.path
      }
    }
    await renameWithRetry(nodeFileOps, tmp, final)
    return 'done'
  }

  // ───────────────────────────── file operations (rename / copy / move) ─────────────────────────────

  private sourceIndex(): Map<string, Job[]> {
    if (!this.srcIndex) {
      const idx = new Map<string, Job[]>()
      for (const j of this.jobs) {
        const key = pathKey(j.source)
        const list = idx.get(key)
        if (list) list.push(j)
        else idx.set(key, [j])
      }
      this.srcIndex = idx
    }
    return this.srcIndex
  }

  /** Written by another job of the current run (one batch never produces two files with the same name). */
  private isRunOutput(key: string, self: Job): boolean {
    const owner = this.runOutputs.get(key)
    return owner !== undefined && owner !== self.id
  }

  /** A finished move / rename that took its source away (the old path is free again). */
  private vacatedSource(j: Job): boolean {
    return (
      j.kind === 'file' &&
      j.file?.operation !== 'copy' &&
      j.status === 'done' &&
      !!j.outputPath &&
      pathKey(j.outputPath) !== pathKey(j.source)
    )
  }

  /**
   * Is `key` the source of another job that still needs it?
   * taken    → queued / running job, or a job of the current run that left its source in place (never overwrite it)
   * vacating → only running moves / renames that are taking it away: usable once they finished
   */
  private sourceOwnership(key: string, self: Job): SourceOwnership {
    const owners = this.sourceIndex().get(key)
    if (!owners) return null
    const vacating: ActiveJob[] = []
    for (const j of owners) {
      if (j === self) continue
      if (j.status === 'queued') return { state: 'taken' }
      if (j.status === 'running') {
        const a = this.active.get(j.id)
        if (a?.vacating) {
          vacating.push(a)
          continue
        }
        return { state: 'taken' }
      }
      if (this.vacatedSource(j)) continue
      if (this.run?.ids.has(j.id)) return { state: 'taken' }
    }
    return vacating.length ? { state: 'vacating', entries: vacating } : null
  }

  /** Resolve and reserve a file job's destination against the live state. Synchronous. */
  private claimFileTarget(job: Job, entry: ActiveJob, dir: string, baseName: string): FileTarget & { waitFor: ActiveJob[] } {
    const op = job.file!.operation
    if (!entry.claimSeq) entry.claimSeq = ++this.claimCounter
    const vacatingByKey = new Map<string, ActiveJob[]>()
    const r = resolveFileTarget({
      dir,
      baseName,
      ext: exactExt(job.source),
      conflict: job.output.conflict,
      source: job.source,
      operation: op,
      isTaken: (key) => {
        if (this.reserved.has(key) || this.isRunOutput(key, job)) return true
        const own = this.sourceOwnership(key, job)
        if (!own) return false
        if (own.state === 'taken') return true
        // only ever wait on jobs that claimed before this one: a later one (met when picking a new name after waiting)
        // may itself be waiting on this job, and the two would wait on each other forever → treat its source as taken
        if (own.entries.some((a) => a.claimSeq > entry.claimSeq)) return true
        vacatingByKey.set(key, own.entries)
        return false
      },
      // isTaken() always runs first for a candidate, so vacatingByKey is filled
      exists: (p) => !vacatingByKey.has(pathKey(p)) && existsSync(p),
    })
    let waitFor: ActiveJob[] = []
    if (r.status === 'ok' || r.status === 'renamed' || r.status === 'overwrite') {
      const key = pathKey(r.path)
      waitFor = vacatingByKey.get(key) ?? []
      entry.reserved = key
      this.reserved.add(key)
      entry.vacating = op !== 'copy' && key !== pathKey(job.source)
    }
    return { ...r, waitFor }
  }

  private async waitForJobs(entries: ActiveJob[], signal: AbortSignal): Promise<void> {
    if (!entries.length) return
    let onAbort: () => void = () => undefined
    const aborted = new Promise<void>((res) => {
      onAbort = () => res()
      if (signal.aborted) res()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      await Promise.race([Promise.all(entries.map((e) => e.done)), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    this.throwIfAborted(signal)
  }

  /**
   * Wait until a claimed name is really usable: earlier moves / renames that free it have finished, and nothing else
   * took it meanwhile. Otherwise pick again (never clobbering a file that was not meant to be overwritten).
   */
  private async confirmFileTarget(
    job: Job,
    entry: ActiveJob,
    dir: string,
    baseName: string,
    claim: FileTarget & { waitFor: ActiveJob[] },
    signal: AbortSignal,
  ): Promise<FileTarget> {
    let cur = claim
    for (let round = 0; ; round++) {
      if (cur.status === 'skip' || cur.status === 'unchanged') return cur
      await this.waitForJobs(cur.waitFor, signal)
      const occupied = pathKey(cur.path) !== pathKey(job.source) && existsSync(cur.path)
      if (!occupied || cur.status === 'overwrite') return cur
      if (round >= 8) throw new Error(`No free output name for ${cur.path}`)
      this.release(entry)
      entry.vacating = false
      cur = this.claimFileTarget(job, entry, dir, baseName)
      if (cur.status !== 'skip' && cur.status !== 'unchanged') {
        job.outputPath = cur.path
        this.changed()
      }
    }
  }

  private async executeFile(job: Job, entry: ActiveJob): Promise<void> {
    const signal = entry.controller.signal
    // claims happen strictly in start order, so earlier jobs' targets are known when a later job picks a name
    const prevTurn = this.claimChain
    let releaseTurn!: () => void
    const myTurn = new Promise<void>((r) => (releaseTurn = r))
    this.claimChain = prevTurn.then(() => myTurn)
    let tmp: string | null = null
    let committed = false
    await Promise.resolve()
    try {
      const op = job.file?.operation
      if (!isFileOperation(op)) throw new Error('Job has no file operation')
      job.encoder = op
      let st: Stats
      let dir: string
      let baseName: string
      let claimed: FileTarget & { waitFor: ActiveJob[] }
      try {
        const s = await stat(job.source).catch(() => null)
        if (!s?.isFile()) throw jobError(this.tr('error.sourceMissing', { path: job.source }), 'sourceMissing')
        st = s
        const taken = await this.takenFor(job, st)
        baseName = renderNameTemplate(job.output.nameTemplate, this.namingVars(job, st, new Date(), taken))
        dir = this.outputDirFor(job)
        await prevTurn
        this.throwIfAborted(signal)
        claimed = this.claimFileTarget(job, entry, dir, baseName)
      } finally {
        releaseTurn()
      }
      if (claimed.status !== 'skip' && claimed.status !== 'unchanged') {
        job.outputPath = claimed.path
        this.changed()
      }

      let target = await this.confirmFileTarget(job, entry, dir, baseName, claimed, signal)
      if (target.status === 'skip') {
        this.settle(job, entry, { status: 'skipped', outputPath: target.path })
        return
      }
      if (target.status === 'unchanged') {
        // the name is already right: nothing to do, the file is not touched
        job.outputPath = job.source
        job.outputSizeBytes = st.size
        this.settle(job, entry, { status: 'done' })
        return
      }
      this.throwIfAborted(signal)
      await mkdir(dirname(target.path), { recursive: true })
      this.throwIfAborted(signal)
      const onProgress = (fraction: number): void => {
        const elapsedSec = (Date.now() - (job.startedAt ?? Date.now())) / 1000
        this.onProgress(job, { fraction, elapsedSec })
      }

      if (op === 'copy') {
        tmp = target.path + TEMP_SUFFIX
        await copyData(this.fs, job.source, tmp, st, { signal, onProgress })
        this.throwIfAborted(signal)
        // a file may have appeared while we were copying
        target = await this.confirmFileTarget(job, entry, dir, baseName, { ...target, waitFor: [] }, signal)
        if (target.status === 'skip' || target.status === 'unchanged') {
          await removeWithRetry(tmp)
          tmp = null
          if (target.status === 'skip') this.settle(job, entry, { status: 'skipped', outputPath: target.path })
          else {
            job.outputPath = job.source
            this.settle(job, entry, { status: 'done' })
          }
          return
        }
        await renameWithRetry(this.fs, tmp, target.path)
        tmp = null
        committed = true
      } else {
        const from = job.source
        await relocate(this.fs, from, target.path, { tag: job.id.slice(0, 8), signal, onProgress })
        committed = true
        this.recordFileOp(op, from, target.path, await fileStampOf(target.path))
      }
      job.outputPath = target.path
      job.outputSizeBytes = st.size
      // the file is in place: done, even if a stop / cancel arrived meanwhile
      this.settle(job, entry, { status: 'done' })
    } catch (err) {
      if (tmp) await removeWithRetry(tmp)
      tmp = null
      if (committed) this.settle(job, entry, { status: 'done' })
      else if (signal.aborted) this.settle(job, entry, { status: 'aborted' })
      else this.settle(job, entry, { status: 'failed', error: err instanceof CopySizeError ? jobError(this.tr('error.copyIncomplete'), 'copyIncomplete') : err })
    }
  }

  /**
   * Dry run of the given queued file jobs in queue order — same rules as a real run, nothing is touched. It assumes
   * they are started with startQueue(jobIds): only they run, plus queued file jobs already part of a running queue
   * (they may claim a name first); other queued jobs keep their sources. Only the requested ones are returned.
   */
  async previewFileOps(jobIds: string[]): Promise<FileOpPreviewItem[]> {
    const wanted = new Set(Array.isArray(jobIds) ? jobIds : [])
    const inRun = (j: Job): boolean => this.running && !!this.run?.ids.has(j.id)
    const list = this.jobs.filter((j) => j.kind === 'file' && j.status === 'queued' && (wanted.has(j.id) || inRun(j)))
    const listed = new Set(list.map((j) => j.id))
    const now = new Date()
    const prepared = await mapLimit(list, 8, async (job) => {
      const st = await stat(job.source).catch(() => null)
      if (!st?.isFile()) return { job, ok: false as const }
      const taken = await this.takenFor(job, st)
      const baseName = renderNameTemplate(job.output.nameTemplate, this.namingVars(job, st, now, taken))
      return { job, ok: true as const, baseName, dir: this.outputDirFor(job) }
    })

    // simulated state of the batch so far
    const pending = new Set(listed)
    /** source keys freed by earlier simulated moves / renames */
    const vacated = new Set<string>()
    /** targets claimed by earlier simulated jobs */
    const created = new Set<string>()
    /** simulated jobs whose source stays in place (copy, skip, unchanged) */
    const stays = new Set<string>()

    const items: FileOpPreviewItem[] = []
    for (const p of prepared) {
      const job = p.job
      pending.delete(job.id)
      const op = job.file?.operation
      if (!p.ok || !isFileOperation(op)) {
        // missing source (or a damaged job): the run would not touch anything either
        stays.add(job.id)
        if (wanted.has(job.id)) items.push({ jobId: job.id, source: job.source, target: null, status: 'skip' })
        continue
      }
      const freedByRunning = new Set<string>()
      const r = resolveFileTarget({
        dir: p.dir,
        baseName: p.baseName,
        ext: exactExt(job.source),
        conflict: job.output.conflict,
        source: job.source,
        operation: op,
        isTaken: (key) => {
          if (created.has(key) || this.reserved.has(key) || this.isRunOutput(key, job)) return true
          for (const o of this.sourceIndex().get(key) ?? []) {
            if (o === job) continue
            if (listed.has(o.id)) {
              if (pending.has(o.id) || stays.has(o.id)) return true
              continue
            }
            if (o.status === 'queued') return true
            if (o.status === 'running') {
              if (this.active.get(o.id)?.vacating) {
                freedByRunning.add(key)
                continue
              }
              return true
            }
            if (this.vacatedSource(o)) continue
            if (this.run?.ids.has(o.id)) return true
          }
          return false
        },
        exists: (path) => {
          const key = pathKey(path)
          if (vacated.has(key) || freedByRunning.has(key)) return false
          return existsSync(path)
        },
      })
      if (wanted.has(job.id)) items.push({ jobId: job.id, source: job.source, target: r.status === 'skip' ? null : r.path, status: r.status })
      if (r.status === 'skip' || r.status === 'unchanged') {
        stays.add(job.id)
        continue
      }
      const targetKey = pathKey(r.path)
      const sourceKey = pathKey(job.source)
      created.add(targetKey)
      if (op !== 'copy' && targetKey !== sourceKey) {
        vacated.add(sourceKey)
        vacated.delete(targetKey)
      } else {
        stays.add(job.id)
      }
    }
    return items
  }

  private recordFileOp(op: 'move' | 'rename', from: string, to: string, stamp: FileStamp | null): void {
    const journal = this.journal.get()
    if (!this.journalRun) {
      this.journalRun = { id: randomUUID(), startedAt: Date.now(), entries: [] }
      journal.runs.push(this.journalRun)
      if (journal.runs.length > MAX_JOURNAL_RUNS) journal.runs.splice(0, journal.runs.length - MAX_JOURNAL_RUNS)
    }
    this.journalRun.entries.push({ from, to, op, ...stamp })
    this.journal.save()
  }

  private closeJournalRun(): void {
    if (!this.journalRun) return
    this.journalRun.finishedAt = Date.now()
    this.journalRun = null
    this.journal.save()
  }

  /** Newest finished batch that can be undone (none while a batch is still running). */
  private latestUndoRun(): FileOpJournalRun | null {
    if (this.journalRun) return null
    const runs = this.journal.get().runs
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].finishedAt !== undefined && runs[i].entries.length) return runs[i]
    }
    return null
  }

  getFileOpUndo(): FileOpUndoInfo | null {
    const run = this.latestUndoRun()
    if (!run) return null
    let move = 0
    let renameCount = 0
    for (const e of run.entries) {
      if (e.op === 'move') move++
      else renameCount++
    }
    return { id: run.id, finishedAt: run.finishedAt ?? run.startedAt, count: run.entries.length, operations: { move, rename: renameCount } }
  }

  /** Put the files of the latest move / rename batch back where they were (newest first), then forget the batch. */
  async undoFileOps(): Promise<FileOpUndoResult> {
    if (this.journalRun || [...this.active.values()].some((a) => a.job.kind === 'file')) throw new Error(this.tr('error.undoBusy'))
    const run = this.latestUndoRun()
    if (!run) return { restored: 0, failed: [] }
    const failed: FileOpUndoResult['failed'] = []
    let restored = 0
    const tag = randomUUID().slice(0, 8)
    for (const e of [...run.entries].reverse()) {
      try {
        if (!existsSync(e.to)) {
          failed.push({ path: e.to, error: this.tr('error.undoMissing') })
          continue
        }
        // the name may now belong to another file (the original was moved away and something else took its place)
        const now = e.fileId ? await fileStampOf(e.to) : null
        if (now && isReplacedFile(e, now)) {
          failed.push({ path: e.to, error: this.tr('error.undoReplaced') })
          continue
        }
        if (pathKey(e.from) !== pathKey(e.to) && existsSync(e.from)) {
          failed.push({ path: e.to, error: this.tr('error.undoOccupied', { path: e.from }) })
          continue
        }
        await mkdir(dirname(e.from), { recursive: true })
        await relocate(this.fs, e.to, e.from, { tag })
        restored++
      } catch (err) {
        failed.push({ path: e.to, error: errorMessage(err), errorCode: classify(err, { kind: 'file', source: e.to }).code })
      }
    }
    const journal = this.journal.get()
    journal.runs = journal.runs.filter((r) => r !== run)
    this.journal.save()
    await this.journal.flush()
    return { restored, failed }
  }

  // ───────────────────────────── job end ─────────────────────────────

  private settle(job: Job, entry: ActiveJob, outcome: Outcome): void {
    if (entry.settled) return
    entry.settled = true
    this.release(entry)
    entry.vacating = false
    this.active.delete(job.id)
    this.dirtyProgress.delete(job.id)
    const listed = this.jobs.includes(job)
    let end: EndStatus | null = null

    switch (outcome.status) {
      case 'aborted':
        if (entry.reason === 'cancel') {
          job.status = 'cancelled'
          job.finishedAt = Date.now()
          delete job.outputPath
          end = 'cancelled'
        } else if (entry.reason !== 'remove') {
          this.resetForQueue(job)
        }
        break
      case 'failed':
        job.status = 'failed'
        job.error = errorMessage(outcome.error)
        {
          const { code, params } = classify(outcome.error, job)
          job.errorCode = code
          job.errorParams = params
        }
        if (isEncodeErrorLike(outcome.error) && outcome.error.logTail.length) job.logTail = outcome.error.logTail.slice(-40)
        job.finishedAt = Date.now()
        delete job.outputPath
        end = 'failed'
        break
      case 'skipped':
        job.status = 'skipped'
        job.outputPath = outcome.outputPath
        job.finishedAt = Date.now()
        end = 'skipped'
        break
      case 'done':
        job.status = 'done'
        job.progress = 1
        job.etaSec = 0
        job.finishedAt = Date.now()
        if (job.startedAt) job.elapsedSec = (job.finishedAt - job.startedAt) / 1000
        if (job.outputPath && this.run) this.runOutputs.set(pathKey(job.outputPath), job.id)
        end = 'done'
        break
    }

    if (end && listed) {
      this.countEnd(job, end)
      this.fireEnd(job)
      if (end === 'done' && this.deps.settings.get().removeFinished) {
        this.jobs = this.jobs.filter((j) => j !== job)
        this.srcIndex = null
        delete this.meta[job.id]
      }
    }
    this.changed()
    this.pump()
  }

  private countEnd(job: Job, status: EndStatus): void {
    if (this.run?.ids.has(job.id)) this.run[status]++
  }

  private fireEnd(job: Job): void {
    const copy = clone(job)
    for (const l of this.endListeners) {
      try {
        l(copy)
      } catch (err) {
        console.error('[queue] job-end listener failed:', err)
      }
    }
  }

  private requeue(job: Job): void {
    this.resetForQueue(job)
    // a re-queued file job waits for the next explicit start (the user sees a fresh preview first)
    if (job.kind === 'file') this.run?.ids.delete(job.id)
    else if (this.run && (!this.run.restricted || this.deps.settings.get().autoStart)) this.run.ids.add(job.id)
  }

  private resetForQueue(job: Job): void {
    job.status = 'queued'
    job.progress = 0
    for (const k of [
      'error',
      'errorCode',
      'errorParams',
      'logTail',
      'outputPath',
      'encoder',
      'speed',
      'fps',
      'etaSec',
      'elapsedSec',
      'outputSizeBytes',
      'startedAt',
      'finishedAt',
    ] as const) {
      delete job[k]
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  // ───────────────────────────── probing ─────────────────────────────

  private probeJob(job: Job): Promise<MediaInfo> {
    let p = this.probes.get(job.id)
    if (!p) {
      p = job.kind === 'image' ? this.deps.image.probe(job.source) : this.deps.ffmpeg.probe(job.source)
      this.probes.set(job.id, p)
      const forget = (): void => {
        if (this.probes.get(job.id) === p) this.probes.delete(job.id)
      }
      p.then(forget, forget)
    }
    return p
  }

  private pumpProbes(): void {
    const limit = this.deps.probeConcurrency ?? 4
    while (this.probesRunning < limit && this.probeBacklog.length) {
      const id = this.probeBacklog.shift()!
      const job = this.jobs.find((j) => j.id === id)
      // file jobs are never probed: their sources may be any file type, and probing would hold files they move
      if (!job || job.sourceInfo || job.kind === 'file') continue
      this.probesRunning++
      this.probeJob(job)
        .then((info) => {
          if (!job.sourceInfo && this.jobs.includes(job)) {
            job.sourceInfo = info
            this.scheduleSnapshot()
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.probesRunning--
          this.pumpProbes()
        })
    }
  }

  // ───────────────────────────── progress / events ─────────────────────────────

  private onProgress(job: Job, p: EncodeProgress): void {
    if (job.status !== 'running') return
    job.progress = Math.max(0, Math.min(1, Number.isFinite(p.fraction) ? p.fraction : 0))
    job.speed = p.speed
    job.fps = p.fps
    job.etaSec = p.etaSec
    job.elapsedSec = p.elapsedSec
    this.dirtyProgress.add(job.id)
    if (this.progressTimer) return
    const wait = Math.max(0, this.lastProgressEmit + this.progressInterval - Date.now())
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      this.flushProgress()
    }, wait)
  }

  private flushProgress(): void {
    const items: JobProgress[] = []
    for (const id of this.dirtyProgress) {
      const job = this.active.get(id)?.job
      if (!job) continue
      items.push({ id, progress: job.progress, speed: job.speed, fps: job.fps, etaSec: job.etaSec, elapsedSec: job.elapsedSec })
    }
    this.dirtyProgress.clear()
    this.lastProgressEmit = Date.now()
    if (items.length) this.emit({ type: 'progress', items })
    this.updateTaskbar()
  }

  private onLog(job: Job, line: string): void {
    const tail = job.logTail ?? (job.logTail = [])
    tail.push(line)
    if (tail.length > 40) tail.splice(0, tail.length - 40)
  }

  private emit(e: QueueEvent): void {
    try {
      this.deps.effects?.onEvent?.(e)
    } catch (err) {
      console.error('[queue] event effect failed:', err)
    }
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('[queue] listener failed:', err)
      }
    }
  }

  private emitSnapshot(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }
    this.emit({ type: 'snapshot', state: this.getSnapshot() })
  }

  /** Coalesced snapshot for low-priority updates (probe results). */
  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.persist()
      this.emitSnapshot()
    }, 100)
  }

  private persist(): void {
    this.deps.store.set({ version: 1, jobs: this.jobs, meta: this.meta })
  }

  private changed(): void {
    this.persist()
    this.emitSnapshot()
    this.updateTaskbar()
    this.updatePower()
  }

  private updateTaskbar(): void {
    let value: number | null = null
    if (this.run && (this.running || this.active.size)) {
      let total = 0
      let sum = 0
      for (const job of this.jobs) {
        if (!this.run.ids.has(job.id)) continue
        total++
        sum += FINAL.has(job.status) ? 1 : job.status === 'running' ? job.progress : 0
      }
      value = total ? Math.min(1, sum / total) : 0
    }
    if (value === this.lastTaskbar || (value !== null && this.lastTaskbar !== null && Math.abs(value - this.lastTaskbar) < 0.001)) return
    this.lastTaskbar = value
    try {
      this.deps.effects?.setProgress?.(value)
    } catch (err) {
      console.error('[queue] taskbar effect failed:', err)
    }
  }

  private updatePower(): void {
    const want = this.active.size > 0 && this.deps.settings.get().preventSleep
    if (want === this.holdingPower) return
    this.holdingPower = want
    try {
      this.deps.effects?.setPreventSleep?.(want)
    } catch (err) {
      console.error('[queue] power effect failed:', err)
    }
  }
}

async function removeWithRetry(p: string): Promise<void> {
  await rm(p, { force: true, maxRetries: 6, retryDelay: 100 }).catch(() => undefined)
}

/** Remove leftover *.mcpart files in a folder (best effort). */
export async function cleanTempFiles(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(entries.filter((n) => n.endsWith(TEMP_SUFFIX)).map((n) => removeWithRetry(join(dir, n))))
}

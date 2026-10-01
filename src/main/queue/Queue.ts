// The encode queue: jobs, scheduling (separate video / image pools), output naming, temp-file-then-rename,
// progress aggregation and persistence. No Electron imports — OS integration goes through QueueEffects.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { baseNameOf, classifyPath, extOf } from '../../shared/media'
import { renderNameTemplate, type NamingVars } from '../../shared/naming'
import type {
  AddJobsRequest,
  AddJobsResult,
  EncoderCapabilities,
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
import type { EncodeProgress, FfmpegEngine, ImageEngine, VideoOverlay } from '../contracts'
import { t, type I18nKey } from '../i18n'
import type { JsonStore } from '../jsonStore'
import type { PresetLookup } from '../presets/store'
import type { SettingsAccess } from '../settings'
import { pathKey, resolveOutputPath, TEMP_SUFFIX } from './outputPath'

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
  /** Where watermark overlay PNGs go; default <os tmp>/media-converter. */
  tmpDir?: string
  /** Default 4. */
  probeConcurrency?: number
  /** Progress event throttle; default 200 ms (≤ 5/s). */
  progressIntervalMs?: number
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
  settled: boolean
  done: Promise<void>
}

interface RunStats {
  ids: Set<string>
  done: number
  failed: number
  cancelled: number
  skipped: number
}

const FINAL: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'skipped'])
const SIZE_TOKENS = /\{(width|height)\}/

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const clone = <T>(v: T): T => structuredClone(v)
const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}
const isEncodeErrorLike = (err: unknown): err is Error & { logTail: string[] } =>
  err instanceof Error && Array.isArray((err as { logTail?: unknown }).logTail)

export function localizedPresetName(p: Preset, locale: Locale): string {
  return p.names?.[locale] ?? p.name
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules'])

/** Expand files/folders into supported media files (natural sort order, hidden entries skipped). */
export async function expandPaths(paths: string[], recursive: boolean): Promise<{ files: string[]; ignored: string[] }> {
  const files: string[] = []
  const ignored: string[] = []
  const seen = new Set<string>()
  const addFile = (abs: string, original: string): void => {
    if (!classifyPath(abs) || abs.endsWith(TEMP_SUFFIX)) {
      ignored.push(original)
      return
    }
    const key = pathKey(abs)
    if (seen.has(key)) return
    seen.add(key)
    files.push(abs)
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      ignored.push(dir)
      return
    }
    entries.sort((a, b) => collator.compare(a.name, b.name))
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      const abs = join(dir, e.name)
      if (e.isFile()) addFile(abs, abs)
      else if (e.isDirectory() && recursive && depth < 32 && !SKIP_DIRS.has(e.name.toLowerCase())) await walk(abs, depth + 1)
      else if (e.isSymbolicLink()) {
        const st = await stat(abs).catch(() => null)
        if (st?.isFile()) addFile(abs, abs)
      }
    }
  }
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const abs = resolve(p)
    const st = await stat(abs).catch(() => null)
    if (!st) ignored.push(p)
    else if (st.isDirectory()) await walk(abs, 0)
    else if (st.isFile()) addFile(abs, p)
    else ignored.push(p)
  }
  return { files, ignored }
}

export class Queue {
  private jobs: Job[]
  private meta: Record<string, JobMeta>
  private running = false
  private run: RunStats | null = null
  private readonly active = new Map<string, ActiveJob>()
  private readonly reserved = new Set<string>()
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
  private readonly tmpDir: string
  private readonly progressInterval: number

  constructor(private readonly deps: QueueDeps) {
    this.tmpDir = deps.tmpDir ?? join(tmpdir(), 'media-converter')
    this.progressInterval = deps.progressIntervalMs ?? 200
    const data = deps.store.get()
    this.jobs = Array.isArray(data?.jobs) ? data.jobs.filter((j) => j && typeof j.id === 'string' && typeof j.source === 'string') : []
    this.meta = data?.meta && typeof data.meta === 'object' ? data.meta : {}
    for (const job of this.jobs) {
      if (job.status === 'running') {
        if (job.outputPath) this.staleTemps.push(job.outputPath + TEMP_SUFFIX)
        this.resetForQueue(job)
      }
    }
    this.persist()
  }

  /** Clean up after a crash and probe restored jobs that have no media info yet. */
  async init(): Promise<void> {
    const temps = this.staleTemps
    this.staleTemps = []
    await Promise.all(temps.map((p) => rm(p, { force: true }).catch(() => undefined)))
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

  /** True while ffmpeg/sharp work is in flight or queued work is pending in a started queue. */
  hasActiveWork(): boolean {
    return this.active.size > 0 || (this.running && this.jobs.some((j) => j.status === 'queued'))
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

  async addJobs(req: AddJobsRequest): Promise<AddJobsResult> {
    const settings = this.deps.settings.get()
    const locale = this.deps.settings.locale()
    const { files, ignored } = await expandPaths(Array.isArray(req.paths) ? req.paths : [], !!req.recursive)

    let videoPreset: VideoPreset | null = null
    let imagePreset: ImagePreset | null = null
    const getVideoPreset = (): VideoPreset =>
      (videoPreset ??= this.pickPreset('video', req.videoPresetId, settings.lastVideoPresetId, 'h264-match') as VideoPreset)
    const getImagePreset = (): ImagePreset =>
      (imagePreset ??= this.pickPreset('image', req.imagePresetId, settings.lastImagePresetId, 'img-jpeg-q90') as ImagePreset)

    const o = req.output ?? {}
    const output: OutputTarget = {
      dir: o.dir !== undefined ? o.dir || null : settings.defaultOutputDir,
      nameTemplate: o.nameTemplate && o.nameTemplate.trim() ? o.nameTemplate : settings.defaultNameTemplate,
      conflict: o.conflict ?? settings.conflict,
    }

    const createdAt = Date.now()
    const added: Job[] = []
    let counter = 0
    for (const source of files) {
      const kind = classifyPath(source)
      if (!kind) continue
      const base = {
        id: randomUUID(),
        source,
        output: { ...output },
        status: 'queued' as const,
        progress: 0,
        createdAt,
        ...(req.watchFolderId ? { watchFolderId: req.watchFolderId } : {}),
      }
      let job: Job
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
      this.meta[job.id] = { counter: ++counter }
      added.push(job)
    }

    if (added.length) {
      this.jobs.push(...added)
      if (this.run) for (const j of added) this.run.ids.add(j.id)
      if (!req.watchFolderId) {
        const patch: Partial<typeof settings> = {}
        if (videoPreset && (videoPreset as VideoPreset).id !== settings.lastVideoPresetId) patch.lastVideoPresetId = (videoPreset as VideoPreset).id
        if (imagePreset && (imagePreset as ImagePreset).id !== settings.lastImagePresetId) patch.lastImagePresetId = (imagePreset as ImagePreset).id
        if (Object.keys(patch).length) this.deps.settings.patch(patch)
      }
      this.changed()
      for (const j of added) this.probeBacklog.push(j.id)
      this.pumpProbes()
      if (settings.autoStart || req.watchFolderId) this.start()
    }
    return { jobs: clone(added), ignored }
  }

  private pickPreset(kind: 'video' | 'image', requested: string | null | undefined, remembered: string, fallback: string): Preset {
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
    const hasSettings = !!(patch.video?.settings || patch.image?.actions || patch.image?.output)
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
    if (patch.output) {
      const o = patch.output
      if ('dir' in o) job.output.dir = o.dir || null
      if (o.nameTemplate !== undefined) job.output.nameTemplate = o.nameTemplate.trim() ? o.nameTemplate : '{name}'
      if (o.conflict !== undefined) job.output.conflict = o.conflict
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
    this.deps.settings.patch(p.kind === 'video' ? { lastVideoPresetId: p.id } : { lastImagePresetId: p.id })
    this.changed()
    this.pump()
  }

  private applyPresetTo(job: Job, p: Preset): void {
    job.presetId = p.id
    job.presetName = localizedPresetName(p, this.deps.settings.locale())
    if (p.kind === 'video') job.video = { settings: clone(p.settings), trim: job.video?.trim ?? null }
    else job.image = { actions: clone(p.actions), output: clone(p.output) }
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
      if (this.run) this.run.ids.add(copy.id)
      next.push(copy)
      added++
    }
    if (!added) return
    this.jobs = next
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
    if (this.deps.settings.get().autoStart) this.start()
    else this.pump()
  }

  clearFinished(): void {
    const keep = this.jobs.filter((j) => !FINAL.has(j.status))
    if (keep.length === this.jobs.length) return
    for (const j of this.jobs) if (FINAL.has(j.status)) delete this.meta[j.id]
    this.jobs = keep
    this.changed()
  }

  // ───────────────────────────── run control ─────────────────────────────

  start(): void {
    if (this.running) {
      this.pump()
      return
    }
    this.running = true
    this.run = {
      ids: new Set(this.jobs.filter((j) => j.status === 'queued').map((j) => j.id)),
      done: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    }
    for (const id of this.active.keys()) this.run.ids.add(id)
    this.emitSnapshot()
    this.pump()
  }

  /** Stop starting jobs and abort running ones; they go back to 'queued'. Resolves when all processes ended. */
  async stop(): Promise<void> {
    this.running = false
    this.run = null
    const waits: Promise<void>[] = []
    for (const entry of this.active.values()) {
      if (!entry.reason) entry.reason = 'stop'
      entry.controller.abort()
      waits.push(entry.done)
    }
    this.emitSnapshot()
    await Promise.all(waits)
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
  }

  // ───────────────────────────── scheduling ─────────────────────────────

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
    if (!this.running) return
    const s = this.deps.settings.get()
    let video = 0
    let image = 0
    for (const a of this.active.values()) {
      if (a.job.kind === 'video') video++
      else image++
    }
    for (const job of this.jobs) {
      if (video >= s.videoConcurrency && image >= s.imageConcurrency) break
      if (job.status !== 'queued') continue
      if (job.kind === 'video' && video < s.videoConcurrency) {
        video++
        this.startJob(job)
      } else if (job.kind === 'image' && image < s.imageConcurrency) {
        image++
        this.startJob(job)
      }
    }
    if (this.active.size === 0 && !this.jobs.some((j) => j.status === 'queued')) this.finishRun()
  }

  private finishRun(): void {
    const run = this.run
    this.running = false
    this.run = null
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
    for (const k of ['error', 'logTail', 'outputPath', 'encoder', 'speed', 'fps', 'etaSec', 'elapsedSec', 'outputSizeBytes', 'finishedAt'] as const) {
      delete job[k]
    }
    const entry: ActiveJob = {
      job,
      controller: new AbortController(),
      reason: null,
      reserved: null,
      settled: false,
      done: Promise.resolve(),
    }
    this.active.set(job.id, entry)
    this.run?.ids.add(job.id)
    entry.done = this.execute(job, entry).catch((err) => {
      console.error('[queue] unexpected error:', err)
      this.settle(job, entry, { status: 'failed', error: err })
    })
    this.changed()
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
      if (!existsSync(job.source)) throw new Error(this.tr('error.sourceMissing', { path: job.source }))

      let info = job.sourceInfo
      let size: { width: number; height: number } | null = null
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

      const dir = job.output.dir ? resolve(job.output.dir) : dirname(job.source)
      await mkdir(dir, { recursive: true })
      this.throwIfAborted(signal)

      const vars: NamingVars = {
        name: baseNameOf(job.source),
        ext: extOf(job.source),
        preset: job.presetName,
        parent: basename(dirname(job.source)),
        width: size?.width,
        height: size?.height,
        counter: this.meta[job.id]?.counter ?? 1,
        now,
      }
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
          const layer = await this.deps.image.renderWatermarkLayer(vs.watermark, size.width, size.height, {
            name: vars.name,
            date: ymd(now),
          })
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
      await this.commit(job, entry, tmp, dir, ext)
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

  private claimOutput(job: Job, entry: ActiveJob, dir: string, baseName: string, ext: string): { path: string; skip: boolean } {
    const r = resolveOutputPath({ dir, baseName, ext, conflict: job.output.conflict, source: job.source, reserved: this.reserved })
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

  /** Move the finished temp file onto the final name. */
  private async commit(job: Job, entry: ActiveJob, tmp: string, dir: string, ext: string): Promise<void> {
    let final = job.outputPath!
    if (job.output.conflict !== 'overwrite' && existsSync(final)) {
      // something else created the file while we were encoding: never clobber it
      const base = basename(final).slice(0, -(ext.length + 1))
      this.release(entry)
      final = this.claimOutput(job, entry, dir, base, ext).path
      job.outputPath = final
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, final)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
      }
    }
  }

  private settle(job: Job, entry: ActiveJob, outcome: Outcome): void {
    if (entry.settled) return
    entry.settled = true
    this.release(entry)
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
        end = 'done'
        break
    }

    if (end && listed) {
      this.countEnd(job, end)
      this.fireEnd(job)
      if (end === 'done' && this.deps.settings.get().removeFinished) {
        this.jobs = this.jobs.filter((j) => j !== job)
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
    this.run?.ids.add(job.id)
  }

  private resetForQueue(job: Job): void {
    job.status = 'queued'
    job.progress = 0
    for (const k of [
      'error',
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
      if (!job || job.sourceInfo) continue
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

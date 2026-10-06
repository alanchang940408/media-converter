// Media Converter side of the Premiere Pro / After Effects bridge (contract: src/shared/bridge.ts).
// A folder, no network: writes bridge/info.json, consumes bridge/inbox/<id>.json, answers in bridge/results/<id>.json and
// deletes rendered intermediates (only inside bridge/intermediates) after all of their jobs succeeded.
// No Electron imports — paths, queue, presets, settings and the clock are injected (tests use a temp folder).
import { watch as chokidarWatch, type FSWatcher } from 'chokidar'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { BRIDGE_VERSION, type BridgeInfo, type BridgeResult } from '../../shared/bridge'
import { baseNameOf, classifyPath, extOf } from '../../shared/media'
import { renderNameTemplate } from '../../shared/naming'
import type { AddJobsRequest, AddJobsResult, BridgeRequestEvent, Job, Locale, Preset, VideoPreset } from '../../shared/types'
import { outputExtension } from '../ffmpeg/args'
import { t, type I18nKey } from '../i18n'
import { pathKey } from '../queue/outputPath'
import type { SettingsAccess } from '../settings'
import { bridgePresets } from './summary'

/** What the bridge needs from the queue (the real Queue implements it). */
export interface BridgeQueue {
  addJobs(req: AddJobsRequest): Promise<AddJobsResult>
  /** `only`: start just these jobs (a restricted run, see Queue.start). */
  start(auto?: boolean, only?: readonly string[]): void
  getJobs(): Job[]
  onJobEnd(listener: (job: Job) => void): () => void
}

export interface BridgePresetSource {
  list(): Preset[]
  get(id: string): Preset | undefined
}

type DeleteJobState = 'pending' | 'ok' | 'bad'

/** One intermediate waiting for its jobs before it is deleted (deleteAfter). */
export interface PendingDelete {
  path: string
  jobs: Record<string, DeleteJobState>
  createdAt: number
}

/** Persisted bookkeeping (userData bridge-state.json) so a restart does not forget pending deletes. */
export interface BridgeState {
  version: 1
  /** pathKey(intermediate) → entry */
  pendingDeletes: Record<string, PendingDelete>
}

export const emptyBridgeState = (): BridgeState => ({ version: 1, pendingDeletes: {} })

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function parseBridgeState(raw: unknown): BridgeState | null {
  if (!isObj(raw) || !isObj(raw.pendingDeletes)) return null
  const pendingDeletes: Record<string, PendingDelete> = {}
  for (const [key, e] of Object.entries(raw.pendingDeletes)) {
    if (!isObj(e) || typeof e.path !== 'string' || !isObj(e.jobs)) continue
    const jobs: Record<string, DeleteJobState> = {}
    for (const [id, s] of Object.entries(e.jobs)) if (s === 'pending' || s === 'ok' || s === 'bad') jobs[id] = s
    if (Object.keys(jobs).length) pendingDeletes[key] = { path: e.path, jobs, createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0 }
  }
  return { version: 1, pendingDeletes }
}

/** JsonStore-compatible persistence (in memory when not injected). */
export interface StateStore<T> {
  get(): T
  save(): void
  flush(): Promise<void>
}

function memoryStore<T>(value: T): StateStore<T> {
  return { get: () => value, save: () => undefined, flush: async () => undefined }
}

export interface BridgeDeps {
  /** <userData>/bridge */
  dir: string
  queue: BridgeQueue
  presets: BridgePresetSource
  settings: SettingsAccess
  appVersion: string
  /** info.exePath: the packaged executable, or a hint in development runs. */
  exePath: string
  state?: StateStore<BridgeState>
  now?: () => number
  /** A request was handled (in-app toast / notification). */
  onRequest?: (e: BridgeRequestEvent) => void
  onError?: (err: Error) => void
  /** chokidar awaitWriteFinish for inbox files; default { stabilityThreshold: 250, pollInterval: 50 }. */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number } | false
  usePolling?: boolean
  /** info.json rewrites are coalesced; default 150 ms. */
  infoDebounceMs?: number
}

export interface BridgePaths {
  dir: string
  info: string
  inbox: string
  results: string
  intermediates: string
}

export function bridgePaths(dir: string): BridgePaths {
  const root = resolve(dir)
  return {
    dir: root,
    info: join(root, 'info.json'),
    inbox: join(root, 'inbox'),
    results: join(root, 'results'),
    intermediates: join(root, 'intermediates'),
  }
}

/** Normalise BridgeRequest.host ('premiere', 'aftereffects', or CEP host ids such as PPRO / AEFT). */
export function bridgeHostId(host: string): 'premiere' | 'aftereffects' | 'other' {
  const h = host.toLowerCase().replace(/[^a-z]/g, '')
  if (h === 'premiere' || h === 'premierepro' || h === 'ppro') return 'premiere'
  if (h === 'aftereffects' || h === 'aeft' || h === 'ae') return 'aftereffects'
  return 'other'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException)?.code
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message || err.name : String(err))
const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** `child` lies strictly below `parent` (never equal, never via ".."). Case-insensitive on Windows (path.relative). */
function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/** Windows: a reader (the panel, an AV scanner) can hold the target for a moment → retry. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= attempts - 1 || !RETRY_CODES.has(errCode(err) ?? '')) throw err
      await sleep(40 * (attempt + 1))
    }
  }
}

let tmpSeq = 0

/** Write JSON next to the target under a unique temp name, then rename over it (readers never see a partial file). */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await withRetry(() => rename(tmp, path))
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

interface Handled {
  result: BridgeResult
  event: BridgeRequestEvent
}

/** One requested output after validation: a preset id and its name template (trimmed; null = app default). */
export interface WantedOutput {
  presetId: string
  nameTemplate: string | null
}

/**
 * Indexes of the outputs that would write the same file: same rendered name + extension (compared case-insensitively)
 * in the same folder — every output of a request shares its output folder (`outDir`, or each source's own folder when
 * null). (file, output) pairs of different sources count too: the panel's "{name}_2" for comp "X" renders the same
 * name as "{name}" for a comp whose intermediate is "X_2". Only the files of one output never count against each
 * other (that output's own conflict handling numbers them).
 * Size tokens render empty and every time token renders the same instant, so names that could only differ there count
 * as colliding (a false alarm only costs a " (1)" suffix; a miss would let one output replace or skip the other).
 */
export function collidingOutputs(
  files: readonly string[],
  outputs: readonly { preset: VideoPreset; nameTemplate: string | null }[],
  defaultNameTemplate: string,
  locale: Locale,
  outDir: string | null = null,
): Set<number> {
  const now = new Date()
  const owner = new Map<string, number>()
  const colliding = new Set<number>()
  files.forEach((file, fi) => {
    const dirKey = pathKey(outDir ?? dirname(file))
    outputs.forEach((o, i) => {
      // the queue's {counter} is the file's place in the batch, the same in every output (each output adds the same
      // files in the same order)
      const name = renderNameTemplate(o.nameTemplate ?? defaultNameTemplate, {
        name: baseNameOf(file),
        ext: extOf(file),
        preset: o.preset.names?.[locale] ?? o.preset.name,
        parent: basename(dirname(file)),
        counter: fi + 1,
        now,
      })
      const key = `${dirKey}\n${name}.${outputExtension(o.preset.settings)}`.toLowerCase()
      const first = owner.get(key)
      if (first === undefined) owner.set(key, i)
      else if (first !== i) {
        colliding.add(first)
        colliding.add(i)
      }
    })
  })
  return colliding
}

export class BridgeService {
  readonly paths: BridgePaths
  private readonly state: StateStore<BridgeState>
  private readonly now: () => number
  private watcher: FSWatcher | null = null
  private unsubscribe: (() => void) | null = null
  private closed = true
  private readonly tasks = new Set<Promise<unknown>>()
  /** Inbox files are handled one at a time, in arrival order. */
  private chain: Promise<void> = Promise.resolve()
  private readonly inFlight = new Set<string>()
  /** Request ids handled in this session (a re-delivered id is never queued twice). */
  private readonly handled = new Set<string>()
  private infoTimer: NodeJS.Timeout | null = null
  private infoRelease: (() => void) | null = null
  private infoChain: Promise<void> = Promise.resolve()
  /** Ends start()'s wait for the watcher's initial scan when close() comes first. */
  private stopWaiting: (() => void) | null = null

  constructor(private readonly deps: BridgeDeps) {
    this.paths = bridgePaths(deps.dir)
    this.state = deps.state ?? memoryStore(emptyBridgeState())
    this.now = deps.now ?? Date.now
  }

  private tr(key: I18nKey, params?: Record<string, string | number>): string {
    return t(key, params, this.deps.settings.locale())
  }

  private report(err: unknown): void {
    if (this.deps.onError) this.deps.onError(toError(err))
    else console.warn('[bridge]', err)
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.tasks.add(p)
    void p.then(
      () => this.tasks.delete(p),
      () => this.tasks.delete(p),
    )
    return p
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Create the folders, write info.json, resume pending deletes, then handle waiting and new inbox files. */
  async start(): Promise<void> {
    if (!this.closed) return
    this.closed = false
    const p = this.paths
    await Promise.all([p.inbox, p.results, p.intermediates].map((d) => mkdir(d, { recursive: true })))
    await this.writeInfo().catch((err) => this.report(err))
    if (this.closed) return
    if (!this.unsubscribe) this.unsubscribe = this.deps.queue.onJobEnd((job) => this.onJobEnd(job))
    this.restorePending()

    const inbox = p.inbox
    const watcher = chokidarWatch(inbox, {
      depth: 0,
      // files already waiting (sent while the app was closed) arrive as 'add' events too
      ignoreInitial: false,
      ignored: (path) => resolve(path) !== inbox && !path.toLowerCase().endsWith('.json'),
      awaitWriteFinish: this.deps.awaitWriteFinish ?? { stabilityThreshold: 250, pollInterval: 50 },
      ignorePermissionErrors: true,
      persistent: true,
      usePolling: this.deps.usePolling ?? false,
    })
    this.watcher = watcher
    watcher.on('add', (path) => this.enqueue(path))
    watcher.on('change', (path) => this.enqueue(path))
    watcher.on('error', (err) => this.report(err))
    await new Promise<void>((res) => {
      this.stopWaiting = res
      watcher.once('ready', () => res())
    })
    this.stopWaiting = null
    if (this.closed) return
    // belt and braces: anything the watcher did not report (e.g. written between mkdir and the watch)
    await this.rescan()
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    const w = this.watcher
    this.watcher = null
    this.stopWaiting?.()
    await w?.close().catch(() => undefined)
    if (this.infoTimer) {
      clearTimeout(this.infoTimer)
      this.infoTimer = null
    }
    this.infoRelease?.()
    this.infoRelease = null
    await this.idle()
    await this.state.flush()
  }

  /** Resolves when no request, info write or delete is in progress. */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }

  /** Handle every *.json currently in the inbox. */
  async rescan(): Promise<void> {
    const names = await readdir(this.paths.inbox).catch(() => [] as string[])
    for (const name of names) if (name.toLowerCase().endsWith('.json')) this.enqueue(join(this.paths.inbox, name))
    await this.idle()
  }

  // ───────────────────────────── info.json ─────────────────────────────

  buildInfo(): BridgeInfo {
    const s = this.deps.settings.get()
    const locale = this.deps.settings.locale()
    const presets = bridgePresets(this.deps.presets.list(), locale)
    const isVideo = (id: string): boolean => this.deps.presets.get(id)?.kind === 'video'
    // same fallback as the queue: the remembered preset, else the built-in default
    const last = isVideo(s.lastVideoPresetId) ? s.lastVideoPresetId : isVideo('h264-match') ? 'h264-match' : (presets[0]?.id ?? '')
    return {
      bridgeVersion: BRIDGE_VERSION,
      appVersion: this.deps.appVersion,
      exePath: this.deps.exePath,
      locale,
      updatedAt: this.now(),
      presets,
      lastVideoPresetId: last,
      defaultOutputDir: s.defaultOutputDir,
    }
  }

  /** Write info.json now (atomically; writes are serialized so the newest state lands last). */
  writeInfo(): Promise<void> {
    const run = this.infoChain.then(async () => {
      await mkdir(this.paths.dir, { recursive: true })
      await writeJsonAtomic(this.paths.info, this.buildInfo())
    })
    this.infoChain = run.catch(() => undefined)
    return this.track(run)
  }

  /** Presets, language, default output folder or last preset changed: rewrite info.json shortly. */
  scheduleInfo(): void {
    if (this.closed) return
    if (this.infoTimer) clearTimeout(this.infoTimer)
    // superseded: idle() must not wait for the old timer any more
    this.infoRelease?.()
    let release!: () => void
    void this.track(new Promise<void>((r) => (release = r)))
    this.infoRelease = release
    this.infoTimer = setTimeout(() => {
      this.infoTimer = null
      this.infoRelease = null
      void this.writeInfo()
        .catch((err) => this.report(err))
        .finally(release)
    }, this.deps.infoDebounceMs ?? 150)
  }

  // ───────────────────────────── inbox ─────────────────────────────

  private enqueue(path: string): void {
    if (this.closed) return
    const name = basename(path)
    if (!name.toLowerCase().endsWith('.json')) return
    const key = pathKey(path)
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)
    const run = this.chain.then(() => this.handleFile(path)).finally(() => this.inFlight.delete(key))
    this.chain = run.catch(() => undefined)
    void this.track(run).catch((err) => this.report(err))
  }

  private async removeInbox(path: string): Promise<void> {
    await withRetry(() => unlink(path)).catch((err) => {
      if (errCode(err) !== 'ENOENT') this.report(err)
    })
  }

  private async handleFile(path: string): Promise<void> {
    if (this.closed) return
    const id = basename(path).slice(0, -'.json'.length)
    if (!id) return
    let text: string
    try {
      text = await withRetry(() => readFile(path, 'utf8'))
    } catch (err) {
      if (errCode(err) !== 'ENOENT') this.report(err)
      return
    }
    const resultPath = join(this.paths.results, `${id}.json`)
    // already answered (re-delivered request, or the inbox file could not be deleted last time): never queue twice
    if (this.handled.has(id.toLowerCase()) || existsSync(resultPath)) {
      await this.removeInbox(path)
      return
    }
    const { result, event } = await this.handleRequest(id, text)
    this.handled.add(id.toLowerCase())
    await mkdir(this.paths.results, { recursive: true })
    await writeJsonAtomic(resultPath, result)
    await this.removeInbox(path)
    try {
      this.deps.onRequest?.(event)
    } catch (err) {
      this.report(err)
    }
  }

  /** Validate a request and queue its jobs. Never throws: problems end up in result.errors. */
  async handleRequest(id: string, text: string): Promise<Handled> {
    const errors: string[] = []
    let host = ''
    const finish = (jobIds: string[], fileCount: number): Handled => {
      const status = jobIds.length ? 'accepted' : 'rejected'
      return {
        result: { id, status, jobIds, errors, handledAt: this.now() },
        event: { id, host, status, jobCount: jobIds.length, fileCount, errors: [...errors] },
      }
    }

    let req: unknown
    try {
      req = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      req = undefined
    }
    if (!isObj(req)) {
      errors.push(this.tr('bridge.err.json'))
      return finish([], 0)
    }
    if (typeof req.host === 'string') host = req.host.slice(0, 64)
    const version = req.bridgeVersion
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > BRIDGE_VERSION) {
      errors.push(this.tr('bridge.err.version', { v: String(version), supported: BRIDGE_VERSION }))
      return finish([], 0)
    }

    // files: absolute, existing video / audio files (a video preset cannot convert an image)
    const rawFiles = Array.isArray(req.files) ? req.files.filter((f): f is string => typeof f === 'string' && !!f.trim()) : []
    if (!rawFiles.length) errors.push(this.tr('bridge.err.noFiles'))
    const files: string[] = []
    /** pathKey(resolved) → the path exactly as the panel sent it (deleteAfter refuses any ".." in it) */
    const sent = new Map<string, string>()
    for (const f of rawFiles) {
      if (!isAbsolute(f)) {
        errors.push(this.tr('bridge.err.notAbsolute', { path: f }))
        continue
      }
      const abs = resolve(f)
      const key = pathKey(abs)
      if (sent.has(key)) continue
      sent.set(key, f)
      const st = await stat(abs).catch(() => null)
      if (!st?.isFile()) {
        errors.push(this.tr('bridge.err.fileMissing', { path: f }))
        continue
      }
      const kind = classifyPath(abs)
      if (kind !== 'video' && kind !== 'audio') {
        errors.push(this.tr('bridge.err.notMedia', { path: f }))
        continue
      }
      files.push(abs)
    }

    // outputs: BridgeRequest.outputs (one job per file × output, each with its own name) when it has a well-formed
    // entry, else presetIds with the request's nameTemplate (older panels)
    const locale = this.deps.settings.locale()
    const presetName = (p: Preset): string => p.names?.[locale] ?? p.name
    let wanted = this.parseOutputs(req.outputs, errors)
    if (!wanted.length) {
      const legacyTemplate = typeof req.nameTemplate === 'string' && req.nameTemplate.trim() ? req.nameTemplate : null
      const rawIds = Array.isArray(req.presetIds) ? [...new Set(req.presetIds.filter((p): p is string => typeof p === 'string' && !!p))] : []
      wanted = rawIds.map((presetId) => ({ presetId, nameTemplate: legacyTemplate }))
    }
    if (!wanted.length) errors.push(this.tr('bridge.err.noPresets'))
    // known video presets; unknown ones are reported (once each) and skipped
    const outputs: { preset: VideoPreset; nameTemplate: string | null }[] = []
    const reported = new Set<string>()
    for (const w of wanted) {
      const p = this.deps.presets.get(w.presetId)
      if (p?.kind === 'video') {
        outputs.push({ preset: p, nameTemplate: w.nameTemplate })
        continue
      }
      if (reported.has(w.presetId)) continue
      reported.add(w.presetId)
      errors.push(p ? this.tr('bridge.err.notVideoPreset', { name: presetName(p) }) : this.tr('bridge.err.unknownPreset', { id: w.presetId }))
    }

    // output: an absolute folder, or null = next to the source
    let outDir: string | null = null
    if (typeof req.outputDir === 'string' && req.outputDir.trim()) {
      const d = req.outputDir.trim()
      if (!isAbsolute(d)) {
        errors.push(this.tr('bridge.err.outputDir', { path: d }))
        return finish([], 0)
      }
      outDir = resolve(d)
    }
    if (!files.length || !outputs.length) return finish([], 0)

    // Outputs that would write the same file for a source must never replace each other, whatever the user's
    // conflict policy: the queue only keeps running jobs (and the current run) apart, so 'overwrite', 'skip' or a
    // later run could still lose one of them. Those outputs always number their files instead ("name (1).mp4").
    const forceRename = collidingOutputs(files, outputs, this.deps.settings.get().defaultNameTemplate, locale, outDir)

    const jobIds: string[] = []
    /** pathKey(source) → every job of every output for that file (deleteAfter waits for all of them) */
    const byFile = new Map<string, { path: string; jobIds: string[] }>()
    const reportedMissing = new Set<string>()
    for (const [i, o] of outputs.entries()) {
      try {
        const res = await this.deps.queue.addJobs({
          paths: files,
          videoPresetId: o.preset.id,
          output: {
            dir: outDir,
            ...(o.nameTemplate ? { nameTemplate: o.nameTemplate } : {}),
            ...(forceRename.has(i) ? { conflict: 'rename' as const } : {}),
          },
        })
        for (const j of res.jobs) {
          jobIds.push(j.id)
          const key = pathKey(j.source)
          let g = byFile.get(key)
          if (!g) byFile.set(key, (g = { path: j.source, jobIds: [] }))
          g.jobIds.push(j.id)
        }
        for (const ig of res.ignored) {
          if (reportedMissing.has(ig)) continue
          reportedMissing.add(ig)
          errors.push(this.tr('bridge.err.fileMissing', { path: ig }))
        }
      } catch (err) {
        errors.push(this.tr('bridge.err.addFailed', { name: presetName(o.preset), message: errorMessage(err) }))
      }
    }

    if (req.deleteAfter === true) {
      for (const [key, g] of byFile) {
        const original = sent.get(key) ?? g.path
        if ((await this.isDeletableIntermediate(original)) && (await this.isDeletableIntermediate(g.path))) this.trackDelete(g.path, g.jobIds)
        else errors.push(this.tr('bridge.err.keepOutside', { path: original }))
      }
    }

    if (req.start === true && jobIds.length) this.deps.queue.start(false, jobIds)
    return finish(jobIds, byFile.size)
  }

  /**
   * BridgeRequest.outputs → well-formed outputs (nameTemplate trimmed, empty = null), identical (preset, name) pairs
   * once. Malformed entries — or a value that is not an array — are reported and skipped; absent / null → [].
   */
  private parseOutputs(raw: unknown, errors: string[]): WantedOutput[] {
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) {
      errors.push(this.tr('bridge.err.badOutputs'))
      return []
    }
    const out: WantedOutput[] = []
    const seen = new Set<string>()
    raw.forEach((o: unknown, i) => {
      const tpl = isObj(o) ? o.nameTemplate : undefined
      if (!isObj(o) || typeof o.presetId !== 'string' || !o.presetId.trim() || !(tpl === undefined || tpl === null || typeof tpl === 'string')) {
        errors.push(this.tr('bridge.err.badOutput', { n: i + 1 }))
        return
      }
      const nameTemplate = typeof tpl === 'string' && tpl.trim() ? tpl.trim() : null
      const key = JSON.stringify([o.presetId, nameTemplate])
      if (seen.has(key)) return
      seen.add(key)
      out.push({ presetId: o.presetId, nameTemplate })
    })
    return out
  }

  // ───────────────────────────── deleteAfter ─────────────────────────────

  /**
   * True only for a regular file whose path and real path (junctions / symlinks resolved) both lie inside
   * bridge/intermediates, with no ".." anywhere in the given path.
   */
  async isDeletableIntermediate(p: string): Promise<boolean> {
    if (typeof p !== 'string' || !p || !isAbsolute(p)) return false
    if (p.split(/[\\/]+/).some((seg) => seg === '..')) return false
    const root = this.paths.intermediates
    const abs = resolve(p)
    if (!isStrictlyInside(abs, root)) return false
    try {
      const st = await lstat(abs)
      if (!st.isFile()) return false
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(abs)])
      return isStrictlyInside(realFile, realRoot)
    } catch {
      return false
    }
  }

  private trackDelete(path: string, jobIds: string[]): void {
    const key = pathKey(path)
    const data = this.state.get()
    const entry = data.pendingDeletes[key] ?? (data.pendingDeletes[key] = { path, jobs: {}, createdAt: this.now() })
    // jobs may already have ended (autoStart): take their current state from the queue
    const current = new Map(this.deps.queue.getJobs().map((j) => [j.id, j.status]))
    for (const id of jobIds) entry.jobs[id] = stateOf(current.get(id))
    this.state.save()
    this.evaluate(key)
  }

  private onJobEnd(job: Job): void {
    const key = pathKey(job.source)
    const entry = this.state.get().pendingDeletes[key]
    if (!entry) return
    if (Object.prototype.hasOwnProperty.call(entry.jobs, job.id)) {
      entry.jobs[job.id] = job.status === 'done' ? 'ok' : 'bad'
      this.state.save()
    }
    this.evaluate(key)
  }

  /** Queue jobs survive restarts: refresh the job states; entries whose unfinished jobs are gone can never complete. */
  private restorePending(): void {
    const data = this.state.get()
    const jobs = new Map(this.deps.queue.getJobs().map((j) => [j.id, j.status]))
    let changed = false
    for (const [key, entry] of Object.entries(data.pendingDeletes)) {
      let gone = false
      for (const [id, s] of Object.entries(entry.jobs)) {
        if (s === 'ok') continue
        const status = jobs.get(id)
        if (status === undefined) {
          gone = true
          break
        }
        const next = stateOf(status)
        if (next !== s) {
          entry.jobs[id] = next
          changed = true
        }
      }
      if (gone) {
        delete data.pendingDeletes[key]
        changed = true
      }
    }
    if (changed) this.state.save()
    for (const key of Object.keys(data.pendingDeletes)) this.evaluate(key)
  }

  private evaluate(key: string): void {
    const data = this.state.get()
    const entry = data.pendingDeletes[key]
    if (!entry) return
    const states = Object.values(entry.jobs)
    if (!states.length || states.some((s) => s !== 'ok')) return
    // another queued / running job (a duplicate, a manual add) still needs the file
    if (this.deps.queue.getJobs().some((j) => (j.status === 'queued' || j.status === 'running') && pathKey(j.source) === key)) return
    delete data.pendingDeletes[key]
    this.state.save()
    void this.track(this.deleteIntermediate(entry.path)).catch((err) => this.report(err))
  }

  private async deleteIntermediate(path: string): Promise<void> {
    // checked again right before deleting: the folder layout may have changed since the request
    if (!(await this.isDeletableIntermediate(path))) return
    await withRetry(() => unlink(path), 10).catch((err) => {
      if (errCode(err) !== 'ENOENT') throw err
    })
  }

  /** Intermediates still waiting for their jobs (for tests / diagnostics). */
  pendingDeletes(): PendingDelete[] {
    return Object.values(this.state.get().pendingDeletes).map((e) => structuredClone(e))
  }
}

function stateOf(status: Job['status'] | undefined): DeleteJobState {
  if (status === 'done') return 'ok'
  if (status === 'failed' || status === 'cancelled' || status === 'skipped') return 'bad'
  return 'pending'
}

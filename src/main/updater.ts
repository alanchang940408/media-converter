// Update checks against the GitHub Releases of alan940408/media-converter.
// - Installed Windows build (NSIS): electron-updater downloads in the background and installs on quit, or right away
//   via installNow() ("Restart now").
// - Portable exe (PORTABLE_EXECUTABLE_DIR) and the other platforms (unsigned macOS, Linux packages): never touch
//   electron-updater; ask the GitHub "latest release" API and only remind the user, with a download link.
// - Unpackaged / dev runs: disabled.
// Network and GitHub errors (offline, 404/401 while the repo is private, rate limit) never throw: the state becomes
// 'error' and is logged; only the renderer's manual "Check now" turns that into a message.
// No Electron import: index.ts injects the app facts, electron-updater's autoUpdater and fetch, so this runs in vitest.
import type { UpdateErrorKind, UpdateEvent, UpdateMode, UpdateState } from '../shared/api'
import type { AppSettings } from '../shared/types'

export const UPDATE_REPO = { owner: 'alan940408', repo: 'media-converter' } as const
export const FIRST_CHECK_DELAY_MS = 10_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
/** When quitAndInstall did not quit the app (installer failed to start), quit anyway: the queue is already shut down. */
const INSTALL_QUIT_FALLBACK_MS = 5_000

// ───────────────────────────── versions ─────────────────────────────

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: (string | number)[]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i

export function parseVersion(v: string): ParsedVersion | null {
  const m = SEMVER.exec(String(v ?? '').trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
  }
}

/** "v1.2.3" → "1.2.3" (other strings are returned trimmed). */
export function normalizeVersion(v: string): string {
  const s = String(v ?? '').trim()
  return /^v\d/i.test(s) ? s.slice(1) : s
}

/** Semver precedence: <0 when a < b, 0 when equal (build metadata ignored), >0 when a > b; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  // a release ranks above any of its pre-releases
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1
    // numeric identifiers rank below alphanumeric ones
    if (typeof p === 'number') return -1
    if (typeof q === 'number') return 1
    return p < q ? -1 : 1
  }
  return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return (compareVersions(candidate, current) ?? 0) > 0
}

// ───────────────────────────── mode ─────────────────────────────

export interface UpdateEnvironment {
  isPackaged: boolean
  platform: string
  env?: Record<string, string | undefined>
}

export function resolveUpdateMode({ isPackaged, platform, env = {} }: UpdateEnvironment): UpdateMode {
  if (env.MC_NO_UPDATE_CHECK) return 'disabled'
  if (!isPackaged) return 'disabled'
  // set by electron-builder's portable launcher
  if (env.PORTABLE_EXECUTABLE_DIR) return 'portable'
  if (platform === 'win32') return 'auto'
  // unsigned macOS builds cannot use Squirrel.Mac; Linux packages are updated by hand too
  return 'manual'
}

// ───────────────────────────── GitHub API (portable / manual) ─────────────────────────────

export interface FetchResponseLike {
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<FetchResponseLike>

export class UpdateCheckError extends Error {
  constructor(
    message: string,
    readonly kind: UpdateErrorKind,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'UpdateCheckError'
  }
}

export function latestReleaseApiUrl(repo: { owner: string; repo: string } = UPDATE_REPO): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`
}

export function releasesPageUrl(repo: { owner: string; repo: string } = UPDATE_REPO, version?: string): string {
  const base = `https://github.com/${repo.owner}/${repo.repo}/releases`
  return version ? `${base}/tag/v${normalizeVersion(version)}` : `${base}/latest`
}

/** Only GitHub pages of this repository are ever opened in the browser. */
function isRepoUrl(url: unknown, repo: { owner: string; repo: string }): url is string {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.toLowerCase().startsWith(`/${repo.owner}/${repo.repo}/`.toLowerCase())
  } catch {
    return false
  }
}

export interface LatestRelease {
  tag: string
  version: string
  url: string
}

/** GET /repos/{owner}/{repo}/releases/latest (newest published, non-prerelease release). Throws UpdateCheckError. */
export async function fetchLatestRelease(
  fetchFn: FetchLike,
  repo: { owner: string; repo: string } = UPDATE_REPO,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<LatestRelease> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    let res: FetchResponseLike
    try {
      res = await fetchFn(latestReleaseApiUrl(repo), {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'media-converter-updater' },
        signal: ctrl.signal,
      })
    } catch (err) {
      throw new UpdateCheckError(`Network error: ${errorMessage(err)}`, 'network')
    }
    if (!res.ok) {
      // 404 / 401: no published release yet, or the repository is still private
      // 403 / 429: unauthenticated API rate limit (60 requests per hour per IP)
      const kind: UpdateErrorKind =
        res.status === 404 || res.status === 401 ? 'not-found' : res.status === 403 || res.status === 429 ? 'rate-limit' : 'other'
      const remaining = res.headers?.get('x-ratelimit-remaining')
      throw new UpdateCheckError(`GitHub API responded ${res.status}${remaining === '0' ? ' (rate limit reached)' : ''}`, kind, res.status)
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      throw new UpdateCheckError(`Invalid response from GitHub: ${errorMessage(err)}`, 'other')
    }
    const b = (body && typeof body === 'object' ? body : {}) as { tag_name?: unknown; html_url?: unknown }
    const tag = typeof b.tag_name === 'string' ? b.tag_name : ''
    const version = normalizeVersion(tag)
    if (!parseVersion(version)) throw new UpdateCheckError(`Unexpected release tag "${tag}"`, 'other')
    return { tag, version, url: isRepoUrl(b.html_url, repo) ? b.html_url : releasesPageUrl(repo, version) }
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────── errors ─────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/** Kind + a short one-line message (electron-updater's errors carry whole response dumps). */
export function describeUpdateError(err: unknown): { kind: UpdateErrorKind; message: string } {
  const raw = errorMessage(err)
  const message = (raw.split(/\r?\n/).find((l) => l.trim()) ?? raw).trim().slice(0, 300) || 'Unknown error'
  if (err instanceof UpdateCheckError) return { kind: err.kind, message }
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  if (status === 404 || status === 401) return { kind: 'not-found', message }
  if (status === 403 || status === 429) return { kind: 'rate-limit', message }
  if (/rate limit|\b429\b/i.test(raw)) return { kind: 'rate-limit', message }
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network|timed? ?out|abort/i.test(raw)) {
    return { kind: 'network', message }
  }
  if (/\b40[14]\b|not found|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|no published versions|unable to find latest/i.test(raw)) {
    return { kind: 'not-found', message }
  }
  return { kind: 'other', message }
}

// ───────────────────────────── the updater ─────────────────────────────

/** The parts of electron-updater's autoUpdater this module uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  // any[]: compatible with both EventEmitter and electron-updater's typed emitter
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** What the updater needs from SettingsManager. */
export interface UpdaterSettings {
  get(): Pick<AppSettings, 'autoCheckUpdates'>
  onChange(listener: (next: AppSettings, prev: AppSettings, changed: (keyof AppSettings)[]) => void): () => void
}

export interface UpdaterLog {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

export interface UpdaterOptions extends UpdateEnvironment {
  /** app.getVersion() */
  currentVersion: string
  settings: UpdaterSettings
  /** Loads electron-updater's autoUpdater; only called in 'auto' mode, on the first check. */
  loadAutoUpdater: () => AutoUpdaterLike | Promise<AutoUpdaterLike>
  /** Used for the GitHub API in 'portable' / 'manual' mode (Electron: net.fetch). */
  fetch: FetchLike
  /** Push an event to the renderer. */
  emit: (e: UpdateEvent) => void
  openExternal: (url: string) => Promise<void> | void
  /** Runs before quitAndInstall (confirm + shut down the queue); false cancels. */
  beforeInstall?: () => boolean | Promise<boolean>
  /** Last resort when quitAndInstall did not quit the app (e.g. the installer could not be started). */
  quit?: () => void
  log?: UpdaterLog
  repo?: { owner: string; repo: string }
  firstCheckDelayMs?: number
  intervalMs?: number
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type UpdateEventPayload = DistributiveOmit<UpdateEvent, 'state'>

export class Updater {
  readonly mode: UpdateMode
  private state: UpdateState
  private started = false
  private firstTimer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private inflight: Promise<UpdateState> | null = null
  private au: AutoUpdaterLike | null = null
  private auLoading: Promise<AutoUpdaterLike> | null = null
  private unsubSettings: (() => void) | null = null
  private lastPercent = -1
  private installing = false
  private readonly log: UpdaterLog
  private readonly repo: { owner: string; repo: string }

  constructor(private readonly opts: UpdaterOptions) {
    this.mode = resolveUpdateMode(opts)
    this.log = opts.log ?? console
    this.repo = opts.repo ?? UPDATE_REPO
    this.state = { mode: this.mode, status: this.mode === 'disabled' ? 'disabled' : 'idle', currentVersion: opts.currentVersion }
  }

  getState(): UpdateState {
    return { ...this.state, ...(this.state.error ? { error: { ...this.state.error } } : {}) }
  }

  /** Schedule automatic checks (first after ~10 s, then every 6 h) while settings.autoCheckUpdates is on. */
  start(): void {
    if (this.started || this.mode === 'disabled') return
    this.started = true
    this.unsubSettings = this.opts.settings.onChange((_next, _prev, changed) => {
      if (changed.includes('autoCheckUpdates')) this.schedule()
    })
    this.schedule()
  }

  stop(): void {
    this.started = false
    this.clearTimers()
    this.unsubSettings?.()
    this.unsubSettings = null
  }

  private autoCheckEnabled(): boolean {
    return this.opts.settings.get().autoCheckUpdates !== false
  }

  private clearTimers(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.interval) clearInterval(this.interval)
    this.firstTimer = null
    this.interval = null
  }

  private schedule(): void {
    this.clearTimers()
    if (!this.started || !this.autoCheckEnabled()) return
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null
      void this.check(false)
    }, this.opts.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS)
    this.interval = setInterval(() => void this.check(false), this.opts.intervalMs ?? CHECK_INTERVAL_MS)
  }

  /**
   * Check now. `manual` = the user pressed "Check for updates" (works even with automatic checks off).
   * Never rejects: failures end in status 'error'. Resolves with the state after the check.
   */
  check(manual = false): Promise<UpdateState> {
    if (this.mode === 'disabled') return Promise.resolve(this.getState())
    if (!manual && !this.autoCheckEnabled()) return Promise.resolve(this.getState())
    // an update is already on its way / waiting for a restart
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return Promise.resolve(this.getState())
    if (this.inflight) return this.inflight
    const run = this.mode === 'auto' ? this.checkAuto() : this.checkGithub()
    const p = run
      .catch((err: unknown) => this.fail(err))
      .then(() => this.getState())
      .finally(() => {
        if (this.inflight === p) this.inflight = null
      })
    this.inflight = p
    return p
  }

  /** Quit and install the downloaded update (installed build only). */
  async installNow(): Promise<void> {
    const au = this.au
    if (this.mode !== 'auto' || this.state.status !== 'downloaded' || !au || this.installing) return
    this.installing = true
    try {
      if (this.opts.beforeInstall && !(await this.opts.beforeInstall())) return
      this.log.info('[updater] quit and install', this.state.version)
      // silent install of the already-chosen location, then start the new version
      au.quitAndInstall(true, true)
      if (this.opts.quit) {
        const quit = this.opts.quit
        setTimeout(() => quit(), INSTALL_QUIT_FALLBACK_MS)
      }
    } catch (err) {
      this.fail(err)
      this.opts.quit?.()
    } finally {
      this.installing = false
    }
  }

  /** Release page of the newer version (or the latest release). */
  async openReleasePage(): Promise<void> {
    const url = this.state.url ?? (this.state.version ? releasesPageUrl(this.repo, this.state.version) : releasesPageUrl(this.repo))
    await this.opts.openExternal(url)
  }

  // ── internals ──

  private setState(patch: Partial<UpdateState>, event?: UpdateEventPayload): void {
    this.state = { ...this.state, ...patch }
    for (const k of Object.keys(this.state) as (keyof UpdateState)[]) if (this.state[k] === undefined) delete this.state[k]
    if (!event) return
    try {
      this.opts.emit({ ...event, state: this.getState() } as UpdateEvent)
    } catch (err) {
      this.log.warn('[updater] emit failed:', err)
    }
  }

  private fail(err: unknown): void {
    const error = describeUpdateError(err)
    // background checks fail quietly (offline, private repo, rate limit): log only
    this.log.warn(`[updater] update check failed (${error.kind}): ${error.message}`)
    this.setState({ status: 'error', error, percent: undefined, lastCheckedAt: Date.now() }, { type: 'error', message: error.message })
  }

  private async checkGithub(): Promise<void> {
    this.setState({ status: 'checking', error: undefined }, { type: 'checking' })
    const release = await fetchLatestRelease(this.opts.fetch, this.repo)
    const now = Date.now()
    if (isNewerVersion(release.version, this.opts.currentVersion)) {
      this.log.info(`[updater] version ${release.version} is available (${this.mode})`)
      this.setState(
        { status: 'available', version: release.version, url: release.url, lastCheckedAt: now },
        { type: 'available', version: release.version, portable: true, url: release.url },
      )
    } else {
      this.setState({ status: 'not-available', version: undefined, url: undefined, lastCheckedAt: now }, { type: 'not-available' })
    }
  }

  private async checkAuto(): Promise<void> {
    this.setState({ status: 'checking', error: undefined }, { type: 'checking' })
    try {
      const au = await this.autoUpdater()
      const result = await au.checkForUpdates()
      // download failures also arrive as an 'error' event; keep the promise from going unhandled
      result?.downloadPromise?.catch(() => undefined)
      if (!result && this.state.status === 'checking') this.setState({ status: 'idle', lastCheckedAt: Date.now() })
    } catch (err) {
      // checkForUpdates() emits 'error' (handled by the listener) and then rejects with the same error
      if (this.state.status !== 'error') this.fail(err)
    }
  }

  private autoUpdater(): Promise<AutoUpdaterLike> {
    if (this.au) return Promise.resolve(this.au)
    if (!this.auLoading) {
      this.auLoading = Promise.resolve()
        .then(() => this.opts.loadAutoUpdater())
        .then((au) => {
          au.autoDownload = true
          au.autoInstallOnAppQuit = true
          this.wire(au)
          this.au = au
          return au
        })
        .catch((err: unknown) => {
          this.auLoading = null
          throw err
        })
    }
    return this.auLoading
  }

  private wire(au: AutoUpdaterLike): void {
    const on = (event: string, fn: (arg: unknown) => void): void => {
      au.on(event, fn)
    }
    const versionOf = (info: unknown): string | undefined => {
      const v = (info as { version?: unknown } | null)?.version
      return typeof v === 'string' && v ? normalizeVersion(v) : undefined
    }
    on('update-available', (info) => {
      const version = versionOf(info) ?? this.state.version ?? ''
      this.lastPercent = -1
      this.log.info(`[updater] version ${version} is available, downloading`)
      this.setState(
        { status: 'available', version, percent: undefined, url: undefined, lastCheckedAt: Date.now() },
        { type: 'available', version, portable: false },
      )
    })
    on('update-not-available', () => {
      this.setState({ status: 'not-available', version: undefined, percent: undefined, lastCheckedAt: Date.now() }, { type: 'not-available' })
    })
    on('download-progress', (p) => {
      const raw = Number((p as { percent?: unknown } | null)?.percent)
      const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0
      // one event per whole percent is plenty for a progress line
      if (this.state.status === 'downloading' && Math.floor(percent) === this.lastPercent) return
      this.lastPercent = Math.floor(percent)
      this.setState({ status: 'downloading', percent }, { type: 'downloading', percent })
    })
    on('update-downloaded', (info) => {
      const version = versionOf(info) ?? this.state.version ?? ''
      this.log.info(`[updater] version ${version} downloaded; installs on quit`)
      this.setState({ status: 'downloaded', version, percent: 100 }, { type: 'downloaded', version })
    })
    on('error', (err) => this.fail(err))
  }
}

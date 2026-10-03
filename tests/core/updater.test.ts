// Updater: semver compare, mode detection, GitHub API path (portable), silent errors, scheduling, electron-updater path.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateEvent } from '../../src/shared/api'
import type { AppSettings } from '../../src/shared/types'
import { defaultSettings, sanitizeSettings } from '../../src/main/settings'
import {
  CHECK_INTERVAL_MS,
  compareVersions,
  describeUpdateError,
  FIRST_CHECK_DELAY_MS,
  isNewerVersion,
  latestReleaseApiUrl,
  normalizeVersion,
  resolveUpdateMode,
  UpdateCheckError,
  Updater,
  type AutoUpdaterLike,
  type FetchLike,
  type FetchResponseLike,
  type UpdaterOptions,
} from '../../src/main/updater'

// ───────────────────────────── fakes ─────────────────────────────

type Listener = (next: AppSettings, prev: AppSettings, changed: (keyof AppSettings)[]) => void

class FakeSettings {
  private value: AppSettings
  private listeners = new Set<Listener>()
  constructor(patch: Partial<AppSettings> = {}) {
    this.value = { ...defaultSettings(), ...patch }
  }
  get(): AppSettings {
    return { ...this.value }
  }
  patch(p: Partial<AppSettings>): void {
    const prev = this.value
    this.value = { ...prev, ...p }
    const changed = (Object.keys(p) as (keyof AppSettings)[]).filter((k) => prev[k] !== this.value[k])
    for (const l of this.listeners) l(this.get(), prev, changed)
  }
  onChange(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  }
}

function release(tag: string, html = `https://github.com/alan940408/media-converter/releases/tag/${tag}`): FetchResponseLike {
  return json(200, { tag_name: tag, html_url: html, draft: false, prerelease: false })
}

class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  /** What the next checkForUpdates() does. */
  next: 'available' | 'none' | 'error' = 'none'
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null> {
    this.checks++
    this.emit('checking-for-update')
    if (this.next === 'error') {
      const err = new Error('net::ERR_INTERNET_DISCONNECTED')
      this.emit('error', err)
      return Promise.reject(err)
    }
    if (this.next === 'none') {
      this.emit('update-not-available', { version: '0.1.0' })
      return Promise.resolve({ downloadPromise: null })
    }
    this.emit('update-available', { version: '0.2.0' })
    return Promise.resolve({ downloadPromise: new Promise<unknown>(() => undefined) })
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}

interface Harness {
  updater: Updater
  events: UpdateEvent[]
  fetch: ReturnType<typeof vi.fn<FetchLike>>
  settings: FakeSettings
  au: FakeAutoUpdater
  loadAutoUpdater: ReturnType<typeof vi.fn<() => AutoUpdaterLike>>
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  opened: string[]
}

function makeUpdater(
  opts: Partial<UpdaterOptions> & { response?: FetchResponseLike | (() => Promise<FetchResponseLike>); settingsPatch?: Partial<AppSettings> } = {},
): Harness {
  const events: UpdateEvent[] = []
  const settings = new FakeSettings(opts.settingsPatch)
  const au = new FakeAutoUpdater()
  const response = opts.response ?? release('v0.2.0')
  const fetch = vi.fn<FetchLike>(async () => (typeof response === 'function' ? response() : response))
  const loadAutoUpdater = vi.fn<() => AutoUpdaterLike>(() => au)
  const log = { info: vi.fn(), warn: vi.fn() }
  const opened: string[] = []
  const updater = new Updater({
    currentVersion: '0.1.0',
    isPackaged: true,
    platform: 'win32',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' },
    settings,
    loadAutoUpdater,
    fetch,
    emit: (e) => events.push(e),
    openExternal: (url) => {
      opened.push(url)
    },
    log,
    ...opts,
  })
  return { updater, events, fetch, settings, au, loadAutoUpdater, log, opened }
}

// ───────────────────────────── versions ─────────────────────────────

describe('updater: semver', () => {
  it('compares major / minor / patch numerically', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
  })

  it('accepts a leading v and ignores build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.7', '1.2.3')).toBe(0)
    expect(normalizeVersion('v0.2.0')).toBe('0.2.0')
    expect(normalizeVersion(' 0.2.0 ')).toBe('0.2.0')
  })

  it('ranks pre-releases below the release, per semver precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1)
      expect(compareVersions(ordered[i + 1], ordered[i])).toBe(1)
    }
  })

  it('returns null for non-versions and isNewerVersion treats them as not newer', () => {
    expect(compareVersions('latest', '1.0.0')).toBeNull()
    expect(compareVersions('1.0', '1.0.0')).toBeNull()
    expect(isNewerVersion('garbage', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false)
  })
})

// ───────────────────────────── mode ─────────────────────────────

describe('updater: mode', () => {
  it('is disabled when not packaged (dev) or when MC_NO_UPDATE_CHECK is set', () => {
    expect(resolveUpdateMode({ isPackaged: false, platform: 'win32', env: {} })).toBe('disabled')
    expect(resolveUpdateMode({ isPackaged: false, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'D:\\' } })).toBe('disabled')
    expect(resolveUpdateMode({ isPackaged: true, platform: 'win32', env: { MC_NO_UPDATE_CHECK: '1' } })).toBe('disabled')
  })

  it('uses electron-updater for the installed Windows build only', () => {
    expect(resolveUpdateMode({ isPackaged: true, platform: 'win32', env: {} })).toBe('auto')
    expect(resolveUpdateMode({ isPackaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Apps' } })).toBe('portable')
    expect(resolveUpdateMode({ isPackaged: true, platform: 'darwin', env: {} })).toBe('manual')
    expect(resolveUpdateMode({ isPackaged: true, platform: 'linux', env: {} })).toBe('manual')
  })

  it('settings: autoCheckUpdates defaults to on and is sanitized', () => {
    expect(defaultSettings().autoCheckUpdates).toBe(true)
    expect(sanitizeSettings({}).autoCheckUpdates).toBe(true)
    expect(sanitizeSettings({ autoCheckUpdates: false }).autoCheckUpdates).toBe(false)
    expect(sanitizeSettings({ autoCheckUpdates: 'no' } as unknown as Partial<AppSettings>).autoCheckUpdates).toBe(true)
  })
})

// ───────────────────────────── portable: GitHub API ─────────────────────────────

describe('updater: portable (GitHub API)', () => {
  it('reports a newer release with portable: true and the release page url', async () => {
    const h = makeUpdater()
    const state = await h.updater.check(true)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.fetch.mock.calls[0][0]).toBe(latestReleaseApiUrl())
    expect(h.fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/alan940408/media-converter/releases/latest')
    expect(h.loadAutoUpdater).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      mode: 'portable',
      status: 'available',
      currentVersion: '0.1.0',
      version: '0.2.0',
      url: 'https://github.com/alan940408/media-converter/releases/tag/v0.2.0',
    })
    expect(h.events.map((e) => e.type)).toEqual(['checking', 'available'])
    const available = h.events[1]
    expect(available).toMatchObject({ type: 'available', version: '0.2.0', portable: true, url: 'https://github.com/alan940408/media-converter/releases/tag/v0.2.0' })
    expect(available.state.status).toBe('available')

    await h.updater.openReleasePage()
    expect(h.opened).toEqual(['https://github.com/alan940408/media-converter/releases/tag/v0.2.0'])
  })

  it('reports not-available when the latest release is not newer', async () => {
    for (const tag of ['v0.1.0', 'v0.0.9', '0.1.0']) {
      const h = makeUpdater({ response: release(tag) })
      const state = await h.updater.check(true)
      expect(state.status).toBe('not-available')
      expect(state.version).toBeUndefined()
      expect(h.events.map((e) => e.type)).toEqual(['checking', 'not-available'])
    }
  })

  it('never opens a url that is not on this repository', async () => {
    const h = makeUpdater({ response: release('v0.3.0', 'https://evil.example/download') })
    const state = await h.updater.check(true)
    expect(state.url).toBe('https://github.com/alan940408/media-converter/releases/tag/v0.3.0')
  })

  it('macOS / Linux builds take the same path, flagged as manual', async () => {
    const h = makeUpdater({ platform: 'darwin', env: {} })
    const state = await h.updater.check(true)
    expect(h.loadAutoUpdater).not.toHaveBeenCalled()
    expect(state).toMatchObject({ mode: 'manual', status: 'available', version: '0.2.0' })
    expect(h.events[1]).toMatchObject({ type: 'available', portable: true })
  })

  it('shares one request between overlapping checks', async () => {
    const h = makeUpdater()
    const [a, b] = await Promise.all([h.updater.check(true), h.updater.check(false)])
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })
})

// ───────────────────────────── errors are silent ─────────────────────────────

describe('updater: errors are silent', () => {
  const cases: { name: string; response: FetchResponseLike | (() => Promise<FetchResponseLike>); kind: string }[] = [
    { name: '404 (no release yet / private repo)', response: json(404, { message: 'Not Found' }), kind: 'not-found' },
    { name: '401', response: json(401, { message: 'Bad credentials' }), kind: 'not-found' },
    { name: '403 rate limit', response: json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }), kind: 'rate-limit' },
    { name: '429', response: json(429, {}), kind: 'rate-limit' },
    { name: '500', response: json(500, {}), kind: 'other' },
    { name: 'offline', response: () => Promise.reject(new TypeError('fetch failed')), kind: 'network' },
    { name: 'garbage tag', response: json(200, { tag_name: 'nightly' }), kind: 'other' },
    {
      name: 'bad JSON',
      response: async () => ({ ok: true, status: 200, json: async () => JSON.parse('{') as unknown }),
      kind: 'other',
    },
  ]

  for (const c of cases) {
    it(`${c.name} → status 'error' (${c.kind}), resolves, logs a warning`, async () => {
      const h = makeUpdater({ response: c.response })
      const state = await h.updater.check(false)
      expect(state.status).toBe('error')
      expect(state.error?.kind).toBe(c.kind)
      expect(state.lastCheckedAt).toBeTypeOf('number')
      expect(h.events.map((e) => e.type)).toEqual(['checking', 'error'])
      expect(h.events.some((e) => e.type === 'available')).toBe(false)
      expect(h.log.warn).toHaveBeenCalledTimes(1)
      // a later check starts clean
      h.fetch.mockImplementation(async () => release('v0.2.0'))
      const next = await h.updater.check(true)
      expect(next.status).toBe('available')
      expect(next.error).toBeUndefined()
    })
  }

  it('classifies electron-updater style errors', () => {
    expect(describeUpdateError(Object.assign(new Error('HttpError: 404'), { statusCode: 404 })).kind).toBe('not-found')
    expect(describeUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED')).kind).toBe('network')
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND github.com')).kind).toBe('network')
    expect(describeUpdateError(new Error('Unable to find latest version on GitHub (https://github.com/...)')).kind).toBe('not-found')
    expect(describeUpdateError(new UpdateCheckError('x', 'rate-limit')).kind).toBe('rate-limit')
    expect(describeUpdateError('weird').kind).toBe('other')
    // only the first line of multi-line dumps is kept
    expect(describeUpdateError(new Error('first line\nheaders: {...}\nmore')).message).toBe('first line')
  })
})

// ───────────────────────────── disabled / scheduling ─────────────────────────────

describe('updater: scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is disabled when not packaged: no checks, no events, no electron-updater', async () => {
    const h = makeUpdater({ isPackaged: false, env: {} })
    expect(h.updater.mode).toBe('disabled')
    h.updater.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    const state = await h.updater.check(true)
    expect(state).toMatchObject({ mode: 'disabled', status: 'disabled' })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.loadAutoUpdater).not.toHaveBeenCalled()
    expect(h.events).toEqual([])
    await h.updater.installNow()
    expect(h.au.installs).toEqual([])
  })

  it('checks ~10 s after start and then every 6 hours', async () => {
    const h = makeUpdater({ response: release('v0.1.0') })
    h.updater.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 100)
    expect(h.fetch).toHaveBeenCalledTimes(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(h.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(h.fetch).toHaveBeenCalledTimes(3)
    h.updater.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3)
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('autoCheckUpdates: false prevents automatic checks; manual checks still work; turning it on schedules again', async () => {
    const h = makeUpdater({ settingsPatch: { autoCheckUpdates: false }, response: release('v0.1.0') })
    h.updater.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(h.fetch).not.toHaveBeenCalled()
    // a scheduled-style call is ignored too
    await h.updater.check(false)
    expect(h.fetch).not.toHaveBeenCalled()

    await h.updater.check(true)
    expect(h.fetch).toHaveBeenCalledTimes(1)

    h.settings.patch({ autoCheckUpdates: true })
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 10)
    expect(h.fetch).toHaveBeenCalledTimes(2)

    h.settings.patch({ autoCheckUpdates: false })
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })
})

// ───────────────────────────── installed build: electron-updater ─────────────────────────────

describe('updater: installed build (electron-updater)', () => {
  it('configures autoUpdater lazily and maps its events', async () => {
    const h = makeUpdater({ env: {} })
    expect(h.updater.mode).toBe('auto')
    expect(h.loadAutoUpdater).not.toHaveBeenCalled()
    h.au.next = 'available'
    const state = await h.updater.check(true)
    expect(h.loadAutoUpdater).toHaveBeenCalledTimes(1)
    expect(h.au.autoDownload).toBe(true)
    expect(h.au.autoInstallOnAppQuit).toBe(true)
    expect(h.fetch).not.toHaveBeenCalled()
    expect(state).toMatchObject({ mode: 'auto', status: 'available', version: '0.2.0' })

    h.au.emit('download-progress', { percent: 10.2 })
    h.au.emit('download-progress', { percent: 10.7 }) // same whole percent: no extra event
    h.au.emit('download-progress', { percent: 55 })
    expect(h.updater.getState()).toMatchObject({ status: 'downloading', percent: 55 })
    h.au.emit('update-downloaded', { version: '0.2.0' })
    expect(h.updater.getState()).toMatchObject({ status: 'downloaded', version: '0.2.0' })
    expect(h.events.map((e) => e.type)).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloaded'])
    expect(h.events[1]).toMatchObject({ type: 'available', version: '0.2.0', portable: false })
    expect(h.events[4]).toMatchObject({ type: 'downloaded', version: '0.2.0' })

    // waiting for a restart: further checks do nothing
    await h.updater.check(true)
    expect(h.au.checks).toBe(1)
  })

  it('installNow runs beforeInstall, then quitAndInstall (silent, relaunch)', async () => {
    vi.useFakeTimers()
    try {
      const quit = vi.fn()
      let allow = false
      const beforeInstall = vi.fn(async () => allow)
      const h = makeUpdater({ env: {}, beforeInstall, quit })
      // nothing downloaded yet
      await h.updater.installNow()
      expect(beforeInstall).not.toHaveBeenCalled()

      h.au.next = 'available'
      await h.updater.check(true)
      h.au.emit('update-downloaded', { version: '0.2.0' })

      await h.updater.installNow()
      expect(beforeInstall).toHaveBeenCalledTimes(1)
      expect(h.au.installs).toEqual([]) // the user cancelled (queue busy)

      allow = true
      await h.updater.installNow()
      expect(h.au.installs).toEqual([[true, true]])
      // fallback quit only fires when the installer did not take over
      expect(quit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(6000)
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failing check emits a single silent error and resolves', async () => {
    const h = makeUpdater({ env: {} })
    h.au.next = 'error'
    const state = await h.updater.check(false)
    expect(state.status).toBe('error')
    expect(state.error?.kind).toBe('network')
    expect(h.events.map((e) => e.type)).toEqual(['checking', 'error'])
    expect(h.log.warn).toHaveBeenCalledTimes(1)
  })

  it('a failing loader (e.g. missing app-update.yml) is an error, and the next check retries', async () => {
    const h = makeUpdater({ env: {} })
    h.loadAutoUpdater.mockImplementationOnce(() => {
      throw new Error('ENOENT: app-update.yml')
    })
    const state = await h.updater.check(true)
    expect(state.status).toBe('error')
    const again = await h.updater.check(true)
    expect(again.status).toBe('not-available')
    expect(h.loadAutoUpdater).toHaveBeenCalledTimes(2)
  })
})

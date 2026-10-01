// Shared helpers for the Electron E2E tests.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolveFfmpeg, type TestMediaManifest } from '../scripts/make-test-media.mjs'
import type { InvokeMethod, MediaApi } from '../src/shared/api'
import type { Job, JobStatus } from '../src/shared/types'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const E2E_TMP = join(ROOT, 'e2e', '.tmp')
export const MEDIA_DIR = join(E2E_TMP, 'media')
export const SCREENSHOT_DIR = join(ROOT, 'e2e', 'screenshots')

export function readManifest(): TestMediaManifest {
  return JSON.parse(readFileSync(join(MEDIA_DIR, 'manifest.json'), 'utf8')) as TestMediaManifest
}

/** New empty folder under e2e/.tmp (outputs of one test run). */
export function freshDir(prefix: string): string {
  mkdirSync(E2E_TMP, { recursive: true })
  return mkdtempSync(join(E2E_TMP, `${prefix}-`))
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  userDataDir: string
}

/** Launch the built app (out/main/index.js via package.json "main") with a throw-away userData folder. */
export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'mc-e2e-'))
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  env.MC_USER_DATA_DIR = userDataDir
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env, timeout: 60_000 })
  const page = await app.firstWindow({ timeout: 60_000 })
  // config `use` options do not reach _electron pages: keep clicks/waits from hanging for the whole test timeout
  page.setDefaultTimeout(15_000)
  await page.waitForLoadState('domcontentloaded')
  // consistent screenshots regardless of the saved window state
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMaximized()) win.unmaximize()
      win.setSize(1440, 900)
    }
  })
  return { app, page, userDataDir }
}

type ApiResult<K extends InvokeMethod> = Awaited<ReturnType<MediaApi[K]>>

/** Call window.api.<method>(...args) inside the renderer and return the (structured-cloned) result. */
export async function api<K extends InvokeMethod>(page: Page, method: K, ...args: Parameters<MediaApi[K]>): Promise<ApiResult<K>> {
  return page.evaluate(
    ([m, a]) => {
      const w = globalThis as unknown as { api?: Record<string, (...x: unknown[]) => Promise<unknown>> }
      if (!w.api) throw new Error('window.api is not exposed (preload failed?)')
      return w.api[m](...a)
    },
    [method, args as unknown[]] as const,
  ) as Promise<ApiResult<K>>
}

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled', 'skipped']

/** Poll getQueue() until every job in `ids` reached a terminal status. */
export async function waitForJobs(page: Page, ids: string[], timeoutMs = 120_000): Promise<Job[]> {
  const deadline = Date.now() + timeoutMs
  let last: Job[] = []
  while (Date.now() < deadline) {
    const q = await api(page, 'getQueue')
    last = ids.map((id) => q.jobs.find((j) => j.id === id)).filter((j): j is Job => !!j)
    if (last.length === ids.length && last.every((j) => TERMINAL.includes(j.status))) return last
    await page.waitForTimeout(500)
  }
  const state = last.map((j) => `${j.id}: ${j.status} ${(j.progress * 100).toFixed(0)}%`).join(', ')
  throw new Error(`jobs did not finish within ${timeoutMs / 1000}s (${state || 'jobs missing from queue'})`)
}

/** Human-readable failure context for a job. */
export function describeJob(job: Job): string {
  return [`status=${job.status} encoder=${job.encoder ?? '?'} error=${job.error ?? ''}`, ...(job.logTail ?? []).slice(-15)].join('\n')
}

let bins: { ffmpeg: string; ffprobe: string } | null = null
const ffprobeBin = (): string => (bins ??= resolveFfmpeg()).ffprobe
const ffmpegBin = (): string => (bins ??= resolveFfmpeg()).ffmpeg

export interface ProbeResult {
  width?: number
  height?: number
  durationSec?: number
  videoCodec?: string
  audioCodec?: string
  formatName?: string
}

export function ffprobe(path: string): ProbeResult {
  const r = spawnSync(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.error || r.status !== 0) throw new Error(`ffprobe failed for ${path}: ${r.error?.message ?? r.stderr}`)
  const j = JSON.parse(r.stdout) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]
    format: { duration?: string; format_name?: string }
  }
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  return {
    width: v?.width,
    height: v?.height,
    durationSec: j.format.duration ? Number(j.format.duration) : undefined,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    formatName: j.format.format_name,
  }
}

/** Mean and standard deviation of the luma in a w×h region at (x, y) of the frame at timeSec. */
export function lumaStats(path: string, timeSec: number, x: number, y: number, w: number, h: number): { mean: number; std: number } {
  const r = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-ss', String(timeSec), '-i', path, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  )
  if (r.error || r.status !== 0 || !r.stdout?.length) throw new Error(`frame extraction failed for ${path}: ${r.error?.message ?? r.stderr}`)
  const px = r.stdout as Buffer
  let sum = 0
  for (const v of px) sum += v
  const mean = sum / px.length
  let sq = 0
  for (const v of px) sq += (v - mean) ** 2
  return { mean, std: Math.sqrt(sq / px.length) }
}

export async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const path = join(SCREENSHOT_DIR, `${name}.png`)
  await page.waitForTimeout(400) // let transitions settle
  await page.screenshot({ path })
  return path
}

/** Main navigation targets, matched by accessible name / text in en, zh-TW and ja. */
export const TABS = {
  queue: /^\s*(queue|佇列|編碼佇列|轉檔佇列|キュー)/i,
  presets: /^\s*(presets|預設集|預設|プリセット)/i,
  watch: /^\s*(watch folders?|監看資料夾|監視資料夾|監視フォルダ|ウォッチフォルダ)/i,
  settings: /^\s*(settings|preferences|設定|偏好設定|環境設定)/i,
} as const

export type TabKey = keyof typeof TABS

/** Click a main navigation tab. Tries ARIA roles, then data attributes, then plain text. */
export async function openTab(page: Page, key: TabKey): Promise<void> {
  const name = TABS[key]
  for (const role of ['tab', 'link', 'button', 'menuitem', 'radio'] as const) {
    const loc = page.getByRole(role, { name })
    if ((await loc.count()) > 0) {
      await loc.first().click()
      return
    }
  }
  for (const sel of [`[data-testid="tab-${key}"]`, `[data-testid="nav-${key}"]`, `[data-tab="${key}"]`, `[data-view="${key}"]`]) {
    const loc = page.locator(sel)
    if ((await loc.count()) > 0) {
      await loc.first().click()
      return
    }
  }
  const text = page.getByText(name)
  if ((await text.count()) > 0) {
    await text.first().click()
    return
  }
  throw new Error(`navigation tab "${key}" not found (tried roles tab/link/button/menuitem/radio, data-testid/data-tab/data-view, text ${name})`)
}

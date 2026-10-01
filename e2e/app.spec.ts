// End-to-end: launch the built app, drive the queue through window.api, verify real output files.
import { existsSync, rmSync } from 'node:fs'
import { extname } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import sharp from 'sharp'
import type { TestMediaManifest } from '../scripts/make-test-media.mjs'
import type { TextWatermark } from '../src/shared/types'
import { api, describeJob, ffprobe, freshDir, launchApp, lumaStats, openTab, readManifest, shot, waitForJobs } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDir: string
let media: TestMediaManifest
let outDir: string
const pageErrors: string[] = []

test.beforeAll(async () => {
  media = readManifest()
  outDir = freshDir('out')
  ;({ app, page, userDataDir } = await launchApp())
  page.on('pageerror', (err) => pageErrors.push(err.message))
  // deterministic queue behaviour: nothing starts on add, finished jobs stay visible, no OS notifications
  await api(page, 'saveSettings', { autoStart: false, removeFinished: false, notifyOnFinish: false, preventSleep: false, conflict: 'rename' })
})

test.afterAll(async () => {
  if (pageErrors.length) console.warn(`[e2e] renderer errors:\n${pageErrors.join('\n')}`)
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('window opens with an empty queue', async () => {
  await expect(page.locator('#root > *').first()).toBeVisible()
  const info = await api(page, 'getAppInfo')
  expect(info.name).toBeTruthy()
  const q = await api(page, 'getQueue')
  expect(q.jobs).toHaveLength(0)
  await shot(page, '01-queue-empty')
})

test('encodes a video with the h264-720p preset', async () => {
  const res = await api(page, 'addJobs', { paths: [media.video], videoPresetId: 'h264-720p', output: { dir: outDir } })
  expect(res.ignored).toEqual([])
  expect(res.jobs).toHaveLength(1)
  expect(res.jobs[0].kind).toBe('video')

  await api(page, 'startQueue')
  const [job] = await waitForJobs(page, res.jobs.map((j) => j.id), 120_000)
  expect(job.status, describeJob(job)).toBe('done')
  expect(job.outputPath).toBeTruthy()
  const out = job.outputPath!
  expect(existsSync(out), out).toBe(true)
  expect(extname(out).toLowerCase()).toBe('.mp4')

  const p = ffprobe(out)
  expect([p.width, p.height]).toEqual([1280, 720])
  expect(p.videoCodec).toBe('h264')
  expect(p.audioCodec).toBe('aac')
  expect(p.durationSec ?? 0).toBeGreaterThan(2.7)
  expect(p.durationSec ?? 0).toBeLessThan(3.3)
})

test('converts a 4000×3000 JPEG with img-web-2048-webp', async () => {
  const res = await api(page, 'addJobs', { paths: [media.jpeg], imagePresetId: 'img-web-2048-webp', output: { dir: outDir } })
  expect(res.ignored).toEqual([])
  expect(res.jobs).toHaveLength(1)
  expect(res.jobs[0].kind).toBe('image')

  await api(page, 'startQueue')
  const [job] = await waitForJobs(page, res.jobs.map((j) => j.id), 120_000)
  expect(job.status, describeJob(job)).toBe('done')
  const out = job.outputPath!
  expect(existsSync(out), out).toBe(true)
  expect(extname(out).toLowerCase()).toBe('.webp')

  const meta = await sharp(out).metadata()
  expect(meta.format).toBe('webp')
  expect([meta.width, meta.height]).toEqual([2048, 1536])
})

test('watermark + trim job', async () => {
  const res = await api(page, 'addJobs', {
    paths: [media.flat],
    videoPresetId: 'h264-720p',
    output: { dir: outDir, nameTemplate: '{name}_wm_trim' },
  })
  expect(res.jobs).toHaveLength(1)
  const queued = res.jobs[0]
  expect(queued.video?.settings).toBeTruthy()

  const watermark: TextWatermark = {
    type: 'text',
    text: 'E2E {name}',
    anchor: 'bottom-right',
    marginPct: 3,
    opacity: 0.9,
    fontSizePct: 8,
    color: '#ffffff',
    bold: true,
    shadow: false,
    background: null,
  }
  const patched = await api(page, 'updateJob', queued.id, {
    video: { settings: { ...queued.video!.settings, watermark }, trim: { inSec: 1, outSec: 3 } },
  })
  expect(patched.video?.trim).toEqual({ inSec: 1, outSec: 3 })
  expect(patched.video?.settings.watermark).toMatchObject({ type: 'text', anchor: 'bottom-right' })

  await api(page, 'startQueue')
  const [job] = await waitForJobs(page, [queued.id], 120_000)
  expect(job.status, describeJob(job)).toBe('done')
  const out = job.outputPath!
  expect(existsSync(out), out).toBe(true)

  const p = ffprobe(out)
  expect([p.width, p.height]).toEqual([1280, 720])
  expect(p.durationSec ?? 0).toBeGreaterThan(1.75)
  expect(p.durationSec ?? 0).toBeLessThan(2.25)

  // source is flat grey: the watermark corner must have texture, the opposite corner must not
  const corner = lumaStats(out, 1, 640, 540, 640, 180)
  const blank = lumaStats(out, 1, 0, 0, 640, 180)
  expect(blank.std, `top-left std ${blank.std.toFixed(2)}`).toBeLessThan(4)
  expect(corner.std, `bottom-right std ${corner.std.toFixed(2)} (watermark missing?)`).toBeGreaterThan(8)
})

test('screenshots of each tab', async () => {
  await shot(page, '02-queue-with-jobs')

  // English UI for predictable tab names (the renderer reads settings on load)
  await api(page, 'saveSettings', { language: 'en' })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#root > *').first()).toBeVisible()

  await openTab(page, 'presets')
  await shot(page, '03-presets')
  await openTab(page, 'watch')
  await shot(page, '04-watch-folders')
  await openTab(page, 'settings')
  await shot(page, '05-settings')
  await page.keyboard.press('Escape') // settings may be a modal dialog
  await openTab(page, 'queue')
  await shot(page, '06-queue-en')
  expect((await api(page, 'getQueue')).jobs.length).toBeGreaterThanOrEqual(3)
})

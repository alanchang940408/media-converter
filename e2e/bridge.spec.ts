// End-to-end: the Adobe panel bridge (contract: src/shared/bridge.ts) against the built app — no Adobe software needed.
// The test plays the panel: it reads bridge/info.json, drops inbox/<id>.json (.tmp, then rename) for a "rendered"
// intermediate placed in bridge/intermediates/<id>/, and checks the answer, the conversion and the deleteAfter cleanup.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { TestMediaManifest } from '../scripts/make-test-media.mjs'
import { BRIDGE_VERSION, type BridgeInfo, type BridgeRequest, type BridgeResult } from '../src/shared/bridge'
import { api, describeJob, ffprobe, freshDir, launchApp, readManifest, waitForJobs } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDir: string
let bridgeDir: string
let media: TestMediaManifest
let outDir: string
const pageErrors: string[] = []

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null // not written yet, or caught mid-rename
  }
}

/** Write inbox/<id>.json the way the panel does: <id>.json.tmp first, then rename. */
function sendRequest(req: BridgeRequest): string {
  const inbox = join(bridgeDir, 'inbox')
  mkdirSync(inbox, { recursive: true })
  const final = join(inbox, `${req.id}.json`)
  writeFileSync(`${final}.tmp`, JSON.stringify(req, null, 2), 'utf8')
  renameSync(`${final}.tmp`, final)
  return final
}

/** Poll a JSON file until it parses and passes `ok`. */
async function waitForJson<T>(path: string, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  await expect
    .poll(
      () => {
        const v = readJson<T>(path)
        return !!v && ok(v)
      },
      { timeout: timeoutMs, message: path },
    )
    .toBe(true)
  return readJson<T>(path)!
}

const waitForResult = (id: string): Promise<BridgeResult> =>
  waitForJson<BridgeResult>(join(bridgeDir, 'results', `${id}.json`), (r) => r.id === id)

function request(id: string, files: string[], presetIds: string[], deleteAfter: boolean): BridgeRequest {
  return { bridgeVersion: BRIDGE_VERSION, id, host: 'premiere', files, presetIds, outputDir: outDir, deleteAfter, start: true, createdAt: Date.now() }
}

test.beforeAll(async () => {
  media = readManifest()
  outDir = freshDir('bridge-out')
  ;({ app, page, userDataDir } = await launchApp())
  bridgeDir = join(userDataDir, 'bridge')
  page.on('pageerror', (err) => pageErrors.push(err.message))
  // a bridge request starts its own jobs (start: true) even with auto-start off; no OS notifications for finished jobs
  await api(page, 'saveSettings', { autoStart: false, removeFinished: false, notifyOnFinish: false, preventSleep: false, conflict: 'rename' })
})

test.afterAll(async () => {
  if (pageErrors.length) console.warn(`[e2e] renderer errors:\n${pageErrors.join('\n')}`)
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('writes bridge/info.json with the video presets', async () => {
  const info = await waitForJson<BridgeInfo>(join(bridgeDir, 'info.json'), (i) => Array.isArray(i.presets))
  expect(info.bridgeVersion).toBe(BRIDGE_VERSION)
  expect(info.appVersion).toBeTruthy()
  expect(info.exePath).toBeTruthy()
  expect(['zh-TW', 'en', 'ja']).toContain(info.locale)
  expect(info.presets.length).toBeGreaterThan(0)
  expect(info.presets.every((p) => p.kind === 'video')).toBe(true)
  const p720 = info.presets.find((p) => p.id === 'h264-720p')
  expect(p720, 'h264-720p in info.presets').toBeTruthy()
  expect(p720!.name).toBeTruthy()
  expect(p720!.summary).toBeTruthy()
  expect(p720!.ext).toBe('mp4')
  expect(info.presets.find((p) => p.id === 'prores-422')?.ext).toBe('mov')
  expect(info.presets.map((p) => p.id)).toContain(info.lastVideoPresetId)
  // the folders the panel needs exist
  for (const d of ['inbox', 'results', 'intermediates']) expect(existsSync(join(bridgeDir, d)), d).toBe(true)
})

test('inbox request → job runs → results accepted → output written, intermediate deleted', async () => {
  const id = `e2e-${Date.now()}`
  // a "rendered master" inside bridge/intermediates/<id>/ (spaces + CJK in the name, like real sequence names)
  const interDir = join(bridgeDir, 'intermediates', id)
  mkdirSync(interDir, { recursive: true })
  const intermediate = join(interDir, basename(media.video))
  copyFileSync(media.video, intermediate)

  const inboxFile = sendRequest(request(id, [intermediate], ['h264-720p'], true))

  const result = await waitForResult(id)
  expect(result.status, result.errors.join('\n')).toBe('accepted')
  expect(result.errors).toEqual([])
  expect(result.jobIds).toHaveLength(1)
  expect(existsSync(inboxFile), 'inbox file consumed').toBe(false)
  expect(readdirSync(join(bridgeDir, 'inbox')).filter((f) => f.startsWith(id))).toEqual([])

  const [job] = await waitForJobs(page, result.jobIds, 120_000)
  expect(job.status, describeJob(job)).toBe('done')
  expect(job.source.toLowerCase()).toBe(intermediate.toLowerCase())
  const out = job.outputPath!
  expect(out.toLowerCase().startsWith(outDir.toLowerCase()), out).toBe(true)
  expect(existsSync(out), out).toBe(true)
  expect(extname(out).toLowerCase()).toBe('.mp4')
  const p = ffprobe(out)
  expect([p.width, p.height]).toEqual([1280, 720])
  expect(p.videoCodec).toBe('h264')
  expect(p.durationSec ?? 0).toBeGreaterThan(2.7)
  expect(p.durationSec ?? 0).toBeLessThan(3.3)

  // deleteAfter: the intermediate goes once its only job succeeded; the source it was copied from stays
  await expect.poll(() => existsSync(intermediate), { timeout: 15_000, message: intermediate }).toBe(false)
  expect(existsSync(media.video)).toBe(true)
})

test('outputs: the same preset twice with its own file names, and two outputs with the same name never overwrite', async () => {
  const id = `e2e-outputs-${Date.now()}`
  const interDir = join(bridgeDir, 'intermediates', id)
  mkdirSync(interDir, { recursive: true })
  const intermediate = join(interDir, basename(media.video))
  copyFileSync(media.video, intermediate)
  const stem = `成品 ${id}`
  // like the panel: presetIds filled from the outputs for older apps
  sendRequest({
    ...request(id, [intermediate], ['h264-720p'], true),
    outputs: [
      { presetId: 'h264-720p', nameTemplate: stem },
      { presetId: 'h264-720p', nameTemplate: `${stem} 小` },
      { presetId: 'h264-1080p', nameTemplate: stem },
    ],
  })

  const result = await waitForResult(id)
  expect(result.status, result.errors.join('\n')).toBe('accepted')
  expect(result.errors).toEqual([])
  expect(result.jobIds).toHaveLength(3)
  const jobs = await waitForJobs(page, result.jobIds, 180_000)
  for (const j of jobs) expect(j.status, describeJob(j)).toBe('done')
  const names = result.jobIds.map((jid) => basename(jobs.find((j) => j.id === jid)!.outputPath!))
  expect(names).toEqual([`${stem}.mp4`, `${stem} 小.mp4`, `${stem} (1).mp4`])
  for (const j of jobs) expect(existsSync(j.outputPath!), j.outputPath).toBe(true)
  // deleteAfter waits for every output
  await expect.poll(() => existsSync(intermediate), { timeout: 15_000, message: intermediate }).toBe(false)
})

test('unknown presets are reported; deleteAfter never touches files outside bridge/intermediates', async () => {
  const id = `e2e-outside-${Date.now()}`
  const srcDir = freshDir('bridge-src')
  const outside = join(srcDir, basename(media.video))
  copyFileSync(media.video, outside)

  sendRequest(request(id, [outside], ['h264-720p', 'no-such-preset'], true))

  const result = await waitForResult(id)
  expect(result.status).toBe('accepted')
  expect(result.jobIds).toHaveLength(1)
  expect(result.errors.some((e) => e.includes('no-such-preset')), result.errors.join('\n')).toBe(true)
  expect(result.errors.some((e) => e.includes(outside)), result.errors.join('\n')).toBe(true)

  const [job] = await waitForJobs(page, result.jobIds, 120_000)
  expect(job.status, describeJob(job)).toBe('done')
  expect(existsSync(job.outputPath!)).toBe(true)
  await page.waitForTimeout(1000)
  expect(existsSync(outside), 'file outside intermediates kept').toBe(true)
})

test('a request for a missing file is rejected and nothing is queued', async () => {
  const id = `e2e-missing-${Date.now()}`
  const before = (await api(page, 'getQueue')).jobs.length
  const missing = join(bridgeDir, 'intermediates', id, 'gone.mov')
  sendRequest(request(id, [missing], ['h264-720p'], true))

  const result = await waitForResult(id)
  expect(result.status).toBe('rejected')
  expect(result.jobIds).toEqual([])
  expect(result.errors.some((e) => e.includes(missing)), result.errors.join('\n')).toBe(true)
  expect((await api(page, 'getQueue')).jobs.length).toBe(before)
})

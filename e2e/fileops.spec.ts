// End-to-end: batch rename / copy / move and "keep folder structure" against the built app.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { api, describeJob, freshDir, launchApp, readManifest, waitForJobs } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDir: string

/** root/{a.txt, 第2張 照片.jpg, sub/{10.txt, 2.txt}} — CJK + spaces + natural-sort bait. */
function makeTree(): string {
  const root = freshDir('tree')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'a.txt'), 'a')
  writeFileSync(join(root, '第2張 照片.jpg'), 'not really a jpeg')
  writeFileSync(join(root, 'sub', '10.txt'), 'ten')
  writeFileSync(join(root, 'sub', '2.txt'), 'two')
  return root
}

test.beforeAll(async () => {
  readManifest()
  ;({ app, page, userDataDir } = await launchApp())
  // autoStart on: file-mode adds must still NOT start by themselves
  await api(page, 'saveSettings', { autoStart: true, removeFinished: false, notifyOnFinish: false, preventSleep: false, conflict: 'rename' })
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('copy & rename keeps the folder structure and leaves sources untouched', async () => {
  const root = makeTree()
  const out = freshDir('copies')
  const res = await api(page, 'addJobs', {
    paths: [root],
    recursive: true,
    filePresetId: 'file-copy-rename',
    output: { dir: out, nameTemplate: '{parent}_{counter:3}', preserveStructure: true },
  })
  expect(res.jobs).toHaveLength(4)
  expect(res.jobs.every((j) => j.kind === 'file')).toBe(true)

  const q = await api(page, 'getQueue')
  expect(q.running, 'file mode must not auto-start').toBe(false)

  const preview = await api(page, 'previewFileOps', res.jobs.map((j) => j.id))
  expect(preview.every((p) => p.status === 'ok')).toBe(true)
  expect(readdirSync(out)).toHaveLength(0) // dry run touched nothing

  await api(page, 'startQueue')
  const done = await waitForJobs(page, res.jobs.map((j) => j.id), 60_000)
  for (const j of done) expect(j.status, describeJob(j)).toBe('done')

  // natural order inside sub/: 2.txt → 003, 10.txt → 004 (root files first: a.txt 001, 第2張 002)
  expect(existsSync(join(out, 'sub', 'sub_003.txt'))).toBe(true)
  expect(existsSync(join(out, 'sub', 'sub_004.txt'))).toBe(true)
  expect(readdirSync(out).filter((f) => f !== 'sub')).toHaveLength(2)
  expect(existsSync(join(root, 'sub', '10.txt')) && existsSync(join(root, 'a.txt'))).toBe(true)
  for (const p of preview) expect(existsSync(p.target!), p.target!).toBe(true)
})

test('rename in place, then undo restores the original names', async () => {
  const root = makeTree()
  const res = await api(page, 'addJobs', {
    paths: [root],
    recursive: true,
    filePresetId: 'file-rename',
    output: { dir: null, nameTemplate: 'renamed_{counter:3}' },
  })
  await api(page, 'startQueue')
  const done = await waitForJobs(page, res.jobs.map((j) => j.id), 60_000)
  for (const j of done) expect(j.status, describeJob(j)).toBe('done')
  expect(existsSync(join(root, 'a.txt'))).toBe(false)
  expect(readdirSync(join(root, 'sub')).every((f) => f.startsWith('renamed_'))).toBe(true)

  const undo = await api(page, 'getFileOpUndo')
  expect(undo?.count).toBe(4)
  const r = await api(page, 'undoFileOps')
  expect(r.restored).toBe(4)
  expect(r.failed).toEqual([])
  expect(existsSync(join(root, 'a.txt'))).toBe(true)
  expect(existsSync(join(root, '第2張 照片.jpg'))).toBe(true)
  expect(existsSync(join(root, 'sub', '10.txt'))).toBe(true)
  expect(await api(page, 'getFileOpUndo')).toBeNull()
})

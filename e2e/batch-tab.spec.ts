// End-to-end: drive the "Batch rename" tab itself (files → template → preview → run → undo), against the built app.
// The native file dialog is stubbed in the main process; everything else goes through the UI.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { api, freshDir, launchApp, shot } from './helpers'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDir: string
const pageErrors: string[] = []

/** The next native open dialog (Add files / Add folder) "chooses" these paths. */
async function stubOpenDialog(paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as typeof dialog.showOpenDialog
  }, paths)
}

test.beforeAll(async () => {
  ;({ app, page, userDataDir } = await launchApp())
  page.on('pageerror', (err) => pageErrors.push(err.message))
  // autoStart on: the batch must still wait for "Run"; English UI for readable failures
  await api(page, 'saveSettings', { language: 'en', autoStart: true, removeFinished: false, notifyOnFinish: false, preventSleep: false, conflict: 'rename' })
  await page.reload()
  await page.waitForSelector('.app-header', { timeout: 30_000 })
})

test.afterAll(async () => {
  if (pageErrors.length) console.warn(`[e2e] renderer errors:\n${pageErrors.join('\n')}`)
  await app?.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

test('batch rename tab: add files, preview with a name clash, run, then undo', async () => {
  const dir = freshDir('batch-tab')
  const files = ['a.txt', 'b.txt', 'c 3.txt']
  for (const f of files) writeFileSync(join(dir, f), `content of ${f}`)
  // not part of the batch: makes b.txt's new name clash → "Number added"
  writeFileSync(join(dir, 'trip_002.txt'), 'already here')

  await page.getByRole('tab', { name: /batch rename/i }).click()
  const view = page.locator('.batch-view')
  await expect(view).toBeVisible()

  // ── step 1: files, operation, name template ──
  await stubOpenDialog(files.map((f) => join(dir, f)))
  await view.locator('.fo-add-row button').first().click() // "Add files"
  await expect(view.locator('.fo-entry')).toHaveCount(3)
  await view.locator('.fo-op.op-rename').click()
  await expect(view.locator('.fo-op.op-rename')).toHaveAttribute('aria-checked', 'true')
  await view.locator('.ntf-input').fill('trip_{counter:3}')
  // live examples follow the template before anything runs
  await expect(view.locator('.fo-examples .fo-ex-to').first()).toHaveText('trip_001.txt')
  expect(readdirSync(dir).sort()).toEqual([...files, 'trip_002.txt'].sort())

  // ── step 2: preview (dry run: nothing on disk changes) ──
  await view.locator('.batch-foot').getByRole('button', { name: /preview/i }).click()
  const rows = view.locator('.fo-tbody .fo-tr')
  await expect(rows).toHaveCount(3)
  await expect(rows.locator('.fo-td.new')).toHaveText(['trip_001.txt', 'trip_002 (1).txt', 'trip_003.txt'])
  await expect(rows.nth(1)).toHaveClass(/row-renamed/)
  await expect(view.locator('.fo-notes .issue')).toHaveCount(1) // "1 name is already taken"
  expect(readdirSync(dir).sort()).toEqual([...files, 'trip_002.txt'].sort())
  const q = await api(page, 'getQueue')
  expect(q.running, 'the preview must not start the batch').toBe(false)
  await shot(page, 'batch-tab-preview')

  // ── step 3: run ──
  await view.locator('.batch-foot').getByRole('button', { name: /run \(3\)/i }).click()
  const runRows = view.locator('.batch-run-row')
  await expect(runRows).toHaveCount(3)
  await expect(view.locator('.batch-run-row.st-done')).toHaveCount(3, { timeout: 30_000 })
  await expect(runRows.locator('.batch-run-target')).toHaveText(['trip_001.txt', 'trip_002 (1).txt', 'trip_003.txt'])
  expect(readdirSync(dir).sort()).toEqual(['trip_001.txt', 'trip_002 (1).txt', 'trip_002.txt', 'trip_003.txt'])
  expect(readFileSync(join(dir, 'trip_002 (1).txt'), 'utf8')).toBe('content of b.txt')
  expect(readFileSync(join(dir, 'trip_002.txt'), 'utf8')).toBe('already here')
  // one Undo button: in the footer of the result step
  const undo = view.locator('.tb-undo')
  await expect(undo).toHaveCount(1)
  await shot(page, 'batch-tab-done')

  // ── step 4: undo ──
  await undo.click()
  const dialog = page.locator('.dialog-modal')
  await expect(dialog).toBeVisible()
  await dialog.locator('.modal-footer button').last().click()
  await expect(view.locator('.batch-undone')).toBeVisible({ timeout: 15_000 })
  await expect(view.locator('.batch-run-row.is-restored')).toHaveCount(3)
  await expect(view.locator('.tb-undo')).toHaveCount(0)
  expect(readdirSync(dir).sort()).toEqual([...files, 'trip_002.txt'].sort())
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).toBe(`content of ${f}`)
  expect(existsSync(join(dir, 'trip_001.txt'))).toBe(false)
  expect(await api(page, 'getFileOpUndo')).toBeNull()
  await shot(page, 'batch-tab-undone')

  // ── back to an empty form for the next batch ──
  await view.locator('.batch-foot').getByRole('button', { name: /new batch/i }).click()
  await expect(view.locator('.fo-entry')).toHaveCount(0)
  await expect.poll(async () => (await api(page, 'getQueue')).jobs.filter((j) => j.kind === 'file').length).toBe(0)
  expect(pageErrors).toEqual([])
})

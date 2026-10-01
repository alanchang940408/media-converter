// Smoke test of the PACKAGED app (after `npm run dist`). Skipped unless MC_PACKAGED_EXE points at the built exe, e.g.
//   MC_PACKAGED_EXE="release/win-unpacked/Media Converter.exe" npx playwright test e2e/packaged.spec.ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { api, describeJob, freshDir, readManifest, shot, waitForJobs } from './helpers'

const exe = process.env.MC_PACKAGED_EXE

test.skip(!exe, 'set MC_PACKAGED_EXE to run against the packaged build')

test('packaged app uses the bundled ffmpeg and converts video + image', async () => {
  const media = readManifest()
  const userDataDir = mkdtempSync(join(tmpdir(), 'mc-packaged-'))
  const app = await _electron.launch({
    executablePath: resolve(exe!),
    env: { ...process.env, MC_USER_DATA_DIR: userDataDir, MC_NO_QUIT_CONFIRM: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.api)
    await api(page, 'saveSettings', { autoStart: false, notifyOnFinish: false, preventSleep: false })

    const caps = await api(page, 'getCapabilities', true)
    expect(caps.ffmpegSource).toBe('bundled')
    console.log(`[packaged] ffmpeg ${caps.ffmpegVersion} · hw: ${caps.workingHwEncoders.join(', ') || 'none'}`)

    const out = freshDir('packaged-out')
    const res = await api(page, 'addJobs', {
      paths: [media.video, media.jpeg],
      videoPresetId: 'h264-720p',
      imagePresetId: 'img-web-2048-webp',
      output: { dir: out },
    })
    expect(res.jobs).toHaveLength(2)
    await api(page, 'startQueue')
    const done = await waitForJobs(page, res.jobs.map((j) => j.id), 120_000)
    for (const j of done) {
      expect(j.status, describeJob(j)).toBe('done')
      expect(existsSync(j.outputPath!)).toBe(true)
      console.log(`[packaged] ${j.kind} → ${j.outputPath} (${j.encoder})`)
    }
    await shot(page, '10-packaged-app')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

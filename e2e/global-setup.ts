// Runs once before the E2E suite: checks the app is built and generates the synthetic test media.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestMedia } from '../scripts/make-test-media.mjs'
import { MEDIA_DIR, ROOT, SCREENSHOT_DIR } from './helpers'

export default async function globalSetup(): Promise<void> {
  for (const f of [join('out', 'main', 'index.js'), join('out', 'preload', 'index.cjs'), join('out', 'renderer', 'index.html')]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing: run "npm run build" before "npm run e2e"`)
  }
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const media = await makeTestMedia(MEDIA_DIR, { log: (m) => console.log(`[e2e] ${m}`) })
  console.log(`[e2e] test media ready in ${media.dir}`)
}

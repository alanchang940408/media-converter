// E2E tests drive the built Electron app (Playwright `_electron`). Run `npm run build` first, then `npm run e2e`.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  globalSetup: './e2e/global-setup.ts',
  // one Electron instance at a time: encodes are CPU/GPU heavy and share the queue
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
})

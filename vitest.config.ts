import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // ffmpeg integration tests are CPU heavy
    fileParallelism: true,
    maxWorkers: 4,
  },
})

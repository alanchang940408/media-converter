// window.api (Electron preload) or the in-memory mock when running in a plain browser.
import type { MediaApi } from '../../shared/api'

export let api: MediaApi = window.api as MediaApi
export let isMock = !window.api

/** Loads the mock lazily so it never ships into the Electron renderer's main chunk. */
export async function ensureApi(): Promise<void> {
  if (window.api) return
  const m = await import('./mockApi')
  api = m.createMockApi()
  isMock = true
}

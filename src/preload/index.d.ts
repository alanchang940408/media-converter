import type { MediaApi } from '../shared/api'

declare global {
  interface Window {
    /** Undefined when the renderer runs in a plain browser (npm run dev:web) — use the mock API then. */
    api?: MediaApi
  }
}

export {}

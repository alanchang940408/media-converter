// JSON persistence in app.getPath('userData'). Import this module first from index.ts:
// MC_USER_DATA_DIR (used by E2E tests) must redirect userData before anything reads it.
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { JsonStore, type JsonStoreOptions } from './jsonStore'

export { JsonStore } from './jsonStore'
export type { JsonStoreOptions } from './jsonStore'

let applied = false

/** Honour MC_USER_DATA_DIR. Idempotent; runs at module load and again from index.ts. */
export function applyUserDataOverride(): void {
  if (applied) return
  applied = true
  const dir = process.env.MC_USER_DATA_DIR
  if (dir && dir.trim()) {
    const abs = resolve(dir.trim())
    mkdirSync(abs, { recursive: true })
    app.setPath('userData', abs)
  }
}

applyUserDataOverride()

export function userDataDir(): string {
  return app.getPath('userData')
}

export function userDataFile(name: string): string {
  return join(userDataDir(), name)
}

const stores: JsonStore<unknown>[] = []

/** Open (and register for flushAllStores) a JSON store in userData. */
export function openStore<T>(name: string, defaults: () => T, opts?: JsonStoreOptions<T>): JsonStore<T> {
  const store = new JsonStore<T>(userDataFile(name), defaults, opts)
  stores.push(store as JsonStore<unknown>)
  return store
}

export function flushAllStoresSync(): void {
  for (const s of stores) s.flushSync()
}

export async function flushAllStores(): Promise<void> {
  await Promise.all(stores.map((s) => s.flush()))
}

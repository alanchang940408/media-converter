// Tiny JSON file persistence: synchronous load, debounced atomic save (tmp + rename).
// Pure Node — no Electron import, so queue/presets/watch tests can use it with a temp dir.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface JsonStoreOptions<T> {
  /** Debounce for save(); default 300 ms. */
  debounceMs?: number
  /** Turn whatever was on disk into a valid T (return null to fall back to defaults). */
  parse?: (raw: unknown) => T | null
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class JsonStore<T> {
  private data: T
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> | null = null
  private dirty = false
  private readonly debounceMs: number

  constructor(
    readonly file: string,
    defaults: () => T,
    opts: JsonStoreOptions<T> = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 300
    let loaded: T | null = null
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      loaded = opts.parse ? opts.parse(raw) : (raw as T)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // keep the unreadable file for inspection instead of silently losing it
        try {
          renameSync(file, `${file}.corrupt-${Date.now()}`)
        } catch {
          /* ignore */
        }
      }
    }
    this.data = loaded ?? defaults()
  }

  get(): T {
    return this.data
  }

  /** Replace the value and schedule a save. The value is serialized at write time (latest state wins). */
  set(value: T): void {
    this.data = value
    this.save()
  }

  /** Schedule a debounced save of the current value. */
  save(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.debounceMs)
  }

  /** Write now if there are pending changes. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    while (this.writing) await this.writing
    if (!this.dirty) return
    this.dirty = false
    const json = JSON.stringify(this.data, null, 2)
    this.writing = this.writeAtomic(json).finally(() => {
      this.writing = null
    })
    await this.writing
  }

  /** Synchronous flush for app quit. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const tmp = `${this.file}.${process.pid}.sync.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      console.error(`[store] failed to write ${this.file}:`, err)
    }
  }

  private async writeAtomic(json: string): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(tmp, json, 'utf8')
      // Windows: antivirus/indexers can briefly lock the target → retry
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, this.file)
          break
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
          await sleep(50 * (attempt + 1))
        }
      }
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      console.error(`[store] failed to write ${this.file}:`, err)
    }
  }
}

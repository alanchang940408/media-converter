// Fakes and utilities for core tests (no Electron, no real ffmpeg/sharp).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  EncodeError,
  type FfmpegEngine,
  type ImageEngine,
  type ImageProcessRequest,
  type ImageProcessResult,
  type VideoEncodeRequest,
  type VideoEncodeResult,
  type WatermarkLayer,
} from '../../src/main/contracts'
import { JsonStore } from '../../src/main/jsonStore'
import { emptyPresetFile, PresetStore, type PresetFile } from '../../src/main/presets/store'
import type { FileOpsFs } from '../../src/main/queue/fileOps'
import { emptyJournal, parseJournal, type FileOpJournal, type JournalStore } from '../../src/main/queue/journal'
import { emptyQueue, Queue, type PersistedQueue, type QueueEffects } from '../../src/main/queue/Queue'
import { defaultSettings, type SettingsAccess } from '../../src/main/settings'
import { extOf } from '../../src/shared/media'
import type { AppSettings, EncoderCapabilities, ImageOutputSettings, MediaInfo, QueueEvent, VideoPresetSettings } from '../../src/shared/types'
import { isAudioOnlyContainer } from '../../src/shared/videoRules'

export function makeTempDir(prefix = 'mc-core-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

export function touch(path: string, content = 'x'): string {
  writeFileSync(path, content)
  return path
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const fakeCaps: EncoderCapabilities = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  ffmpegVersion: 'fake',
  ffmpegSource: 'system',
  compiledEncoders: ['libx264'],
  workingHwEncoders: [],
  hw: { nvenc: false, qsv: false, amf: false, videotoolbox: false },
}

const abortError = (): Error => {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

interface Pending<Req> {
  req: Req
  release: () => void
  fail: (err: Error) => void
}

/** Manual mode: work stays "running" until release()/fail(); it writes a partial temp file immediately. */
export class FakeFfmpeg implements FfmpegEngine {
  mode: 'instant' | 'manual' = 'instant'
  failWith: Error | null = null
  readonly encodes: VideoEncodeRequest[] = []
  readonly pending: Pending<VideoEncodeRequest>[] = []
  /** Snapshot taken inside encode(): did the overlay PNG exist while encoding? */
  overlayExisted: boolean[] = []
  probeCalls = 0

  async probe(path: string): Promise<MediaInfo> {
    this.probeCalls++
    const audio = ['mp3', 'wav', 'flac', 'm4a'].includes(extOf(path))
    return audio
      ? { path, kind: 'audio', sizeBytes: 10, durationSec: 10, hasAudio: true }
      : { path, kind: 'video', sizeBytes: 10, durationSec: 10, width: 1920, height: 1080, fps: 30, hasAudio: true }
  }

  async detectCapabilities(): Promise<EncoderCapabilities> {
    return fakeCaps
  }

  outputExtension(s: VideoPresetSettings): string {
    return s.container
  }

  computeOutputSize(info: MediaInfo, s: VideoPresetSettings): { width: number; height: number } | null {
    if (isAudioOnlyContainer(s.container) || !info.width || !info.height) return null
    return { width: s.video.width ?? info.width, height: s.video.height ?? info.height }
  }

  buildArgs(): { args: string[]; encoder: string } {
    return { args: [], encoder: 'libx264' }
  }

  async encode(req: VideoEncodeRequest): Promise<VideoEncodeResult> {
    this.encodes.push(req)
    if (req.overlay) this.overlayExisted.push(existsSync(req.overlay.pngPath))
    await writeFile(req.dest, 'PARTIAL')
    req.onProgress({ fraction: 0.5, elapsedSec: 1, speed: 2, fps: 60, etaSec: 1 })
    req.onLog?.('frame=1 fps=60')
    if (this.mode === 'manual') {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(abortError())
        if (req.signal.aborted) return onAbort()
        req.signal.addEventListener('abort', onAbort, { once: true })
        this.pending.push({ req, release: resolve, fail: reject })
      })
    }
    if (req.signal.aborted) throw abortError()
    if (this.failWith) throw this.failWith
    await writeFile(req.dest, `ENCODED ${req.source}`)
    req.onProgress({ fraction: 1, elapsedSec: 2 })
    return { encoder: 'libx264', args: [] }
  }

  async extractFrame(): Promise<Buffer> {
    return Buffer.from('JPEG')
  }

  async decodeImageToPng(): Promise<Buffer> {
    return Buffer.from('PNG')
  }

  releaseAll(): void {
    for (const p of this.pending.splice(0)) p.release()
  }
}

export class FakeImage implements ImageEngine {
  mode: 'instant' | 'manual' = 'instant'
  failWith: Error | null = null
  readonly processed: ImageProcessRequest[] = []
  readonly pending: Pending<ImageProcessRequest>[] = []
  readonly watermarkCalls: { frameW: number; frameH: number; vars?: { name?: string; date?: string } }[] = []
  result = { width: 400, height: 300 }
  /** EXIF taken times by file name (base name with extension); readTakenAt() answers from here. */
  takenAt: Record<string, number> = {}
  readonly takenReads: string[] = []

  async probe(path: string): Promise<MediaInfo> {
    const takenAt = this.takenAt[basename(path)]
    return {
      path,
      kind: 'image',
      sizeBytes: 10,
      width: 800,
      height: 600,
      hasAudio: false,
      format: extOf(path),
      ...(takenAt !== undefined ? { takenAt } : {}),
    }
  }

  async readTakenAt(path: string): Promise<number | undefined> {
    this.takenReads.push(path)
    return this.takenAt[basename(path)]
  }

  outputExtension(output: ImageOutputSettings, sourcePath: string): string {
    if (output.format === 'keep') return extOf(sourcePath)
    return output.format === 'jpeg' ? 'jpg' : output.format
  }

  async process(req: ImageProcessRequest): Promise<ImageProcessResult> {
    this.processed.push(req)
    await writeFile(req.dest, 'PARTIAL')
    if (this.mode === 'manual') {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(abortError())
        if (req.signal?.aborted) return onAbort()
        req.signal?.addEventListener('abort', onAbort, { once: true })
        this.pending.push({ req, release: resolve, fail: reject })
      })
    }
    if (this.failWith) throw this.failWith
    await writeFile(req.dest, `IMAGE ${req.source}`)
    return { ...this.result, bytes: 10, format: 'jpeg' }
  }

  async preview(): Promise<{ before: Buffer; beforeMime: string; after: Buffer; afterMime: string; outWidth: number; outHeight: number }> {
    return { before: Buffer.from('a'), beforeMime: 'image/jpeg', after: Buffer.from('b'), afterMime: 'image/jpeg', outWidth: 1, outHeight: 1 }
  }

  async thumbnail(): Promise<Buffer> {
    return Buffer.from('THUMB')
  }

  async renderWatermarkLayer(_wm: unknown, frameW: number, frameH: number, vars?: { name?: string; date?: string }): Promise<WatermarkLayer> {
    this.watermarkCalls.push({ frameW, frameH, vars })
    return { png: Buffer.from('PNGDATA'), left: 12, top: 34, width: 100, height: 50 }
  }

  async compositeWatermark(input: Buffer): Promise<Buffer> {
    return input
  }

  releaseAll(): void {
    for (const p of this.pending.splice(0)) p.release()
  }
}

export function fakeSettings(over: Partial<AppSettings> = {}): SettingsAccess & { value: AppSettings } {
  const s = {
    value: { ...defaultSettings(), imageConcurrency: 3, notifyOnFinish: true, ...over } as AppSettings,
    get: () => ({ ...s.value }),
    patch: (p: Partial<AppSettings>) => {
      s.value = { ...s.value, ...p }
      return { ...s.value }
    },
    locale: () => 'en' as const,
  }
  return s
}

export interface Harness {
  dir: string
  queue: Queue
  ffmpeg: FakeFfmpeg
  image: FakeImage
  settings: ReturnType<typeof fakeSettings>
  presets: PresetStore
  store: JsonStore<PersistedQueue>
  events: QueueEvent[]
  effects: {
    progress: (number | null)[]
    sleep: boolean[]
    notifications: { title: string; body: string }[]
  }
  wmDir: string
  journal: JsonStore<FileOpJournal>
}

export function makeHarness(
  dir: string,
  opts: {
    settings?: Partial<AppSettings>
    ffmpeg?: FakeFfmpeg
    image?: FakeImage
    storeFile?: string
    journalFile?: string
    fileOps?: Partial<FileOpsFs>
    fileConcurrency?: number
  } = {},
): Harness {
  const ffmpeg = opts.ffmpeg ?? new FakeFfmpeg()
  const image = opts.image ?? new FakeImage()
  const settings = fakeSettings(opts.settings)
  const presets = new PresetStore(new JsonStore<PresetFile>(join(dir, 'presets.json'), emptyPresetFile, { debounceMs: 5 }))
  const store = new JsonStore<PersistedQueue>(opts.storeFile ?? join(dir, 'queue.json'), emptyQueue, { debounceMs: 5 })
  const journal = new JsonStore<FileOpJournal>(opts.journalFile ?? join(dir, 'file-ops-journal.json'), emptyJournal, {
    debounceMs: 5,
    parse: parseJournal,
  })
  const events: QueueEvent[] = []
  const effectsLog = { progress: [] as (number | null)[], sleep: [] as boolean[], notifications: [] as { title: string; body: string }[] }
  const effects: QueueEffects = {
    onEvent: (e) => events.push(e),
    setProgress: (f) => effectsLog.progress.push(f),
    setPreventSleep: (on) => effectsLog.sleep.push(on),
    notify: (title, body) => effectsLog.notifications.push({ title, body }),
  }
  const wmDir = join(dir, '_wm')
  const queue = new Queue({
    ffmpeg,
    image,
    store,
    settings,
    presets,
    getCapabilities: async () => fakeCaps,
    effects,
    journal: journal as JournalStore,
    fileOps: opts.fileOps,
    fileConcurrency: opts.fileConcurrency,
    tmpDir: wmDir,
    progressIntervalMs: 20,
  })
  return { dir, queue, ffmpeg, image, settings, presets, store, events, effects: effectsLog, wmDir, journal }
}

export { EncodeError }

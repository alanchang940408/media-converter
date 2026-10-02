import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { t } from '../../src/main/i18n'
import { JsonStore } from '../../src/main/jsonStore'
import { emptyPresetFile, PresetStore, type PresetFile } from '../../src/main/presets/store'
import {
  emptyProcessedFile,
  emptyWatchFolderFile,
  WatchManager,
  type ProcessedFile,
  type WatchFolderFile,
  type WatchQueue,
} from '../../src/main/watch/WatchManager'
import type { AddJobsRequest, AddJobsResult, Job, WatchFolder } from '../../src/shared/types'
import { makeHarness, makeTempDir, sleep, touch, waitFor } from './helpers'

const AWF = { stabilityThreshold: 200, pollInterval: 50 }

class FakeQueue implements WatchQueue {
  readonly requests: AddJobsRequest[] = []
  readonly internals: ({ relativeDir?: string } | undefined)[] = []
  readonly jobs: Job[] = []
  private listeners = new Set<(job: Job) => void>()
  private seq = 0

  async addJobs(req: AddJobsRequest, internal?: { relativeDir?: string }): Promise<AddJobsResult> {
    this.requests.push(structuredClone(req))
    this.internals.push(internal ? { ...internal } : undefined)
    const job: Job = {
      id: `job-${++this.seq}`,
      kind: req.imagePresetId ? 'image' : 'video',
      source: req.paths[0],
      presetId: req.videoPresetId ?? req.imagePresetId ?? '',
      presetName: 'x',
      output: { dir: req.output?.dir ?? null, nameTemplate: '{name}', conflict: 'rename' },
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      watchFolderId: req.watchFolderId,
    }
    this.jobs.push(job)
    return { jobs: [structuredClone(job)], ignored: [] }
  }

  getJobs(): Job[] {
    return structuredClone(this.jobs)
  }

  onJobEnd(listener: (job: Job) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  finish(id: string, status: Job['status']): void {
    const job = this.jobs.find((j) => j.id === id)!
    job.status = status
    for (const l of this.listeners) l(structuredClone(job))
  }
}

let tmp: { dir: string; cleanup: () => void }
let watched: string
let managers: WatchManager[]

const stores = (dir: string) => ({
  folders: new JsonStore<WatchFolderFile>(join(dir, 'watch-folders.json'), emptyWatchFolderFile, { debounceMs: 5 }),
  processed: new JsonStore<ProcessedFile>(join(dir, 'watch-processed.json'), emptyProcessedFile, { debounceMs: 5 }),
  presets: new PresetStore(new JsonStore<PresetFile>(join(dir, 'presets.json'), emptyPresetFile)),
})

function makeManager(queue: WatchQueue, dir = tmp.dir): WatchManager {
  const s = stores(dir)
  const m = new WatchManager({ queue, presets: s.presets, folders: s.folders, processed: s.processed, awaitWriteFinish: AWF })
  managers.push(m)
  return m
}

const folder = (over: Partial<WatchFolder> = {}): WatchFolder => ({
  id: '',
  path: watched,
  enabled: true,
  presetIds: ['h264-match', 'audio-mp3-192', 'img-png'],
  outputDir: null,
  includeSubfolders: false,
  afterProcess: 'keep',
  processExisting: false,
  ...over,
})

beforeEach(() => {
  tmp = makeTempDir('mc-watch-')
  watched = join(tmp.dir, 'watch me 監看')
  mkdirSync(watched, { recursive: true })
  managers = []
})

afterEach(async () => {
  for (const m of managers) await m.close()
  tmp.cleanup()
})

describe('WatchManager', () => {
  it('validates folders on save', async () => {
    const m = makeManager(new FakeQueue())
    await m.start()
    await expect(m.save(folder({ path: join(tmp.dir, 'missing') }))).rejects.toThrow()
    await expect(m.save(folder({ outputDir: watched }))).rejects.toThrow()
    const saved = await m.save(folder())
    expect(saved.id).toBeTruthy()
    expect(m.list()).toHaveLength(1)
    expect(existsSync(join(watched, 'Output'))).toBe(true)
  })

  it('queues new files with every matching preset, into <folder>/Output', async () => {
    const q = new FakeQueue()
    const m = makeManager(q)
    await m.start()
    const f = await m.save(folder())
    await m.whenReady()

    touch(join(watched, 'clip.mp4'))
    touch(join(watched, 'photo.jpg'))
    await waitFor(() => q.requests.length === 3, 8000, '3 addJobs calls')
    await m.idle()
    const video = q.requests.filter((r) => r.paths[0].endsWith('clip.mp4'))
    expect(video.map((r) => r.videoPresetId).sort()).toEqual(['audio-mp3-192', 'h264-match'])
    const image = q.requests.filter((r) => r.paths[0].endsWith('photo.jpg'))
    expect(image.map((r) => r.imagePresetId)).toEqual(['img-png'])
    for (const r of q.requests) {
      expect(r.watchFolderId).toBe(f.id)
      expect(r.output?.dir).toBe(join(watched, 'Output'))
      expect(r.output?.preserveStructure).toBe(true)
    }
    expect(q.internals.every((i) => i?.relativeDir === '')).toBe(true)
  })

  it('ignores the output folder, Source, temp files, unsupported files and subfolders (depth 0)', async () => {
    const q = new FakeQueue()
    const m = makeManager(q)
    await m.start()
    await m.save(folder({ afterProcess: 'move' }))
    await m.whenReady()
    mkdirSync(join(watched, 'Source'), { recursive: true })
    mkdirSync(join(watched, 'nested'), { recursive: true })
    touch(join(watched, 'Output', 'encoded.mp4'))
    touch(join(watched, 'Source', 'old.mp4'))
    touch(join(watched, 'nested', 'deep.mp4'))
    touch(join(watched, 'partial.mp4.mcpart'))
    touch(join(watched, 'readme.txt'))
    touch(join(watched, '.hidden.mp4'))
    await sleep(1200)
    await m.idle()
    expect(q.requests).toHaveLength(0)
    // a real file still works
    touch(join(watched, 'real.mov'))
    await waitFor(() => q.requests.length === 2, 8000, 'real file')
  })

  it('includeSubfolders passes the folder relative to the watch folder and keeps the structure', async () => {
    const q = new FakeQueue()
    const out = join(tmp.dir, 'custom out')
    const m = makeManager(q)
    await m.start()
    await m.save(folder({ includeSubfolders: true, outputDir: out, presetIds: ['img-png'] }))
    await m.whenReady()
    mkdirSync(join(watched, 'day 1', '下午'), { recursive: true })
    touch(join(watched, 'day 1', '下午', 'a.png'))
    await waitFor(() => q.requests.length === 1, 8000, 'nested file')
    expect(q.requests[0].output).toMatchObject({ dir: out, preserveStructure: true })
    expect(q.internals[0]).toEqual({ relativeDir: join('day 1', '下午') })
  })

  it('rejects rename / copy / move presets', async () => {
    const m = makeManager(new FakeQueue())
    await m.start()
    await expect(m.save(folder({ presetIds: ['h264-match', 'file-copy-rename'] }))).rejects.toThrow(t('error.filePresetInWatch'))
    expect(m.list()).toHaveLength(0)
  })

  it('real queue: nested files land in the same subfolder below Output', async () => {
    const h = makeHarness(tmp.dir)
    const s = stores(tmp.dir)
    const m = new WatchManager({ queue: h.queue, presets: h.presets, folders: s.folders, processed: s.processed, awaitWriteFinish: AWF })
    managers.push(m)
    await m.start()
    await m.save(folder({ includeSubfolders: true, presetIds: ['img-png'] }))
    await m.whenReady()
    mkdirSync(join(watched, 'trip 旅行', 'day 2'), { recursive: true })
    touch(join(watched, 'trip 旅行', 'day 2', 'pic.jpg'))
    touch(join(watched, 'top.jpg'))
    const nested = join(watched, 'Output', 'trip 旅行', 'day 2', 'pic.png')
    await waitFor(() => existsSync(nested) && existsSync(join(watched, 'Output', 'top.png')), 10000, 'outputs')
    const jobs = h.queue.getJobs()
    expect(jobs.find((j) => j.source.endsWith('pic.jpg'))).toMatchObject({
      relativeDir: join('trip 旅行', 'day 2'),
      output: { dir: join(watched, 'Output'), preserveStructure: true },
      outputPath: nested,
    })
    expect(jobs.find((j) => j.source.endsWith('top.jpg'))?.relativeDir).toBe('')
    await m.close()
    await h.queue.shutdown()
  })

  it('tracks processed files so a restart never reprocesses them', async () => {
    touch(join(watched, 'existing.mp4'))
    const q1 = new FakeQueue()
    const m1 = makeManager(q1)
    await m1.start()
    await m1.save(folder({ processExisting: true, presetIds: ['h264-match'] }))
    await waitFor(() => q1.requests.length === 1, 8000, 'existing file processed')
    await m1.idle()
    await m1.close()
    const processed = JSON.parse(readFileSync(join(tmp.dir, 'watch-processed.json'), 'utf8')) as ProcessedFile
    expect(Object.keys(processed.entries)).toHaveLength(1)

    // "restart": new manager, same userData files
    const q2 = new FakeQueue()
    const m2 = makeManager(q2)
    await m2.start()
    await m2.whenReady()
    await sleep(1000)
    await m2.idle()
    expect(q2.requests).toHaveLength(0)
    touch(join(watched, 'new.mp4'))
    await waitFor(() => q2.requests.length === 1, 8000, 'new file after restart')
    expect(q2.requests[0].paths[0].endsWith('new.mp4')).toBe(true)
  })

  it('moves the source into <folder>/Source only after all its jobs succeeded', async () => {
    const q = new FakeQueue()
    const m = makeManager(q)
    await m.start()
    await m.save(folder({ afterProcess: 'move', presetIds: ['h264-match', 'audio-mp3-192'] }))
    await m.whenReady()
    const file = touch(join(watched, 'take 1.mp4'))
    await waitFor(() => q.requests.length === 2, 8000, 'jobs added')
    await m.idle()
    q.finish(q.jobs[0].id, 'done')
    await m.idle()
    expect(existsSync(file)).toBe(true)
    q.finish(q.jobs[1].id, 'failed')
    await m.idle()
    expect(existsSync(file)).toBe(true)
    // retry succeeded
    q.finish(q.jobs[1].id, 'done')
    await waitFor(() => !existsSync(file), 5000, 'move to Source')
    await m.idle()
    expect(existsSync(join(watched, 'Source', 'take 1.mp4'))).toBe(true)
    // the moved file is not picked up again
    await sleep(800)
    expect(q.requests).toHaveLength(2)
  })

  it('works end-to-end with the real queue (fake engines)', async () => {
    const h = makeHarness(tmp.dir)
    const s = stores(tmp.dir)
    const m = new WatchManager({ queue: h.queue, presets: h.presets, folders: s.folders, processed: s.processed, awaitWriteFinish: AWF })
    managers.push(m)
    await m.start()
    await m.save(folder({ afterProcess: 'move', presetIds: ['h264-match', 'img-png'] }))
    await m.whenReady()
    touch(join(watched, 'clip.mp4'))
    touch(join(watched, 'pic.jpg'))
    await waitFor(() => existsSync(join(watched, 'Source', 'clip.mp4')) && existsSync(join(watched, 'Source', 'pic.jpg')), 10000, 'sources moved')
    expect(existsSync(join(watched, 'Output', 'clip.mp4'))).toBe(true)
    expect(existsSync(join(watched, 'Output', 'pic.png'))).toBe(true)
    expect(h.queue.getJobs().every((j) => j.status === 'done' && j.watchFolderId)).toBe(true)
    await m.close()
    await h.queue.shutdown()
  })

  it('stops watching when a folder is disabled or deleted', async () => {
    const q = new FakeQueue()
    const m = makeManager(q)
    await m.start()
    const f = await m.save(folder({ presetIds: ['img-png'] }))
    await m.whenReady()
    await m.save({ ...f, enabled: false })
    touch(join(watched, 'a.png'))
    await sleep(800)
    expect(q.requests).toHaveLength(0)
    await m.save({ ...f, enabled: true })
    await m.whenReady()
    touch(join(watched, 'b.png'))
    await waitFor(() => q.requests.length === 1, 8000, 'b.png')
    await m.delete(f.id)
    expect(m.list()).toHaveLength(0)
    touch(join(watched, 'c.png'))
    await sleep(800)
    expect(q.requests).toHaveLength(1)
  })

  it('an output folder above the watch folder does not hide it, and outputs never land back inside it', async () => {
    const q = new FakeQueue()
    const m = makeManager(q)
    await m.start()
    // watch <tmp>/watch me 監看, output <tmp>: a subfolder named like the watch folder would map back into it
    await m.save(folder({ outputDir: tmp.dir, includeSubfolders: true, presetIds: ['img-png'] }))
    await m.whenReady()
    touch(join(watched, 'top.png'))
    await waitFor(() => q.requests.length === 1, 8000, 'file directly in the watch folder')
    expect(q.requests[0].output).toMatchObject({ dir: tmp.dir, preserveStructure: true })
    expect(q.internals[0]).toEqual({ relativeDir: '' })
    const mirror = join(watched, 'watch me 監看', 'day')
    mkdirSync(mirror, { recursive: true })
    touch(join(mirror, 'deep.png'))
    await waitFor(() => q.requests.length === 2, 8000, 'nested file')
    // <tmp>/watch me 監看/day would be inside the watch folder → flattened into the output folder
    expect(q.internals[1]).toEqual({ relativeDir: '' })
    mkdirSync(join(watched, 'other'), { recursive: true })
    touch(join(watched, 'other', 'x.png'))
    await waitFor(() => q.requests.length === 3, 8000, 'other nested file')
    expect(q.internals[2]).toEqual({ relativeDir: 'other' })
  })
})

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../../src/main/jsonStore'
import { computeOutputSize } from '../../src/main/ffmpeg/args'
import { emptyQueue, type PersistedQueue } from '../../src/main/queue/Queue'
import type { Job, QueueEvent, VideoPreset } from '../../src/shared/types'
import { EncodeError, makeHarness, makeTempDir, touch, waitFor, type Harness } from './helpers'

let tmp: { dir: string; cleanup: () => void }
let h: Harness
let src: string
let out: string

beforeEach(() => {
  tmp = makeTempDir()
  src = join(tmp.dir, 'src folder 素材')
  out = join(tmp.dir, 'out')
  mkdirSync(src, { recursive: true })
  mkdirSync(out, { recursive: true })
})

afterEach(async () => {
  await h?.queue.shutdown()
  tmp.cleanup()
})

const job = (id: string): Job => h.queue.getJobs().find((j) => j.id === id)!
const statuses = (): string[] => h.queue.getJobs().map((j) => j.status)
const allSettled = (): boolean => h.queue.getJobs().every((j) => ['done', 'failed', 'cancelled', 'skipped'].includes(j.status))

describe('adding jobs', () => {
  it('classifies files, expands folders and applies presets per kind', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'clip.mp4'))
    touch(join(src, 'song.mp3'))
    touch(join(src, 'photo.jpg'))
    touch(join(src, 'notes.txt'))
    mkdirSync(join(src, 'sub'))
    touch(join(src, 'sub', 'deep.mov'))

    const flat = await h.queue.addJobs({ paths: [src] })
    expect(flat.jobs.map((j) => j.source.split(/[\\/]/).pop())).toEqual(['clip.mp4', 'photo.jpg', 'song.mp3'])
    expect(flat.ignored.some((p) => p.endsWith('notes.txt'))).toBe(true)
    const byName = Object.fromEntries(flat.jobs.map((j) => [j.source.split(/[\\/]/).pop(), j]))
    expect(byName['clip.mp4'].kind).toBe('video')
    expect(byName['clip.mp4'].presetId).toBe('h264-match')
    expect(byName['song.mp3'].kind).toBe('video')
    expect(byName['photo.jpg'].kind).toBe('image')
    expect(byName['photo.jpg'].presetId).toBe('img-jpeg-q90')
    expect(byName['clip.mp4'].presetName).toBe('H.264 MP4 (match source)')

    const rec = await h.queue.addJobs({ paths: [src], recursive: true, videoPresetId: 'hevc-match' })
    expect(rec.jobs.some((j) => j.source.endsWith('deep.mov'))).toBe(true)
    expect(rec.jobs.filter((j) => j.kind === 'video').every((j) => j.presetId === 'hevc-match')).toBe(true)
    // remembered for next time
    expect(h.settings.value.lastVideoPresetId).toBe('hevc-match')
    // settings are deep copies of the preset
    const preset = h.presets.get('hevc-match') as VideoPreset
    const j = rec.jobs.find((x) => x.kind === 'video')!
    expect(j.video!.settings).toEqual(preset.settings)
    expect(j.video!.settings).not.toBe(preset.settings)
    // probed asynchronously
    await waitFor(() => h.queue.getJobs().every((x) => x.sourceInfo), 2000, 'probe')
  })

  it('rejects unknown or kind-mismatched presets and ignores missing paths', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    await expect(h.queue.addJobs({ paths: [join(src, 'a.mp4')], videoPresetId: 'nope' })).rejects.toThrow(/nope/)
    await expect(h.queue.addJobs({ paths: [join(src, 'a.mp4')], videoPresetId: 'img-png' })).rejects.toThrow()
    const r = await h.queue.addJobs({ paths: [join(src, 'missing.mp4')] })
    expect(r.jobs).toHaveLength(0)
    expect(r.ignored).toHaveLength(1)
  })

  it('auto-starts when settings.autoStart is on', async () => {
    h = makeHarness(tmp.dir, { settings: { autoStart: true } })
    touch(join(src, 'a.mp4'))
    await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(statuses()).toEqual(['done'])
  })
})

describe('output naming and conflicts', () => {
  it('renders the template with counter/preset tokens and renames on conflict', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    touch(join(out, 'a.mp4'), 'EXISTING')
    await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    await h.queue.addJobs({
      paths: [join(src, 'a.mp4'), join(src, 'b.mp4')],
      output: { dir: out, nameTemplate: '{name}_{counter:3}_{width}x{height}' },
    })
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    const names = h.queue.getJobs().map((j) => j.outputPath!.split(/[\\/]/).pop())
    expect(names).toEqual(['a (1).mp4', 'a_001_1920x1080.mp4', 'b_002_1920x1080.mp4'])
    expect(readFileSync(join(out, 'a.mp4'), 'utf8')).toBe('EXISTING')
  })

  it('skip policy marks the job skipped without encoding', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    touch(join(out, 'a.mp4'), 'EXISTING')
    await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out, conflict: 'skip' } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(statuses()).toEqual(['skipped'])
    expect(h.ffmpeg.encodes).toHaveLength(0)
    expect(readFileSync(join(out, 'a.mp4'), 'utf8')).toBe('EXISTING')
  })

  it('overwrite policy replaces the existing file', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    touch(join(out, 'a.mp4'), 'EXISTING')
    await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out, conflict: 'overwrite' } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(statuses()).toEqual(['done'])
    expect(readFileSync(join(out, 'a.mp4'), 'utf8')).toMatch(/^ENCODED/)
    expect(readdirSync(out).sort()).toEqual(['a.mp4'])
  })

  it('never writes onto the source file, whatever the policy', async () => {
    h = makeHarness(tmp.dir)
    const source = touch(join(src, 'same.mp4'), 'ORIGINAL')
    for (const conflict of ['overwrite', 'skip', 'rename'] as const) {
      await h.queue.addJobs({ paths: [source], videoPresetId: 'remux-mp4', output: { dir: null, conflict } })
    }
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(readFileSync(source, 'utf8')).toBe('ORIGINAL')
    const outs = h.queue.getJobs().map((j) => j.outputPath!.split(/[\\/]/).pop())
    expect(outs).toEqual(['same (1).mp4', 'same (2).mp4', 'same (3).mp4'])
    expect(statuses()).toEqual(['done', 'done', 'done'])
  })

  it('reserves output paths across concurrently running jobs', async () => {
    h = makeHarness(tmp.dir, { settings: { videoConcurrency: 3 } })
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    touch(join(src, 'c.mp4'))
    await h.queue.addJobs({
      paths: [join(src, 'a.mp4'), join(src, 'b.mp4'), join(src, 'c.mp4')],
      output: { dir: out, nameTemplate: 'render', conflict: 'overwrite' },
    })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 3, 3000, '3 concurrent encodes')
    const dests = h.ffmpeg.pending.map((p) => p.req.dest.split(/[\\/]/).pop()).sort()
    expect(dests).toEqual(['render (1).mp4.mcpart', 'render (2).mp4.mcpart', 'render.mp4.mcpart'])
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(readdirSync(out).sort()).toEqual(['render (1).mp4', 'render (2).mp4', 'render.mp4'])
  })

  it('uses the processed image size for {width}/{height} in image jobs', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'p.png'))
    await h.queue.addJobs({ paths: [join(src, 'p.png')], output: { dir: out, nameTemplate: '{name}-{width}x{height}' } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    expect(readdirSync(out)).toEqual(['p-400x300.jpg'])
  })
})

describe('job execution', () => {
  it('writes to a .mcpart temp file and renames it on success', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: join(out, 'new sub') } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode start')
    const dest = h.ffmpeg.pending[0].req.dest
    expect(dest).toBe(join(out, 'new sub', 'a.mp4.mcpart'))
    expect(existsSync(dest)).toBe(true)
    expect(job(jobs[0].id).status).toBe('running')
    expect(h.effects.sleep.at(-1)).toBe(true)
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'job to finish')
    const j = job(jobs[0].id)
    expect(j.status).toBe('done')
    expect(j.progress).toBe(1)
    expect(j.encoder).toBe('libx264')
    expect(j.outputSizeBytes).toBeGreaterThan(0)
    expect(j.startedAt).toBeTypeOf('number')
    expect(j.finishedAt).toBeTypeOf('number')
    expect(existsSync(dest)).toBe(false)
    expect(readFileSync(join(out, 'new sub', 'a.mp4'), 'utf8')).toMatch(/^ENCODED/)
    // run finished: event, notification, taskbar cleared, sleep blocker released
    const finished = h.events.filter((e): e is Extract<QueueEvent, { type: 'finished' }> => e.type === 'finished')
    expect(finished.at(-1)!.summary).toEqual({ done: 1, failed: 0, cancelled: 0, skipped: 0 })
    expect(h.effects.notifications).toHaveLength(1)
    expect(h.effects.notifications[0].title).toBe('Queue finished')
    expect(h.effects.progress.at(-1)).toBeNull()
    expect(h.effects.sleep.at(-1)).toBe(false)
    expect(h.queue.isRunning()).toBe(false)
  })

  it('emits throttled progress events', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.events.some((e) => e.type === 'progress'), 3000, 'progress event')
    const ev = h.events.find((e) => e.type === 'progress') as Extract<QueueEvent, { type: 'progress' }>
    expect(ev.items[0]).toMatchObject({ id: jobs[0].id, progress: 0.5, speed: 2, fps: 60 })
    expect(h.effects.progress.some((p) => p !== null && p > 0 && p < 1)).toBe(true)
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'job to finish')
  })

  it('failure records the error message + log tail and deletes the temp file', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.failWith = new EncodeError('Invalid data found when processing input', ['line 1', 'line 2'], 1)
    touch(join(src, 'a.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to fail')
    const j = job(jobs[0].id)
    expect(j.status).toBe('failed')
    expect(j.error).toBe('Invalid data found when processing input')
    expect(j.logTail).toEqual(['line 1', 'line 2'])
    expect(j.outputPath).toBeUndefined()
    expect(readdirSync(out)).toEqual([])
  })

  it('fails with a clear message when the source disappeared', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'gone.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [p], output: { dir: out } })
    const { rmSync } = await import('node:fs')
    rmSync(p)
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to fail')
    expect(job(jobs[0].id).error).toMatch(/Source file not found/)
  })

  it('retry re-queues failed jobs and they can succeed', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.failWith = new Error('boom')
    touch(join(src, 'a.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to fail')
    expect(job(jobs[0].id).status).toBe('failed')
    h.ffmpeg.failWith = null
    h.queue.retryJobs([jobs[0].id])
    expect(job(jobs[0].id).status).toBe('queued')
    expect(job(jobs[0].id).error).toBeUndefined()
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to finish')
    expect(job(jobs[0].id).status).toBe('done')
  })

  it('stop aborts running jobs: back to queued, progress 0, temp deleted', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4'), join(src, 'b.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode start')
    const dest = h.ffmpeg.pending[0].req.dest
    expect(existsSync(dest)).toBe(true)
    await h.queue.stop()
    expect(h.queue.isRunning()).toBe(false)
    expect(statuses()).toEqual(['queued', 'queued'])
    expect(job(jobs[0].id).progress).toBe(0)
    expect(job(jobs[0].id).outputPath).toBeUndefined()
    expect(existsSync(dest)).toBe(false)
    expect(h.ffmpeg.pending[0].req.signal.aborted).toBe(true)
    expect(h.effects.sleep.at(-1)).toBe(false)
    expect(h.effects.progress.at(-1)).toBeNull()
    // no "finished" for a stop
    expect(h.events.some((e) => e.type === 'finished')).toBe(false)
  })

  it('cancel marks running and queued jobs cancelled and deletes the temp file', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    touch(join(src, 'c.mp4'))
    const { jobs } = await h.queue.addJobs({
      paths: [join(src, 'a.mp4'), join(src, 'b.mp4'), join(src, 'c.mp4')],
      output: { dir: out },
    })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode start')
    const dest = h.ffmpeg.pending[0].req.dest
    await h.queue.cancelJobs([jobs[0].id, jobs[1].id])
    expect(job(jobs[0].id).status).toBe('cancelled')
    expect(job(jobs[1].id).status).toBe('cancelled')
    expect(existsSync(dest)).toBe(false)
    // the queue moves on to the remaining job
    await waitFor(() => h.ffmpeg.pending.length === 2, 3000, 'next encode')
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'jobs to settle')
    expect(statuses()).toEqual(['cancelled', 'cancelled', 'done'])
    const finished = h.events.filter((e): e is Extract<QueueEvent, { type: 'finished' }> => e.type === 'finished')
    expect(finished.at(-1)!.summary).toEqual({ done: 1, failed: 0, cancelled: 2, skipped: 0 })
    expect(readdirSync(out)).toEqual(['c.mp4'])
  })

  it('runs separate concurrency pools for video (1) and images (3)', async () => {
    h = makeHarness(tmp.dir, { settings: { videoConcurrency: 1, imageConcurrency: 3 } })
    h.ffmpeg.mode = 'manual'
    h.image.mode = 'manual'
    const paths = ['v1.mp4', 'v2.mp4', 'v3.mp4', 'i1.jpg', 'i2.jpg', 'i3.jpg', 'i4.jpg', 'i5.jpg'].map((n) => touch(join(src, n)))
    await h.queue.addJobs({ paths, output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1 && h.image.pending.length === 3, 3000, 'pools to fill')
    const running = (): Job[] => h.queue.getJobs().filter((j) => j.status === 'running')
    expect(running().filter((j) => j.kind === 'video')).toHaveLength(1)
    expect(running().filter((j) => j.kind === 'image')).toHaveLength(3)
    // FIFO: the first images in queue order are the ones running
    const names = (jobs: Job[]): (string | undefined)[] => jobs.map((j) => j.source.split(/[\\/]/).pop())
    expect(names(running().filter((j) => j.kind === 'image'))).toEqual(['i1.jpg', 'i2.jpg', 'i3.jpg'])
    expect(names(running().filter((j) => j.kind === 'video'))).toEqual(['v1.mp4'])
    h.image.pending.shift()!.release()
    await waitFor(() => h.image.processed.length === 4, 3000, 'next image')
    expect(running().filter((j) => j.kind === 'image')).toHaveLength(3)
    expect(running().filter((j) => j.kind === 'video')).toHaveLength(1)
    // drain everything
    while (!allSettled()) {
      h.ffmpeg.releaseAll()
      h.image.releaseAll()
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(statuses().every((s) => s === 'done')).toBe(true)
  })

  it('passes a rendered watermark overlay PNG to the engine and cleans it up', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'clip.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], output: { dir: out } })
    const settings = structuredClone(jobs[0].video!.settings)
    settings.video.width = 1280
    settings.video.height = 720
    settings.watermark = {
      type: 'text',
      text: '{name} {date}',
      anchor: 'bottom-right',
      marginPct: 3,
      opacity: 0.8,
      fontSizePct: 5,
      color: '#ffffff',
    }
    h.queue.updateJob(jobs[0].id, { video: { settings } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode start')
    const req = h.ffmpeg.pending[0].req
    expect(req.overlay).toBeTruthy()
    expect(req.overlay!.left).toBe(12)
    expect(req.overlay!.top).toBe(34)
    expect(req.overlay!.pngPath).toBe(join(h.wmDir, `${jobs[0].id}.png`))
    expect(h.ffmpeg.overlayExisted).toEqual([true])
    expect(readFileSync(req.overlay!.pngPath, 'utf8')).toBe('PNGDATA')
    expect(h.image.watermarkCalls[0]).toMatchObject({ frameW: 1280, frameH: 720, vars: { name: 'clip' } })
    expect(req.caps.ffmpegVersion).toBe('fake')
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'job to finish')
    // the PNG is removed in execute()'s `finally`, i.e. just after the job was settled as done: wait for it
    // instead of checking once (a single check right after "done" raced the async rm under load)
    await waitFor(() => !existsSync(req.overlay!.pngPath), 3000, 'overlay PNG cleanup')
    expect(existsSync(req.overlay!.pngPath)).toBe(false)
  })

  it('DVD output (non-square pixels): the watermark is rendered for the displayed frame', async () => {
    h = makeHarness(tmp.dir)
    // what the real engine reports for DVD-Video NTSC 16:9
    h.ffmpeg.computeOutputSize = () => ({ width: 720, height: 480, sar: 32 / 27 })
    touch(join(src, 'clip.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], videoPresetId: 'mpeg2-dvd-ntsc', output: { dir: out } })
    const settings = structuredClone(jobs[0].video!.settings)
    settings.watermark = { type: 'image', path: 'C:/logo.png', anchor: 'top-left', marginPct: 2, opacity: 1, scalePct: 10 }
    h.queue.updateJob(jobs[0].id, { video: { settings } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to finish')
    expect(h.image.watermarkCalls).toHaveLength(1)
    expect(h.image.watermarkCalls[0]).toMatchObject({ frameW: 720, frameH: 480, opts: { sampleAspect: 32 / 27 } })
    expect(h.ffmpeg.encodes[0].overlay).toMatchObject({ left: 12, top: 34 })
  })

  it('square-pixel outputs render the watermark without a pixel aspect', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'clip.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], output: { dir: out } })
    const settings = structuredClone(jobs[0].video!.settings)
    settings.watermark = { type: 'image', path: 'C:/logo.png', anchor: 'top-left', marginPct: 2, opacity: 1, scalePct: 10 }
    h.queue.updateJob(jobs[0].id, { video: { settings } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to finish')
    expect(h.image.watermarkCalls).toHaveLength(1)
    expect(h.image.watermarkCalls[0].opts).toBeUndefined()
  })

  it('anamorphic source (HDV 1440×1080 at 4:3): the watermark is laid out on the displayed 1920×1080 frame', async () => {
    h = makeHarness(tmp.dir)
    const real = h.ffmpeg.probe.bind(h.ffmpeg)
    h.ffmpeg.probe = async (p: string) => ({ ...(await real(p)), width: 1920, height: 1080, storageWidth: 1440, storageHeight: 1080, sampleAspectRatio: 4 / 3 })
    h.ffmpeg.computeOutputSize = computeOutputSize
    touch(join(src, 'hdv.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'hdv.mp4')], output: { dir: out } })
    const settings = structuredClone(jobs[0].video!.settings)
    settings.watermark = { type: 'image', path: 'C:/logo.png', anchor: 'top-left', marginPct: 2, opacity: 1, scalePct: 10 }
    h.queue.updateJob(jobs[0].id, { video: { settings } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to finish')
    expect(h.image.watermarkCalls).toHaveLength(1)
    expect(h.image.watermarkCalls[0]).toMatchObject({ frameW: 1920, frameH: 1080 })
    expect(h.image.watermarkCalls[0].opts).toBeUndefined()
  })

  it('does not render a watermark for stream copy', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'clip.mp4'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], videoPresetId: 'remux-mp4', output: { dir: out } })
    const settings = structuredClone(jobs[0].video!.settings)
    settings.watermark = { type: 'image', path: 'C:/logo.png', anchor: 'top-left', marginPct: 2, opacity: 1, scalePct: 10 }
    h.queue.updateJob(jobs[0].id, { video: { settings } })
    h.queue.start()
    await waitFor(allSettled, 3000, 'job to finish')
    expect(h.ffmpeg.encodes[0].overlay).toBeNull()
    expect(h.image.watermarkCalls).toHaveLength(0)
  })

  it('removeFinished drops done jobs automatically', async () => {
    h = makeHarness(tmp.dir, { settings: { removeFinished: true } })
    touch(join(src, 'a.mp4'))
    h.ffmpeg.failWith = null
    await h.queue.addJobs({ paths: [join(src, 'a.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.queue.getJobs().length === 0, 3000, 'job removal')
    expect(existsSync(join(out, 'a.mp4'))).toBe(true)
  })
})

describe('editing the queue', () => {
  it('update/applyPreset/duplicate/reorder/remove/clearFinished', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    touch(join(src, 'c.jpg'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4'), join(src, 'b.mp4'), join(src, 'c.jpg')] })
    const [a, b, c] = jobs

    // applyPreset only touches kind-compatible jobs
    h.queue.applyPreset([a.id, c.id], 'audio-mp3-320')
    expect(job(a.id).presetId).toBe('audio-mp3-320')
    expect(job(a.id).video!.settings.container).toBe('mp3')
    expect(job(c.id).presetId).toBe('img-jpeg-q90')

    // updateJob with presetId alone applies that preset
    const updated = h.queue.updateJob(b.id, { presetId: 'gif-480', output: { nameTemplate: '{name}_gif', dir: out } })
    expect(updated.video!.settings.container).toBe('gif')
    expect(updated.output).toMatchObject({ dir: out, nameTemplate: '{name}_gif' })
    expect(() => h.queue.updateJob(b.id, { presetId: 'img-png' })).toThrow()

    h.queue.duplicateJobs([a.id])
    let ids = h.queue.getJobs().map((j) => j.id)
    expect(ids).toHaveLength(4)
    expect(ids[0]).toBe(a.id)
    const dup = h.queue.getJobs()[1]
    expect(dup.source).toBe(a.source)
    expect(dup.presetId).toBe('audio-mp3-320')
    expect(dup.id).not.toBe(a.id)

    h.queue.reorderJobs([c.id, b.id])
    ids = h.queue.getJobs().map((j) => j.id)
    expect(ids).toEqual([c.id, b.id, a.id, dup.id])

    // running jobs cannot be edited; removing one aborts it
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode start')
    const runningId = h.queue.getJobs().find((j) => j.status === 'running' && j.kind === 'video')!.id
    expect(() => h.queue.updateJob(runningId, { output: { nameTemplate: 'x' } })).toThrow(/running/)
    const dest = h.ffmpeg.pending[0].req.dest
    await h.queue.removeJobs([runningId])
    expect(h.queue.getJobs().some((j) => j.id === runningId)).toBe(false)
    expect(existsSync(dest)).toBe(false)

    await h.queue.stop()
    h.ffmpeg.mode = 'instant'
    h.queue.start()
    await waitFor(allSettled, 3000, 'jobs to finish')
    h.queue.clearFinished()
    expect(h.queue.getJobs()).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('restored jobs saved with the stored size of an anamorphic source get the displayed size', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'dv.avi'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'dv.avi')], output: { dir: out } })
    await waitFor(() => !!job(jobs[0].id).sourceInfo, 3000, 'probe')
    await h.store.flush()
    const file = join(tmp.dir, 'queue.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as PersistedQueue
    // the shape written before MediaInfo had storageWidth: stored size + pixel aspect
    saved.jobs[0].sourceInfo = { ...saved.jobs[0].sourceInfo!, width: 720, height: 480, sampleAspectRatio: 8 / 9 }
    writeFileSync(file, JSON.stringify(saved))
    const h2 = makeHarness(tmp.dir, { storeFile: file })
    expect(h2.queue.getJobs()[0].sourceInfo).toMatchObject({ width: 640, height: 480, storageWidth: 720, storageHeight: 480 })
  })

  it('persists the queue and restores running jobs as queued', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.jpg'))
    const { jobs } = await h.queue.addJobs({ paths: [join(src, 'a.mp4'), join(src, 'b.jpg')], output: { dir: out, nameTemplate: '{name}_x' } })
    await h.store.flush()
    const file = join(tmp.dir, 'queue.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as PersistedQueue
    expect(saved.jobs.map((j) => j.id)).toEqual(jobs.map((j) => j.id))
    // simulate a crash mid-encode
    saved.jobs[0].status = 'running'
    saved.jobs[0].progress = 0.4
    saved.jobs[0].outputPath = join(out, 'a_x.mp4')
    writeFileSync(join(out, 'a_x.mp4.mcpart'), 'stale')
    writeFileSync(file, JSON.stringify(saved))

    const h2 = makeHarness(tmp.dir, { storeFile: file })
    await h2.queue.init()
    const restored = h2.queue.getJobs()
    expect(restored.map((j) => j.id)).toEqual(jobs.map((j) => j.id))
    expect(restored[0].status).toBe('queued')
    expect(restored[0].progress).toBe(0)
    expect(restored[0].outputPath).toBeUndefined()
    expect(restored[0].output.nameTemplate).toBe('{name}_x')
    expect(existsSync(join(out, 'a_x.mp4.mcpart'))).toBe(false)
    expect(h2.queue.isRunning()).toBe(false)
    // counter metadata survives too
    h2.queue.start()
    await waitFor(() => h2.queue.getJobs().every((j) => j.status === 'done'), 3000, 'restored jobs to finish')
    expect(readdirSync(out).sort()).toEqual(['a_x.mp4', 'b_x.jpg'])
    await h2.queue.shutdown()
  })

  it('loads a corrupt queue file as empty', () => {
    const file = join(tmp.dir, 'queue.json')
    writeFileSync(file, '{not json')
    const store = new JsonStore<PersistedQueue>(file, emptyQueue)
    expect(store.get().jobs).toEqual([])
    h = makeHarness(tmp.dir, { storeFile: join(tmp.dir, 'other.json') })
  })
})

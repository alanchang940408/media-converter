// Adobe panel bridge, Media Converter side: info.json, inbox requests → jobs → results, deleteAfter safety.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeService, collidingOutputs, emptyBridgeState, parseBridgeState, type BridgeState } from '../../src/main/bridge/BridgeService'
import { bridgePresets, videoPresetSummary } from '../../src/main/bridge/summary'
import { outputExtension } from '../../src/main/ffmpeg/args'
import { t } from '../../src/main/i18n'
import { JsonStore } from '../../src/main/jsonStore'
import { getBuiltinPreset } from '../../src/main/presets/builtin'
import { BRIDGE_VERSION, type BridgeInfo, type BridgeOutput, type BridgeRequest, type BridgeResult } from '../../src/shared/bridge'
import type { BridgeRequestEvent, Job, Locale, VideoPreset } from '../../src/shared/types'
import { makeHarness, makeTempDir, sleep, touch, waitFor, type Harness } from './helpers'

let tmp: { dir: string; cleanup: () => void }
let h: Harness
let bridges: BridgeService[]
let events: BridgeRequestEvent[]
let src: string
let out: string

beforeEach(() => {
  tmp = makeTempDir('mc-bridge-')
  h = makeHarness(tmp.dir)
  // the harness answers 'en' always; follow settings.language like the real SettingsManager
  h.settings.locale = (): Locale => (h.settings.value.language === 'auto' ? 'en' : h.settings.value.language)
  bridges = []
  events = []
  src = join(tmp.dir, '來源 素材')
  out = join(tmp.dir, 'out put')
  mkdirSync(src, { recursive: true })
})

afterEach(async () => {
  for (const b of bridges) await b.close()
  await h.queue.shutdown()
  tmp.cleanup()
})

function makeBridge(state?: JsonStore<BridgeState>): BridgeService {
  const b = new BridgeService({
    dir: join(tmp.dir, 'user data', 'bridge'),
    queue: h.queue,
    presets: h.presets,
    settings: h.settings,
    appVersion: '9.8.7',
    exePath: 'C:\\Program Files\\Media Converter\\Media Converter.exe',
    now: () => 1234,
    onRequest: (e) => events.push(e),
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    infoDebounceMs: 10,
    ...(state ? { state } : {}),
  })
  bridges.push(b)
  return b
}

const readInfo = (b: BridgeService): BridgeInfo => JSON.parse(readFileSync(b.paths.info, 'utf8')) as BridgeInfo

function request(over: Partial<BridgeRequest> & { id: string }): BridgeRequest {
  return {
    bridgeVersion: BRIDGE_VERSION,
    host: 'aftereffects',
    files: [],
    presetIds: ['h264-match'],
    outputDir: out,
    nameTemplate: null,
    deleteAfter: false,
    start: false,
    createdAt: 1,
    ...over,
  }
}

/** Like the panel: write "<id>.json.tmp", then rename it to "<id>.json". */
function send(b: BridgeService, id: string, body: BridgeRequest | string): string {
  const path = join(b.paths.inbox, `${id}.json`)
  writeFileSync(path + '.tmp', typeof body === 'string' ? body : JSON.stringify(body))
  renameSync(path + '.tmp', path)
  return path
}

async function result(b: BridgeService, id: string): Promise<BridgeResult> {
  const path = join(b.paths.results, `${id}.json`)
  await waitFor(() => existsSync(path), 10000, `result ${id}`)
  await b.idle()
  return JSON.parse(readFileSync(path, 'utf8')) as BridgeResult
}

const tmpFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'))

describe('bridge info.json', () => {
  it('start creates the folders and writes info.json: video presets only, localized, with a summary', async () => {
    const b = makeBridge()
    await b.start()
    for (const d of [b.paths.inbox, b.paths.results, b.paths.intermediates]) expect(existsSync(d)).toBe(true)
    const info = readInfo(b)
    expect(info).toMatchObject({
      bridgeVersion: BRIDGE_VERSION,
      appVersion: '9.8.7',
      exePath: 'C:\\Program Files\\Media Converter\\Media Converter.exe',
      locale: 'en',
      updatedAt: 1234,
      lastVideoPresetId: 'h264-match',
      defaultOutputDir: null,
    })
    const videoIds = h.presets.list().filter((p) => p.kind === 'video').map((p) => p.id)
    expect(info.presets.map((p) => p.id)).toEqual(videoIds)
    expect(info.presets.every((p) => p.kind === 'video')).toBe(true)
    expect(info.presets.some((p) => p.id === 'img-jpeg-q90' || p.id === 'file-copy-rename')).toBe(false)
    const match = info.presets.find((p) => p.id === 'h264-match')!
    expect(match).toMatchObject({ name: 'H.264 MP4 (match source)', builtIn: true, category: 'web', summary: 'MP4 · H.264 · Source size' })
    expect(match.names?.['zh-TW']).toBe('H.264 MP4（原始尺寸）')
    const p1080 = info.presets.find((p) => p.id === 'h264-1080p')!
    expect(p1080.summary).toMatch(/^MP4 · H\.264 · \d+×\d+$/)
    expect(tmpFiles(b.paths.dir)).toEqual([])
  })

  it('follows the language, the default output folder, the last preset and preset edits', async () => {
    const b = makeBridge()
    await b.start()
    h.presets.onChange(() => b.scheduleInfo())

    h.settings.patch({ language: 'zh-TW', defaultOutputDir: 'D:\\輸出', lastVideoPresetId: 'h264-1080p' })
    b.scheduleInfo()
    await b.idle()
    let info = readInfo(b)
    expect(info.locale).toBe('zh-TW')
    expect(info.defaultOutputDir).toBe('D:\\輸出')
    expect(info.lastVideoPresetId).toBe('h264-1080p')
    const match = info.presets.find((p) => p.id === 'h264-match')!
    expect(match.name).toBe('H.264 MP4（原始尺寸）')
    expect(match.summary).toBe('MP4 · H.264 · 來源尺寸')

    // a user preset appears (no localized names), and disappears again when deleted
    const copy = h.presets.save(getBuiltinPreset('h264-1080p')!)
    await b.idle()
    info = readInfo(b)
    const user = info.presets.find((p) => p.id === copy.id)!
    expect(user).toMatchObject({ kind: 'video', builtIn: false, name: copy.name })
    expect(user.names).toBeUndefined()
    // an unknown remembered preset falls back to the built-in default, like the queue does
    h.settings.patch({ lastVideoPresetId: copy.id })
    h.presets.delete(copy.id)
    await b.idle()
    info = readInfo(b)
    expect(info.presets.some((p) => p.id === copy.id)).toBe(false)
    expect(info.lastVideoPresetId).toBe('h264-match')
  })

  it('writes atomically: concurrent rewrites never expose a partial file and leave no temp files', async () => {
    const b = makeBridge()
    mkdirSync(b.paths.dir, { recursive: true })
    writeFileSync(b.paths.info, '{"broken":')
    await b.start()
    expect(readInfo(b).bridgeVersion).toBe(BRIDGE_VERSION)
    let done = false
    const writes = Promise.all(Array.from({ length: 40 }, () => b.writeInfo())).finally(() => {
      done = true
    })
    let reads = 0
    while (!done) {
      expect(() => readInfo(b)).not.toThrow()
      reads++
      await sleep(0)
    }
    await writes
    expect(reads).toBeGreaterThan(0)
    expect(readInfo(b).presets.length).toBeGreaterThan(5)
    expect(tmpFiles(b.paths.dir)).toEqual([])
  })

  it('summaries cover audio-only, GIF and copy presets', () => {
    const s = (getBuiltinPreset('h264-match') as VideoPreset).settings
    expect(videoPresetSummary({ ...s, container: 'mp3', audio: { codec: 'mp3', bitrateKbps: 320 } }, 'en')).toBe('MP3 · MP3 · 320 kbps')
    expect(videoPresetSummary({ ...s, video: { ...s.video, codec: 'copy' } }, 'ja')).toBe('MP4 · コピー（再エンコードなし）')
    expect(
      videoPresetSummary(
        { ...s, container: 'gif', video: { ...s.video, codec: 'gif', gif: { fps: 12, width: 480, colors: 256, dither: 'none', loop: 0 } } },
        'en',
      ),
    ).toBe('GIF · GIF · 480px · 12 fps')
  })
})

describe('bridge requests', () => {
  it('queues one job per file × preset, writes the result and removes the inbox file', async () => {
    const a = touch(join(src, 'A 片段.mov'))
    const c = touch(join(src, 'B.mp4'))
    const b = makeBridge()
    await b.start()
    const inbox = send(b, 'req-1', request({ id: 'req-1', files: [a, c], presetIds: ['h264-match', 'h264-1080p'], nameTemplate: '{name}_{preset}' }))
    const r = await result(b, 'req-1')
    expect(r).toMatchObject({ id: 'req-1', status: 'accepted', errors: [], handledAt: 1234 })
    expect(r.jobIds).toHaveLength(4)
    expect(existsSync(inbox)).toBe(false)
    const jobs = h.queue.getJobs()
    expect(jobs.map((j) => j.id).sort()).toEqual([...r.jobIds].sort())
    for (const j of jobs) {
      expect(j.kind).toBe('video')
      expect(j.status).toBe('queued')
      expect(j.output.dir).toBe(out)
      expect(j.output.nameTemplate).toBe('{name}_{preset}')
    }
    expect(jobs.filter((j) => j.presetId === 'h264-1080p').map((j) => j.source).sort()).toEqual([a, c].sort())
    expect(jobs.filter((j) => j.presetId === 'h264-match')).toHaveLength(2)
    expect(h.queue.isRunning()).toBe(false)
    expect(events).toEqual([{ id: 'req-1', host: 'aftereffects', status: 'accepted', jobCount: 4, fileCount: 2, errors: [] }])
  })

  it('outputDir null puts the output next to the source; nameTemplate null uses the app default', async () => {
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    send(b, 'next', request({ id: 'next', files: [a], outputDir: null }))
    const r = await result(b, 'next')
    expect(r.status).toBe('accepted')
    const [job] = h.queue.getJobs()
    expect(job.output.dir).toBeNull()
    expect(job.output.nameTemplate).toBe(h.settings.value.defaultNameTemplate)
  })

  it('reports unknown and non-video presets and still queues the known ones', async () => {
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    send(b, 'p', request({ id: 'p', files: [a], presetIds: ['no-such-preset', 'img-jpeg-q90', 'h264-match', 'h264-match'] }))
    const r = await result(b, 'p')
    expect(r.status).toBe('accepted')
    expect(r.jobIds).toHaveLength(1)
    expect(r.errors).toEqual([
      t('bridge.err.unknownPreset', { id: 'no-such-preset' }, 'en'),
      t('bridge.err.notVideoPreset', { name: getBuiltinPreset('img-jpeg-q90')!.names!.en! }, 'en'),
    ])
    expect(h.queue.getJobs().map((j) => j.presetId)).toEqual(['h264-match'])
  })

  it('reports missing, relative and non-video files; nothing valid → rejected', async () => {
    const good = touch(join(src, 'good.mov'))
    const text = touch(join(src, 'notes.txt'))
    const photo = touch(join(src, 'still.jpg'))
    const missing = join(src, 'gone.mov')
    const b = makeBridge()
    await b.start()
    send(b, 'f1', request({ id: 'f1', files: [missing, text, 'relative\\x.mov', photo, good] }))
    const r1 = await result(b, 'f1')
    expect(r1.status).toBe('accepted')
    expect(r1.jobIds).toHaveLength(1)
    expect(r1.errors).toEqual([
      t('bridge.err.fileMissing', { path: missing }, 'en'),
      t('bridge.err.notMedia', { path: text }, 'en'),
      t('bridge.err.notAbsolute', { path: 'relative\\x.mov' }, 'en'),
      t('bridge.err.notMedia', { path: photo }, 'en'),
    ])

    send(b, 'f2', request({ id: 'f2', files: [missing] }))
    const r2 = await result(b, 'f2')
    expect(r2).toMatchObject({ status: 'rejected', jobIds: [], errors: [t('bridge.err.fileMissing', { path: missing }, 'en')] })
    expect(h.queue.getJobs()).toHaveLength(1)
    expect(events.map((e) => e.status)).toEqual(['accepted', 'rejected'])
  })

  it('malformed JSON, a newer bridge version or a relative output folder → rejected, inbox file removed', async () => {
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    const bad = send(b, 'bad', '{ "bridgeVersion": 1, "files": [')
    const r = await result(b, 'bad')
    expect(r).toEqual({ id: 'bad', status: 'rejected', jobIds: [], errors: [t('bridge.err.json', undefined, 'en')], handledAt: 1234 })
    expect(existsSync(bad)).toBe(false)

    send(b, 'v2', request({ id: 'v2', files: [a], bridgeVersion: BRIDGE_VERSION + 1 }))
    expect((await result(b, 'v2')).errors).toEqual([t('bridge.err.version', { v: BRIDGE_VERSION + 1, supported: BRIDGE_VERSION }, 'en')])

    send(b, 'rel', request({ id: 'rel', files: [a], outputDir: 'renders' }))
    const rel = await result(b, 'rel')
    expect(rel.status).toBe('rejected')
    expect(rel.errors).toEqual([t('bridge.err.outputDir', { path: 'renders' }, 'en')])
    expect(h.queue.getJobs()).toEqual([])
  })

  it('start runs only the new jobs (other queued jobs stay queued)', async () => {
    const old = touch(join(src, 'old.mov'))
    const a = touch(join(src, 'new.mov'))
    await h.queue.addJobs({ paths: [old] })
    const b = makeBridge()
    await b.start()
    send(b, 's', request({ id: 's', files: [a], presetIds: ['h264-match', 'h264-1080p'], start: true }))
    const r = await result(b, 's')
    expect(r.jobIds).toHaveLength(2)
    await waitFor(() => h.queue.getJobs().filter((j) => r.jobIds.includes(j.id)).every((j) => j.status === 'done'), 10000, 'bridge jobs done')
    await waitFor(() => !h.queue.isRunning(), 5000, 'restricted run over')
    const oldJob = h.queue.getJobs().find((j) => j.source === old)!
    expect(oldJob.status).toBe('queued')
    expect(h.ffmpeg.encodes.map((e) => e.source)).toEqual([a, a])
  })

  it('handles requests waiting at startup, ignores *.tmp, and never queues the same id twice', async () => {
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    mkdirSync(b.paths.inbox, { recursive: true })
    writeFileSync(join(b.paths.inbox, 'early.json'), JSON.stringify(request({ id: 'early', files: [a] })))
    writeFileSync(join(b.paths.inbox, 'half.json.tmp'), '{"bridgeVersion":1,')
    await b.start()
    const r = await result(b, 'early')
    expect(r.status).toBe('accepted')
    await sleep(300)
    expect(existsSync(join(b.paths.inbox, 'half.json.tmp'))).toBe(true)
    expect(existsSync(join(b.paths.results, 'half.json'))).toBe(false)

    // the same request delivered again (e.g. the panel retried): removed, not queued again
    const again = send(b, 'early', request({ id: 'early', files: [a] }))
    await waitFor(() => !existsSync(again), 10000, 'duplicate removed')
    await b.idle()
    expect(h.queue.getJobs()).toHaveLength(1)
    expect(events).toHaveLength(1)
  })
})

describe('bridge deleteAfter', () => {
  it('deletes an intermediate only after every job for it succeeded', async () => {
    h.ffmpeg.mode = 'manual'
    const b = makeBridge()
    await b.start()
    const master = touch(join(b.paths.intermediates, 'master 母片.mov'))
    send(b, 'd', request({ id: 'd', files: [master], presetIds: ['h264-match', 'h264-1080p'], deleteAfter: true, start: true }))
    const r = await result(b, 'd')
    expect(r).toMatchObject({ status: 'accepted', errors: [] })
    expect(b.pendingDeletes()).toHaveLength(1)

    await waitFor(() => h.ffmpeg.pending.length === 1, 5000, 'first encode')
    h.ffmpeg.releaseAll()
    await waitFor(() => h.queue.getJobs().some((j) => j.status === 'done'), 5000, 'first job done')
    await b.idle()
    expect(existsSync(master)).toBe(true)

    await waitFor(() => h.ffmpeg.pending.length === 1, 5000, 'second encode')
    h.ffmpeg.releaseAll()
    await waitFor(() => !existsSync(master), 5000, 'intermediate deleted')
    expect(b.pendingDeletes()).toEqual([])
  })

  it('keeps the intermediate when a job fails, deletes it once a retry succeeds', async () => {
    h.ffmpeg.failWith = new Error('boom')
    const b = makeBridge()
    await b.start()
    const master = touch(join(b.paths.intermediates, 'comp.mov'))
    send(b, 'f', request({ id: 'f', files: [master], deleteAfter: true, start: true }))
    const r = await result(b, 'f')
    await waitFor(() => h.queue.getJobs().every((j) => j.status === 'failed'), 5000, 'job failed')
    await b.idle()
    expect(existsSync(master)).toBe(true)
    expect(b.pendingDeletes()).toHaveLength(1)

    h.ffmpeg.failWith = null
    h.queue.retryJobs(r.jobIds)
    h.queue.start(false, r.jobIds)
    await waitFor(() => !existsSync(master), 5000, 'deleted after retry')
  })

  it('keeps cancelled jobs’ intermediates', async () => {
    h.ffmpeg.mode = 'manual'
    const b = makeBridge()
    await b.start()
    const master = touch(join(b.paths.intermediates, 'cancel me.mov'))
    send(b, 'c', request({ id: 'c', files: [master], deleteAfter: true, start: true }))
    const r = await result(b, 'c')
    await waitFor(() => h.ffmpeg.pending.length === 1, 5000, 'encode running')
    await h.queue.cancelJobs(r.jobIds)
    await b.idle()
    expect(h.queue.getJobs()[0].status).toBe('cancelled')
    expect(existsSync(master)).toBe(true)
  })

  it('never deletes files outside bridge/intermediates — not via "..", not through a junction', async () => {
    const b = makeBridge()
    await b.start()
    const outside = touch(join(src, 'my footage.mov'))
    const sibling = touch(join(b.paths.dir, 'escape.mov'))
    const viaDots = `${b.paths.intermediates}\\..\\escape.mov`
    const elsewhere = join(tmp.dir, 'elsewhere')
    mkdirSync(elsewhere)
    const target = touch(join(elsewhere, 'linked.mov'))
    symlinkSync(elsewhere, join(b.paths.intermediates, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const viaJunction = join(b.paths.intermediates, 'link', 'linked.mov')
    const inside = touch(join(b.paths.intermediates, 'ok.mov'))

    send(b, 'x', request({ id: 'x', files: [outside, viaDots, viaJunction, inside], deleteAfter: true, start: true }))
    const r = await result(b, 'x')
    expect(r.status).toBe('accepted')
    expect(r.jobIds).toHaveLength(4)
    // errors follow the queue's (natural name) order of the files
    expect([...r.errors].sort()).toEqual([outside, viaDots, viaJunction].map((p) => t('bridge.err.keepOutside', { path: p }, 'en')).sort())
    await waitFor(() => !existsSync(inside), 10000, 'inside intermediate deleted')
    await waitFor(() => h.queue.getJobs().every((j) => j.status === 'done'), 10000, 'all done')
    await b.idle()
    expect(existsSync(outside)).toBe(true)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('checks paths strictly', async () => {
    const b = makeBridge()
    await b.start()
    const inside = touch(join(b.paths.intermediates, 'a.mov'))
    mkdirSync(join(b.paths.intermediates, 'sub'))
    expect(await b.isDeletableIntermediate(inside)).toBe(true)
    expect(await b.isDeletableIntermediate(b.paths.intermediates)).toBe(false)
    expect(await b.isDeletableIntermediate(join(b.paths.intermediates, 'sub'))).toBe(false)
    expect(await b.isDeletableIntermediate(`${b.paths.intermediates}\\sub\\..\\a.mov`)).toBe(false)
    expect(await b.isDeletableIntermediate('intermediates\\a.mov')).toBe(false)
    expect(await b.isDeletableIntermediate(join(b.paths.intermediates, 'missing.mov'))).toBe(false)
  })

  it('remembers pending deletes across a restart', async () => {
    const stateFile = join(tmp.dir, 'bridge-state.json')
    const store1 = new JsonStore<BridgeState>(stateFile, emptyBridgeState, { debounceMs: 5, parse: parseBridgeState })
    const b1 = makeBridge(store1)
    await b1.start()
    const master = touch(join(b1.paths.intermediates, 'later.mov'))
    send(b1, 'r', request({ id: 'r', files: [master], deleteAfter: true, start: false }))
    const r = await result(b1, 'r')
    await b1.close()
    expect(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).pendingDeletes)).toHaveLength(1)

    const b2 = makeBridge(new JsonStore<BridgeState>(stateFile, emptyBridgeState, { debounceMs: 5, parse: parseBridgeState }))
    await b2.start()
    expect(b2.pendingDeletes()).toHaveLength(1)
    h.queue.start(false, r.jobIds)
    await waitFor(() => !existsSync(master), 5000, 'deleted by the restarted bridge')
  })
})

describe('bridge info.json preset extensions', () => {
  it('every preset carries the extension the queue gives its output', async () => {
    const b = makeBridge()
    await b.start()
    const info = readInfo(b)
    expect(info.presets.find((p) => p.id === 'h264-match')!.ext).toBe('mp4')
    expect(info.presets.find((p) => p.id === 'h264-1080p')!.ext).toBe('mp4')
    expect(info.presets.find((p) => p.id === 'prores-422')!.ext).toBe('mov')
    for (const p of info.presets) {
      const preset = h.presets.get(p.id) as VideoPreset
      expect(p.ext).toBe(outputExtension(preset.settings))
      expect(p.ext).toMatch(/^[a-z0-9]+$/)
      expect(p.settings).toEqual(preset.settings)
    }
    // the pure helper too (no Electron needed)
    const [mov] = bridgePresets([getBuiltinPreset('prores-422')!], 'ja')
    expect(mov.ext).toBe('mov')
  })
})

const jobsOf = (r: BridgeResult): Job[] => h.queue.getJobs().filter((j) => r.jobIds.includes(j.id))
const outName = (j: Job): string => j.outputPath!.slice(out.length + 1)

describe('bridge request outputs', () => {
  it('one job per file × output; the same preset twice with different names; identical pairs once', async () => {
    h.settings.patch({ conflict: 'overwrite' })
    const a = touch(join(src, 'A 片段.mov'))
    const c = touch(join(src, 'B.mp4'))
    const b = makeBridge()
    await b.start()
    const outputs: BridgeOutput[] = [
      { presetId: 'h264-match', nameTemplate: '{name}' },
      { presetId: 'h264-match', nameTemplate: '{name}_小' },
      // the same pair again (after trimming): ignored
      { presetId: 'h264-match', nameTemplate: '  {name}_小 ' },
      { presetId: 'prores-422' },
    ]
    // presetIds / nameTemplate are what an older app would use: ignored when outputs are present
    send(b, 'o1', request({ id: 'o1', files: [a, c], presetIds: ['h264-1080p'], nameTemplate: 'ignored', outputs, start: true }))
    const r = await result(b, 'o1')
    expect(r).toMatchObject({ status: 'accepted', errors: [] })
    expect(r.jobIds).toHaveLength(6)
    const jobs = jobsOf(r)
    expect(jobs.some((j) => j.presetId === 'h264-1080p')).toBe(false)
    for (const file of [a, c]) {
      const mine = jobs.filter((j) => j.source === file)
      expect(mine.map((j) => [j.presetId, j.output.nameTemplate])).toEqual([
        ['h264-match', '{name}'],
        ['h264-match', '{name}_小'],
        ['prores-422', h.settings.value.defaultNameTemplate],
      ])
    }
    // no two outputs share a file name here: the user's conflict policy is kept
    expect(jobs.every((j) => j.output.conflict === 'overwrite' && j.output.dir === out)).toBe(true)
    await waitFor(() => jobsOf(r).every((j) => j.status === 'done'), 10000, 'all outputs done')
    expect(jobsOf(r).map(outName).sort()).toEqual(['A 片段.mov', 'A 片段.mp4', 'A 片段_小.mp4', 'B.mov', 'B.mp4', 'B_小.mp4'].sort())
    expect(events).toEqual([{ id: 'o1', host: 'aftereffects', status: 'accepted', jobCount: 6, fileCount: 2, errors: [] }])
  })

  it('unknown and non-video presets in outputs are reported once and skipped', async () => {
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    const outputs: BridgeOutput[] = [
      { presetId: 'no-such-preset', nameTemplate: 'x' },
      { presetId: 'h264-match', nameTemplate: 'keep me' },
      { presetId: 'img-jpeg-q90', nameTemplate: 'still' },
      { presetId: 'no-such-preset', nameTemplate: 'y' },
    ]
    send(b, 'u', request({ id: 'u', files: [a], outputs }))
    const r = await result(b, 'u')
    expect(r.status).toBe('accepted')
    expect(r.errors).toEqual([
      t('bridge.err.unknownPreset', { id: 'no-such-preset' }, 'en'),
      t('bridge.err.notVideoPreset', { name: getBuiltinPreset('img-jpeg-q90')!.names!.en! }, 'en'),
    ])
    expect(h.queue.getJobs().map((j) => [j.presetId, j.output.nameTemplate])).toEqual([['h264-match', 'keep me']])

    // nothing usable → rejected
    send(b, 'u2', request({ id: 'u2', files: [a], outputs: [{ presetId: 'no-such-preset' }] }))
    const r2 = await result(b, 'u2')
    expect(r2).toMatchObject({ status: 'rejected', jobIds: [], errors: [t('bridge.err.unknownPreset', { id: 'no-such-preset' }, 'en')] })
  })

  it('malformed outputs are reported (localized) and skipped; none well-formed → presetIds + nameTemplate', async () => {
    h.settings.patch({ language: 'zh-TW' })
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    const mixed = [
      null,
      'h264-match',
      { presetId: '' },
      { presetId: 'h264-match', nameTemplate: 5 },
      { nameTemplate: 'x' },
      { presetId: 'h264-1080p', nameTemplate: '{name}_hd' },
    ]
    send(b, 'm1', request({ id: 'm1', files: [a], outputs: mixed as unknown as BridgeOutput[] }))
    const r1 = await result(b, 'm1')
    expect(r1.status).toBe('accepted')
    expect(r1.errors).toEqual([1, 2, 3, 4, 5].map((n) => t('bridge.err.badOutput', { n }, 'zh-TW')))
    expect(r1.errors[0]).toBe('要求中的第 1 個輸出格式不正確（需要指定預設集），已略過。')
    expect(h.queue.getJobs().map((j) => [j.presetId, j.output.nameTemplate])).toEqual([['h264-1080p', '{name}_hd']])

    // every entry malformed: falls back to the legacy fields
    const allBad = [{ presetId: 7 }] as unknown as BridgeOutput[]
    send(b, 'm2', request({ id: 'm2', files: [a], presetIds: ['h264-match'], nameTemplate: '{name}_legacy', outputs: allBad }))
    const r2 = await result(b, 'm2')
    expect(r2.errors).toEqual([t('bridge.err.badOutput', { n: 1 }, 'zh-TW')])
    expect(jobsOf(r2).map((j) => [j.presetId, j.output.nameTemplate])).toEqual([['h264-match', '{name}_legacy']])

    // not an array: reported once, legacy fields used
    send(b, 'm3', request({ id: 'm3', files: [a], presetIds: ['h264-1080p'], outputs: 'h264-match' as unknown as BridgeOutput[] }))
    const r3 = await result(b, 'm3')
    expect(r3.errors).toEqual([t('bridge.err.badOutputs', undefined, 'zh-TW')])
    expect(jobsOf(r3).map((j) => j.presetId)).toEqual(['h264-1080p'])

    // an empty list is simply "no outputs"
    send(b, 'm4', request({ id: 'm4', files: [a], presetIds: ['h264-match'], outputs: [] }))
    expect(await result(b, 'm4')).toMatchObject({ status: 'accepted', errors: [] })

    // nothing at all
    send(b, 'm5', request({ id: 'm5', files: [a], presetIds: [], outputs: [{ presetId: '' }] }))
    expect(await result(b, 'm5')).toMatchObject({
      status: 'rejected',
      errors: [t('bridge.err.badOutput', { n: 1 }, 'zh-TW'), t('bridge.err.noPresets', undefined, 'zh-TW')],
    })
  })

  it('legacy requests (presetIds + nameTemplate, no outputs) still work', async () => {
    h.settings.patch({ conflict: 'skip' })
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    send(b, 'l', request({ id: 'l', files: [a], presetIds: ['h264-match', 'prores-422'], nameTemplate: '{name}_{preset}' }))
    const r = await result(b, 'l')
    expect(r).toMatchObject({ status: 'accepted', errors: [] })
    expect(jobsOf(r).map((j) => [j.presetId, j.output.nameTemplate, j.output.conflict])).toEqual([
      ['h264-match', '{name}_{preset}', 'skip'],
      ['prores-422', '{name}_{preset}', 'skip'],
    ])
  })
})

describe('bridge duplicate output names', () => {
  const vp = (id: string): VideoPreset => getBuiltinPreset(id) as VideoPreset
  // only names matter here (nothing is read)
  const files = [resolve('來源 素材', 'clip.mov'), resolve('來源 素材', 'other.mov')]
  const coll = (outputs: [string, string | null][], defaultTemplate = '{name}'): number[] =>
    [...collidingOutputs(files, outputs.map(([id, nameTemplate]) => ({ preset: vp(id), nameTemplate })), defaultTemplate, 'en')].sort()

  it('flags the outputs that render the same name + extension for a source', () => {
    // same name, both MP4
    expect(coll([['h264-match', 'Final'], ['h264-1080p', 'Final']])).toEqual([0, 1])
    // only the case differs; a template and a plain name that render alike; the app default vs. the same template
    expect(coll([['h264-match', 'final'], ['h264-1080p', 'FINAL']])).toEqual([0, 1])
    expect(coll([['h264-match', '{name}'], ['h264-1080p', 'clip']])).toEqual([0, 1])
    expect(coll([['h264-match', null], ['h264-1080p', '{name}']])).toEqual([0, 1])
    expect(coll([['h264-match', null], ['h264-1080p', 'clip_x']], '{name}_x')).toEqual([0, 1])
    // names that could only differ in size or time tokens count as the same
    expect(coll([['h264-match', '{name}_{width}'], ['h264-1080p', '{name}_{width}']])).toEqual([0, 1])
    expect(coll([['h264-match', '{name}_{time}'], ['h264-1080p', '{name}_{time}']])).toEqual([0, 1])
    // only the colliding outputs
    expect(coll([['h264-match', 'Final'], ['prores-422', 'Final'], ['h264-1080p', 'Final'], ['h264-1080p', 'Final small']])).toEqual([0, 2])
    // another extension, another {preset} name, another name: no collision
    expect(coll([['h264-match', 'Final'], ['prores-422', 'Final']])).toEqual([])
    expect(coll([['h264-match', '{name}_{preset}'], ['h264-1080p', '{name}_{preset}']])).toEqual([])
    expect(coll([['h264-match', '{name}'], ['h264-match', '{name}_小']])).toEqual([])
    // the files of one output never count against each other
    expect(coll([['h264-match', 'Final']])).toEqual([])
  })

  it('flags outputs of different sources that render the same file in the shared folder', () => {
    const outputs = [
      { preset: vp('h264-match'), nameTemplate: '{name}' },
      { preset: vp('h264-1080p'), nameTemplate: '{name}_2' },
    ]
    // After Effects comps "A:B" and "A_B" -> intermediates A_B.mov and A_B_2.mov; "A_B" + "_2" = "A_B_2"
    const inter = [resolve('inter', 'A_B.mov'), resolve('inter', 'A_B_2.mov')]
    expect([...collidingOutputs(inter, outputs, '{name}', 'en')].sort()).toEqual([0, 1])
    expect([...collidingOutputs(inter, outputs, '{name}', 'en', resolve('out put'))].sort()).toEqual([0, 1])
    // next to the sources (outputDir null) in different folders: no collision; one shared output folder: collision
    const apart = [resolve('a', 'A_B.mov'), resolve('b', 'A_B_2.mov')]
    expect([...collidingOutputs(apart, outputs, '{name}', 'en')]).toEqual([])
    expect([...collidingOutputs(apart, outputs, '{name}', 'en', resolve('out put'))].sort()).toEqual([0, 1])
    // {counter} is each file's place in the batch: the 2nd file's "{counter}" is the 1st file's "2"
    const counted = [
      { preset: vp('h264-match'), nameTemplate: '{counter}' },
      { preset: vp('h264-1080p'), nameTemplate: '2' },
    ]
    expect([...collidingOutputs(inter, counted, '{name}', 'en')].sort()).toEqual([0, 1])
    expect([...collidingOutputs(inter.slice(0, 1), counted, '{name}', 'en')]).toEqual([])
  })

  it("policy 'skip': outputs of different comps that render the same name are both written", async () => {
    h.settings.patch({ conflict: 'skip' })
    const a = touch(join(src, 'A_B.mov'))
    const a2 = touch(join(src, 'A_B_2.mov'))
    const b = makeBridge()
    await b.start()
    const outputs: BridgeOutput[] = [
      { presetId: 'h264-match', nameTemplate: '{name}' },
      { presetId: 'h264-1080p', nameTemplate: '{name}_2' },
    ]
    send(b, 'x', request({ id: 'x', files: [a, a2], outputs, start: true }))
    const r = await result(b, 'x')
    await waitFor(() => jobsOf(r).every((j) => j.status === 'done'), 5000, 'all done')
    expect(jobsOf(r).map((j) => j.output.conflict)).toEqual(['rename', 'rename', 'rename', 'rename'])
    expect(jobsOf(r).map(outName).sort()).toEqual(['A_B.mp4', 'A_B_2 (1).mp4', 'A_B_2.mp4', 'A_B_2_2.mp4'])
  })

  it('colliding outputs never overwrite each other with policy overwrite, also in separate runs', async () => {
    h.settings.patch({ conflict: 'overwrite' })
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    const outputs: BridgeOutput[] = [
      { presetId: 'h264-match', nameTemplate: 'Final' },
      { presetId: 'h264-1080p', nameTemplate: 'Final' },
      { presetId: 'h264-1080p', nameTemplate: 'Other' },
    ]
    send(b, 'dup', request({ id: 'dup', files: [a], outputs }))
    const r = await result(b, 'dup')
    expect(r).toMatchObject({ status: 'accepted', errors: [] })
    const [first, second, other] = r.jobIds
    const job = (id: string): Job => h.queue.getJobs().find((j) => j.id === id)!
    expect([first, second, other].map((id) => job(id).output.conflict)).toEqual(['rename', 'rename', 'overwrite'])

    // one run each: the queue's per-run bookkeeping is gone when the second one starts
    for (const id of [first, second, other]) {
      h.queue.start(false, [id])
      await waitFor(() => job(id).status === 'done' && !h.queue.isRunning(), 5000, `output ${id}`)
    }
    expect([first, second, other].map((id) => outName(job(id)))).toEqual(['Final.mp4', 'Final (1).mp4', 'Other.mp4'])
    for (const n of ['Final.mp4', 'Final (1).mp4', 'Other.mp4']) expect(existsSync(join(out, n))).toBe(true)

    // the same request again (a re-export): the colliding outputs add numbered files, "Other" keeps 'overwrite'
    send(b, 'dup2', request({ id: 'dup2', files: [a], outputs, start: true }))
    const r2 = await result(b, 'dup2')
    await waitFor(() => jobsOf(r2).every((j) => j.status === 'done'), 5000, 're-export done')
    expect(jobsOf(r2).map(outName)).toEqual(['Final (2).mp4', 'Final (3).mp4', 'Other.mp4'])
  })

  it("policy 'skip' still writes both colliding outputs (legacy presetIds too)", async () => {
    h.settings.patch({ conflict: 'skip' })
    const a = touch(join(src, 'clip.mov'))
    const b = makeBridge()
    await b.start()
    send(b, 'sk', request({ id: 'sk', files: [a], presetIds: ['h264-match', 'h264-1080p'], nameTemplate: '{name}', start: true }))
    const r = await result(b, 'sk')
    await waitFor(() => jobsOf(r).every((j) => j.status === 'done'), 5000, 'both done')
    expect(jobsOf(r).map((j) => j.output.conflict)).toEqual(['rename', 'rename'])
    expect(jobsOf(r).map(outName).sort()).toEqual(['clip (1).mp4', 'clip.mp4'])
  })
})

describe('bridge deleteAfter with several outputs', () => {
  it('deletes the intermediate only after the jobs of every output succeeded', async () => {
    h.ffmpeg.mode = 'manual'
    const b = makeBridge()
    await b.start()
    const master = touch(join(b.paths.intermediates, 'comp 合成.mov'))
    const outputs: BridgeOutput[] = [
      { presetId: 'h264-match', nameTemplate: 'A' },
      { presetId: 'h264-match', nameTemplate: 'B' },
      { presetId: 'prores-422', nameTemplate: 'A' },
    ]
    send(b, 'dm', request({ id: 'dm', files: [master], outputs, deleteAfter: true, start: true }))
    const r = await result(b, 'dm')
    expect(r).toMatchObject({ status: 'accepted', errors: [] })
    expect(r.jobIds).toHaveLength(3)
    expect(b.pendingDeletes()).toHaveLength(1)
    expect(Object.keys(b.pendingDeletes()[0].jobs).sort()).toEqual([...r.jobIds].sort())
    for (let i = 1; i <= 3; i++) {
      await waitFor(() => h.ffmpeg.pending.length === 1, 5000, `encode ${i}`)
      h.ffmpeg.releaseAll()
      await waitFor(() => h.queue.getJobs().filter((j) => j.status === 'done').length === i, 5000, `job ${i} done`)
      await b.idle()
      if (i < 3) expect(existsSync(master)).toBe(true)
    }
    await waitFor(() => !existsSync(master), 5000, 'intermediate deleted')
    expect(b.pendingDeletes()).toEqual([])
  })
})

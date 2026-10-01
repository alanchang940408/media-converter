// Rename / copy / move jobs, folder structure, natural ordering, preview and undo (real file system, fake engines).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { rename as fsRename } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expandPaths } from '../../src/main/queue/Queue'
import type { FileOpJournal } from '../../src/main/queue/journal'
import type { AddJobsRequest, FileOpPreviewItem, Job, QueueEvent } from '../../src/shared/types'
import { makeHarness, makeTempDir, sleep, touch, waitFor, type Harness } from './helpers'

let tmp: { dir: string; cleanup: () => void }
let h: Harness
let src: string
let out: string

beforeEach(() => {
  tmp = makeTempDir('mc-fileops-')
  src = join(tmp.dir, 'src 素材 folder')
  out = join(tmp.dir, 'out 輸出')
  mkdirSync(src, { recursive: true })
})

afterEach(async () => {
  await h?.queue.shutdown()
  tmp.cleanup()
})

const names = (dir: string): string[] => readdirSync(dir).sort()
const read = (p: string): string => readFileSync(p, 'utf8')
const allSettled = (): boolean => h.queue.getJobs().every((j) => ['done', 'failed', 'cancelled', 'skipped'].includes(j.status))
const job = (id: string): Job => h.queue.getJobs().find((j) => j.id === id)!
const base = (p: string): string => p.split(/[\\/]/).pop()!

/** Set a file's modified (and access) time. */
function setMtime(p: string, d: Date): void {
  utimesSync(p, d, d)
}

/** Recursive listing: relative path → size, content hash and mtime. */
function snapshot(root: string): Record<string, string> {
  const outMap: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        outMap[relative(root, abs) + '/'] = 'dir'
        walk(abs)
      } else {
        const st = statSync(abs)
        const hash = createHash('sha1').update(readFileSync(abs)).digest('hex')
        outMap[relative(root, abs)] = `${st.size}|${hash}|${st.mtimeMs}`
      }
    }
  }
  walk(root)
  return outMap
}

async function addFiles(req: Partial<AddJobsRequest> & { paths: string[] }): Promise<Job[]> {
  const res = await h.queue.addJobs({ filePresetId: 'file-copy-rename', ...req })
  return res.jobs
}

async function runAll(): Promise<void> {
  h.queue.start()
  await waitFor(allSettled, 8000, 'file jobs to settle')
}

describe('expandPaths', () => {
  it('orders naturally (2 before 10), folder by folder, whatever order the paths come in', async () => {
    for (const n of ['img10.jpg', 'img2.jpg', 'IMG1.jpg', 'img3.jpg']) touch(join(src, n))
    mkdirSync(join(src, 'folder 10'))
    mkdirSync(join(src, 'folder 2'))
    touch(join(src, 'folder 10', 'b.jpg'))
    touch(join(src, 'folder 2', 'a.jpg'))
    const r = await expandPaths([src], { recursive: true })
    expect(r.files.map((p) => relative(src, p))).toEqual([
      join('folder 2', 'a.jpg'),
      join('folder 10', 'b.jpg'),
      'IMG1.jpg',
      'img2.jpg',
      'img3.jpg',
      'img10.jpg',
    ])
    // files given one by one in a random order end up in the same natural order
    const direct = await expandPaths(['img10.jpg', 'img3.jpg', 'IMG1.jpg', 'img2.jpg'].map((n) => join(src, n)), false)
    expect(direct.files.map(base)).toEqual(['IMG1.jpg', 'img2.jpg', 'img3.jpg', 'img10.jpg'])
  })

  it('sorts by modified time, and by EXIF taken time falling back to modified', async () => {
    const a = touch(join(src, 'a.jpg'))
    const b = touch(join(src, 'b.jpg'))
    const c = touch(join(src, 'c.txt'))
    setMtime(a, new Date(2024, 0, 3))
    setMtime(b, new Date(2024, 0, 1))
    setMtime(c, new Date(2024, 0, 2))
    const byMtime = await expandPaths([src], { mode: 'file', sortBy: 'modified' })
    expect(byMtime.files.map(base)).toEqual(['b.jpg', 'c.txt', 'a.jpg'])

    const taken: Record<string, number> = { 'a.jpg': new Date(2020, 5, 1).getTime(), 'b.jpg': new Date(2025, 5, 1).getTime() }
    const byTaken = await expandPaths([src], { mode: 'file', sortBy: 'taken', readTakenAt: async (p) => taken[base(p)] })
    // a (2020 photo) < c.txt (no EXIF → mtime 2024-01-02) < b (2025 photo)
    expect(byTaken.files.map(base)).toEqual(['a.jpg', 'c.txt', 'b.jpg'])
    expect(byTaken.entries.find((e) => e.path === a)?.takenAt).toBe(taken['a.jpg'])

    // equal times keep the natural name order
    for (const p of [a, b, c]) setMtime(p, new Date(2024, 0, 1))
    const tie = await expandPaths([src], { mode: 'file', sortBy: 'modified' })
    expect(tie.files.map(base)).toEqual(['a.jpg', 'b.jpg', 'c.txt'])
  })

  it('records relativeDir for files found inside an added folder', async () => {
    mkdirSync(join(src, 'sub 子', 'deep'), { recursive: true })
    touch(join(src, 'top.mp4'))
    touch(join(src, 'sub 子', 'mid.mp4'))
    touch(join(src, 'sub 子', 'deep', 'low.mp4'))
    const lone = touch(join(tmp.dir, 'lone.mp4'))
    const r = await expandPaths([src, lone], { recursive: true })
    const rel = Object.fromEntries(r.entries.map((e) => [base(e.path), e.relativeDir]))
    expect(rel).toEqual({ 'top.mp4': '', 'mid.mp4': 'sub 子', 'low.mp4': join('sub 子', 'deep'), 'lone.mp4': undefined })
  })

  it('file mode accepts any regular file but never hidden / system / temp files', async () => {
    for (const n of ['notes.txt', 'README', 'clip.mp4', 'archive.tar.gz', '.hidden', 'Thumbs.db', 'desktop.ini', '.DS_Store', 'x.mp4.mcpart', '~$doc.docx', 'a.jpg.1234.mcrename']) {
      touch(join(src, n))
    }
    const files = await expandPaths([src], { mode: 'file' })
    expect(files.files.map(base)).toEqual(['archive.tar.gz', 'clip.mp4', 'notes.txt', 'README'])
    expect(files.ignored).toEqual([])
    const media = await expandPaths([src], { mode: 'media' })
    expect(media.files.map(base)).toEqual(['clip.mp4'])
    // explicitly added junk is reported, not queued
    const direct = await expandPaths([join(src, 'Thumbs.db'), join(src, 'notes.txt')], { mode: 'file' })
    expect(direct.files.map(base)).toEqual(['notes.txt'])
    expect(direct.ignored.map(base)).toEqual(['Thumbs.db'])
  })
})

describe('adding file jobs', () => {
  it('creates file jobs for every file type from the file preset and remembers it', async () => {
    h = makeHarness(tmp.dir, { settings: { lastFilePresetId: 'file-copy-rename' } })
    touch(join(src, 'notes.txt'))
    touch(join(src, 'clip.mp4'))
    touch(join(src, 'NOEXT'))
    const jobs = await addFiles({ paths: [src], filePresetId: 'file-move-rename', videoPresetId: 'hevc-match' })
    expect(jobs.map((j) => base(j.source))).toEqual(['clip.mp4', 'NOEXT', 'notes.txt'])
    for (const j of jobs) {
      expect(j.kind).toBe('file')
      expect(j.file).toEqual({ operation: 'move' })
      expect(j.presetId).toBe('file-move-rename')
      expect(j.presetName).toBe('Move & rename')
      expect(j.video).toBeUndefined()
    }
    expect(h.settings.value.lastFilePresetId).toBe('file-move-rename')
    // never probed (any file type; probing would hold files that are about to move)
    await sleep(50)
    expect(h.ffmpeg.probeCalls).toBe(0)
    expect(h.queue.getJobs().every((j) => !j.sourceInfo)).toBe(true)
  })

  it('rejects wrong preset kinds and file presets for watch folders', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'a.txt'))
    await expect(h.queue.addJobs({ paths: [p], filePresetId: 'h264-match' })).rejects.toThrow()
    await expect(h.queue.addJobs({ paths: [p], filePresetId: 'nope' })).rejects.toThrow(/nope/)
    await expect(h.queue.addJobs({ paths: [p], filePresetId: 'file-rename', watchFolderId: 'w1' })).rejects.toThrow(/watch folders/)
    // and a file preset is no video preset
    const clip = touch(join(src, 'a.mp4'))
    await expect(h.queue.addJobs({ paths: [clip], videoPresetId: 'file-rename' })).rejects.toThrow()
    expect(h.queue.getJobs()).toHaveLength(0)
  })

  it('keeps preset kinds compatible when applying / updating presets', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.mp4'))
    const [fileJob] = await addFiles({ paths: [join(src, 'a.mp4')], filePresetId: 'file-copy-rename' })
    const { jobs: [videoJob] } = await h.queue.addJobs({ paths: [join(src, 'a.mp4')] })
    h.queue.applyPreset([fileJob.id, videoJob.id], 'file-rename')
    expect(job(fileJob.id).file).toEqual({ operation: 'rename' })
    expect(job(fileJob.id).presetId).toBe('file-rename')
    expect(job(videoJob.id).presetId).toBe('h264-match')
    expect(h.settings.value.lastFilePresetId).toBe('file-rename')
    h.queue.applyPreset([fileJob.id], 'h264-720p')
    expect(job(fileJob.id).presetId).toBe('file-rename')
    expect(() => h.queue.updateJob(fileJob.id, { presetId: 'h264-720p' })).toThrow()
    expect(() => h.queue.updateJob(videoJob.id, { presetId: 'file-move-rename' })).toThrow()
    const patched = h.queue.updateJob(fileJob.id, { file: { operation: 'move' }, output: { preserveStructure: true } })
    expect(patched.file).toEqual({ operation: 'move' })
    expect(patched.output.preserveStructure).toBe(true)
    const viaPreset = h.queue.updateJob(fileJob.id, { presetId: 'file-copy-rename' })
    expect(viaPreset.file).toEqual({ operation: 'copy' })
  })

  it('preserveStructure defaults on only for folder adds with an output folder', async () => {
    h = makeHarness(tmp.dir, { settings: { preserveStructure: true } })
    mkdirSync(join(src, 'sub'))
    touch(join(src, 'sub', 'a.mp4'))
    const lone = touch(join(src, 'lone.mp4'))
    const { jobs: [folderJob] } = await h.queue.addJobs({ paths: [join(src, 'sub')], output: { dir: out } })
    expect(folderJob.output.preserveStructure).toBe(true)
    expect(folderJob.relativeDir).toBe('')
    const { jobs: [loneJob] } = await h.queue.addJobs({ paths: [lone], output: { dir: out } })
    expect(loneJob.output.preserveStructure).toBe(false)
    expect(loneJob.relativeDir).toBeUndefined()
    const { jobs: [nextToSource] } = await h.queue.addJobs({ paths: [join(src, 'sub')], output: { dir: null } })
    expect(nextToSource.output.preserveStructure).toBeUndefined()
    // choosing an output folder later applies the same default
    expect(h.queue.updateJob(nextToSource.id, { output: { dir: out } }).output.preserveStructure).toBe(true)
    // an explicit choice is never overridden
    expect(h.queue.updateJob(nextToSource.id, { output: { dir: join(out, 'x'), preserveStructure: false } }).output.preserveStructure).toBe(false)
    expect(h.queue.updateJob(nextToSource.id, { output: { dir: out } }).output.preserveStructure).toBe(false)
    // single files have no structure to keep
    const { jobs: [lone2] } = await h.queue.addJobs({ paths: [lone], output: { dir: null } })
    expect(h.queue.updateJob(lone2.id, { output: { dir: out } }).output.preserveStructure).toBeUndefined()
    const { jobs: [explicitOff] } = await h.queue.addJobs({ paths: [join(src, 'sub')], output: { dir: out, preserveStructure: false } })
    expect(explicitOff.output.preserveStructure).toBe(false)
    h.settings.value.preserveStructure = false
    const { jobs: [settingOff] } = await h.queue.addJobs({ paths: [join(src, 'sub')], output: { dir: out } })
    expect(settingOff.output.preserveStructure).toBe(false)
  })

  it('file-mode adds never auto-start, not even with autoStart or a running queue', async () => {
    h = makeHarness(tmp.dir, { settings: { autoStart: true } })
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'clip.mp4'))
    touch(join(src, 'a.txt'))
    await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], output: { dir: out } })
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'video encode')
    const [fileJob] = await addFiles({ paths: [join(src, 'a.txt')], output: { dir: out } })
    await sleep(80)
    expect(job(fileJob.id).status).toBe('queued')
    // a video added later (auto-start again) does not drag the file job along either
    touch(join(src, 'clip2.mp4'))
    await h.queue.addJobs({ paths: [join(src, 'clip2.mp4')], output: { dir: out } })
    h.ffmpeg.releaseAll()
    await waitFor(() => h.ffmpeg.encodes.length === 2, 3000, 'second encode')
    h.ffmpeg.releaseAll()
    await waitFor(() => !h.queue.isRunning(), 3000, 'run to finish')
    expect(job(fileJob.id).status).toBe('queued')
    expect(existsSync(join(out, 'a.txt'))).toBe(false)
    // the user's explicit start runs it
    h.queue.start()
    await waitFor(() => job(fileJob.id).status === 'done', 3000, 'file job')
    expect(read(join(out, 'a.txt'))).toBe('x')
  })

  it('an explicit start while the queue is running picks up waiting file jobs', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'clip.mp4'))
    touch(join(src, 'a.txt'))
    await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'video encode')
    const [fileJob] = await addFiles({ paths: [join(src, 'a.txt')], output: { dir: out } })
    await sleep(50)
    expect(job(fileJob.id).status).toBe('queued')
    h.queue.start()
    await waitFor(() => job(fileJob.id).status === 'done', 3000, 'file job')
    h.ffmpeg.releaseAll()
    await waitFor(allSettled, 3000, 'all')
  })
})

describe('running file jobs', () => {
  it('copy: byte-identical, keeps the exact extension (also none), mtime, CJK + spaces; source untouched', async () => {
    h = makeHarness(tmp.dir)
    const photo = join(src, 'a 照片 01.JPG')
    writeFileSync(photo, Buffer.from([0, 1, 2, 3, 255, 254]))
    const readme = touch(join(src, 'b READ ME'), 'readme')
    const when = new Date(2021, 4, 6, 7, 8, 9)
    setMtime(photo, when)
    const jobs = await addFiles({ paths: [readme, photo], output: { dir: out, nameTemplate: '{name} 複製_{counter:2}' } })
    await runAll()
    const copied = join(out, 'a 照片 01 複製_01.JPG')
    expect(names(out)).toEqual(['a 照片 01 複製_01.JPG', 'b READ ME 複製_02'])
    expect(readFileSync(copied)).toEqual(Buffer.from([0, 1, 2, 3, 255, 254]))
    expect(Math.abs(statSync(copied).mtimeMs - when.getTime())).toBeLessThan(2000)
    expect(read(join(out, 'b READ ME 複製_02'))).toBe('readme')
    expect(existsSync(photo) && existsSync(readme)).toBe(true)
    for (const j of jobs) {
      const done = job(j.id)
      expect(done).toMatchObject({ status: 'done', progress: 1, encoder: 'copy' })
      expect(done.outputSizeBytes).toBeGreaterThan(0)
    }
    expect(job(jobs[0].id).outputPath).toBe(copied)
    // copies are not journaled
    expect(h.queue.getFileOpUndo()).toBeNull()
  })

  it('move keeps the folder structure below the output folder', async () => {
    h = makeHarness(tmp.dir)
    mkdirSync(join(src, 'day 1', '早上'), { recursive: true })
    touch(join(src, 'root.txt'), 'R')
    touch(join(src, 'day 1', 'a.txt'), 'A')
    touch(join(src, 'day 1', '早上', 'b.txt'), 'B')
    const jobs = await addFiles({ paths: [src], recursive: true, filePresetId: 'file-move-rename', output: { dir: out } })
    expect(jobs.every((j) => j.output.preserveStructure)).toBe(true)
    await runAll()
    expect(read(join(out, 'root.txt'))).toBe('R')
    expect(read(join(out, 'day 1', 'a.txt'))).toBe('A')
    expect(read(join(out, 'day 1', '早上', 'b.txt'))).toBe('B')
    expect(existsSync(join(src, 'day 1', 'a.txt'))).toBe(false)
    expect(existsSync(join(src, 'root.txt'))).toBe(false)
    expect(h.queue.getFileOpUndo()).toMatchObject({ count: 3, operations: { move: 3, rename: 0 } })
  })

  it('preserveStructure applies to conversions too; off = flat output folder', async () => {
    h = makeHarness(tmp.dir)
    mkdirSync(join(src, 'sub'), { recursive: true })
    touch(join(src, 'sub', 'clip.mp4'))
    touch(join(src, 'sub', 'pic.jpg'))
    await h.queue.addJobs({ paths: [src], recursive: true, output: { dir: out } })
    await runAll()
    expect(names(join(out, 'sub'))).toEqual(['clip.mp4', 'pic.jpg'])
    await h.queue.addJobs({ paths: [src], recursive: true, output: { dir: join(tmp.dir, 'flat'), preserveStructure: false } })
    await runAll()
    expect(names(join(tmp.dir, 'flat'))).toEqual(['clip.mp4', 'pic.jpg'])
  })

  it('rename works in place (output folder ignored) with {counter} in natural order', async () => {
    h = makeHarness(tmp.dir)
    for (const n of ['shot 10.txt', 'shot 2.txt', 'shot 1.txt']) touch(join(src, n), n)
    await addFiles({ paths: [src], filePresetId: 'file-rename', output: { dir: out, nameTemplate: '旅行_{counter:3}' } })
    await runAll()
    expect(existsSync(out)).toBe(false)
    expect(names(src)).toEqual(['旅行_001.txt', '旅行_002.txt', '旅行_003.txt'])
    expect(read(join(src, '旅行_001.txt'))).toBe('shot 1.txt')
    expect(read(join(src, '旅行_002.txt'))).toBe('shot 2.txt')
    expect(read(join(src, '旅行_003.txt'))).toBe('shot 10.txt')
    expect(h.queue.getFileOpUndo()).toMatchObject({ count: 3, operations: { move: 0, rename: 3 } })
  })

  it('case-only rename (a.jpg → A.jpg) goes through a temp name and really changes the case', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'photo.jpg'), 'P')
    const [j] = await addFiles({ paths: [p], filePresetId: 'file-rename', output: { nameTemplate: 'PHOTO' } })
    const [item] = await h.queue.previewFileOps([j.id])
    expect(item).toMatchObject({ status: 'ok', target: join(src, 'PHOTO.jpg') })
    await runAll()
    expect(names(src)).toEqual(['PHOTO.jpg'])
    expect(read(join(src, 'PHOTO.jpg'))).toBe('P')
    expect(job(j.id)).toMatchObject({ status: 'done', outputPath: join(src, 'PHOTO.jpg') })
  })

  it('target === source: done without touching the file', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'same.txt'), 'S')
    setMtime(p, new Date(2020, 1, 2))
    const before = statSync(p).mtimeMs
    const [j] = await addFiles({ paths: [p], filePresetId: 'file-rename', output: { nameTemplate: '{name}' } })
    expect(await h.queue.previewFileOps([j.id])).toEqual([{ jobId: j.id, source: p, target: p, status: 'unchanged' }])
    await runAll()
    expect(job(j.id)).toMatchObject({ status: 'done', outputPath: p })
    expect(statSync(p).mtimeMs).toBe(before)
    expect(h.queue.getFileOpUndo()).toBeNull()
  })

  it('conflict policies: rename / overwrite / skip', async () => {
    h = makeHarness(tmp.dir)
    mkdirSync(out)
    const a = touch(join(src, 'a.txt'), 'NEW')
    touch(join(out, 'a.txt'), 'EXISTING')
    const [r] = await addFiles({ paths: [a], output: { dir: out, conflict: 'rename' } })
    const [o] = await addFiles({ paths: [a], output: { dir: out, conflict: 'overwrite', nameTemplate: '{name}' } })
    const [s] = await addFiles({ paths: [a], output: { dir: out, conflict: 'skip' } })
    const preview = await h.queue.previewFileOps([r.id, o.id, s.id])
    expect(preview.map((i) => i.status)).toEqual(['renamed', 'overwrite', 'skip'])
    expect(preview.map((i) => i.target && base(i.target))).toEqual(['a (1).txt', 'a.txt', null])
    await runAll()
    expect(job(r.id)).toMatchObject({ status: 'done', outputPath: join(out, 'a (1).txt') })
    expect(job(o.id)).toMatchObject({ status: 'done', outputPath: join(out, 'a.txt') })
    expect(job(s.id).status).toBe('skipped')
    expect(names(out)).toEqual(['a (1).txt', 'a.txt'])
    expect(read(join(out, 'a.txt'))).toBe('NEW')
    expect(read(join(out, 'a (1).txt'))).toBe('NEW')
  })

  it('move / rename with overwrite replace an existing file that no job owns', async () => {
    h = makeHarness(tmp.dir)
    mkdirSync(out)
    const a = touch(join(src, 'a.txt'), 'MOVED')
    const b = touch(join(src, 'b.txt'), 'RENAMED')
    touch(join(out, 'a.txt'), 'OLD OUT')
    touch(join(src, 'target.txt'), 'OLD IN PLACE')
    const [m] = await addFiles({ paths: [a], filePresetId: 'file-move-rename', output: { dir: out, conflict: 'overwrite' } })
    const [r] = await addFiles({ paths: [b], filePresetId: 'file-rename', output: { nameTemplate: 'target', conflict: 'overwrite' } })
    expect((await h.queue.previewFileOps([m.id, r.id])).map((i) => i.status)).toEqual(['overwrite', 'overwrite'])
    await runAll()
    expect(read(join(out, 'a.txt'))).toBe('MOVED')
    expect(read(join(src, 'target.txt'))).toBe('RENAMED')
    expect(names(src)).toEqual(['target.txt'])
    expect(names(out)).toEqual(['a.txt'])
  })

  it('never two outputs with the same name inside one batch', async () => {
    h = makeHarness(tmp.dir)
    const files = ['x.txt', 'y.txt', 'z.txt'].map((n) => touch(join(src, n), n))
    const jobs = await addFiles({ paths: files, output: { dir: out, nameTemplate: 'same', conflict: 'overwrite' } })
    const preview = await h.queue.previewFileOps(jobs.map((j) => j.id))
    expect(preview.map((i) => base(i.target!))).toEqual(['same.txt', 'same (1).txt', 'same (2).txt'])
    await runAll()
    expect(names(out)).toEqual(['same (1).txt', 'same (2).txt', 'same.txt'])
    expect(h.queue.getJobs().map((j) => base(j.outputPath!))).toEqual(['same.txt', 'same (1).txt', 'same (2).txt'])
  })

  it('one after another (concurrency 1) an overwrite batch still never reuses a name it produced', async () => {
    h = makeHarness(tmp.dir, { fileConcurrency: 1 })
    const files = ['x.txt', 'y.txt', 'z.txt'].map((n) => touch(join(src, n), n))
    const jobs = await addFiles({ paths: files, filePresetId: 'file-move-rename', output: { dir: out, nameTemplate: 'same', conflict: 'overwrite' } })
    const preview = await h.queue.previewFileOps(jobs.map((j) => j.id))
    await runAll()
    expect(h.queue.getJobs().map((j) => j.outputPath)).toEqual(preview.map((i) => i.target))
    expect(names(out)).toEqual(['same (1).txt', 'same (2).txt', 'same.txt'])
    expect([read(join(out, 'same.txt')), read(join(out, 'same (1).txt')), read(join(out, 'same (2).txt'))]).toEqual(['x.txt', 'y.txt', 'z.txt'])
    // a later run may overwrite (that is what the policy is for)
    touch(join(src, 'w.txt'), 'w.txt')
    const [w] = await addFiles({ paths: [join(src, 'w.txt')], output: { dir: out, nameTemplate: 'same', conflict: 'overwrite' } })
    expect((await h.queue.previewFileOps([w.id]))[0].status).toBe('overwrite')
    await runAll()
    expect(read(join(out, 'same.txt'))).toBe('w.txt')
  })

  it('conversions in one run never overwrite each other either', async () => {
    h = makeHarness(tmp.dir, { settings: { videoConcurrency: 1 } })
    touch(join(src, 'a.mp4'))
    touch(join(src, 'b.mp4'))
    await h.queue.addJobs({ paths: [join(src, 'a.mp4'), join(src, 'b.mp4')], output: { dir: out, nameTemplate: 'render', conflict: 'overwrite' } })
    await runAll()
    expect(names(out)).toEqual(['render (1).mp4', 'render.mp4'])
  })

  it('A→B while B is another pending job’s source: B is never overwritten', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.txt'), 'A')
    touch(join(src, 'b.txt'), 'B')
    const [j1] = await addFiles({ paths: [join(src, 'a.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'b', conflict: 'overwrite' } })
    const [j2] = await addFiles({ paths: [join(src, 'b.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'c' } })
    const preview = await h.queue.previewFileOps([j1.id, j2.id])
    expect(preview.map((i) => [i.status, base(i.target!)])).toEqual([
      ['renamed', 'b (1).txt'],
      ['ok', 'c.txt'],
    ])
    await runAll()
    expect(names(src)).toEqual(['b (1).txt', 'c.txt'])
    expect(read(join(src, 'b (1).txt'))).toBe('A')
    expect(read(join(src, 'c.txt'))).toBe('B')
    expect(h.queue.getJobs().map((j) => j.outputPath)).toEqual(preview.map((i) => i.target))
  })

  it('B→C then A→B: the second job waits until B has been moved away and takes the free name', async () => {
    // slow down the first rename so the second job really has to wait for it
    h = makeHarness(tmp.dir, {
      fileOps: {
        rename: async (from, to) => {
          if (base(from) === 'b.txt') await sleep(150)
          await fsRename(from, to)
        },
      },
    })
    touch(join(src, 'a.txt'), 'A')
    touch(join(src, 'b.txt'), 'B')
    const [j1] = await addFiles({ paths: [join(src, 'b.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'c' } })
    const [j2] = await addFiles({ paths: [join(src, 'a.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'b' } })
    const preview = await h.queue.previewFileOps([j1.id, j2.id])
    expect(preview.map((i) => [i.status, base(i.target!)])).toEqual([
      ['ok', 'c.txt'],
      ['ok', 'b.txt'],
    ])
    await runAll()
    expect(names(src)).toEqual(['b.txt', 'c.txt'])
    expect(read(join(src, 'b.txt'))).toBe('A')
    expect(read(join(src, 'c.txt'))).toBe('B')
    expect(h.queue.getJobs().map((j) => j.outputPath)).toEqual(preview.map((i) => i.target))
  })

  it('if the job freeing a name fails, the waiting job picks another name instead of clobbering', async () => {
    h = makeHarness(tmp.dir, {
      fileOps: {
        rename: async (from, to) => {
          if (base(from) === 'b.txt') {
            await sleep(100)
            const e = new Error('EINVAL: simulated failure') as NodeJS.ErrnoException
            e.code = 'EINVAL'
            throw e
          }
          await fsRename(from, to)
        },
      },
    })
    touch(join(src, 'a.txt'), 'A')
    touch(join(src, 'b.txt'), 'B')
    const [j1] = await addFiles({ paths: [join(src, 'b.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'c' } })
    const [j2] = await addFiles({ paths: [join(src, 'a.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'b', conflict: 'overwrite' } })
    await runAll()
    expect(job(j1.id).status).toBe('failed')
    expect(job(j2.id)).toMatchObject({ status: 'done', outputPath: join(src, 'b (1).txt') })
    expect(read(join(src, 'b.txt'))).toBe('B')
    expect(read(join(src, 'b (1).txt'))).toBe('A')
  })

  it('a 3-file rotation loses nothing and matches the preview', async () => {
    h = makeHarness(tmp.dir)
    for (const n of ['1', '2', '3']) touch(join(src, `${n}.txt`), n)
    const ids: string[] = []
    for (const [from, to] of [['1', '2'], ['2', '3'], ['3', '1']]) {
      const [j] = await addFiles({ paths: [join(src, `${from}.txt`)], filePresetId: 'file-rename', output: { nameTemplate: to } })
      ids.push(j.id)
    }
    const preview = await h.queue.previewFileOps(ids)
    expect(preview.map((i) => base(i.target!))).toEqual(['2 (1).txt', '3 (1).txt', '1.txt'])
    await runAll()
    expect(h.queue.getJobs().map((j) => j.outputPath)).toEqual(preview.map((i) => i.target))
    expect(read(join(src, '2 (1).txt'))).toBe('1')
    expect(read(join(src, '3 (1).txt'))).toBe('2')
    expect(read(join(src, '1.txt'))).toBe('3')
    // and the whole batch can be undone
    const res = await h.queue.undoFileOps()
    expect(res).toEqual({ restored: 3, failed: [] })
    expect(names(src)).toEqual(['1.txt', '2.txt', '3.txt'])
    for (const n of ['1', '2', '3']) expect(read(join(src, `${n}.txt`))).toBe(n)
  })

  it('a missing source fails the job with a clear message', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'gone.txt'))
    const [j] = await addFiles({ paths: [p], output: { dir: out } })
    rmSync(p)
    expect((await h.queue.previewFileOps([j.id]))[0]).toMatchObject({ status: 'skip', target: null })
    await runAll()
    expect(job(j.id).status).toBe('failed')
    expect(job(j.id).error).toMatch(/Source file not found/)
  })

  it('cross-volume move (EXDEV): copy + verify + delete, mtime kept, journaled and undoable', async () => {
    const calls: string[] = []
    h = makeHarness(tmp.dir, {
      fileOps: {
        rename: async (from, to) => {
          calls.push(`${base(from)}→${base(to)}`)
          if (resolve(dirname(from)).toLowerCase() !== resolve(dirname(to)).toLowerCase()) {
            const e = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
            e.code = 'EXDEV'
            throw e
          }
          await fsRename(from, to)
        },
      },
    })
    const p = join(src, '影片 big.bin')
    writeFileSync(p, Buffer.alloc(100_000, 7))
    const when = new Date(2019, 2, 3, 4, 5, 6)
    setMtime(p, when)
    const [j] = await addFiles({ paths: [p], filePresetId: 'file-move-rename', output: { dir: out, nameTemplate: 'moved {name}' } })
    await runAll()
    const target = join(out, 'moved 影片 big.bin')
    expect(job(j.id)).toMatchObject({ status: 'done', outputPath: target, encoder: 'move' })
    expect(existsSync(p)).toBe(false)
    expect(readFileSync(target)).toEqual(Buffer.alloc(100_000, 7))
    expect(Math.abs(statSync(target).mtimeMs - when.getTime())).toBeLessThan(2000)
    expect(names(out)).toEqual(['moved 影片 big.bin'])
    // first the direct rename (EXDEV), then temp → final inside the output folder
    expect(calls).toEqual(['影片 big.bin→moved 影片 big.bin', 'moved 影片 big.bin.mcpart→moved 影片 big.bin'])
    expect(h.queue.getFileOpUndo()).toMatchObject({ count: 1, operations: { move: 1, rename: 0 } })
    expect(await h.queue.undoFileOps()).toEqual({ restored: 1, failed: [] })
    expect(readFileSync(p)).toEqual(Buffer.alloc(100_000, 7))
    expect(existsSync(target)).toBe(false)
  })

  it('names from {exifdate}/{exiftime} (EXIF, fallback modified) and {mdate}', async () => {
    h = makeHarness(tmp.dir)
    const photo = touch(join(src, 'photo.jpg'))
    const doc = touch(join(src, 'doc.txt'))
    setMtime(photo, new Date(2023, 10, 11, 12, 13, 14))
    setMtime(doc, new Date(2019, 4, 6, 7, 8, 9))
    h.image.takenAt['photo.jpg'] = new Date(2020, 0, 2, 3, 4, 5).getTime()
    const jobs = await addFiles({ paths: [photo, doc], output: { dir: out, nameTemplate: '{exifdate}_{exiftime}_m{mdate}' } })
    const preview = await h.queue.previewFileOps(jobs.map((j) => j.id))
    expect(preview.map((i) => base(i.target!))).toEqual(['2019-05-06_070809_m2019-05-06.txt', '2020-01-02_030405_m2023-11-11.jpg'])
    await runAll()
    expect(names(out)).toEqual(['2019-05-06_070809_m2019-05-06.txt', '2020-01-02_030405_m2023-11-11.jpg'])
  })

  it('EXIF is only read when the template or the sort order needs it', async () => {
    h = makeHarness(tmp.dir)
    const photo = touch(join(src, 'photo.jpg'))
    await addFiles({ paths: [photo], output: { dir: out, nameTemplate: '{name}_{mdate}' } })
    await runAll()
    expect(h.image.takenReads).toEqual([])
  })

  it('sortBy taken defines {counter}', async () => {
    h = makeHarness(tmp.dir)
    for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) touch(join(src, n), n)
    h.image.takenAt['a.jpg'] = new Date(2022, 0, 3).getTime()
    h.image.takenAt['b.jpg'] = new Date(2022, 0, 1).getTime()
    h.image.takenAt['c.jpg'] = new Date(2022, 0, 2).getTime()
    const jobs = await addFiles({ paths: [src], sortBy: 'taken', output: { dir: out, nameTemplate: '{counter:2}_{name}' } })
    expect(jobs.map((j) => base(j.source))).toEqual(['b.jpg', 'c.jpg', 'a.jpg'])
    await runAll()
    expect(names(out)).toEqual(['01_b.jpg', '02_c.jpg', '03_a.jpg'])
  })
})

describe('interruptions', () => {
  it('stop during a batch: finished moves stay done (and undoable), the rest goes back to queued', async () => {
    h = makeHarness(tmp.dir, {
      fileConcurrency: 1,
      fileOps: {
        rename: async (from, to) => {
          await sleep(60)
          await fsRename(from, to)
        },
      },
    })
    for (const n of ['1.txt', '2.txt', '3.txt', '4.txt']) touch(join(src, n), n)
    const jobs = await addFiles({ paths: [src], filePresetId: 'file-rename', output: { nameTemplate: 'r{name}' } })
    h.queue.start()
    await waitFor(() => job(jobs[0].id).status === 'done', 3000, 'first rename')
    await h.queue.stop()
    const statuses = jobs.map((j) => job(j.id).status)
    expect(statuses[0]).toBe('done')
    // whatever was in flight when stop arrived either completed (done) or never touched its file (queued)
    for (const [i, j] of jobs.entries()) {
      const st = job(j.id)
      if (st.status === 'done') expect(existsSync(join(src, 'r' + base(j.source)))).toBe(true)
      else {
        expect(st.status).toBe('queued')
        expect(existsSync(j.source)).toBe(true)
      }
      expect(['done', 'queued']).toContain(statuses[i])
    }
    const done = statuses.filter((x) => x === 'done').length
    expect(h.queue.getFileOpUndo()).toMatchObject({ count: done })
    expect((await h.queue.undoFileOps()).restored).toBe(done)
    expect(names(src)).toEqual(['1.txt', '2.txt', '3.txt', '4.txt'])
  })

  it('restores a case-only rename interrupted by a crash, and cleans partial copies', async () => {
    h = makeHarness(tmp.dir)
    const p = touch(join(src, 'photo.jpg'), 'P')
    const c = touch(join(src, 'c.txt'), 'C')
    const [ren] = await addFiles({ paths: [p], filePresetId: 'file-rename', output: { nameTemplate: 'PHOTO' } })
    const [cp] = await addFiles({ paths: [c], output: { dir: out } })
    await h.store.flush()
    await h.queue.shutdown()
    // simulate a crash: the rename was between its two steps, the copy half written
    const file = join(tmp.dir, 'queue.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { jobs: Job[] }
    for (const j of saved.jobs) {
      j.status = 'running'
      j.outputPath = j.id === ren.id ? join(src, 'PHOTO.jpg') : join(out, 'c.txt')
    }
    writeFileSync(file, JSON.stringify(saved))
    const tmpName = join(src, `photo.jpg.${ren.id.slice(0, 8)}.mcrename`)
    await fsRename(p, tmpName)
    mkdirSync(out)
    writeFileSync(join(out, 'c.txt.mcpart'), 'PART')

    h = makeHarness(tmp.dir, { storeFile: file })
    await h.queue.init()
    expect(names(src)).toEqual(['c.txt', 'photo.jpg'])
    expect(read(p)).toBe('P')
    expect(names(out)).toEqual([])
    expect(h.queue.getJobs().map((j) => j.status)).toEqual(['queued', 'queued'])
    expect(job(cp.id).outputPath).toBeUndefined()
    await runAll()
    expect(names(src)).toEqual(['PHOTO.jpg', 'c.txt'])
    expect(names(out)).toEqual(['c.txt'])
  })
})

describe('preview', () => {
  it('is a pure dry run: nothing is created, moved or changed', async () => {
    h = makeHarness(tmp.dir)
    mkdirSync(join(src, 'sub 1'), { recursive: true })
    touch(join(src, 'a.txt'), 'A')
    touch(join(src, 'sub 1', 'b.txt'), 'B')
    touch(join(src, 'sub 1', 'c.jpg'), 'C')
    h.image.takenAt['c.jpg'] = new Date(2020, 0, 1).getTime()
    const moves = await addFiles({ paths: [src], recursive: true, filePresetId: 'file-move-rename', output: { dir: out, nameTemplate: '{exifdate}_{counter}' } })
    const renames = await addFiles({ paths: [src], recursive: true, filePresetId: 'file-rename', output: { nameTemplate: 'r_{name}' } })
    // (the queue's own JSON stores live in tmp.dir and may still be flushing: snapshot the user's folder)
    const before = snapshot(src)
    const queueBefore = JSON.stringify(h.queue.getJobs())
    const events = h.events.length
    const items: FileOpPreviewItem[] = await h.queue.previewFileOps([...moves, ...renames].map((j) => j.id))
    expect(items).toHaveLength(6)
    const rels = items.slice(0, 3).map((i) => relative(out, i.target!))
    expect(rels[0]).toMatch(/^\d{4}-\d{2}-\d{2}_1\.txt$/)
    expect(rels[1].startsWith(join('sub 1', ''))).toBe(true)
    expect(rels[1]).toMatch(/\d{4}-\d{2}-\d{2}_2\.txt$/)
    expect(rels[2]).toBe(join('sub 1', '2020-01-01_3.jpg'))
    expect(items.slice(3).map((i) => base(i.target!))).toEqual(['r_a.txt', 'r_b.txt', 'r_c.jpg'])
    expect(items.every((i) => i.status === 'ok')).toBe(true)
    expect(snapshot(src)).toEqual(before)
    expect(existsSync(out)).toBe(false)
    expect(JSON.stringify(h.queue.getJobs())).toBe(queueBefore)
    expect(h.events.length).toBe(events)
    expect(h.queue.isRunning()).toBe(false)
    // non-file and non-queued jobs are left out
    const { jobs: [video] } = await h.queue.addJobs({ paths: [join(src, 'sub 1', 'c.jpg')] })
    expect(await h.queue.previewFileOps([video.id, 'unknown'])).toEqual([])
  })

  it('accounts for running jobs’ reservations and pending sources outside the list', async () => {
    h = makeHarness(tmp.dir)
    h.ffmpeg.mode = 'manual'
    touch(join(src, 'clip.mp4'))
    touch(join(src, 'note.txt'))
    // a conversion is writing out/clip.mp4 right now
    await h.queue.addJobs({ paths: [join(src, 'clip.mp4')], output: { dir: out } })
    h.queue.start()
    await waitFor(() => h.ffmpeg.pending.length === 1, 3000, 'encode')
    const [j] = await addFiles({ paths: [join(src, 'note.txt')], output: { dir: out, nameTemplate: 'clip' } })
    // different extension → no clash; same name + extension → reserved
    expect((await h.queue.previewFileOps([j.id]))[0]).toMatchObject({ status: 'ok', target: join(out, 'clip.txt') })
    const [k] = await addFiles({ paths: [join(src, 'clip.mp4')], output: { dir: out, nameTemplate: 'clip' } })
    expect((await h.queue.previewFileOps([k.id]))[0]).toMatchObject({ status: 'renamed', target: join(out, 'clip (1).mp4') })
    h.ffmpeg.releaseAll()
    await waitFor(() => !h.queue.isRunning(), 3000, 'run end')
  })
})

describe('undo', () => {
  it('restores the latest move/rename batch in reverse order, then forgets it', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'x.txt'), 'X')
    touch(join(src, 'y.txt'), 'Y')
    await addFiles({ paths: [src], filePresetId: 'file-rename', output: { nameTemplate: 'renamed_{name}' } })
    await runAll()
    const info = h.queue.getFileOpUndo()!
    expect(info).toMatchObject({ count: 2, operations: { move: 0, rename: 2 } })
    expect(info.finishedAt).toBeGreaterThan(0)
    // persisted in the journal file
    await h.journal.flush()
    const disk = JSON.parse(readFileSync(join(tmp.dir, 'file-ops-journal.json'), 'utf8')) as FileOpJournal
    expect(disk.runs).toHaveLength(1)
    // completion order (jobs run in parallel)
    expect(disk.runs[0].entries.map((e) => [base(e.from), base(e.to), e.op]).sort()).toEqual([
      ['x.txt', 'renamed_x.txt', 'rename'],
      ['y.txt', 'renamed_y.txt', 'rename'],
    ])
    expect(await h.queue.undoFileOps()).toEqual({ restored: 2, failed: [] })
    expect(names(src)).toEqual(['x.txt', 'y.txt'])
    expect(h.queue.getFileOpUndo()).toBeNull()
    expect(await h.queue.undoFileOps()).toEqual({ restored: 0, failed: [] })
    await h.journal.flush()
    expect((JSON.parse(readFileSync(join(tmp.dir, 'file-ops-journal.json'), 'utf8')) as FileOpJournal).runs).toEqual([])
  })

  it('earlier batches stay undoable one after another; journal survives a restart', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.txt'), 'A')
    await addFiles({ paths: [join(src, 'a.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'b' } })
    await runAll()
    await addFiles({ paths: [join(src, 'b.txt')], filePresetId: 'file-move-rename', output: { dir: out, nameTemplate: 'c' } })
    await runAll()
    expect(h.queue.getFileOpUndo()).toMatchObject({ count: 1, operations: { move: 1, rename: 0 } })
    await h.queue.shutdown()

    const h2 = makeHarness(tmp.dir, { storeFile: join(tmp.dir, 'queue2.json') })
    try {
      expect(h2.queue.getFileOpUndo()).toMatchObject({ operations: { move: 1 } })
      expect((await h2.queue.undoFileOps()).restored).toBe(1)
      expect(read(join(src, 'b.txt'))).toBe('A')
      expect(h2.queue.getFileOpUndo()).toMatchObject({ operations: { rename: 1 } })
      expect((await h2.queue.undoFileOps()).restored).toBe(1)
      expect(names(src)).toEqual(['a.txt'])
      expect(h2.queue.getFileOpUndo()).toBeNull()
    } finally {
      await h2.queue.shutdown()
    }
  })

  it('skips and reports files that are gone or whose original place is taken', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'p.txt'), 'P')
    touch(join(src, 'q.txt'), 'Q')
    touch(join(src, 'r.txt'), 'R')
    await addFiles({ paths: [src], filePresetId: 'file-rename', output: { nameTemplate: 'n_{name}' } })
    await runAll()
    rmSync(join(src, 'n_p.txt'))
    touch(join(src, 'q.txt'), 'NEW Q')
    const res = await h.queue.undoFileOps()
    expect(res.restored).toBe(1)
    expect(res.failed.map((f) => base(f.path)).sort()).toEqual(['n_p.txt', 'n_q.txt'])
    expect(res.failed.find((f) => base(f.path) === 'n_q.txt')!.error).toMatch(/original location/)
    expect(read(join(src, 'q.txt'))).toBe('NEW Q')
    expect(read(join(src, 'n_q.txt'))).toBe('Q')
    expect(read(join(src, 'r.txt'))).toBe('R')
    expect(h.queue.getFileOpUndo()).toBeNull()
  })

  it('a finished-notification still arrives for file runs', async () => {
    h = makeHarness(tmp.dir)
    touch(join(src, 'a.txt'))
    await addFiles({ paths: [join(src, 'a.txt')], output: { dir: out } })
    await runAll()
    await waitFor(() => !h.queue.isRunning(), 2000, 'run end')
    const finished = h.events.filter((e): e is Extract<QueueEvent, { type: 'finished' }> => e.type === 'finished')
    expect(finished.at(-1)!.summary).toEqual({ done: 1, failed: 0, cancelled: 0, skipped: 0 })
  })
})

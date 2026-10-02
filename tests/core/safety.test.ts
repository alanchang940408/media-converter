// Data-safety regressions: never clobber a file the user did not ask to replace, preview == run, careful undo,
// damaged stores (real file system, fake engines).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relocate, isReplacedFile, nodeFileOps } from '../../src/main/queue/fileOps'
import { parseJournal } from '../../src/main/queue/journal'
import { parseWatchFolderFile } from '../../src/main/watch/WatchManager'
import type { AddJobsRequest, Job } from '../../src/shared/types'
import { makeHarness, makeTempDir, touch, waitFor, type Harness } from './helpers'

let tmp: { dir: string; cleanup: () => void }
let h: Harness | undefined
let src: string
let out: string

beforeEach(() => {
  tmp = makeTempDir('mc-safety-')
  src = join(tmp.dir, 'src 素材')
  out = join(tmp.dir, 'out 輸出')
  mkdirSync(src, { recursive: true })
  h = undefined
})

afterEach(async () => {
  await h?.queue.shutdown()
  tmp.cleanup()
})

const read = (p: string): string => readFileSync(p, 'utf8')
const base = (p: string): string => p.split(/[\\/]/).pop()!
const settled = (q: Harness): boolean => q.queue.getJobs().every((j) => ['done', 'failed', 'cancelled', 'skipped'].includes(j.status))
const jobOf = (q: Harness, id: string): Job => q.queue.getJobs().find((j) => j.id === id)!

async function addFiles(q: Harness, req: Partial<AddJobsRequest> & { paths: string[] }): Promise<Job[]> {
  return (await q.queue.addJobs({ filePresetId: 'file-copy-rename', ...req })).jobs
}

describe('conversions never clobber what they must not', () => {
  it("policy 'skip': a file that appears while encoding is left alone and the job is skipped", async () => {
    const q = (h = makeHarness(tmp.dir, { settings: { autoStart: false } }))
    q.image.mode = 'manual'
    touch(join(src, 'a.jpg'), 'SOURCE')
    const [j] = (
      await q.queue.addJobs({ paths: [join(src, 'a.jpg')], imagePresetId: 'img-jpeg-q90', output: { dir: out, nameTemplate: '{name}', conflict: 'skip' } })
    ).jobs
    q.queue.start()
    await waitFor(() => q.image.pending.length === 1, 5000, 'image job to start')
    mkdirSync(out, { recursive: true })
    touch(join(out, 'a.jpg'), 'USER FILE')
    q.image.releaseAll()
    await waitFor(() => settled(q), 5000, 'job to settle')
    expect(jobOf(q, j.id)).toMatchObject({ status: 'skipped', outputPath: join(out, 'a.jpg') })
    expect(read(join(out, 'a.jpg'))).toBe('USER FILE')
    expect(readdirSync(out)).toEqual(['a.jpg'])
  })

  it("policy 'overwrite' never replaces the source reached through another path (junction / symlinked folder)", async () => {
    const q = (h = makeHarness(tmp.dir, { settings: { autoStart: false } }))
    touch(join(src, 'a.jpg'), 'SOURCE')
    const alias = join(tmp.dir, 'alias 別名')
    symlinkSync(src, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const [j] = (
      await q.queue.addJobs({ paths: [join(src, 'a.jpg')], imagePresetId: 'img-jpeg-q90', output: { dir: alias, nameTemplate: '{name}', conflict: 'overwrite' } })
    ).jobs
    q.queue.start()
    await waitFor(() => settled(q), 5000, 'job to settle')
    expect(read(join(src, 'a.jpg'))).toBe('SOURCE')
    expect(jobOf(q, j.id)).toMatchObject({ status: 'done', outputPath: join(alias, 'a (1).jpg') })
    expect(read(join(src, 'a (1).jpg'))).toMatch(/^IMAGE /)
  })
})

describe('file operations', () => {
  it.runIf(process.platform === 'win32')('a "case-only" rename never replaces a different file that only our key folds together', async () => {
    // NTFS keeps "\u212A" (Kelvin sign) and "k" apart; toLowerCase() does not
    const kelvin = touch(join(src, '\u212Aelvin.txt'), 'KELVIN')
    const plain = touch(join(src, 'kelvin.txt'), 'PLAIN')
    expect(readdirSync(src)).toHaveLength(2)
    await expect(relocate(nodeFileOps, kelvin, plain, { tag: 'test1234' })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(read(kelvin)).toBe('KELVIN')
    expect(read(plain)).toBe('PLAIN')
    expect(readdirSync(src)).toHaveLength(2)
  })

  it('the preview of new jobs assumes only they run: a queued file job ahead of them neither claims a name nor frees one', async () => {
    const q = (h = makeHarness(tmp.dir))
    touch(join(src, 'x.txt'), 'X')
    touch(join(src, 'y.txt'), 'Y')
    const output = { dir: out, nameTemplate: 'same', conflict: 'rename' as const }
    const [earlier] = await addFiles(q, { paths: [join(src, 'x.txt')], output })
    const [later] = await addFiles(q, { paths: [join(src, 'y.txt')], output })
    const preview = await q.queue.previewFileOps([later.id])
    expect(preview).toHaveLength(1)
    expect(preview[0]).toMatchObject({ jobId: later.id, status: 'ok' })
    expect(base(preview[0].target!)).toBe('same.txt')
    q.queue.start(false, [later.id])
    await waitFor(() => jobOf(q, later.id).status === 'done', 5000, 'chosen job')
    expect(jobOf(q, later.id).outputPath).toBe(preview[0].target)
    expect(jobOf(q, earlier.id).status).toBe('queued')
    expect(read(join(out, 'same.txt'))).toBe('Y')
    // a plain start later runs the waiting job too: it takes the next free name
    q.queue.start()
    await waitFor(() => settled(q), 5000, 'file jobs to settle')
    expect(read(join(out, 'same (1).txt'))).toBe('X')
  })

  it('in a running queue, the preview accounts for file jobs of that run still waiting ahead of the new ones', async () => {
    const q = (h = makeHarness(tmp.dir, {
      fileConcurrency: 1,
      fileOps: {
        rename: async (from, to) => {
          if (base(from) === 's.txt') await new Promise((r) => setTimeout(r, 600))
          await nodeFileOps.rename(from, to)
        },
      },
    }))
    for (const n of ['s', 'x', 'y']) touch(join(src, `${n}.txt`), n.toUpperCase())
    const output = { dir: out, nameTemplate: 'same', conflict: 'rename' as const }
    const [slow] = await addFiles(q, { paths: [join(src, 's.txt')], filePresetId: 'file-rename', output: { nameTemplate: 'n_s' } })
    const [earlier] = await addFiles(q, { paths: [join(src, 'x.txt')], output })
    q.queue.start()
    await waitFor(() => jobOf(q, slow.id).status === 'running', 2000, 'slow job running')
    const [later] = await addFiles(q, { paths: [join(src, 'y.txt')], output })
    const preview = await q.queue.previewFileOps([later.id])
    // the earlier job is part of the running queue (only waiting for a free slot) → it gets "same.txt" first
    expect(jobOf(q, earlier.id).status).toBe('queued')
    expect(preview[0]).toMatchObject({ jobId: later.id, status: 'renamed' })
    expect(base(preview[0].target!)).toBe('same (1).txt')
    q.queue.start(false, [later.id])
    await waitFor(() => settled(q), 5000, 'file jobs to settle')
    expect(jobOf(q, later.id).outputPath).toBe(preview[0].target)
    expect(read(join(out, 'same.txt'))).toBe('X')
    expect(read(join(out, 'same (1).txt'))).toBe('Y')
  })

  it('undo leaves a different file that took the name alone, but still restores an edited one', async () => {
    const q = (h = makeHarness(tmp.dir))
    touch(join(src, 'a.txt'), 'A')
    touch(join(src, 'b.txt'), 'B')
    await addFiles(q, { paths: [src], filePresetId: 'file-rename', output: { nameTemplate: 'n_{name}' } })
    q.queue.start()
    await waitFor(() => settled(q), 5000, 'renames to settle')
    // n_a.txt is replaced by another file; n_b.txt is only edited in place
    rmSync(join(src, 'n_a.txt'))
    touch(join(src, 'n_a.txt'), 'SOMETHING ELSE')
    const old = new Date(2015, 0, 1)
    utimesSync(join(src, 'n_a.txt'), old, old)
    writeFileSync(join(src, 'n_b.txt'), 'B edited')
    const res = await q.queue.undoFileOps()
    expect(res.restored).toBe(1)
    expect(res.failed.map((f) => base(f.path))).toEqual(['n_a.txt'])
    expect(read(join(src, 'n_a.txt'))).toBe('SOMETHING ELSE')
    expect(existsSync(join(src, 'a.txt'))).toBe(false)
    expect(read(join(src, 'b.txt'))).toBe('B edited')
  })

  it('a changed file id alone (FAT / exFAT renames) does not block undo; ids unknown → no check', () => {
    const rec = { fileId: '1:2', size: 5, mtimeMs: 1000 }
    expect(isReplacedFile(rec, { fileId: '1:3', size: 5, mtimeMs: 1500 })).toBe(false)
    expect(isReplacedFile(rec, { fileId: '1:3', size: 6, mtimeMs: 1000 })).toBe(true)
    expect(isReplacedFile(rec, { fileId: '1:2', size: 6, mtimeMs: 9000 })).toBe(false)
    expect(isReplacedFile({ size: 5, mtimeMs: 1000 }, { fileId: '1:3', size: 6, mtimeMs: 1000 })).toBe(false)
    // the stamp survives a journal round trip
    const parsed = parseJournal({ runs: [{ id: 'r', startedAt: 1, finishedAt: 2, entries: [{ from: 'a', to: 'b', op: 'move', ...rec }] }] })
    expect(parsed?.runs[0].entries[0]).toEqual({ from: 'a', to: 'b', op: 'move', ...rec })
  })
})

describe('damaged stores', () => {
  it('queue.json entries that are not jobs are dropped instead of breaking the app', async () => {
    const file = join(tmp.dir, 'queue-bad.json')
    const good: Job = {
      id: 'good',
      kind: 'file',
      source: join(src, 'a.txt'),
      presetId: 'file-copy-rename',
      presetName: 'x',
      file: { operation: 'copy' },
      output: { dir: out, nameTemplate: '{name}', conflict: 'rename' },
      status: 'queued',
      progress: 0,
      createdAt: 1,
    }
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobs: [null, 7, { id: 'x', source: 'y' }, { ...good, id: 'no-output', output: null }, { ...good, id: 'bad-kind', kind: 'zip' }, good],
      }),
    )
    touch(join(src, 'a.txt'), 'A')
    const q = (h = makeHarness(tmp.dir, { storeFile: file }))
    expect(q.queue.getJobs().map((j) => j.id)).toEqual(['good'])
    expect(await q.queue.previewFileOps(['good'])).toHaveLength(1)
  })

  it('watch-folders.json: junk entries are dropped', () => {
    expect(parseWatchFolderFile({ folders: 'nope' })).toBeNull()
    const f = parseWatchFolderFile({ folders: [null, 3, { id: 'a' }, { id: 'b', path: 'C:\\x', presetIds: 'bad' }] })
    expect(f?.folders).toEqual([{ id: 'b', path: 'C:\\x', presetIds: [] }])
  })
})

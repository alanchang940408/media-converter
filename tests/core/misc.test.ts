import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { t } from '../../src/main/i18n'
import { JsonStore } from '../../src/main/jsonStore'
import { handleMediaRequest, parseRange, pathFromMediaUrl } from '../../src/main/mediaResponse'
import { pathKey, resolveOutputPath } from '../../src/main/queue/outputPath'
import { defaultSettings, resolveLocale, sanitizeSettings, SettingsManager } from '../../src/main/settings'
import { ThumbnailService } from '../../src/main/thumbnails'
import type { AppSettings } from '../../src/shared/types'
import { FakeFfmpeg, FakeImage, makeTempDir, touch } from './helpers'

let tmp: { dir: string; cleanup: () => void }
beforeEach(() => {
  tmp = makeTempDir('mc-misc-')
})
afterEach(() => tmp.cleanup())

describe('resolveOutputPath', () => {
  const base = { baseName: 'a', ext: 'mp4', reserved: new Set<string>() }

  it('handles rename / overwrite / skip and never returns the source or a reserved path', () => {
    const dir = tmp.dir
    const src = join(dir, 'src.mov')
    touch(join(dir, 'a.mp4'))
    touch(join(dir, 'a (1).mp4'))
    expect(resolveOutputPath({ ...base, dir, conflict: 'rename', source: src }).path).toBe(join(dir, 'a (2).mp4'))
    expect(resolveOutputPath({ ...base, dir, conflict: 'overwrite', source: src })).toEqual({ path: join(dir, 'a.mp4'), skip: false })
    expect(resolveOutputPath({ ...base, dir, conflict: 'skip', source: src })).toEqual({ path: join(dir, 'a.mp4'), skip: true })
    expect(resolveOutputPath({ ...base, baseName: 'b', dir, conflict: 'skip', source: src })).toEqual({ path: join(dir, 'b.mp4'), skip: false })

    // source == target → forced rename even for overwrite/skip
    const self = join(dir, 'a.mp4')
    for (const conflict of ['overwrite', 'skip', 'rename'] as const) {
      const r = resolveOutputPath({ ...base, dir, conflict, source: self })
      expect(r.skip).toBe(false)
      expect(r.path).toBe(join(dir, 'a (2).mp4'))
    }
    // case-insensitive source comparison on Windows/macOS
    if (process.platform === 'win32') {
      const r = resolveOutputPath({ ...base, dir, conflict: 'overwrite', source: join(dir, 'A.MP4') })
      expect(r.path).toBe(join(dir, 'a (2).mp4'))
    }
    // reserved by a running job
    const reserved = new Set([pathKey(join(dir, 'c.mp4')), pathKey(join(dir, 'c (1).mp4'))])
    expect(resolveOutputPath({ ...base, baseName: 'c', dir, conflict: 'overwrite', source: src, reserved }).path).toBe(join(dir, 'c (2).mp4'))
    expect(resolveOutputPath({ ...base, baseName: 'c', dir, conflict: 'skip', source: src, reserved }).skip).toBe(true)
  })
})

describe('media:// responses', () => {
  let file: string
  beforeEach(() => {
    file = join(tmp.dir, '影片 clip.mp4')
    writeFileSync(file, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
  })
  const url = (p: string): string => 'media://local/' + encodeURIComponent(p)

  it('parses URLs and ranges', () => {
    expect(pathFromMediaUrl(url(file))).toBe(file)
    expect(pathFromMediaUrl('media://local/relative.mp4')).toBeNull()
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 })
    expect(parseRange('bytes=1000-', 1000)).toBeNull()
    expect(parseRange('bytes=5-1', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
  })

  it('serves full files and 206 partial content', async () => {
    const full = await handleMediaRequest(new Request(url(file)))
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-length')).toBe('1000')
    expect(Buffer.from(await full.arrayBuffer()).length).toBe(1000)

    const part = await handleMediaRequest(new Request(url(file), { headers: { Range: 'bytes=100-199' } }))
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(part.headers.get('content-length')).toBe('100')
    const body = Buffer.from(await part.arrayBuffer())
    expect(body.length).toBe(100)
    expect(body[0]).toBe(100)
    expect(body[99]).toBe(199)

    const tail = await handleMediaRequest(new Request(url(file), { headers: { Range: 'bytes=-10' } }))
    expect(tail.status).toBe(206)
    expect(Buffer.from(await tail.arrayBuffer())[9]).toBe(999 % 256)

    const bad = await handleMediaRequest(new Request(url(file), { headers: { Range: 'bytes=5000-' } }))
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe('bytes */1000')
  })

  it('refuses unsupported types and reports missing files', async () => {
    const secret = touch(join(tmp.dir, 'secret.txt'), 'nope')
    expect((await handleMediaRequest(new Request(url(secret)))).status).toBe(403)
    expect((await handleMediaRequest(new Request(url(join(tmp.dir, 'missing.mp4'))))).status).toBe(404)
  })
})

describe('settings', () => {
  it('defaults match the spec', () => {
    const d = defaultSettings()
    expect(d).toMatchObject({
      language: 'auto',
      theme: 'dark',
      videoConcurrency: 1,
      autoStart: false,
      defaultOutputDir: null,
      defaultNameTemplate: '{name}',
      conflict: 'rename',
      preferredHw: 'auto',
      lastVideoPresetId: 'h264-match',
      lastImagePresetId: 'img-jpeg-q90',
      lastFilePresetId: 'file-copy-rename',
      preserveStructure: true,
      notifyOnFinish: true,
      preventSleep: true,
      removeFinished: false,
      ffmpegPath: null,
    })
    expect(d.imageConcurrency).toBeGreaterThanOrEqual(1)
    expect(d.imageConcurrency).toBeLessThanOrEqual(4)
  })

  it('sanitizes patches and resolves the locale', () => {
    const s = sanitizeSettings({ videoConcurrency: 99, imageConcurrency: 0, theme: 'neon', conflict: 'skip', defaultNameTemplate: '  ' } as unknown as Partial<AppSettings>)
    expect(s.videoConcurrency).toBe(4)
    expect(s.imageConcurrency).toBe(1)
    expect(s.theme).toBe('dark')
    expect(s.conflict).toBe('skip')
    expect(s.defaultNameTemplate).toBe('{name}')
    // new fields: kept when valid, defaults otherwise (older settings files lack them)
    expect(sanitizeSettings({ lastFilePresetId: 'file-rename', preserveStructure: false })).toMatchObject({
      lastFilePresetId: 'file-rename',
      preserveStructure: false,
    })
    expect(sanitizeSettings({ lastFilePresetId: '  ', preserveStructure: 'yes' } as unknown as Partial<AppSettings>)).toMatchObject({
      lastFilePresetId: 'file-copy-rename',
      preserveStructure: true,
    })
    const legacy = { ...defaultSettings() } as Partial<AppSettings>
    delete legacy.lastFilePresetId
    delete legacy.preserveStructure
    expect(sanitizeSettings(legacy)).toMatchObject({ lastFilePresetId: 'file-copy-rename', preserveStructure: true })
    expect(resolveLocale('auto', 'zh-HK')).toBe('zh-TW')
    expect(resolveLocale('auto', 'ja-JP')).toBe('ja')
    expect(resolveLocale('auto', 'de-DE')).toBe('en')
    expect(resolveLocale('en', 'ja-JP')).toBe('en')
  })

  it('SettingsManager persists, applies theme and notifies listeners', async () => {
    const file = join(tmp.dir, 'settings.json')
    const themes: string[] = []
    const store = new JsonStore<AppSettings>(file, defaultSettings, { debounceMs: 5, parse: (raw) => sanitizeSettings(raw) })
    const m = new SettingsManager(store, { systemLocale: () => 'ja-JP', applyTheme: (th) => themes.push(th) })
    expect(m.locale()).toBe('ja')
    const changes: string[][] = []
    m.onChange((_n, _p, changed) => changes.push(changed))
    m.patch({ theme: 'light', videoConcurrency: 2 })
    m.patch({ theme: 'light' })
    expect(themes).toEqual(['dark', 'light'])
    expect(changes).toEqual([['theme', 'videoConcurrency']])
    m.patch({ language: 'en' })
    expect(t('notify.finishedTitle')).toBe('Queue finished')
    await store.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ theme: 'light', videoConcurrency: 2, language: 'en' })
  })
})

describe('JsonStore', () => {
  it('writes atomically and debounces', async () => {
    const file = join(tmp.dir, 'nested', 'data.json')
    const store = new JsonStore<{ n: number }>(file, () => ({ n: 0 }), { debounceMs: 20 })
    for (let i = 1; i <= 5; i++) store.set({ n: i })
    expect(existsSync(file)).toBe(false)
    await store.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 5 })
    expect(readdirSync(join(tmp.dir, 'nested'))).toEqual(['data.json'])
    expect(new JsonStore<{ n: number }>(file, () => ({ n: 0 })).get()).toEqual({ n: 5 })
  })
})

describe('ThumbnailService', () => {
  it('returns data URLs, caches by path+size+mtime and skips audio', async () => {
    const ffmpeg = new FakeFfmpeg()
    const image = new FakeImage()
    let thumbs = 0
    let frames = 0
    image.thumbnail = async () => {
      thumbs++
      return Buffer.from('T')
    }
    ffmpeg.extractFrame = async () => {
      frames++
      return Buffer.from('F')
    }
    const svc = new ThumbnailService(ffmpeg, image, 2)
    const img = touch(join(tmp.dir, 'a.jpg'))
    const vid = touch(join(tmp.dir, 'b.mp4'))
    const aud = touch(join(tmp.dir, 'c.mp3'))
    expect(await svc.get(img)).toBe(`data:image/jpeg;base64,${Buffer.from('T').toString('base64')}`)
    await svc.get(img)
    expect(thumbs).toBe(1)
    expect(await svc.get(vid, 200)).toMatch(/^data:image\/jpeg;base64,/)
    expect(frames).toBe(1)
    expect(await svc.get(aud)).toBeNull()
    expect(await svc.get(join(tmp.dir, 'missing.jpg'))).toBeNull()
    // LRU of 2: img(160) evicted after two other entries
    await svc.get(img, 64)
    await svc.get(vid, 200)
    await svc.get(img)
    expect(thumbs).toBe(3)
  })
})

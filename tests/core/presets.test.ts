import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../../src/main/jsonStore'
import { BUILTIN_PRESETS, getBuiltinPreset } from '../../src/main/presets/builtin'
import { emptyPresetFile, normalizePreset, parsePresetFile, PresetStore, type PresetFile } from '../../src/main/presets/store'
import type { FilePreset, ImagePreset, Preset, VideoPreset } from '../../src/shared/types'
import { validateVideoSettings } from '../../src/shared/videoRules'
import { makeTempDir } from './helpers'

const VIDEO_IDS = [
  'h264-match', 'h264-1080p', 'h264-720p', 'h264-4k', 'youtube-1080p', 'social-vertical-1080x1920', 'social-square-1080',
  'h264-proxy-720p', 'hevc-match', 'hevc-4k-10bit', 'av1-match', 'webm-vp9-1080p', 'prores-422', 'prores-422-hq',
  'prores-422-proxy', 'prores-4444', 'dnxhr-hq', 'remux-mp4', 'gif-480', 'gif-720-hq', 'audio-mp3-320', 'audio-mp3-192',
  'audio-aac-256', 'audio-wav', 'audio-flac',
]
const IMAGE_IDS = [
  'img-jpeg-q90', 'img-web-2048-webp', 'img-png', 'img-avif', 'img-thumb-512', 'img-square-1080', 'img-portrait-1080x1350',
  'img-tiff-archive', 'img-half', 'img-grayscale',
]

let tmp: { dir: string; cleanup: () => void }
let file: string
let store: JsonStore<PresetFile>
let presets: PresetStore

beforeEach(() => {
  tmp = makeTempDir('mc-presets-')
  file = join(tmp.dir, 'presets.json')
  store = new JsonStore<PresetFile>(file, emptyPresetFile, { debounceMs: 5, parse: parsePresetFile })
  presets = new PresetStore(store, () => 'zh-TW')
})

afterEach(() => tmp.cleanup())

describe('built-in presets', () => {
  it('has every required id with the right kind, localized names and valid settings', () => {
    expect(BUILTIN_PRESETS.filter((p) => p.kind === 'video').map((p) => p.id)).toEqual(VIDEO_IDS)
    expect(BUILTIN_PRESETS.filter((p) => p.kind === 'image').map((p) => p.id)).toEqual(IMAGE_IDS)
    expect(BUILTIN_PRESETS.filter((p) => p.kind === 'file').map((p) => [p.id, (p as FilePreset).operation, p.category])).toEqual([
      ['file-copy-rename', 'copy', 'file'],
      ['file-rename', 'rename', 'file'],
      ['file-move-rename', 'move', 'file'],
    ])
    for (const p of BUILTIN_PRESETS) {
      expect(p.builtIn).toBe(true)
      expect(p.names?.['zh-TW'] && p.names?.en && p.names?.ja).toBeTruthy()
      expect(p.descriptions?.['zh-TW'] && p.descriptions?.en && p.descriptions?.ja).toBeTruthy()
      if (p.kind === 'video') {
        expect(p.settings.video.hw).toBe('auto')
        expect(validateVideoSettings(p.settings).filter((i) => i.level === 'error')).toEqual([])
      }
    }
    const ids = BUILTIN_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matches the specified key settings', () => {
    const v = (id: string): VideoPreset => getBuiltinPreset(id) as VideoPreset
    const i = (id: string): ImagePreset => getBuiltinPreset(id) as ImagePreset
    expect(v('h264-match').settings).toMatchObject({
      container: 'mp4',
      faststart: true,
      video: { codec: 'h264', rate: { mode: 'crf', crf: 20 }, speed: 'balanced', width: null, height: null },
      audio: { codec: 'aac', bitrateKbps: 192 },
    })
    expect(v('youtube-1080p').settings.video.rate).toMatchObject({ mode: 'vbr', bitrateKbps: 10000 })
    expect(v('social-vertical-1080x1920').settings.video).toMatchObject({ width: 1080, height: 1920, scaleMode: 'crop' })
    expect(v('social-square-1080').settings.video).toMatchObject({ width: 1080, height: 1080, scaleMode: 'crop' })
    expect(v('h264-proxy-720p').settings.video).toMatchObject({ speed: 'fast', rate: { mode: 'crf', crf: 26 } })
    expect(v('hevc-4k-10bit').settings.video).toMatchObject({ codec: 'hevc', tenBit: true, width: 3840, height: 2160 })
    expect(v('webm-vp9-1080p').settings).toMatchObject({ container: 'webm', video: { codec: 'vp9' }, audio: { codec: 'opus' } })
    expect(v('remux-mp4').settings).toMatchObject({ video: { codec: 'copy' }, audio: { codec: 'copy' } })
    expect(v('gif-480').settings.video.gif).toEqual({ fps: 15, width: 480, colors: 256, dither: 'sierra2_4a', loop: 0 })
    expect(v('gif-720-hq').settings.video.gif).toMatchObject({ fps: 24, width: 720 })
    expect(v('prores-4444').settings.video.profile).toBe('4444')
    expect(v('dnxhr-hq').settings.video).toMatchObject({ codec: 'dnxhr', profile: 'hq' })
    expect(v('audio-aac-256').settings).toMatchObject({ container: 'm4a', audio: { codec: 'aac', bitrateKbps: 256 } })
    expect(i('img-jpeg-q90').actions.map((a) => a.type)).toEqual(['autoOrient'])
    expect(i('img-jpeg-q90').output).toMatchObject({ format: 'jpeg', quality: 90 })
    expect(i('img-web-2048-webp').output).toMatchObject({ format: 'webp', quality: 82 })
    expect(i('img-avif').output).toMatchObject({ format: 'avif', quality: 60 })
    expect(i('img-thumb-512').actions.map((a) => a.type)).toEqual(['autoOrient', 'resize', 'sharpen'])
    expect(i('img-square-1080').actions[1]).toMatchObject({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity: 'attention' })
    expect(i('img-portrait-1080x1350').actions[2]).toMatchObject({ type: 'resize', width: 1080, height: 1350 })
    expect(i('img-tiff-archive').output).toMatchObject({ format: 'tiff', keepMetadata: true, lossless: true })
    expect(i('img-half').actions[0]).toMatchObject({ type: 'resize', mode: 'percent', percent: 50 })
    expect(i('img-half').output.format).toBe('keep')
    expect(i('img-grayscale').actions[0].type).toBe('grayscale')
    const actionIds = BUILTIN_PRESETS.flatMap((p) => (p.kind === 'image' ? p.actions.map((a) => a.id) : []))
    expect(new Set(actionIds).size).toBe(actionIds.length)
  })
})

describe('PresetStore', () => {
  it('saving a built-in creates a user copy and leaves the built-in untouched', async () => {
    const builtin = getBuiltinPreset('h264-1080p') as VideoPreset
    const edited = structuredClone(builtin)
    edited.settings.video.rate = { mode: 'crf', crf: 18 }
    const saved = presets.save(edited) as VideoPreset
    expect(saved.id).not.toBe('h264-1080p')
    expect(saved.builtIn).toBe(false)
    expect(saved.name).toBe('H.264 MP4 1080p（副本）')
    expect(saved.names).toBeUndefined()
    expect(saved.settings.video.rate).toEqual({ mode: 'crf', crf: 18 })
    expect((presets.get('h264-1080p') as VideoPreset).settings.video.rate).toEqual({ mode: 'crf', crf: 20 })
    expect(presets.list().filter((p) => !p.builtIn)).toHaveLength(1)

    // update in place
    const again = presets.save({ ...saved, name: 'My 1080p' })
    expect(again.id).toBe(saved.id)
    expect(presets.list().filter((p) => !p.builtIn).map((p) => p.name)).toEqual(['My 1080p'])

    // persisted
    await store.flush()
    const reloaded = new PresetStore(new JsonStore<PresetFile>(file, emptyPresetFile, { parse: parsePresetFile }))
    expect(reloaded.get(saved.id)?.name).toBe('My 1080p')
  })

  it('creates a new id for presets without one and refuses to delete built-ins', () => {
    const img = structuredClone(getBuiltinPreset('img-png') as ImagePreset)
    const p = presets.save({ ...img, id: '', name: 'PNG small' })
    expect(p.id).toMatch(/^user-/)
    expect(() => presets.delete('img-png')).toThrow()
    presets.delete(p.id)
    expect(presets.get(p.id)).toBeUndefined()
  })

  it('exports { app, version, presets } and re-imports with fresh ids on collision', () => {
    const mine = presets.save({ ...structuredClone(getBuiltinPreset('h264-720p') as VideoPreset), id: '', name: 'Mine' })
    const json = presets.exportJson([mine.id, 'img-avif', 'does-not-exist'])
    const data = JSON.parse(json) as { app: string; version: number; presets: Preset[] }
    expect(data.app).toBe('media-converter')
    expect(data.version).toBe(1)
    expect(data.presets.map((p) => p.id)).toEqual([mine.id, 'img-avif'])
    expect(data.presets.every((p) => p.builtIn === false)).toBe(true)

    const imported = presets.importJson(json)
    expect(imported).toHaveLength(2)
    expect(imported[0].id).not.toBe(mine.id)
    expect(imported[1].id).not.toBe('img-avif')
    expect(imported.every((p) => !p.builtIn)).toBe(true)
    expect(new Set(presets.list().map((p) => p.id)).size).toBe(presets.list().length)
    // a non-colliding id is kept
    const fresh = JSON.stringify({ app: 'media-converter', version: 1, presets: [{ ...data.presets[0], id: 'shared-1' }] })
    expect(presets.importJson(fresh)[0].id).toBe('shared-1')
  })

  it('validates import files', () => {
    expect(() => presets.importJson('not json')).toThrow()
    expect(() => presets.importJson(JSON.stringify({ app: 'other', version: 1, presets: [] }))).toThrow()
    expect(() => presets.importJson(JSON.stringify({ app: 'media-converter', version: 2, presets: [] }))).toThrow()
    const bad = {
      app: 'media-converter',
      version: 1,
      presets: [
        { kind: 'video', name: 'broken', settings: { container: 'mp4', video: { codec: 'prores' }, audio: { codec: 'aac' } } },
        { kind: 'image', name: 'no output', actions: [] },
      ],
    }
    expect(() => presets.importJson(JSON.stringify(bad))).toThrow()
    const mixed = { ...bad, presets: [...bad.presets, { ...structuredClone(getBuiltinPreset('img-png')), name: 'ok' }] }
    const res = presets.importJson(JSON.stringify(mixed))
    expect(res.map((p) => p.name)).toEqual(['ok'])
  })
})

describe('file presets in the store', () => {
  it('saving a built-in file preset creates a user copy in the file category', () => {
    const builtin = getBuiltinPreset('file-rename') as FilePreset
    const saved = presets.save({ ...structuredClone(builtin), operation: 'move' }) as FilePreset
    expect(saved).toMatchObject({ kind: 'file', operation: 'move', category: 'file', builtIn: false, name: '原地重新命名（副本）' })
    expect(saved.id).toMatch(/^user-/)
    expect((presets.get('file-rename') as FilePreset).operation).toBe('rename')
  })

  it('validates the operation and keeps the file category exclusive to file presets', () => {
    expect(normalizePreset({ kind: 'file', name: 'x', operation: 'delete' })).toBeNull()
    expect(normalizePreset({ kind: 'file', name: 'x' })).toBeNull()
    expect(normalizePreset({ kind: 'file', name: ' Mine ', operation: 'copy', category: 'web' })).toMatchObject({
      kind: 'file',
      name: 'Mine',
      operation: 'copy',
      category: 'file',
    })
    const video = structuredClone(getBuiltinPreset('h264-720p') as VideoPreset)
    expect(normalizePreset({ ...video, category: 'file' })?.category).toBe('custom')
  })

  it('exports and imports file presets', () => {
    const json = presets.exportJson(['file-move-rename'])
    const data = JSON.parse(json) as { presets: Preset[] }
    expect(data.presets[0]).toMatchObject({ kind: 'file', operation: 'move', builtIn: false, name: '移動並重新命名' })
    const [imported] = presets.importJson(json) as FilePreset[]
    expect(imported).toMatchObject({ kind: 'file', operation: 'move', category: 'file' })
    expect(imported.id).not.toBe('file-move-rename')
    // a file whose only preset is broken is rejected
    const bad = JSON.stringify({ app: 'media-converter', version: 1, presets: [{ kind: 'file', name: 'bad', operation: 'zip' }] })
    expect(() => presets.importJson(bad)).toThrow()
  })
})

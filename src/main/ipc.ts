// Single invoke channel: ipcMain.handle('mc:invoke', (e, method, ...args)) → handler map implementing MediaApi.
import { app, BrowserWindow, dialog, ipcMain, shell, type FileFilter, type OpenDialogOptions } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { IPC, type InvokeMethod, type MediaApi } from '../shared/api'
import { AUDIO_EXTS, baseNameOf, classifyPath, IMAGE_EXTS, VIDEO_EXTS, WATERMARK_EXTS } from '../shared/media'
import type { FileKindFilter, QueueEvent, VideoPresetSettings } from '../shared/types'
import type { CapabilitiesCache } from './caps'
import type { FfmpegEngine, ImageEngine } from './contracts'
import { t, type I18nKey } from './i18n'
import type { PresetStore } from './presets/store'
import type { Queue } from './queue/Queue'
import type { SettingsManager } from './settings'
import type { ThumbnailService } from './thumbnails'
import type { WatchManager } from './watch/WatchManager'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  queue: Queue
  presets: PresetStore
  watch: WatchManager
  settings: SettingsManager
  thumbnails: ThumbnailService
  caps: CapabilitiesCache
  ffmpeg: FfmpegEngine
  image: ImageEngine
}

type Handlers = {
  [K in InvokeMethod]: (...args: Parameters<MediaApi[K]>) => ReturnType<MediaApi[K]> | Awaited<ReturnType<MediaApi[K]>>
}

const jpegDataUrl = (buf: Buffer): string => `data:image/jpeg;base64,${buf.toString('base64')}`
const dataUrl = (buf: Buffer, mime: string): string => `data:${mime};base64,${buf.toString('base64')}`
const pad2 = (n: number): string => String(n).padStart(2, '0')
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function filtersFor(kind: FileKindFilter): FileFilter[] {
  const all: FileFilter = { name: t('filter.all'), extensions: ['*'] }
  const video: FileFilter = { name: t('filter.video'), extensions: [...VIDEO_EXTS] }
  const audio: FileFilter = { name: t('filter.audio'), extensions: [...AUDIO_EXTS] }
  const image: FileFilter = { name: t('filter.image'), extensions: [...IMAGE_EXTS] }
  switch (kind) {
    case 'media':
      return [{ name: t('filter.media'), extensions: [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS] }, video, audio, image, all]
    case 'video':
      return [video, all]
    case 'audio':
      return [audio, all]
    case 'image':
      return [image, all]
    case 'watermark':
      return [{ name: t('filter.watermark'), extensions: [...WATERMARK_EXTS] }, all]
    case 'presets':
      return [{ name: t('filter.presets'), extensions: ['json'] }, all]
    case 'any':
      return [all]
  }
}

const DIALOG_TITLE: Record<FileKindFilter, I18nKey> = {
  media: 'dialog.addFiles',
  video: 'dialog.addVideo',
  audio: 'dialog.addAudio',
  image: 'dialog.addImages',
  watermark: 'dialog.chooseWatermark',
  presets: 'dialog.importPresets',
  any: 'dialog.addFiles',
}

async function openDialog(win: BrowserWindow | null, opts: OpenDialogOptions): Promise<string[]> {
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? [] : res.filePaths
}

/** Frame exactly as the preset would scale it (fit / pad / crop / stretch), watermark composited, then shrunk for display. */
async function renderPreviewFrame(
  ctx: IpcContext,
  path: string,
  timeSec: number,
  settings: VideoPresetSettings,
  maxWidth: number,
): Promise<string> {
  const info = await ctx.ffmpeg.probe(path)
  const size = ctx.ffmpeg.computeOutputSize(info, settings)
  if (!size || !info.width || !info.height) throw new Error(t('error.noVideoFrame'))
  const { width: W, height: H } = size

  // decode at (at most) 4K keeping the source aspect, then reproduce the geometry with sharp
  const cap = Math.min(1, 3840 / Math.max(info.width, info.height))
  const fw = Math.max(2, Math.round((info.width * cap) / 2) * 2)
  const fh = Math.max(2, Math.round((info.height * cap) / 2) * 2)
  const frame = await ctx.ffmpeg.extractFrame(path, Math.max(0, timeSec), { width: fw, height: fh, format: 'jpeg' })
  const mode = settings.video.scaleMode
  const fit = mode === 'crop' ? 'cover' : mode === 'pad' ? 'contain' : 'fill'
  let out: Buffer = await sharp(frame)
    .resize(W, H, { fit, position: 'centre', background: { r: 0, g: 0, b: 0, alpha: 1 }, kernel: 'lanczos3' })
    .jpeg({ quality: 92 })
    .toBuffer()

  const codec = settings.video.codec
  if (settings.watermark && codec !== 'copy' && codec !== 'none') {
    out = await ctx.image.compositeWatermark(out, settings.watermark, { name: baseNameOf(path), date: today() })
  }
  if (maxWidth > 0 && W > maxWidth) {
    out = await sharp(out).resize({ width: Math.round(maxWidth) }).jpeg({ quality: 88 }).toBuffer()
  }
  return jpegDataUrl(out)
}

export function createHandlers(ctx: IpcContext): Handlers {
  const { queue, presets, watch, settings } = ctx
  return {
    // ── system ──
    getAppInfo: async () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      locale: settings.locale(),
      userDataDir: app.getPath('userData'),
      electronVersion: process.versions.electron ?? '',
      sharpVersion: sharp.versions.sharp,
      libvipsVersion: sharp.versions.vips,
    }),
    getCapabilities: (refresh) => ctx.caps.get(!!refresh),

    // ── files ──
    pickFiles: async (kind, multi = true) => {
      const filterKind: FileKindFilter = kind in DIALOG_TITLE ? kind : 'media'
      return openDialog(ctx.getWindow(), {
        title: t(DIALOG_TITLE[filterKind]),
        properties: multi && filterKind !== 'watermark' && filterKind !== 'presets' ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: filtersFor(filterKind),
      })
    },
    pickFolder: async (title) => {
      const paths = await openDialog(ctx.getWindow(), {
        title: title || t('dialog.chooseFolder'),
        properties: ['openDirectory', 'createDirectory'],
      })
      return paths[0] ?? null
    },
    probe: async (path) => {
      const kind = classifyPath(path)
      if (!kind) throw new Error(t('error.unsupportedFile', { path }))
      return kind === 'image' ? ctx.image.probe(path) : ctx.ffmpeg.probe(path)
    },
    getThumbnail: (path, maxSize) => ctx.thumbnails.get(path, maxSize ?? 160),
    revealInFolder: async (path) => {
      const st = await stat(path).catch(() => null)
      if (st?.isDirectory()) {
        const err = await shell.openPath(path)
        if (err) throw new Error(err)
      } else {
        shell.showItemInFolder(path)
      }
    },
    openPath: async (path) => {
      const err = await shell.openPath(path)
      if (err) throw new Error(err)
    },

    // ── presets ──
    listPresets: async () => presets.list(),
    savePreset: async (preset) => presets.save(preset),
    deletePreset: async (id) => presets.delete(id),
    importPresets: async () => {
      const paths = await openDialog(ctx.getWindow(), {
        title: t('dialog.importPresets'),
        properties: ['openFile'],
        filters: filtersFor('presets'),
      })
      if (!paths.length) return []
      return presets.importJson(await readFile(paths[0], 'utf8'))
    },
    exportPresets: async (ids) => {
      const win = ctx.getWindow()
      const opts = {
        title: t('dialog.exportPresets'),
        defaultPath: t('preset.exportFileName'),
        filters: filtersFor('presets'),
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, presets.exportJson(ids), 'utf8')
      return true
    },

    // ── queue ──
    getQueue: async () => queue.getSnapshot(),
    addJobs: (req) => queue.addJobs(req),
    updateJob: async (id, patch) => queue.updateJob(id, patch),
    applyPreset: async (ids, presetId) => queue.applyPreset(ids, presetId),
    duplicateJobs: async (ids) => queue.duplicateJobs(ids),
    removeJobs: (ids) => queue.removeJobs(ids),
    reorderJobs: async (ids) => queue.reorderJobs(ids),
    retryJobs: async (ids) => queue.retryJobs(ids),
    clearFinished: async () => queue.clearFinished(),
    startQueue: async (ids) => queue.start(false, Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : undefined),
    stopQueue: () => queue.stop(),
    cancelJobs: (ids) => queue.cancelJobs(ids),

    // ── preview ──
    getVideoFrame: async (path, timeSec, maxWidth) =>
      jpegDataUrl(await ctx.ffmpeg.extractFrame(path, Math.max(0, timeSec), { maxWidth: maxWidth ?? 640, format: 'jpeg' })),
    previewVideoFrame: (path, timeSec, s, maxWidth) => renderPreviewFrame(ctx, path, timeSec, s, maxWidth ?? 960),
    previewImage: async (path, actions, output, maxSize) => {
      const r = await ctx.image.preview({ source: path, actions, output, maxSize: maxSize ?? 1024 })
      return {
        before: dataUrl(r.before, r.beforeMime),
        after: dataUrl(r.after, r.afterMime),
        outWidth: r.outWidth,
        outHeight: r.outHeight,
      }
    },

    // ── file operations ──
    previewFileOps: (ids) => queue.previewFileOps(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []),
    getFileOpUndo: async () => queue.getFileOpUndo(),
    undoFileOps: () => queue.undoFileOps(),

    // ── watch folders ──
    listWatchFolders: async () => watch.list(),
    saveWatchFolder: (w) => watch.save(w),
    deleteWatchFolder: (id) => watch.delete(id),

    // ── settings ──
    getSettings: async () => settings.get(),
    saveSettings: async (patch) => settings.patch(patch ?? {}),
  }
}

export function registerIpc(ctx: IpcContext): void {
  const handlers = createHandlers(ctx)
  ipcMain.handle(IPC.invoke, async (event, method: unknown, ...args: unknown[]) => {
    const win = ctx.getWindow()
    if (!win || event.sender !== win.webContents) throw new Error('Unauthorized sender')
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, method)) {
      throw new Error(t('error.unknownMethod', { method: String(method) }))
    }
    const fn = handlers[method as InvokeMethod] as (...a: unknown[]) => unknown
    return await fn(...args)
  })
}

/** Push a queue event to the renderer. */
export function sendQueueEvent(win: BrowserWindow | null, e: QueueEvent): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.queueEvent, e)
}

export function sendExternalFiles(win: BrowserWindow | null, paths: string[]): void {
  if (paths.length && win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.externalFiles, paths)
}

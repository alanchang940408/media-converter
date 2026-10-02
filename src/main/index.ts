// App / window lifecycle. './store' must stay the first import: it applies MC_USER_DATA_DIR before anything reads userData.
import { applyUserDataOverride, flushAllStoresSync, openStore, type JsonStore } from './store'
import { app, BrowserWindow, dialog, nativeTheme, Notification, powerSaveBlocker, screen, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { classifyPath } from '../shared/media'
import type { AppSettings } from '../shared/types'
import { CapabilitiesCache } from './caps'
import { ffmpegEngine } from './ffmpeg'
import { t } from './i18n'
import { imageEngine } from './image'
import { registerIpc, sendExternalFiles, sendQueueEvent } from './ipc'
import { emptyPresetFile, parsePresetFile, PresetStore } from './presets/store'
import { handleMediaProtocol, registerMediaScheme } from './protocol'
import { emptyJournal, parseJournal, type FileOpJournal } from './queue/journal'
import { emptyQueue, Queue, type PersistedQueue } from './queue/Queue'
import { defaultSettings, sanitizeSettings, SettingsManager } from './settings'
import { ThumbnailService } from './thumbnails'
import {
  emptyProcessedFile,
  emptyWatchFolderFile,
  parseWatchFolderFile,
  WatchManager,
  type ProcessedFile,
  type WatchFolderFile,
} from './watch/WatchManager'

applyUserDataOverride()
app.setAppUserModelId('app.mediaconverter.desktop')
registerMediaScheme()

const here = dirname(fileURLToPath(import.meta.url))
const DARK_BG = '#1d1d1f'
const LIGHT_BG = '#f5f5f7'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

let win: BrowserWindow | null = null
let rendererReady = false
let pendingFiles: string[] = []
let quitConfirmed = false
let cleanedUp = false
let cleaning: Promise<void> | null = null
let powerBlockerId: number | null = null

let settings: SettingsManager
let queue: Queue
let watch: WatchManager
let winStore: JsonStore<WindowState>

/** Media files (and folders, when packaged) passed on the command line. */
function filesFromArgv(argv: string[], cwd: string): string[] {
  const out: string[] = []
  for (const arg of argv.slice(app.isPackaged ? 1 : 2)) {
    if (!arg || arg.startsWith('-')) continue
    const p = resolve(cwd || process.cwd(), arg)
    try {
      const st = statSync(p)
      if ((st.isFile() && classifyPath(p)) || (st.isDirectory() && app.isPackaged)) out.push(p)
    } catch {
      /* not a path */
    }
  }
  return out
}

function deliverFiles(paths: string[]): void {
  if (!paths.length) return
  if (win && rendererReady) sendExternalFiles(win, paths)
  else pendingFiles.push(...paths)
}

function focusWindow(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function backgroundColor(): string {
  const theme = settings?.get().theme ?? 'dark'
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  return dark ? DARK_BG : LIGHT_BG
}

function devIcon(): string | undefined {
  if (app.isPackaged) return undefined
  const icon = join(here, '../../resources/icon.png')
  return existsSync(icon) ? icon : undefined
}

function restoreBounds(s: WindowState): WindowState {
  const width = Math.max(1000, s.width || 1360)
  const height = Math.max(640, s.height || 860)
  if (typeof s.x === 'number' && typeof s.y === 'number') {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return s.x! < a.x + a.width - 100 && s.x! + width > a.x + 100 && s.y! < a.y + a.height - 50 && s.y! + 40 > a.y
    })
    if (visible) return { x: s.x, y: s.y, width, height, maximized: !!s.maximized }
  }
  return { width, height, maximized: !!s.maximized }
}

function saveBounds(): void {
  if (!win || win.isDestroyed()) return
  const b = win.getNormalBounds()
  winStore.set({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() })
}

function rendererBase(): string {
  return process.env.ELECTRON_RENDERER_URL || pathToFileURL(join(here, '../renderer/index.html')).href
}

function isAppUrl(url: string): boolean {
  try {
    const target = new URL(url)
    const base = new URL(rendererBase())
    if (base.protocol === 'file:') return target.protocol === 'file:' && target.pathname === base.pathname
    return target.origin === base.origin
  } catch {
    return false
  }
}

function confirmQuit(): boolean {
  if (quitConfirmed || !queue?.hasActiveWork() || process.env.MC_NO_QUIT_CONFIRM) return true
  const opts = {
    type: 'warning' as const,
    buttons: [t('quit.quit'), t('quit.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: t('quit.title'),
    message: t('quit.message'),
    detail: t('quit.detail'),
  }
  const choice = win && !win.isDestroyed() ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts)
  quitConfirmed = choice === 0
  return quitConfirmed
}

function createWindow(): void {
  const state = restoreBounds(winStore.get())
  rendererReady = false
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Media Converter',
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    icon: devIcon(),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  const w = win

  w.once('ready-to-show', () => {
    if (state.maximized) w.maximize()
    w.show()
  })

  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  w.webContents.on('will-attach-webview', (e) => e.preventDefault())
  w.webContents.on('did-finish-load', () => {
    rendererReady = true
    const files = pendingFiles
    pendingFiles = []
    // the preload buffers these until the UI subscribes
    sendExternalFiles(w, files)
  })
  w.webContents.on('did-start-loading', () => {
    rendererReady = false
  })

  w.on('resize', saveBounds)
  w.on('move', saveBounds)
  w.on('maximize', saveBounds)
  w.on('unmaximize', saveBounds)
  w.on('close', (e) => {
    saveBounds()
    if (!confirmQuit()) e.preventDefault()
  })
  w.on('closed', () => {
    if (win === w) win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(here, '../renderer/index.html'))
}

function setPreventSleep(on: boolean): void {
  if (on && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  else if (!on && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
  }
}

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: devIcon(), silent: false })
  n.on('click', focusWindow)
  n.show()
}

async function cleanup(): Promise<void> {
  const work = (async () => {
    await queue?.shutdown().catch((err) => console.error('[quit] queue shutdown failed:', err))
    await watch?.close().catch((err) => console.error('[quit] watch close failed:', err))
  })()
  // never hang the quit on a stuck process
  await Promise.race([work, new Promise((r) => setTimeout(r, 10000))])
  setPreventSleep(false)
  flushAllStoresSync()
}

async function startApp(): Promise<void> {
  const settingsStore = openStore<AppSettings>('settings.json', defaultSettings, { parse: (raw) => sanitizeSettings(raw) })
  settings = new SettingsManager(settingsStore, {
    systemLocale: () => app.getLocale(),
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme
    },
  })
  const presets = new PresetStore(openStore('presets.json', emptyPresetFile, { parse: parsePresetFile }), () => settings.locale())
  const caps = new CapabilitiesCache(ffmpegEngine)
  winStore = openStore<WindowState>('window.json', () => ({ width: 1360, height: 860, maximized: false }))

  queue = new Queue({
    ffmpeg: ffmpegEngine,
    image: imageEngine,
    store: openStore<PersistedQueue>('queue.json', emptyQueue, {
      parse: (raw) => (raw && typeof raw === 'object' && Array.isArray((raw as PersistedQueue).jobs) ? (raw as PersistedQueue) : null),
    }),
    settings,
    presets,
    journal: openStore<FileOpJournal>('file-ops-journal.json', emptyJournal, { parse: parseJournal }),
    getCapabilities: () => caps.get(),
    tmpDir: join(tmpdir(), 'media-converter', String(process.pid)),
    effects: {
      onEvent: (e) => sendQueueEvent(win, e),
      setProgress: (f) => {
        if (win && !win.isDestroyed()) win.setProgressBar(f === null ? -1 : f)
      },
      setPreventSleep,
      notify,
    },
  })

  watch = new WatchManager({
    queue,
    presets,
    folders: openStore<WatchFolderFile>('watch-folders.json', emptyWatchFolderFile, {
      parse: parseWatchFolderFile,
    }),
    processed: openStore<ProcessedFile>('watch-processed.json', emptyProcessedFile, {
      parse: (raw) =>
        raw && typeof raw === 'object' && (raw as ProcessedFile).entries && typeof (raw as ProcessedFile).entries === 'object'
          ? (raw as ProcessedFile)
          : null,
    }),
    onError: (folder, err) => console.warn(`[watch] ${folder.path}: ${err.message}`),
  })

  const thumbnails = new ThumbnailService(ffmpegEngine, imageEngine)

  settings.onChange((_next, _prev, changed) => {
    if (changed.some((k) => k === 'videoConcurrency' || k === 'imageConcurrency' || k === 'removeFinished' || k === 'preventSleep')) {
      queue.refresh()
    }
    if (changed.includes('ffmpegPath')) void caps.get(true)
    if (changed.includes('theme') && win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor())
  })
  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColor())
  })

  registerIpc({ getWindow: () => win, queue, presets, watch, settings, thumbnails, caps, ffmpeg: ffmpegEngine, image: imageEngine })
  handleMediaProtocol()
  createWindow()

  // background work after the window is up
  void caps.get()
  void queue.init().catch((err) => console.error('[queue] init failed:', err))
  void watch.start().catch((err) => console.error('[watch] start failed:', err))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  pendingFiles = filesFromArgv(process.argv, process.cwd())

  app.on('second-instance', (_e, argv, workingDirectory) => {
    focusWindow()
    deliverFiles(filesFromArgv(argv, workingDirectory))
  })

  // macOS "Open with" / dock drops
  app.on('open-file', (e, path) => {
    e.preventDefault()
    deliverFiles([path])
  })

  app.on('before-quit', (e) => {
    if (cleanedUp) return
    if (!confirmQuit()) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    if (!cleaning) {
      cleaning = cleanup().finally(() => {
        cleanedUp = true
        app.quit()
      })
    }
  })

  app.on('will-quit', () => flushAllStoresSync())

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (!win && app.isReady() && settings) createWindow()
  })

  app.whenReady().then(startApp).catch((err) => {
    console.error('[app] startup failed:', err)
    dialog.showErrorBox('Media Converter', err instanceof Error ? err.stack || err.message : String(err))
    app.exit(1)
  })
}

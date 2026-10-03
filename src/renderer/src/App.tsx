// App shell: boot, theme, header with tabs + hardware badge, view switching, global modals, drop overlay.
import { useEffect, useRef, useState } from 'react'
import { CircleArrowDown, Cpu, ExternalLink, FilePen, FolderSearch, Gauge, Layers, ListVideo, RefreshCw, RotateCw, Settings, TriangleAlert, X, Zap } from 'lucide-react'
import type { EncoderCapabilities } from '../../shared/types'
import { HW_PRIORITY } from '../../shared/videoRules'
import { api, isMock } from './api'
import { addFileOpsEntries, addPaths, init, openSettings, setView, toast, tNow, useLocale, useStore, useT, type View } from './store'
import { LOCALE_HTML_LANG, type MessageKey } from './i18n'
import { isFileDrag } from './lib/dnd'
import { AppMark } from './components/AppMark'
import { DialogHost, DropOverlay, Toasts } from './components/Overlays'
import { Button, IconButton, Spinner, cx } from './components/ui'
import { dismissUpdateNotice, initUpdates, installUpdateNow, openReleasePage, useUpdates } from './updates'
import './styles/update.css'
import { QueueView } from './views/QueueView'
import { PresetsView } from './views/PresetsView'
import { WatchView } from './views/WatchView'
import { SettingsModal } from './modals/SettingsModal'
import { PreviewModal } from './modals/PreviewModal'
import { JobEditorModal } from './modals/JobEditorModal'
import { BatchRenameView } from './views/BatchRenameView'
import { entriesFromPaths } from './lib/fileops'

export function App() {
  const ready = useStore((s) => s.ready)
  const loadError = useStore((s) => s.loadError)

  const view = useStore((s) => s.view)
  useBoot()
  useEffect(() => initUpdates(), [])
  useTheme()
  useHtmlLang()
  const dragging = useWindowFileDrop(ready && !loadError)

  if (!ready) return <BootScreen />
  if (loadError) return <FatalScreen error={loadError} />

  return (
    <div className="app">
      <Header />
      <UpdateBar />
      <main className="app-main">
        <CurrentView />
        <BatchRenameView active={view === 'batch'} />
      </main>
      <SettingsModal />
      <PreviewModal />
      <JobEditorModal />
      <DialogHost />
      <Toasts />
      <DropOverlay visible={dragging} />
    </div>
  )
}

function CurrentView() {
  const view = useStore((s) => s.view)
  if (view === 'presets') return <PresetsView />
  if (view === 'watch') return <WatchView />
  if (view === 'batch') return null
  return <QueueView />
}

// ───────────────────────────── boot / theme / lang ─────────────────────────────

function useBoot(): void {
  useEffect(() => {
    let dispose: (() => void) | null = null
    let cancelled = false
    void init().then((d) => {
      if (cancelled) d()
      else dispose = d
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [])
}

function useTheme(): void {
  const pref = useStore((s) => s.settings.theme)
  useEffect(() => {
    const root = document.documentElement
    if (pref !== 'system') {
      root.dataset.theme = pref
      return
    }
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = (): void => {
      root.dataset.theme = mq.matches ? 'light' : 'dark'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref])
}

function useHtmlLang(): void {
  const locale = useLocale()
  const t = useT()
  useEffect(() => {
    document.documentElement.lang = LOCALE_HTML_LANG[locale]
    document.title = t('app.name')
  }, [locale, t])
}

/** Whole-window OS file drop → addJobs (folders are expanded recursively). Returns whether a file drag is over the window. */
function useWindowFileDrop(enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  useEffect(() => {
    if (!enabled) return
    const onEnter = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onOver = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e.dataTransfer)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      const paths: string[] = []
      for (const f of files) {
        try {
          const p = api.getPathForFile(f)
          if (p) paths.push(p)
        } catch (err) {
          console.error(err)
        }
      }
      if (!paths.length) {
        toast('error', tNow('toast.dropUnreadable'))
        return
      }
      // On the batch rename tab, drops go into its file list instead of the queue.
      if (useStore.getState().view === 'batch') {
        addFileOpsEntries(entriesFromPaths(paths))
        return
      }
      setView('queue')
      void addPaths(paths, true)
    }
    // Leaving the window (e.g. Esc or dragging out) does not always fire a final dragleave.
    const reset = (): void => {
      depth.current = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('blur', reset)
    document.addEventListener('mouseleave', reset)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('blur', reset)
      document.removeEventListener('mouseleave', reset)
    }
  }, [enabled])
  return dragging
}

// ───────────────────────────── header ─────────────────────────────

const TABS: { view: View; icon: typeof ListVideo; label: MessageKey }[] = [
  { view: 'queue', icon: ListVideo, label: 'nav.queue' },
  { view: 'batch', icon: FilePen, label: 'nav.batch' },
  { view: 'presets', icon: Layers, label: 'nav.presets' },
  { view: 'watch', icon: FolderSearch, label: 'nav.watch' },
]

function Header() {
  const t = useT()
  const view = useStore((s) => s.view)
  const jobs = useStore((s) => s.jobs)
  const watchFolders = useStore((s) => s.watchFolders)
  const pending = jobs.filter((j) => j.kind !== 'file' && (j.status === 'queued' || j.status === 'running')).length
  const activeWatch = watchFolders.filter((w) => w.enabled).length

  return (
    <header className="app-header">
      <div className="brand">
        <AppMark size={22} />
        <span className="brand-name">{t('app.name')}</span>
        <BrandVersion />
        {isMock && (
          <span className="mock-badge" title={t('app.mockBadgeHint')}>
            {t('app.mockBadge')}
          </span>
        )}
      </div>
      <nav className="tabs" role="tablist" aria-label={t('nav.main')}>
        {TABS.map(({ view: v, icon: Icon, label }) => {
          const count = v === 'queue' ? pending : v === 'watch' ? activeWatch : 0
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={cx('tab', view === v && 'active')}
              onClick={() => setView(v)}
            >
              <Icon size={15} aria-hidden />
              <span>{t(label)}</span>
              {count > 0 && <span className={cx('tab-count', v === 'watch' && 'live')}>{count}</span>}
            </button>
          )
        })}
      </nav>
      <div className="header-right">
        <HwBadge />
        <button type="button" className="header-btn" onClick={() => openSettings()} aria-label={t('nav.settings')} title={t('nav.settings')}>
          <Settings size={17} aria-hidden />
        </button>
      </div>
    </header>
  )
}

/** Small muted "v0.1.0" next to the app name; opens Settings → About (updates). A dot marks a waiting update. */
function BrandVersion() {
  const t = useT()
  const version = useStore((s) => s.appInfo?.version)
  const update = useUpdates((s) => s.state)
  if (!version) return null
  const ready = update?.status === 'downloaded' && !!update.version
  const available = !ready && update?.status === 'available' && update.mode !== 'auto' && !!update.version
  const title = ready
    ? t('update.readyHint', { v: update!.version! })
    : available
      ? t('update.availableHint', { v: update!.version! })
      : t('update.versionHint', { v: version })
  return (
    <button type="button" className="brand-version" onClick={() => openSettings('about')} title={title} aria-label={title}>
      <span>v{version}</span>
      {(ready || available) && <span className="brand-version-dot" aria-hidden />}
    </button>
  )
}

/** Persistent bar under the header: a downloaded update (restart now / later) or, for portable builds, a download link. */
function UpdateBar() {
  const t = useT()
  const notice = useUpdates((s) => s.notice)
  if (!notice) return null
  const downloaded = notice.kind === 'downloaded'
  const text = t(downloaded ? 'update.barDownloaded' : notice.kind === 'portable' ? 'update.barPortable' : 'update.barManual', { v: notice.version })
  return (
    <div className="update-bar" role="status" aria-label={t('update.barRegion')}>
      <span className="update-bar-icon">
        <CircleArrowDown size={17} aria-hidden />
      </span>
      <div className="update-bar-text">
        <strong>{text}</strong>
        {downloaded && <span className="update-bar-detail">{t('update.barDownloadedDetail')}</span>}
      </div>
      <div className="update-bar-actions">
        {downloaded ? (
          <>
            <Button size="sm" variant="primary" icon={RotateCw} onClick={() => void installUpdateNow()}>
              {t('update.restartNow')}
            </Button>
            <Button size="sm" variant="ghost" onClick={dismissUpdateNotice}>
              {t('update.later')}
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => void openReleasePage()}>
              {t('update.download')}
            </Button>
            <IconButton icon={X} label={t('common.close')} onClick={dismissUpdateNotice} />
          </>
        )}
      </div>
    </div>
  )
}

function workingFamilies(caps: EncoderCapabilities): (typeof HW_PRIORITY)[number][] {
  return HW_PRIORITY.filter((f) => caps.hw[f])
}

const HW_SHORT: Record<(typeof HW_PRIORITY)[number], string> = { nvenc: 'NVENC', qsv: 'Quick Sync', amf: 'AMF', videotoolbox: 'VideoToolbox' }

function HwBadge() {
  const t = useT()
  const caps = useStore((s) => s.caps)
  const loading = useStore((s) => s.capsLoading)
  if (!caps) {
    return (
      <button type="button" className="hw-badge checking" onClick={() => openSettings('performance')} title={t('hw.badgeChecking')}>
        {loading ? <Spinner size={12} /> : <Gauge size={13} aria-hidden />}
        <span>{t('hw.badgeChecking')}</span>
      </button>
    )
  }
  if (caps.ffmpegSource === 'missing') {
    return (
      <button type="button" className="hw-badge missing" onClick={() => openSettings('performance')} title={t('hw.titleMissing')}>
        <TriangleAlert size={13} aria-hidden />
        <span>{t('hw.badgeMissing')}</span>
      </button>
    )
  }
  const fams = workingFamilies(caps)
  if (fams.length) {
    const list = fams.map((f) => t(`hw.${f}` as MessageKey)).join(', ')
    return (
      <button type="button" className="hw-badge gpu" onClick={() => openSettings('performance')} title={t('hw.titleGpu', { list })}>
        {loading ? <Spinner size={12} /> : <Zap size={13} aria-hidden />}
        <span>{t('hw.badgeGpu', { name: HW_SHORT[fams[0]] })}</span>
      </button>
    )
  }
  return (
    <button type="button" className="hw-badge cpu" onClick={() => openSettings('performance')} title={t('hw.titleCpu')}>
      {loading ? <Spinner size={12} /> : <Cpu size={13} aria-hidden />}
      <span>{t('hw.badgeCpu')}</span>
    </button>
  )
}

// ───────────────────────────── boot / fatal screens ─────────────────────────────

function BootScreen() {
  const t = useT()
  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <AppMark size={44} />
      <div className="boot-line">
        <Spinner size={14} />
        <span>{t('app.loading')}</span>
      </div>
    </div>
  )
}

function FatalScreen({ error }: { error: string }) {
  const t = useT()
  return (
    <div className="boot-screen fatal" role="alert">
      <AppMark size={44} />
      <h1>{t('app.loadFailed')}</h1>
      <p>{t('app.loadFailedHint')}</p>
      <code className="fatal-detail">{error}</code>
      <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
        {t('common.retry')}
      </Button>
    </div>
  )
}

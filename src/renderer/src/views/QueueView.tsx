// Encode queue: toolbar, job list (multi-select, reorder, preset drop), status bar, preset browser.
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent } from 'react'
import {
  ArrowRight,
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  CopyPlus,
  Eye,
  FilePen,
  FilePlus,
  Film,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  FolderTree,
  Image as ImageIcon,
  ListX,
  LoaderCircle,
  Music,
  PanelRightOpen,
  Play,
  RotateCcw,
  Scissors,
  SkipForward,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import type { FileOpPreviewItem, Job, Preset } from '../../../shared/types'
import { classifyPath } from '../../../shared/media'
import { api } from '../api'
import {
  addFilesDialog,
  addFolderDialog,
  applyPreset,
  cancelJobs,
  clearFinished,
  duplicateJobs,
  guard,
  openEditor,
  openPreview,
  removeJobsConfirm,
  reorderJobs,
  retryJobs,
  saveSettings,
  selectJobs,
  setView,
  setJobsOutputDir,
  setJobsPreserveStructure,
  startQueue,
  stopQueue,
  toast,
  togglePresetBrowser,
  tNow,
  useLocale,
  useStore,
  useT,
} from '../store'
import type { MessageKey, TFunc } from '../i18n'
import { formatBytes, formatEta, formatTimecode, fileName, sourceInfoLine, truncateMiddle, dirName, joinPath } from '../lib/format'
import { FILE_OP_ICON, FILE_OP_LABEL, FILE_OP_STATUS_LABEL, jobOperation, recreatedSubfolder } from '../lib/fileops'
import { useDebouncedValue } from '../lib/hooks'
import { groupByCategory, isEditableJob, isPresetCompatible, presetName } from '../lib/presets'
import { DND_JOBS, DND_PRESET, dragState, hasType } from '../lib/dnd'
import { PresetBrowser } from '../components/PresetBrowser'
import { Thumb, type ThumbKind } from '../components/Thumb'
import { Button, IconButton, Menu, MenuButton, ProgressBar, Select, Switch, cx, isModalOpen, isTypingTarget, type MenuItem } from '../components/ui'

/** Jobs shown in the conversion queue: batch rename / copy / move jobs live on their own tab. */
const visibleJobs = (jobs: Job[]): Job[] => jobs.filter((j) => j.kind !== 'file')

function useQueueJobs(): Job[] {
  const all = useStore((s) => s.jobs)
  return useMemo(() => visibleJobs(all), [all])
}

export function QueueView() {
  const jobs = useQueueJobs()
  const browserOpen = useStore((s) => s.presetBrowserOpen)
  return (
    <div className={cx('queue-view', browserOpen && 'with-browser')}>
      <div className="queue-main">
        <QueueToolbar />
        {jobs.length ? <JobList /> : <EmptyDrop />}
      </div>
      {browserOpen && <PresetBrowser />}
      <StatusBar />
    </div>
  )
}

// ───────────────────────────── toolbar ─────────────────────────────

function QueueToolbar() {
  const t = useT()
  const jobs = useQueueJobs()
  const selected = useStore((s) => s.selected)
  const browserOpen = useStore((s) => s.presetBrowserOpen)
  const sel = jobs.filter((j) => selected.includes(j.id))
  const editable = sel.filter(isEditableJob)
  const finished = jobs.some((j) => j.status === 'done' || j.status === 'skipped')
  // rename jobs stay in their folder, so the output folder does not apply to them
  const withFolder = editable.filter((j) => !(j.kind === 'file' && jobOperation(j) === 'rename'))
  const allPreserve = withFolder.length > 0 && withFolder.every((j) => j.output.preserveStructure)

  const outputItems: MenuItem[] = [
    {
      key: 'choose',
      label: t('queue.chooseFolder'),
      icon: FolderOpen,
      disabled: !withFolder.length,
      onSelect: async () => {
        const dir = await guard(() => api.pickFolder(tNow('dialog.outputFolderTitle')))
        if (dir) await setJobsOutputDir(withFolder.map((j) => j.id), dir)
      },
    },
    { key: 'same', label: t('common.sameAsSource'), icon: FolderOutput, disabled: !withFolder.length, onSelect: () => void setJobsOutputDir(withFolder.map((j) => j.id), null) },
    { type: 'separator', key: 'sep' },
    {
      key: 'structure',
      label: t('fileops.keepStructure'),
      checked: allPreserve,
      icon: allPreserve ? undefined : FolderTree,
      disabled: !withFolder.length,
      hint: t('fileops.keepStructureHint'),
      onSelect: () => void setJobsPreserveStructure(withFolder.map((j) => j.id), !allPreserve),
    },
  ]

  return (
    <div className="toolbar" role="toolbar" aria-label={t('queue.toolbar')}>
      <Button icon={FilePlus} onClick={() => void addFilesDialog()}>
        {t('queue.addFiles')}
      </Button>
      <Button icon={FolderPlus} onClick={() => void addFolderDialog()}>
        {t('queue.addFolder')}
      </Button>
      <span className="tb-sep" />
      <Button variant="ghost" icon={Trash2} disabled={!sel.length} onClick={() => void removeJobsConfirm(sel.map((j) => j.id))} title={`${t('queue.remove')} (Delete)`} className="tb-collapsible">
        {t('queue.remove')}
      </Button>
      <Button variant="ghost" icon={CopyPlus} disabled={!sel.length} onClick={() => void duplicateJobs(selected)} title={t('queue.duplicateHint')} className="tb-collapsible">
        {t('queue.duplicate')}
      </Button>
      <Button variant="ghost" icon={ListX} disabled={!finished} onClick={() => void clearFinished()} className="tb-collapsible" title={t('queue.clearFinished')}>
        {t('queue.clearFinished')}
      </Button>
      <MenuButton variant="ghost" icon={FolderOutput} label={t('queue.outputFolder')} items={outputItems} disabled={!editable.length} title={t('queue.outputFolderHint')} className="tb-collapsible" />
      <span className="tb-spacer" />
      <span className="tb-count">{sel.length ? t('queue.selectedCount', { n: sel.length, total: jobs.length }) : t('queue.totalCount', { n: jobs.length })}</span>
      {!browserOpen && <IconButton icon={PanelRightOpen} label={t('queue.showBrowser')} onClick={() => togglePresetBrowser(true)} />}
    </div>
  )
}

// ───────────────────────────── empty state ─────────────────────────────

function EmptyDrop() {
  const t = useT()
  return (
    <div className="empty-drop">
      <div className="empty-drop-box">
        <div className="empty-icons" aria-hidden>
          <Film size={26} />
          <Music size={26} />
          <ImageIcon size={26} />
        </div>
        <h2>{t('queue.dropTitle')}</h2>
        <p>{t('queue.dropSubtitle')}</p>
        <div className="empty-actions">
          <Button variant="primary" size="lg" icon={FilePlus} onClick={() => void addFilesDialog()}>
            {t('queue.addFiles')}
          </Button>
          <Button size="lg" icon={FolderPlus} onClick={() => void addFolderDialog()}>
            {t('queue.addFolder')}
          </Button>
        </div>
        <p className="empty-formats">{t('queue.dropFormats')}</p>
        <div className="empty-secondary">
          <Button variant="ghost" icon={FilePen} onClick={() => setView('batch')}>
            {t('fileops.emptyAction')}
          </Button>
          <span>{t('fileops.emptyHint')}</span>
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── job list ─────────────────────────────

type DropMark = { id: string; after: boolean } | null

/** Path separator used by `p` (shown before a recreated subfolder in the output column). */
const sepOf = (p: string): string => (p.includes('\\') || /^[a-z]:/i.test(p) ? '\\' : '/')

function JobList() {
  const t = useT()
  const locale = useLocale()
  const jobs = useQueueJobs()
  const selected = useStore((s) => s.selected)
  const presets = useStore((s) => s.presets)
  const view = useStore((s) => s.view)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dropMark, setDropMark] = useState<DropMark>(null)
  const [presetTarget, setPresetTarget] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const fileTargets = useFileOpTargets(jobs)

  // Keyboard: Delete removes, Ctrl+A selects all, arrows move the selection, Enter edits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (view !== 'queue' || isModalOpen() || isTypingTarget(e.target)) return
      const st = useStore.getState()
      if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
        // same single confirmation as the toolbar button and the row ×: the count, and what happens to running jobs
        const ids = visibleJobs(st.jobs)
          .filter((j) => st.selected.includes(j.id))
          .map((j) => j.id)
        if (ids.length) {
          e.preventDefault()
          void removeJobsConfirm(ids)
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        const vis = visibleJobs(st.jobs)
        selectJobs(vis.map((j) => j.id), vis[0]?.id ?? null)
      } else if (e.key === 'Escape' && st.selected.length) {
        selectJobs([], null)
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && listRef.current?.contains(document.activeElement)) {
        e.preventDefault()
        const ids = visibleJobs(st.jobs).map((j) => j.id)
        const cur = st.selected.length ? ids.indexOf(st.selected[st.selected.length - 1]) : -1
        const next = Math.max(0, Math.min(ids.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
        const id = ids[next]
        if (!id) return
        if (e.shiftKey && st.anchor) {
          const a = ids.indexOf(st.anchor)
          // keep the focused row last so the next arrow press continues from it
          const range = ids.slice(Math.min(a, next), Math.max(a, next) + 1)
          selectJobs([...range.filter((x) => x !== id), id], st.anchor)
        } else selectJobs([id], id)
        listRef.current?.querySelector<HTMLElement>(`[data-job="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && st.selected.length === 1 && listRef.current?.contains(document.activeElement)) {
        const job = st.jobs.find((j) => j.id === st.selected[0])
        if (job) openJob(job)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const onRowClick = (e: RMouseEvent, id: string): void => {
    if ((e.target as HTMLElement).closest('button, select, input, a, .no-row-select')) return
    const st = useStore.getState()
    const ids = visibleJobs(st.jobs).map((j) => j.id)
    if (e.shiftKey && st.anchor && ids.includes(st.anchor)) {
      const a = ids.indexOf(st.anchor)
      const b = ids.indexOf(id)
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1)
      selectJobs(e.ctrlKey || e.metaKey ? Array.from(new Set([...st.selected, ...range])) : range, st.anchor)
    } else if (e.ctrlKey || e.metaKey) {
      selectJobs(st.selected.includes(id) ? st.selected.filter((x) => x !== id) : [...st.selected, id], id)
    } else {
      selectJobs([id], id)
    }
  }

  const onDragStartRow = (e: DragEvent, job: Job): void => {
    const st = useStore.getState()
    const ids = st.selected.includes(job.id) ? st.jobs.filter((j) => st.selected.includes(j.id) && j.status === 'queued').map((j) => j.id) : [job.id]
    dragState.jobIds = ids
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(DND_JOBS, JSON.stringify(ids))
  }

  const onDragOverRow = (e: DragEvent, job: Job): void => {
    if (hasType(e.dataTransfer, DND_JOBS) && dragState.jobIds) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      const after = e.clientY > r.top + r.height / 2
      if (dropMark?.id !== job.id || dropMark.after !== after) setDropMark({ id: job.id, after })
    } else if (hasType(e.dataTransfer, DND_PRESET) && dragState.presetId) {
      const p = presets.find((x) => x.id === dragState.presetId)
      if (p && isEditableJob(job) && isPresetCompatible(job, p)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (presetTarget !== job.id) setPresetTarget(job.id)
      } else {
        e.dataTransfer.dropEffect = 'none'
      }
    }
  }

  const onDropRow = async (e: DragEvent, job: Job): Promise<void> => {
    if (hasType(e.dataTransfer, DND_JOBS) && dragState.jobIds) {
      e.preventDefault()
      e.stopPropagation()
      const moving = dragState.jobIds
      const after = dropMark?.after ?? false
      setDropMark(null)
      dragState.jobIds = null
      if (moving.includes(job.id)) return
      const order = useStore.getState().jobs.map((j) => j.id)
      const rest = order.filter((id) => !moving.includes(id))
      let idx = rest.indexOf(job.id)
      if (idx < 0) return
      if (after) idx++
      rest.splice(idx, 0, ...moving)
      await reorderJobs(rest)
    } else if (hasType(e.dataTransfer, DND_PRESET) && dragState.presetId) {
      e.preventDefault()
      e.stopPropagation()
      const p = presets.find((x) => x.id === dragState.presetId)
      setPresetTarget(null)
      dragState.presetId = null
      if (!p) return
      const st = useStore.getState()
      const targetIds = st.selected.includes(job.id) ? st.jobs.filter((j) => st.selected.includes(j.id) && isEditableJob(j) && isPresetCompatible(j, p)).map((j) => j.id) : [job.id]
      if (await applyPreset(targetIds, p.id)) toast('success', tNow('browser.applied', { name: presetName(p, locale), n: targetIds.length }))
    }
  }

  const clearDnd = (): void => {
    setDropMark(null)
    setPresetTarget(null)
  }

  const toggleExpanded = (id: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="job-table" role="grid" aria-label={t('queue.listLabel')} aria-multiselectable>
      <div className="job-head" role="row">
        <span role="columnheader" className="cell cell-thumb" />
        <span role="columnheader" className="cell cell-source">{t('queue.colSource')}</span>
        <span role="columnheader" className="cell cell-preset">{t('queue.colPreset')}</span>
        <span role="columnheader" className="cell cell-output">{t('queue.colOutput')}</span>
        <span role="columnheader" className="cell cell-status">{t('queue.colStatus')}</span>
        <span role="columnheader" className="cell cell-actions" />
      </div>
      <div
        ref={listRef}
        className="job-list"
        tabIndex={0}
        onClick={(e) => {
          if (e.target === e.currentTarget) selectJobs([], null)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) clearDnd()
        }}
      >
        {jobs.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            t={t}
            locale={locale}
            presets={presets}
            selected={selectedSet.has(job.id)}
            expanded={expanded.has(job.id)}
            fileTarget={fileTargets.get(job.id)}
            dropMark={dropMark?.id === job.id ? (dropMark.after ? 'after' : 'before') : null}
            presetTarget={presetTarget === job.id}
            onToggleDetails={() => toggleExpanded(job.id)}
            onClick={(e) => onRowClick(e, job.id)}
            onDragStart={(e) => onDragStartRow(e, job)}
            onDragOver={(e) => onDragOverRow(e, job)}
            onDrop={(e) => void onDropRow(e, job)}
            onDragEnd={() => {
              dragState.jobIds = null
              clearDnd()
            }}
          />
        ))}
        <div className="job-list-pad" onClick={() => selectJobs([], null)} />
      </div>
    </div>
  )
}

// ───────────────────────────── row ─────────────────────────────

/** Jobs a row action applies to: the whole selection when the row is part of a multi-selection, else just the row. */
function rowTargets(job: Job): Job[] {
  const st = useStore.getState()
  if (st.selected.length < 2 || !st.selected.includes(job.id)) return [job]
  const ids = new Set(st.selected)
  return st.jobs.filter((j) => ids.has(j.id))
}

/** The row's preset dropdown: applies to every kind-compatible editable job of the row's selection. */
async function applyPresetFromRow(job: Job, presetId: string, locale: Parameters<typeof presetName>[1]): Promise<void> {
  const group = rowTargets(job)
  const p = useStore.getState().presets.find((x) => x.id === presetId)
  if (group.length < 2 || !p) {
    await applyPreset([job.id], presetId)
    return
  }
  const ids = group.filter((j) => isEditableJob(j) && isPresetCompatible(j, p)).map((j) => j.id)
  const skipped = group.length - ids.length
  if (await applyPreset(ids, presetId)) toast('success', tNow('browser.applied', { name: presetName(p, locale), n: ids.length }), skipped ? tNow('browser.skipped', { n: skipped }) : undefined)
}

/** Editable jobs of the row's selection that have an output folder setting (in-place renames don't). */
function outputTargets(job: Job): string[] {
  return rowTargets(job)
    .filter((j) => isEditableJob(j) && !(j.kind === 'file' && jobOperation(j) === 'rename'))
    .map((j) => j.id)
}

/** Double-click / Enter: edit when possible, otherwise preview (file jobs: show the file in its folder). */
function openJob(job: Job): void {
  if (isEditableJob(job)) openEditor(job.id)
  else if (job.kind === 'file') void guard(() => api.revealInFolder(job.outputPath ?? job.source))
  else openPreview(job.id)
}

/**
 * Where queued file jobs will go (dry run in main), refreshed shortly after the relevant job fields change.
 * Failures (e.g. an older main process) just leave the targets unknown.
 */
function useFileOpTargets(jobs: Job[]): Map<string, FileOpPreviewItem> {
  const queued = jobs.filter((j) => j.kind === 'file' && j.status === 'queued')
  const key = JSON.stringify(queued.map((j) => [j.id, j.presetId, j.file?.operation, j.output]))
  const debounced = useDebouncedValue(key, 300)
  const [map, setMap] = useState<Map<string, FileOpPreviewItem>>(new Map())
  useEffect(() => {
    const ids = (JSON.parse(debounced) as [string][]).map((x) => x[0])
    if (!ids.length) {
      setMap((m) => (m.size ? new Map() : m))
      return
    }
    let alive = true
    api
      .previewFileOps(ids)
      .then((items) => alive && setMap(new Map(items.map((i) => [i.jobId, i]))))
      .catch((err: unknown) => console.warn('previewFileOps failed', err))
    return () => {
      alive = false
    }
  }, [debounced])
  return map
}

function isModified(job: Job, p: Preset | undefined): boolean {
  if (!p) return false
  if (p.kind === 'file' && job.file) return p.operation !== job.file.operation
  if (p.kind === 'video' && job.video) return JSON.stringify(p.settings) !== JSON.stringify(job.video.settings)
  if (p.kind === 'image' && job.image) return JSON.stringify([p.actions, p.output]) !== JSON.stringify([job.image.actions, job.image.output])
  return false
}

function encoderBadge(encoder?: string): { label: string; gpu: boolean } | null {
  if (!encoder) return null
  if (/nvenc/.test(encoder)) return { label: 'NVENC', gpu: true }
  if (/qsv/.test(encoder)) return { label: 'QSV', gpu: true }
  if (/amf/.test(encoder)) return { label: 'AMF', gpu: true }
  if (/videotoolbox/.test(encoder)) return { label: 'VT', gpu: true }
  if (encoder === 'sharp') return { label: 'libvips', gpu: false }
  if (encoder === 'copy') return { label: 'COPY', gpu: false }
  return { label: 'CPU', gpu: false }
}

function EncoderBadge({ encoder }: { encoder?: string }) {
  const b = encoderBadge(encoder)
  if (!b) return null
  return (
    <span className={cx('enc-badge', b.gpu && 'gpu')} title={encoder}>
      {b.label}
    </span>
  )
}

interface RowProps {
  job: Job
  t: TFunc
  locale: ReturnType<typeof useLocale>
  presets: Preset[]
  selected: boolean
  expanded: boolean
  fileTarget?: FileOpPreviewItem
  dropMark: 'before' | 'after' | null
  presetTarget: boolean
  onToggleDetails: () => void
  onClick: (e: RMouseEvent) => void
  onDragStart: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
  onDragEnd: () => void
}

function JobRow({ job, t, locale, presets, selected, expanded, fileTarget, dropMark, presetTarget, onToggleDetails, onClick, onDragStart, onDragOver, onDrop, onDragEnd }: RowProps) {
  const [outMenu, setOutMenu] = useState<HTMLElement | null>(null)
  const selCount = useStore((s) => s.selected.length)
  const groupHint = selected && selCount > 1 ? t('queue.appliesToSelection', { n: selCount }) : undefined
  const editable = isEditableJob(job)
  const isFile = job.kind === 'file'
  const op = jobOperation(job)
  const OpIcon = FILE_OP_ICON[op]
  const kind: ThumbKind = isFile ? (job.sourceInfo?.kind ?? classifyPath(job.source) ?? 'file') : (job.sourceInfo?.kind ?? (job.kind === 'image' ? 'image' : 'video'))
  const inPlace = isFile && op === 'rename'
  const subfolder = recreatedSubfolder(job)
  // Target name: known once the job started, or from the dry run while it waits.
  const targetPath = job.outputPath ?? (job.status === 'queued' ? (fileTarget?.target ?? undefined) : undefined)
  const targetName = isFile && targetPath && fileName(targetPath) !== fileName(job.source) ? fileName(targetPath) : null
  const compatible = useMemo(() => presets.filter((p) => isPresetCompatible(job, p)), [presets, job])
  const groups = groupByCategory(compatible)
  const preset = presets.find((p) => p.id === job.presetId)
  const known = compatible.some((p) => p.id === job.presetId)
  const modified = useMemo(() => isModified(job, preset), [job, preset])
  const trim = job.video?.trim
  const fps = job.sourceInfo?.fps ?? 30
  const outDirLabel = inPlace ? t('fileops.inPlaceShort') : job.output.dir ? truncateMiddle(job.output.dir, subfolder ? 26 : 34) : t('common.sameAsSource')
  const outDirFull = inPlace ? t('fileops.inPlaceShort') : job.output.dir ? (subfolder ? joinPath(job.output.dir, subfolder) : job.output.dir) : t('common.sameAsSource')

  const outItems: MenuItem[] = [
    {
      key: 'choose',
      label: t('queue.chooseFolder'),
      icon: FolderOpen,
      disabled: !editable,
      onSelect: async () => {
        const dir = await guard(() => api.pickFolder(tNow('dialog.outputFolderTitle')))
        if (dir) await setJobsOutputDir(outputTargets(job), dir)
      },
      hint: groupHint,
    },
    { key: 'same', label: t('common.sameAsSource'), checked: job.output.dir == null, disabled: !editable, hint: groupHint, onSelect: () => void setJobsOutputDir(outputTargets(job), null) },
    {
      key: 'structure',
      label: t('fileops.keepStructure'),
      checked: !!job.output.preserveStructure,
      icon: job.output.preserveStructure ? undefined : FolderTree,
      disabled: !editable || !job.output.dir,
      hint: groupHint ?? (job.relativeDir ? t('fileops.keepStructureRow', { dir: job.relativeDir }) : t('fileops.keepStructureHint')),
      onSelect: () => {
        const ids = new Set(outputTargets(job))
        const withDir = useStore.getState().jobs.filter((j) => ids.has(j.id) && j.output.dir).map((j) => j.id)
        void setJobsPreserveStructure(withDir, !job.output.preserveStructure)
      },
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'reveal',
      label: t('job.openOutputFolder'),
      icon: FolderOpen,
      onSelect: () => void guard(() => api.revealInFolder(job.outputPath ?? job.output.dir ?? job.source)),
    },
  ]

  return (
    <>
      <div
        role="row"
        aria-selected={selected}
        data-job={job.id}
        className={cx('job-row', `st-${job.status}`, selected && 'selected', dropMark && `drop-${dropMark}`, presetTarget && 'preset-target', expanded && 'expanded')}
        draggable={job.status === 'queued'}
        onClick={onClick}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button, select, input')) return
          openJob(job)
        }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      >
        <div className="cell cell-thumb" role="gridcell">
          <Thumb path={job.source} kind={kind} size={160} />
        </div>
        <div className="cell cell-source" role="gridcell">
          <div className={cx('job-name', targetName && 'has-target')} title={targetPath ? `${job.source}\n→ ${targetPath}` : job.source}>
            <span className="job-name-text">{fileName(job.source)}</span>
            {targetName && (
              <>
                <ArrowRight size={12} className="job-arrow" aria-label="→" />
                <span className="job-target">{targetName}</span>
              </>
            )}
          </div>
          <div className="job-sub">
            {isFile && (
              <span className={cx('op-badge', `op-${op}`)} title={t(FILE_OP_LABEL[op])}>
                <OpIcon size={11} aria-hidden /> {t(FILE_OP_LABEL[op])}
              </span>
            )}
            <span className="job-info">{sourceInfoLine(job.sourceInfo, t) || dirName(job.source)}</span>
            {trim && (
              <span className="tag" title={t('job.trimmed')}>
                <Scissors size={11} aria-hidden /> {formatTimecode(trim.inSec, fps).slice(0, 8)}–{formatTimecode(trim.outSec, fps).slice(0, 8)}
              </span>
            )}
          </div>
          <div className="job-sub job-sub-output" title={outDirFull}>
            <FolderOutput size={11} aria-hidden /> {outDirLabel}
            {subfolder && (
              <span className="rel-dir" title={t('fileops.relativeDirHint', { dir: subfolder })}>
                {sepOf(job.output.dir ?? job.source) + subfolder}
              </span>
            )}
          </div>
        </div>
        <div className="cell cell-preset" role="gridcell">
          <div className="preset-cell">
            <Select
              value={job.presetId}
              onChange={(id) => void applyPresetFromRow(job, id, locale)}
              disabled={!editable}
              aria-label={t('queue.colPreset')}
              title={job.presetName}
              className="preset-select"
            >
              {!known && <option value={job.presetId}>{job.presetName}</option>}
              {groups.map(([cat, list]) => (
                <optgroup key={cat} label={t(`category.${cat}` as MessageKey)}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {presetName(p, locale)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            {modified && <span className="mod-dot" title={t('job.modified')} aria-label={t('job.modified')} />}
          </div>
        </div>
        <div className="cell cell-output" role="gridcell">
          {inPlace ? (
            <span className="output-btn same in-place" title={t('fileops.inPlace')}>
              <OpIcon size={13} aria-hidden />
              <span>{outDirLabel}</span>
            </span>
          ) : (
            <button
              type="button"
              className={cx('output-btn', !job.output.dir && 'same')}
              title={outDirFull}
              onClick={(e) => setOutMenu(e.currentTarget)}
              aria-haspopup="menu"
              aria-label={`${t('queue.colOutput')}: ${outDirFull}`}
            >
              <FolderOutput size={13} aria-hidden />
              <span>{outDirLabel}</span>
              {subfolder && (
              <span className="rel-dir" title={t('fileops.relativeDirHint', { dir: subfolder })}>
                {sepOf(job.output.dir ?? job.source) + subfolder}
              </span>
            )}
              <ChevronDown size={12} aria-hidden className="caret" />
            </button>
          )}
          {outMenu && <Menu anchor={outMenu} items={outItems} onClose={() => setOutMenu(null)} />}
        </div>
        <div className="cell cell-status" role="gridcell">
          <StatusCell job={job} t={t} expanded={expanded} onToggleDetails={onToggleDetails} fileTarget={fileTarget} />
        </div>
        <div className="cell cell-actions" role="gridcell">
          {isFile ? (
            // nothing to preview for a file job; "show in folder" instead (done rows already have it in the status cell)
            <IconButton
              icon={FolderOpen}
              label={t('job.reveal')}
              disabled={job.status === 'done'}
              className={cx(job.status === 'done' && 'invisible')}
              onClick={() => void guard(() => api.revealInFolder(job.outputPath ?? job.source))}
            />
          ) : (
            <IconButton icon={Eye} label={t('job.preview')} onClick={() => openPreview(job.id)} />
          )}
          <IconButton
            icon={SlidersHorizontal}
            label={editable ? t('job.edit') : t('job.notEditable')}
            disabled={!editable}
            onClick={() => openEditor(job.id, rowTargets(job).map((j) => j.id))}
          />
          {job.status === 'running' || job.status === 'queued' ? (
            <IconButton
              icon={Square}
              label={t('job.cancel')}
              size={13}
              disabled={job.status === 'queued'}
              onClick={() => void cancelJobs(rowTargets(job).filter((j) => j.status === 'running' || j.status === 'queued').map((j) => j.id))}
              className={cx(job.status === 'queued' && 'invisible')}
            />
          ) : (
            <IconButton icon={RotateCcw} label={t('job.retry')} onClick={() => void retryJobs(rowTargets(job).map((j) => j.id))} />
          )}
          <IconButton icon={X} label={t('job.remove')} tone="danger" onClick={() => void removeJobsConfirm(rowTargets(job).map((j) => j.id))} />
        </div>
      </div>
      {expanded && <JobDetails job={job} t={t} />}
    </>
  )
}

function StatusCell({ job, t, expanded, onToggleDetails, fileTarget }: { job: Job; t: TFunc; expanded: boolean; onToggleDetails: () => void; fileTarget?: FileOpPreviewItem }) {
  const isFile = job.kind === 'file'
  switch (job.status) {
    case 'running':
      return (
        <div className="status status-running">
          <div className="status-line">
            <ProgressBar value={job.progress} />
            <span className="pct">{Math.floor(job.progress * 100)}%</span>
          </div>
          <div className="status-meta">
            <LoaderCircle size={11} className="spin" aria-hidden />
            {job.speed != null && job.kind === 'video' && <span title={t('job.speedHint')}>{job.speed.toFixed(1)}×</span>}
            {job.etaSec != null && <span>{t('job.eta', { eta: formatEta(job.etaSec) })}</span>}
            {!isFile && <EncoderBadge encoder={job.encoder} />}
          </div>
        </div>
      )
    case 'queued':
      return (
        <div className="status status-queued">
          <Clock size={13} aria-hidden /> <span>{t('status.queued')}</span>
          {isFile && fileTarget && fileTarget.status !== 'ok' && (
            <span className={cx('fo-badge', `fo-${fileTarget.status}`)} title={fileTarget.target ?? undefined}>
              {t(FILE_OP_STATUS_LABEL[fileTarget.status])}
            </span>
          )}
        </div>
      )
    case 'done':
      return (
        <div className="status status-done">
          <div className="status-line">
            <CircleCheck size={14} aria-hidden />
            <span className="status-word">{t('status.done')}</span>
            {!isFile && <span className="muted">{formatBytes(job.outputSizeBytes)}</span>}
            {!isFile && <EncoderBadge encoder={job.encoder} />}
            {job.outputPath && (
              <IconButton icon={FolderOpen} size={13} label={t('job.reveal')} className="status-btn" onClick={() => void guard(() => api.revealInFolder(job.outputPath!))} />
            )}
          </div>
          {job.outputPath && (
            <div className="status-path" title={job.outputPath}>
              {fileName(job.outputPath)}
            </div>
          )}
        </div>
      )
    case 'failed':
      return (
        <div className="status status-failed">
          <div className="status-line">
            <CircleAlert size={14} aria-hidden />
            <span className="status-word">{t('status.failed')}</span>
            <button type="button" className="link-btn" onClick={onToggleDetails} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              {t('job.details')}
            </button>
          </div>
          <div className="status-error" title={job.error}>
            {job.error ?? t('job.unknownError')}
          </div>
        </div>
      )
    case 'cancelled':
      return (
        <div className="status status-cancelled">
          <Ban size={13} aria-hidden /> <span>{t('status.cancelled')}</span>
        </div>
      )
    case 'skipped':
      return (
        <div className="status status-skipped">
          <div className="status-line">
            <SkipForward size={13} aria-hidden /> <span className="status-word">{t('status.skipped')}</span>
          </div>
          <div className="status-path" title={job.error ?? job.outputPath}>
            {job.error ? t('job.skippedExists') : ''}
          </div>
        </div>
      )
  }
}

function JobDetails({ job, t }: { job: Job; t: TFunc }) {
  const log = job.logTail?.join('\n') ?? ''
  return (
    <div className="job-details" role="row">
      <div className="job-details-inner" role="gridcell">
        <div className="jd-head">
          <CircleAlert size={14} aria-hidden />
          <strong>{job.error ?? t('job.unknownError')}</strong>
          <span className="tb-spacer" />
          {job.encoder && <span className="muted">{t('job.encoder')}: {job.encoder}</span>}
          <Button
            size="sm"
            icon={Copy}
            disabled={!log}
            onClick={() =>
              void navigator.clipboard
                .writeText(`${job.source}\n${job.error ?? ''}\n\n${log}`)
                .then(() => toast('success', tNow('common.copied')))
                .catch(() => toast('error', tNow('toast.actionFailed')))
            }
          >
            {t('job.copyLog')}
          </Button>
        </div>
        {log ? <pre className="log">{log}</pre> : <div className="muted">{t('job.noLog')}</div>}
      </div>
    </div>
  )
}

// ───────────────────────────── status bar ─────────────────────────────

/** A previewed batch rename waits for its own Run: the queue's Start must not pick those file jobs up. */
const queuedBatchJobs = (): boolean => useStore.getState().jobs.some((j) => j.kind === 'file' && j.status === 'queued')

function StatusBar() {
  const t = useT()
  const jobs = useQueueJobs()
  const running = useStore((s) => s.running)
  const autoStart = useStore((s) => s.settings.autoStart)
  const c = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0, cancelled: 0 }
  let progressSum = 0
  for (const j of jobs) {
    c[j.status]++
    if (j.status === 'running') progressSum += j.progress
  }
  const total = jobs.length - c.cancelled
  const finished = c.done + c.failed + c.skipped
  const overall = total ? (finished + progressSum) / total : 0
  const runningJobs = jobs.filter((j) => j.status === 'running')
  const eta = runningJobs.length ? Math.max(...runningJobs.map((j) => j.etaSec ?? 0)) : null

  return (
    <footer className="statusbar">
      <div className="sb-progress">
        <div className="sb-progress-label">
          <span>{running ? (c.running ? t('bar.encoding') : t('bar.waiting')) : c.queued ? t('bar.ready') : t('bar.idle')}</span>
          <span className="muted">
            {t('bar.progressCount', { done: finished, total })} · {Math.floor(overall * 100)}%
            {running && eta != null && c.running ? ` · ${t('job.eta', { eta: formatEta(eta) })}` : ''}
          </span>
        </div>
        <ProgressBar value={overall} tone={!running && !c.running && !c.queued && total > 0 ? (c.failed ? 'error' : 'ok') : undefined} className="sb-bar" />
      </div>
      <div className="sb-counts">
        <span className="count-chip" title={t('status.queued')}>
          <Clock size={12} aria-hidden /> {c.queued}
          <span className="count-label">{t('status.queued')}</span>
        </span>
        <span className={cx('count-chip', c.running > 0 && 'is-running')} title={t('status.running')}>
          <LoaderCircle size={12} aria-hidden className={cx(c.running > 0 && 'spin')} /> {c.running}
          <span className="count-label">{t('status.running')}</span>
        </span>
        <span className="count-chip ok" title={t('status.done')}>
          <CircleCheck size={12} aria-hidden /> {c.done}
          <span className="count-label">{t('status.done')}</span>
        </span>
        <span className={cx('count-chip', c.failed > 0 && 'err')} title={t('status.failed')}>
          <CircleAlert size={12} aria-hidden /> {c.failed}
          <span className="count-label">{t('status.failed')}</span>
        </span>
      </div>
      <div className="sb-right">
        <Switch checked={autoStart} onChange={(v) => void saveSettings({ autoStart: v })} label={t('bar.autoStart')} title={t('bar.autoStartHint')} />
        {running ? (
          <Button variant="stop" size="lg" icon={Square} onClick={() => void stopQueue()} className="queue-btn">
            {t('bar.stop')}
          </Button>
        ) : (
          <Button variant="start" size="lg" icon={Play} disabled={!c.queued} onClick={() => void startQueue(queuedBatchJobs() ? jobs.filter((j) => j.status === 'queued').map((j) => j.id) : undefined)} className="queue-btn" title={c.queued ? undefined : t('bar.nothingQueued')}>
            {t('bar.start')}
          </Button>
        )}
      </div>
    </footer>
  )
}

// Batch rename / copy / move: choose files → operation, folder, name template → "old name → new name" preview → run.
// Preview adds real file jobs to the queue (addJobs with filePresetId) and asks main for a dry run (previewFileOps);
// Back / closing removes those jobs again unless they were started.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  File as FileIcon,
  FilePen,
  FilePlus,
  Folder,
  FolderOpen,
  FolderOutput,
  FolderPlus,
  Info,
  Play,
  Square,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import type { AddJobsRequest, ConflictPolicy, FileOpPreviewItem, FilePreset, Job, OutputTarget } from '../../../shared/types'
import { api } from '../api'
import {
  addFileOpsEntries,
  clearFileOpsEntries,
  closeFileOps,
  guard,
  refreshQueue,
  removeFileOpsEntry,
  saveSettings,
  selectJobs,
  startQueue,
  stopQueue,
  toast,
  tNow,
  useLocale,
  useStore,
  useT,
  type FileOpsEntry,
} from '../store'
import type { MessageKey } from '../i18n'
import { dirName, fileName, joinPath, truncateMiddle } from '../lib/format'
import { presetDescription, presetName } from '../lib/presets'
import {
  DEFAULT_FILE_TEMPLATE,
  FILE_NAME_TOKENS,
  FILE_OP_DESC,
  FILE_OP_ICON,
  FILE_OP_STATUS_LABEL,
  displaySource,
  displayTarget,
  exampleFileName,
  isAttention,
  isFilePreset,
  naturalCompare,
} from '../lib/fileops'
import { NameTemplateField } from '../components/NameTemplateField'
import { Button, Checkbox, Menu, Modal, Segmented, Select, Switch, cx, type MenuItem } from '../components/ui'

type SortBy = NonNullable<AddJobsRequest['sortBy']>
type StatusCounts = Record<FileOpPreviewItem['status'], number>

const LS_FORM = 'mc-fileops-form'
const MAX_ROWS = 2000
const EXAMPLE_ROWS = 5

interface Remembered {
  template: string
  recursive: boolean
  sortBy: SortBy
}

function readRemembered(): Remembered {
  const d: Remembered = { template: DEFAULT_FILE_TEMPLATE, recursive: true, sortBy: 'name' }
  try {
    const raw = localStorage.getItem(LS_FORM)
    if (!raw) return d
    const v = JSON.parse(raw) as Partial<Remembered>
    return {
      template: typeof v.template === 'string' && v.template.trim() ? v.template : d.template,
      recursive: typeof v.recursive === 'boolean' ? v.recursive : d.recursive,
      sortBy: v.sortBy === 'modified' || v.sortBy === 'taken' || v.sortBy === 'name' ? v.sortBy : d.sortBy,
    }
  } catch {
    return d
  }
}

function writeRemembered(r: Remembered): void {
  try {
    localStorage.setItem(LS_FORM, JSON.stringify(r))
  } catch {
    /* storage unavailable */
  }
}

export function FileOpsModal() {
  const open = useStore((s) => !!s.fileOps)
  if (!open) return null
  return <FileOpsDialog />
}

function FileOpsDialog() {
  const t = useT()
  const locale = useLocale()
  const entries = useStore((s) => s.fileOps?.entries ?? [])
  const presets = useStore((s) => s.presets)
  const settings = useStore((s) => s.settings)
  const queueRunning = useStore((s) => s.running)
  const filePresets = useMemo(() => presets.filter(isFilePreset), [presets])
  const [remembered] = useState(readRemembered)
  const [presetId, setPresetId] = useState<string>(() => {
    const list = useStore.getState().presets.filter(isFilePreset)
    return (list.find((p) => p.id === settings.lastFilePresetId) ?? list[0])?.id ?? ''
  })
  const [outputDir, setOutputDir] = useState<string | null>(settings.defaultOutputDir)
  const [preserve, setPreserve] = useState(settings.preserveStructure)
  const [recursive, setRecursive] = useState(remembered.recursive)
  const [sortBy, setSortBy] = useState<SortBy>(remembered.sortBy)
  const [template, setTemplate] = useState(remembered.template)
  const [conflict, setConflict] = useState<ConflictPolicy>(settings.conflict)
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [busy, setBusy] = useState<'preview' | 'back' | 'run' | null>(null)
  const [created, setCreated] = useState<Job[]>([])
  const [items, setItems] = useState<FileOpPreviewItem[]>([])
  const [ignored, setIgnored] = useState<string[]>([])
  const createdIds = useRef<string[]>([])
  const started = useRef(false)

  const preset: FilePreset | undefined = filePresets.find((p) => p.id === presetId) ?? filePresets[0]
  const op = preset?.operation ?? 'rename'
  const usesFolder = op !== 'rename'
  const hasFolders = entries.some((e) => e.isFolder)

  // Jobs created for the preview are removed when the dialog goes away without running them.
  useEffect(() => {
    return () => {
      if (!started.current && createdIds.current.length) void discardJobs(createdIds.current)
    }
  }, [])

  const close = async (): Promise<void> => {
    if (busy === 'run') return
    const ids = createdIds.current
    createdIds.current = []
    closeFileOps()
    if (!started.current && ids.length) await discardJobs(ids)
  }

  const preview = async (): Promise<void> => {
    if (!entries.length || !preset || busy) return
    setBusy('preview')
    const tpl = template.trim() || '{name}'
    writeRemembered({ template: tpl, recursive, sortBy })
    if (preset.id !== settings.lastFilePresetId) void saveSettings({ lastFilePresetId: preset.id })
    const output: Partial<OutputTarget> = {
      dir: usesFolder ? outputDir : null,
      nameTemplate: tpl,
      conflict,
      preserveStructure: usesFolder && !!outputDir && preserve,
    }
    const res = await guard(
      () => api.addJobs({ paths: entries.map((e) => e.path), recursive, filePresetId: preset.id, sortBy, output }),
      'toast.addFailed',
    )
    if (!res) {
      setBusy(null)
      return
    }
    createdIds.current = res.jobs.map((j) => j.id)
    await refreshQueue()
    if (!res.jobs.length) {
      setBusy(null)
      toast('error', tNow('fileops.nothingFound'), res.ignored.length ? tNow('fileops.ignoredCount', { n: res.ignored.length }) : undefined)
      return
    }
    const list = await guard(() => api.previewFileOps(createdIds.current), 'fileops.previewFailed')
    if (!list) {
      const ids = createdIds.current
      createdIds.current = []
      await discardJobs(ids)
      setBusy(null)
      return
    }
    // Rows in queue order (= {counter} order).
    const order = new Map(res.jobs.map((j, i) => [j.id, i]))
    list.sort((a, b) => (order.get(a.jobId) ?? 0) - (order.get(b.jobId) ?? 0))
    setCreated(res.jobs)
    setItems(list)
    setIgnored(res.ignored)
    setStep('preview')
    setBusy(null)
  }

  const back = async (): Promise<void> => {
    setBusy('back')
    const ids = createdIds.current
    createdIds.current = []
    await discardJobs(ids)
    setItems([])
    setCreated([])
    setIgnored([])
    setStep('form')
    setBusy(null)
  }

  const run = async (): Promise<void> => {
    setBusy('run')
    started.current = true
    const ids = createdIds.current
    await startQueue()
    selectJobs(ids, ids[0] ?? null)
    toast('info', tNow('fileops.started', { n: ids.length }), tNow('fileops.startedHint'))
    closeFileOps()
  }

  const subtitle = step === 'form' ? t('fileops.stepForm') : t('fileops.stepPreview')

  return (
    <Modal
      title={t('fileops.title')}
      subtitle={subtitle}
      icon={FilePen}
      size="lg"
      onClose={() => void close()}
      closeOnBackdrop={false}
      className="fo-modal"
      bodyClassName={cx('fo-body', step === 'preview' && 'fo-body-preview')}
      footer={
        step === 'form' ? (
          <FormFooter
            canPreview={!!entries.length && !!preset && !queueRunning && busy == null}
            busy={busy === 'preview'}
            blockedReason={!entries.length ? t('fileops.needFiles') : queueRunning ? t('fileops.queueBusyShort') : undefined}
            onCancel={() => void close()}
            onPreview={() => void preview()}
          />
        ) : (
          <PreviewFooter items={items} created={created} busy={busy} onBack={() => void back()} onRun={() => void run()} />
        )
      }
    >
      {step === 'form' ? (
        <div className="fo-form">
          {queueRunning && (
            <div className="issue issue-warning fo-busy">
              <TriangleAlert size={14} aria-hidden />
              <span>{t('fileops.queueBusy')}</span>
              <button type="button" className="link-btn" onClick={() => void stopQueue()}>
                <Square size={11} aria-hidden /> {t('bar.stop')}
              </button>
            </div>
          )}
          <div className="fo-col">
            <FilesPanel entries={entries} recursive={recursive} onRecursive={setRecursive} sortBy={sortBy} onSortBy={setSortBy} />
          </div>
          <div className="fo-col">
            <section className="fo-section">
              <h3 className="fo-h">{t('fileops.operation')}</h3>
              <div className="fo-ops" role="radiogroup" aria-label={t('fileops.operation')}>
                {filePresets.map((p) => {
                  const Icon = FILE_OP_ICON[p.operation]
                  const desc = presetDescription(p, locale) || t(FILE_OP_DESC[p.operation])
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="radio"
                      aria-checked={p.id === preset?.id}
                      className={cx('fo-op', p.id === preset?.id && 'active', `op-${p.operation}`)}
                      onClick={() => setPresetId(p.id)}
                      title={desc}
                    >
                      <span className="fo-op-icon" aria-hidden>
                        <Icon size={16} />
                      </span>
                      <span className="fo-op-text">
                        <span className="fo-op-name">{presetName(p, locale)}</span>
                        <span className="fo-op-desc">{desc}</span>
                      </span>
                    </button>
                  )
                })}
                {!filePresets.length && <div className="fo-empty-note">{t('fileops.noPresets')}</div>}
              </div>
            </section>
            <section className="fo-section">
              <h3 className="fo-h">{t('fileops.destination')}</h3>
              {usesFolder ? (
                <OutputFolderField dir={outputDir} onChange={setOutputDir} preserve={preserve} onPreserve={setPreserve} hasFolders={hasFolders} move={op === 'move'} />
              ) : (
                <div className="fo-inplace">
                  <FolderOpen size={14} aria-hidden />
                  <span>{t('fileops.inPlace')}</span>
                </div>
              )}
            </section>
          </div>
          <section className="fo-section fo-name">
            <h3 className="fo-h">{t('fileops.newName')}</h3>
            <NameTemplateField value={template} onChange={setTemplate} tokens={FILE_NAME_TOKENS} ariaLabel={t('fileops.newName')} />
            <Examples entries={entries} template={template} sortBy={sortBy} presetLabel={preset ? presetName(preset, locale) : ''} />
            <div className="fo-conflict">
              <span className="fo-label">{t('editor.conflict')}</span>
              <Select value={conflict} onChange={(v) => setConflict(v as ConflictPolicy)} aria-label={t('editor.conflict')}>
                {(['rename', 'overwrite', 'skip'] as const).map((c) => (
                  <option key={c} value={c}>
                    {t(`conflict.${c}` as MessageKey)}
                  </option>
                ))}
              </Select>
              <span className="fo-hint">{t('fileops.neverSameName')}</span>
            </div>
          </section>
        </div>
      ) : (
        <PreviewTable items={items} created={created} ignored={ignored} outputDir={usesFolder ? outputDir : null} />
      )}
    </Modal>
  )
}

async function discardJobs(ids: string[]): Promise<void> {
  const live = useStore
    .getState()
    .jobs.filter((j) => ids.includes(j.id) && j.status !== 'running' && j.status !== 'done')
    .map((j) => j.id)
  if (!live.length) return
  await guard(() => api.removeJobs(live))
  await refreshQueue()
}

// ───────────────────────────── form parts ─────────────────────────────

function FilesPanel({
  entries,
  recursive,
  onRecursive,
  sortBy,
  onSortBy,
}: {
  entries: FileOpsEntry[]
  recursive: boolean
  onRecursive: (v: boolean) => void
  sortBy: SortBy
  onSortBy: (v: SortBy) => void
}) {
  const t = useT()
  const files = entries.filter((e) => !e.isFolder).length
  const folders = entries.length - files

  const addFiles = async (): Promise<void> => {
    const paths = await guard(() => api.pickFiles('media', true))
    if (paths?.length) addFileOpsEntries(paths.map((path) => ({ path, isFolder: false })))
  }
  const addFolder = async (): Promise<void> => {
    const dir = await guard(() => api.pickFolder(tNow('fileops.pickFolderTitle')))
    if (dir) addFileOpsEntries([{ path: dir, isFolder: true }])
  }

  return (
    <section className="fo-section fo-files">
      <div className="fo-h-row">
        <h3 className="fo-h">{t('fileops.files')}</h3>
        {entries.length > 0 && (
          <>
            <span className="fo-count">{t('fileops.entryCount', { files, folders })}</span>
            <button type="button" className="link-btn" onClick={clearFileOpsEntries}>
              {t('common.clear')}
            </button>
          </>
        )}
      </div>
      <div className="fo-add-row">
        <Button size="sm" icon={FilePlus} onClick={() => void addFiles()}>
          {t('queue.addFiles')}
        </Button>
        <Button size="sm" icon={FolderPlus} onClick={() => void addFolder()}>
          {t('queue.addFolder')}
        </Button>
      </div>
      {entries.length ? (
        <ul className="fo-entries" aria-label={t('fileops.files')}>
          {entries.map((e) => (
            <li key={e.path} className="fo-entry" title={e.path}>
              {e.isFolder ? <Folder size={14} className="fo-entry-icon folder" aria-hidden /> : <FileIcon size={14} className="fo-entry-icon" aria-hidden />}
              <span className="fo-entry-text">
                <span className="fo-entry-name">{fileName(e.path) || e.path}</span>
                <span className="fo-entry-path">{dirName(e.path)}</span>
              </span>
              <button type="button" className="fo-entry-x" onClick={() => removeFileOpsEntry(e.path)} aria-label={`${t('common.remove')}: ${fileName(e.path)}`} title={t('common.remove')}>
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="fo-drop">
          <Upload size={20} aria-hidden />
          <span>{t('fileops.dropHere')}</span>
          <span className="fo-hint">{t('fileops.anyType')}</span>
        </div>
      )}
      <div className="fo-files-opts">
        <Checkbox checked={recursive} onChange={onRecursive} label={t('fileops.recursive')} disabled={!folders && entries.length > 0} title={t('fileops.recursiveHint')} />
        <div className="fo-sort">
          <span className="fo-label">{t('fileops.sortBy')}</span>
          <Segmented<SortBy>
            size="sm"
            value={sortBy}
            onChange={onSortBy}
            ariaLabel={t('fileops.sortBy')}
            options={[
              { value: 'name', label: t('fileops.sortName'), title: t('fileops.sortNameHint') },
              { value: 'modified', label: t('fileops.sortModified'), title: t('fileops.sortModifiedHint') },
              { value: 'taken', label: t('fileops.sortTaken'), title: t('fileops.sortTakenHint') },
            ]}
          />
        </div>
      </div>
    </section>
  )
}

function OutputFolderField({
  dir,
  onChange,
  preserve,
  onPreserve,
  hasFolders,
  move,
}: {
  dir: string | null
  onChange: (d: string | null) => void
  preserve: boolean
  onPreserve: (v: boolean) => void
  hasFolders: boolean
  move: boolean
}) {
  const t = useT()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const items: MenuItem[] = [
    {
      key: 'choose',
      label: t('queue.chooseFolder'),
      icon: FolderOpen,
      onSelect: async () => {
        const d = await guard(() => api.pickFolder(tNow('dialog.outputFolderTitle')))
        if (d) onChange(d)
      },
    },
    { key: 'same', label: t('common.sameAsSource'), checked: dir == null, onSelect: () => onChange(null) },
  ]
  return (
    <div className="fo-dest">
      <button
        type="button"
        className={cx('je-folder-btn', !dir && 'same')}
        title={dir ?? t('common.sameAsSource')}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        aria-label={`${t('editor.outputFolder')}: ${dir ?? t('common.sameAsSource')}`}
        onClick={(e) => setAnchor(e.currentTarget)}
      >
        <FolderOutput size={14} aria-hidden />
        <span>{dir ?? t('common.sameAsSource')}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {anchor && <Menu anchor={anchor} items={items} onClose={() => setAnchor(null)} />}
      <Switch checked={preserve && !!dir} onChange={onPreserve} disabled={!dir} label={t('fileops.keepStructure')} title={t('fileops.keepStructureHint')} />
      <div className="fo-hint">
        {!dir
          ? move
            ? t('fileops.moveSameFolder')
            : t('fileops.copySameFolder')
          : preserve
            ? hasFolders
              ? t('fileops.structureOn')
              : t('fileops.structureOnlyFolders')
            : t('fileops.structureOff')}
      </div>
    </div>
  )
}

function Examples({ entries, template, sortBy, presetLabel }: { entries: FileOpsEntry[]; template: string; sortBy: SortBy; presetLabel: string }) {
  const t = useT()
  const files = entries.filter((e) => !e.isFolder).map((e) => e.path)
  const folder = entries.find((e) => e.isFolder)?.path
  const sample = !files.length
  const now = useMemo(() => new Date(), [])
  const list = useMemo(() => {
    let src = files
    if (sample) {
      const base = folder ?? 'C:\\Photos'
      src = ['IMG_0001.JPG', 'IMG_0002.JPG', 'IMG_0003.JPG'].map((n) => joinPath(base, n))
    } else if (sortBy === 'name') {
      src = [...files].sort((a, b) => naturalCompare(fileName(a), fileName(b)))
    }
    return src.slice(0, EXAMPLE_ROWS).map((p, i) => ({ from: fileName(p), to: exampleFileName(p, template.trim() || '{name}', { counter: i + 1, preset: presetLabel, now }) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.join('|'), folder, sample, sortBy, template, presetLabel, now])
  const datesUsed = /\{(exifdate|exiftime|mdate)\}/.test(template)
  return (
    <div className="fo-examples">
      <div className="fo-examples-head">
        <span>{sample ? t('fileops.exampleSample') : t('fileops.example')}</span>
        {!sample && files.length > EXAMPLE_ROWS && <span className="fo-hint">{t('fileops.exampleMore', { n: files.length - EXAMPLE_ROWS })}</span>}
      </div>
      <ul>
        {list.map((r, i) => (
          <li key={i} className={cx(sample && 'sample')}>
            <span className="fo-ex-from" title={r.from}>
              {r.from}
            </span>
            <ArrowRight size={12} aria-hidden />
            <span className={cx('fo-ex-to', r.to === r.from && 'same')} title={r.to}>
              {r.to}
            </span>
          </li>
        ))}
      </ul>
      {(datesUsed || sortBy !== 'name' || entries.some((e) => e.isFolder)) && (
        <div className="fo-hint fo-examples-note">
          <Info size={12} aria-hidden /> {t('fileops.exampleNote')}
        </div>
      )}
    </div>
  )
}

function FormFooter({ canPreview, busy, blockedReason, onCancel, onPreview }: { canPreview: boolean; busy: boolean; blockedReason?: string; onCancel: () => void; onPreview: () => void }) {
  const t = useT()
  return (
    <>
      <span className="fo-foot-note">{t('fileops.footNoteForm')}</span>
      <span className="footer-spacer" />
      <Button onClick={onCancel}>{t('common.cancel')}</Button>
      <Button variant="primary" iconRight={ArrowRight} onClick={onPreview} disabled={!canPreview} busy={busy} title={blockedReason}>
        {t('fileops.preview')}
      </Button>
    </>
  )
}

// ───────────────────────────── preview step ─────────────────────────────

function countStatuses(items: FileOpPreviewItem[]): StatusCounts {
  const c: StatusCounts = { ok: 0, renamed: 0, overwrite: 0, skip: 0, unchanged: 0 }
  for (const i of items) c[i.status]++
  return c
}

function PreviewTable({ items, created, ignored, outputDir }: { items: FileOpPreviewItem[]; created: Job[]; ignored: string[]; outputDir: string | null }) {
  const t = useT()
  const [filter, setFilter] = useState<'all' | 'attention'>('all')
  const jobs = useMemo(() => new Map(created.map((j) => [j.id, j])), [created])
  const c = countStatuses(items)
  const attention = c.renamed + c.overwrite + c.skip
  const rows = filter === 'all' ? items : items.filter((i) => isAttention(i.status))
  const shown = rows.slice(0, MAX_ROWS)
  const index = useMemo(() => new Map(items.map((it, i) => [it.jobId, i + 1])), [items])

  return (
    <div className="fo-preview">
      <div className="fo-summary">
        <div className="fo-summary-main">
          <strong>{t('fileops.previewCount', { n: items.length })}</strong>
          <span className="fo-summary-dest" title={outputDir ?? undefined}>
            {outputDir ? t('fileops.into', { dir: truncateMiddle(outputDir, 60) }) : t('fileops.inPlaceShort')}
          </span>
        </div>
        <div className="fo-chips">
          {(['ok', 'renamed', 'overwrite', 'skip', 'unchanged'] as const).map(
            (s) =>
              c[s] > 0 && (
                <span key={s} className={cx('fo-badge', `fo-${s}`)}>
                  {t(FILE_OP_STATUS_LABEL[s])} <b>{c[s]}</b>
                </span>
              ),
          )}
        </div>
      </div>
      <div className="fo-notes">
        {c.overwrite > 0 && (
          <div className="issue issue-error">
            <CircleAlert size={14} aria-hidden />
            <span>{t('fileops.noteOverwrite', { n: c.overwrite })}</span>
          </div>
        )}
        {c.skip > 0 && (
          <div className="issue issue-warning">
            <TriangleAlert size={14} aria-hidden />
            <span>{t('fileops.noteSkip', { n: c.skip })}</span>
          </div>
        )}
        {c.renamed > 0 && (
          <div className="issue issue-warning">
            <Info size={14} aria-hidden />
            <span>{t('fileops.noteRenamed', { n: c.renamed })}</span>
          </div>
        )}
        {c.unchanged === items.length && (
          <div className="issue issue-warning">
            <TriangleAlert size={14} aria-hidden />
            <span>{t('fileops.noteNothing')}</span>
          </div>
        )}
        {ignored.length > 0 && (
          <div className="fo-hint fo-ignored" title={ignored.slice(0, 20).map(fileName).join('\n')}>
            <Info size={12} aria-hidden /> {t('fileops.ignoredCount', { n: ignored.length })}
          </div>
        )}
      </div>
      {attention > 0 && (
        <Segmented<'all' | 'attention'>
          size="sm"
          value={filter}
          onChange={setFilter}
          ariaLabel={t('fileops.filter')}
          options={[
            { value: 'all', label: t('fileops.filterAll', { n: items.length }) },
            { value: 'attention', label: t('fileops.filterAttention', { n: attention }) },
          ]}
        />
      )}
      <div className="fo-table" role="table" aria-label={t('fileops.tableLabel')}>
        <div className="fo-tr fo-thead" role="row">
          <span role="columnheader" className="fo-td num">
            #
          </span>
          <span role="columnheader" className="fo-td">
            {t('fileops.colOld')}
          </span>
          <span role="columnheader" className="fo-td arrow" aria-hidden />
          <span role="columnheader" className="fo-td">
            {t('fileops.colNew')}
          </span>
          <span role="columnheader" className="fo-td status">
            {t('queue.colStatus')}
          </span>
        </div>
        <div className="fo-tbody">
          {shown.map((it) => {
            const job = jobs.get(it.jobId)
            const from = displaySource(it.source, job?.relativeDir)
            const to = it.target ? displayTarget(it.target, it.source, outputDir) : null
            return (
              <div key={it.jobId} className={cx('fo-tr', `row-${it.status}`)} role="row">
                <span role="cell" className="fo-td num">
                  {index.get(it.jobId)}
                </span>
                <span role="cell" className="fo-td old" title={it.source}>
                  {from}
                </span>
                <span role="cell" className="fo-td arrow" aria-hidden>
                  <ArrowRight size={12} />
                </span>
                <span role="cell" className={cx('fo-td new', !to && 'none')} title={it.target ?? undefined}>
                  {to ?? '—'}
                </span>
                <span role="cell" className="fo-td status">
                  <span className={cx('fo-badge', `fo-${it.status}`)}>{t(FILE_OP_STATUS_LABEL[it.status])}</span>
                </span>
              </div>
            )
          })}
          {rows.length > shown.length && <div className="fo-more">{t('fileops.moreRows', { n: rows.length - shown.length })}</div>}
          {!rows.length && <div className="fo-more">{t('fileops.noAttention')}</div>}
        </div>
      </div>
    </div>
  )
}

function PreviewFooter({
  items,
  created,
  busy,
  onBack,
  onRun,
}: {
  items: FileOpPreviewItem[]
  created: Job[]
  busy: 'preview' | 'back' | 'run' | null
  onBack: () => void
  onRun: () => void
}) {
  const t = useT()
  const otherQueued = useStore((s) => {
    const mine = new Set(created.map((j) => j.id))
    return s.jobs.filter((j) => j.status === 'queued' && !mine.has(j.id)).length
  })
  const actionable = items.filter((i) => i.status !== 'skip' && i.status !== 'unchanged').length
  return (
    <>
      <Button icon={ArrowLeft} onClick={onBack} disabled={busy != null} busy={busy === 'back'}>
        {t('common.back')}
      </Button>
      <span className={cx('fo-foot-note', otherQueued > 0 && 'warn')}>
        {otherQueued > 0 ? t('fileops.runAllQueued', { n: otherQueued }) : t('fileops.runStartsQueue')}
      </span>
      <span className="footer-spacer" />
      <Button variant="start" icon={Play} onClick={onRun} disabled={!actionable || busy != null} busy={busy === 'run'} title={!actionable ? t('fileops.nothingToRun') : undefined}>
        {t('fileops.run', { n: actionable })}
      </Button>
    </>
  )
}

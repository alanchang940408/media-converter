// Edit one queued job's settings snapshot (video: encode settings + watermark + trim; image: action chain + output),
// plus its output target. "Apply" patches the job; "Save as preset" stores a new user preset and links the job to it.
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, FolderOpen, FolderOutput, FolderTree, Info, Layers, Lock, Music, RotateCcw, Save, Scissors, SlidersHorizontal } from 'lucide-react'
import type {
  ConflictPolicy,
  FileOperation,
  ImageAction,
  ImageOutputSettings,
  Job,
  JobPatch,
  OutputTarget,
  Preset,
  Trim,
  VideoPresetSettings,
} from '../../../shared/types'
import { isAudioOnlyContainer, validateVideoSettings } from '../../../shared/videoRules'
import { renderNameTemplate } from '../../../shared/naming'
import { baseNameOf, extOf } from '../../../shared/media'
import { api } from '../api'
import { closeEditor, confirmDialog, guard, promptDialog, refreshQueue, savePreset, toast, tNow, updateJob, useLocale, useStore, useT } from '../store'
import type { MessageKey } from '../i18n'
import { clone, isEditableJob, presetName } from '../lib/presets'
import { clamp, dirName, fileName, formatTimecode, joinPath } from '../lib/format'
import { computeVideoOutputSize } from '../lib/videoSize'
import { useDebouncedValue } from '../lib/hooks'
import { FILE_NAME_TOKENS, FILE_OPS, FILE_OP_DESC, FILE_OP_ICON, FILE_OP_LABEL, dotExt, exampleFileName } from '../lib/fileops'
import { TimecodeInput } from '../components/TimecodeInput'
import { NameTemplateField } from '../components/NameTemplateField'
import { Button, Menu, Modal, Select, Spinner, Switch, TextInput, cx, type MenuItem } from '../components/ui'
import { VideoSettingsForm } from '../editors/VideoSettingsForm'
import { ImageChainEditor } from '../editors/ImageChainEditor'

interface Draft {
  video?: VideoPresetSettings
  trim: Trim | null
  actions?: ImageAction[]
  imgOutput?: ImageOutputSettings
  /** File jobs (rename / copy / move). */
  operation?: FileOperation
  output: OutputTarget
}

function draftFromJob(job: Job): Draft {
  return {
    video: job.video ? clone(job.video.settings) : undefined,
    trim: job.video?.trim ? { ...job.video.trim } : null,
    actions: job.image ? clone(job.image.actions) : undefined,
    imgOutput: job.image ? clone(job.image.output) : undefined,
    operation: job.kind === 'file' ? (job.file?.operation ?? 'rename') : undefined,
    output: { ...job.output },
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function JobEditorModal() {
  const id = useStore((s) => s.editorJobId)
  const job = useStore((s) => (s.editorJobId ? s.jobs.find((j) => j.id === s.editorJobId) : undefined))
  if (!id || !job) return null
  return <JobEditor key={job.id} job={job} />
}

function JobEditor({ job }: { job: Job }) {
  const t = useT()
  const locale = useLocale()
  const presets = useStore((s) => s.presets)
  const [baseline] = useState(() => draftFromJob(job))
  const [draft, setDraft] = useState<Draft>(baseline)
  const [busy, setBusy] = useState<'apply' | 'save' | null>(null)
  const locked = !isEditableJob(job)
  const isFile = job.kind === 'file'
  const isVideo = job.kind === 'video' && !!draft.video
  const preset = presets.find((p) => p.id === job.presetId)
  const presetLabel = preset ? presetName(preset, locale) : job.presetName.replace(/\*$/, '')
  // Multi-selection edit: the settings go to every selected non-running job of the same kind (audio vs video too).
  const groupIds = useStore((s) => s.editorGroup)
  const allJobs = useStore((s) => s.jobs)
  const group = groupIds.length > 1 ? allJobs.filter((j) => groupIds.includes(j.id)) : []
  const isAudio = job.sourceInfo?.kind === 'audio'
  const groupTargets = group.filter((j) => j.kind === job.kind && isEditableJob(j) && (j.kind !== 'video' || (j.sourceInfo?.kind === 'audio') === isAudio))
  const many = !locked && groupTargets.length > 1 && groupTargets.some((j) => j.id === job.id)
  const groupSkipped = group.length - groupTargets.length

  const dirty = !same(draft, baseline)
  const issues = draft.video ? validateVideoSettings(draft.video) : []
  const hasErrors = issues.some((i) => i.level === 'error')
  const differsFromPreset = preset
    ? preset.kind === 'video'
      ? !!draft.video && !same(preset.settings, draft.video)
      : preset.kind === 'image'
        ? !same([preset.actions, preset.output], [draft.actions, draft.imgOutput])
        : preset.operation !== draft.operation
    : false

  const requestClose = async (): Promise<void> => {
    if (dirty && !locked) {
      const ok = await confirmDialog({ title: tNow('editor.discardTitle'), message: tNow('editor.discardBody'), confirmLabel: tNow('common.discard'), danger: true })
      if (!ok) return
    }
    closeEditor()
  }

  const revert = (): void => {
    if (!preset) return
    if (preset.kind === 'video') setDraft((d) => ({ ...d, video: clone(preset.settings) }))
    else if (preset.kind === 'image') setDraft((d) => ({ ...d, actions: clone(preset.actions), imgOutput: clone(preset.output) }))
    else setDraft((d) => ({ ...d, operation: preset.operation }))
  }

  const buildPatch = (): JobPatch => {
    const patch: JobPatch = {}
    if (isFile) {
      if (draft.operation && draft.operation !== baseline.operation) patch.file = { operation: draft.operation }
    } else if (isVideo) {
      const v: NonNullable<JobPatch['video']> = {}
      if (!same(draft.video, baseline.video)) v.settings = draft.video
      if (!same(draft.trim, baseline.trim)) v.trim = draft.trim
      if (Object.keys(v).length) patch.video = v
    } else if (draft.actions && draft.imgOutput) {
      const im: NonNullable<JobPatch['image']> = {}
      if (!same(draft.actions, baseline.actions)) im.actions = draft.actions
      if (!same(draft.imgOutput, baseline.imgOutput)) im.output = draft.imgOutput
      if (Object.keys(im).length) patch.image = im
    }
    if (!same(draft.output, baseline.output)) patch.output = draft.output
    return patch
  }

  /** What the other jobs of a multi-selection get: the clicked job's settings + output row, never its trim. */
  const groupPatch = (): JobPatch => {
    const patch: JobPatch = { presetId: job.presetId, output: { ...draft.output } }
    if (isFile) patch.file = { operation: draft.operation }
    else if (isVideo) patch.video = { settings: draft.video }
    else if (draft.actions && draft.imgOutput) patch.image = { actions: draft.actions, output: draft.imgOutput }
    return patch
  }

  const apply = async (): Promise<void> => {
    setBusy('apply')
    if (many) {
      let ok = 0
      for (const j of groupTargets) {
        const patch = j.id === job.id ? buildPatch() : groupPatch()
        if (await guard(() => api.updateJob(j.id, patch), 'toast.updateFailed')) ok++
      }
      await refreshQueue()
      setBusy(null)
      if (ok) {
        toast('success', tNow('editor.appliedMany', { n: ok }), groupSkipped ? tNow('editor.groupSkipped', { n: groupSkipped }) : undefined)
        closeEditor()
      }
      return
    }
    const r = await updateJob(job.id, buildPatch())
    setBusy(null)
    if (r) {
      toast('success', tNow('editor.applied'))
      closeEditor()
    }
  }

  const saveAsPreset = async (): Promise<void> => {
    const name = await promptDialog({
      title: tNow('editor.presetSaveTitle'),
      label: tNow('editor.presetNamePrompt'),
      value: tNow('editor.customName', { name: presetLabel }),
      confirmLabel: tNow('common.save'),
    })
    if (!name) return
    setBusy('save')
    const p: Preset = isFile
      ? { id: '', kind: 'file', name, category: 'custom', builtIn: false, operation: draft.operation ?? 'rename' }
      : isVideo && draft.video
        ? { id: '', kind: 'video', name, category: 'custom', builtIn: false, settings: clone(draft.video) }
        : { id: '', kind: 'image', name, category: 'custom', builtIn: false, actions: clone(draft.actions ?? []), output: clone(draft.imgOutput!) }
    const saved = await savePreset(p)
    if (!saved) {
      setBusy(null)
      return
    }
    toast('success', tNow('editor.presetSaved', { name: saved.name }))
    // The queue may have started this job while the dialog was open — only link it if it is still editable.
    const live = useStore.getState().jobs.find((j) => j.id === job.id)
    if (live && isEditableJob(live)) {
      const patch: JobPatch = { presetId: saved.id }
      if (isVideo) patch.video = { trim: draft.trim }
      if (!same(draft.output, baseline.output)) patch.output = draft.output
      await updateJob(job.id, patch)
    }
    setBusy(null)
    closeEditor()
  }

  const subtitle = (
    <>
      {fileName(job.source)}
      <span className="je-sub-sep">·</span>
      {t('editor.basedOn', { name: presetLabel })}
      {differsFromPreset && <span className="je-mod">{t('editor.modified')}</span>}
    </>
  )

  return (
    <Modal
      title={t('editor.title')}
      subtitle={subtitle}
      icon={SlidersHorizontal}
      size={isFile ? 'md' : 'xl'}
      onClose={() => void requestClose()}
      closeOnBackdrop={false}
      className={cx('editor-modal', isFile && 'editor-modal-file')}
      bodyClassName="je-body"
      footer={
        <>
          <Button variant="ghost" icon={RotateCcw} onClick={revert} disabled={!preset || !differsFromPreset || locked}>
            {t('editor.revert')}
          </Button>
          <span className="footer-spacer" />
          <Button icon={Save} onClick={() => void saveAsPreset()} disabled={hasErrors || busy != null} busy={busy === 'save'}>
            {t('editor.saveAsPreset')}
          </Button>
          <Button onClick={() => void requestClose()}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void apply()} disabled={(!dirty && !many) || locked || hasErrors || busy != null} busy={busy === 'apply'}>
            {many ? t('editor.applyToMany', { n: groupTargets.length }) : t('editor.apply')}
          </Button>
        </>
      }
    >
      {locked && (
        <div className="je-banner">
          <Lock size={14} aria-hidden /> {t('editor.locked')}
        </div>
      )}
      {many && (
        <div className="je-banner je-banner-group">
          <Layers size={14} aria-hidden /> {t('editor.groupNote', { n: groupTargets.length })}
          {groupSkipped > 0 && <> {t('editor.groupSkipped', { n: groupSkipped })}</>}
        </div>
      )}
      {isFile ? (
        <FileJobForm job={job} draft={draft} presetLabel={presetLabel} disabled={locked} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
      ) : isVideo && draft.video ? (
        <div className="je-main je-video">
          <div className="je-form">
            <VideoSettingsForm value={draft.video} onChange={(video) => setDraft((d) => ({ ...d, video }))} sourceInfo={job.sourceInfo} disabled={locked} />
          </div>
          <aside className="je-side">
            <OutputFramePreview job={job} settings={draft.video} trim={draft.trim} />
            <TrimCard job={job} trim={draft.trim} disabled={locked} onChange={(trim) => setDraft((d) => ({ ...d, trim }))} />
          </aside>
        </div>
      ) : draft.actions && draft.imgOutput ? (
        <div className={cx('je-main je-image', locked && 'is-locked')}>
          <ImageChainEditor
            actions={draft.actions}
            output={draft.imgOutput}
            onChange={(actions, imgOutput) => setDraft((d) => ({ ...d, actions, imgOutput }))}
            fixedSample={job.source}
          />
        </div>
      ) : null}
      {!isFile && <OutputTargetBar job={job} draft={draft} presetLabel={presetLabel} disabled={locked} onChange={(output) => setDraft((d) => ({ ...d, output }))} />}
    </Modal>
  )
}

// ───────────────────────────── output frame preview ─────────────────────────────

function OutputFramePreview({ job, settings, trim }: { job: Job; settings: VideoPresetSettings; trim: Trim | null }) {
  const t = useT()
  const info = job.sourceInfo
  const fps = info?.fps && info.fps > 0 ? info.fps : 30
  const duration = info?.durationSec ?? 0
  const audio = info?.kind === 'audio' || isAudioOnlyContainer(settings.container) || settings.video.codec === 'none'
  const outSize = computeVideoOutputSize(info, settings)
  const [time, setTime] = useState(() => (trim ? trim.inSec + (trim.outSec - trim.inSec) * 0.25 : Math.min(duration * 0.2, 30)))
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const key = useDebouncedValue(JSON.stringify([settings, Math.round(time * 10) / 10]), 350)

  useEffect(() => {
    if (audio) return
    let alive = true
    setLoading(true)
    api
      .previewVideoFrame(job.source, time, settings, 720)
      .then((u) => {
        if (!alive) return
        setUrl(u)
        setFailed(false)
      })
      .catch((err: unknown) => {
        console.error(err)
        if (alive) setFailed(true)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, audio, job.source])

  const ratio = outSize ? `${outSize.width} / ${outSize.height}` : '16 / 9'
  return (
    <section className="section je-card">
      <header className="section-header">
        <h3>{t('editor.outputPreview')}</h3>
        {outSize && !audio && (
          <span className="section-right je-size">
            {outSize.width}×{outSize.height}
          </span>
        )}
      </header>
      <div className="section-body">
        {audio ? (
          <div className="je-frame audio">
            <Music size={28} aria-hidden />
            <span>{t('editor.audioPreview')}</span>
          </div>
        ) : (
          <>
            <div className="je-frame" style={{ aspectRatio: ratio }}>
              {url && <img src={url} alt="" draggable={false} />}
              {failed && (
                <span className="je-frame-msg">
                  <Info size={14} aria-hidden /> {t('preview.failed')}
                </span>
              )}
              {loading && (
                <span className="je-frame-spin">
                  <Spinner size={14} />
                </span>
              )}
            </div>
            {duration > 0 && (
              <div className="je-scrub">
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={1 / fps}
                  value={clamp(time, 0, duration)}
                  onChange={(e) => setTime(Number(e.target.value))}
                  aria-label={t('preview.timeline')}
                  style={{ '--pct': `${(clamp(time, 0, duration) / duration) * 100}%` } as React.CSSProperties}
                />
                <span className="je-tc">{formatTimecode(time, fps)}</span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ───────────────────────────── trim ─────────────────────────────

function TrimCard({ job, trim, disabled, onChange }: { job: Job; trim: Trim | null; disabled: boolean; onChange: (t: Trim | null) => void }) {
  const t = useT()
  const info = job.sourceInfo
  const fps = info?.fps && info.fps > 0 ? info.fps : 30
  const duration = info?.durationSec ?? 0
  const inSec = trim?.inSec ?? null
  const outSec = trim?.outSec ?? null
  const set = (a: number | null, b: number | null): void => {
    if (a == null && b == null) return onChange(null)
    const i = a ?? 0
    let o = b ?? duration
    if (o <= i) o = duration > i ? duration : i + 1
    onChange({ inSec: i, outSec: o })
  }
  const keep = trim ? trim.outSec - trim.inSec : duration
  return (
    <section className="section je-card">
      <header className="section-header">
        <Scissors size={14} aria-hidden />
        <h3>{t('editor.trim')}</h3>
        <span className="section-right">
          <button type="button" className="link-btn" disabled={disabled || !trim} onClick={() => onChange(null)}>
            {t('preview.clearTrim')}
          </button>
        </span>
      </header>
      <div className="section-body je-trim">
        <label className="je-trim-field">
          <span>{t('preview.in')}</span>
          <TimecodeInput value={inSec} onChange={(v) => set(v, outSec)} fps={fps} max={duration || undefined} disabled={disabled} ariaLabel={t('preview.in')} placeholder={formatTimecode(0, fps)} />
        </label>
        <label className="je-trim-field">
          <span>{t('preview.out')}</span>
          <TimecodeInput value={outSec} onChange={(v) => set(inSec, v)} fps={fps} max={duration || undefined} disabled={disabled} ariaLabel={t('preview.out')} placeholder={formatTimecode(duration, fps)} />
        </label>
        <div className="je-trim-field">
          <span>{t('preview.duration')}</span>
          <strong className={cx(trim && 'tc')}>{trim ? formatTimecode(keep, fps) : t('preview.wholeFile')}</strong>
        </div>
        {duration > 0 && (
          <div className="je-trim-bar" aria-hidden>
            <span style={{ left: `${((inSec ?? 0) / duration) * 100}%`, width: `${(keep / duration) * 100}%` }} />
          </div>
        )}
      </div>
    </section>
  )
}

// ───────────────────────────── output target ─────────────────────────────

function outputExt(job: Job, draft: Draft): string {
  if (draft.video) return draft.video.container
  const f = draft.imgOutput?.format ?? 'keep'
  if (f === 'keep') {
    const e = extOf(job.source)
    return ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif'].includes(e) ? e : 'png'
  }
  return f === 'jpeg' ? 'jpg' : f === 'tiff' ? 'tif' : f
}

function OutputTargetBar({
  job,
  draft,
  presetLabel,
  disabled,
  onChange,
}: {
  job: Job
  draft: Draft
  presetLabel: string
  disabled: boolean
  onChange: (o: OutputTarget) => void
}) {
  const t = useT()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const o = draft.output
  const example = useMemo(() => {
    const size = draft.video ? computeVideoOutputSize(job.sourceInfo, draft.video) : null
    const name = renderNameTemplate(o.nameTemplate, {
      name: baseNameOf(job.source),
      ext: extOf(job.source),
      preset: presetLabel,
      parent: fileName(dirName(job.source)),
      width: size?.width ?? job.sourceInfo?.width,
      height: size?.height ?? job.sourceInfo?.height,
      counter: 1,
      now: new Date(),
    })
    return `${name}.${outputExt(job, draft)}`
  }, [o.nameTemplate, job, draft, presetLabel])

  const items: MenuItem[] = [
    {
      key: 'choose',
      label: t('queue.chooseFolder'),
      icon: FolderOpen,
      onSelect: async () => {
        const dir = await guard(() => api.pickFolder(tNow('dialog.outputFolderTitle')))
        if (dir) onChange({ ...o, dir })
      },
    },
    { key: 'same', label: t('common.sameAsSource'), checked: o.dir == null, onSelect: () => onChange({ ...o, dir: null }) },
  ]

  return (
    <div className="je-output">
      <div className="je-output-title">
        <FolderOutput size={14} aria-hidden />
        <span>{t('editor.outputTarget')}</span>
      </div>
      <div className="je-field je-folder">
        <span className="je-label">{t('editor.outputFolder')}</span>
        <button
          type="button"
          className={cx('je-folder-btn', !o.dir && 'same')}
          disabled={disabled}
          title={o.dir ?? t('common.sameAsSource')}
          aria-haspopup="menu"
          aria-expanded={!!menuAnchor}
          onClick={(e) => setMenuAnchor(e.currentTarget)}
        >
          <span>{o.dir ?? t('common.sameAsSource')}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
        {menuAnchor && <Menu anchor={menuAnchor} items={items} onClose={() => setMenuAnchor(null)} />}
        <KeepStructureSwitch job={job} output={o} disabled={disabled} onChange={onChange} />
      </div>
      <div className="je-field je-name">
        <span className="je-label">{t('editor.fileName')}</span>
        <TextInput value={o.nameTemplate} onChange={(nameTemplate) => onChange({ ...o, nameTemplate })} disabled={disabled} title={t('editor.fileNameHint')} aria-label={t('editor.fileName')} placeholder="{name}" />
        <span className="je-example" title={example}>
          {t('editor.example', { file: example })}
        </span>
      </div>
      <div className="je-field je-conflict">
        <span className="je-label">{t('editor.conflict')}</span>
        <Select value={o.conflict} onChange={(v) => onChange({ ...o, conflict: v as ConflictPolicy })} disabled={disabled} aria-label={t('editor.conflict')}>
          {(['rename', 'overwrite', 'skip'] as const).map((c) => (
            <option key={c} value={c}>
              {t(`conflict.${c}` as MessageKey)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  )
}


// ───────────────────────────── keep folder structure ─────────────────────────────

function KeepStructureSwitch({ job, output, disabled, onChange }: { job: Job; output: OutputTarget; disabled: boolean; onChange: (o: OutputTarget) => void }) {
  const t = useT()
  const on = !!output.preserveStructure && !!output.dir
  return (
    <div className="je-structure">
      <Switch
        checked={on}
        onChange={(preserveStructure) => onChange({ ...output, preserveStructure })}
        disabled={disabled || !output.dir}
        label={t('fileops.keepStructure')}
        title={job.relativeDir ? t('fileops.keepStructureRow', { dir: job.relativeDir }) : t('fileops.keepStructureHint')}
      />
      {on && job.relativeDir ? (
        <span className="je-structure-path" title={joinPath(output.dir!, job.relativeDir)}>
          <FolderTree size={11} aria-hidden /> {job.relativeDir}
        </span>
      ) : null}
    </div>
  )
}


// ───────────────────────────── file job (rename / copy / move) ─────────────────────────────

function FileJobForm({
  job,
  draft,
  presetLabel,
  disabled,
  onChange,
}: {
  job: Job
  draft: Draft
  presetLabel: string
  disabled: boolean
  onChange: (patch: Partial<Draft>) => void
}) {
  const t = useT()
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const op = draft.operation ?? 'rename'
  const o = draft.output
  const usesFolder = op !== 'rename'
  const setOutput = (output: OutputTarget): void => onChange({ output })
  const example = exampleFileName(job.source, o.nameTemplate || '{name}', { counter: 1, preset: presetLabel, taken: job.sourceInfo?.takenAt })
  const items: MenuItem[] = [
    {
      key: 'choose',
      label: t('queue.chooseFolder'),
      icon: FolderOpen,
      onSelect: async () => {
        const dir = await guard(() => api.pickFolder(tNow('dialog.outputFolderTitle')))
        if (dir) setOutput({ ...o, dir })
      },
    },
    { key: 'same', label: t('common.sameAsSource'), checked: o.dir == null, onSelect: () => setOutput({ ...o, dir: null }) },
  ]

  return (
    <div className="je-file">
      <section className="je-file-section">
        <h3 className="fo-h">{t('fileops.operation')}</h3>
        <div className="fo-ops fo-ops-row" role="radiogroup" aria-label={t('fileops.operation')}>
          {FILE_OPS.map((x) => {
            const Icon = FILE_OP_ICON[x]
            return (
              <button
                key={x}
                type="button"
                role="radio"
                aria-checked={x === op}
                disabled={disabled}
                className={cx('fo-op', x === op && 'active', `op-${x}`)}
                onClick={() => onChange({ operation: x })}
              >
                <span className="fo-op-icon" aria-hidden>
                  <Icon size={16} />
                </span>
                <span className="fo-op-text">
                  <span className="fo-op-name">{t(FILE_OP_LABEL[x])}</span>
                  <span className="fo-op-desc">{t(FILE_OP_DESC[x])}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>
      <section className="je-file-section">
        <h3 className="fo-h">{t('fileops.destination')}</h3>
        {usesFolder ? (
          <div className="fo-dest">
            <button
              type="button"
              className={cx('je-folder-btn', !o.dir && 'same')}
              disabled={disabled}
              title={o.dir ?? t('common.sameAsSource')}
              aria-haspopup="menu"
              aria-expanded={!!menuAnchor}
              aria-label={`${t('editor.outputFolder')}: ${o.dir ?? t('common.sameAsSource')}`}
              onClick={(e) => setMenuAnchor(e.currentTarget)}
            >
              <FolderOutput size={14} aria-hidden />
              <span>{o.dir ?? t('common.sameAsSource')}</span>
              <ChevronDown size={13} aria-hidden />
            </button>
            {menuAnchor && <Menu anchor={menuAnchor} items={items} onClose={() => setMenuAnchor(null)} />}
            <KeepStructureSwitch job={job} output={o} disabled={disabled} onChange={setOutput} />
          </div>
        ) : (
          <div className="fo-inplace">
            <FolderOpen size={14} aria-hidden />
            <span>{t('fileops.inPlace')}</span>
          </div>
        )}
      </section>
      <section className="je-file-section">
        <h3 className="fo-h">{t('fileops.newName')}</h3>
        <NameTemplateField value={o.nameTemplate} onChange={(nameTemplate) => setOutput({ ...o, nameTemplate })} tokens={FILE_NAME_TOKENS} disabled={disabled} ariaLabel={t('fileops.newName')} />
        <div className="je-file-example" title={example}>
          <span className="fo-label">{t('fileops.exampleOne')}</span>
          <code>{fileName(job.source)}</code>
          <span aria-hidden>→</span>
          <code className="to">{example}</code>
        </div>
        <div className="fo-conflict">
          <span className="fo-label">{t('editor.conflict')}</span>
          <Select value={o.conflict} onChange={(v) => setOutput({ ...o, conflict: v as ConflictPolicy })} disabled={disabled} aria-label={t('editor.conflict')}>
            {(['rename', 'overwrite', 'skip'] as const).map((c) => (
              <option key={c} value={c}>
                {t(`conflict.${c}` as MessageKey)}
              </option>
            ))}
          </Select>
        </div>
        {!dotExt(job.source) && <div className="fo-hint">{t('fileops.noExtension')}</div>}
      </section>
    </div>
  )
}

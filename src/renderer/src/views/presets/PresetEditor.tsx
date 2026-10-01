// Presets screen — right column: name / category header, save bar, and the video or image editor.
import { CircleAlert, Film, Image as ImageIcon, Info, Lock, Music, Save, SlidersHorizontal, Sparkles, TriangleAlert, Undo2, UserRound } from 'lucide-react'
import type { FilePreset, ImagePreset, Preset, PresetCategory, VideoPreset } from '../../../../shared/types'
import { validateVideoSettings } from '../../../../shared/videoRules'
import { useLocale, useT } from '../../store'
import type { MessageKey } from '../../i18n'
import { isAudioPreset, presetDescription, presetName } from '../../lib/presets'
import { presetSummary } from '../../lib/labels'
import { FILE_OPS, FILE_OP_DESC, FILE_OP_ICON, FILE_OP_LABEL } from '../../lib/fileops'
import { VideoSettingsForm } from '../../editors/VideoSettingsForm'
import { ActionsPanel } from '../../editors/ImageActions'
import { ImageOutputForm, ImagePreviewPane } from '../../editors/ImageChainEditor'
import { Button, Select, TextInput, cx } from '../../components/ui'
import {
  FILE_CATEGORIES,
  IMAGE_CATEGORIES,
  VIDEO_CATEGORIES,
  draftIssues,
  hasBlockingIssues,
  isDirty,
  newPreset,
  revertDraft,
  saveDraft,
  updateDraft,
  usePresetDraft,
} from './draft'

export function PresetEditor() {
  const t = useT()
  const locale = useLocale()
  const draft = usePresetDraft((s) => s.draft)
  const selectedId = usePresetDraft((s) => s.selectedId)
  const saving = usePresetDraft((s) => s.saving)
  const kind = usePresetDraft((s) => s.kind)
  const dirty = usePresetDraft(isDirty)

  if (!draft) {
    return (
      <section className="pv-editor pv-editor-empty">
        <SlidersHorizontal size={30} aria-hidden />
        <p>{t('presetsView.noSelection')}</p>
        <Button icon={Sparkles} onClick={() => void newPreset()}>
          {kind === 'video' ? t('presetsView.newVideo') : kind === 'image' ? t('presetsView.newImage') : t('presetsView.newFile')}
        </Button>
      </section>
    )
  }

  const isNew = selectedId === null
  const builtIn = draft.builtIn
  const issues = draftIssues(draft, locale)
  const blocked = hasBlockingIssues(draft)
  const videoErrors = draft.kind === 'video' ? validateVideoSettings(draft.settings).filter((i) => i.level === 'error').length : 0
  const name = presetName(draft, locale)
  const desc = presetDescription(draft, locale)
  const Icon = draft.kind === 'file' ? FILE_OP_ICON[draft.operation] : draft.kind === 'image' ? ImageIcon : isAudioPreset(draft) ? Music : Film
  const categories = draft.kind === 'video' ? VIDEO_CATEGORIES : draft.kind === 'image' ? IMAGE_CATEGORIES : FILE_CATEGORIES
  const canSave = !blocked && !saving && (dirty || builtIn)
  const saveTitle = blocked
    ? videoErrors
      ? t('presetsView.saveBlockedVideo')
      : t('presetsView.saveBlocked')
    : builtIn
      ? t('presetsView.saveAsNewHint')
      : `${t('presetsView.save')} (Ctrl+S)`

  const setName = (v: string): void => updateDraft({ ...draft, name: v, names: undefined })
  const setCategory = (c: string): void => updateDraft({ ...draft, category: c as PresetCategory })

  return (
    <section className={cx('pv-editor', `pv-editor-${draft.kind}`)} aria-label={t('presetsView.editorLabel')}>
      <header className="pv-editor-head">
        <div className="pv-title-row">
          <span className={cx('pv-kind-icon', draft.kind)} aria-hidden>
            <Icon size={16} />
          </span>
          <TextInput
            className="pv-name-input"
            value={name}
            onChange={setName}
            placeholder={t('presetsView.untitled')}
            aria-label={t('presetsView.name')}
            title={t('presetsView.name')}
            maxLength={200}
          />
          <Select value={categories.includes(draft.category) ? draft.category : 'custom'} onChange={setCategory} aria-label={t('presetsView.category')} title={t('presetsView.category')} className="pv-category">
            {categories.map((c) => (
              <option key={c} value={c}>
                {t(`category.${c}` as MessageKey)}
              </option>
            ))}
          </Select>
          <span className="pv-head-spacer" />
          <Button variant="ghost" className="pv-revert" icon={Undo2} disabled={!dirty || saving} onClick={revertDraft} title={isNew ? t('presetsView.discardNewHint') : t('presetsView.revertHint')}>
            {isNew ? t('presetsView.discard') : t('presetsView.revert')}
          </Button>
          <Button variant="primary" icon={Save} busy={saving} disabled={!canSave} onClick={() => void saveDraft()} title={saveTitle}>
            {builtIn ? t('presetsView.saveAsNew') : t('presetsView.save')}
          </Button>
        </div>
        <div className="pv-meta-row">
          {builtIn ? (
            <span className="pv-badge builtin">
              <Lock size={11} aria-hidden />
              {t('presetsView.builtInBadge')}
            </span>
          ) : isNew ? (
            <span className="pv-badge new">
              <Sparkles size={11} aria-hidden />
              {t('presetsView.newBadge')}
            </span>
          ) : (
            <span className="pv-badge user">
              <UserRound size={11} aria-hidden />
              {t('presetsView.userBadge')}
            </span>
          )}
          <span className="pv-summary">{presetSummary(draft, t)}</span>
          {desc && <span className="pv-desc" title={desc}>{desc}</span>}
          {dirty && (
            <span className="pv-unsaved" role="status">
              <span className="pv-dot" aria-hidden />
              {isNew ? t('presetsView.notSavedYet') : t('presetsView.unsaved')}
            </span>
          )}
        </div>
        {builtIn && (
          <div className="pv-note">
            <Info size={14} aria-hidden />
            <span>{t('presetsView.builtInNote')}</span>
          </div>
        )}
        {issues.length > 0 && (
          <div className="issues pv-issues" role="status">
            {issues.map((i) => (
              <div key={i.key} className={cx('issue', `issue-${i.level}`)}>
                {i.level === 'error' ? <CircleAlert size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
                <span>{t(i.key, i.params)}</span>
              </div>
            ))}
          </div>
        )}
      </header>

      {draft.kind === 'video' ? (
        <VideoBody draft={draft} editorKey={selectedId ?? 'new'} />
      ) : draft.kind === 'image' ? (
        <ImageBody draft={draft} editorKey={selectedId ?? 'new'} />
      ) : (
        <FileBody draft={draft} />
      )}
    </section>
  )
}

function VideoBody({ draft, editorKey }: { draft: VideoPreset; editorKey: string }) {
  return (
    <div className="pv-editor-body pv-video-body">
      <VideoSettingsForm key={editorKey} value={draft.settings} onChange={(settings) => updateDraft({ ...draft, settings } satisfies Preset)} />
    </div>
  )
}

function ImageBody({ draft, editorKey }: { draft: ImagePreset; editorKey: string }) {
  // Composed from the chain editor's parts so the preview sample survives switching presets.
  return (
    <div className="pv-editor-body pv-image-body">
      <div className="chain-editor pv-chain">
        <div className="chain-left">
          <ActionsPanel key={editorKey} actions={draft.actions} onChange={(actions) => updateDraft({ ...draft, actions })} />
          <ImageOutputForm output={draft.output} onChange={(output) => updateDraft({ ...draft, output })} />
        </div>
        <ImagePreviewPane actions={draft.actions} output={draft.output} />
      </div>
    </div>
  )
}

function FileBody({ draft }: { draft: FilePreset }) {
  const t = useT()
  const locale = useLocale()
  const desc = presetDescription(draft, locale)
  return (
    <div className="pv-editor-body pv-file-body">
      <section className="pv-file-section">
        <h3 className="fo-h">{t('fileops.operation')}</h3>
        <div className="fo-ops" role="radiogroup" aria-label={t('fileops.operation')}>
          {FILE_OPS.map((op) => {
            const OpIcon = FILE_OP_ICON[op]
            return (
              <button
                key={op}
                type="button"
                role="radio"
                aria-checked={draft.operation === op}
                className={cx('fo-op', draft.operation === op && 'active', `op-${op}`)}
                onClick={() => updateDraft({ ...draft, operation: op })}
              >
                <span className="fo-op-icon" aria-hidden>
                  <OpIcon size={16} />
                </span>
                <span className="fo-op-text">
                  <span className="fo-op-name">{t(FILE_OP_LABEL[op])}</span>
                  <span className="fo-op-desc">{t(FILE_OP_DESC[op])}</span>
                </span>
              </button>
            )
          })}
        </div>
      </section>
      <section className="pv-file-section">
        <h3 className="fo-h">{t('common.description')}</h3>
        <TextInput
          value={desc}
          onChange={(v) => updateDraft({ ...draft, description: v, descriptions: undefined })}
          placeholder={t('presetsView.fileDescPlaceholder')}
          aria-label={t('common.description')}
          maxLength={300}
          className="pv-file-desc"
        />
      </section>
      <div className="pv-note pv-file-note">
        <Info size={14} aria-hidden />
        <span>{t('presetsView.fileNote')}</span>
      </div>
    </div>
  )
}

// One watch-folder card: enable switch, folder, preset chips, output folder, after-processing and options.
import { useRef, useState } from 'react'
import { CircleAlert, ExternalLink, Film, Folder, FolderOutput, FolderSync, Image as ImageIcon, Music, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import type { Preset, WatchFolder } from '../../../../shared/types'
import { api } from '../../api'
import { guard, useLocale, useStore, useT } from '../../store'
import { fileName, joinPath } from '../../lib/format'
import { isAudioPreset, presetName } from '../../lib/presets'
import { presetSummary } from '../../lib/labels'
import { Button, Checkbox, IconButton, Segmented, Switch, cx } from '../../components/ui'
import { PresetPicker } from './PresetPicker'
import { changeWatchOutput, changeWatchPath, deleteWatchFolder, saveWatchFolder } from './actions'

export function WatchCard({ w }: { w: WatchFolder }) {
  const t = useT()
  const presets = useStore((s) => s.presets)
  const [pickerOpen, setPickerOpen] = useState(false)
  const addBtn = useRef<HTMLButtonElement>(null)

  const save = (patch: Partial<WatchFolder>): void => void saveWatchFolder({ ...w, ...patch })
  const chosen = w.presetIds.map((id) => ({ id, preset: presets.find((p) => p.id === id) ?? null }))
  const valid = chosen.filter((c) => c.preset)
  const hasVideo = valid.some((c) => c.preset!.kind === 'video')
  const hasImage = valid.some((c) => c.preset!.kind === 'image')
  const outDir = w.outputDir ?? joinPath(w.path, 'Output')
  const name = fileName(w.path) || w.path

  const toggle = (id: string, on: boolean): void => {
    const ids = on ? [...w.presetIds.filter((x) => x !== id), id] : w.presetIds.filter((x) => x !== id)
    save({ presetIds: ids })
  }

  return (
    <article className={cx('wf-card', !w.enabled && 'is-off')} aria-label={name}>
      <header className="wf-card-head">
        <span className="wf-folder-icon" aria-hidden>
          <Folder size={18} />
        </span>
        <div className="wf-path" title={w.path}>
          <span className="wf-path-name">{name}</span>
          <span className="wf-path-full">{w.path}</span>
        </div>
        <div className="wf-head-actions">
          <span className={cx('wf-state', w.enabled ? 'on' : 'off')}>
            <Switch checked={w.enabled} onChange={(enabled) => save({ enabled })} label={w.enabled ? t('watch.stateOn') : t('watch.stateOff')} title={t('watch.enableHint')} />
          </span>
          <Button size="sm" variant="ghost" icon={FolderSync} onClick={() => void changeWatchPath(w)} title={t('watch.changeFolderHint')}>
            {t('watch.changeFolder')}
          </Button>
          <IconButton icon={ExternalLink} label={t('watch.openFolder')} onClick={() => void guard(() => api.openPath(w.path))} />
          <IconButton icon={Trash2} label={t('watch.delete')} tone="danger" onClick={() => void deleteWatchFolder(w)} />
        </div>
      </header>

      <div className="wf-card-body">
        <div className="wf-field">
          <div className="wf-label">{t('watch.presets')}</div>
          <div className="wf-control">
            <div className="wf-chips">
              {chosen.map(({ id, preset }) => (
                <PresetChip key={id} preset={preset} onRemove={() => toggle(id, false)} />
              ))}
              <button
                ref={addBtn}
                type="button"
                className={cx('wf-chip-add', pickerOpen && 'pressed')}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen((o) => !o)}
              >
                <Plus size={13} aria-hidden />
                {chosen.length ? t('watch.editPresets') : t('watch.addPresets')}
              </button>
            </div>
            {!valid.length ? (
              <div className="wf-warn">
                <CircleAlert size={13} aria-hidden />
                {t('watch.noPresets')}
              </div>
            ) : (
              <div className="wf-hint">{hasVideo && hasImage ? t('watch.presetsHintBoth') : hasVideo ? t('watch.presetsHintVideo') : t('watch.presetsHintImage')}</div>
            )}
          </div>
        </div>

        <div className="wf-field">
          <div className="wf-label">{t('watch.output')}</div>
          <div className="wf-control">
            <div className="wf-path-row">
              <FolderOutput size={14} className="wf-path-row-icon" aria-hidden />
              <span className="wf-path-value" title={outDir}>
                {outDir}
              </span>
              {w.outputDir == null && <span className="wf-tag">{t('watch.defaultTag')}</span>}
              <Button size="sm" onClick={() => void changeWatchOutput(w)}>
                {t('watch.change')}
              </Button>
              {w.outputDir != null && (
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => save({ outputDir: null })} title={t('watch.resetOutputHint')}>
                  {t('watch.resetOutput')}
                </Button>
              )}
            </div>
            <div className="wf-hint">{t('watch.outputHint')}</div>
          </div>
        </div>

        <div className="wf-field">
          <div className="wf-label">{t('watch.after')}</div>
          <div className="wf-control">
            <Segmented<WatchFolder['afterProcess']>
              size="sm"
              value={w.afterProcess}
              onChange={(afterProcess) => save({ afterProcess })}
              ariaLabel={t('watch.after')}
              options={[
                { value: 'keep', label: t('watch.afterKeep') },
                { value: 'move', label: t('watch.afterMove') },
              ]}
            />
            <div className="wf-hint">{w.afterProcess === 'move' ? t('watch.afterMoveHint', { path: joinPath(w.path, 'Source') }) : t('watch.afterKeepHint')}</div>
          </div>
        </div>

        <div className="wf-field">
          <div className="wf-label">{t('watch.options')}</div>
          <div className="wf-control wf-options">
            <Checkbox checked={w.includeSubfolders} onChange={(includeSubfolders) => save({ includeSubfolders })} label={t('watch.subfolders')} title={t('watch.subfoldersHint')} />
            <Checkbox checked={w.processExisting} onChange={(processExisting) => save({ processExisting })} label={t('watch.existing')} title={t('watch.existingHint')} />
          </div>
        </div>
      </div>

      {pickerOpen && <PresetPicker anchor={addBtn.current} selected={w.presetIds} onToggle={toggle} onClose={() => setPickerOpen(false)} />}
    </article>
  )
}

function PresetChip({ preset, onRemove }: { preset: Preset | null; onRemove: () => void }) {
  const t = useT()
  const locale = useLocale()
  if (!preset) {
    return (
      <span className="wf-chip missing" title={t('watch.missingPresetHint')}>
        <CircleAlert size={12} aria-hidden />
        <span className="wf-chip-name">{t('watch.missingPreset')}</span>
        <button type="button" className="wf-chip-x" onClick={onRemove} aria-label={t('watch.removePreset')} title={t('watch.removePreset')}>
          <X size={11} aria-hidden />
        </button>
      </span>
    )
  }
  const Icon = preset.kind === 'image' ? ImageIcon : isAudioPreset(preset) ? Music : Film
  const name = presetName(preset, locale)
  return (
    <span className={cx('wf-chip', preset.kind)} title={`${name}\n${presetSummary(preset, t)}`}>
      <Icon size={12} aria-hidden />
      <span className="wf-chip-name">{name}</span>
      <button type="button" className="wf-chip-x" onClick={onRemove} aria-label={`${t('watch.removePreset')}: ${name}`} title={t('watch.removePreset')}>
        <X size={11} aria-hidden />
      </button>
    </span>
  )
}

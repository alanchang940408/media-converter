// Presets screen: toolbar (new / duplicate / delete / import / export), preset list, preset editor.
import { useEffect } from 'react'
import { CopyPlus, FileInput, FileOutput, ListChecks, Plus, Trash2 } from 'lucide-react'
import { useLocale, useStore, useT } from '../store'
import { presetName } from '../lib/presets'
import { Button, MenuButton, isModalOpen, type MenuItem } from '../components/ui'
import { PresetList } from './presets/PresetList'
import { PresetEditor } from './presets/PresetEditor'
import { deleteSelected, duplicatePreset, ensureSelection, exportPresetFile, importPresetFile, newPreset, saveDraft, usePresetDraft } from './presets/draft'

export function PresetsView() {
  const t = useT()
  const locale = useLocale()
  const presets = useStore((s) => s.presets)
  const view = useStore((s) => s.view)
  const kind = usePresetDraft((s) => s.kind)
  const selectedId = usePresetDraft((s) => s.selectedId)
  const selected = presets.find((p) => p.id === selectedId) ?? null
  const userPresets = presets.filter((p) => !p.builtIn)

  // Initial selection, and fall back when the selected preset disappears.
  useEffect(() => {
    ensureSelection()
  }, [presets, kind])

  // Ctrl/Cmd+S saves the draft.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (view !== 'presets' || isModalOpen()) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        ;(document.activeElement as HTMLElement | null)?.blur?.() // commit number inputs that save on blur
        setTimeout(() => void saveDraft(), 0)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const exportItems: MenuItem[] = [
    {
      key: 'selected',
      label: selected ? t('presetsView.exportSelected', { name: presetName(selected, locale) }) : t('presetsView.exportSelectedNone'),
      icon: FileOutput,
      disabled: !selected,
      onSelect: () => selected && void exportPresetFile([selected.id]),
    },
    {
      key: 'mine',
      label: t('presetsView.exportAllMine', { n: userPresets.length }),
      icon: ListChecks,
      disabled: !userPresets.length,
      onSelect: () => void exportPresetFile(userPresets.map((p) => p.id)),
    },
  ]

  return (
    <div className="presets-view">
      <div className="toolbar pv-toolbar" role="toolbar" aria-label={t('presetsView.toolbar')}>
        <Button icon={Plus} onClick={() => void newPreset()} title={kind === 'video' ? t('presetsView.newVideo') : kind === 'image' ? t('presetsView.newImage') : t('presetsView.newFile')}>
          {t('presetsView.new')}
        </Button>
        <Button variant="ghost" icon={CopyPlus} disabled={!selected} onClick={() => void duplicatePreset()} title={t('presetsView.duplicateHint')}>
          {t('presetsView.duplicate')}
        </Button>
        <Button
          variant="ghost"
          icon={Trash2}
          disabled={!selected || selected.builtIn}
          onClick={() => void deleteSelected()}
          title={selected?.builtIn ? t('presetsView.deleteBuiltInHint') : t('presetsView.delete')}
        >
          {t('presetsView.delete')}
        </Button>
        <span className="tb-sep" />
        <Button variant="ghost" icon={FileInput} onClick={() => void importPresetFile()} title={t('presetsView.importHint')}>
          {t('presetsView.import')}
        </Button>
        <MenuButton variant="ghost" icon={FileOutput} label={t('presetsView.export')} items={exportItems} title={t('presetsView.exportHint')} />
        <span className="tb-spacer" />
        <span className="tb-count">{t('presetsView.counts', { n: presets.length, mine: userPresets.length })}</span>
      </div>
      <div className="pv-body">
        <PresetList />
        <PresetEditor />
      </div>
    </div>
  )
}

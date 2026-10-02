// Queue sidebar: searchable preset list. Click applies to the selected jobs right away (or, with nothing selected,
// makes the preset the default for newly added files); a preset can also be dragged onto a row.
import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FilePen, Film, Image as ImageIcon, Lock, Music, PanelRightClose, Search, Settings2, X } from 'lucide-react'
import type { Preset } from '../../../shared/types'
import { applyPreset, saveSettings, setView, toast, togglePresetBrowser, tNow, useLocale, useStore, useT } from '../store'
import type { MessageKey } from '../i18n'
import { groupByCategory, isAudioPreset, isEditableJob, isPresetCompatible, presetDescription, presetName } from '../lib/presets'
import { presetSummary } from '../lib/labels'
import { DND_PRESET, dragState } from '../lib/dnd'
import { FILE_OP_ICON } from '../lib/fileops'
import { IconButton, Segmented, cx } from './ui'

export function PresetBrowser() {
  const t = useT()
  const locale = useLocale()
  const presets = useStore((s) => s.presets)
  const jobs = useStore((s) => s.jobs)
  const selected = useStore((s) => s.selected)
  const [tab, setTab] = useState<'video' | 'image' | 'file'>('video')
  const [q, setQ] = useState('')
  const settings = useStore((s) => s.settings)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const selectedJobs = useMemo(() => jobs.filter((j) => selected.includes(j.id)), [jobs, selected])

  // Follow the selection: all selected jobs are images → image tab, etc.
  useEffect(() => {
    if (!selectedJobs.length) return
    if (selectedJobs.every((j) => j.kind === 'image')) setTab('image')
    else if (selectedJobs.every((j) => j.kind === 'video')) setTab('video')
    else if (selectedJobs.every((j) => j.kind === 'file')) setTab('file')
  }, [selectedJobs])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return presets.filter((p) => {
      if (p.kind !== tab) return false
      if (!needle) return true
      return (
        presetName(p, locale).toLowerCase().includes(needle) ||
        p.name.toLowerCase().includes(needle) ||
        presetDescription(p, locale).toLowerCase().includes(needle) ||
        presetSummary(p, t).toLowerCase().includes(needle)
      )
    })
  }, [presets, tab, q, locale, t])

  const groups = groupByCategory(filtered)
  const defaultId = tab === 'video' ? settings.lastVideoPresetId : tab === 'image' ? settings.lastImagePresetId : settings.lastFilePresetId

  // Click = act: apply to every selected kind-compatible job, or (nothing selected) set the default for new files.
  const choose = async (p: Preset): Promise<void> => {
    const name = presetName(p, locale)
    if (!selectedJobs.length) {
      const patch = p.kind === 'video' ? { lastVideoPresetId: p.id } : p.kind === 'image' ? { lastImagePresetId: p.id } : { lastFilePresetId: p.id }
      await saveSettings(patch)
      toast('success', tNow('browser.defaultSet', { name }))
      return
    }
    const ids = selectedJobs.filter((j) => isEditableJob(j) && isPresetCompatible(j, p)).map((j) => j.id)
    if (!ids.length) {
      toast('info', tNow('browser.noneFit', { n: selectedJobs.length }))
      return
    }
    const skipped = selectedJobs.length - ids.length
    if (await applyPreset(ids, p.id)) toast('success', tNow('browser.applied', { name, n: ids.length }), skipped ? tNow('browser.skipped', { n: skipped }) : undefined)
  }

  const toggleGroup = (key: string): void =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  return (
    <aside className="preset-browser" aria-label={t('browser.title')}>
      <div className="pb-head">
        <h2>{t('browser.title')}</h2>
        <IconButton icon={Settings2} label={t('browser.manage')} onClick={() => setView('presets')} />
        <IconButton icon={PanelRightClose} label={t('queue.hideBrowser')} onClick={() => togglePresetBrowser(false)} />
      </div>
      <div className="pb-controls">
        <Segmented
          stretch
          size="sm"
          value={tab}
          onChange={setTab}
          ariaLabel={t('browser.kind')}
          options={[
            { value: 'video', label: t('browser.video'), icon: Film },
            { value: 'image', label: t('browser.image'), icon: ImageIcon },
            { value: 'file', label: t('browser.file'), icon: FilePen, title: t('presetsView.kindFileHint') },
          ]}
        />
        <div className="search-field">
          <Search size={14} aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('browser.search')} aria-label={t('browser.search')} />
          {q && (
            <button type="button" className="search-clear" onClick={() => setQ('')} aria-label={t('common.clear')} title={t('common.clear')}>
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="pb-list" role="listbox" aria-label={t('browser.title')}>
        {groups.length === 0 && <div className="pb-empty">{t('browser.empty')}</div>}
        {groups.map(([cat, list]) => {
          const key = `${tab}-${cat}`
          const isCollapsed = collapsed.has(key) && !q
          return (
            <div key={key} className="pb-group">
              <button type="button" className="pb-group-head" onClick={() => toggleGroup(key)} aria-expanded={!isCollapsed}>
                {isCollapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
                <span>{t(`category.${cat}` as MessageKey)}</span>
                <span className="count">{list.length}</span>
              </button>
              {!isCollapsed &&
                list.map((p) => {
                  const Icon = p.kind === 'file' ? FILE_OP_ICON[p.operation] : p.kind === 'image' ? ImageIcon : isAudioPreset(p) ? Music : Film
                  const desc = presetDescription(p, locale)
                  const isDefault = p.id === defaultId
                  return (
                    <div
                      key={p.id}
                      role="option"
                      aria-selected={isDefault}
                      tabIndex={0}
                      className={cx('pb-item', isDefault && 'selected')}
                      draggable
                      title={desc ? `${presetName(p, locale)}\n${desc}` : presetName(p, locale)}
                      onClick={() => void choose(p)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          void choose(p)
                        }
                      }}
                      onDragStart={(e) => {
                        dragState.presetId = p.id
                        e.dataTransfer.effectAllowed = 'copy'
                        e.dataTransfer.setData(DND_PRESET, p.id)
                      }}
                      onDragEnd={() => (dragState.presetId = null)}
                    >
                      <Icon size={14} className="pb-icon" aria-hidden />
                      <div className="pb-text">
                        <div className="pb-name">
                          <span>{presetName(p, locale)}</span>
                          {p.builtIn && <Lock size={11} className="lock" aria-label={t('presets.builtIn')} />}
                          {isDefault && (
                            <em className="pb-default" title={t('browser.defaultHint')}>
                              {t('browser.defaultBadge')}
                            </em>
                          )}
                        </div>
                        <div className="pb-sub">{presetSummary(p, t)}</div>
                      </div>
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      <div className="pb-foot">
        <div className="pb-foot-hint" aria-live="polite">
          {selectedJobs.length ? t('browser.hintClickApply', { n: selectedJobs.length }) : t('browser.hintClickDefault')}
        </div>
      </div>
    </aside>
  )
}

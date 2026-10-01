// Presets screen — left column: kind switch, search, built-in / mine filter, grouped list.
import { useMemo, useRef, type KeyboardEvent } from 'react'
import { Film, FilePen, Image as ImageIcon, Lock, Music, Search, Sparkles, X } from 'lucide-react'
import type { Preset } from '../../../../shared/types'
import { useLocale, useStore, useT } from '../../store'
import type { MessageKey } from '../../i18n'
import { groupByCategory, isAudioPreset, presetDescription, presetName } from '../../lib/presets'
import { presetSummary } from '../../lib/labels'
import { FILE_OP_ICON } from '../../lib/fileops'
import { Segmented, cx } from '../../components/ui'
import { isDirty, selectPreset, switchKind, usePresetDraft, type PresetFilter, type PresetKind } from './draft'

export function PresetList() {
  const t = useT()
  const locale = useLocale()
  const presets = useStore((s) => s.presets)
  const kind = usePresetDraft((s) => s.kind)
  const selectedId = usePresetDraft((s) => s.selectedId)
  const draft = usePresetDraft((s) => s.draft)
  const query = usePresetDraft((s) => s.query)
  const filter = usePresetDraft((s) => s.filter)
  const dirty = usePresetDraft(isDirty)
  const listRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(
    () => ({
      video: presets.filter((p) => p.kind === 'video').length,
      image: presets.filter((p) => p.kind === 'image').length,
      file: presets.filter((p) => p.kind === 'file').length,
    }),
    [presets],
  )

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return presets.filter((p) => {
      if (p.kind !== kind) return false
      if (filter === 'builtIn' && !p.builtIn) return false
      if (filter === 'mine' && p.builtIn) return false
      if (!needle) return true
      return (
        presetName(p, locale).toLowerCase().includes(needle) ||
        p.name.toLowerCase().includes(needle) ||
        presetDescription(p, locale).toLowerCase().includes(needle) ||
        presetSummary(p, t).toLowerCase().includes(needle)
      )
    })
  }, [presets, kind, filter, query, locale, t])

  const groups = groupByCategory(filtered)
  const flatIds = groups.flatMap(([, list]) => list.map((p) => p.id))
  const isNewDraft = !!draft && selectedId === null
  // roving tabindex: the selected row, or the first row when the selection is filtered out
  const focusId = isNewDraft ? null : selectedId && flatIds.includes(selectedId) ? selectedId : (flatIds[0] ?? null)

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    if (!flatIds.length) return
    const cur = selectedId ? flatIds.indexOf(selectedId) : -1
    let next = cur
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = flatIds.length - 1
    else next = Math.max(0, Math.min(flatIds.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
    const id = flatIds[next]
    if (!id || id === selectedId) return
    void selectPreset(id).then(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus()
    })
  }

  const empty =
    filter === 'mine' && !query.trim() ? t('presetsView.emptyMine') : query.trim() ? t('presetsView.emptySearch') : t('presetsView.emptyList')

  return (
    <aside className="pv-side" aria-label={t('presetsView.listLabel')}>
      <div className="pv-side-controls">
        <Segmented<PresetKind>
          stretch
          size="sm"
          value={kind}
          onChange={(k) => void switchKind(k)}
          ariaLabel={t('presetsView.kind')}
          options={[
            { value: 'video', label: <KindLabel text={t('presetsView.kindVideo')} n={counts.video} />, icon: Film, title: `${t('presetsView.kindVideo')} (${counts.video})` },
            { value: 'image', label: <KindLabel text={t('presetsView.kindImage')} n={counts.image} />, icon: ImageIcon, title: `${t('presetsView.kindImage')} (${counts.image})` },
            { value: 'file', label: <KindLabel text={t('presetsView.kindFile')} n={counts.file} />, icon: FilePen, title: `${t('presetsView.kindFileHint')} (${counts.file})` },
          ]}
        />
        <div className="search-field pv-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => usePresetDraft.setState({ query: e.target.value })}
            placeholder={t('presetsView.search')}
            aria-label={t('presetsView.search')}
            onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), usePresetDraft.setState({ query: '' }))}
          />
          {query && (
            <button type="button" className="search-clear" onClick={() => usePresetDraft.setState({ query: '' })} aria-label={t('presetsView.clearSearch')} title={t('presetsView.clearSearch')}>
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
        <Segmented<PresetFilter>
          stretch
          size="sm"
          value={filter}
          onChange={(f) => usePresetDraft.setState({ filter: f })}
          ariaLabel={t('presetsView.filter')}
          options={[
            { value: 'all', label: t('presetsView.filterAll') },
            { value: 'builtIn', label: t('presetsView.filterBuiltIn') },
            { value: 'mine', label: t('presetsView.filterMine') },
          ]}
        />
      </div>

      <div ref={listRef} className="pv-list" role="listbox" aria-label={t('presetsView.listLabel')} onKeyDown={onListKey}>
        {isNewDraft && draft && (
          <div className="pv-group">
            <div className="pv-group-head">
              <span>{t('presetsView.unsavedGroup')}</span>
            </div>
            <div role="option" aria-selected className="pv-item selected is-new" tabIndex={0}>
              <Sparkles size={14} className="pv-item-icon" aria-hidden />
              <div className="pv-item-text">
                <div className="pv-item-name">
                  <span>{presetName(draft, locale) || t('presetsView.untitled')}</span>
                  <span className="pv-dot" title={t('presetsView.unsaved')} aria-label={t('presetsView.unsaved')} />
                </div>
                <div className="pv-item-sub">{presetSummary(draft, t)}</div>
              </div>
            </div>
          </div>
        )}
        {groups.length === 0 && <div className="pv-empty">{empty}</div>}
        {groups.map(([cat, list]) => (
          <div key={cat} className="pv-group" role="group" aria-label={t(`category.${cat}` as MessageKey)}>
            <div className="pv-group-head">
              <span>{t(`category.${cat}` as MessageKey)}</span>
              <span className="pv-count">{list.length}</span>
            </div>
            {list.map((p) => (
              <PresetItem key={p.id} p={p} selected={p.id === selectedId} focusable={p.id === focusId} dirty={p.id === selectedId && dirty} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

function KindLabel({ text, n }: { text: string; n: number }) {
  return (
    <span className="pv-kind-label">
      {text}
      <span className="pv-kind-count">{n}</span>
    </span>
  )
}

function PresetItem({ p, selected, focusable, dirty }: { p: Preset; selected: boolean; focusable: boolean; dirty: boolean }) {
  const t = useT()
  const locale = useLocale()
  const Icon = p.kind === 'file' ? FILE_OP_ICON[p.operation] : p.kind === 'image' ? ImageIcon : isAudioPreset(p) ? Music : Film
  const name = presetName(p, locale)
  const desc = presetDescription(p, locale)
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      data-id={p.id}
      className={cx('pv-item', selected && 'selected', p.builtIn && 'is-builtin')}
      title={desc ? `${name}\n${desc}` : name}
      onClick={() => void selectPreset(p.id)}
    >
      <Icon size={14} className="pv-item-icon" aria-hidden />
      <div className="pv-item-text">
        <div className="pv-item-name">
          <span>{name}</span>
          {dirty && <span className="pv-dot" title={t('presetsView.unsaved')} aria-label={t('presetsView.unsaved')} />}
        </div>
        <div className="pv-item-sub">{presetSummary(p, t)}</div>
      </div>
      {p.builtIn && (
        <span className="pv-lock" title={t('presetsView.builtInBadge')}>
          <Lock size={11} aria-label={t('presetsView.builtInBadge')} />
        </span>
      )}
    </div>
  )
}

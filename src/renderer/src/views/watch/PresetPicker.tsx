// Multi-select popover listing video + image presets with checkboxes (stays open while toggling).
// File-operation presets (rename / copy / move) are never offered: watch folders only convert.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Film, Image as ImageIcon, Search, X } from 'lucide-react'
import type { Preset } from '../../../../shared/types'
import { useLocale, useStore, useT } from '../../store'
import { presetDescription, presetName } from '../../lib/presets'
import { presetSummary } from '../../lib/labels'
import { clamp } from '../../lib/format'
import { Checkbox } from '../../components/ui'

export function PresetPicker({
  anchor,
  selected,
  onToggle,
  onClose,
}: {
  anchor: HTMLElement | null
  selected: string[]
  onToggle: (id: string, on: boolean) => void
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const presets = useStore((s) => s.presets)
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const r = anchor.getBoundingClientRect()
    const h = el.offsetHeight
    const w = el.offsetWidth
    const below = window.innerHeight - r.bottom
    const top = below < h + 8 && r.top > h + 8 ? r.top - h - 4 : Math.min(r.bottom + 4, window.innerHeight - h - 8)
    setPos({ top: Math.max(8, top), left: clamp(r.left, 8, window.innerWidth - w - 8), visibility: 'visible' })
    el.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const tgt = e.target as Node
      if (ref.current?.contains(tgt) || anchor?.contains(tgt)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        anchor?.focus()
      }
    }
    const onScroll = (e: Event): void => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (p: Preset): boolean =>
      !needle || presetName(p, locale).toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle) || presetSummary(p, t).toLowerCase().includes(needle)
    return [
      { key: 'video', label: t('watch.pickerVideo'), icon: Film, list: presets.filter((p) => p.kind === 'video' && match(p)) },
      { key: 'image', label: t('watch.pickerImage'), icon: ImageIcon, list: presets.filter((p) => p.kind === 'image' && match(p)) },
    ]
  }, [presets, q, locale, t])

  return createPortal(
    <div ref={ref} className="wf-picker" role="dialog" aria-label={t('watch.pickerTitle')} style={pos}>
      <div className="wf-picker-head">
        <div className="search-field">
          <Search size={14} aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('watch.pickerSearch')} aria-label={t('watch.pickerSearch')} />
          {q && (
            <button type="button" className="search-clear" onClick={() => setQ('')} aria-label={t('presetsView.clearSearch')} title={t('presetsView.clearSearch')}>
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="wf-picker-list">
        {groups.every((g) => !g.list.length) && <div className="wf-picker-empty">{t('presetsView.emptySearch')}</div>}
        {groups.map(
          (g) =>
            g.list.length > 0 && (
              <div key={g.key} className="wf-picker-group">
                <div className="wf-picker-group-head">
                  <g.icon size={12} aria-hidden />
                  {g.label}
                  <span className="wf-picker-count">{g.list.filter((p) => selected.includes(p.id)).length || ''}</span>
                </div>
                {g.list.map((p) => {
                  const desc = presetDescription(p, locale)
                  return (
                    <div key={p.id} className="wf-picker-item" title={desc || undefined}>
                      <Checkbox
                        checked={selected.includes(p.id)}
                        onChange={(on) => onToggle(p.id, on)}
                        label={
                          <span className="wf-picker-text">
                            <span className="wf-picker-name">{presetName(p, locale)}</span>
                            <span className="wf-picker-sub">{presetSummary(p, t)}</span>
                          </span>
                        }
                      />
                    </div>
                  )
                })}
              </div>
            ),
        )}
      </div>
      <div className="wf-picker-foot">
        <span>{t('watch.pickerSelected', { n: selected.filter((id) => presets.some((p) => p.id === id)).length })}</span>
        <button type="button" className="link-btn" onClick={onClose}>
          {t('watch.pickerDone')}
        </button>
      </div>
    </div>,
    document.body,
  )
}

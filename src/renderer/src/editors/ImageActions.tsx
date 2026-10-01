// XnConvert-style action list: add / reorder / toggle / edit image actions.
import { useState, type DragEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Blend,
  ChevronDown,
  ChevronRight,
  Contrast,
  Crop,
  Droplet,
  Focus,
  FlipHorizontal2,
  Frame,
  GripVertical,
  Palette,
  Plus,
  RotateCcwSquare,
  RotateCw,
  Scaling,
  Scissors,
  SlidersHorizontal,
  Stamp,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { Anchor, ImageAction, ImageActionType, ResizeMode } from '../../../shared/types'
import { useT } from '../store'
import type { MessageKey, TFunc } from '../i18n'
import { ACTION_GROUPS, newAction } from '../lib/presets'
import { AnchorGrid, Checkbox, ColorInput, IconButton, MenuButton, NumberInput, Row, Segmented, Select, Slider, TextInput, cx, type MenuItem } from '../components/ui'
import { WatermarkEditor } from './WatermarkEditor'

export const ACTION_ICON: Record<ImageActionType, LucideIcon> = {
  resize: Scaling,
  crop: Crop,
  rotate: RotateCw,
  flip: FlipHorizontal2,
  autoOrient: RotateCcwSquare,
  canvas: Frame,
  trim: Scissors,
  adjust: SlidersHorizontal,
  grayscale: Contrast,
  sepia: Palette,
  invert: Blend,
  sharpen: Focus,
  blur: Droplet,
  watermark: Stamp,
}

const ASPECTS = ['1:1', '4:3', '3:2', '16:9', '9:16', '4:5']
const RESIZE_MODES: ResizeMode[] = ['longEdge', 'shortEdge', 'fit', 'fill', 'stretch', 'width', 'height', 'percent']

type Patch<T extends ImageAction['type']> = Partial<Extract<ImageAction, { type: T }>>

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n))

export function actionSummary(a: ImageAction, t: TFunc): string {
  switch (a.type) {
    case 'resize':
      switch (a.mode) {
        case 'fit':
        case 'fill':
        case 'stretch':
          return `${t(`resize.${a.mode}` as MessageKey)} ${a.width ?? '?'}×${a.height ?? '?'}`
        case 'percent':
          return `${a.percent ?? 100}%`
        case 'longEdge':
        case 'shortEdge':
          return `${t(`resize.${a.mode}` as MessageKey)} ${a.size ?? '?'} px`
        case 'width':
          return `${t('resize.width')} ${a.width ?? '?'} px`
        case 'height':
          return `${t('resize.height')} ${a.height ?? '?'} px`
      }
      return ''
    case 'crop':
      if (a.mode === 'aspect') return `${a.aspect ?? '1:1'} · ${t(`anchor.${a.gravity ?? 'center'}` as MessageKey)}`
      if (a.mode === 'rect') return `${a.width ?? 0}×${a.height ?? 0} @ ${a.left ?? 0},${a.top ?? 0}`
      return t('crop.edgesSummary', { t: a.edges?.top ?? 0, r: a.edges?.right ?? 0, b: a.edges?.bottom ?? 0, l: a.edges?.left ?? 0 })
    case 'rotate':
      return `${a.angle}°`
    case 'flip':
      return t(a.axis === 'horizontal' ? 'flip.horizontal' : 'flip.vertical')
    case 'adjust': {
      const parts: string[] = []
      if (a.brightness) parts.push(`${t('adjust.brightness')} ${signed(a.brightness)}`)
      if (a.contrast) parts.push(`${t('adjust.contrast')} ${signed(a.contrast)}`)
      if (a.saturation) parts.push(`${t('adjust.saturation')} ${signed(a.saturation)}`)
      if (a.hue) parts.push(`${t('adjust.hue')} ${signed(a.hue)}°`)
      if (a.gamma !== 1) parts.push(`γ ${a.gamma}`)
      return parts.join(' · ') || t('adjust.noChange')
    }
    case 'sharpen':
    case 'blur':
      return `σ ${a.sigma}`
    case 'canvas':
      return `${a.top}/${a.right}/${a.bottom}/${a.left} ${a.unit === 'pct' ? '%' : 'px'}`
    case 'trim':
      return `${t('trim.threshold')} ${a.threshold}`
    case 'watermark':
      return a.watermark.type === 'text' ? `“${a.watermark.text}”` : t('wm.image')
    default:
      return ''
  }
}

export function ActionsPanel({ actions, onChange }: { actions: ImageAction[]; onChange: (a: ImageAction[]) => void }) {
  const t = useT()
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(actions.length <= 3 ? actions.map((a) => a.id) : []))
  const [armed, setArmed] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null)

  const update = (id: string, patch: Partial<ImageAction>): void => onChange(actions.map((a) => (a.id === id ? ({ ...a, ...patch } as ImageAction) : a)))
  const remove = (id: string): void => onChange(actions.filter((a) => a.id !== id))
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= actions.length) return
    const next = [...actions]
    const [it] = next.splice(from, 1)
    next.splice(to, 0, it)
    onChange(next)
  }
  const add = (type: ImageActionType): void => {
    const a = newAction(type)
    onChange([...actions, a])
    setOpenIds((s) => new Set(s).add(a.id))
  }
  const toggleOpen = (id: string): void =>
    setOpenIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const menu: MenuItem[] = ACTION_GROUPS.flatMap((g, gi) => [
    ...(gi ? [{ type: 'separator' as const, key: `sep-${g.group}` }] : []),
    { type: 'header' as const, key: `h-${g.group}`, label: t(`actionGroup.${g.group}` as MessageKey) },
    ...g.types.map((type) => ({ key: type, label: t(`action.${type}` as MessageKey), icon: ACTION_ICON[type], onSelect: () => add(type) })),
  ])

  const onDrop = (e: DragEvent, targetId: string): void => {
    e.preventDefault()
    if (!dragId || !over) return
    const from = actions.findIndex((a) => a.id === dragId)
    let to = actions.findIndex((a) => a.id === targetId)
    if (from < 0 || to < 0) return
    if (over.after) to++
    if (from < to) to--
    move(from, to)
    setDragId(null)
    setOver(null)
  }

  return (
    <div className="actions-panel">
      <div className="panel-head">
        <h3>
          {t('chain.actions')} <span className="count">{actions.length}</span>
        </h3>
        <MenuButton items={menu} label={t('chain.addAction')} icon={Plus} variant="primary" size="sm" align="right" />
      </div>
      {actions.length === 0 && <div className="actions-empty">{t('chain.noActions')}</div>}
      <ol className="action-list">
        {actions.map((a, i) => {
          const Icon = ACTION_ICON[a.type]
          const open = openIds.has(a.id)
          return (
            <li
              key={a.id}
              className={cx(
                'action-card',
                !a.enabled && 'disabled',
                dragId === a.id && 'dragging',
                over?.id === a.id && (over.after ? 'drop-after' : 'drop-before'),
              )}
              draggable={armed === a.id}
              onDragStart={(e) => {
                setDragId(a.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('application/x-mc-action', a.id)
              }}
              onDragEnd={() => {
                setDragId(null)
                setOver(null)
                setArmed(null)
              }}
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                setOver({ id: a.id, after: e.clientY > r.top + r.height / 2 })
              }}
              onDrop={(e) => onDrop(e, a.id)}
            >
              <div className="action-head">
                <span
                  className="grip"
                  onPointerDown={() => setArmed(a.id)}
                  onPointerUp={() => setArmed(null)}
                  title={t('chain.dragToReorder')}
                  aria-hidden
                >
                  <GripVertical size={14} />
                </span>
                <input
                  type="checkbox"
                  className="mini-check"
                  checked={a.enabled}
                  onChange={(e) => update(a.id, { enabled: e.target.checked })}
                  aria-label={t('chain.enableAction')}
                  title={t('chain.enableAction')}
                />
                <button type="button" className="action-title" onClick={() => toggleOpen(a.id)} aria-expanded={open}>
                  {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                  <Icon size={14} aria-hidden />
                  <span className="action-name">{t(`action.${a.type}` as MessageKey)}</span>
                  <span className="action-summary">{actionSummary(a, t)}</span>
                </button>
                <div className="action-tools">
                  <IconButton icon={ArrowUp} label={t('chain.moveUp')} size={13} disabled={i === 0} onClick={() => move(i, i - 1)} />
                  <IconButton icon={ArrowDown} label={t('chain.moveDown')} size={13} disabled={i === actions.length - 1} onClick={() => move(i, i + 1)} />
                  <IconButton icon={Trash2} label={t('chain.removeAction')} size={13} tone="danger" onClick={() => remove(a.id)} />
                </div>
              </div>
              {open && (
                <div className="action-body">
                  <ActionForm action={a} onChange={(p) => update(a.id, p)} />
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ActionForm({ action: a, onChange }: { action: ImageAction; onChange: (p: Partial<ImageAction>) => void }) {
  const t = useT()
  switch (a.type) {
    case 'resize': {
      const set = (p: Patch<'resize'>): void => onChange(p)
      const box = a.mode === 'fit' || a.mode === 'fill' || a.mode === 'stretch'
      return (
        <>
          <Row label={t('resize.mode')}>
            <Select value={a.mode} onChange={(m) => set({ mode: m as ResizeMode })} aria-label={t('resize.mode')}>
              {RESIZE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`resize.${m}.long` as MessageKey)}
                </option>
              ))}
            </Select>
          </Row>
          {box && (
            <Row label={t('resize.size')}>
              <div className="inline-controls">
                <NumberInput value={a.width} onChange={(width) => set({ width: width ?? undefined })} min={1} max={65000} integer width={92} suffix="W" ariaLabel={t('resize.width')} />
                <span className="times">×</span>
                <NumberInput value={a.height} onChange={(height) => set({ height: height ?? undefined })} min={1} max={65000} integer width={92} suffix="H" ariaLabel={t('resize.height')} />
              </div>
            </Row>
          )}
          {(a.mode === 'longEdge' || a.mode === 'shortEdge') && (
            <Row label={t('resize.edge')}>
              <NumberInput value={a.size} onChange={(size) => set({ size: size ?? undefined })} min={1} max={65000} integer width={110} suffix="px" ariaLabel={t('resize.edge')} />
            </Row>
          )}
          {a.mode === 'width' && (
            <Row label={t('resize.width')}>
              <NumberInput value={a.width} onChange={(width) => set({ width: width ?? undefined })} min={1} max={65000} integer width={110} suffix="px" ariaLabel={t('resize.width')} />
            </Row>
          )}
          {a.mode === 'height' && (
            <Row label={t('resize.height')}>
              <NumberInput value={a.height} onChange={(height) => set({ height: height ?? undefined })} min={1} max={65000} integer width={110} suffix="px" ariaLabel={t('resize.height')} />
            </Row>
          )}
          {a.mode === 'percent' && (
            <Row label={t('resize.percent')}>
              <Slider value={a.percent ?? 100} min={5} max={400} step={5} onChange={(percent) => set({ percent })} format={(n) => `${n}%`} ariaLabel={t('resize.percent')} />
            </Row>
          )}
          <Row label={t('resize.kernel')}>
            <Select value={a.kernel ?? 'lanczos3'} onChange={(k) => set({ kernel: k as 'lanczos3' })} aria-label={t('resize.kernel')}>
              {(['lanczos3', 'mitchell', 'cubic', 'nearest'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`kernel.${k}` as MessageKey)}
                </option>
              ))}
            </Select>
          </Row>
          <Row label="">
            <Checkbox checked={a.withoutEnlargement} onChange={(withoutEnlargement) => set({ withoutEnlargement })} label={t('resize.noEnlarge')} />
          </Row>
        </>
      )
    }
    case 'crop': {
      const set = (p: Patch<'crop'>): void => onChange(p)
      const edges = a.edges ?? { top: 0, right: 0, bottom: 0, left: 0 }
      const smart = a.gravity === 'attention' || a.gravity === 'entropy'
      return (
        <>
          <Row label={t('crop.mode')}>
            <Segmented
              value={a.mode}
              onChange={(mode) => set({ mode })}
              ariaLabel={t('crop.mode')}
              options={[
                { value: 'aspect', label: t('crop.aspect') },
                { value: 'rect', label: t('crop.rect') },
                { value: 'edges', label: t('crop.edges') },
              ]}
            />
          </Row>
          {a.mode === 'aspect' && (
            <>
              <Row label={t('crop.ratio')}>
                <div className="chips-row">
                  {ASPECTS.map((r) => (
                    <button key={r} type="button" className={cx('chip', a.aspect === r && 'active')} onClick={() => set({ aspect: r })} aria-pressed={a.aspect === r}>
                      {r}
                    </button>
                  ))}
                  <TextInput value={a.aspect ?? ''} onChange={(aspect) => set({ aspect })} className="aspect-input" aria-label={t('crop.customRatio')} placeholder="21:9" />
                </div>
              </Row>
              <Row label={t('crop.gravity')}>
                <div className="wm-position">
                  <AnchorGrid value={smart ? null : ((a.gravity as Anchor | undefined) ?? 'center')} onChange={(gravity) => set({ gravity })} />
                  <div className="stack">
                    <span className="mini-label">{t('crop.smart')}</span>
                    <Segmented<string>
                      size="sm"
                      value={smart ? (a.gravity as string) : ''}
                      onChange={(g) => set({ gravity: g as 'attention' })}
                      ariaLabel={t('crop.smart')}
                      options={[
                        { value: 'attention', label: t('anchor.attention'), title: t('crop.attentionHint') },
                        { value: 'entropy', label: t('anchor.entropy'), title: t('crop.entropyHint') },
                      ]}
                    />
                  </div>
                </div>
              </Row>
            </>
          )}
          {a.mode === 'rect' && (
            <>
              <Row label={t('crop.position')}>
                <div className="inline-controls">
                  <NumberInput value={a.left ?? 0} onChange={(left) => set({ left: left ?? 0 })} min={0} integer width={92} suffix="X" ariaLabel="X" />
                  <NumberInput value={a.top ?? 0} onChange={(top) => set({ top: top ?? 0 })} min={0} integer width={92} suffix="Y" ariaLabel="Y" />
                </div>
              </Row>
              <Row label={t('crop.size')}>
                <div className="inline-controls">
                  <NumberInput value={a.width} onChange={(width) => set({ width: width ?? undefined })} min={1} integer width={92} suffix="W" ariaLabel={t('resize.width')} />
                  <span className="times">×</span>
                  <NumberInput value={a.height} onChange={(height) => set({ height: height ?? undefined })} min={1} integer width={92} suffix="H" ariaLabel={t('resize.height')} />
                </div>
              </Row>
            </>
          )}
          {a.mode === 'edges' && (
            <Row label={t('crop.removePx')}>
              <div className="edges-grid">
                {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                  <label key={k} className="edge-field">
                    <span>{t(`edge.${k}` as MessageKey)}</span>
                    <NumberInput value={edges[k]} onChange={(n) => set({ edges: { ...edges, [k]: n ?? 0 } })} min={0} integer width={80} suffix="px" ariaLabel={t(`edge.${k}` as MessageKey)} />
                  </label>
                ))}
              </div>
            </Row>
          )}
        </>
      )
    }
    case 'rotate': {
      const set = (p: Patch<'rotate'>): void => onChange(p)
      const right = a.angle % 90 === 0
      return (
        <>
          <Row label={t('rotate.angle')}>
            <div className="inline-controls">
              {[90, 180, 270].map((d) => (
                <button key={d} type="button" className={cx('chip', a.angle === d && 'active')} onClick={() => set({ angle: d })} aria-pressed={a.angle === d}>
                  {d}°
                </button>
              ))}
              <NumberInput value={a.angle} onChange={(angle) => set({ angle: angle ?? 0 })} min={-360} max={360} step={1} width={90} suffix="°" ariaLabel={t('rotate.angle')} />
            </div>
          </Row>
          <Row label={t('rotate.background')} hint={right ? t('rotate.backgroundHint') : undefined}>
            <ColorInput value={a.background ?? '#000000'} onChange={(background) => set({ background })} disabled={right} ariaLabel={t('rotate.background')} />
          </Row>
        </>
      )
    }
    case 'flip':
      return (
        <Row label={t('flip.axis')}>
          <Segmented
            value={a.axis}
            onChange={(axis) => onChange({ axis } as Patch<'flip'>)}
            ariaLabel={t('flip.axis')}
            options={[
              { value: 'horizontal', label: t('flip.horizontal') },
              { value: 'vertical', label: t('flip.vertical') },
            ]}
          />
        </Row>
      )
    case 'adjust': {
      const set = (p: Patch<'adjust'>): void => onChange(p)
      const sliders: { key: 'brightness' | 'contrast' | 'saturation' | 'hue'; min: number; max: number; unit?: string }[] = [
        { key: 'brightness', min: -100, max: 100 },
        { key: 'contrast', min: -100, max: 100 },
        { key: 'saturation', min: -100, max: 100 },
        { key: 'hue', min: -180, max: 180, unit: '°' },
      ]
      const changed = a.brightness || a.contrast || a.saturation || a.hue || a.gamma !== 1
      return (
        <>
          {sliders.map((s) => (
            <Row key={s.key} label={t(`adjust.${s.key}` as MessageKey)}>
              <Slider value={a[s.key]} min={s.min} max={s.max} step={1} onChange={(n) => set({ [s.key]: n })} format={(n) => `${signed(n)}${s.unit ?? ''}`} resetTo={0} ariaLabel={t(`adjust.${s.key}` as MessageKey)} />
            </Row>
          ))}
          <Row label={t('adjust.gamma')}>
            <Slider value={a.gamma} min={0.1} max={3} step={0.05} onChange={(gamma) => set({ gamma })} format={(n) => n.toFixed(2)} resetTo={1} ariaLabel={t('adjust.gamma')} />
          </Row>
          <Row label="">
            <button type="button" className="link-btn" disabled={!changed} onClick={() => set({ brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1 })}>
              {t('adjust.resetAll')}
            </button>
          </Row>
        </>
      )
    }
    case 'sharpen':
    case 'blur':
      return (
        <Row label={t('filter.sigma')} hint={t(a.type === 'sharpen' ? 'filter.sharpenHint' : 'filter.blurHint')}>
          <Slider value={a.sigma} min={0.3} max={a.type === 'blur' ? 30 : 10} step={0.1} onChange={(sigma) => onChange({ sigma })} format={(n) => n.toFixed(1)} ariaLabel={t('filter.sigma')} />
        </Row>
      )
    case 'canvas': {
      const set = (p: Patch<'canvas'>): void => onChange(p)
      const same = a.top === a.right && a.top === a.bottom && a.top === a.left
      return (
        <>
          <Row label={t('canvas.unit')}>
            <Segmented value={a.unit} onChange={(unit) => set({ unit })} ariaLabel={t('canvas.unit')} options={[{ value: 'px', label: 'px' }, { value: 'pct', label: t('canvas.pct') }]} />
          </Row>
          <Row label={t('canvas.all')}>
            <NumberInput value={same ? a.top : null} placeholder="—" onChange={(n) => n != null && set({ top: n, right: n, bottom: n, left: n })} min={0} integer={a.unit === 'px'} width={100} suffix={a.unit === 'px' ? 'px' : '%'} ariaLabel={t('canvas.all')} allowEmpty />
          </Row>
          <Row label={t('canvas.sides')}>
            <div className="edges-grid">
              {(['top', 'right', 'bottom', 'left'] as const).map((k) => (
                <label key={k} className="edge-field">
                  <span>{t(`edge.${k}` as MessageKey)}</span>
                  <NumberInput value={a[k]} onChange={(n) => set({ [k]: n ?? 0 })} min={0} integer={a.unit === 'px'} width={80} suffix={a.unit === 'px' ? 'px' : '%'} ariaLabel={t(`edge.${k}` as MessageKey)} />
                </label>
              ))}
            </div>
          </Row>
          <Row label={t('canvas.color')}>
            <ColorInput value={a.color} onChange={(color) => set({ color })} ariaLabel={t('canvas.color')} />
          </Row>
        </>
      )
    }
    case 'trim':
      return (
        <Row label={t('trim.threshold')} hint={t('trim.hint')}>
          <Slider value={a.threshold} min={0} max={100} step={1} onChange={(threshold) => onChange({ threshold })} ariaLabel={t('trim.threshold')} />
        </Row>
      )
    case 'watermark':
      return <WatermarkEditor value={a.watermark} allowNone={false} onChange={(w) => w && onChange({ watermark: w } as Patch<'watermark'>)} />
    case 'autoOrient':
    case 'grayscale':
    case 'sepia':
    case 'invert':
      return <p className="note">{t(`action.${a.type}.hint` as MessageKey)}</p>
  }
}

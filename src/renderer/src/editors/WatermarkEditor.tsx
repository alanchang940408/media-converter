// Text / image watermark editor shared by video presets and the image "watermark" action.
import { ImagePlus, Type, Ban } from 'lucide-react'
import type { Watermark } from '../../../shared/types'
import { api } from '../api'
import { guard, useT } from '../store'
import { defaultTextWatermark } from '../lib/presets'
import { fileName } from '../lib/format'
import { AnchorGrid, Button, Checkbox, ColorInput, Row, Segmented, Slider, TextInput, cx } from '../components/ui'

const TOKENS = ['{name}', '{date}'] as const

export function WatermarkEditor({
  value,
  onChange,
  allowNone = true,
  disabled,
}: {
  value: Watermark | null | undefined
  onChange: (w: Watermark | null) => void
  allowNone?: boolean
  disabled?: boolean
}) {
  const t = useT()
  const type = value?.type ?? 'none'

  const setType = (tp: 'none' | 'text' | 'image'): void => {
    if (tp === type) return
    if (tp === 'none') return onChange(null)
    const common = { anchor: value?.anchor ?? 'bottom-right', marginPct: value?.marginPct ?? 3, opacity: value?.opacity ?? 0.85 } as const
    if (tp === 'text') onChange({ ...defaultTextWatermark(), ...common })
    else onChange({ type: 'image', path: '', scalePct: 15, ...common })
  }

  const pickLogo = async (): Promise<void> => {
    if (value?.type !== 'image') return
    const files = await guard(() => api.pickFiles('watermark', false))
    if (files?.[0]) onChange({ ...value, path: files[0] })
  }

  const options = [
    ...(allowNone ? [{ value: 'none' as const, label: t('wm.none'), icon: Ban }] : []),
    { value: 'text' as const, label: t('wm.text'), icon: Type },
    { value: 'image' as const, label: t('wm.image'), icon: ImagePlus },
  ]

  return (
    <div className={cx('wm-editor', disabled && 'is-disabled')}>
      <Row label={t('wm.type')}>
        <Segmented value={type} options={options} onChange={setType} disabled={disabled} ariaLabel={t('wm.type')} />
      </Row>

      {value?.type === 'text' && (
        <>
          <Row label={t('wm.textLabel')} hint={
            <span className="token-hints">
              {t('wm.tokens')}
              {TOKENS.map((tok) => (
                <button key={tok} type="button" className="chip chip-sm" disabled={disabled} onClick={() => onChange({ ...value, text: `${value.text}${value.text && !value.text.endsWith(' ') ? ' ' : ''}${tok}` })} title={t(tok === '{name}' ? 'wm.tokenName' : 'wm.tokenDate')}>
                  {tok}
                </button>
              ))}
            </span>
          }>
            <TextInput value={value.text} onChange={(text) => onChange({ ...value, text })} disabled={disabled} aria-label={t('wm.textLabel')} placeholder="© {name}" />
          </Row>
          <Row label={t('wm.fontSize')}>
            <Slider value={value.fontSizePct} min={1} max={20} step={0.5} onChange={(fontSizePct) => onChange({ ...value, fontSizePct })} format={(v) => `${v}%`} disabled={disabled} ariaLabel={t('wm.fontSize')} />
          </Row>
          <Row label={t('wm.color')}>
            <div className="inline-controls">
              <ColorInput value={value.color} onChange={(color) => onChange({ ...value, color })} disabled={disabled} ariaLabel={t('wm.color')} />
              <Checkbox checked={!!value.bold} onChange={(bold) => onChange({ ...value, bold })} label={t('wm.bold')} disabled={disabled} />
              <Checkbox checked={!!value.shadow} onChange={(shadow) => onChange({ ...value, shadow })} label={t('wm.shadow')} disabled={disabled} />
            </div>
          </Row>
          <Row label={t('wm.background')}>
            <div className="inline-controls">
              <Checkbox checked={!!value.background} onChange={(on) => onChange({ ...value, background: on ? '#000000' : null })} label={t('wm.backgroundBox')} disabled={disabled} />
              {value.background && <ColorInput value={value.background} onChange={(background) => onChange({ ...value, background })} disabled={disabled} ariaLabel={t('wm.background')} />}
            </div>
          </Row>
        </>
      )}

      {value?.type === 'image' && (
        <>
          <Row label={t('wm.logo')} hint={t('wm.logoHint')}>
            <div className="path-field">
              <span className={cx('path-text', !value.path && 'muted')} title={value.path}>
                {value.path ? fileName(value.path) : t('wm.noLogo')}
              </span>
              <Button size="sm" onClick={pickLogo} disabled={disabled}>
                {t('common.browse')}
              </Button>
            </div>
          </Row>
          <Row label={t('wm.scale')}>
            <Slider value={value.scalePct} min={2} max={60} step={1} onChange={(scalePct) => onChange({ ...value, scalePct })} format={(v) => `${v}%`} disabled={disabled} ariaLabel={t('wm.scale')} />
          </Row>
        </>
      )}

      {value && (
        <>
          <Row label={t('wm.position')}>
            <div className="wm-position">
              <AnchorGrid value={value.anchor} onChange={(anchor) => onChange({ ...value, anchor })} disabled={disabled} />
              <div className="wm-position-side">
                <span className="mini-label">{t('wm.margin')}</span>
                <Slider value={value.marginPct} min={0} max={20} step={0.5} onChange={(marginPct) => onChange({ ...value, marginPct })} format={(v) => `${v}%`} disabled={disabled} ariaLabel={t('wm.margin')} />
              </div>
            </div>
          </Row>
          <Row label={t('wm.opacity')}>
            <Slider value={Math.round(value.opacity * 100)} min={0} max={100} step={1} onChange={(v) => onChange({ ...value, opacity: v / 100 })} format={(v) => `${v}%`} disabled={disabled} ariaLabel={t('wm.opacity')} />
          </Row>
        </>
      )}
    </div>
  )
}

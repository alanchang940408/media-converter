// Small UI kit: buttons, inputs, switches, segmented controls, sliders, menus, modals.
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, LoaderCircle, RotateCcw, X, type LucideIcon } from 'lucide-react'
import type { Anchor } from '../../../shared/types'
import { useT } from '../store'
import type { MessageKey } from '../i18n'
import { clamp } from '../lib/format'

export const cx = (...a: (string | false | null | undefined)[]): string => a.filter(Boolean).join(' ')

// ───────────────────────────── buttons ─────────────────────────────

type BtnVariant = 'default' | 'primary' | 'ghost' | 'danger' | 'start' | 'stop' | 'subtle'

export function Button({
  variant = 'default',
  size = 'md',
  icon: Icon,
  iconRight: IconRight,
  children,
  className,
  type = 'button',
  busy,
  ...rest
}: ComponentProps<'button'> & { variant?: BtnVariant; size?: 'sm' | 'md' | 'lg'; icon?: LucideIcon; iconRight?: LucideIcon; busy?: boolean }) {
  const s = size === 'lg' ? 18 : size === 'sm' ? 13 : 15
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, `btn-${size}`, !children && 'btn-icon-only', className)} {...rest}>
      {busy ? <LoaderCircle size={s} className="spin" aria-hidden /> : Icon && <Icon size={s} aria-hidden />}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
      {IconRight && <IconRight size={s - 2} aria-hidden className="btn-icon-right" />}
    </button>
  )
}

export function IconButton({
  icon: Icon,
  label,
  size = 15,
  active,
  className,
  tone,
  ...rest
}: ComponentProps<'button'> & { icon: LucideIcon; label: string; size?: number; active?: boolean; tone?: 'danger' | 'accent' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx('icon-btn', active && 'active', tone && `tone-${tone}`, className)}
      {...rest}
    >
      <Icon size={size} aria-hidden />
    </button>
  )
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} className={cx('spin', className)} aria-hidden />
}

// ───────────────────────────── toggles ─────────────────────────────

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  disabled?: boolean
  title?: string
}) {
  return (
    <label className={cx('switch', disabled && 'disabled')} title={title}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden>
        <span className="switch-thumb" />
      </span>
      {label != null && <span className="switch-label">{label}</span>}
    </label>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
  title?: string
}) {
  return (
    <label className={cx('checkbox', disabled && 'disabled')} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden>
        <Check size={11} strokeWidth={3.2} />
      </span>
      <span className="checkbox-label">{label}</span>
    </label>
  )
}

export interface SegOption<T> {
  value: T
  label: ReactNode
  title?: string
  disabled?: boolean
  icon?: LucideIcon
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  ariaLabel,
  disabled,
  stretch,
}: {
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  ariaLabel?: string
  disabled?: boolean
  stretch?: boolean
}) {
  return (
    <div className={cx('segmented', `segmented-${size}`, stretch && 'stretch', disabled && 'disabled')} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => {
        const Icon = o.icon
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={cx('seg', o.value === value && 'active')}
            disabled={disabled || o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {Icon && <Icon size={13} aria-hidden />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ───────────────────────────── inputs ─────────────────────────────

export function Select({
  value,
  onChange,
  children,
  className,
  ...rest
}: Omit<ComponentProps<'select'>, 'onChange'> & { onChange: (v: string) => void }) {
  return (
    <span className={cx('select-wrap', rest.disabled && 'disabled', className)}>
      <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
        {children}
      </select>
      <ChevronDown className="select-arrow" size={13} aria-hidden />
    </span>
  )
}

export function TextInput({
  value,
  onChange,
  className,
  ...rest
}: Omit<ComponentProps<'input'>, 'onChange' | 'value'> & { value: string; onChange: (v: string) => void }) {
  return <input type="text" className={cx('text-input', className)} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />
}

const fmtNum = (v: number | null | undefined): string => (v == null ? '' : String(Math.round(v * 1000) / 1000))

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  placeholder,
  allowEmpty,
  width,
  disabled,
  ariaLabel,
  integer,
}: {
  value: number | null | undefined
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  placeholder?: string
  allowEmpty?: boolean
  width?: number
  disabled?: boolean
  ariaLabel?: string
  integer?: boolean
}) {
  const [text, setText] = useState(fmtNum(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(fmtNum(value))
  }, [value])
  const bound = (n: number): number => {
    let r = clamp(n, min ?? -Infinity, max ?? Infinity)
    if (integer) r = Math.round(r)
    return Math.round(r * 1000) / 1000
  }
  const commit = (raw: string): void => {
    const s = raw.trim()
    if (!s) {
      if (allowEmpty) onChange(null)
      else setText(fmtNum(value))
      return
    }
    const n = Number(s.replace(',', '.'))
    if (!Number.isFinite(n)) {
      setText(fmtNum(value))
      return
    }
    const r = bound(n)
    setText(fmtNum(r))
    if (r !== value) onChange(r)
  }
  return (
    <span className={cx('num-input', disabled && 'disabled')} style={width ? { width } : undefined}>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        onFocus={() => (focused.current = true)}
        onBlur={(e) => {
          focused.current = false
          commit(e.target.value)
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value)
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const cur = Number(text.replace(',', '.'))
            const base = Number.isFinite(cur) && text.trim() ? cur : (value ?? min ?? 0)
            const r = bound(base + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1))
            setText(fmtNum(r))
            onChange(r)
          }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </span>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  marks,
  disabled,
  ariaLabel,
  resetTo,
  reversed,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  format?: (v: number) => string
  marks?: { value: number; label: string }[]
  disabled?: boolean
  ariaLabel?: string
  /** Shows a small reset button when value !== resetTo. */
  resetTo?: number
  /** Fill from the right (e.g. CRF: lower = better). */
  reversed?: boolean
}) {
  const t = useT()
  const pct = ((value - min) / (max - min)) * 100
  const style = { '--pct': `${reversed ? 100 - pct : pct}%` } as CSSProperties
  return (
    <div className={cx('slider', disabled && 'disabled', marks && 'has-marks', reversed && 'reversed')}>
      <div className="slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-valuetext={format ? format(value) : undefined}
          style={style}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {marks && (
          <div className="slider-marks" aria-hidden>
            {marks.map((m) => (
              <span
                key={m.value}
                className={cx('slider-mark', m.value === value && 'active')}
                style={{ left: `${((m.value - min) / (max - min)) * 100}%` }}
                onClick={() => !disabled && onChange(m.value)}
              >
                <i />
                {m.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="slider-value">{format ? format(value) : value}</span>
      {resetTo != null && (
        <button
          type="button"
          className={cx('slider-reset', value === resetTo && 'hidden')}
          onClick={() => onChange(resetTo)}
          aria-label={t('common.reset')}
          title={t('common.reset')}
          disabled={disabled || value === resetTo}
        >
          <RotateCcw size={12} aria-hidden />
        </button>
      )}
    </div>
  )
}

const HEX = /^#[0-9a-f]{6}$/i

export function ColorInput({ value, onChange, disabled, ariaLabel }: { value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const safe = HEX.test(value) ? value : '#000000'
  return (
    <span className={cx('color-input', disabled && 'disabled')}>
      <span className="color-swatch" style={{ background: safe }}>
        <input type="color" value={safe} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} />
      </span>
      <input
        type="text"
        value={text}
        maxLength={7}
        spellCheck={false}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = text.startsWith('#') ? text : `#${text}`
          if (HEX.test(v)) onChange(v.toLowerCase())
          else setText(value)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
}

export function ProgressBar({ value, tone, className }: { value: number; tone?: 'ok' | 'error' | 'muted'; className?: string }) {
  const v = clamp(value, 0, 1)
  return (
    <div className={cx('progress', tone && `progress-${tone}`, className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className="progress-fill" style={{ width: `${v * 100}%` }} />
    </div>
  )
}

// ───────────────────────────── layout helpers ─────────────────────────────

export function Row({ label, hint, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('form-row', className)}>
      <label className="form-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="form-control">
        {children}
        {hint && <div className="form-hint">{hint}</div>}
      </div>
    </div>
  )
}

export function Section({
  title,
  icon: Icon,
  right,
  children,
  className,
  muted,
}: {
  title: ReactNode
  icon?: LucideIcon
  right?: ReactNode
  children: ReactNode
  className?: string
  muted?: boolean
}) {
  return (
    <section className={cx('section', muted && 'section-muted', className)}>
      <header className="section-header">
        {Icon && <Icon size={14} aria-hidden />}
        <h3>{title}</h3>
        {right && <div className="section-right">{right}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  )
}

// ───────────────────────────── anchor grid ─────────────────────────────

export const ANCHORS: Anchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']

export function AnchorGrid({ value, onChange, disabled }: { value: Anchor | null; onChange: (a: Anchor) => void; disabled?: boolean }) {
  const t = useT()
  return (
    <div className={cx('anchor-grid', disabled && 'disabled')} role="radiogroup" aria-label={t('wm.position')}>
      {ANCHORS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          disabled={disabled}
          className={cx('anchor-cell', value === a && 'active')}
          title={t(`anchor.${a}` as MessageKey)}
          aria-label={t(`anchor.${a}` as MessageKey)}
          onClick={() => onChange(a)}
        >
          <span />
        </button>
      ))}
    </div>
  )
}

// ───────────────────────────── menu ─────────────────────────────

export type MenuItem =
  | { type?: 'item'; key: string; label: ReactNode; icon?: LucideIcon; onSelect: () => void; disabled?: boolean; danger?: boolean; hint?: string; checked?: boolean }
  | { type: 'separator'; key: string }
  | { type: 'header'; key: string; label: ReactNode }

export function MenuButton({
  items,
  label,
  icon,
  variant = 'default',
  size = 'md',
  align = 'left',
  ariaLabel,
  className,
  disabled,
  title,
  caret = true,
  iconOnly,
}: {
  items: MenuItem[]
  label?: ReactNode
  icon?: LucideIcon
  variant?: BtnVariant
  size?: 'sm' | 'md'
  align?: 'left' | 'right'
  ariaLabel?: string
  className?: string
  disabled?: boolean
  title?: string
  caret?: boolean
  iconOnly?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button
        ref={btn}
        variant={variant}
        size={size}
        icon={icon}
        iconRight={caret && !iconOnly ? ChevronDown : undefined}
        className={cx(className, open && 'pressed')}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title ?? ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {iconOnly ? null : label}
      </Button>
      {open && <Menu anchor={btn.current} items={items} align={align} onClose={() => setOpen(false)} />}
    </>
  )
}

export function Menu({ anchor, items, align = 'left', onClose }: { anchor: HTMLElement | null; items: MenuItem[]; align?: 'left' | 'right'; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden', top: 0, left: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const r = anchor.getBoundingClientRect()
    const mh = el.offsetHeight
    const mw = el.offsetWidth
    const below = window.innerHeight - r.bottom
    const top = below < mh + 8 && r.top > mh + 8 ? r.top - mh - 4 : Math.min(r.bottom + 4, window.innerHeight - mh - 8)
    let left = align === 'right' ? r.right - mw : r.left
    left = clamp(left, 8, window.innerWidth - mw - 8)
    setPos({ top: Math.max(8, top), left, visibility: 'visible' })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [anchor, align])
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
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const btns = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const i = btns.indexOf(document.activeElement as HTMLButtonElement)
        const n = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length
        btns[n]?.focus()
      }
    }
    const onScroll = (e: Event): void => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, onClose])
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={pos}>
      {items.map((it) => {
        if (it.type === 'separator') return <div key={it.key} className="menu-sep" role="separator" />
        if (it.type === 'header') return <div key={it.key} className="menu-header">{it.label}</div>
        const Icon = it.icon
        return (
          <button
            key={it.key}
            type="button"
            role="menuitem"
            className={cx('menu-item', it.danger && 'danger')}
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              onClose()
              it.onSelect()
            }}
          >
            <span className="menu-icon">{it.checked ? <Check size={14} aria-hidden /> : Icon ? <Icon size={14} aria-hidden /> : null}</span>
            <span className="menu-label">{it.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

// ───────────────────────────── modal ─────────────────────────────

const modalStack: symbol[] = []

export function Modal({
  title,
  subtitle,
  icon: Icon,
  onClose,
  children,
  footer,
  size = 'md',
  className,
  bodyClassName,
  closeOnBackdrop = true,
  headerRight,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  bodyClassName?: string
  closeOnBackdrop?: boolean
  headerRight?: ReactNode
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const token = Symbol('modal')
    modalStack.push(token)
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    ;(el?.querySelector<HTMLElement>('[data-autofocus]') ?? el)?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || modalStack[modalStack.length - 1] !== token) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const i = modalStack.indexOf(token)
      if (i >= 0) modalStack.splice(i, 1)
      prev?.focus?.()
    }
  }, [])
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className={cx('modal', `modal-${size}`, className)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          {Icon && (
            <span className="modal-icon">
              <Icon size={16} aria-hidden />
            </span>
          )}
          <div className="modal-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          {headerRight}
          <IconButton icon={X} label={t('common.close')} onClick={onClose} className="modal-close" />
        </header>
        <div className={cx('modal-body', bodyClassName)}>{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function isModalOpen(): boolean {
  return modalStack.length > 0
}

/** True when keyboard focus is in a text field (global shortcuts should not fire). */
export function isTypingTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null
  if (!e) return false
  const tag = e.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable
}

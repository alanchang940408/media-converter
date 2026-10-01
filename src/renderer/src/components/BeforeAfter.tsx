// Before/after image comparison with a draggable divider (or side-by-side).
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { MoveHorizontal } from 'lucide-react'
import { useT } from '../store'
import { clamp } from '../lib/format'
import { cx } from './ui'

export function BeforeAfter({
  before,
  after,
  zoom,
  mode,
  outWidth,
  outHeight,
}: {
  before: string
  after: string
  zoom: 'fit' | 'actual'
  mode: 'split' | 'side'
  outWidth?: number
  outHeight?: number
}) {
  const t = useT()
  const [pos, setPos] = useState(50)
  const stage = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const fromEvent = (e: PointerEvent): void => {
    const r = stage.current?.getBoundingClientRect()
    if (!r || r.width === 0) return
    setPos(clamp(((e.clientX - r.left) / r.width) * 100, 0, 100))
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowLeft') setPos((p) => clamp(p - (e.shiftKey ? 10 : 2), 0, 100))
    else if (e.key === 'ArrowRight') setPos((p) => clamp(p + (e.shiftKey ? 10 : 2), 0, 100))
    else return
    e.preventDefault()
  }

  const actualStyle: CSSProperties | undefined = zoom === 'actual' && outWidth && outHeight ? { width: outWidth, height: outHeight } : undefined

  if (mode === 'side') {
    return (
      <div className={cx('ba-side', zoom === 'actual' && 'actual')}>
        <figure>
          <figcaption>{t('preview.before')}</figcaption>
          <div className="ba-side-img">
            <img src={before} alt={t('preview.before')} draggable={false} style={actualStyle} />
          </div>
        </figure>
        <figure>
          <figcaption>{t('preview.after')}</figcaption>
          <div className="ba-side-img">
            <img src={after} alt={t('preview.after')} draggable={false} style={actualStyle} />
          </div>
        </figure>
      </div>
    )
  }

  return (
    <div className={cx('ba', zoom === 'actual' ? 'ba-actual' : 'ba-fit')}>
      <div
        ref={stage}
        className="ba-stage"
        style={actualStyle}
        onPointerDown={(e) => {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          fromEvent(e)
        }}
        onPointerMove={(e) => dragging.current && fromEvent(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <img className="ba-img" src={before} alt={t('preview.before')} draggable={false} />
        <img className="ba-img" src={after} alt={t('preview.after')} draggable={false} style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
        <div className="ba-divider" style={{ left: `${pos}%` }}>
          <span
            className="ba-handle"
            role="slider"
            tabIndex={0}
            aria-label={t('preview.divider')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            onKeyDown={onKey}
          >
            <MoveHorizontal size={14} aria-hidden />
          </span>
        </div>
        <span className="ba-tag left">{t('preview.before')}</span>
        <span className="ba-tag right">{t('preview.after')}</span>
      </div>
    </div>
  )
}

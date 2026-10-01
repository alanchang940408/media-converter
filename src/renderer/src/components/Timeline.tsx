// Seekable timeline with an in/out (trim) range.
import { useRef, type PointerEvent } from 'react'
import { useT } from '../store'
import { clamp, formatTimecode } from '../lib/format'

export function Timeline({
  duration,
  time,
  inSec,
  outSec,
  fps,
  onSeek,
}: {
  duration: number
  time: number
  inSec: number | null
  outSec: number | null
  fps: number
  onSeek: (t: number) => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const d = duration > 0 ? duration : 1
  const pct = (s: number): number => clamp((s / d) * 100, 0, 100)
  const seekFrom = (e: PointerEvent): void => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    onSeek(clamp((e.clientX - r.left) / r.width, 0, 1) * d)
  }
  const hasTrim = inSec != null || outSec != null
  const a = inSec ?? 0
  const b = outSec ?? d
  return (
    <div
      ref={ref}
      className="timeline"
      role="slider"
      tabIndex={0}
      aria-label={t('preview.timeline')}
      aria-valuemin={0}
      aria-valuemax={Math.round(d)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={formatTimecode(time, fps)}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        seekFrom(e)
      }}
      onPointerMove={(e) => dragging.current && seekFrom(e)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <div className="tl-track" />
      {hasTrim && <div className="tl-range" style={{ left: `${pct(a)}%`, width: `${Math.max(0, pct(b) - pct(a))}%` }} />}
      {inSec != null && <div className="tl-mark tl-in" style={{ left: `${pct(inSec)}%` }} title={`${t('preview.in')} ${formatTimecode(inSec, fps)}`} />}
      {outSec != null && <div className="tl-mark tl-out" style={{ left: `${pct(outSec)}%` }} title={`${t('preview.out')} ${formatTimecode(outSec, fps)}`} />}
      <div className="tl-head" style={{ left: `${pct(time)}%` }} />
    </div>
  )
}

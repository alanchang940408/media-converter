// hh:mm:ss.ff text field: shows the formatted timecode, parses on Enter / blur, reverts invalid input.
import { useEffect, useRef, useState } from 'react'
import { formatTimecode, parseTimecode } from '../lib/format'
import { cx } from './ui'

export function TimecodeInput({
  value,
  onChange,
  fps,
  max,
  placeholder = '--:--:--.--',
  disabled,
  ariaLabel,
  className,
}: {
  value: number | null
  onChange: (sec: number | null) => void
  fps: number
  max?: number
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  className?: string
}) {
  const fmt = (v: number | null): string => (v == null ? '' : formatTimecode(v, fps))
  const [text, setText] = useState(fmt(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, fps])
  const commit = (raw: string): void => {
    if (!raw.trim()) {
      onChange(null)
      setText('')
      return
    }
    const n = parseTimecode(raw, fps)
    if (n == null) {
      setText(fmt(value))
      return
    }
    const v = Math.max(0, max != null ? Math.min(max, n) : n)
    setText(fmt(v))
    if (v !== value) onChange(v)
  }
  return (
    <input
      type="text"
      className={cx('text-input tc-input', className)}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      spellCheck={false}
      inputMode="numeric"
      onFocus={(e) => {
        focused.current = true
        e.currentTarget.select()
      }}
      onBlur={(e) => {
        focused.current = false
        commit(e.target.value)
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget.value)
        else if (e.key === 'Escape' && focused.current) {
          e.stopPropagation()
          setText(fmt(value))
          e.currentTarget.blur()
        }
      }}
    />
  )
}

import { useEffect, useRef, useState } from 'react'

/** Returns `value` after it has stopped changing for `ms`. Compare by `key` (e.g. JSON) to ignore identity churn. */
export function useDebouncedValue<T>(value: T, ms: number, key?: string): T {
  const [v, setV] = useState(value)
  const k = key ?? value
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, ms])
  return v
}

/** Latest-request-wins async loader: ignores results of superseded calls. */
export function useLatest(): () => (cb: () => void) => void {
  const seq = useRef(0)
  return () => {
    const mine = ++seq.current
    return (cb) => {
      if (mine === seq.current) cb()
    }
  }
}

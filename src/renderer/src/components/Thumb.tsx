// Lazy thumbnail (IntersectionObserver → api.getThumbnail, cached per path).
import { useEffect, useRef, useState } from 'react'
import { Film, Image as ImageIcon, Music } from 'lucide-react'
import type { MediaKind } from '../../../shared/types'
import { api } from '../api'
import { cx } from './ui'

const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function load(path: string, size: number): Promise<string | null> {
  const key = `${size}|${path}`
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null)
  let p = inflight.get(key)
  if (!p) {
    p = api
      .getThumbnail(path, size)
      .catch(() => null)
      .then((u) => {
        cache.set(key, u)
        inflight.delete(key)
        return u
      })
    inflight.set(key, p)
  }
  return p
}

export function KindIcon({ kind, size = 18 }: { kind: MediaKind; size?: number }) {
  if (kind === 'audio') return <Music size={size} aria-hidden />
  if (kind === 'image') return <ImageIcon size={size} aria-hidden />
  return <Film size={size} aria-hidden />
}

export function Thumb({ path, kind, size = 160, className }: { path: string; kind: MediaKind; size?: number; className?: string }) {
  const key = `${size}|${path}`
  const [url, setUrl] = useState<string | null | undefined>(() => (cache.has(key) ? cache.get(key) : undefined))
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (kind === 'audio') return
    if (cache.has(key)) {
      setUrl(cache.get(key))
      return
    }
    setUrl(undefined)
    const el = ref.current
    if (!el) return
    let alive = true
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        void load(path, size).then((u) => alive && setUrl(u))
      },
      { rootMargin: '200px' },
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [key, kind, path, size])

  return (
    <div ref={ref} className={cx('thumb', `thumb-${kind}`, url === undefined && kind !== 'audio' && 'loading', className)}>
      {url ? <img src={url} alt="" draggable={false} /> : <KindIcon kind={kind} size={kind === 'audio' ? 20 : 18} />}
    </div>
  )
}

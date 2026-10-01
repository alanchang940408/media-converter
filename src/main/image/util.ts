// Small helpers shared by the image engine modules. No Electron imports.
import type { Anchor } from '../../shared/types'

export interface Rgba {
  r: number
  g: number
  b: number
  alpha: number
}

export const WHITE: Rgba = { r: 255, g: 255, b: 255, alpha: 1 }
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, alpha: 0 }

/** Parse "#rgb", "#rrggbb" or "#rrggbbaa" (alpha optional). Returns `fallback` for anything else. */
export function parseColor(input: string | null | undefined, fallback: Rgba): Rgba {
  if (!input) return fallback
  const s = input.trim().toLowerCase()
  if (s === 'transparent') return TRANSPARENT
  let m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s)
  if (m) {
    return { r: parseInt(m[1] + m[1], 16), g: parseInt(m[2] + m[2], 16), b: parseInt(m[3] + m[3], 16), alpha: 1 }
  }
  m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(s)
  if (m) {
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      alpha: m[4] ? parseInt(m[4], 16) / 255 : 1,
    }
  }
  return fallback
}

/** "#rrggbb" for Pango markup (alpha dropped). */
export function toHex({ r, g, b }: Rgba): string {
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Finite number or the fallback. */
export const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/** Horizontal / vertical fraction (0, 0.5, 1) of a 3×3 anchor. */
export function anchorFractions(anchor: Anchor | string | undefined): { fx: number; fy: number } {
  const a = anchor ?? 'center'
  const fx = a.endsWith('left') ? 0 : a.endsWith('right') ? 1 : 0.5
  const fy = a.startsWith('top') ? 0 : a.startsWith('bottom') ? 1 : 0.5
  return { fx, fy }
}

export function abortError(): Error {
  const e = new Error('Aborted')
  e.name = 'AbortError'
  return e
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortError()
}

/** Local date as YYYY-MM-DD. */
export function today(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

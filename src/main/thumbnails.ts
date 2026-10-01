// Thumbnails for the queue list: data:image/jpeg URLs, in-memory LRU keyed by path + size + mtime.
import { stat } from 'node:fs/promises'
import { classifyPath } from '../shared/media'
import type { FfmpegEngine, ImageEngine } from './contracts'

const toDataUrl = (buf: Buffer): string => `data:image/jpeg;base64,${buf.toString('base64')}`

export class ThumbnailService {
  private readonly cache = new Map<string, string | null>()
  private readonly inFlight = new Map<string, Promise<string | null>>()

  constructor(
    private readonly ffmpeg: FfmpegEngine,
    private readonly image: ImageEngine,
    private readonly maxEntries = 300,
  ) {}

  async get(path: string, size = 160): Promise<string | null> {
    const kind = classifyPath(path)
    if (!kind || kind === 'audio') return null
    const box = Math.max(16, Math.min(1024, Math.round(size) || 160))
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) return null
    const key = `${path}|${box}|${st.mtimeMs}|${st.size}`
    if (this.cache.has(key)) {
      const v = this.cache.get(key)!
      this.cache.delete(key)
      this.cache.set(key, v)
      return v
    }
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.render(path, kind, box)
        .catch(() => null)
        .then((v) => {
          this.inFlight.delete(key)
          this.cache.set(key, v)
          while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!)
          return v
        })
      this.inFlight.set(key, p)
    }
    return p
  }

  clear(): void {
    this.cache.clear()
  }

  private async render(path: string, kind: 'video' | 'image', box: number): Promise<string | null> {
    if (kind === 'image') {
      try {
        return toDataUrl(await this.image.thumbnail(path, box))
      } catch {
        // formats sharp cannot read: let ffmpeg decode a frame
        return toDataUrl(await this.ffmpeg.extractFrame(path, 0, { maxWidth: box }))
      }
    }
    const info = await this.ffmpeg.probe(path).catch(() => null)
    if (info && !info.width) return null // audio-only stream in a video container
    const dur = info?.durationSec ?? 0
    const at = dur > 0 ? Math.min(1, dur * 0.1) : 0
    let opts: { maxWidth?: number; width?: number; height?: number } = { maxWidth: box }
    if (info?.width && info.height) {
      // fit within box×box, even dimensions
      const scale = Math.min(1, box / Math.max(info.width, info.height))
      const w = Math.max(2, Math.round((info.width * scale) / 2) * 2)
      const h = Math.max(2, Math.round((info.height * scale) / 2) * 2)
      opts = { width: w, height: h }
    }
    return toDataUrl(await this.ffmpeg.extractFrame(path, at, { ...opts, format: 'jpeg' }))
  }
}

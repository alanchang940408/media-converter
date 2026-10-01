// Cached encoder capabilities. Detection runs once at startup (async) and again on demand / ffmpeg path change.
import type { EncoderCapabilities } from '../shared/types'
import type { FfmpegEngine } from './contracts'
import { getFfmpegPaths } from './ffmpeg/paths'

export function missingCapabilities(): EncoderCapabilities {
  const p = getFfmpegPaths()
  return {
    ffmpegPath: p.ffmpeg,
    ffprobePath: p.ffprobe,
    ffmpegVersion: '',
    ffmpegSource: 'missing',
    compiledEncoders: [],
    workingHwEncoders: [],
    hw: { nvenc: false, qsv: false, amf: false, videotoolbox: false },
  }
}

export class CapabilitiesCache {
  private current: Promise<EncoderCapabilities> | null = null

  constructor(private readonly engine: FfmpegEngine) {}

  get(refresh = false): Promise<EncoderCapabilities> {
    if (!this.current || refresh) {
      const p = this.engine.detectCapabilities(refresh).catch((err) => {
        console.error('[caps] detection failed:', err)
        // retry on the next request instead of caching the failure
        if (this.current === p) this.current = null
        return missingCapabilities()
      })
      this.current = p
    }
    return this.current
  }
}

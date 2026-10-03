// Output frame size estimate for the UI (mirrors the engine's computeOutputSize rules).
import { pictureGeometry } from '../../../shared/media'
import type { MediaInfo, VideoPresetSettings } from '../../../shared/types'
import { isAudioOnlyContainer } from '../../../shared/videoRules'

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

export function computeVideoOutputSize(
  info: Pick<MediaInfo, 'width' | 'height' | 'sampleAspectRatio' | 'storageWidth' | 'storageHeight'> | undefined,
  s: VideoPresetSettings,
): { width: number; height: number } | null {
  if (isAudioOnlyContainer(s.container) || s.video.codec === 'none') return null
  // displayed size: non-square-pixel sources (DV, HDV) become square pixels at their displayed aspect
  const g = info ? pictureGeometry(info) : null
  const W = g?.width || 1920
  const H = g?.height || 1080
  // stream copy keeps the source picture as it is (shown here at its displayed size)
  if (s.video.codec === 'copy') return { width: W, height: H }
  if (s.container === 'gif' && s.video.gif) {
    let gw = s.video.gif.width ?? W
    if (s.video.noUpscale) gw = Math.min(gw, W)
    return { width: even(gw), height: even((gw * H) / W) }
  }
  const tw = s.video.width
  const th = s.video.height
  if (!tw && !th) return { width: even(W), height: even(H) }
  if (tw && !th) {
    const w = s.video.noUpscale ? Math.min(tw, W) : tw
    return { width: even(w), height: even((w * H) / W) }
  }
  if (!tw && th) {
    const h = s.video.noUpscale ? Math.min(th, H) : th
    return { width: even((h * W) / H), height: even(h) }
  }
  const bw = tw as number
  const bh = th as number
  switch (s.video.scaleMode) {
    case 'fit': {
      let k = Math.min(bw / W, bh / H)
      if (s.video.noUpscale) k = Math.min(k, 1)
      return { width: even(W * k), height: even(H * k) }
    }
    case 'pad':
    case 'crop':
    case 'stretch':
    default:
      return { width: even(bw), height: even(bh) }
  }
}

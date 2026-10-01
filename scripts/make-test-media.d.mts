// Types for scripts/make-test-media.mjs (imported by the E2E global setup).

export interface TestMediaManifest {
  dir: string
  /** 3 s 1280×720 H.264 + AAC .mov, CJK + space in the name */
  video: string
  /** 2 s 1280×720 ProRes Proxy .mov */
  prores: string
  /** 640×480 PNG with alpha */
  png: string
  /** 4000×3000 JPEG */
  jpeg: string
  /** 2 s animated GIF */
  gif: string
  /** 4 s 1280×720 flat grey H.264 .mp4 */
  flat: string
}

export function resolveFfmpeg(): { ffmpeg: string; ffprobe: string }

export function makeTestMedia(
  outDir: string,
  opts?: { force?: boolean; ffmpeg?: string; log?: (msg: string) => void },
): Promise<TestMediaManifest>

// ffmpeg engine: probe, capability detection, preset → args, encode runner, frame extraction.
import type { FfmpegEngine } from '../contracts'
import { buildArgs, computeOutputSize, outputExtension } from './args'
import { detectCapabilities } from './capabilities'
import { decodeImageToPng, extractFrame } from './frames'
import { probe } from './probe'
import { encode } from './runner'

export const ffmpegEngine: FfmpegEngine = {
  probe,
  detectCapabilities,
  outputExtension,
  computeOutputSize,
  buildArgs: (req) => buildArgs(req),
  encode,
  extractFrame,
  decodeImageToPng,
}

export { activePids } from './proc'
export { setCustomFfmpegPath, getFfmpegPaths } from './paths'

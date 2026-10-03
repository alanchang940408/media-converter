// encode() retry logic with a scripted fake ffmpeg process (no real ffmpeg): an ffmpeg build without the format
// filter's color_ranges option (< 7.1) gets the legacy yuvj422p MJPEG path, and later MJPEG jobs go there directly.
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EncodeError, type VideoEncodeRequest } from '../../src/main/contracts'
import type { VideoPresetSettings } from '../../src/shared/types'
import { fakeCaps, preset, videoInfo } from './fixtures'

interface Script {
  stderr: string[]
  code: number
}

const calls: string[][] = []
let respond: (args: string[]) => Script = () => ({ stderr: [], code: 0 })

vi.mock('../../src/main/ffmpeg/proc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/ffmpeg/proc')>()
  return {
    ...actual,
    spawnTracked: (_bin: string, args: string[]) => {
      calls.push(args)
      const { stderr, code } = respond(args)
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
      child.stderr.on('end', () => setImmediate(() => child.emit('close', code)))
      setImmediate(() => {
        child.stdout.end()
        child.stderr.end(stderr.length ? `${stderr.join('\n')}\n` : '')
      })
      return child
    },
  }
})

const { encode } = await import('../../src/main/ffmpeg/runner')

/** What ffmpeg 6.x / 7.0 print for format=pix_fmts=…:color_ranges=pc. */
const OLD_FFMPEG = [
  "[AVFilterGraph @ 0000020] Error applying option 'color_ranges' to filter 'format': Option not found",
  'Error opening output file out.avi.',
  'Error opening output files: Option not found',
]

const mjpeg = (): VideoPresetSettings => preset({ container: 'avi', video: { codec: 'mjpeg' }, audio: { codec: 'pcm' } })

function request(settings: VideoPresetSettings, logs: string[] = []): VideoEncodeRequest {
  return {
    // must exist: encode() checks its inputs before spawning
    source: resolve(__dirname, 'fixtures.ts'),
    info: videoInfo(),
    settings,
    trim: null,
    dest: 'C:/out/never written.part',
    overlay: null,
    caps: fakeCaps(),
    preferredHw: 'none',
    signal: new AbortController().signal,
    onProgress: () => {},
    onLog: (l) => logs.push(l),
  }
}

const vfOf = (args: string[]): string => args[args.indexOf('-vf') + 1]

beforeEach(() => {
  calls.length = 0
  respond = () => ({ stderr: [], code: 0 })
})

// order matters: the "this build is old" memo is module state
describe('MJPEG colour-range fallback', () => {
  it('other failures of an MJPEG job are not retried', async () => {
    respond = () => ({ stderr: ['av_interleaved_write_frame(): No space left on device'], code: 1 })
    await expect(encode(request(mjpeg()))).rejects.toBeInstanceOf(EncodeError)
    expect(calls).toHaveLength(1)
    expect(vfOf(calls[0])).toBe('format=pix_fmts=yuv422p:color_ranges=pc')
  })

  it('non-MJPEG jobs never take the legacy path', async () => {
    respond = () => ({ stderr: OLD_FFMPEG, code: 8 })
    await expect(encode(request(preset({ container: 'avi', video: { codec: 'mpeg4' } })))).rejects.toBeInstanceOf(EncodeError)
    expect(calls).toHaveLength(1)
  })

  it('an ffmpeg without color_ranges: retried once with yuvj422p, then used directly', async () => {
    respond = (args) => (vfOf(args).includes('color_ranges') ? { stderr: OLD_FFMPEG, code: 8 } : { stderr: [], code: 0 })
    const logs: string[] = []
    const res = await encode(request(mjpeg(), logs))
    expect(calls).toHaveLength(2)
    expect(vfOf(calls[0])).toBe('format=pix_fmts=yuv422p:color_ranges=pc')
    expect(vfOf(calls[1])).toBe('format=yuvj422p')
    expect(calls[1]).not.toContain('-color_range')
    expect(res).toMatchObject({ encoder: 'mjpeg', args: calls[1] })
    expect(logs.some((l) => /retrying with yuvj422p/.test(l))).toBe(true)

    // the next MJPEG job on the same ffmpeg skips the failing attempt
    calls.length = 0
    await encode(request(mjpeg()))
    expect(calls).toHaveLength(1)
    expect(vfOf(calls[0])).toBe('format=yuvj422p')
  })
})

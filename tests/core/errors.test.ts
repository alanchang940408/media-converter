// classify(): raw ffmpeg / sharp / Node failures → the small fixed set of codes the UI explains in the user's language.
import { describe, expect, it } from 'vitest'
import { EncodeError } from '../../src/main/contracts'
import { classify, jobError } from '../../src/main/queue/errors'
import { CopySizeError } from '../../src/main/queue/fileOps'
import type { Job, JobErrorCode, VideoPresetSettings } from '../../src/shared/types'

const SOURCE = 'C:\\Users\\me\\Videos\\broken clip.mp4'
const video: Pick<Job, 'kind' | 'source' | 'outputPath'> = { kind: 'video', source: SOURCE, outputPath: 'D:\\out\\broken clip_H264.mp4' }
const image: Pick<Job, 'kind' | 'source'> = { kind: 'image', source: 'C:\\Users\\me\\Pictures\\IMG_0001.heic' }
const file: Pick<Job, 'kind' | 'source'> = { kind: 'file', source: 'C:\\Users\\me\\Docs\\report.docx' }
const withWatermark = {
  ...video,
  video: { settings: { watermark: { type: 'image', path: 'C:/logos/logo.png', anchor: 'top-right', marginPct: 2, opacity: 1, scalePct: 10 } } as unknown as VideoPresetSettings },
}

/** A Node fs / child_process error as thrown on Windows. */
const errno = (message: string, code: string, extra: Record<string, string> = {}): Error =>
  Object.assign(new Error(message), { code, errno: -1, ...extra })
const enc = (message: string, tail: string[] = []): EncodeError => new EncodeError(message, tail, 1)

const cases: Array<[JobErrorCode, unknown, object?]> = [
  // sourceMissing
  ['sourceMissing', enc(`Source file not found: ${SOURCE}`)],
  ['sourceMissing', new Error('Cannot read broken clip.mp4: No such file or directory')],
  ['sourceMissing', errno(`ENOENT: no such file or directory, open '${SOURCE}'`, 'ENOENT', { syscall: 'open', path: SOURCE })],
  ['sourceMissing', errno(`ENOENT: no such file or directory, stat '${file.source}'`, 'ENOENT', { syscall: 'stat', path: file.source }), file],
  ['sourceMissing', jobError('找不到來源檔案：C:\\a.mp4', 'sourceMissing')],
  ['sourceMissing', new Error(`Input file is missing: ${image.source}`), image],
  // sourceUnreadable
  ['sourceUnreadable', new Error('Cannot read broken clip.mp4: Invalid data found when processing input')],
  ['sourceUnreadable', enc('[mov,mp4,m4a,3gp,3g2,mj2 @ 000001d8c5a3e540] moov atom not found')],
  ['sourceUnreadable', enc('Error opening input file C:\\Users\\me\\Videos\\broken clip.mp4.')],
  ['sourceUnreadable', new Error('No audio or video stream found in notes.txt.mp4')],
  ['sourceUnreadable', new Error('Timed out while reading broken clip.mp4')],
  ['sourceUnreadable', new Error('Could not decode a frame from broken clip.mp4')],
  // noVideoStream / noAudioStream
  ['noVideoStream', new Error('GIF output needs a video source (this file has no video stream).')],
  ['noVideoStream', enc("Stream map '0:V:0' matches no streams.")],
  ['noAudioStream', new Error('The source has no audio stream to encode.')],
  ['noAudioStream', enc("Stream map '0:a:0' matches no streams.")],
  // diskFull
  ['diskFull', errno('ENOSPC: no space left on device, write', 'ENOSPC', { syscall: 'write' })],
  ['diskFull', enc('[out#0/mp4 @ 0000021c] Error writing trailer: No space left on device')],
  ['diskFull', new Error('There is not enough space on the disk.')],
  // permissionDenied
  ['permissionDenied', errno("EPERM: operation not permitted, rename 'D:\\out\\a.mp4.mctmp' -> 'D:\\out\\a.mp4'", 'EPERM', { syscall: 'rename' })],
  ['permissionDenied', errno("EBUSY: resource busy or locked, unlink 'D:\\out\\a.mp4'", 'EBUSY', { syscall: 'unlink' }), file],
  ['permissionDenied', errno("EACCES: permission denied, open 'C:\\Program Files\\out.mp4'", 'EACCES', { syscall: 'open' })],
  ['permissionDenied', enc('[out#0/mp4 @ 0000021c] Error opening output D:/out/broken clip_H264.mp4.mctmp: Permission denied')],
  ['permissionDenied', new Error('The process cannot access the file because it is being used by another process.')],
  // outputPathInvalid
  ['outputPathInvalid', errno("ENAMETOOLONG: name too long, open 'D:\\out\\…'", 'ENAMETOOLONG', { syscall: 'open' })],
  ['outputPathInvalid', errno("EINVAL: invalid argument, open 'D:\\out\\a:b.mp4'", 'EINVAL', { syscall: 'open' })],
  ['outputPathInvalid', enc('[out#0/mp4 @ 0000021c] Error opening output D:/out/broken clip_H264.mp4.mctmp: Invalid argument')],
  ['outputPathInvalid', new Error('No free output name for D:\\out\\a.mp4')],
  ['outputPathInvalid', errno(`ENOENT: no such file or directory, open 'D:\\out\\broken clip_H264.mp4.mctmp'`, 'ENOENT', { syscall: 'open', path: 'D:\\out\\broken clip_H264.mp4.mctmp' })],
  // outputExists
  ['outputExists', enc("File 'D:/out/a.mp4' already exists. Exiting.")],
  ['outputExists', errno("EEXIST: file already exists, copyfile 'a' -> 'b'", 'EEXIST', { syscall: 'copyfile' }), file],
  // encoderUnavailable
  ['encoderUnavailable', enc("Unknown encoder 'libsvtav1'")],
  ['encoderUnavailable', enc("Encoder 'hevc_videotoolbox' not found")],
  ['encoderUnavailable', enc("Unrecognized option 'svtav1-params'.")],
  ['encoderUnavailable', enc("[AVFilterGraph @ 000002] No such filter: 'zscale'")],
  // gpuEncoderFailed
  ['gpuEncoderFailed', enc('[h264_nvenc @ 0000020a5f] OpenEncodeSessionEx failed: unsupported device (2): (no details)')],
  ['gpuEncoderFailed', enc('[hevc_qsv @ 000001] Error initializing an internal MFX session: unsupported (-3)')],
  ['gpuEncoderFailed', enc('[h264_amf @ 000001] CreateComponent(AMFVideoEncoderVCE_AVC) failed with error 30')],
  ['gpuEncoderFailed', enc('Conversion failed!', ['[h264_nvenc @ 0000020a5f] No capable devices found', '[vost#0:0/h264_nvenc @ 000001] Error while opening encoder', 'Conversion failed!'])],
  // invalidSettings
  ['invalidSettings', enc('[libx264 @ 000001] height not divisible by 2 (1280x721)')],
  ['invalidSettings', enc('[libx265 @ 000001] Specified pixel format yuva420p is invalid or not supported')],
  ['invalidSettings', enc('[vost#0:0/libx264 @ 000001] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height')],
  ['invalidSettings', enc('[mp4 @ 000001] Could not find tag for codec pcm_s16le in stream #1, codec not currently supported in container')],
  ['invalidSettings', new Error('Nothing to encode: video is disabled and audio is set to none.')],
  // ffmpegMissing
  ['ffmpegMissing', enc('ffmpeg was not found (C:\\tools\\ffmpeg.exe). Install ffmpeg or choose an ffmpeg folder in Settings.')],
  ['ffmpegMissing', new Error('ffprobe was not found (ffprobe). Install ffmpeg or choose an ffmpeg folder in Settings.')],
  ['ffmpegMissing', errno('spawn C:\\tools\\ffprobe.exe ENOENT', 'ENOENT', { syscall: 'spawn C:\\tools\\ffprobe.exe', path: 'C:\\tools\\ffprobe.exe' })],
  // imageDecodeFailed (a video job with the same text is unreadable)
  ['imageDecodeFailed', new Error('Input file contains unsupported image format'), image],
  ['imageDecodeFailed', new Error('VipsJpeg: Premature end of input file'), image],
  ['imageDecodeFailed', new Error('heifload: Invalid input: Unsupported feature: Unsupported codec (4.3000)'), image],
  ['sourceUnreadable', new Error('Input file contains unsupported image format')],
  // watermarkMissing
  ['watermarkMissing', enc('Watermark image not found: C:\\Users\\me\\AppData\\Local\\Temp\\mc\\job.png')],
  ['watermarkMissing', new Error('Input file is missing: C:\\logos\\logo.png'), withWatermark],
  ['watermarkMissing', errno("ENOENT: no such file or directory, open 'C:\\logos\\logo.png'", 'ENOENT', { syscall: 'open', path: 'C:\\logos\\logo.png' }), withWatermark],
  // outOfMemory
  ['outOfMemory', enc('[libx265 @ 000001] Cannot allocate memory')],
  ['outOfMemory', new Error('vips_malloc: out of memory --- size == 512MB'), image],
  ['outOfMemory', errno('ENOMEM: not enough memory, read', 'ENOMEM', { syscall: 'read' })],
  // copyIncomplete
  ['copyIncomplete', new CopySizeError(1000, 500), file],
  ['copyIncomplete', jobError('檔案沒有完整複製', 'copyIncomplete'), file],
  // unknown
  ['unknown', new Error('boom')],
  ['unknown', enc('Conversion failed!', ['frame=  10 fps=0.0 q=-1.0 size=       0kB', 'Conversion failed!'])],
  ['unknown', 'something odd'],
  ['unknown', undefined],
]

describe('classify job errors', () => {
  for (const [code, err, job] of cases) {
    const label = err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err)
    it(`${code} ← ${label}`, () => {
      expect(classify(err, (job ?? video) as Job).code).toBe(code)
    })
  }

  it('params carry the source file name', () => {
    expect(classify(new Error('boom'), video as Job).params).toEqual({ name: 'broken clip.mp4' })
    expect(classify(new Error('x'), { kind: 'video', source: '/home/me/片段 1.mov' } as Job).params).toEqual({ name: '片段 1.mov' })
  })

  it('every code above is exercised', () => {
    const all: JobErrorCode[] = [
      'sourceMissing', 'sourceUnreadable', 'noVideoStream', 'noAudioStream', 'diskFull', 'permissionDenied', 'outputPathInvalid',
      'outputExists', 'encoderUnavailable', 'gpuEncoderFailed', 'invalidSettings', 'ffmpegMissing', 'imageDecodeFailed',
      'watermarkMissing', 'outOfMemory', 'copyIncomplete', 'unknown',
    ]
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(all))
  })
})

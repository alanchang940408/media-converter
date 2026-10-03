// Classify why a job failed into a small fixed set of codes, so the UI can say it in the user's language (with a hint
// what to do) while the raw ffmpeg / sharp / Node message stays available in the details. Pure: no I/O.
import { EncodeError } from '../contracts'
import type { Job, JobErrorCode, Watermark } from '../../shared/types'
import { CopySizeError } from './fileOps'

export interface ClassifiedError {
  code: JobErrorCode
  params: Record<string, string | number>
}

type JobLike = Pick<Job, 'kind' | 'source'> & Partial<Pick<Job, 'outputPath' | 'sourceInfo' | 'video' | 'image'>>

const TAG = 'jobErrorCode'

/** An Error whose kind is already known where it is thrown (e.g. a localised "source missing" from the queue). */
export function jobError(message: string, code: JobErrorCode): Error {
  return Object.assign(new Error(message), { [TAG]: code })
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() || p
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

function watermarkPaths(job: JobLike): string[] {
  const marks: (Watermark | null | undefined)[] = [job.video?.settings.watermark]
  for (const a of job.image?.actions ?? []) if (a.type === 'watermark') marks.push(a.watermark)
  return marks.flatMap((w) => (w && w.type === 'image' && w.path ? [w.path] : []))
}

const HW = /nvenc|_qsv|\bqsv\b|_amf|\bamf\b|videotoolbox|vaapi|nvcuda|\bcuda\b|OpenEncodeSession|No capable devices? found|hardware (device|encoder|acceleration)|\bMFX\b|d3d11va|dxva/i

/** Ordered message rules; the first match wins. `image` replaces the code for image jobs. */
const RULES: Array<{ re: RegExp; code: JobErrorCode | ((job: JobLike, msg: string) => JobErrorCode) }> = [
  { re: /\b(ffmpeg|ffprobe) was not found\b|spawn \S*ff(mpeg|probe)\S* ENOENT/i, code: 'ffmpegMissing' },
  { re: /^Watermark image not found\b/i, code: 'watermarkMissing' },
  { re: /^Source file not found\b/i, code: 'sourceMissing' },
  // sharp: "Input file is missing: C:\logo.png" (the source, or the watermark image of an overlay)
  { re: /input file is missing/i, code: (job, msg) => missingWhat(job, msg) },
  { re: /no space left on device|not enough space on the disk|disk (is )?full|\bENOSPC\b|disk quota exceeded|\bEDQUOT\b/i, code: 'diskFull' },
  { re: /cannot allocate memory|out of memory|\bENOMEM\b|allocation failed|heap limit|failed to allocate/i, code: 'outOfMemory' },
  {
    re: /permission denied|operation not permitted|access is denied|\bEACCES\b|\bEPERM\b|\bEBUSY\b|resource busy or locked|used by another process|read-only file system|\bEROFS\b/i,
    code: 'permissionDenied',
  },
  {
    re: /file ?name too long|path too long|\bENAMETOOLONG\b|filename, directory name, or volume label syntax is incorrect|No free output name/i,
    code: 'outputPathInvalid',
  },
  { re: /already exists/i, code: 'outputExists' },
  { re: /no such file or directory|\bENOENT\b|cannot find the (file|path) specified|system cannot find/i, code: (job, msg) => missingWhat(job, msg) },
  {
    re: /unknown encoder|encoder ['"]?[\w-]+['"]? (was )?not found|encoder not found|no such filter|unrecognized option|option not found|not compiled in|was disabled at compile/i,
    code: 'encoderUnavailable',
  },
  { re: HW, code: 'gpuEncoderFailed' },
  { re: /no video stream|needs a video source|stream map '?0:V[^']*'? matches no streams/i, code: 'noVideoStream' },
  { re: /no audio stream|stream map '?0:a[^']*'? matches no streams/i, code: 'noAudioStream' },
  {
    re: /does not contain any stream/i,
    code: (job) => (job.sourceInfo && !job.sourceInfo.width ? 'noVideoStream' : job.sourceInfo && !job.sourceInfo.hasAudio ? 'noAudioStream' : 'invalidSettings'),
  },
  {
    re: /not divisible by 2|divisible by|pixel format\b.*\b(invalid|not supported)|incompatible pixel format|unsupported pixel format|invalid pixel format|nothing to encode|could not find tag for codec|not currently supported in container|error while opening encoder|incorrect parameters such as|picture size \d+x\d+ is invalid|invalid (frame )?(size|dimensions)|error initializing output stream|frame size .* (too large|not supported)|bitrate .* (too high|too low|invalid)/i,
    code: 'invalidSettings',
  },
  {
    re: /unsupported image format|corrupt header|vipsjpeg|\bvips\b|premature end|(png|jpeg|jpg|webp|tiff|heif|gif|svg)load|input (file|buffer) (contains|has)|could not decode/i,
    code: (job) => (job.kind === 'image' ? 'imageDecodeFailed' : 'sourceUnreadable'),
  },
  {
    re: /invalid data found when processing input|moov atom not found|could not find codec parameters|^cannot read\b|error opening input|unknown format|end of file|header missing|timed out while reading|no audio or video stream found|could not find corresponding|unsupported codec|error while decoding|decoding error|corrupt|truncated|invalid nal|not an? (valid )?(video|media|image)/i,
    code: (job) => (job.kind === 'image' ? 'imageDecodeFailed' : 'sourceUnreadable'),
  },
  { re: /invalid argument|\bEINVAL\b/i, code: (job, msg) => (mentionsOutput(job, msg) ? 'outputPathInvalid' : 'invalidSettings') },
]

function mentionsOutput(job: JobLike, msg: string): boolean {
  if (/\boutput\b/i.test(msg)) return true
  const out = job.outputPath ? fileName(job.outputPath) : ''
  return !!out && msg.toLowerCase().includes(out.toLowerCase())
}

/** A "no such file" error: the source, the watermark image or the output side (by full path, then by file name). */
function missingWhat(job: JobLike, msg: string, path?: string): JobErrorCode {
  const subject = norm(path ?? msg)
  const has = (p: string): boolean => (path ? subject === norm(p) : subject.includes(norm(p)))
  const marks = watermarkPaths(job)
  if (has(job.source)) return 'sourceMissing'
  if (marks.some(has)) return 'watermarkMissing'
  if (job.outputPath && subject.includes(norm(job.outputPath))) return 'outputPathInvalid'
  if (!path) {
    if (marks.some((w) => subject.includes(norm(fileName(w))))) return 'watermarkMissing'
    if (subject.includes(norm(fileName(job.source)))) return 'sourceMissing'
  }
  return mentionsOutput(job, path ?? msg) ? 'outputPathInvalid' : 'sourceMissing'
}

/** Node errno codes (fs, spawn) → kind, before looking at the message. */
function fromErrno(err: NodeJS.ErrnoException & { dest?: string }, job: JobLike): JobErrorCode | null {
  switch (err.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'diskFull'
    case 'EACCES':
    case 'EPERM':
    case 'EBUSY':
    case 'EROFS':
      return 'permissionDenied'
    case 'ENAMETOOLONG':
      return 'outputPathInvalid'
    case 'ENOMEM':
      return 'outOfMemory'
    case 'EEXIST':
      return 'outputExists'
    case 'ENOENT':
      if (err.syscall?.startsWith('spawn')) return 'ffmpegMissing'
      return missingWhat(job, err.message, err.path)
    case 'EINVAL':
      return err.syscall && err.syscall !== 'spawn' ? 'outputPathInvalid' : null
    default:
      return null
  }
}

/** Classify a job failure. `params.name` is the source file name (used by some messages). */
export function classify(err: unknown, job: JobLike): ClassifiedError {
  const params = { name: fileName(job.source) }
  const tagged = err && typeof err === 'object' ? (err as Record<string, unknown>)[TAG] : undefined
  if (typeof tagged === 'string') return { code: tagged as JobErrorCode, params }
  if (err instanceof CopySizeError) return { code: 'copyIncomplete', params }
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string') {
    const code = fromErrno(err as NodeJS.ErrnoException, job)
    if (code) return { code, params }
  }
  const msg = err instanceof Error ? err.message || err.name : String(err ?? '')
  // hardware failures are often only visible in the log tail (the message is ffmpeg's generic last line)
  const tail = err instanceof EncodeError ? err.logTail.join('\n') : ''
  for (const rule of RULES) {
    if (rule.re.test(msg)) return { code: typeof rule.code === 'function' ? rule.code(job, msg) : rule.code, params }
  }
  if (tail) {
    // a hardware encoder failing shows up as its own log lines ([h264_nvenc @ …] OpenEncodeSessionEx failed …)
    if (/\[[\w/:#.]*(nvenc|_qsv|_amf|videotoolbox|vaapi)[^\]]*\]/i.test(tail)) return { code: 'gpuEncoderFailed', params }
    for (const rule of RULES) {
      if (rule.re !== HW && rule.re.test(tail)) return { code: typeof rule.code === 'function' ? rule.code(job, tail) : rule.code, params }
    }
  }
  return { code: 'unknown', params }
}

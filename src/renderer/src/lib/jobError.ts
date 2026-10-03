// Localised text for a failed job (Job.errorCode from main/queue/errors.ts); the raw message stays in the details.
import type { Job, JobErrorCode } from '../../../shared/types'
import { hasMessage, type TFunc } from '../i18n'
import { fileName } from './format'

export interface JobErrorText {
  /** Main message in the UI language. */
  message: string
  /** One line on what to do, when known. */
  hint?: string
  /** The raw technical message (ffmpeg / sharp / Node), when different from `message`. */
  raw?: string
  /** Short form for the status cell: the message, plus the raw text when the kind is unknown. */
  summary: string
}

export function errorCodeMessage(code: JobErrorCode | undefined, params: Record<string, string | number> | undefined, t: TFunc): string | null {
  if (!code || code === 'unknown') return null
  const key = `jobError.${code}`
  return hasMessage(key) ? t(key, params) : null
}

export function jobErrorText(job: Pick<Job, 'kind' | 'source' | 'error' | 'errorCode' | 'errorParams'>, t: TFunc): JobErrorText {
  const raw = job.error?.trim() || undefined
  const code = job.errorCode
  // failed before error codes existed: the raw message is all there is
  if (!code) {
    const message = raw ?? t('job.unknownError')
    return { message, summary: message }
  }
  const known = errorCodeMessage(code, { name: fileName(job.source), ...job.errorParams }, t)
  if (known) {
    const hintKey = `jobErrorHint.${code}`
    return { message: known, hint: hasMessage(hintKey) ? t(hintKey) : undefined, raw, summary: known }
  }
  const message = t(job.kind === 'file' ? 'jobError.unknownFile' : 'jobError.unknown')
  return {
    message,
    hint: raw ? t('jobErrorHint.unknown') : undefined,
    raw,
    summary: raw ? t('jobError.withDetail', { message, detail: raw }) : message,
  }
}

/** Node errno / ffmpeg-missing text inside a raw IPC error → a localised explanation, else null. */
export function friendlyRawError(raw: string, t: TFunc): string | null {
  const code: JobErrorCode | null = /\bENOSPC\b|no space left on device|not enough space on the disk/i.test(raw)
    ? 'diskFull'
    : /\b(EACCES|EPERM|EBUSY)\b|permission denied|operation not permitted|access is denied/i.test(raw)
      ? 'permissionDenied'
      : /\bENAMETOOLONG\b/.test(raw)
        ? 'outputPathInvalid'
        : /\b(ffmpeg|ffprobe) was not found\b/i.test(raw)
          ? 'ffmpegMissing'
          : null
  return code ? errorCodeMessage(code, undefined, t) : null
}

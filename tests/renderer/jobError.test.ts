// Renderer: a failed job's localised message + hint, with the raw message kept for the details view.
import { describe, expect, it } from 'vitest'
import { LOCALES, makeT } from '../../src/renderer/src/i18n'
import { jobErrorsEn } from '../../src/renderer/src/i18n/jobErrors'
import { friendlyRawError, jobErrorText } from '../../src/renderer/src/lib/jobError'
import type { Job, JobErrorCode } from '../../src/shared/types'

const zh = makeT('zh-TW')
const base: Pick<Job, 'kind' | 'source' | 'error'> = { kind: 'video', source: 'C:\\影片\\壞掉的 clip.mp4', error: 'Invalid data found when processing input' }

describe('job error text', () => {
  it('known codes: localised message with the file name, a hint, and the raw message for the details', () => {
    const e = jobErrorText({ ...base, errorCode: 'sourceUnreadable' }, zh)
    expect(e.message).toBe('無法讀取 壞掉的 clip.mp4：檔案已損毀或格式不支援')
    expect(e.summary).toBe(e.message)
    expect(e.hint).toBeTruthy()
    expect(e.raw).toBe('Invalid data found when processing input')
  })

  it('unknown: generic "conversion failed" plus the raw message; file jobs say file operation', () => {
    const e = jobErrorText({ ...base, error: 'boom', errorCode: 'unknown' }, zh)
    expect(e.message).toBe('轉檔失敗')
    expect(e.summary).toBe('轉檔失敗：boom')
    expect(jobErrorText({ ...base, kind: 'file', error: 'boom', errorCode: 'unknown' }, makeT('en')).summary).toBe('File operation failed: boom')
  })

  it('jobs that failed before error codes existed show the raw message as before', () => {
    expect(jobErrorText({ ...base }, zh)).toEqual({ message: base.error, summary: base.error })
    expect(jobErrorText({ ...base, error: undefined }, zh).message).toBe('未知的錯誤')
  })

  it('every code has a message and a hint in every language', () => {
    const codes = Object.keys(jobErrorsEn)
      .filter((k) => k.startsWith('jobErrorHint.'))
      .map((k) => k.slice('jobErrorHint.'.length) as JobErrorCode)
    expect(codes).toHaveLength(17)
    for (const locale of LOCALES) {
      const t = makeT(locale)
      for (const code of codes.filter((c) => c !== 'unknown')) {
        const e = jobErrorText({ ...base, errorCode: code }, t)
        expect(e.message, `${locale} ${code}`).not.toMatch(/jobError|\{name\}/)
        expect(e.hint, `${locale} ${code}`).toBeTruthy()
      }
    }
  })

  it('raw IPC errors with a Node errno get an explanation', () => {
    expect(friendlyRawError("EACCES: permission denied, open 'C:\\x'", zh)).toBe('沒有讀寫這個檔案的權限')
    expect(friendlyRawError('ENOSPC: no space left on device, write', zh)).toBe('磁碟空間不足')
    expect(friendlyRawError('Unknown preset', zh)).toBeNull()
  })
})

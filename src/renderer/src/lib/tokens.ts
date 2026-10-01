// Labels for the file-name template tokens (shared by Settings → Output, the job editor and the batch rename dialog).
import type { NAME_TOKENS } from '../../../shared/naming'
import type { MessageKey } from '../i18n'

export type NameToken = (typeof NAME_TOKENS)[number]

/** Short chip label. */
export const TOKEN_LABEL: Record<NameToken, MessageKey> = {
  '{name}': 'settings.tokenName',
  '{ext}': 'settings.tokenExt',
  '{preset}': 'settings.tokenPreset',
  '{date}': 'settings.tokenDate',
  '{time}': 'settings.tokenTime',
  '{counter}': 'settings.tokenCounter',
  '{counter:3}': 'settings.tokenCounter3',
  '{width}': 'settings.tokenWidth',
  '{height}': 'settings.tokenHeight',
  '{parent}': 'settings.tokenParent',
  '{exifdate}': 'tokens.exifdate',
  '{exiftime}': 'tokens.exiftime',
  '{mdate}': 'tokens.mdate',
}

/** Longer explanation for the tooltip (falls back to the label). */
export const TOKEN_TITLE: Partial<Record<NameToken, MessageKey>> = {
  '{date}': 'tokens.dateHint',
  '{time}': 'tokens.timeHint',
  '{exifdate}': 'tokens.exifdateHint',
  '{exiftime}': 'tokens.exiftimeHint',
  '{mdate}': 'tokens.mdateHint',
  '{counter}': 'tokens.counterHint',
  '{counter:3}': 'tokens.counterHint',
}

/** Insert `token` at the caret of `input` (or at the end), adding "_" after a preceding tag. Returns the new text and caret. */
export function insertToken(text: string, token: string, input: HTMLInputElement | null): { text: string; caret: number } {
  const active = !!input && document.activeElement === input
  const start = active ? (input.selectionStart ?? text.length) : text.length
  const end = active ? (input.selectionEnd ?? text.length) : text.length
  const ins = start > 0 && text[start - 1] === '}' ? `_${token}` : token
  return { text: text.slice(0, start) + ins + text.slice(end), caret: start + ins.length }
}

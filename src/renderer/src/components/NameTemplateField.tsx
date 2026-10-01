// File-name template input with clickable token chips (used by the batch rename dialog and the file-job editor).
import { useRef } from 'react'
import { useT } from '../store'
import { TOKEN_LABEL, TOKEN_TITLE, insertToken, type NameToken } from '../lib/tokens'
import { TextInput, cx } from './ui'

export function NameTemplateField({
  value,
  onChange,
  tokens,
  disabled,
  ariaLabel,
  placeholder = '{name}',
  className,
}: {
  value: string
  onChange: (v: string) => void
  tokens: readonly NameToken[]
  disabled?: boolean
  ariaLabel: string
  placeholder?: string
  className?: string
}) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)

  const insert = (token: string): void => {
    const el = inputRef.current
    const r = insertToken(value, token, el)
    onChange(r.text)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(r.caret, r.caret)
    })
  }

  return (
    <div className={cx('ntf', className)}>
      <TextInput ref={inputRef} value={value} onChange={onChange} disabled={disabled} aria-label={ariaLabel} placeholder={placeholder} className="ntf-input mono" />
      <div className="ntf-tokens" role="group" aria-label={t('settings.tokens')}>
        {tokens.map((tok) => {
          const label = t(TOKEN_LABEL[tok])
          const title = TOKEN_TITLE[tok] ? t(TOKEN_TITLE[tok]!) : label
          return (
            <button
              key={tok}
              type="button"
              className="ntf-token"
              disabled={disabled}
              title={`${tok} — ${title}`}
              onMouseDown={(e) => e.preventDefault() /* keep the caret in the input */}
              onClick={() => insert(tok)}
            >
              <code>{tok}</code>
              <span>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

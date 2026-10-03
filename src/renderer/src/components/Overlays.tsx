// Toast stack, confirm/prompt dialog host, and the whole-window file drop overlay.
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Info, Upload, X } from 'lucide-react'
import { closeDialog, dismissToast, useStore, useT } from '../store'
import { Button, Modal, TextInput, cx } from './ui'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const t = useT()
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label={t('common.notifications')}>
      {toasts.map((x) => (
        <div key={x.id} className={cx('toast', `toast-${x.kind}`)} role={x.kind === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon">
            {x.kind === 'error' ? <CircleAlert size={16} aria-hidden /> : x.kind === 'success' ? <CircleCheck size={16} aria-hidden /> : <Info size={16} aria-hidden />}
          </span>
          <div className="toast-body">
            <div className="toast-text">{x.text}</div>
            {x.detail && <div className="toast-detail">{x.detail}</div>}
          </div>
          {x.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(x.id)
                x.action!.run()
              }}
            >
              {x.action.label}
            </button>
          )}
          <button type="button" className="toast-close" onClick={() => dismissToast(x.id)} aria-label={t('common.close')} title={t('common.close')}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}

export function DialogHost() {
  const d = useStore((s) => s.dialog)
  const t = useT()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (d?.kind === 'prompt') {
      setValue(d.value ?? '')
      setTimeout(() => inputRef.current?.select(), 30)
    }
  }, [d])
  if (!d) return null
  const submit = (): void => {
    if (d.kind === 'prompt') {
      if (value.trim()) closeDialog(value.trim())
    } else closeDialog(true)
  }
  return (
    <Modal
      title={d.title}
      size="sm"
      onClose={() => closeDialog(d.kind === 'prompt' ? null : false)}
      footer={
        <>
          <Button onClick={() => closeDialog(d.kind === 'prompt' ? null : false)}>{d.cancelLabel ?? t('common.cancel')}</Button>
          <Button variant={d.danger ? 'danger' : 'primary'} onClick={submit} data-autofocus={d.kind === 'confirm' ? true : undefined} disabled={d.kind === 'prompt' && !value.trim()}>
            {d.confirmLabel ?? t('common.ok')}
          </Button>
        </>
      }
    >
      {d.message && <p className="dialog-message">{d.message}</p>}
      {d.kind === 'prompt' && (
        <label className="dialog-field">
          {d.label && <span>{d.label}</span>}
          <TextInput
            ref={inputRef}
            value={value}
            onChange={setValue}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
        </label>
      )}
    </Modal>
  )
}

export function DropOverlay({ visible }: { visible: boolean }) {
  const t = useT()
  // drops on the batch rename tab go into its file list (see App's useWindowFileDrop), everywhere else into the queue
  const fileOps = useStore((s) => s.view === 'batch')
  if (!visible) return null
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay-inner">
        <div className="drop-card">
          <span className="drop-icon">
            <Upload size={28} />
          </span>
          <div className="drop-overlay-title">{fileOps ? t('fileops.dropRelease') : t('queue.dropRelease')}</div>
          <div className="drop-overlay-sub">{fileOps ? t('fileops.dropTypes') : t('queue.dropTypes')}</div>
        </div>
      </div>
    </div>
  )
}

// Settings → Adobe integration: install / update / uninstall the "Send to Media Converter" panel for Premiere Pro and
// After Effects (a signed CEP extension copied into the per-user extensions folder), and open the bridge folder.
import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleArrowDown, CircleCheck, Download, FolderOpen, FolderSync, Info, Puzzle, RotateCw, Trash2 } from 'lucide-react'
import type { AdobePanelStatus } from '../../../../shared/types'
import { api } from '../../api'
import { panelStatusView } from '../../lib/adobe'
import { joinPath } from '../../lib/format'
import { confirmDialog, guard, toast, tNow, useStore, useT } from '../../store'
import { Button, Spinner, cx } from '../../components/ui'
import { InfoLine, SettingGroup } from './parts'

export function AdobeTab() {
  const t = useT()
  const info = useStore((s) => s.appInfo)
  const [status, setStatus] = useState<AdobePanelStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'uninstall' | null>(null)

  const refresh = useCallback(async () => {
    const s = await guard(() => api.getAdobePanelStatus())
    if (s) setStatus(s)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = async (): Promise<void> => {
    setBusy('install')
    try {
      const s = await guard(() => api.installAdobePanel(), 'adobe.installFailed')
      if (s) {
        setStatus(s)
        toast('success', tNow('adobe.installed'))
      }
    } finally {
      setBusy(null)
    }
  }

  const uninstall = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: tNow('adobe.uninstallConfirmTitle'),
      message: tNow('adobe.uninstallConfirmMessage'),
      confirmLabel: tNow('adobe.uninstall'),
      danger: true,
    })
    if (!ok) return
    setBusy('uninstall')
    try {
      const s = await guard(() => api.uninstallAdobePanel(), 'adobe.uninstallFailed')
      if (s) {
        setStatus(s)
        toast('success', tNow('adobe.uninstalled'))
      }
    } finally {
      setBusy(null)
    }
  }

  const view = panelStatusView(status, t)
  const Icon = view.tone === 'ok' ? CircleCheck : view.tone === 'warn' ? CircleAlert : view.tone === 'accent' ? CircleArrowDown : Info
  const primaryLabel = view.primary === 'install' ? t('adobe.install') : view.primary === 'update' ? t('adobe.update') : t('adobe.reinstall')
  const bridgeDir = info?.userDataDir ? joinPath(info.userDataDir, 'bridge') : null

  return (
    <>
      <SettingGroup title={t('adobe.groupPanel')} icon={Puzzle}>
        <p className="st-note">{t('adobe.intro')}</p>
        <p className="st-note">{t('adobe.openHow')}</p>
        <div className="st-update">
          <div className={cx('st-update-status', view.tone)} role="status" aria-live="polite">
            {!status ? <Spinner size={14} /> : <Icon size={14} aria-hidden />}
            <div>{view.text}</div>
          </div>
          <div className="st-update-actions">
            {view.primary && (
              <Button
                size="sm"
                variant={view.primary === 'reinstall' ? 'default' : 'primary'}
                icon={view.primary === 'reinstall' ? RotateCw : Download}
                busy={busy === 'install'}
                disabled={!!busy}
                onClick={() => void install()}
              >
                {primaryLabel}
              </Button>
            )}
            {view.canUninstall && (
              <Button size="sm" icon={Trash2} busy={busy === 'uninstall'} disabled={!!busy} onClick={() => void uninstall()}>
                {t('adobe.uninstall')}
              </Button>
            )}
          </div>
        </div>
        {status && (
          <div className="st-info-list">
            <InfoLine label={t('adobe.installPath')} mono>
              <span className="st-ellipsis" title={status.path}>
                {status.path}
              </span>
            </InfoLine>
          </div>
        )}
        <p className="st-note">{t('adobe.restartNote')}</p>
      </SettingGroup>

      <SettingGroup title={t('adobe.groupBridge')} icon={FolderSync}>
        <div className="st-path">
          <span className={cx('st-path-text mono', !bridgeDir && 'muted')} title={bridgeDir ?? undefined}>
            {bridgeDir ?? '—'}
          </span>
          <Button size="sm" icon={FolderOpen} onClick={() => void guard(() => api.openBridgeFolder())}>
            {t('adobe.openBridgeFolder')}
          </Button>
        </div>
        <p className="st-note">{t('adobe.bridgeDesc')}</p>
      </SettingGroup>
    </>
  )
}

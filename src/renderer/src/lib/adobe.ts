// Adobe integration: status text for Settings → Adobe integration, and the toast for requests from the panel.
import type { AdobePanelStatus, BridgeRequestEvent } from '../../../shared/types'
import type { TFunc } from '../i18n'

/** "Premiere Pro" / "After Effects" / a generic name for anything else the panel reports as its host. */
export function bridgeHostLabel(host: string, t: TFunc): string {
  const h = host.toLowerCase().replace(/[^a-z]/g, '')
  if (h === 'premiere' || h === 'premierepro' || h === 'ppro') return 'Premiere Pro'
  if (h === 'aftereffects' || h === 'aeft' || h === 'ae') return 'After Effects'
  return t('bridge.hostOther')
}

export interface PanelStatusView {
  text: string
  tone: '' | 'ok' | 'accent' | 'warn'
  /** The main button: install (not installed), update (other version bundled), reinstall (same version), or none. */
  primary: 'install' | 'update' | 'reinstall' | null
  canUninstall: boolean
}

export function panelStatusView(s: AdobePanelStatus | null, t: TFunc): PanelStatusView {
  if (!s) return { text: t('adobe.statusChecking'), tone: '', primary: null, canUninstall: false }
  const installedText = (): string => t('adobe.statusInstalled', { v: s.installedVersion ?? '—' })
  if (!s.bundled) {
    return s.installed
      ? { text: installedText(), tone: 'ok', primary: null, canUninstall: true }
      : { text: t('adobe.statusNotBundled'), tone: 'warn', primary: null, canUninstall: false }
  }
  if (!s.installed) return { text: t('adobe.statusNotInstalled'), tone: '', primary: 'install', canUninstall: false }
  if (s.bundledVersion && s.installedVersion !== s.bundledVersion) {
    return {
      text: t('adobe.statusUpdate', { installed: s.installedVersion ?? '—', bundled: s.bundledVersion }),
      tone: 'accent',
      primary: 'update',
      canUninstall: true,
    }
  }
  return { text: installedText(), tone: 'ok', primary: 'reinstall', canUninstall: true }
}

/** Toast for a handled panel request: [kind, title, detail]. */
export function bridgeToast(e: BridgeRequestEvent, t: TFunc): { kind: 'success' | 'info' | 'error'; text: string; detail?: string } {
  const host = bridgeHostLabel(e.host, t)
  const shown = e.errors.slice(0, 4)
  const detail = shown.length ? shown.join('\n') + (e.errors.length > shown.length ? '\n…' : '') : undefined
  if (e.status === 'accepted') {
    return { kind: e.errors.length ? 'info' : 'success', text: t('bridge.received', { n: e.jobCount, host }), detail }
  }
  return { kind: 'error', text: t('bridge.rejected', { host }), detail }
}

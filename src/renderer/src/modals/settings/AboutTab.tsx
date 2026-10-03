// Settings → About: app version, updates, runtime / library versions, data folder, licences.
import { CircleAlert, CircleArrowDown, CircleCheck, Clapperboard, ExternalLink, FolderCog, Image as ImageIcon, Info, RefreshCw, RotateCw, Scale } from 'lucide-react'
import type { UpdateState } from '../../../../shared/api'
import { api } from '../../api'
import { LOCALE_HTML_LANG, type TFunc } from '../../i18n'
import { guard, saveSettings, useLocale, useStore, useT } from '../../store'
import { checkForUpdatesNow, installUpdateNow, openReleasePage, updateErrorKey, useUpdates } from '../../updates'
import { Button, Spinner, Switch, cx } from '../../components/ui'
import { InfoLine, SettingGroup, SettingRow } from './parts'

const PLATFORM: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export function AboutTab() {
  const t = useT()
  const info = useStore((s) => s.appInfo)
  const caps = useStore((s) => s.caps)
  const ffmpegVersion = caps?.ffmpegVersion ? caps.ffmpegVersion.split(/\s/)[0] : '—'

  return (
    <>
      <div className="st-about-hero">
        <span className="st-app-icon" aria-hidden>
          <Clapperboard size={22} />
          <ImageIcon size={14} className="st-app-icon-sub" />
        </span>
        <div className="st-about-titles">
          <h3>{info?.name ?? 'Media Converter'}</h3>
          <div className="st-about-version">
            {t('settings.version', { v: info?.version ?? '—' })}
            {info && (
              <span className="st-about-platform">
                {PLATFORM[info.platform] ?? info.platform} · {info.arch}
              </span>
            )}
          </div>
          <p>{t('settings.aboutTagline')}</p>
        </div>
      </div>

      <UpdatesGroup />

      <SettingGroup title={t('settings.groupComponents')} icon={Info}>
        <div className="st-info-list">
          <InfoLine label="Electron" mono>
            {info?.electronVersion ?? '—'}
          </InfoLine>
          <InfoLine label="FFmpeg" mono>
            {ffmpegVersion}
          </InfoLine>
          <InfoLine label="sharp" mono>
            {info?.sharpVersion ?? '—'}
          </InfoLine>
          <InfoLine label="libvips" mono>
            {info?.libvipsVersion ?? '—'}
          </InfoLine>
        </div>
      </SettingGroup>

      {info?.userDataDir && (
        <SettingGroup title={t('settings.groupData')} icon={FolderCog}>
          <div className="st-path">
            <span className="st-path-text mono" title={info.userDataDir}>
              {info.userDataDir}
            </span>
            <Button size="sm" icon={ExternalLink} onClick={() => void guard(() => api.openPath(info.userDataDir))}>
              {t('settings.openFolder')}
            </Button>
          </div>
          <p className="st-note">{t('settings.dataDesc')}</p>
        </SettingGroup>
      )}

      <SettingGroup title={t('settings.groupLicenses')} icon={Scale}>
        <div className="st-licenses">
          <p>{t('settings.licenseApp')}</p>
          <p>{t('settings.licenseFfmpeg')}</p>
          <p>{t('settings.licenseVips')}</p>
          <p className="st-note">{t('settings.licenseNotices')}</p>
        </div>
      </SettingGroup>
    </>
  )
}

function updateStatusText(t: TFunc, s: UpdateState | null): { text: string; tone: '' | 'ok' | 'accent' | 'warn' } {
  if (!s) return { text: '—', tone: '' }
  const v = s.version ?? ''
  switch (s.status) {
    case 'disabled':
      return { text: t('update.disabled'), tone: '' }
    case 'checking':
      return { text: t('update.checking'), tone: '' }
    case 'available':
      return {
        text: t(s.mode === 'auto' ? 'update.availableAuto' : s.mode === 'portable' ? 'update.availablePortable' : 'update.availableManual', { v }),
        tone: 'accent',
      }
    case 'downloading':
      return { text: t('update.downloading', { v, p: Math.floor(s.percent ?? 0) }), tone: 'accent' }
    case 'downloaded':
      return { text: t('update.downloaded', { v }), tone: 'accent' }
    case 'not-available':
      return { text: t('update.upToDate'), tone: 'ok' }
    case 'error':
      return { text: t(updateErrorKey(s.error?.kind)), tone: 'warn' }
    default:
      return { text: t('update.never'), tone: '' }
  }
}

/** Status line + "Check for updates", restart / download actions, and the automatic-check switch. */
function UpdatesGroup() {
  const t = useT()
  const locale = useLocale()
  const s = useUpdates((x) => x.state)
  const checking = useUpdates((x) => x.checking)
  const autoCheck = useStore((x) => x.settings.autoCheckUpdates)
  const busy = checking || s?.status === 'checking'
  const { text, tone } = updateStatusText(t, s)
  const Icon = tone === 'ok' ? CircleCheck : tone === 'warn' ? CircleAlert : tone === 'accent' ? CircleArrowDown : Info
  const lastChecked =
    s?.lastCheckedAt && !busy
      ? new Date(s.lastCheckedAt).toLocaleString(LOCALE_HTML_LANG[locale], { dateStyle: 'medium', timeStyle: 'short' })
      : null
  const mode = s?.mode
  const canCheck = !!s && mode !== 'disabled' && s.status !== 'downloading' && s.status !== 'downloaded'

  return (
    <SettingGroup title={t('update.group')} icon={RefreshCw}>
      <div className="st-update">
        <div className={cx('st-update-status', tone)} role="status" aria-live="polite">
          {busy ? <Spinner size={14} /> : <Icon size={14} aria-hidden />}
          <div>
            <div>{text}</div>
            {lastChecked && <div className="st-update-sub">{t('update.lastChecked', { time: lastChecked })}</div>}
          </div>
        </div>
        <div className="st-update-actions">
          {s?.status === 'downloaded' && (
            <Button size="sm" variant="primary" icon={RotateCw} onClick={() => void installUpdateNow()}>
              {t('update.restartNow')}
            </Button>
          )}
          {s?.status === 'available' && mode !== 'auto' && (
            <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => void openReleasePage()}>
              {t('update.download')}
            </Button>
          )}
          {(s?.status === 'downloading' || s?.status === 'downloaded') && (
            <Button size="sm" icon={ExternalLink} onClick={() => void openReleasePage()}>
              {t('update.releaseNotes')}
            </Button>
          )}
          <Button size="sm" icon={RefreshCw} busy={busy} disabled={!canCheck || busy} onClick={() => void checkForUpdatesNow()}>
            {t('update.check')}
          </Button>
        </div>
      </div>
      {mode && mode !== 'disabled' && (
        <p className="st-note">{t(mode === 'auto' ? 'update.modeAuto' : mode === 'portable' ? 'update.modePortable' : 'update.modeManual')}</p>
      )}
      <SettingRow title={t('update.autoCheck')} desc={t('update.autoCheckDesc')}>
        <Switch checked={autoCheck !== false} onChange={(autoCheckUpdates) => void saveSettings({ autoCheckUpdates })} title={t('update.autoCheck')} />
      </SettingRow>
    </SettingGroup>
  )
}

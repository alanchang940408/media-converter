// Settings → About: app version, runtime / library versions, data folder, licences.
import { Clapperboard, ExternalLink, FolderCog, Image as ImageIcon, Info, Scale } from 'lucide-react'
import { api } from '../../api'
import { guard, useStore, useT } from '../../store'
import { Button } from '../../components/ui'
import { InfoLine, SettingGroup } from './parts'

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

// Settings → General: language, theme, queue behaviour, system.
import { Bell, ListChecks, Monitor, Moon, Palette, Sun } from 'lucide-react'
import type { AppSettings } from '../../../../shared/types'
import { saveSettings, useStore, useT } from '../../store'
import { LOCALES, LOCALE_NATIVE_NAMES } from '../../i18n'
import { Segmented, Select, Switch } from '../../components/ui'
import { SettingGroup, SettingRow } from './parts'

export function GeneralTab() {
  const t = useT()
  const s = useStore((st) => st.settings)
  const sysLocale = useStore((st) => st.appInfo?.locale ?? 'zh-TW')

  return (
    <>
      <SettingGroup title={t('settings.groupAppearance')} icon={Palette}>
        <SettingRow title={t('settings.language')} desc={t('settings.languageDesc')}>
          <Select value={s.language} onChange={(v) => void saveSettings({ language: v as AppSettings['language'] })} aria-label={t('settings.language')} className="st-select">
            <option value="auto">{t('settings.languageAuto', { name: LOCALE_NATIVE_NAMES[sysLocale] })}</option>
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_NATIVE_NAMES[l]}
              </option>
            ))}
          </Select>
        </SettingRow>
        <SettingRow title={t('settings.theme')} desc={t('settings.themeDesc')}>
          <Segmented<AppSettings['theme']>
            value={s.theme}
            onChange={(theme) => void saveSettings({ theme })}
            ariaLabel={t('settings.theme')}
            options={[
              { value: 'dark', label: t('settings.themeDark'), icon: Moon },
              { value: 'light', label: t('settings.themeLight'), icon: Sun },
              { value: 'system', label: t('settings.themeSystem'), icon: Monitor },
            ]}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.groupQueue')} icon={ListChecks}>
        <SettingRow title={t('settings.autoStart')} desc={t('settings.autoStartDesc')}>
          <Switch checked={s.autoStart} onChange={(autoStart) => void saveSettings({ autoStart })} title={t('settings.autoStart')} />
        </SettingRow>
        <SettingRow title={t('settings.removeFinished')} desc={t('settings.removeFinishedDesc')}>
          <Switch checked={s.removeFinished} onChange={(removeFinished) => void saveSettings({ removeFinished })} title={t('settings.removeFinished')} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.groupSystem')} icon={Bell}>
        <SettingRow title={t('settings.notify')} desc={t('settings.notifyDesc')}>
          <Switch checked={s.notifyOnFinish} onChange={(notifyOnFinish) => void saveSettings({ notifyOnFinish })} title={t('settings.notify')} />
        </SettingRow>
        <SettingRow title={t('settings.preventSleep')} desc={t('settings.preventSleepDesc')}>
          <Switch checked={s.preventSleep} onChange={(preventSleep) => void saveSettings({ preventSleep })} title={t('settings.preventSleep')} />
        </SettingRow>
      </SettingGroup>
    </>
  )
}

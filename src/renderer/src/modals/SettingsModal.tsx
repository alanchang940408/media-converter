// Settings modal: vertical tabs (General / Output / Performance / Adobe integration / About) driven by store.settingsTab.
// Every control saves immediately through saveSettings().
import type { KeyboardEvent } from 'react'
import { Cpu, FolderOutput, Info, Puzzle, Settings, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { openSettings, useStore, useT, type SettingsTab } from '../store'
import type { MessageKey } from '../i18n'
import { Button, Modal, cx } from '../components/ui'
import { GeneralTab } from './settings/GeneralTab'
import { OutputTab } from './settings/OutputTab'
import { PerformanceTab } from './settings/PerformanceTab'
import { AboutTab } from './settings/AboutTab'
import { AdobeTab } from './settings/AdobeTab'

const TABS: { id: SettingsTab; icon: LucideIcon; label: MessageKey }[] = [
  { id: 'general', icon: SlidersHorizontal, label: 'settings.tabGeneral' },
  { id: 'output', icon: FolderOutput, label: 'settings.tabOutput' },
  { id: 'performance', icon: Cpu, label: 'settings.tabPerformance' },
  { id: 'adobe', icon: Puzzle, label: 'settings.tabAdobe' },
  { id: 'about', icon: Info, label: 'settings.tabAbout' },
]

const close = (): void => useStore.setState({ settingsTab: null })

export function SettingsModal() {
  const tab = useStore((s) => s.settingsTab)
  const t = useT()
  if (!tab) return null

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const i = TABS.findIndex((x) => x.id === tab)
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + TABS.length) % TABS.length
    openSettings(TABS[n].id)
    requestAnimationFrame(() => document.getElementById(`st-tab-${TABS[n].id}`)?.focus())
  }

  return (
    <Modal
      title={t('settings.title')}
      icon={Settings}
      onClose={close}
      size="lg"
      className="settings-modal"
      bodyClassName="st-body"
      footer={
        <>
          <span className="st-foot-note">{t('settings.autoSaved')}</span>
          <Button variant="primary" onClick={close}>
            {t('settings.done')}
          </Button>
        </>
      }
    >
      <div className="st-nav" role="tablist" aria-orientation="vertical" aria-label={t('settings.title')} onKeyDown={onNavKey}>
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            id={`st-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls="st-panel"
            tabIndex={tab === id ? 0 : -1}
            className={cx('st-tab', tab === id && 'active')}
            onClick={() => openSettings(id)}
          >
            <Icon size={15} aria-hidden />
            <span>{t(label)}</span>
          </button>
        ))}
      </div>
      <div className="st-panel" id="st-panel" role="tabpanel" aria-labelledby={`st-tab-${tab}`} key={tab}>
        {tab === 'general' && <GeneralTab />}
        {tab === 'output' && <OutputTab />}
        {tab === 'performance' && <PerformanceTab />}
        {tab === 'adobe' && <AdobeTab />}
        {tab === 'about' && <AboutTab />}
      </div>
    </Modal>
  )
}

// Settings → Output: default folder, file-name template (token chips + live example), conflict policy.
import { useEffect, useRef, useState } from 'react'
import { FileType, FolderOpen, FolderOutput, RotateCcw, ShieldAlert } from 'lucide-react'
import type { ConflictPolicy } from '../../../../shared/types'
import { NAME_TOKENS, renderNameTemplate } from '../../../../shared/naming'
import { api } from '../../api'
import { guard, saveSettings, tNow, useLocale, useStore, useT } from '../../store'
import type { MessageKey } from '../../i18n'
import { presetName } from '../../lib/presets'
import { Button, Segmented, TextInput, cx } from '../../components/ui'
import { SettingGroup, SettingRow } from './parts'

const DEFAULT_TEMPLATE = '{name}'
const TOKEN_HINT: Record<(typeof NAME_TOKENS)[number], MessageKey> = {
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
}
const CONFLICTS: ConflictPolicy[] = ['rename', 'overwrite', 'skip']

export function OutputTab() {
  const t = useT()
  const s = useStore((st) => st.settings)

  const pickDefault = async (): Promise<void> => {
    const dir = await guard(() => api.pickFolder(tNow('settings.pickOutputTitle')))
    if (dir) await saveSettings({ defaultOutputDir: dir })
  }

  return (
    <>
      <SettingGroup title={t('settings.groupLocation')} icon={FolderOutput}>
        <SettingRow title={t('settings.defaultOutput')} desc={t('settings.defaultOutputDesc')} stacked>
          <div className="st-stack">
            <Segmented<'source' | 'folder'>
              value={s.defaultOutputDir ? 'folder' : 'source'}
              onChange={(v) => (v === 'source' ? void saveSettings({ defaultOutputDir: null }) : void pickDefault())}
              ariaLabel={t('settings.defaultOutput')}
              options={[
                { value: 'source', label: t('settings.outputSame') },
                { value: 'folder', label: t('settings.outputFolder') },
              ]}
            />
            {s.defaultOutputDir && (
              <div className="st-path">
                <FolderOpen size={14} aria-hidden />
                <span className="st-path-text" title={s.defaultOutputDir}>
                  {s.defaultOutputDir}
                </span>
                <Button size="sm" onClick={() => void pickDefault()}>
                  {t('settings.change')}
                </Button>
              </div>
            )}
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('settings.groupNaming')} icon={FileType}>
        <NameTemplateEditor />
      </SettingGroup>

      <SettingGroup title={t('settings.groupConflict')} icon={ShieldAlert}>
        <SettingRow title={t('settings.conflict')} desc={t('settings.conflictDesc')} stacked>
          <div className="st-radios" role="radiogroup" aria-label={t('settings.conflict')}>
            {CONFLICTS.map((c) => (
              <label key={c} className={cx('st-radio', s.conflict === c && 'active')}>
                <input type="radio" name="st-conflict" value={c} checked={s.conflict === c} onChange={() => void saveSettings({ conflict: c })} />
                <span className="st-radio-dot" aria-hidden />
                <span className="st-radio-text">
                  <span className="st-radio-title">{t(`settings.conflict_${c}` as MessageKey)}</span>
                  <span className="st-radio-desc">{t(`settings.conflict_${c}Desc` as MessageKey)}</span>
                </span>
              </label>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function NameTemplateEditor() {
  const t = useT()
  const locale = useLocale()
  const saved = useStore((st) => st.settings.defaultNameTemplate)
  const lastVideo = useStore((st) => st.presets.find((p) => p.id === st.settings.lastVideoPresetId) ?? st.presets.find((p) => p.kind === 'video'))
  const [tpl, setTpl] = useState(saved)
  const inputRef = useRef<HTMLInputElement>(null)
  const focused = useRef(false)

  // follow external changes while the field is not being edited
  useEffect(() => {
    if (!focused.current) setTpl(saved)
  }, [saved])

  // save shortly after typing stops
  useEffect(() => {
    const v = tpl.trim()
    if (!v || v === saved) return
    const id = setTimeout(() => void saveSettings({ defaultNameTemplate: v }), 500)
    return () => clearTimeout(id)
  }, [tpl, saved])

  const commit = (): void => {
    const v = tpl.trim() || DEFAULT_TEMPLATE
    setTpl(v)
    if (v !== saved) void saveSettings({ defaultNameTemplate: v })
  }

  const insert = (token: string): void => {
    const el = inputRef.current
    const active = !!el && document.activeElement === el
    const start = active ? (el.selectionStart ?? tpl.length) : tpl.length
    const end = active ? (el.selectionEnd ?? tpl.length) : tpl.length
    // right after another tag, add a separator so "{name}{date}" does not run together
    const text = start > 0 && tpl[start - 1] === '}' ? `_${token}` : token
    const next = tpl.slice(0, start) + text + tpl.slice(end)
    setTpl(next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
    })
  }

  const example =
    renderNameTemplate(tpl, {
      name: t('settings.sampleName'),
      ext: 'mov',
      preset: lastVideo ? presetName(lastVideo, locale) : 'H.264 1080p',
      parent: t('settings.sampleParent'),
      width: 1920,
      height: 1080,
      counter: 1,
      now: new Date(),
    }) + '.mp4'

  return (
    <SettingRow title={t('settings.nameTemplate')} desc={t('settings.nameTemplateDesc')} stacked>
      <div className="st-stack">
        <div className="st-template-row">
          <TextInput
            ref={inputRef}
            value={tpl}
            onChange={setTpl}
            onFocus={() => (focused.current = true)}
            onBlur={() => {
              focused.current = false
              commit()
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            className="st-template-input mono"
            aria-label={t('settings.nameTemplate')}
            placeholder={DEFAULT_TEMPLATE}
          />
          <Button
            variant="ghost"
            icon={RotateCcw}
            disabled={tpl === DEFAULT_TEMPLATE}
            onClick={() => {
              setTpl(DEFAULT_TEMPLATE)
              void saveSettings({ defaultNameTemplate: DEFAULT_TEMPLATE })
            }}
            title={t('settings.resetTemplate')}
          >
            {t('settings.reset')}
          </Button>
        </div>
        <div className="st-tokens" aria-label={t('settings.tokens')}>
          <span className="st-tokens-label">{t('settings.tokens')}</span>
          {NAME_TOKENS.map((tok) => (
            <button
              key={tok}
              type="button"
              className="st-token"
              title={t(TOKEN_HINT[tok])}
              onMouseDown={(e) => e.preventDefault() /* keep the caret in the input */}
              onClick={() => insert(tok)}
            >
              <code>{tok}</code>
              <span>{t(TOKEN_HINT[tok])}</span>
            </button>
          ))}
        </div>
        <div className="st-example">
          <span className="st-example-label">{t('settings.example')}</span>
          <code className="st-example-value" title={example}>
            {example}
          </code>
        </div>
      </div>
    </SettingRow>
  )
}

// Settings → Performance: concurrency, preferred hardware, detected capabilities, ffmpeg location.
import { CircleAlert, CircleCheck, CircleMinus, Cpu, FolderOpen, Gauge, RefreshCw, RotateCcw, SquareTerminal } from 'lucide-react'
import type { EncoderCapabilities, HwAccel } from '../../../../shared/types'
import { api } from '../../api'
import { guard, refreshCaps, saveSettings, tNow, toast, useStore, useT } from '../../store'
import type { MessageKey } from '../../i18n'
import { Button, Segmented, Select, Slider, Spinner, cx } from '../../components/ui'
import { encoderGroup, encoderLabel, sortEncoders, splitEncoders } from '../../lib/encoders'
import { InfoLine, SettingGroup, SettingRow } from './parts'

const HW_FAMILIES = ['nvenc', 'qsv', 'amf', 'videotoolbox'] as const

export function PerformanceTab() {
  const t = useT()
  const s = useStore((st) => st.settings)
  const caps = useStore((st) => st.caps)
  const loading = useStore((st) => st.capsLoading)

  const setFfmpeg = async (path: string | null): Promise<void> => {
    await saveSettings({ ffmpegPath: path })
    // main re-detects on ffmpegPath change; a non-forced get() picks up that run
    await refreshCaps(false)
    const c = useStore.getState().caps
    if (c?.ffmpegSource === 'missing') toast('error', tNow('settings.ffmpegNotFound'))
    else toast('success', tNow(path ? 'settings.ffmpegCustomSet' : 'settings.ffmpegBundledSet'))
  }

  const pickFfmpeg = async (): Promise<void> => {
    const dir = await guard(() => api.pickFolder(tNow('settings.pickFfmpegTitle')))
    if (dir) await setFfmpeg(dir)
  }

  return (
    <>
      <SettingGroup title={t('settings.groupConcurrency')} icon={Gauge}>
        <SettingRow title={t('settings.videoConcurrency')} desc={t('settings.videoConcurrencyDesc')}>
          <Segmented<number>
            value={s.videoConcurrency}
            onChange={(videoConcurrency) => void saveSettings({ videoConcurrency })}
            ariaLabel={t('settings.videoConcurrency')}
            options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
          />
        </SettingRow>
        <SettingRow title={t('settings.imageConcurrency')} desc={t('settings.imageConcurrencyDesc')}>
          <div className="st-slider">
            <Slider value={s.imageConcurrency} min={1} max={16} step={1} onChange={(imageConcurrency) => void saveSettings({ imageConcurrency })} ariaLabel={t('settings.imageConcurrency')} />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={t('settings.groupHardware')}
        icon={Cpu}
        right={
          <Button size="sm" icon={RefreshCw} busy={loading} disabled={loading} onClick={() => void refreshCaps(true)} title={t('settings.redetectHint')}>
            {loading ? t('settings.detecting') : t('settings.redetect')}
          </Button>
        }
      >
        <SettingRow title={t('settings.preferredHw')} desc={t('settings.preferredHwDesc')}>
          <Select value={s.preferredHw} onChange={(v) => void saveSettings({ preferredHw: v as HwAccel })} aria-label={t('settings.preferredHw')} className="st-select">
            <option value="auto">{t('settings.hwAuto')}</option>
            <option value="none">{t('settings.hwCpu')}</option>
            {HW_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {t(`hw.${f}` as MessageKey)}
                {caps && !caps.hw[f] ? ` — ${t('settings.hwNotDetected')}` : ''}
              </option>
            ))}
          </Select>
        </SettingRow>
        <CapsPanel caps={caps} loading={loading} />
      </SettingGroup>

      <SettingGroup title={t('settings.groupFfmpeg')} icon={SquareTerminal}>
        {caps?.ffmpegSource === 'missing' && (
          <div className="st-alert error">
            <CircleAlert size={14} aria-hidden />
            <span>{t('settings.ffmpegMissing')}</span>
          </div>
        )}
        {caps ? (
          <div className="st-info-list">
            <InfoLine label={t('settings.ffmpegVersion')}>{caps.ffmpegVersion || '—'}</InfoLine>
            <InfoLine label={t('settings.ffmpegSource')}>
              <span className={cx('st-badge', `src-${caps.ffmpegSource}`)}>{t(`settings.source_${caps.ffmpegSource}` as MessageKey)}</span>
            </InfoLine>
            <InfoLine label="ffmpeg" mono>
              <span className="st-ellipsis" title={caps.ffmpegPath}>
                {caps.ffmpegPath || '—'}
              </span>
            </InfoLine>
            <InfoLine label="ffprobe" mono>
              <span className="st-ellipsis" title={caps.ffprobePath}>
                {caps.ffprobePath || '—'}
              </span>
            </InfoLine>
          </div>
        ) : (
          <div className="st-loading">{loading ? <Spinner size={14} /> : null}</div>
        )}
        <SettingRow title={t('settings.customFfmpeg')} desc={t('settings.customFfmpegDesc')} stacked>
          <div className="st-path">
            <FolderOpen size={14} aria-hidden />
            <span className={cx('st-path-text', !s.ffmpegPath && 'muted')} title={s.ffmpegPath ?? undefined}>
              {s.ffmpegPath ?? t('settings.ffmpegUsingBundled')}
            </span>
            <Button size="sm" onClick={() => void pickFfmpeg()}>
              {t('settings.chooseFolder')}
            </Button>
            {s.ffmpegPath && (
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void setFfmpeg(null)} title={t('settings.useBundledHint')}>
                {t('settings.useBundled')}
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  )
}

function CapsPanel({ caps, loading }: { caps: EncoderCapabilities | null; loading: boolean }) {
  const t = useT()
  if (!caps) {
    return (
      <div className="st-caps st-caps-empty">
        {loading ? (
          <>
            <Spinner size={14} /> {t('settings.detecting')}
          </>
        ) : (
          t('settings.capsUnavailable')
        )}
      </div>
    )
  }
  const enc = splitEncoders(caps.compiledEncoders)
  return (
    <div className={cx('st-caps', loading && 'is-loading')}>
      <div className="st-caps-label">{t('settings.gpuFamilies')}</div>
      <div className="st-hw-grid">
        {HW_FAMILIES.map((f) => {
          const ok = caps.hw[f]
          return (
            <div key={f} className={cx('st-hw', ok ? 'ok' : 'off')}>
              {ok ? <CircleCheck size={15} aria-hidden /> : <CircleMinus size={15} aria-hidden />}
              <span className="st-hw-name">{t(`hw.${f}` as MessageKey)}</span>
              <span className="st-hw-state">{ok ? t('settings.hwWorking') : t('settings.hwNotDetected')}</span>
            </div>
          )
        })}
      </div>
      <div className="st-enc">
        <EncoderLine label={t('settings.workingHw')} list={sortEncoders(caps.workingHwEncoders)} empty={t('settings.noneDetected')} highlight />
        <EncoderLine label={t('settings.encVideo')} list={enc.video} empty="—" />
        <EncoderLine label={t('settings.encHw')} list={enc.hw} empty="—" />
        <EncoderLine label={t('settings.encAudio')} list={enc.audio} empty="—" />
      </div>
      <div className="st-caps-foot">{t('settings.compiledCount', { n: caps.compiledEncoders.length })}</div>
    </div>
  )
}

/**
 * One row of encoders: friendly name first, then FFmpeg's encoder name (what a custom FFmpeg must provide).
 * GPU encoders read "HEVC · NVENC" already, so their raw name (hevc_nvenc) is only in the tooltip.
 */
function EncoderLine({ label, list, empty, highlight }: { label: string; list: string[]; empty: string; highlight?: boolean }) {
  return (
    <div className="st-enc-line">
      <span className="st-enc-label">{label}</span>
      <span className="st-codes">
        {list.length ? (
          list.map((e) => {
            const name = encoderLabel(e)
            return (
              <span key={e} className={cx('st-enc-chip', highlight && 'hl')} title={e}>
                {name}
                {name !== e && encoderGroup(e) !== 'hw' && <code>{e}</code>}
              </span>
            )
          })
        ) : (
          <span className="muted">{empty}</span>
        )}
      </span>
    </div>
  )
}

// Video / audio encode settings form (preset editor + job editor).
import { useState } from 'react'
import { AudioLines, Clapperboard, FileVideoCamera, Film, Settings2, Stamp, CircleAlert, TriangleAlert, Frame } from 'lucide-react'
import type {
  EncodeSpeed,
  GifSettings,
  HwAccel,
  MediaInfo,
  OutputContainer,
  RateControl,
  ScaleMode,
  VideoCodecId,
  VideoPresetSettings,
} from '../../../shared/types'
import {
  DNXHR_PROFILES,
  H264_PROFILES,
  HW_CODECS,
  PRORES_PROFILES,
  allowedAudioCodecs,
  allowedVideoCodecs,
  defaultCodecsFor,
  isAudioOnlyContainer,
  validateVideoSettings,
} from '../../../shared/videoRules'
import { useStore, useT } from '../store'
import type { MessageKey } from '../i18n'
import { CONTAINER_LABEL, audioCodecLabel, videoCodecLabel } from '../lib/labels'
import { computeVideoOutputSize } from '../lib/videoSize'
import { Checkbox, NumberInput, Row, Section, Segmented, Select, Slider, cx } from '../components/ui'
import { WatermarkEditor } from './WatermarkEditor'

type V = VideoPresetSettings['video']
type A = VideoPresetSettings['audio']

const VIDEO_CONTAINERS: OutputContainer[] = ['mp4', 'mov', 'mkv', 'webm', 'gif']
const AUDIO_CONTAINERS: OutputContainer[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg']
const RATE_CODECS: VideoCodecId[] = ['h264', 'hevc', 'av1', 'vp9']
const TEN_BIT_CODECS: VideoCodecId[] = ['hevc', 'av1', 'vp9']
const HW_FAMILIES = ['nvenc', 'qsv', 'amf', 'videotoolbox'] as const
const RESOLUTIONS = ['3840x2160', '2560x1440', '1920x1080', '1280x720', '854x480', '1080x1920', '1080x1080', '1080x1350'] as const
const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
const AUDIO_BITRATES = [64, 96, 128, 160, 192, 256, 320]
const SAMPLE_RATES = [22050, 44100, 48000, 96000]
const CRF_MIN = 14
const CRF_MAX = 35
const clampCrf = (n: number): number => Math.min(CRF_MAX, Math.max(CRF_MIN, n))
const DEFAULT_GIF: GifSettings = { fps: 12, width: 480, colors: 256, dither: 'sierra2_4a', loop: 0 }

function fixProfile(codec: VideoCodecId, profile: string | null | undefined): string | null {
  if (codec === 'prores') return profile && (PRORES_PROFILES as readonly string[]).includes(profile) ? profile : 'hq'
  if (codec === 'dnxhr') return profile && (DNXHR_PROFILES as readonly string[]).includes(profile) ? profile : 'hq'
  if (codec === 'h264') return profile && (H264_PROFILES as readonly string[]).includes(profile) ? profile : null
  return null
}

export function VideoSettingsForm({
  value: s,
  onChange,
  sourceInfo,
  disabled,
}: {
  value: VideoPresetSettings
  onChange: (v: VideoPresetSettings) => void
  sourceInfo?: MediaInfo
  disabled?: boolean
}) {
  const t = useT()
  const caps = useStore((st) => st.caps)
  const preferredHw = useStore((st) => st.settings.preferredHw)
  const [customRes, setCustomRes] = useState(false)
  const v = s.video
  const a = s.audio
  const audioOnly = isAudioOnlyContainer(s.container)
  const issues = validateVideoSettings(s)
  const setV = (patch: Partial<V>): void => onChange({ ...s, video: { ...v, ...patch } })
  const setA = (patch: Partial<A>): void => onChange({ ...s, audio: { ...a, ...patch } })

  const setContainer = (c: OutputContainer): void => {
    const d = defaultCodecsFor(c)
    const codec = allowedVideoCodecs(c).includes(v.codec) ? v.codec : d.video
    const acodec = allowedAudioCodecs(c).includes(a.codec) ? a.codec : d.audio
    const video: V = { ...v, codec, profile: fixProfile(codec, v.profile) }
    if (c === 'gif' && !video.gif) video.gif = { ...DEFAULT_GIF }
    if (!TEN_BIT_CODECS.includes(codec)) video.tenBit = false
    onChange({ ...s, container: c, video, audio: { ...a, codec: acodec }, faststart: ['mp4', 'mov', 'm4a'].includes(c) ? s.faststart ?? true : false })
  }

  const setCodec = (codec: VideoCodecId): void =>
    setV({ codec, profile: fixProfile(codec, v.profile), tenBit: TEN_BIT_CODECS.includes(codec) ? v.tenBit : false })

  const setRateMode = (mode: RateControl['mode']): void => {
    const prevKbps = v.rate.mode === 'crf' ? 8000 : v.rate.bitrateKbps
    if (mode === 'crf') setV({ rate: { mode: 'crf', crf: 23 } })
    else if (mode === 'vbr') setV({ rate: { mode: 'vbr', bitrateKbps: prevKbps, maxKbps: Math.round(prevKbps * 1.5) } })
    else setV({ rate: { mode: 'cbr', bitrateKbps: prevKbps } })
  }

  const resKey = v.width == null && v.height == null ? 'source' : (RESOLUTIONS as readonly string[]).includes(`${v.width}x${v.height}`) ? `${v.width}x${v.height}` : 'custom'
  const resSelect = customRes && resKey !== 'source' ? 'custom' : resKey
  const setRes = (k: string): void => {
    if (k === 'custom') {
      setCustomRes(true)
      if (resKey === 'source') setV({ width: sourceInfo?.width ?? 1920, height: sourceInfo?.height ?? 1080 })
      return
    }
    setCustomRes(false)
    if (k === 'source') setV({ width: null, height: null })
    else {
      const [w, h] = k.split('x').map(Number)
      setV({ width: w, height: h })
    }
  }

  const hasHw = (codec: VideoCodecId): boolean => HW_FAMILIES.some((f) => HW_CODECS[f].includes(codec))
  const hwApplicable = hasHw(v.codec)
  const autoHwFamily = caps ? HW_FAMILIES.find((f) => caps.hw[f] && HW_CODECS[f].includes(v.codec)) : undefined
  const outSize = computeVideoOutputSize(sourceInfo, s)
  const rateApplies = RATE_CODECS.includes(v.codec)
  const profiles: readonly string[] | null = v.codec === 'prores' ? PRORES_PROFILES : v.codec === 'dnxhr' ? DNXHR_PROFILES : v.codec === 'h264' ? H264_PROFILES : null
  const lossyAudio = ['aac', 'mp3', 'opus'].includes(a.codec)
  const audioActive = a.codec !== 'none' && a.codec !== 'copy'
  const gif = v.gif ?? DEFAULT_GIF
  const setGif = (patch: Partial<GifSettings>): void => setV({ gif: { ...gif, ...patch } })
  const loopMode = gif.loop === 0 ? 'forever' : gif.loop === -1 ? 'once' : 'count'

  return (
    <div className={cx('vform', disabled && 'is-disabled')}>
      {issues.length > 0 && (
        <div className="issues" role="status">
          {issues.map((i) => (
            <div key={i.code} className={cx('issue', `issue-${i.level}`)}>
              {i.level === 'error' ? <CircleAlert size={14} aria-hidden /> : <TriangleAlert size={14} aria-hidden />}
              <span>{t(`videoIssue.${i.code}` as MessageKey, i.params)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="vform-columns">
        <div className="vform-col">
        <Section title={t('video.format')} icon={FileVideoCamera}>
          <Row label={t('video.container')}>
            <Select value={s.container} onChange={(c) => setContainer(c as OutputContainer)} disabled={disabled} aria-label={t('video.container')}>
              <optgroup label={t('video.videoFormats')}>
                {VIDEO_CONTAINERS.map((c) => (
                  <option key={c} value={c}>
                    {CONTAINER_LABEL[c]}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('video.audioFormats')}>
                {AUDIO_CONTAINERS.map((c) => (
                  <option key={c} value={c}>
                    {CONTAINER_LABEL[c]}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Row>
          {sourceInfo && outSize && sourceInfo.width && (
            <Row label={t('video.outputSize')}>
              <span className="readout">
                {sourceInfo.width}×{sourceInfo.height} <span className="arrow">→</span> <strong>{outSize.width}×{outSize.height}</strong>
              </span>
            </Row>
          )}
          {audioOnly && <p className="note">{t('video.audioOnlyNote')}</p>}
        </Section>

        {!audioOnly && (
          <Section title={t('video.video')} icon={Film}>
            <Row label={t('video.codec')}>
              <Select value={v.codec} onChange={(c) => setCodec(c as VideoCodecId)} disabled={disabled} aria-label={t('video.codec')}>
                {allowedVideoCodecs(s.container).map((c) => (
                  <option key={c} value={c}>
                    {videoCodecLabel(c, t)}
                  </option>
                ))}
              </Select>
            </Row>
            <Row
              label={t('video.hardware')}
              hint={
                !hwApplicable
                  ? t('video.hwSoftwareOnly')
                  : v.hw === 'auto'
                    ? preferredHw === 'none'
                      ? t('video.hwAutoCpuPref')
                      : autoHwFamily
                        ? t('video.hwAutoWill', { name: t(`hw.${autoHwFamily}` as MessageKey) })
                        : t('video.hwAutoNone')
                    : undefined
              }
            >
              <Select value={hwApplicable ? v.hw : 'none'} onChange={(h) => setV({ hw: h as HwAccel })} disabled={disabled || !hwApplicable} aria-label={t('video.hardware')}>
                <option value="auto">{t('hw.auto')}</option>
                <option value="none">{t('hw.none')}</option>
                {HW_FAMILIES.map((f) => {
                  const unavailable = caps ? !caps.hw[f] : false
                  const unsupported = !HW_CODECS[f].includes(v.codec)
                  return (
                    <option key={f} value={f}>
                      {t(`hw.${f}` as MessageKey)}
                      {unavailable ? ` — ${t('video.hwUnavailable')}` : unsupported ? ` — ${t('video.hwNoCodec')}` : ''}
                    </option>
                  )
                })}
              </Select>
            </Row>
            {rateApplies && (
              <>
                <Row label={t('video.quality')}>
                  <Segmented
                    value={v.rate.mode}
                    onChange={setRateMode}
                    disabled={disabled}
                    ariaLabel={t('video.quality')}
                    options={[
                      { value: 'crf', label: t('video.rateCrf'), title: t('video.rateCrfHint') },
                      { value: 'vbr', label: t('video.rateVbr'), title: t('video.rateVbrHint') },
                      { value: 'cbr', label: t('video.rateCbr'), title: t('video.rateCbrHint') },
                    ]}
                  />
                </Row>
                {v.rate.mode === 'crf' && (
                  <Row label={t('video.crf')} hint={t('video.crfHint')}>
                    <Slider
                      // Mirrored so that "more quality" is to the right: position = 49 − CRF (CRF 35 … 14).
                      value={CRF_MIN + CRF_MAX - clampCrf(v.rate.crf)}
                      min={CRF_MIN}
                      max={CRF_MAX}
                      step={1}
                      onChange={(n) => setV({ rate: { mode: 'crf', crf: CRF_MIN + CRF_MAX - n } })}
                      format={(n) => `CRF ${CRF_MIN + CRF_MAX - n}`}
                      disabled={disabled}
                      ariaLabel={t('video.crf')}
                    />
                    <div className="crf-presets" role="group" aria-label={t('video.crf')}>
                      {([
                        [18, t('video.crfLossless')],
                        [23, t('video.crfStandard')],
                        [28, t('video.crfSmall')],
                      ] as const).map(([crf, label]) => (
                        <button
                          key={crf}
                          type="button"
                          className={cx('chip chip-xs', v.rate.mode === 'crf' && v.rate.crf === crf && 'active')}
                          disabled={disabled}
                          aria-pressed={v.rate.mode === 'crf' && v.rate.crf === crf}
                          onClick={() => setV({ rate: { mode: 'crf', crf } })}
                        >
                          <span className="chip-num">{crf}</span>
                          {label}
                        </button>
                      ))}
                    </div>
                  </Row>
                )}
                {v.rate.mode !== 'crf' && (
                  <Row label={t('video.bitrate')} hint={`≈ ${(v.rate.bitrateKbps / 1000).toFixed(1)} Mbps`}>
                    <div className="inline-controls">
                      <NumberInput
                        value={v.rate.bitrateKbps}
                        min={100}
                        max={400000}
                        step={500}
                        integer
                        suffix="kbps"
                        width={130}
                        disabled={disabled}
                        ariaLabel={t('video.bitrate')}
                        onChange={(n) => setV({ rate: { ...v.rate, bitrateKbps: n ?? 8000 } as RateControl })}
                      />
                      {v.rate.mode === 'vbr' && (
                        <>
                          <span className="mini-label">{t('video.maxBitrate')}</span>
                          <NumberInput
                            value={v.rate.maxKbps ?? null}
                            min={100}
                            max={400000}
                            step={500}
                            integer
                            allowEmpty
                            placeholder={t('common.auto')}
                            suffix="kbps"
                            width={130}
                            disabled={disabled}
                            ariaLabel={t('video.maxBitrate')}
                            onChange={(n) => v.rate.mode === 'vbr' && setV({ rate: { ...v.rate, maxKbps: n ?? undefined } })}
                          />
                        </>
                      )}
                    </div>
                  </Row>
                )}
                <Row label={t('video.speed')}>
                  <Segmented<EncodeSpeed>
                    value={v.speed}
                    onChange={(speed) => setV({ speed })}
                    disabled={disabled}
                    ariaLabel={t('video.speed')}
                    options={[
                      { value: 'fast', label: t('video.speedFast') },
                      { value: 'balanced', label: t('video.speedBalanced') },
                      { value: 'quality', label: t('video.speedQuality') },
                    ]}
                  />
                </Row>
              </>
            )}
            {profiles && (
              <Row label={t('video.profile')}>
                <Select value={v.profile ?? ''} onChange={(p) => setV({ profile: p || null })} disabled={disabled} aria-label={t('video.profile')}>
                  {v.codec === 'h264' && <option value="">{t('common.auto')}</option>}
                  {profiles.map((p) => (
                    <option key={p} value={p}>
                      {t(`profile.${v.codec}.${p}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              </Row>
            )}
            {v.codec !== 'copy' && v.codec !== 'gif' && (
              <Row label={t('video.colorDepth')}>
                <Checkbox
                  checked={!!v.tenBit && TEN_BIT_CODECS.includes(v.codec)}
                  onChange={(tenBit) => setV({ tenBit })}
                  disabled={disabled || !TEN_BIT_CODECS.includes(v.codec)}
                  label={t('video.tenBit')}
                  title={TEN_BIT_CODECS.includes(v.codec) ? t('video.tenBitHint') : t('video.tenBitUnavailable')}
                />
              </Row>
            )}
          </Section>
        )}

        <Section title={t('video.options')} icon={Settings2}>
          <Row label="">
            <div className="stack">
              <Checkbox
                checked={!!s.faststart && ['mp4', 'mov', 'm4a'].includes(s.container)}
                onChange={(faststart) => onChange({ ...s, faststart })}
                label={t('video.faststart')}
                title={t('video.faststartHint')}
                disabled={disabled || !['mp4', 'mov', 'm4a'].includes(s.container)}
              />
              <Checkbox checked={!!s.stripMetadata} onChange={(stripMetadata) => onChange({ ...s, stripMetadata })} label={t('video.stripMetadata')} disabled={disabled} />
            </div>
          </Row>
        </Section>
        </div>
        <div className="vform-col">
        {!audioOnly && s.container !== 'gif' && (
          <Section title={t('video.frame')} icon={Frame}>
            <Row label={t('video.resolution')}>
              <Select value={resSelect} onChange={setRes} disabled={disabled || v.codec === 'copy'} aria-label={t('video.resolution')}>
                <option value="source">{t('video.resSource')}</option>
                {RESOLUTIONS.map((r) => (
                  <option key={r} value={r}>
                    {t(`res.${r}` as MessageKey)}
                  </option>
                ))}
                <option value="custom">{t('video.resCustom')}</option>
              </Select>
            </Row>
            {resSelect === 'custom' && (
              <Row label={t('video.size')} hint={t('video.sizeHint')}>
                <div className="inline-controls">
                  <NumberInput value={v.width} onChange={(width) => setV({ width })} min={16} max={8192} step={2} integer allowEmpty placeholder={t('common.auto')} width={96} suffix="W" disabled={disabled} ariaLabel={t('video.width')} />
                  <span className="times">×</span>
                  <NumberInput value={v.height} onChange={(height) => setV({ height })} min={16} max={8192} step={2} integer allowEmpty placeholder={t('common.auto')} width={96} suffix="H" disabled={disabled} ariaLabel={t('video.height')} />
                </div>
              </Row>
            )}
            {v.width != null && v.height != null && (
              <Row label={t('video.scaleMode')} hint={t(`scale.${v.scaleMode}.hint` as MessageKey)}>
                <Select value={v.scaleMode} onChange={(m) => setV({ scaleMode: m as ScaleMode })} disabled={disabled || v.codec === 'copy'} aria-label={t('video.scaleMode')}>
                  {(['fit', 'pad', 'crop', 'stretch'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`scale.${m}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              </Row>
            )}
            {(v.width != null || v.height != null) && (
              <Row label="">
                <Checkbox checked={v.noUpscale} onChange={(noUpscale) => setV({ noUpscale })} label={t('video.noUpscale')} disabled={disabled || v.codec === 'copy'} />
              </Row>
            )}
            <Row label={t('video.fps')}>
              <Select value={v.fps == null ? '' : String(v.fps)} onChange={(f) => setV({ fps: f ? Number(f) : null })} disabled={disabled || v.codec === 'copy'} aria-label={t('video.fps')}>
                <option value="">{t('video.fpsSource')}</option>
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={String(f)}>
                    {f} fps
                  </option>
                ))}
              </Select>
            </Row>
          </Section>
        )}

        {s.container === 'gif' && (
          <Section title={t('video.gif')} icon={Clapperboard}>
            <Row label={t('video.gifFps')}>
              <Slider value={gif.fps} min={5} max={50} step={1} onChange={(fps) => setGif({ fps })} format={(n) => `${n} fps`} disabled={disabled} ariaLabel={t('video.gifFps')} />
            </Row>
            <Row label={t('video.gifWidth')} hint={t('video.gifWidthHint')}>
              <NumberInput value={gif.width} onChange={(width) => setGif({ width })} min={16} max={3840} step={10} integer allowEmpty placeholder={t('common.source')} suffix="px" width={120} disabled={disabled} ariaLabel={t('video.gifWidth')} />
            </Row>
            <Row label={t('video.gifColors')}>
              <Slider value={gif.colors} min={2} max={256} step={1} onChange={(colors) => setGif({ colors })} disabled={disabled} ariaLabel={t('video.gifColors')} />
            </Row>
            <Row label={t('video.gifDither')}>
              <Select value={gif.dither} onChange={(d) => setGif({ dither: d as GifSettings['dither'] })} disabled={disabled} aria-label={t('video.gifDither')}>
                {(['none', 'bayer', 'floyd_steinberg', 'sierra2_4a'] as const).map((d) => (
                  <option key={d} value={d}>
                    {t(`dither.${d}` as MessageKey)}
                  </option>
                ))}
              </Select>
            </Row>
            <Row label={t('video.gifLoop')}>
              <div className="inline-controls">
                <Select
                  value={loopMode}
                  onChange={(m) => setGif({ loop: m === 'forever' ? 0 : m === 'once' ? -1 : 3 })}
                  disabled={disabled}
                  aria-label={t('video.gifLoop')}
                >
                  <option value="forever">{t('video.loopForever')}</option>
                  <option value="once">{t('video.loopOnce')}</option>
                  <option value="count">{t('video.loopCount')}</option>
                </Select>
                {loopMode === 'count' && (
                  <NumberInput value={gif.loop} onChange={(n) => setGif({ loop: Math.max(1, n ?? 1) })} min={1} max={100} integer width={80} suffix="×" disabled={disabled} ariaLabel={t('video.loopCount')} />
                )}
              </div>
            </Row>
            <Row label="">
              <Checkbox checked={v.noUpscale} onChange={(noUpscale) => setV({ noUpscale })} label={t('video.noUpscale')} disabled={disabled} />
            </Row>
          </Section>
        )}

        <Section title={t('video.audio')} icon={AudioLines}>
          <Row label={t('video.audioCodec')}>
            <Select value={a.codec} onChange={(c) => setA({ codec: c as A['codec'] })} disabled={disabled} aria-label={t('video.audioCodec')}>
              {allowedAudioCodecs(s.container).map((c) => (
                <option key={c} value={c}>
                  {audioCodecLabel(c, t)}
                </option>
              ))}
            </Select>
          </Row>
          {lossyAudio && (
            <Row label={t('video.audioBitrate')}>
              <Select value={String(a.bitrateKbps ?? 192)} onChange={(b) => setA({ bitrateKbps: Number(b) })} disabled={disabled} aria-label={t('video.audioBitrate')}>
                {AUDIO_BITRATES.map((b) => (
                  <option key={b} value={String(b)}>
                    {b} kbps
                  </option>
                ))}
              </Select>
            </Row>
          )}
          {audioActive && (
            <>
              <Row label={t('video.sampleRate')}>
                <Select value={a.sampleRate == null ? '' : String(a.sampleRate)} onChange={(r) => setA({ sampleRate: r ? Number(r) : null })} disabled={disabled} aria-label={t('video.sampleRate')}>
                  <option value="">{t('common.source')}</option>
                  {SAMPLE_RATES.map((r) => (
                    <option key={r} value={String(r)}>
                      {(r / 1000).toFixed(r % 1000 ? 2 : 0)} kHz
                    </option>
                  ))}
                </Select>
              </Row>
              <Row label={t('video.channels')}>
                <Segmented<string>
                  value={a.channels == null ? 'source' : String(a.channels)}
                  onChange={(c) => setA({ channels: c === 'source' ? null : Number(c) })}
                  disabled={disabled}
                  ariaLabel={t('video.channels')}
                  options={[
                    { value: 'source', label: t('common.source') },
                    { value: '1', label: t('video.mono') },
                    { value: '2', label: t('video.stereo') },
                  ]}
                />
              </Row>
              <Row label="">
                <Checkbox checked={!!a.normalize} onChange={(normalize) => setA({ normalize })} label={t('video.normalize')} title={t('video.normalizeHint')} disabled={disabled} />
              </Row>
            </>
          )}
          {a.codec === 'none' && <p className="note">{t('video.noAudioNote')}</p>}
        </Section>

        {!audioOnly && (
          <Section title={t('video.watermark')} icon={Stamp}>
            <WatermarkEditor value={s.watermark} onChange={(watermark) => onChange({ ...s, watermark })} disabled={disabled || v.codec === 'copy'} />
          </Section>
        )}
        </div>

      </div>
    </div>
  )
}

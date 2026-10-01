// Image preset / job editor: actions + output settings + live before/after preview.
import { useEffect, useMemo, useState } from 'react'
import { FileImage, ImageOff, ImagePlus, Settings2 } from 'lucide-react'
import type { ImageAction, ImageFormat, ImageOutputSettings, ImagePreviewResult, MediaInfo } from '../../../shared/types'
import { api } from '../api'
import { guard, useStore, useT } from '../store'
import { useDebouncedValue } from '../lib/hooks'
import { fileName } from '../lib/format'
import { BeforeAfter } from '../components/BeforeAfter'
import { Button, Checkbox, ColorInput, NumberInput, Row, Segmented, Select, Slider, Spinner, cx } from '../components/ui'
import { ActionsPanel } from './ImageActions'

const FORMATS: (ImageFormat | 'keep')[] = ['keep', 'jpeg', 'png', 'webp', 'avif', 'tiff', 'gif']

export function ImageChainEditor({
  actions,
  output,
  onChange,
  fixedSample,
}: {
  actions: ImageAction[]
  output: ImageOutputSettings
  onChange: (actions: ImageAction[], output: ImageOutputSettings) => void
  /** Job editor: preview this file only. */
  fixedSample?: string
}) {
  return (
    <div className="chain-editor">
      <div className="chain-left">
        <ActionsPanel actions={actions} onChange={(a) => onChange(a, output)} />
        <ImageOutputForm output={output} onChange={(o) => onChange(actions, o)} />
      </div>
      <ImagePreviewPane actions={actions} output={output} fixedSample={fixedSample} />
    </div>
  )
}

export function ImageOutputForm({ output: o, onChange }: { output: ImageOutputSettings; onChange: (o: ImageOutputSettings) => void }) {
  const t = useT()
  const set = (p: Partial<ImageOutputSettings>): void => onChange({ ...o, ...p })
  const f = o.format
  const qualityApplies = f === 'keep' || f === 'jpeg' || f === 'webp' || f === 'avif' || f === 'tiff'
  const losslessApplies = f === 'webp' || f === 'avif'
  return (
    <div className="output-panel">
      <div className="panel-head">
        <h3>
          <Settings2 size={14} aria-hidden /> {t('chain.output')}
        </h3>
      </div>
      <div className="panel-body">
        <Row label={t('imgOut.format')}>
          <Select value={f} onChange={(v) => set({ format: v as ImageOutputSettings['format'] })} aria-label={t('imgOut.format')}>
            {FORMATS.map((x) => (
              <option key={x} value={x}>
                {x === 'keep' ? t('imgOut.keep') : t(`imgFormat.${x}`)}
              </option>
            ))}
          </Select>
        </Row>
        {qualityApplies && (
          <Row label={t('imgOut.quality')}>
            <Slider value={o.quality} min={1} max={100} step={1} onChange={(quality) => set({ quality })} disabled={!!o.lossless && losslessApplies} ariaLabel={t('imgOut.quality')} />
          </Row>
        )}
        {losslessApplies && (
          <Row label="">
            <Checkbox checked={!!o.lossless} onChange={(lossless) => set({ lossless })} label={t('imgOut.lossless')} />
          </Row>
        )}
        {(f === 'jpeg' || f === 'png' || f === 'keep') && (
          <Row label="">
            <Checkbox checked={!!o.progressive} onChange={(progressive) => set({ progressive })} label={t('imgOut.progressive')} title={t('imgOut.progressiveHint')} />
          </Row>
        )}
        {(f === 'jpeg' || f === 'avif') && (
          <Row label={t('imgOut.chroma')} hint={t('imgOut.chromaHint')}>
            <Segmented
              value={o.chromaSubsampling ?? '4:2:0'}
              onChange={(chromaSubsampling) => set({ chromaSubsampling })}
              ariaLabel={t('imgOut.chroma')}
              options={[
                { value: '4:2:0', label: '4:2:0' },
                { value: '4:4:4', label: '4:4:4' },
              ]}
            />
          </Row>
        )}
        {f === 'png' && (
          <Row label={t('imgOut.pngCompression')} hint={t('imgOut.pngCompressionHint')}>
            <Slider value={o.pngCompression ?? 6} min={0} max={9} step={1} onChange={(pngCompression) => set({ pngCompression })} ariaLabel={t('imgOut.pngCompression')} />
          </Row>
        )}
        {(f === 'jpeg' || f === 'keep') && (
          <Row label={t('imgOut.background')} hint={t('imgOut.backgroundHint')}>
            <ColorInput value={o.background ?? '#ffffff'} onChange={(background) => set({ background })} ariaLabel={t('imgOut.background')} />
          </Row>
        )}
        <Row label={t('imgOut.dpi')}>
          <div className="inline-controls">
            <Checkbox checked={o.dpi != null} onChange={(on) => set({ dpi: on ? 300 : null })} label={t('imgOut.setDpi')} />
            {o.dpi != null && <NumberInput value={o.dpi} onChange={(dpi) => set({ dpi: dpi ?? 72 })} min={1} max={2400} integer width={90} suffix="dpi" ariaLabel={t('imgOut.dpi')} />}
          </div>
        </Row>
        <Row label="">
          <Checkbox checked={o.keepMetadata} onChange={(keepMetadata) => set({ keepMetadata })} label={t('imgOut.keepMetadata')} title={t('imgOut.keepMetadataHint')} />
        </Row>
      </div>
    </div>
  )
}

export function ImagePreviewPane({ actions, output, fixedSample }: { actions: ImageAction[]; output: ImageOutputSettings; fixedSample?: string }) {
  const t = useT()
  const jobs = useStore((s) => s.jobs)
  const queueSamples = useMemo(() => Array.from(new Set(jobs.filter((j) => j.kind === 'image').map((j) => j.source))), [jobs])
  const [picked, setPicked] = useState<string[]>([])
  const samples = fixedSample ? [fixedSample] : Array.from(new Set([...picked, ...queueSamples]))
  const [sample, setSample] = useState<string | null>(fixedSample ?? samples[0] ?? null)
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit')
  const [mode, setMode] = useState<'split' | 'side'>('split')
  const [result, setResult] = useState<ImagePreviewResult | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!sample && samples[0]) setSample(samples[0])
  }, [sample, samples])

  useEffect(() => {
    if (!sample) return
    let alive = true
    const fromQueue = jobs.find((j) => j.source === sample)?.sourceInfo
    if (fromQueue) setInfo(fromQueue)
    else api.probe(sample).then((i) => alive && setInfo(i)).catch(() => alive && setInfo(null))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample])

  const key = JSON.stringify([sample, actions, output, zoom])
  const debouncedKey = useDebouncedValue(key, 300)
  useEffect(() => {
    if (!sample) return
    let alive = true
    setLoading(true)
    api
      .previewImage(sample, actions, output, zoom === 'actual' ? 4096 : 1400)
      .then((r) => {
        if (!alive) return
        setResult(r)
        setError(null)
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedKey])

  const pick = async (): Promise<void> => {
    const files = await guard(() => api.pickFiles('image', false))
    if (files?.[0]) {
      setPicked((p) => [files[0], ...p.filter((x) => x !== files[0])])
      setSample(files[0])
    }
  }

  return (
    <div className="preview-pane">
      <div className="panel-head preview-head">
        <h3>
          <FileImage size={14} aria-hidden /> {t('preview.title')}
        </h3>
        <div className="preview-tools">
          {!fixedSample && (
            <>
              <Select value={sample ?? ''} onChange={(v) => setSample(v || null)} aria-label={t('preview.sample')} className="sample-select" disabled={!samples.length}>
                {!samples.length && <option value="">{t('preview.noSample')}</option>}
                {samples.map((p) => (
                  <option key={p} value={p}>
                    {fileName(p)}
                  </option>
                ))}
              </Select>
              <Button size="sm" icon={ImagePlus} onClick={pick} title={t('preview.chooseSample')}>
                {t('preview.choose')}
              </Button>
            </>
          )}
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            ariaLabel={t('preview.mode')}
            options={[
              { value: 'split', label: t('preview.split') },
              { value: 'side', label: t('preview.side') },
            ]}
          />
          <Segmented
            size="sm"
            value={zoom}
            onChange={setZoom}
            ariaLabel={t('preview.zoom')}
            options={[
              { value: 'fit', label: t('preview.fit') },
              { value: 'actual', label: '100%' },
            ]}
          />
        </div>
      </div>
      <div className={cx('preview-stage', loading && 'is-loading')}>
        {!sample && (
          <div className="preview-empty">
            <ImageOff size={28} aria-hidden />
            <p>{t('preview.emptyHint')}</p>
            <Button icon={ImagePlus} onClick={pick}>
              {t('preview.chooseSample')}
            </Button>
          </div>
        )}
        {sample && error && (
          <div className="preview-empty error">
            <ImageOff size={28} aria-hidden />
            <p>{t('preview.failed')}</p>
            <code>{error}</code>
          </div>
        )}
        {sample && !error && result && <BeforeAfter before={result.before} after={result.after} zoom={zoom} mode={mode} outWidth={result.outWidth} outHeight={result.outHeight} />}
        {loading && (
          <div className="preview-spinner">
            <Spinner size={18} />
          </div>
        )}
      </div>
      <div className="preview-foot">
        {info?.width ? (
          <span>
            {t('preview.original')} <strong>{info.width}×{info.height}</strong>
          </span>
        ) : (
          <span />
        )}
        {result && (
          <span>
            {t('preview.output')} <strong>{result.outWidth}×{result.outHeight}</strong>
          </span>
        )}
      </div>
    </div>
  )
}

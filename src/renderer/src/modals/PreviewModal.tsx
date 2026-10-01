// Preview a queued job: video/audio playback (falls back to a still-frame scrubber when the codec can't play
// in Chromium) with In/Out trim and an "output preview" of the encoded frame; images get a before/after view.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Eye,
  Info,
  Music,
  Pause,
  Play,
  Scissors,
  SlidersHorizontal,
  StepBack,
  StepForward,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { Job, Trim } from '../../../shared/types'
import { isAudioOnlyContainer } from '../../../shared/videoRules'
import { api } from '../api'
import { closePreview, openEditor, toast, tNow, updateJob, useStore, useT } from '../store'
import { clamp, fileName, formatTimecode, sourceInfoLine } from '../lib/format'
import { isEditableJob } from '../lib/presets'
import { computeVideoOutputSize } from '../lib/videoSize'
import { useDebouncedValue } from '../lib/hooks'
import { Timeline } from '../components/Timeline'
import { TimecodeInput } from '../components/TimecodeInput'
import { Button, IconButton, Modal, Spinner, Switch, cx, isTypingTarget } from '../components/ui'
import { ImagePreviewPane } from '../editors/ImageChainEditor'

export function PreviewModal() {
  const id = useStore((s) => s.previewJobId)
  const job = useStore((s) => (s.previewJobId ? s.jobs.find((j) => j.id === s.previewJobId) : undefined))
  // File jobs (rename / copy / move) have nothing to preview.
  if (!id || !job || job.kind === 'file') return null
  return <PreviewDialog key={job.id} job={job} />
}

function PreviewDialog({ job }: { job: Job }) {
  const t = useT()
  const editable = isEditableJob(job)
  const sub = [sourceInfoLine(job.sourceInfo, t), job.presetName].filter(Boolean).join(' · ')

  if (job.kind === 'image' && job.image) {
    return (
      <Modal
        title={fileName(job.source)}
        subtitle={sub}
        icon={Eye}
        size="xl"
        onClose={closePreview}
        className="preview-modal"
        bodyClassName="pm-body"
        footer={
          <>
            <span className="footer-spacer" />
            {editable && (
              <Button icon={SlidersHorizontal} onClick={() => openEditor(job.id)}>
                {t('preview.editSettings')}
              </Button>
            )}
            <Button variant="primary" onClick={closePreview} data-autofocus>
              {t('common.close')}
            </Button>
          </>
        }
      >
        <ImagePreviewPane actions={job.image.actions} output={job.image.output} fixedSample={job.source} />
      </Modal>
    )
  }
  return <VideoPreview job={job} subtitle={sub} />
}

// ───────────────────────────── video / audio ─────────────────────────────

const sameTrim = (a: Trim | null | undefined, b: Trim | null | undefined): boolean => {
  if (!a || !b) return !a && !b
  return Math.abs(a.inSec - b.inSec) < 0.001 && Math.abs(a.outSec - b.outSec) < 0.001
}

function VideoPreview({ job, subtitle }: { job: Job; subtitle: string }) {
  const t = useT()
  const info = job.sourceInfo
  const isAudio = info?.kind === 'audio'
  const fps = info?.fps && info.fps > 0 ? info.fps : 30
  const editable = isEditableJob(job)
  const settings = job.video?.settings
  const outputPossible = !isAudio && !!settings && !isAudioOnlyContainer(settings.container) && settings.video.codec !== 'none'
  const outSize = settings ? computeVideoOutputSize(info, settings) : null
  const src = useMemo(() => api.mediaUrl(job.source), [job.source])
  const mediaRef = useRef<HTMLMediaElement | null>(null)

  const [mode, setMode] = useState<'media' | 'frames'>('media')
  const [duration, setDuration] = useState(info?.durationSec ?? 0)
  const savedTrim = job.video?.trim ?? null
  const [time, setTime] = useState(savedTrim?.inSec ?? 0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const [inSec, setIn] = useState<number | null>(savedTrim?.inSec ?? null)
  const [outSec, setOut] = useState<number | null>(savedTrim?.outSec ?? null)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameLoading, setFrameLoading] = useState(false)
  const [frameError, setFrameError] = useState(false)
  const [busy, setBusy] = useState(false)
  const timeRef = useRef(time)
  timeRef.current = time

  const d = duration > 0 ? duration : 0
  const frameDur = 1 / fps

  // ── seeking / playback ──
  const seek = useCallback(
    (sec: number) => {
      const v = clamp(sec, 0, d || sec)
      timeRef.current = v
      setTime(v)
      const m = mediaRef.current
      if (m && mode === 'media') {
        try {
          m.currentTime = v
        } catch {
          /* not seekable yet */
        }
      }
    },
    [d, mode],
  )

  const canPlay = mode === 'media'
  const togglePlay = useCallback(() => {
    const m = mediaRef.current
    if (!m || mode !== 'media') return
    if (m.paused) {
      setShowOutput(false)
      if (outSec != null && m.currentTime >= outSec - frameDur) m.currentTime = inSec ?? 0
      void m.play().catch(() => setPlaying(false))
    } else m.pause()
  }, [mode, inSec, outSec, frameDur])

  const step = useCallback(
    (frames: number) => {
      mediaRef.current?.pause()
      seek(Math.round((timeRef.current + frames * frameDur) * fps) / fps)
    },
    [seek, frameDur, fps],
  )

  // Smooth playhead while playing (timeupdate alone fires only ~4×/s).
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      const m = mediaRef.current
      if (m) {
        setTime(m.currentTime)
        if (outSec != null && m.currentTime >= outSec) {
          m.pause()
          m.currentTime = outSec
          setTime(outSec)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, outSec])

  // ── still frames (fallback) / output preview ──
  const needFrame = !isAudio && (mode === 'frames' || showOutput)
  const frameKind = showOutput ? 'output' : 'source'
  const frameTime = useDebouncedValue(Math.round(time * 100) / 100, showOutput ? 220 : 90)
  // Queue snapshots replace job objects; key on the settings' content so we don't refetch identical frames.
  const settingsKey = JSON.stringify(settings ?? null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  useEffect(() => {
    if (!needFrame) return
    let alive = true
    setFrameLoading(true)
    const s = settingsRef.current
    const p =
      frameKind === 'output' && s
        ? api.previewVideoFrame(job.source, frameTime, s, 1280)
        : api.getVideoFrame(job.source, frameTime, 1280)
    p.then((url) => {
      if (!alive) return
      setFrameUrl(url)
      setFrameError(false)
    })
      .catch((err: unknown) => {
        console.error(err)
        if (alive) setFrameError(true)
      })
      .finally(() => alive && setFrameLoading(false))
    return () => {
      alive = false
    }
  }, [needFrame, frameKind, frameTime, job.source, settingsKey])

  // ── trim ──
  const draftTrim: Trim | null = inSec == null && outSec == null ? null : { inSec: inSec ?? 0, outSec: outSec ?? d }
  const trimValid = !draftTrim || draftTrim.outSec > draftTrim.inSec
  const dirty = !sameTrim(draftTrim, savedTrim)
  const keepDur = Math.max(0, (outSec ?? d) - (inSec ?? 0))

  const setInAt = useCallback(
    (v: number) => {
      setIn(v)
      if (outSec != null && v >= outSec) setOut(null)
    },
    [outSec],
  )
  const setOutAt = useCallback(
    (v: number) => {
      setOut(v)
      if (inSec != null && v <= inSec) setIn(null)
    },
    [inSec],
  )

  const applyTrim = async (): Promise<void> => {
    if (!trimValid) {
      toast('error', tNow('preview.trimInvalid'))
      return
    }
    setBusy(true)
    const r = await updateJob(job.id, { video: { trim: draftTrim } })
    setBusy(false)
    if (r) toast('success', tNow(draftTrim ? 'preview.trimApplied' : 'preview.trimCleared'))
  }

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === ' ' && tag !== 'BUTTON') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const dir = e.key === 'ArrowLeft' ? -1 : 1
        if (e.shiftKey) seek(timeRef.current + dir)
        else step(dir)
      } else if (e.key === 'Home') {
        e.preventDefault()
        seek(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        seek(d)
      } else if ((e.key === 'i' || e.key === 'I') && editable) {
        setInAt(timeRef.current)
      } else if ((e.key === 'o' || e.key === 'O') && editable) {
        setOutAt(timeRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, seek, step, d, editable, setInAt, setOutAt])

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => {
      mediaRef.current = el
    },
    src,
    preload: 'metadata' as const,
    muted,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      const m = e.currentTarget
      if (!(info?.durationSec && info.durationSec > 0) && Number.isFinite(m.duration)) setDuration(m.duration)
      if (timeRef.current > 0) m.currentTime = timeRef.current
    },
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (!playing) setTime(e.currentTarget.currentTime)
    },
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onError: () => {
      setPlaying(false)
      setMode('frames')
    },
  }

  return (
    <Modal
      title={fileName(job.source)}
      subtitle={subtitle}
      icon={Eye}
      size="xl"
      onClose={closePreview}
      className="preview-modal"
      bodyClassName="pm-body"
      footer={
        <>
          <span className="pm-foot-hint">
            {editable ? (
              t('preview.trimHint')
            ) : (
              <>
                <Info size={13} aria-hidden /> {t('preview.trimLocked')}
              </>
            )}
          </span>
          <span className="footer-spacer" />
          {editable && (
            <Button icon={SlidersHorizontal} onClick={() => openEditor(job.id)}>
              {t('preview.editSettings')}
            </Button>
          )}
          <Button onClick={closePreview}>{t('common.close')}</Button>
          {editable && (
            <Button variant="primary" icon={Scissors} disabled={!dirty || !trimValid} busy={busy} onClick={() => void applyTrim()}>
              {t('preview.applyTrim')}
            </Button>
          )}
        </>
      }
    >
      <div className={cx('pm-stage', isAudio && 'audio')}>
        {isAudio ? (
          <>
            <audio {...mediaProps} />
            <div className="pm-audio">
              <Music size={44} aria-hidden />
              <span>{mode === 'frames' ? t('preview.cannotPlay') : t('preview.audioOnly')}</span>
            </div>
          </>
        ) : (
          <video {...mediaProps} className={cx('pm-media', (mode !== 'media' || showOutput) && 'covered')} playsInline onClick={togglePlay} />
        )}
        {needFrame && (frameUrl ? <img className="pm-frame" src={frameUrl} alt="" draggable={false} /> : !frameError && <div className="pm-placeholder"><Spinner size={18} /> {t('preview.loadingFrame')}</div>)}
        {needFrame && frameError && (
          <div className="pm-placeholder error">
            <Info size={16} aria-hidden /> {t('preview.failed')}
          </div>
        )}
        {needFrame && frameLoading && frameUrl && (
          <div className="preview-spinner">
            <Spinner size={16} />
          </div>
        )}
        <div className="pm-badges">
          {mode === 'frames' && !isAudio && (
            <span className="pm-badge warn">
              <Info size={12} aria-hidden /> {t('preview.cannotPlay')}
            </span>
          )}
          {showOutput && outSize && <span className="pm-badge accent">{t('preview.outputSize', { w: outSize.width, h: outSize.height })}</span>}
        </div>
      </div>

      <div className="pm-transport">
        <IconButton icon={StepBack} label={t('preview.prevFrame')} onClick={() => step(-1)} />
        <IconButton icon={playing ? Pause : Play} label={playing ? t('preview.pause') : t('preview.play')} onClick={togglePlay} disabled={!canPlay} className="pm-play" size={17} />
        <IconButton icon={StepForward} label={t('preview.nextFrame')} onClick={() => step(1)} />
        <span className="pm-tc">{formatTimecode(time, fps)}</span>
        <div className="pm-timeline">
          <Timeline duration={d} time={time} inSec={inSec} outSec={outSec} fps={fps} onSeek={(s) => {
            mediaRef.current?.pause()
            seek(s)
          }} />
        </div>
        <span className="pm-tc muted">{formatTimecode(d, fps)}</span>
        <IconButton icon={muted ? VolumeX : Volume2} label={muted ? t('preview.unmute') : t('preview.mute')} onClick={() => setMuted((m) => !m)} disabled={!canPlay} />
        <span className="pm-sep" />
        <Switch checked={showOutput} onChange={(v) => {
          if (v) mediaRef.current?.pause()
          setShowOutput(v)
        }} label={t('preview.outputPreview')} title={t('preview.outputPreviewHint')} disabled={!outputPossible} />
      </div>

      <div className={cx('pm-trim', !editable && 'locked')}>
        <span className="pm-trim-title">
          <Scissors size={14} aria-hidden /> {t('preview.trim')}
        </span>
        <div className="pm-point">
          <span className="mini-label">{t('preview.in')}</span>
          <TimecodeInput value={inSec} onChange={(v) => (v == null ? setIn(null) : setInAt(v))} fps={fps} max={d || undefined} disabled={!editable} ariaLabel={t('preview.in')} placeholder={formatTimecode(0, fps)} />
          <Button size="sm" onClick={() => setInAt(time)} disabled={!editable} title={`${t('preview.setIn')} (I)`}>
            {t('preview.setIn')}
          </Button>
          <IconButton icon={ArrowLeftToLine} size={14} label={t('preview.goIn')} onClick={() => seek(inSec ?? 0)} />
        </div>
        <div className="pm-point">
          <span className="mini-label">{t('preview.out')}</span>
          <TimecodeInput value={outSec} onChange={(v) => (v == null ? setOut(null) : setOutAt(v))} fps={fps} max={d || undefined} disabled={!editable} ariaLabel={t('preview.out')} placeholder={formatTimecode(d, fps)} />
          <Button size="sm" onClick={() => setOutAt(time)} disabled={!editable} title={`${t('preview.setOut')} (O)`}>
            {t('preview.setOut')}
          </Button>
          <IconButton icon={ArrowRightToLine} size={14} label={t('preview.goOut')} onClick={() => seek(outSec ?? d)} />
        </div>
        <div className="pm-point pm-dur">
          <span className="mini-label">{t('preview.duration')}</span>
          <strong className={cx(!trimValid && 'invalid')}>{draftTrim ? formatTimecode(keepDur, fps) : t('preview.wholeFile')}</strong>
        </div>
        <span className="footer-spacer" />
        <Button size="sm" variant="ghost" onClick={() => { setIn(null); setOut(null) }} disabled={!editable || (inSec == null && outSec == null)}>
          {t('preview.clearTrim')}
        </Button>
      </div>
    </Modal>
  )
}

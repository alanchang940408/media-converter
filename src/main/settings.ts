// AppSettings: defaults, validation, persistence and change hooks.
// No Electron import — index.ts injects the system locale and the theme applier (nativeTheme).
import { cpus } from 'node:os'
import type { AppSettings, ConflictPolicy, HwAccel, Locale } from '../shared/types'
import { setCustomFfmpegPath } from './ffmpeg/paths'
import { resolveSystemLocale, setLocale } from './i18n'
import type { JsonStore } from './jsonStore'

export function defaultSettings(): AppSettings {
  return {
    language: 'auto',
    theme: 'dark',
    videoConcurrency: 1,
    imageConcurrency: Math.min(4, Math.max(1, Math.floor(cpus().length / 2))),
    autoStart: false,
    defaultOutputDir: null,
    defaultNameTemplate: '{name}',
    conflict: 'rename',
    preferredHw: 'auto',
    lastVideoPresetId: 'h264-match',
    lastImagePresetId: 'img-jpeg-q90',
    lastFilePresetId: 'file-copy-rename',
    preserveStructure: true,
    notifyOnFinish: true,
    preventSleep: true,
    removeFinished: false,
    ffmpegPath: null,
    autoCheckUpdates: true,
  }
}

const LANGS: AppSettings['language'][] = ['auto', 'zh-TW', 'en', 'ja']
const THEMES: AppSettings['theme'][] = ['dark', 'light', 'system']
const CONFLICTS: ConflictPolicy[] = ['rename', 'overwrite', 'skip']
const HWS: HwAccel[] = ['auto', 'none', 'nvenc', 'qsv', 'amf', 'videotoolbox']

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v : fallback)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const oneOf = <T>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)

/** Merge `input` over `base`, coercing every field to a valid value. */
export function sanitizeSettings(input: Partial<AppSettings> | unknown, base: AppSettings = defaultSettings()): AppSettings {
  const p = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const has = (k: keyof AppSettings): boolean => Object.prototype.hasOwnProperty.call(p, k)
  const pick = <K extends keyof AppSettings>(k: K): unknown => (has(k) ? p[k] : base[k])
  return {
    language: oneOf(pick('language'), LANGS, base.language),
    theme: oneOf(pick('theme'), THEMES, base.theme),
    videoConcurrency: clampInt(pick('videoConcurrency'), 1, 4, base.videoConcurrency),
    imageConcurrency: clampInt(pick('imageConcurrency'), 1, 16, base.imageConcurrency),
    autoStart: bool(pick('autoStart'), base.autoStart),
    defaultOutputDir: strOrNull(pick('defaultOutputDir')),
    defaultNameTemplate: str(pick('defaultNameTemplate'), '{name}'),
    conflict: oneOf(pick('conflict'), CONFLICTS, base.conflict),
    preferredHw: oneOf(pick('preferredHw'), HWS, base.preferredHw),
    lastVideoPresetId: str(pick('lastVideoPresetId'), base.lastVideoPresetId),
    lastImagePresetId: str(pick('lastImagePresetId'), base.lastImagePresetId),
    lastFilePresetId: str(pick('lastFilePresetId'), base.lastFilePresetId),
    preserveStructure: bool(pick('preserveStructure'), base.preserveStructure),
    notifyOnFinish: bool(pick('notifyOnFinish'), base.notifyOnFinish),
    preventSleep: bool(pick('preventSleep'), base.preventSleep),
    removeFinished: bool(pick('removeFinished'), base.removeFinished),
    ffmpegPath: strOrNull(pick('ffmpegPath')),
    autoCheckUpdates: bool(pick('autoCheckUpdates'), base.autoCheckUpdates),
  }
}

export function resolveLocale(language: AppSettings['language'], osLocale: string): Locale {
  return language === 'auto' ? resolveSystemLocale(osLocale) : language
}

/** What the queue / watch manager need from settings (kept small for tests). */
export interface SettingsAccess {
  get(): AppSettings
  patch(p: Partial<AppSettings>): AppSettings
  locale(): Locale
}

export interface SettingsHooks {
  /** e.g. () => app.getLocale() */
  systemLocale?: () => string
  /** e.g. (t) => { nativeTheme.themeSource = t } */
  applyTheme?: (theme: AppSettings['theme']) => void
}

export type SettingsListener = (next: AppSettings, prev: AppSettings, changed: (keyof AppSettings)[]) => void

export class SettingsManager implements SettingsAccess {
  private listeners = new Set<SettingsListener>()

  constructor(
    private readonly store: JsonStore<AppSettings>,
    private readonly hooks: SettingsHooks = {},
  ) {
    const clean = sanitizeSettings(store.get())
    store.set(clean)
    setCustomFfmpegPath(clean.ffmpegPath)
    setLocale(this.locale())
    hooks.applyTheme?.(clean.theme)
  }

  get(): AppSettings {
    return { ...this.store.get() }
  }

  locale(): Locale {
    return resolveLocale(this.store.get().language, this.hooks.systemLocale?.() ?? 'en')
  }

  patch(p: Partial<AppSettings>): AppSettings {
    const prev = this.store.get()
    const next = sanitizeSettings(p, prev)
    const changed = (Object.keys(next) as (keyof AppSettings)[]).filter((k) => next[k] !== prev[k])
    if (!changed.length) return { ...prev }
    this.store.set(next)
    if (changed.includes('ffmpegPath')) setCustomFfmpegPath(next.ffmpegPath)
    if (changed.includes('language')) setLocale(this.locale())
    if (changed.includes('theme')) this.hooks.applyTheme?.(next.theme)
    for (const l of this.listeners) {
      try {
        l({ ...next }, { ...prev }, changed)
      } catch (err) {
        console.error('[settings] listener failed:', err)
      }
    }
    return { ...next }
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

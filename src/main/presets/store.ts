// User presets (userData presets.json) layered over the built-ins, plus JSON import/export.
import { randomUUID } from 'node:crypto'
import type { Locale, Preset, PresetCategory } from '../../shared/types'
import { allowedAudioCodecs, allowedVideoCodecs } from '../../shared/videoRules'
import { t } from '../i18n'
import type { JsonStore } from '../jsonStore'
import { BUILTIN_PRESETS, getBuiltinPreset, isBuiltinId } from './builtin'

export interface PresetFile {
  version: 1
  presets: Preset[]
}

export interface PresetExport {
  app: 'media-converter'
  version: 1
  presets: Preset[]
}

export interface PresetLookup {
  get(id: string): Preset | undefined
}

const CATEGORIES: PresetCategory[] = ['web', 'social', 'editing', 'archive', 'device', 'gif', 'audio', 'image', 'custom']
const CONTAINERS = ['mp4', 'mov', 'mkv', 'webm', 'gif', 'mp3', 'm4a', 'wav', 'flac', 'ogg']
const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif', 'keep']
const RATE_MODES = ['crf', 'vbr', 'cbr']

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function emptyPresetFile(): PresetFile {
  return { version: 1, presets: [] }
}

export function parsePresetFile(raw: unknown): PresetFile | null {
  if (!isObj(raw) || !Array.isArray(raw.presets)) return null
  return { version: 1, presets: raw.presets.map((p) => normalizePreset(p)).filter((p): p is Preset => !!p) }
}

/** Validate an untrusted preset; returns a cleaned user preset or null. */
export function normalizePreset(raw: unknown): Preset | null {
  if (!isObj(raw)) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null
  if (!name) return null
  const base = {
    id: typeof raw.id === 'string' ? raw.id : '',
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : undefined,
    category: CATEGORIES.includes(raw.category as PresetCategory) ? (raw.category as PresetCategory) : 'custom',
    builtIn: false,
  }
  if (raw.kind === 'video') {
    const s = raw.settings
    if (!isObj(s) || !isObj(s.video) || !isObj(s.audio)) return null
    if (!CONTAINERS.includes(s.container as string)) return null
    const v = s.video
    const a = s.audio
    if (!allowedVideoCodecs(s.container as never).includes(v.codec as never)) return null
    if (!allowedAudioCodecs(s.container as never).includes(a.codec as never)) return null
    if (!isObj(v.rate) || !RATE_MODES.includes(v.rate.mode as string)) return null
    if (typeof v.hw !== 'string' || typeof v.scaleMode !== 'string') return null
    return { ...base, kind: 'video', settings: structuredClone(s) as never }
  }
  if (raw.kind === 'image') {
    if (!Array.isArray(raw.actions) || !isObj(raw.output)) return null
    if (!IMAGE_FORMATS.includes(raw.output.format as string)) return null
    const actions = raw.actions.filter((a) => isObj(a) && typeof a.type === 'string')
    return {
      ...base,
      kind: 'image',
      actions: structuredClone(actions) as never,
      output: structuredClone(raw.output) as never,
    }
  }
  return null
}

export class PresetStore implements PresetLookup {
  constructor(
    private readonly store: JsonStore<PresetFile>,
    private readonly locale: () => Locale = () => 'en',
  ) {}

  private get user(): Preset[] {
    return this.store.get().presets
  }

  list(): Preset[] {
    return [...BUILTIN_PRESETS, ...this.user].map((p) => structuredClone(p))
  }

  get(id: string): Preset | undefined {
    return getBuiltinPreset(id) ?? this.user.find((p) => p.id === id)
  }

  private newId(): string {
    let id = `user-${randomUUID().slice(0, 8)}`
    while (this.get(id)) id = `user-${randomUUID().slice(0, 8)}`
    return id
  }

  /** Create or update a user preset. Saving onto a built-in id creates a copy. */
  save(input: Preset): Preset {
    const builtin = input.id ? getBuiltinPreset(input.id) : undefined
    const clean = normalizePreset({ ...input, builtIn: false })
    if (!clean) throw new Error(t('error.invalidPresetFile'))
    const existing = !builtin && input.id ? this.user.findIndex((p) => p.id === input.id) : -1
    if (builtin) {
      // a copy: keep the localized name the user saw unless they renamed it
      const shown = builtin.names?.[this.locale()] ?? builtin.name
      const renamed = clean.name !== builtin.name && clean.name !== shown
      clean.name = renamed ? clean.name : t('preset.copySuffix', { name: shown }, this.locale())
      if (clean.category === 'custom' && builtin.category) clean.category = builtin.category
    }
    if (existing >= 0) {
      clean.id = input.id
      this.user[existing] = clean
    } else {
      clean.id = this.newId()
      this.user.push(clean)
    }
    this.store.save()
    return structuredClone(clean)
  }

  delete(id: string): void {
    if (isBuiltinId(id)) throw new Error(t('error.builtInPreset'))
    const presets = this.user
    const idx = presets.findIndex((p) => p.id === id)
    if (idx >= 0) {
      presets.splice(idx, 1)
      this.store.save()
    }
  }

  exportJson(ids: string[]): string {
    const presets = ids
      .map((id) => this.get(id))
      .filter((p): p is Preset => !!p)
      .map((p) => {
        const copy = structuredClone(p)
        if (copy.builtIn) {
          copy.name = copy.names?.[this.locale()] ?? copy.name
          copy.builtIn = false
        }
        return copy
      })
    const data: PresetExport = { app: 'media-converter', version: 1, presets }
    return JSON.stringify(data, null, 2)
  }

  /** Validate and add presets from an export file. Colliding / missing ids get new ids. */
  importJson(text: string): Preset[] {
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      throw new Error(t('error.invalidPresetFile'))
    }
    if (!isObj(raw) || raw.app !== 'media-converter' || raw.version !== 1 || !Array.isArray(raw.presets)) {
      throw new Error(t('error.invalidPresetFile'))
    }
    const imported: Preset[] = []
    for (const entry of raw.presets) {
      const p = normalizePreset(entry)
      if (!p) continue
      if (!p.id || this.get(p.id) || imported.some((q) => q.id === p.id)) p.id = this.newId()
      this.user.push(p)
      imported.push(p)
    }
    if (!imported.length) throw new Error(t('error.noValidPresets'))
    this.store.save()
    return imported.map((p) => structuredClone(p))
  }
}

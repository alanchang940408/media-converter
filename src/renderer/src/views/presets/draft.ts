// Presets screen state: selection + editable draft. Module-level so an unsaved draft survives switching tabs.
import { create } from 'zustand'
import type { ImageAction, Preset, PresetCategory, Watermark } from '../../../../shared/types'
import { validateVideoSettings } from '../../../../shared/videoRules'
import { api } from '../../api'
import { confirmDialog, guard, refreshPresets, selectLocale, toast, tNow, useStore } from '../../store'
import type { MessageKey } from '../../i18n'
import { clone, newImagePreset, newVideoPreset, presetDescription, presetName } from '../../lib/presets'

export type PresetKind = 'video' | 'image'
export type PresetFilter = 'all' | 'builtIn' | 'mine'

export interface PresetDraftState {
  kind: PresetKind
  /** Saved preset being edited; null while editing a brand-new, never-saved preset. */
  selectedId: string | null
  draft: Preset | null
  /** Stable JSON of the saved version ('' for a new draft). */
  baseline: string
  query: string
  filter: PresetFilter
  saving: boolean
}

export const usePresetDraft = create<PresetDraftState>(() => ({
  kind: 'video',
  selectedId: null,
  draft: null,
  baseline: '',
  query: '',
  filter: 'all',
  saving: false,
}))

const set = usePresetDraft.setState
const get = usePresetDraft.getState

export const VIDEO_CATEGORIES: PresetCategory[] = ['web', 'social', 'editing', 'archive', 'device', 'gif', 'audio', 'custom']
export const IMAGE_CATEGORIES: PresetCategory[] = ['image', 'web', 'social', 'archive', 'custom']

/** JSON with sorted keys, so key order / undefined fields never count as a change. */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          if (o[k] !== undefined) acc[k] = o[k]
          return acc
        }, {})
    }
    return val
  })
}

export function isDirty(s: Pick<PresetDraftState, 'draft' | 'baseline' | 'selectedId'>): boolean {
  if (!s.draft) return false
  if (s.selectedId === null) return true
  return stableStringify(s.draft) !== s.baseline
}

export interface DraftIssue {
  level: 'error' | 'warning'
  key: MessageKey
  params?: Record<string, string | number>
}

const missingLogo = (w: Watermark | null | undefined): boolean => w?.type === 'image' && !w.path

/** Problems not already shown by the editors themselves (VideoSettingsForm lists the video rule issues). */
export function draftIssues(p: Preset | null, locale = selectLocale(useStore.getState())): DraftIssue[] {
  if (!p) return []
  const issues: DraftIssue[] = []
  if (!presetName(p, locale).trim()) issues.push({ level: 'error', key: 'presetsView.issueName' })
  if (p.kind === 'video') {
    if (missingLogo(p.settings.watermark)) issues.push({ level: 'error', key: 'presetsView.issueLogo' })
  } else {
    if (p.actions.some((a: ImageAction) => a.enabled && a.type === 'watermark' && missingLogo(a.watermark))) issues.push({ level: 'error', key: 'presetsView.issueLogo' })
    if (!p.actions.some((a) => a.enabled) && p.output.format === 'keep') issues.push({ level: 'warning', key: 'presetsView.issueNoop' })
  }
  return issues
}

/** True when the draft cannot be saved (error-level problems, including video rule errors). */
export function hasBlockingIssues(p: Preset | null): boolean {
  if (!p) return true
  if (draftIssues(p).some((i) => i.level === 'error')) return true
  return p.kind === 'video' && validateVideoSettings(p.settings).some((i) => i.level === 'error')
}

function presetsOfKind(kind: PresetKind): Preset[] {
  return useStore.getState().presets.filter((p) => p.kind === kind)
}

function load(p: Preset): void {
  const draft = clone(p)
  set({ kind: p.kind, selectedId: p.id, draft, baseline: stableStringify(draft) })
}

/** Ask before throwing away unsaved edits. Resolves true when it is OK to continue. */
export async function confirmDiscard(): Promise<boolean> {
  const s = get()
  if (!isDirty(s) || !s.draft) return true
  const locale = selectLocale(useStore.getState())
  return confirmDialog({
    title: tNow('presetsView.discardTitle'),
    message: tNow('presetsView.discardBody', { name: presetName(s.draft, locale) || tNow('presetsView.untitled') }),
    confirmLabel: tNow('presetsView.discard'),
    danger: true,
  })
}

/** Pick an initial / fallback selection for the current kind. */
export function ensureSelection(): void {
  const s = get()
  const { presets, settings } = useStore.getState()
  if (s.draft && s.selectedId === null) return // unsaved new preset
  if (s.selectedId && presets.some((p) => p.id === s.selectedId && p.kind === s.kind)) {
    // keep the draft, but pick up external changes when it is clean
    if (!isDirty(s)) {
      const cur = presets.find((p) => p.id === s.selectedId)!
      if (stableStringify(cur) !== s.baseline) load(cur)
    }
    return
  }
  const list = presetsOfKind(s.kind)
  const last = s.kind === 'video' ? settings.lastVideoPresetId : settings.lastImagePresetId
  const pick = list.find((p) => p.id === last) ?? list[0]
  if (pick) load(pick)
  else set({ selectedId: null, draft: null, baseline: '' })
}

export async function selectPreset(id: string): Promise<void> {
  if (id === get().selectedId) return
  const p = useStore.getState().presets.find((x) => x.id === id)
  if (!p) return
  if (!(await confirmDiscard())) return
  load(p)
}

export async function switchKind(kind: PresetKind): Promise<void> {
  if (kind === get().kind) return
  if (!(await confirmDiscard())) return
  set({ kind, selectedId: null, draft: null, baseline: '' })
  ensureSelection()
}

export function updateDraft(p: Preset): void {
  set({ draft: p })
}

export function revertDraft(): void {
  const s = get()
  if (s.selectedId === null) {
    set({ draft: null, baseline: '' })
    ensureSelection()
    return
  }
  const p = useStore.getState().presets.find((x) => x.id === s.selectedId)
  if (p) load(p)
}

export async function newPreset(): Promise<void> {
  if (!(await confirmDiscard())) return
  const kind = get().kind
  const draft = kind === 'video' ? newVideoPreset(tNow('presetsView.newVideoName')) : newImagePreset(tNow('presetsView.newImageName'))
  set({ selectedId: null, draft, baseline: '' })
}

export async function saveDraft(): Promise<void> {
  const s = get()
  const draft = s.draft
  if (!draft || s.saving || hasBlockingIssues(draft)) return
  if (!draft.builtIn && !isDirty(s)) return // nothing to save (same rule as the Save button)
  const locale = selectLocale(useStore.getState())
  const wasBuiltIn = draft.builtIn
  const payload: Preset = { ...clone(draft), name: presetName(draft, locale).trim() }
  // Built-in with an untouched (localised) name: send the original so main names the copy "<name> (copy)" itself.
  if (wasBuiltIn && draft.names) payload.name = draft.name
  if (!wasBuiltIn) payload.names = undefined
  // keep the description the user saw (localised) instead of the English fallback
  payload.description = presetDescription(draft, locale) || undefined
  payload.descriptions = undefined
  set({ saving: true })
  const saved = await guard(() => api.savePreset(payload), 'presetsView.saveFailed')
  set({ saving: false })
  if (!saved) return
  await refreshPresets()
  load(saved)
  toast('success', tNow(wasBuiltIn ? 'presetsView.savedAsNew' : 'presetsView.saved', { name: presetName(saved, locale) }))
}

export async function duplicatePreset(): Promise<void> {
  const s = get()
  if (!s.selectedId) return
  const src = useStore.getState().presets.find((p) => p.id === s.selectedId)
  if (!src) return
  if (!(await confirmDiscard())) return
  const locale = selectLocale(useStore.getState())
  const copy: Preset = {
    ...clone(src),
    id: '',
    builtIn: false,
    names: undefined,
    descriptions: undefined,
    description: presetDescription(src, locale) || undefined,
    name: tNow('presetsView.copyName', { name: presetName(src, locale) }),
  }
  const saved = await guard(() => api.savePreset(copy), 'presetsView.saveFailed')
  if (!saved) return
  await refreshPresets()
  load(saved)
  toast('success', tNow('presetsView.duplicated', { name: presetName(saved, locale) }))
}

export async function deleteSelected(): Promise<void> {
  const s = get()
  const { presets, watchFolders } = useStore.getState()
  const p = presets.find((x) => x.id === s.selectedId)
  if (!p || p.builtIn) return
  const locale = selectLocale(useStore.getState())
  const usedBy = watchFolders.filter((w) => w.presetIds.includes(p.id)).length
  const ok = await confirmDialog({
    title: tNow('presetsView.deleteTitle'),
    message: tNow('presetsView.deleteBody', { name: presetName(p, locale) }) + (usedBy ? ' ' + tNow('presetsView.deleteUsedBy', { n: usedBy }) : ''),
    confirmLabel: tNow('presetsView.delete'),
    danger: true,
  })
  if (!ok) return
  const ofKind = presets.filter((x) => x.kind === p.kind)
  const idx = ofKind.findIndex((x) => x.id === p.id)
  const res = await guard(() => api.deletePreset(p.id).then(() => true), 'presetsView.deleteFailed')
  if (!res) return
  const fresh = await refreshPresets()
  const remaining = fresh.filter((x) => x.kind === p.kind)
  const next = remaining[Math.min(idx, remaining.length - 1)]
  if (next) load(next)
  else set({ selectedId: null, draft: null, baseline: '' })
  toast('success', tNow('presetsView.deleted', { name: presetName(p, locale) }))
}

export async function importPresetFile(): Promise<void> {
  if (!(await confirmDiscard())) return
  const imported = await guard(() => api.importPresets(), 'presetsView.importFailed')
  if (!imported?.length) return
  await refreshPresets()
  load(imported[0])
  toast('success', tNow('presetsView.imported', { n: imported.length }))
}

export async function exportPresetFile(ids: string[]): Promise<void> {
  if (!ids.length) return
  const ok = await guard(() => api.exportPresets(ids), 'presetsView.exportFailed')
  if (ok) toast('success', tNow('presetsView.exported', { n: ids.length }))
}

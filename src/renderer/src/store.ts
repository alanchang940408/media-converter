// Global UI state (zustand) + actions that wrap window.api calls with error toasts.
import { useMemo } from 'react'
import { create } from 'zustand'
import type {
  AppInfo,
  AppSettings,
  EncoderCapabilities,
  FileOpUndoInfo,
  Job,
  JobPatch,
  Locale,
  Preset,
  QueueEvent,
  WatchFolder,
} from '../../shared/types'
import { api } from './api'
import { LOCALE_HTML_LANG as LOCALE_TAGS, makeT, type MessageKey, type TFunc } from './i18n'
import { fileName } from './lib/format'
import { errorCodeMessage, friendlyRawError } from './lib/jobError'

export type View = 'queue' | 'batch' | 'presets' | 'watch'
export type SettingsTab = 'general' | 'output' | 'performance' | 'about'

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
  detail?: string
  action?: ToastAction
}

/** A file or folder chosen in the batch rename / copy / move dialog. */
export interface FileOpsEntry {
  path: string
  isFolder: boolean
}

export interface DialogRequest {
  kind: 'confirm' | 'prompt'
  title: string
  message?: string
  label?: string
  value?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (v: string | boolean | null) => void
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'auto',
  theme: 'dark',
  videoConcurrency: 1,
  imageConcurrency: 4,
  autoStart: false,
  defaultOutputDir: null,
  defaultNameTemplate: '{name}',
  conflict: 'rename',
  preferredHw: 'auto',
  lastVideoPresetId: '',
  lastImagePresetId: '',
  lastFilePresetId: '',
  preserveStructure: true,
  notifyOnFinish: true,
  preventSleep: true,
  removeFinished: false,
  ffmpegPath: null,
  autoCheckUpdates: true,
}

export interface AppState {
  ready: boolean
  loadError: string | null
  appInfo: AppInfo | null
  caps: EncoderCapabilities | null
  capsLoading: boolean
  settings: AppSettings
  presets: Preset[]
  jobs: Job[]
  running: boolean
  watchFolders: WatchFolder[]
  view: View
  selected: string[]
  anchor: string | null
  editorJobId: string | null
  /** Jobs selected together with the edited one (multi-selection "Edit settings"); empty = single job. */
  editorGroup: string[]
  previewJobId: string | null
  settingsTab: SettingsTab | null
  presetBrowserOpen: boolean
  toasts: Toast[]
  dialog: DialogRequest | null
  /** Batch rename / copy / move dialog: open while non-null, holds the chosen files and folders. */
  fileOps: { entries: FileOpsEntry[] }
  /** Last move/rename run that can be undone (null when none, or when main does not support it). */
  fileOpUndo: FileOpUndoInfo | null
  /** The last undo that went through: which journal entry, how many files came back and how many did not. */
  fileOpUndone: { id: string; restored: number; failed: number } | null
}

const LS_BROWSER = 'mc-preset-browser-open'

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export const useStore = create<AppState>(() => ({
  ready: false,
  loadError: null,
  appInfo: null,
  caps: null,
  capsLoading: false,
  settings: DEFAULT_SETTINGS,
  presets: [],
  jobs: [],
  running: false,
  watchFolders: [],
  view: 'queue',
  selected: [],
  anchor: null,
  editorJobId: null,
  editorGroup: [],
  previewJobId: null,
  settingsTab: null,
  presetBrowserOpen: readBool(LS_BROWSER, true),
  toasts: [],
  dialog: null,
  fileOps: { entries: [] },
  fileOpUndo: null,
  fileOpUndone: null,
}))

const set = useStore.setState
const get = useStore.getState

// ───────────────────────────── i18n hooks ─────────────────────────────

export function selectLocale(s: AppState): Locale {
  if (s.settings.language !== 'auto') return s.settings.language
  return s.appInfo?.locale ?? 'zh-TW'
}

export function useLocale(): Locale {
  return useStore(selectLocale)
}

export function useT(): TFunc {
  const locale = useLocale()
  return useMemo(() => makeT(locale), [locale])
}

/** Translate outside React (actions, toasts). */
export function tNow(key: MessageKey, params?: Record<string, string | number>): string {
  return makeT(selectLocale(get()))(key, params)
}

// ───────────────────────────── toasts / dialogs ─────────────────────────────

let toastSeq = 0

export function toast(kind: Toast['kind'], text: string, detail?: string, action?: ToastAction): number {
  const id = ++toastSeq
  set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text, detail, action }] }))
  setTimeout(() => dismissToast(id), action ? 12000 : kind === 'error' ? 8000 : 4000)
  return id
}

export function dismissToast(id: number): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(err)
}

/** Run an api call; failures become an error toast instead of an unhandled rejection. */
export async function guard<T>(fn: () => Promise<T>, failKey: MessageKey = 'toast.actionFailed'): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    console.error(err)
    const raw = errorText(err)
    const friendly = friendlyRawError(raw, tNow)
    toast('error', tNow(failKey), friendly ? `${friendly}\n${raw}` : raw)
    return undefined
  }
}

export function confirmDialog(opts: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    set({ dialog: { kind: 'confirm', ...opts, resolve: (v) => resolve(v === true) } })
  })
}

export function promptDialog(opts: { title: string; label?: string; value?: string; confirmLabel?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    set({ dialog: { kind: 'prompt', ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) } })
  })
}

export function closeDialog(value: string | boolean | null): void {
  const d = get().dialog
  set({ dialog: null })
  d?.resolve(value)
}

// ───────────────────────────── loading ─────────────────────────────

function setJobs(jobs: Job[], running?: boolean): void {
  set((s) => {
    const ids = new Set(jobs.map((j) => j.id))
    const selected = s.selected.filter((id) => ids.has(id))
    return {
      jobs,
      running: running ?? s.running,
      selected,
      anchor: s.anchor && ids.has(s.anchor) ? s.anchor : null,
      editorJobId: s.editorJobId && ids.has(s.editorJobId) ? s.editorJobId : null,
      previewJobId: s.previewJobId && ids.has(s.previewJobId) ? s.previewJobId : null,
    }
  })
}

function onQueueEvent(e: QueueEvent): void {
  if (e.type === 'snapshot') {
    setJobs(e.state.jobs, e.state.running)
  } else if (e.type === 'progress') {
    const map = new Map(e.items.map((i) => [i.id, i]))
    set((s) => ({
      jobs: s.jobs.map((j) => {
        const p = map.get(j.id)
        return p && j.status === 'running' ? { ...j, ...p } : j
      }),
    }))
  } else if (e.type === 'finished') {
    const { done, failed, cancelled, skipped } = e.summary
    void refreshFileOpUndo(true).then((announced) => {
      // a run of only renames / moves that all worked: the "Renamed n files · Undo" toast already says it all
      if (announced && announced.count === done && !failed && !cancelled && !skipped) return
      toast(failed ? 'error' : 'success', tNow('toast.queueFinished', { done, failed }), cancelled || skipped ? tNow('toast.queueFinishedExtra', { cancelled, skipped }) : undefined)
    })
  }
}

export async function init(): Promise<() => void> {
  const unsubs: (() => void)[] = []
  unsubs.push(api.onQueueEvent(onQueueEvent))
  unsubs.push(
    api.onExternalFiles((paths) => {
      set({ view: 'queue' })
      void addPaths(paths, true)
    }),
  )
  try {
    const [appInfo, settings, presets, queue, watchFolders] = await Promise.all([
      api.getAppInfo(),
      api.getSettings(),
      api.listPresets(),
      api.getQueue(),
      api.listWatchFolders(),
    ])
    set({ appInfo, settings: { ...DEFAULT_SETTINGS, ...settings }, presets, watchFolders, ready: true })
    setJobs(queue.jobs, queue.running)
  } catch (err) {
    console.error(err)
    set({ ready: true, loadError: errorText(err) })
  }
  void refreshCaps(false)
  void refreshFileOpUndo(false)
  return () => unsubs.forEach((u) => u())
}

export async function refreshCaps(force: boolean): Promise<void> {
  set({ capsLoading: true })
  const caps = await guard(() => api.getCapabilities(force), 'toast.capsFailed')
  set((s) => ({ caps: caps ?? s.caps, capsLoading: false }))
  if (caps && force) toast('success', tNow('toast.capsRefreshed'))
}

export async function refreshPresets(): Promise<Preset[]> {
  const presets = await guard(() => api.listPresets())
  if (presets) set({ presets })
  return presets ?? get().presets
}

export async function refreshQueue(): Promise<void> {
  const q = await guard(() => api.getQueue())
  if (q) setJobs(q.jobs, q.running)
}

export async function refreshWatchFolders(): Promise<void> {
  const list = await guard(() => api.listWatchFolders())
  if (list) set({ watchFolders: list })
}

// ───────────────────────────── settings ─────────────────────────────

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
  const prev = get().settings
  set({ settings: { ...prev, ...patch } })
  const saved = await guard(() => api.saveSettings(patch), 'toast.settingsFailed')
  if (saved) set({ settings: saved })
  else set({ settings: prev })
}

// ───────────────────────────── queue actions ─────────────────────────────

export async function addPaths(paths: string[], recursive = true): Promise<void> {
  if (!paths.length) return
  const res = await guard(() => api.addJobs({ paths, recursive }), 'toast.addFailed')
  if (!res) return
  const added = res.jobs.length
  const ignored = res.ignored.length
  if (added && ignored) toast('info', tNow('toast.addedIgnored', { added, ignored }), res.ignored.slice(0, 4).map(fileName).join(', ') + (ignored > 4 ? ' …' : ''))
  else if (added) toast('success', tNow('toast.added', { added }))
  else if (ignored) toast('error', tNow('toast.nothingAdded', { ignored }), res.ignored.slice(0, 4).map(fileName).join(', ') + (ignored > 4 ? ' …' : ''))
  await refreshQueue()
  if (added) set({ selected: res.jobs.map((j) => j.id), anchor: res.jobs[0]?.id ?? null })
}

export async function addFilesDialog(): Promise<void> {
  const paths = await guard(() => api.pickFiles('media', true))
  if (paths?.length) await addPaths(paths, false)
}

export async function addFolderDialog(): Promise<void> {
  const dir = await guard(() => api.pickFolder(tNow('dialog.addFolderTitle')))
  if (dir) await addPaths([dir], true)
}

export async function removeJobs(ids: string[], confirmed = false): Promise<void> {
  if (!ids.length) return
  const running = get().jobs.filter((j) => ids.includes(j.id) && j.status === 'running')
  if (running.length && !confirmed) {
    const ok = await confirmDialog({
      title: tNow('confirm.removeRunningTitle'),
      message: tNow('confirm.removeRunningBody', { n: running.length }),
      confirmLabel: tNow('common.remove'),
      danger: true,
    })
    if (!ok) return
  }
  await guard(() => api.removeJobs(ids))
  await refreshQueue()
}

/** Remove several jobs after one confirmation that states the count (and the running ones, if any). */
export async function removeJobsConfirm(ids: string[]): Promise<void> {
  if (ids.length < 2) return removeJobs(ids)
  const running = get().jobs.filter((j) => ids.includes(j.id) && j.status === 'running').length
  const ok = await confirmDialog({
    title: tNow('confirm.removeManyTitle', { n: ids.length }),
    message: tNow('confirm.removeManyBody') + (running ? '\n' + tNow('confirm.removeRunningBody', { n: running }) : ''),
    confirmLabel: tNow('common.remove'),
    danger: true,
  })
  if (ok) await removeJobs(ids, true)
}

export async function duplicateJobs(ids: string[]): Promise<void> {
  if (!ids.length) return
  await guard(() => api.duplicateJobs(ids))
  await refreshQueue()
}

export async function clearFinished(): Promise<void> {
  await guard(() => api.clearFinished())
  await refreshQueue()
}

export async function retryJobs(ids: string[]): Promise<void> {
  await guard(() => api.retryJobs(ids))
  await refreshQueue()
}

export async function cancelJobs(ids: string[]): Promise<void> {
  await guard(() => api.cancelJobs(ids))
  await refreshQueue()
}

export async function reorderJobs(ids: string[]): Promise<void> {
  const byId = new Map(get().jobs.map((j) => [j.id, j]))
  set({ jobs: ids.map((id) => byId.get(id)).filter((j): j is Job => !!j) })
  await guard(() => api.reorderJobs(ids))
  await refreshQueue()
}

export async function applyPreset(ids: string[], presetId: string): Promise<boolean> {
  if (!ids.length) return false
  const ok = await guard(() => api.applyPreset(ids, presetId).then(() => true))
  await refreshQueue()
  return !!ok
}

export async function updateJob(id: string, patch: JobPatch): Promise<Job | undefined> {
  const job = await guard(() => api.updateJob(id, patch), 'toast.updateFailed')
  await refreshQueue()
  return job
}

/** Start the queue; with `jobIds` only those queued jobs (see MediaApi.startQueue). */
export async function startQueue(jobIds?: string[]): Promise<void> {
  await guard(() => api.startQueue(jobIds))
  await refreshQueue()
}

export async function stopQueue(): Promise<void> {
  await guard(() => api.stopQueue())
  await refreshQueue()
}

export async function setJobsOutputDir(ids: string[], dir: string | null): Promise<void> {
  let changed = 0
  const { jobs, settings } = get()
  for (const id of ids) {
    const job = jobs.find((j) => j.id === id)
    // Jobs that never had a folder pick up the "keep folder structure" default when they get one.
    const output: JobPatch['output'] = dir && job && job.output.preserveStructure == null ? { dir, preserveStructure: settings.preserveStructure } : { dir }
    const r = await guard(() => api.updateJob(id, { output }), 'toast.updateFailed')
    if (r) changed++
  }
  await refreshQueue()
  if (changed) toast('success', tNow('toast.outputChanged', { n: changed }))
}

export async function setJobsPreserveStructure(ids: string[], preserveStructure: boolean): Promise<void> {
  for (const id of ids) await guard(() => api.updateJob(id, { output: { preserveStructure } }), 'toast.updateFailed')
  await refreshQueue()
}

// ───────────────────────────── file operations (batch rename / copy / move) ─────────────────────────────

/** Switch to the "Batch rename" tab, adding `entries` to its file list. */
export function openFileOps(entries: FileOpsEntry[] = []): void {
  set((s) => ({ fileOps: { entries: dedupeEntries([...s.fileOps.entries, ...entries]) }, editorJobId: null, previewJobId: null, view: 'batch' }))
}

function dedupeEntries(list: FileOpsEntry[]): FileOpsEntry[] {
  const seen = new Set<string>()
  return list.filter((e) => {
    const k = e.path.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function addFileOpsEntries(entries: FileOpsEntry[]): void {
  set((s) => ({ fileOps: { entries: dedupeEntries([...s.fileOps.entries, ...entries]) } }))
}

export function removeFileOpsEntry(path: string): void {
  set((s) => ({ fileOps: { entries: s.fileOps.entries.filter((e) => e.path !== path) } }))
}

export function clearFileOpsEntries(): void {
  set({ fileOps: { entries: [] } })
}

let undoToastId: number | null = null
let undoToastFor: string | null = null

/**
 * Reload the undo journal info. With `announce`, a run that produced a new journal entry shows a toast with
 * an Undo button and the entry is returned. Errors are ignored quietly (older main processes do not have the method).
 */
export async function refreshFileOpUndo(announce: boolean): Promise<FileOpUndoInfo | null> {
  const prev = get().fileOpUndo
  let info: FileOpUndoInfo | null = null
  try {
    info = await api.getFileOpUndo()
  } catch (err) {
    console.warn('getFileOpUndo failed', err)
    info = null
  }
  set({ fileOpUndo: info })
  // the "Undo" toast only makes sense while that journal entry is still the one main would undo
  if (undoToastId != null && info?.id !== undoToastFor) dismissUndoToast()
  if (announce && info && info.id !== prev?.id) {
    const mixed = info.operations.rename > 0 && info.operations.move > 0
    const title = mixed ? 'fileop.undoToast' : info.operations.move ? 'fileop.undoToastMoved' : 'fileop.undoToastRenamed'
    undoToastId = toast('success', tNow(title, { n: info.count }), mixed ? fileOpUndoDetail(info) : undefined, {
      label: tNow('fileop.undoAction'),
      run: () => void undoLastFileOp(),
    })
    undoToastFor = info.id
    return info
  }
  return null
}

function dismissUndoToast(): void {
  if (undoToastId != null) dismissToast(undoToastId)
  undoToastId = null
  undoToastFor = null
}

function fileOpUndoDetail(info: FileOpUndoInfo): string {
  const parts: string[] = []
  if (info.operations.rename) parts.push(tNow('fileop.undoRenamed', { n: info.operations.rename }))
  if (info.operations.move) parts.push(tNow('fileop.undoMoved', { n: info.operations.move }))
  return parts.join(' · ')
}

let undoing = false

export async function undoLastFileOp(): Promise<void> {
  const info = get().fileOpUndo
  if (!info || undoing) return
  const time = new Date(info.finishedAt).toLocaleTimeString(LOCALE_TAGS[selectLocale(get())], { hour: '2-digit', minute: '2-digit' })
  const mixed = info.operations.rename > 0 && info.operations.move > 0
  const detail = mixed ? tNow('fileop.undoDetailParen', { detail: fileOpUndoDetail(info) }) : ''
  const ok = await confirmDialog({
    title: tNow('fileop.undoConfirmTitle', { n: info.count }),
    message: tNow('fileop.undoConfirmBody', { n: info.count, time, detail }),
    confirmLabel: tNow('fileop.undoConfirm'),
  })
  if (!ok) return
  undoing = true
  dismissUndoToast()
  try {
    const res = await guard(() => api.undoFileOps(), 'fileop.undoFailed')
    if (res) {
      const failed = res.failed.length
      set({ fileOpUndone: { id: info.id, restored: res.restored, failed } })
      if (!failed) toast('success', tNow('fileop.undoDone', { n: res.restored }))
      else
        toast(
          'error',
          tNow('fileop.undoPartial', { n: res.restored, failed }),
          res.failed
            .slice(0, 5)
            .map((f) => `${fileName(f.path)}: ${errorCodeMessage(f.errorCode, { name: fileName(f.path) }, tNow) ?? f.error}`)
            .join('\n') + (failed > 5 ? '\n…' : ''),
        )
    }
  } finally {
    undoing = false
  }
  await refreshFileOpUndo(false)
  await refreshQueue()
}

// ───────────────────────────── selection / navigation ─────────────────────────────

export function selectJobs(ids: string[], anchor?: string | null): void {
  set((s) => ({ selected: ids, anchor: anchor === undefined ? s.anchor : anchor }))
}

export function setView(view: View): void {
  set({ view })
}

export function openSettings(tab: SettingsTab = 'general'): void {
  set({ settingsTab: tab })
}

export function openPreview(jobId: string): void {
  set({ previewJobId: jobId, editorJobId: null })
}

export function closePreview(): void {
  set({ previewJobId: null })
}

export function openEditor(jobId: string, group: string[] = []): void {
  set({ editorJobId: jobId, editorGroup: group, previewJobId: null })
}

export function closeEditor(): void {
  set({ editorJobId: null })
}

/** Save a preset (new user preset when id is empty or built-in) and refresh the list. */
export async function savePreset(preset: Preset): Promise<Preset | undefined> {
  const saved = await guard(() => api.savePreset(preset))
  if (saved) await refreshPresets()
  return saved
}

export function togglePresetBrowser(open?: boolean): void {
  const v = open ?? !get().presetBrowserOpen
  writeBool(LS_BROWSER, v)
  set({ presetBrowserOpen: v })
}

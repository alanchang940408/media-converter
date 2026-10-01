// Watch-folder actions: optimistic store update + api call wrapped in guard().
import type { WatchFolder } from '../../../../shared/types'
import { api } from '../../api'
import { confirmDialog, guard, refreshWatchFolders, tNow, toast, useStore } from '../../store'
import { fileName } from '../../lib/format'

const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

export async function saveWatchFolder(w: WatchFolder): Promise<boolean> {
  useStore.setState((s) => ({ watchFolders: s.watchFolders.map((x) => (x.id === w.id ? w : x)) }))
  const saved = await guard(() => api.saveWatchFolder(w), 'watch.saveFailed')
  await refreshWatchFolders()
  return !!saved
}

function defaultPresetIds(): string[] {
  const { presets, settings } = useStore.getState()
  const video = presets.find((p) => p.id === settings.lastVideoPresetId && p.kind === 'video') ?? presets.find((p) => p.kind === 'video')
  const image = presets.find((p) => p.id === settings.lastImagePresetId && p.kind === 'image') ?? presets.find((p) => p.kind === 'image')
  return [video?.id, image?.id].filter((x): x is string => !!x)
}

export async function addWatchFolder(): Promise<void> {
  const dir = await guard(() => api.pickFolder(tNow('watch.pickTitle')))
  if (!dir) return
  const existing = useStore.getState().watchFolders.find((w) => samePath(w.path, dir))
  if (existing) {
    toast('info', tNow('watch.alreadyWatched', { name: fileName(dir) || dir }))
    return
  }
  const w: WatchFolder = {
    id: '',
    path: dir,
    enabled: true,
    presetIds: defaultPresetIds(),
    outputDir: null,
    includeSubfolders: false,
    afterProcess: 'keep',
    processExisting: false,
  }
  const saved = await guard(() => api.saveWatchFolder(w), 'watch.saveFailed')
  await refreshWatchFolders()
  if (saved) toast('success', tNow('watch.added', { name: fileName(saved.path) || saved.path }))
}

export async function changeWatchPath(w: WatchFolder): Promise<void> {
  const dir = await guard(() => api.pickFolder(tNow('watch.pickTitle')))
  if (!dir || samePath(dir, w.path)) return
  if (useStore.getState().watchFolders.some((x) => x.id !== w.id && samePath(x.path, dir))) {
    toast('info', tNow('watch.alreadyWatched', { name: fileName(dir) || dir }))
    return
  }
  await saveWatchFolder({ ...w, path: dir })
}

export async function changeWatchOutput(w: WatchFolder): Promise<void> {
  const dir = await guard(() => api.pickFolder(tNow('watch.pickOutputTitle')))
  if (!dir) return
  if (samePath(dir, w.path)) {
    toast('error', tNow('watch.outputIsSource'))
    return
  }
  await saveWatchFolder({ ...w, outputDir: dir })
}

export async function deleteWatchFolder(w: WatchFolder): Promise<void> {
  const ok = await confirmDialog({
    title: tNow('watch.deleteTitle'),
    message: tNow('watch.deleteBody', { path: w.path }),
    confirmLabel: tNow('watch.delete'),
    danger: true,
  })
  if (!ok) return
  const res = await guard(() => api.deleteWatchFolder(w.id).then(() => true), 'watch.deleteFailed')
  await refreshWatchFolders()
  if (res) toast('success', tNow('watch.deleted', { name: fileName(w.path) || w.path }))
}

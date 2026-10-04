// Exposes window.api (MediaApi) to the sandboxed renderer. Bundled to CommonJS (index.cjs):
// only 'electron' is required at runtime; IPC channel names are inlined by the bundler.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type InvokeMethod, type MediaApi, type UpdateEvent } from '../shared/api'
import type { BridgeRequestEvent, QueueEvent } from '../shared/types'

/** ipcRenderer.invoke wraps errors as "Error invoking remote method 'mc:invoke': Error: <msg>" — keep only <msg>. */
function cleanError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  return new Error(msg.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, ''))
}

function invoke<K extends InvokeMethod>(method: K) {
  return (...args: Parameters<MediaApi[K]>): ReturnType<MediaApi[K]> =>
    ipcRenderer.invoke(IPC.invoke, method, ...args).catch((err: unknown) => {
      throw cleanError(err)
    }) as ReturnType<MediaApi[K]>
}

// External files can arrive before React subscribes: buffer them until the first listener.
const externalListeners = new Set<(paths: string[]) => void>()
let pendingExternal: string[][] = []
ipcRenderer.on(IPC.externalFiles, (_e: IpcRendererEvent, paths: string[]) => {
  if (!Array.isArray(paths) || !paths.length) return
  if (!externalListeners.size) {
    pendingExternal.push(paths)
    return
  }
  for (const cb of externalListeners) cb(paths)
})

// Requests from the Adobe panel handled at startup can arrive before React subscribes too: buffer them the same way.
const bridgeListeners = new Set<(e: BridgeRequestEvent) => void>()
let pendingBridge: BridgeRequestEvent[] = []
ipcRenderer.on(IPC.bridgeEvent, (_e: IpcRendererEvent, e: BridgeRequestEvent) => {
  if (!e || typeof e !== 'object') return
  if (!bridgeListeners.size) {
    pendingBridge.push(e)
    return
  }
  for (const cb of bridgeListeners) cb(e)
})

const api: MediaApi = {
  getAppInfo: invoke('getAppInfo'),
  getCapabilities: invoke('getCapabilities'),

  pickFiles: invoke('pickFiles'),
  pickFolder: invoke('pickFolder'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  probe: invoke('probe'),
  getThumbnail: invoke('getThumbnail'),
  mediaUrl: (path) => 'media://local/' + encodeURIComponent(path),
  revealInFolder: invoke('revealInFolder'),
  openPath: invoke('openPath'),

  listPresets: invoke('listPresets'),
  savePreset: invoke('savePreset'),
  deletePreset: invoke('deletePreset'),
  importPresets: invoke('importPresets'),
  exportPresets: invoke('exportPresets'),

  getQueue: invoke('getQueue'),
  addJobs: invoke('addJobs'),
  updateJob: invoke('updateJob'),
  applyPreset: invoke('applyPreset'),
  duplicateJobs: invoke('duplicateJobs'),
  removeJobs: invoke('removeJobs'),
  reorderJobs: invoke('reorderJobs'),
  retryJobs: invoke('retryJobs'),
  clearFinished: invoke('clearFinished'),
  startQueue: invoke('startQueue'),
  stopQueue: invoke('stopQueue'),
  cancelJobs: invoke('cancelJobs'),
  onQueueEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, e: QueueEvent): void => cb(e)
    ipcRenderer.on(IPC.queueEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.queueEvent, listener)
    }
  },

  getVideoFrame: invoke('getVideoFrame'),
  previewVideoFrame: invoke('previewVideoFrame'),
  previewImage: invoke('previewImage'),

  previewFileOps: invoke('previewFileOps'),
  getFileOpUndo: invoke('getFileOpUndo'),
  undoFileOps: invoke('undoFileOps'),

  countMediaFiles: invoke('countMediaFiles'),
  listWatchFolders: invoke('listWatchFolders'),
  saveWatchFolder: invoke('saveWatchFolder'),
  deleteWatchFolder: invoke('deleteWatchFolder'),

  getSettings: invoke('getSettings'),
  saveSettings: invoke('saveSettings'),

  getUpdateState: invoke('getUpdateState'),
  checkForUpdates: invoke('checkForUpdates'),
  installUpdateNow: invoke('installUpdateNow'),
  openReleasePage: invoke('openReleasePage'),
  onUpdateEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, e: UpdateEvent): void => cb(e)
    ipcRenderer.on(IPC.updateEvent, listener)
    return () => {
      ipcRenderer.removeListener(IPC.updateEvent, listener)
    }
  },

  getAdobePanelStatus: invoke('getAdobePanelStatus'),
  installAdobePanel: invoke('installAdobePanel'),
  uninstallAdobePanel: invoke('uninstallAdobePanel'),
  openBridgeFolder: invoke('openBridgeFolder'),
  onBridgeEvent: (cb) => {
    // one entry per subscription, even when the same callback subscribes twice
    const listener = (e: BridgeRequestEvent): void => cb(e)
    bridgeListeners.add(listener)
    if (pendingBridge.length) {
      const queued = pendingBridge
      pendingBridge = []
      queueMicrotask(() => {
        for (const e of queued) listener(e)
      })
    }
    return () => {
      bridgeListeners.delete(listener)
    }
  },

  onExternalFiles: (cb) => {
    externalListeners.add(cb)
    if (pendingExternal.length) {
      const queued = pendingExternal
      pendingExternal = []
      queueMicrotask(() => {
        for (const paths of queued) cb(paths)
      })
    }
    return () => {
      externalListeners.delete(cb)
    }
  },
}

contextBridge.exposeInMainWorld('api', api)

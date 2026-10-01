// PLACEHOLDER — replaced by the core implementation (exposes window.api: MediaApi).
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', undefined)

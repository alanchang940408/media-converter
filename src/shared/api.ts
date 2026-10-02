// The API the preload script exposes to the renderer as `window.api`.
// Implemented by src/preload/index.ts (ipcRenderer.invoke → src/main/ipc.ts handlers)
// and by src/renderer/src/mockApi.ts (browser-only dev mode, no Electron).
import type {
  AddJobsRequest,
  AddJobsResult,
  AppInfo,
  AppSettings,
  EncoderCapabilities,
  FileKindFilter,
  FileOpPreviewItem,
  FileOpUndoInfo,
  FileOpUndoResult,
  ImageAction,
  ImageOutputSettings,
  ImagePreviewResult,
  Job,
  JobPatch,
  MediaInfo,
  Preset,
  QueueEvent,
  QueueSnapshot,
  VideoPresetSettings,
  WatchFolder,
} from './types'

export interface MediaApi {
  // ── system ──
  getAppInfo(): Promise<AppInfo>
  getCapabilities(refresh?: boolean): Promise<EncoderCapabilities>

  // ── files ──
  /** Native open dialog. Returns absolute paths (empty when cancelled). */
  pickFiles(kind: FileKindFilter, multi?: boolean): Promise<string[]>
  pickFolder(title?: string): Promise<string | null>
  /** Absolute path of a File from a drag-and-drop / <input type=file> (Electron webUtils). Synchronous. */
  getPathForFile(file: File): string
  probe(path: string): Promise<MediaInfo>
  /** data: URL (JPEG) thumbnail for any supported image/video, or null. Cached by main. */
  getThumbnail(path: string, maxSize?: number): Promise<string | null>
  /** URL usable as <video>/<img> src for a local file (custom media:// protocol with Range support). Synchronous. */
  mediaUrl(path: string): string
  revealInFolder(path: string): Promise<void>
  openPath(path: string): Promise<void>

  // ── presets ──
  listPresets(): Promise<Preset[]>
  /** Create (new id when id is empty / unknown) or update a user preset. Built-ins cannot be overwritten (saving a built-in creates a copy). */
  savePreset(preset: Preset): Promise<Preset>
  deletePreset(id: string): Promise<void>
  /** Import presets from a .json file chosen in a dialog. Returns the imported presets. */
  importPresets(): Promise<Preset[]>
  /** Export the given presets to a .json file chosen in a dialog. false when cancelled. */
  exportPresets(ids: string[]): Promise<boolean>

  // ── queue ──
  getQueue(): Promise<QueueSnapshot>
  addJobs(req: AddJobsRequest): Promise<AddJobsResult>
  /** Only queued (or failed/cancelled, which are re-queued) jobs can be patched. */
  updateJob(id: string, patch: JobPatch): Promise<Job>
  /** Apply a preset to many jobs at once (kind-compatible jobs only; others are skipped). */
  applyPreset(jobIds: string[], presetId: string): Promise<void>
  /** Add a copy of each job (same source, same settings) — AME "duplicate" for multiple outputs. */
  duplicateJobs(ids: string[]): Promise<void>
  removeJobs(ids: string[]): Promise<void>
  /** New full order of job ids. */
  reorderJobs(ids: string[]): Promise<void>
  retryJobs(ids: string[]): Promise<void>
  clearFinished(): Promise<void>
  /**
   * Start the queue. With `jobIds` only those queued jobs start (other queued jobs stay queued) and the run ends when
   * they are through; a start without ids during such a run widens it to the whole queue.
   */
  startQueue(jobIds?: string[]): Promise<void>
  /** Stop starting new jobs and cancel running ones (they return to 'queued'). */
  stopQueue(): Promise<void>
  /** Cancel specific running/queued jobs (status → cancelled). */
  cancelJobs(ids: string[]): Promise<void>
  /** Subscribe to queue events. Returns an unsubscribe function. */
  onQueueEvent(cb: (e: QueueEvent) => void): () => void

  // ── preview ──
  /** data: URL (JPEG) of a video frame at timeSec, fit within maxWidth. */
  getVideoFrame(path: string, timeSec: number, maxWidth?: number): Promise<string>
  /** Frame scaled exactly as the preset would scale it, with the preset watermark composited. data: URL. */
  previewVideoFrame(path: string, timeSec: number, settings: VideoPresetSettings, maxWidth?: number): Promise<string>
  previewImage(path: string, actions: ImageAction[], output: ImageOutputSettings, maxSize?: number): Promise<ImagePreviewResult>

  // ── file operations (rename / copy / move jobs) ──
  /** Dry run: where each queued file job would go right now. Touches nothing. */
  previewFileOps(jobIds: string[]): Promise<FileOpPreviewItem[]>
  /** The last undoable move/rename run, or null. */
  getFileOpUndo(): Promise<FileOpUndoInfo | null>
  /** Move files back to where they were before the last move/rename run, then forget that run. */
  undoFileOps(): Promise<FileOpUndoResult>

  // ── watch folders ──
  /** How many supported media files `path` holds (subfolders when `recursive`), not counting its Output / Source subfolders. */
  countMediaFiles(path: string, recursive: boolean): Promise<number>
  listWatchFolders(): Promise<WatchFolder[]>
  saveWatchFolder(w: WatchFolder): Promise<WatchFolder>
  deleteWatchFolder(id: string): Promise<void>

  // ── settings ──
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /** Files opened via OS (argv / second instance / "Open with"). Returns unsubscribe. */
  onExternalFiles(cb: (paths: string[]) => void): () => void
}

/** IPC channel names (main ↔ preload). */
export const IPC = {
  invoke: 'mc:invoke',
  queueEvent: 'mc:queue-event',
  externalFiles: 'mc:external-files',
} as const

/** Methods of MediaApi that go through ipcRenderer.invoke(IPC.invoke, method, ...args). */
export type InvokeMethod = Exclude<keyof MediaApi, 'getPathForFile' | 'mediaUrl' | 'onQueueEvent' | 'onExternalFiles'>

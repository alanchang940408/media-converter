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

  // ── updates (GitHub Releases) ──
  getUpdateState(): Promise<UpdateState>
  /** Check now, also when automatic checks are off. Never rejects for network / GitHub errors: the result has status 'error'. */
  checkForUpdates(): Promise<UpdateState>
  /** Quit and install the downloaded update (installed build, status 'downloaded'). Asks first when the queue is busy. */
  installUpdateNow(): Promise<void>
  /** Open the GitHub release page of the newer version (or the latest release) in the browser. */
  openReleasePage(): Promise<void>
  /** Subscribe to update events. Returns an unsubscribe function. */
  onUpdateEvent(cb: (e: UpdateEvent) => void): () => void
}

/**
 * How this build gets updates:
 * - 'auto': installed Windows build (NSIS); electron-updater downloads in the background, installs on quit or "Restart now"
 * - 'portable': portable exe; only a reminder with a link to the release page
 * - 'manual': other packaged platforms (unsigned macOS, Linux); same as portable
 * - 'disabled': development / unpackaged run
 */
export type UpdateMode = 'auto' | 'portable' | 'manual' | 'disabled'
export type UpdateStatus = 'idle' | 'disabled' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
/** 'not-found': no published release yet, or the repository is private (404/401). */
export type UpdateErrorKind = 'network' | 'not-found' | 'rate-limit' | 'other'

export interface UpdateState {
  mode: UpdateMode
  status: UpdateStatus
  /** Running version (app.getVersion()). */
  currentVersion: string
  /** The newer version, without a leading "v" (available / downloading / downloaded). */
  version?: string
  /** Download progress 0..100 ('downloading'). */
  percent?: number
  /** Release page of the newer version ('portable' / 'manual' modes). */
  url?: string
  /** Why the last check failed (status 'error'). Automatic checks never show it as a toast. */
  error?: { kind: UpdateErrorKind; message: string }
  /** Epoch ms of the last finished check. */
  lastCheckedAt?: number
}

/** Pushed main → renderer; `state` is the full state after the event. */
export type UpdateEvent =
  | { type: 'checking'; state: UpdateState }
  /** `portable`: this build cannot install it itself — download it from `url` (portable exe, or 'manual' mode). */
  | { type: 'available'; version: string; portable: boolean; url?: string; state: UpdateState }
  | { type: 'not-available'; state: UpdateState }
  | { type: 'downloading'; percent: number; state: UpdateState }
  | { type: 'downloaded'; version: string; state: UpdateState }
  | { type: 'error'; message: string; state: UpdateState }

/** IPC channel names (main ↔ preload). */
export const IPC = {
  invoke: 'mc:invoke',
  queueEvent: 'mc:queue-event',
  externalFiles: 'mc:external-files',
  updateEvent: 'mc:update-event',
} as const

/** Methods of MediaApi that go through ipcRenderer.invoke(IPC.invoke, method, ...args). */
export type InvokeMethod = Exclude<keyof MediaApi, 'getPathForFile' | 'mediaUrl' | 'onQueueEvent' | 'onExternalFiles' | 'onUpdateEvent'>

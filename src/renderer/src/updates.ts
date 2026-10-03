// Update state for the header version label, Settings → About "Updates" and the update bar under the header.
// Own small zustand store: main pushes UpdateEvents (each carries the full UpdateState).
// Automatic checks are silent: a failure only changes the status line; the "Check for updates" button is the only
// path that shows a (brief) toast for it.
import { create } from 'zustand'
import type { UpdateErrorKind, UpdateEvent, UpdateState } from '../../shared/api'
import { api } from './api'
import type { MessageKey } from './i18n'
import { guard, toast, tNow } from './store'

export interface UpdateNotice {
  /** 'downloaded': installed build, restart to update; 'portable' / 'manual': download it from the release page */
  kind: 'downloaded' | 'portable' | 'manual'
  version: string
}

interface UpdatesState {
  state: UpdateState | null
  /** The update bar (null = hidden). */
  notice: UpdateNotice | null
  /** A manual check is running. */
  checking: boolean
}

export const useUpdates = create<UpdatesState>(() => ({ state: null, notice: null, checking: false }))

const set = useUpdates.setState
const get = useUpdates.getState

/** Bars the user closed ("Later" / ×) in this session; shown again after the next start. */
const dismissed = new Set<string>()
const noticeKey = (n: UpdateNotice): string => `${n.kind}:${n.version}`

function noticeFor(s: UpdateState): UpdateNotice | null {
  if (!s.version) return null
  if (s.mode === 'auto' && s.status === 'downloaded') return { kind: 'downloaded', version: s.version }
  if ((s.mode === 'portable' || s.mode === 'manual') && s.status === 'available') return { kind: s.mode, version: s.version }
  return null
}

function applyState(s: UpdateState): void {
  const n = noticeFor(s)
  // a later background check that fails keeps an announced version on screen
  set((cur) => ({ state: s, notice: n ? (dismissed.has(noticeKey(n)) ? cur.notice : n) : cur.notice }))
}

function onUpdateEvent(e: UpdateEvent): void {
  if (e && e.state) applyState(e.state)
}

/** Subscribe to main's update events and load the current state. Returns the unsubscribe function. */
export function initUpdates(): () => void {
  let unsub: (() => void) | null = null
  try {
    if (typeof api.onUpdateEvent === 'function') unsub = api.onUpdateEvent(onUpdateEvent)
    if (typeof api.getUpdateState === 'function') {
      void api
        .getUpdateState()
        .then(applyState)
        .catch((err: unknown) => console.warn('getUpdateState failed', err))
    }
  } catch (err) {
    console.warn('update events unavailable', err)
  }
  return () => unsub?.()
}

export function updateErrorKey(kind: UpdateErrorKind | undefined): MessageKey {
  switch (kind) {
    case 'network':
      return 'update.errorNetwork'
    case 'not-found':
      return 'update.errorNotFound'
    case 'rate-limit':
      return 'update.errorRateLimit'
    default:
      return 'update.errorOther'
  }
}

/** "Check for updates" button. */
export async function checkForUpdatesNow(): Promise<void> {
  if (get().checking) return
  set({ checking: true })
  try {
    const s = await api.checkForUpdates()
    applyState(s)
    if (s.status === 'error') toast('error', tNow('update.checkFailed'), tNow(updateErrorKey(s.error?.kind)))
  } catch (err) {
    console.error(err)
    toast('error', tNow('update.checkFailed'), err instanceof Error ? err.message : String(err))
  } finally {
    set({ checking: false })
  }
}

/** Quit and install the downloaded update (main asks first when the queue is busy). */
export async function installUpdateNow(): Promise<void> {
  await guard(() => api.installUpdateNow())
}

export async function openReleasePage(): Promise<void> {
  await guard(() => api.openReleasePage())
}

/** "Later" / ×: hide the bar for this version until the next start (a downloaded update still installs on quit). */
export function dismissUpdateNotice(): void {
  const n = get().notice
  if (n) dismissed.add(noticeKey(n))
  set({ notice: null })
}

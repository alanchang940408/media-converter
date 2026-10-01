// In-app drag & drop state. dataTransfer payloads are unreadable during dragover, so the ids live here.
export const DND_JOBS = 'application/x-mc-jobs'
export const DND_PRESET = 'application/x-mc-preset'

export const dragState: { jobIds: string[] | null; presetId: string | null } = { jobIds: null, presetId: null }

export function hasType(dt: DataTransfer | null, type: string): boolean {
  return !!dt && Array.from(dt.types).includes(type)
}

/** True for OS file drags (not our internal row / preset drags). */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return hasType(dt, 'Files') && !hasType(dt, DND_JOBS) && !hasType(dt, DND_PRESET)
}

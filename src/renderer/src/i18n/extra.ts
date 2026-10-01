// Dictionaries for PresetsView, WatchView and SettingsModal (owned by the views agent).
// Namespaces used here: presetsView.*, watch.*, settings.*
// i18n/index.ts merges these into the main dictionaries; `extraEn` defines the key set,
// the other two must have exactly the same keys.

export const extraEn = {} as const

export const extraZhTW: Record<keyof typeof extraEn, string> = {}

export const extraJa: Record<keyof typeof extraEn, string> = {}

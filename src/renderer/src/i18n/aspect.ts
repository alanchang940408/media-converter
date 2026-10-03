// Dictionaries for non-square-pixel (anamorphic) sources. i18n/index.ts merges these into the main dictionaries;
// `aspectEn` defines the key set.

export const aspectEn = {
  'media.anamorphicSize': '{stored} → {display} displayed (pixel aspect {sar})',
}

export const aspectZhTW: Record<keyof typeof aspectEn, string> = {
  'media.anamorphicSize': '{stored} → 顯示為 {display}（像素比 {sar}）',
}

export const aspectJa: Record<keyof typeof aspectEn, string> = {
  'media.anamorphicSize': '{stored} → 表示 {display}（ピクセル比 {sar}）',
}

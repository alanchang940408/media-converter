// Main-process strings (dialogs, notifications, errors). Pure — no Electron import.
import type { Locale } from '../shared/types'

const en = {
  'dialog.addFiles': 'Add files',
  'dialog.addVideo': 'Add video files',
  'dialog.addImages': 'Add images',
  'dialog.addAudio': 'Add audio files',
  'dialog.chooseWatermark': 'Choose a watermark image',
  'dialog.chooseFolder': 'Choose a folder',
  'dialog.importPresets': 'Import presets',
  'dialog.exportPresets': 'Export presets',
  'filter.media': 'All supported media',
  'filter.video': 'Video',
  'filter.audio': 'Audio',
  'filter.image': 'Images',
  'filter.watermark': 'Watermark images',
  'filter.presets': 'Preset files',
  'filter.all': 'All files',
  'notify.finishedTitle': 'Queue finished',
  'notify.allDone': '{done} file(s) converted.',
  'notify.withFailures': '{done} converted, {failed} failed.',
  'notify.summary': '{done} converted, {failed} failed, {skipped} skipped, {cancelled} cancelled.',
  'quit.title': 'Media Converter',
  'quit.message': 'Encoding is still in progress.',
  'quit.detail': 'Quitting now stops the running jobs and deletes their unfinished output files.',
  'quit.quit': 'Stop and quit',
  'quit.cancel': 'Keep encoding',
  'error.hwFallback': 'Hardware encoder failed, retried with the software encoder.',
  'error.unsupportedFile': 'Unsupported file type: {path}',
  'error.unknownPreset': 'Preset not found: {id}',
  'error.presetKind': 'Preset "{name}" cannot be used for this file type.',
  'error.jobRunning': 'A running job cannot be changed. Stop it first.',
  'error.jobNotFound': 'Job not found.',
  'error.builtInPreset': 'Built-in presets cannot be deleted.',
  'error.invalidPresetFile': 'This file is not a Media Converter preset file.',
  'error.noValidPresets': 'The file contains no valid presets.',
  'error.folderMissing': 'Folder does not exist: {path}',
  'error.outputIsWatchFolder': 'The output folder must be different from the watched folder.',
  'error.noVideoFrame': 'This file has no video to preview.',
  'error.unknownMethod': 'Unknown method: {method}',
  'error.sourceMissing': 'Source file not found: {path}',
  'preset.custom': 'Custom',
  'preset.copySuffix': '{name} (copy)',
  'preset.exportFileName': 'media-converter-presets.json',
}

export type I18nKey = keyof typeof en

const zhTW: Record<I18nKey, string> = {
  'dialog.addFiles': '加入檔案',
  'dialog.addVideo': '加入影片',
  'dialog.addImages': '加入圖片',
  'dialog.addAudio': '加入音訊',
  'dialog.chooseWatermark': '選擇浮水印圖片',
  'dialog.chooseFolder': '選擇資料夾',
  'dialog.importPresets': '匯入預設集',
  'dialog.exportPresets': '匯出預設集',
  'filter.media': '所有支援的媒體',
  'filter.video': '影片',
  'filter.audio': '音訊',
  'filter.image': '圖片',
  'filter.watermark': '浮水印圖片',
  'filter.presets': '預設集檔案',
  'filter.all': '所有檔案',
  'notify.finishedTitle': '佇列已完成',
  'notify.allDone': '已轉換 {done} 個檔案。',
  'notify.withFailures': '已轉換 {done} 個，{failed} 個失敗。',
  'notify.summary': '已轉換 {done} 個，失敗 {failed} 個，略過 {skipped} 個，取消 {cancelled} 個。',
  'quit.title': 'Media Converter',
  'quit.message': '仍有檔案正在轉檔。',
  'quit.detail': '現在結束會停止進行中的工作，並刪除尚未完成的輸出檔。',
  'quit.quit': '停止並結束',
  'quit.cancel': '繼續轉檔',
  'error.hwFallback': '硬體編碼器失敗，已改用軟體編碼器重試。',
  'error.unsupportedFile': '不支援的檔案類型：{path}',
  'error.unknownPreset': '找不到預設集：{id}',
  'error.presetKind': '預設集「{name}」不適用於這種檔案。',
  'error.jobRunning': '進行中的工作無法修改，請先停止。',
  'error.jobNotFound': '找不到這個工作。',
  'error.builtInPreset': '內建預設集無法刪除。',
  'error.invalidPresetFile': '這不是 Media Converter 的預設集檔案。',
  'error.noValidPresets': '檔案中沒有可用的預設集。',
  'error.folderMissing': '資料夾不存在：{path}',
  'error.outputIsWatchFolder': '輸出資料夾不能和監看資料夾相同。',
  'error.noVideoFrame': '這個檔案沒有可預覽的畫面。',
  'error.unknownMethod': '未知的方法：{method}',
  'error.sourceMissing': '找不到來源檔案：{path}',
  'preset.custom': '自訂',
  'preset.copySuffix': '{name}（副本）',
  'preset.exportFileName': 'media-converter-presets.json',
}

const ja: Record<I18nKey, string> = {
  'dialog.addFiles': 'ファイルを追加',
  'dialog.addVideo': '動画を追加',
  'dialog.addImages': '画像を追加',
  'dialog.addAudio': 'オーディオを追加',
  'dialog.chooseWatermark': 'ウォーターマーク画像を選択',
  'dialog.chooseFolder': 'フォルダーを選択',
  'dialog.importPresets': 'プリセットを読み込む',
  'dialog.exportPresets': 'プリセットを書き出す',
  'filter.media': 'サポートされているすべてのメディア',
  'filter.video': '動画',
  'filter.audio': 'オーディオ',
  'filter.image': '画像',
  'filter.watermark': 'ウォーターマーク画像',
  'filter.presets': 'プリセットファイル',
  'filter.all': 'すべてのファイル',
  'notify.finishedTitle': 'キューが完了しました',
  'notify.allDone': '{done} 件のファイルを変換しました。',
  'notify.withFailures': '{done} 件を変換、{failed} 件が失敗しました。',
  'notify.summary': '変換 {done} 件、失敗 {failed} 件、スキップ {skipped} 件、キャンセル {cancelled} 件。',
  'quit.title': 'Media Converter',
  'quit.message': 'まだエンコード中です。',
  'quit.detail': '今終了すると実行中のジョブを停止し、未完成の出力ファイルを削除します。',
  'quit.quit': '停止して終了',
  'quit.cancel': 'エンコードを続ける',
  'error.hwFallback': 'ハードウェアエンコーダーが失敗したため、ソフトウェアエンコーダーで再試行しました。',
  'error.unsupportedFile': 'サポートされていないファイル形式です：{path}',
  'error.unknownPreset': 'プリセットが見つかりません：{id}',
  'error.presetKind': 'プリセット「{name}」はこのファイル形式には使えません。',
  'error.jobRunning': '実行中のジョブは変更できません。先に停止してください。',
  'error.jobNotFound': 'ジョブが見つかりません。',
  'error.builtInPreset': '内蔵プリセットは削除できません。',
  'error.invalidPresetFile': 'Media Converter のプリセットファイルではありません。',
  'error.noValidPresets': '有効なプリセットが含まれていません。',
  'error.folderMissing': 'フォルダーが存在しません：{path}',
  'error.outputIsWatchFolder': '出力フォルダーは監視フォルダーと別にしてください。',
  'error.noVideoFrame': 'このファイルにはプレビューできる映像がありません。',
  'error.unknownMethod': '不明なメソッド：{method}',
  'error.sourceMissing': 'ソースファイルが見つかりません：{path}',
  'preset.custom': 'カスタム',
  'preset.copySuffix': '{name}（コピー）',
  'preset.exportFileName': 'media-converter-presets.json',
}

const dictionaries: Record<Locale, Record<I18nKey, string>> = { en, 'zh-TW': zhTW, ja }

let current: Locale = 'zh-TW'

export function setLocale(locale: Locale): void {
  current = locale
}

export function getLocale(): Locale {
  return current
}

/** Translate with {param} substitution. */
export function t(key: I18nKey, params?: Record<string, string | number>, locale: Locale = current): string {
  const s = dictionaries[locale]?.[key] ?? en[key] ?? key
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (whole, k: string) => (k in params ? String(params[k]) : whole))
}

/** Map an OS locale (e.g. "zh-TW", "zh-Hant-HK", "ja-JP", "en-US") to a supported UI locale. */
export function resolveSystemLocale(osLocale: string): Locale {
  const l = (osLocale || '').toLowerCase()
  if (l.startsWith('zh')) return 'zh-TW'
  if (l.startsWith('ja')) return 'ja'
  return 'en'
}

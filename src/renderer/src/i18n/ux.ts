// Dictionaries for the click-to-apply preset browser, multi-selection actions, watch-folder prompt and batch-rename tab.
// i18n/index.ts merges these into the main dictionaries; `uxEn` defines the key set.

export const uxEn = {
  'browser.skipped': 'Skipped {n} {n|job|jobs} that this preset doesn’t fit or that already started.',
  'browser.noneFit': 'This preset doesn’t fit any of the {n} selected {n|job|jobs} (different type, or already started).',
  'browser.defaultSet': 'Newly added files will use “{name}”.',
  'browser.defaultBadge': 'Default',
  'browser.defaultHint': 'Newly added files use this preset',
  'browser.hintClickApply': 'Click a preset to apply it right away to the {n} selected {n|job|jobs}.',
  'browser.hintClickDefault': 'Nothing selected: clicking a preset makes it the default for newly added files. You can also drag a preset onto a job.',
  'queue.appliesToSelection': 'Applies to the {n} selected jobs',
  'confirm.removeManyTitle': 'Remove {n} jobs from the queue?',
  'confirm.removeManyBody': 'The selected jobs are removed from the queue. Source files are not deleted.',
  'editor.applyToMany': 'Apply to {n} jobs',
  'editor.appliedMany': 'Applied to {n} {n|job|jobs}',
  'editor.groupNote': 'These settings and the output row will be applied to the {n} selected jobs of this type. Trim is not copied; each job keeps its own.',
  'editor.groupSkipped': '{n} selected {n|job is|jobs are} skipped (running, finished, or a different type).',
}

export const uxZhTW: Record<keyof typeof uxEn, string> = {
  'browser.skipped': '略過 {n} 個不適用這個預設集或已開始處理的工作。',
  'browser.noneFit': '選取的 {n} 個工作都不適用這個預設集（類型不同或已開始處理）。',
  'browser.defaultSet': '之後新加入的檔案會使用「{name}」。',
  'browser.defaultBadge': '預設',
  'browser.defaultHint': '新加入的檔案會使用這個預設集',
  'browser.hintClickApply': '點一下預設集，就會立刻套用到選取的 {n} 個工作。',
  'browser.hintClickDefault': '目前沒有選取工作：點一下預設集，會設為之後新加入檔案的預設。也可以把預設集拖曳到工作上。',
  'queue.appliesToSelection': '會套用到選取的 {n} 個工作',
  'confirm.removeManyTitle': '要從佇列移除 {n} 個工作嗎？',
  'confirm.removeManyBody': '選取的工作會從佇列移除，來源檔案不會被刪除。',
  'editor.applyToMany': '套用到 {n} 個工作',
  'editor.appliedMany': '已套用到 {n} 個工作',
  'editor.groupNote': '這些設定和輸出位置會套用到選取的 {n} 個同類型工作。剪輯範圍不會複製，各工作保留自己的設定。',
  'editor.groupSkipped': '選取中有 {n} 個工作正在處理、已完成或類型不同，會略過。',
}

export const uxJa: Record<keyof typeof uxEn, string> = {
  'browser.skipped': 'このプリセットが使えない、または処理が始まっている {n} 件のジョブはスキップしました。',
  'browser.noneFit': '選択中の {n} 件のジョブにはこのプリセットを使えません（種類が違うか、処理が始まっています）。',
  'browser.defaultSet': '新しく追加するファイルには「{name}」を使います。',
  'browser.defaultBadge': '既定',
  'browser.defaultHint': '新しく追加したファイルにはこのプリセットが使われます',
  'browser.hintClickApply': 'プリセットをクリックすると、選択中の {n} 件のジョブにすぐ適用します。',
  'browser.hintClickDefault': 'ジョブを選択していないときは、クリックしたプリセットが新しく追加するファイルの既定になります。プリセットをジョブにドラッグすることもできます。',
  'queue.appliesToSelection': '選択中の {n} 件のジョブに適用します',
  'confirm.removeManyTitle': 'キューから {n} 件のジョブを削除しますか？',
  'confirm.removeManyBody': '選択したジョブをキューから削除します。元のファイルは削除されません。',
  'editor.applyToMany': '{n} 件のジョブに適用',
  'editor.appliedMany': '{n} 件のジョブに適用しました',
  'editor.groupNote': 'この設定と出力先を、選択中の同じ種類のジョブ {n} 件に適用します。トリミング範囲はコピーされず、各ジョブのままです。',
  'editor.groupSkipped': '選択中の {n} 件（処理中・完了済み、または種類が異なるジョブ）はスキップします。',
}

// Dictionaries for Settings → Adobe integration and the "received from Premiere Pro / After Effects" toasts.
// i18n/index.ts merges these into the main dictionaries; `adobeEn` defines the key set.

export const adobeEn = {
  'settings.tabAdobe': 'Adobe integration',
  'adobe.groupPanel': 'Premiere Pro & After Effects panel',
  'adobe.intro':
    'Send sequences from Premiere Pro and compositions from After Effects straight to the Media Converter queue, like Adobe Media Encoder. The panel renders a master file, then Media Converter converts it with the presets you pick.',
  'adobe.openHow': 'In Premiere Pro or After Effects: Window → Extensions → Media Converter.',
  'adobe.statusChecking': 'Checking…',
  'adobe.statusNotBundled': 'This build doesn’t include the panel.',
  'adobe.statusNotInstalled': 'Not installed.',
  'adobe.statusInstalled': 'Installed (version {v}).',
  'adobe.statusUpdate': 'Version {installed} is installed. Version {bundled} is available.',
  'adobe.install': 'Install panel',
  'adobe.update': 'Update panel',
  'adobe.reinstall': 'Reinstall',
  'adobe.uninstall': 'Uninstall',
  'adobe.installPath': 'Install location',
  'adobe.restartNote': 'After installing or updating, restart Premiere Pro / After Effects, then open Window → Extensions → Media Converter.',
  'adobe.installed': 'Panel installed. Restart Premiere Pro / After Effects to use it.',
  'adobe.uninstalled': 'Panel uninstalled.',
  'adobe.installFailed': 'Couldn’t install the panel',
  'adobe.uninstallFailed': 'Couldn’t uninstall the panel',
  'adobe.uninstallConfirmTitle': 'Uninstall the panel?',
  'adobe.uninstallConfirmMessage':
    'Media Converter disappears from Premiere Pro and After Effects after their next restart. Jobs already in the queue are not affected.',
  'adobe.groupBridge': 'Bridge folder',
  'adobe.bridgeDesc':
    'The panel and Media Converter exchange requests through this folder (no network). Rendered master files go into its “intermediates” subfolder; the panel can have them deleted once all of their conversions have succeeded.',
  'adobe.openBridgeFolder': 'Open bridge folder',
  'bridge.received': 'Received {n} conversion {n|job|jobs} from {host}',
  'bridge.rejected': 'Couldn’t queue the files sent from {host}',
  'bridge.hostOther': 'the Adobe panel',
}

export const adobeZhTW: Record<keyof typeof adobeEn, string> = {
  'settings.tabAdobe': 'Adobe 整合',
  'adobe.groupPanel': 'Premiere Pro 與 After Effects 面板',
  'adobe.intro':
    '像 Adobe Media Encoder 一樣，把 Premiere Pro 的序列或 After Effects 的合成直接送進 Media Converter 的佇列。面板會先輸出一個母片，再由 Media Converter 用你選的預設集轉檔。',
  'adobe.openHow': '在 Premiere Pro 或 After Effects 中：視窗 → 擴充功能 → Media Converter。',
  'adobe.statusChecking': '正在檢查…',
  'adobe.statusNotBundled': '這個版本沒有附帶面板。',
  'adobe.statusNotInstalled': '尚未安裝。',
  'adobe.statusInstalled': '已安裝（版本 {v}）。',
  'adobe.statusUpdate': '已安裝版本 {installed}，可以更新為版本 {bundled}。',
  'adobe.install': '安裝面板',
  'adobe.update': '更新面板',
  'adobe.reinstall': '重新安裝',
  'adobe.uninstall': '解除安裝',
  'adobe.installPath': '安裝位置',
  'adobe.restartNote': '安裝或更新後，請重新啟動 Premiere Pro／After Effects，再從「視窗 → 擴充功能 → Media Converter」開啟面板。',
  'adobe.installed': '面板已安裝。重新啟動 Premiere Pro／After Effects 後即可使用。',
  'adobe.uninstalled': '面板已解除安裝。',
  'adobe.installFailed': '無法安裝面板',
  'adobe.uninstallFailed': '無法解除安裝面板',
  'adobe.uninstallConfirmTitle': '要解除安裝面板嗎？',
  'adobe.uninstallConfirmMessage': 'Premiere Pro 和 After Effects 下次重新啟動後就不會再出現 Media Converter 面板。已經在佇列中的工作不受影響。',
  'adobe.groupBridge': '橋接資料夾',
  'adobe.bridgeDesc':
    '面板和 Media Converter 透過這個資料夾交換要求（不經過網路）。面板輸出的母片放在其中的「intermediates」子資料夾，可以設定在所有轉檔都成功後自動刪除。',
  'adobe.openBridgeFolder': '開啟橋接資料夾',
  'bridge.received': '已從 {host} 收到 {n} 個轉檔工作',
  'bridge.rejected': '無法將 {host} 送來的檔案加入佇列',
  'bridge.hostOther': 'Adobe 面板',
}

export const adobeJa: Record<keyof typeof adobeEn, string> = {
  'settings.tabAdobe': 'Adobe 連携',
  'adobe.groupPanel': 'Premiere Pro・After Effects パネル',
  'adobe.intro':
    'Adobe Media Encoder のように、Premiere Pro のシーケンスや After Effects のコンポジションを Media Converter のキューへ直接送れます。パネルがマスターファイルを書き出し、選んだプリセットで Media Converter が変換します。',
  'adobe.openHow': 'Premiere Pro または After Effects で：ウィンドウ → エクステンション → Media Converter。',
  'adobe.statusChecking': '確認しています…',
  'adobe.statusNotBundled': 'このビルドにはパネルが含まれていません。',
  'adobe.statusNotInstalled': 'インストールされていません。',
  'adobe.statusInstalled': 'インストール済み（バージョン {v}）。',
  'adobe.statusUpdate': 'バージョン {installed} がインストールされています。バージョン {bundled} に更新できます。',
  'adobe.install': 'パネルをインストール',
  'adobe.update': 'パネルを更新',
  'adobe.reinstall': '再インストール',
  'adobe.uninstall': 'アンインストール',
  'adobe.installPath': 'インストール先',
  'adobe.restartNote':
    'インストールまたは更新したら Premiere Pro／After Effects を再起動し、「ウィンドウ → エクステンション → Media Converter」を開いてください。',
  'adobe.installed': 'パネルをインストールしました。Premiere Pro／After Effects を再起動すると使えます。',
  'adobe.uninstalled': 'パネルをアンインストールしました。',
  'adobe.installFailed': 'パネルをインストールできませんでした',
  'adobe.uninstallFailed': 'パネルをアンインストールできませんでした',
  'adobe.uninstallConfirmTitle': 'パネルをアンインストールしますか？',
  'adobe.uninstallConfirmMessage':
    '次に再起動したときから、Premiere Pro と After Effects に Media Converter が表示されなくなります。キューにあるジョブには影響しません。',
  'adobe.groupBridge': 'ブリッジフォルダー',
  'adobe.bridgeDesc':
    'パネルと Media Converter はこのフォルダーを通してリクエストをやり取りします（ネットワークは使いません）。書き出したマスターファイルはサブフォルダー「intermediates」に置かれ、すべての変換が成功したあとに削除するようパネルで指定できます。',
  'adobe.openBridgeFolder': 'ブリッジフォルダーを開く',
  'bridge.received': '{host} から {n} 件の変換ジョブを受け取りました',
  'bridge.rejected': '{host} から送られたファイルをキューに追加できませんでした',
  'bridge.hostOther': 'Adobe パネル',
}

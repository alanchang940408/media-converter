# Premiere Pro 2019 手動測試（Media Converter 面板）

自動測試已涵蓋 After Effects 2023 的完整流程（輸出 → 送到 Media Converter → 轉檔），
Premiere Pro 2019 無法自動操作，需要手動測一次。

## 測試前
1. 解除安裝舊版 Media Converter（設定 → 應用程式），安裝 `release\Media Converter-Setup-0.1.0.exe`（10/4 14:26 之後的版本，含 Adobe 面板）。
2. 開一次 Media Converter，到「設定 → Adobe 整合」確認顯示「已安裝」。沒有的話按「安裝面板」。
3. 如果 Premiere 開著，先關掉再重開（面板要重開才會載入）。

## 測試步驟
1. 開 Premiere Pro CC 2019，開一個**已存檔**的專案，裡面放一段 5–10 秒的序列，點一下時間軸讓它成為作用中序列。
2. 選單「視窗 → 擴充功能 → Media Converter」（英文介面：Window → Extensions → Media Converter）。
3. 面板應該顯示：來源序列名稱、中間檔格式、Media Converter 的預設集清單（語言跟 Media Converter 一樣）。
4. 勾一個預設集（建議「H.264 720p」），輸出資料夾選「與來源相同」或自訂資料夾。
5. 按「輸出並轉檔」。
   - Premiere 會卡住一段時間（這是 Premiere 的同步輸出，序列越長越久）。
   - 之後面板的記錄區應依序出現：正在輸出 → 已送出 → Media Converter 已加入佇列。
   - Media Converter 會開始轉檔，轉完後中間檔會自動刪除。
6. （可選）先關掉 Media Converter 再按一次「輸出並轉檔」：面板應自動開啟 Media Converter 並完成轉檔。
7. （可選）在 After Effects 2023 也試一次面板介面（自動測試沒有點過面板 UI）。

## 失敗時請提供
- 面板畫面截圖（含記錄區文字）。
- 面板空白或打不開：`%TEMP%` 裡最新的 `CEP9-PPRO.log` 和 `CEPHtmlEngine9-PPRO-*.log`（簽章被拒等錯誤會寫在這裡）。
- `%APPDATA%\Media Converter\bridge\` 資料夾的截圖（info.json、inbox、results、intermediates）。

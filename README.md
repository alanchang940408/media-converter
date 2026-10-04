<p align="center"><img src="build/icon.png" width="128" alt="Media Converter icon"></p>

<h1 align="center">Media Converter</h1>

<p align="center">給每個人用的批次轉檔工具：影片、音訊、圖片一次搞定。<br>A batch converter for everyone: video, audio and images in one queue.</p>

<p align="center"><a href="#繁體中文">繁體中文</a> · <a href="#english">English</a></p>

---

## 繁體中文

### 這是什麼

Media Converter 是一套桌面批次轉檔程式，結合了兩種常見的工作方式：

- **像 Adobe Media Encoder 的轉檔佇列**：把影片、音訊拖進來、選預設、按開始，就會依序轉檔。內建 ffmpeg，不需要另外安裝。
- **像 XnConvert 的圖片動作鏈**：對一批圖片依序套用縮放、裁切、旋轉、調色、浮水印等動作，再輸出成 JPEG / PNG / WebP / AVIF 等格式。

介面支援繁體中文（預設）、English、日本語。

### 功能特色

- **轉檔佇列**：拖放檔案或整個資料夾，一次加入多個工作；可重新排序、複製工作（同一來源輸出多種格式）、取消、重試，失敗時顯示 ffmpeg 的錯誤訊息與記錄。
- **預設集**：內建網頁分享、社群平台、YouTube、剪輯用（ProRes / DNxHR）、封存、GIF、純音訊、圖片等常用預設；也可以自訂、匯入、匯出（.json）。
- **硬體加速**：自動偵測並實際測試 NVIDIA NVENC、Intel Quick Sync、AMD AMF、Apple VideoToolbox，選用可用的 GPU 編碼器；GPU 失敗時自動改用軟體編碼。
- **監看資料夾**：把檔案丟進指定資料夾就自動轉檔，可同時套用多個預設，完成後保留或移走原檔。
- **浮水印**：文字（可用 `{name}`、`{date}`）或圖片 Logo，九宮格位置、透明度、大小可調，影片與圖片都能用。
- **預覽與裁剪**：影片可逐格預覽套用預設後的畫面，設定入點／出點只轉一段；圖片可即時比對處理前後。
- **圖片動作鏈**：縮放（等比、填滿、長邊、短邊、百分比…）、裁切、旋轉、翻轉、自動轉正、亮度／對比／飽和度／色相／Gamma、灰階、懷舊、負片、銳利化、模糊、加邊框、自動去白邊、浮水印。
- **批次重新命名／複製／移動**：不轉檔、不更動檔案內容，任何類型的檔案都能用。執行前先看「目前檔名 → 新檔名」預覽表（會撞名的檔案會標出來），重新命名和移動做完後還能一鍵復原。詳見下方「[批次重新命名／複製／移動](#批次重新命名複製移動)」。
- **批次命名範本**：用 `{name}` `{ext}` `{preset}` `{date}` `{time}` `{counter}` `{counter:3}` `{width}` `{height}` `{parent}` `{exifdate}` `{exiftime}` `{mdate}` 組合輸出檔名；檔名衝突時可自動加上編號、覆寫或略過。
- **保留資料夾結構**：加入整個資料夾並指定輸出資料夾時，會在輸出資料夾裡照原樣重建子資料夾（轉檔、檔案操作、監看資料夾都適用）。
- 輸出先寫入暫存檔，成功後才改名，取消或失敗不會留下半成品；路徑含空白或中日文都沒問題。

### 安裝（一般使用者）

**Windows**（從 Releases 頁面下載）

| 檔案 | 適合 |
|---|---|
| `Media Converter-Setup-<版本>.exe` | 安裝版。可選安裝位置，會建立桌面與開始選單捷徑，可從「設定 → 應用程式」解除安裝。安裝程式提供繁中／英文／日文。 |
| `Media Converter-Portable-<版本>.exe` | 免安裝版。單一執行檔，放在隨身碟或任何資料夾直接執行（每次啟動會先解壓縮，開啟稍慢）。 |

兩種版本都已內建 ffmpeg，檔案大小各約 152 MB。

**macOS / Linux**：由 GitHub Actions 自動建置（`.dmg` 分 Intel x64 與 Apple Silicon arm64；Linux 提供 `.AppImage` 與 `.deb`）。這兩個平台目前屬於「盡力支援」，尚未在實機上完整測試。

> 本程式沒有程式碼簽章，第一次開啟時系統會跳出警告，處理方式見下方「常見問題」。

### 快速上手

1. 開啟 Media Converter，把影片、音訊或圖片（也可以是整個資料夾）拖進「佇列」。
2. 在每個工作上選擇預設（例如「H.264 MP4 1080p」或「網頁用 WebP（2048px）」）。可多選工作後一次套用。
3. 需要的話調整輸出資料夾與檔名範本（預設輸出在來源檔旁邊）。
4. 按下綠色 ▶ 開始。完成後可直接開啟檔案或在檔案總管中顯示。

想要固定流程自動化？到「監看資料夾」新增資料夾並選好預設，之後丟進去的檔案就會自動處理。

### 批次重新命名／複製／移動

只想整理檔名、不想轉檔時用這個功能。它只會改檔名或搬檔案，檔案內容完全不動，任何類型的檔案都可以（照片、影片、PDF、文件…）。

1. 切到上方的「**批次改名**」分頁（在「佇列」旁邊）。批次改名的工作不會出現在轉檔佇列裡，進度和結果都在這個分頁看。
2. 按「加入檔案」或「加入資料夾」，也可以直接把檔案拖進視窗。勾選「包含子資料夾」會連子資料夾裡的檔案一起處理。
3. 選擇要做什麼：

   | 操作 | 結果 | 能不能復原 |
   |---|---|---|
   | 複製並重新命名 | 用新檔名複製到輸出資料夾，原始檔案不動 | 不需要（原檔還在；複製出來的檔案不要的話自行刪除） |
   | 原地重新命名 | 在原本的資料夾裡直接改檔名 | 可以 |
   | 移動並重新命名 | 用新檔名搬到輸出資料夾 | 可以 |

4. 選擇存放位置（複製、移動才需要），需要的話打開「**保留資料夾結構**」：子資料夾裡的檔案會放進輸出資料夾裡同名的子資料夾，不會全部擠在一起。
5. 輸入新檔名範本（點下方的標籤就能插入），選擇「編號順序」和「檔案已存在時」要怎麼處理。下方會即時顯示範例。
6. 按「**預覽**」：表格列出每個檔案的目前檔名 → 新檔名，會被加上編號、覆寫或略過的檔案會特別標示，可以切換到「需要留意」只看這些。**這一步還不會更動任何檔案**；按「返回」可以再修改。
7. 確認沒問題後按「**執行**」。分頁會列出這一批每個檔案的狀態；完成後，通知和分頁上會出現「**復原**」，可以把上一次重新命名或移動的檔案放回原本的名稱和位置。按「**開始新的一批**」可以清空重來。

**編號順序**（決定 `{counter}` 的編號）

- **檔名**：自然排序，`2` 會排在 `10` 前面（不是 `1, 10, 2`）。
- **修改日期**：最早修改的排在最前面。
- **拍攝日期**：依照片 EXIF 的拍攝時間，最早的在最前面；沒有拍攝日期的檔案用修改日期代替。

整批檔案（包括子資料夾裡的）從 1 開始連續編號。

**檔名標籤**

| 標籤 | 意思 | 範例 |
|---|---|---|
| `{name}` | 原始檔名（不含副檔名） | `IMG_0001` |
| `{ext}` | 原始副檔名 | `jpg` |
| `{counter}` | 流水號 | `1`、`2`、`3` |
| `{counter:3}` | 補零的流水號，冒號後的數字是位數 | `001`、`002` |
| `{exifdate}` | 照片的拍攝日期（EXIF）；沒有的話用修改日期 | `2026-07-15` |
| `{exiftime}` | 照片的拍攝時間（時分秒）；沒有的話用修改時間 | `143005` |
| `{mdate}` | 檔案最後修改的日期 | `2026-09-30` |
| `{date}`、`{time}` | 執行當下的日期、時間 | `2026-10-02`、`094512` |
| `{parent}` | 檔案所在資料夾的名稱 | `夏天旅行` |
| `{preset}` | 預設集名稱 | `複製並重新命名` |
| `{width}`、`{height}` | 輸出的寬、高（只有轉檔時才有） | `1920` |

例如 `{exifdate}_{counter:3}` 會把照片改成 `2026-07-15_001.jpg`、`2026-07-15_002.jpg`…。副檔名會自動保留，不必寫在範本裡。

**小提醒**

- 檔名重複時可選「自動加上編號」（變成 `名稱 (1).jpg`）、「覆寫」或「略過」。同一批不會產生兩個同名的檔案；被覆寫的檔案無法復原。
- 復原只保留**最後一次**重新命名／移動。如果之後檔案又被改名或移走，那些檔案會顯示無法復原，其他檔案照常復原。
- 隱藏檔和系統檔（`Thumbs.db`、`desktop.ini`、`.` 開頭的檔案）會自動略過。
- 就算開啟了「自動開始」，檔案操作也一定要在預覽後按「執行」才會進行。
- 三種操作是「預設集 → 檔案」分頁裡的內建預設集，可以另存成自己的版本；加入佇列後的檔案工作也能在工作編輯器裡修改操作、檔名和輸出資料夾。

### Premiere Pro／After Effects 面板

類似 Adobe Media Encoder 的「傳送到 Media Encoder」：在 Premiere Pro 或 After Effects 按一個按鈕，就把序列或合成輸出成高品質母片，再交給 Media Converter 用你勾選的預設集轉檔。

- **支援版本**：Premiere Pro CC 2019（13.0）以上、After Effects CC 2019（16.0）以上，兩個程式共用同一個面板（CEP）。
- **安裝**：在 Media Converter 開啟「設定 → Adobe 整合」→「安裝面板」，重新啟動 Premiere Pro／After Effects，再從「視窗 → 擴充功能 → Media Converter」開啟。面板有數位簽章（自簽憑證），裝在使用者自己的 `%APPDATA%\Adobe\CEP\extensions\`：不需要系統管理員權限，也不用改登錄檔（不必開 PlayerDebugMode）。
- **使用**：勾選一或多個預設集（會記住上次的選擇）、選輸出資料夾（預設與專案檔相同），按「輸出並轉檔」。
  - Premiere Pro：輸出作用中的序列（整個序列或入點到出點），母片用 Premiere 內建的「Apple ProRes 422 HQ」輸出預設（.epr）；找不到時可按「選擇 .epr…」自己指定。
  - After Effects：輸出「專案」面板中選取的合成（沒選就用目前開啟的合成），透過算圖佇列使用「High Quality」等內建輸出模組範本（ProRes 422）。原本排在佇列裡的項目算圖期間會暫停，之後恢復原狀。
- 母片存在 `%APPDATA%\Media Converter\bridge\intermediates\`，所有轉檔成功後自動刪除。Media Converter 沒開時，面板會自動啟動它。
- 面板和 Media Converter 只透過 `bridge` 資料夾交換 JSON（格式見 `src/shared/bridge.ts`），沒有網路連線。

### 支援格式

| 類型 | 讀取 | 輸出 |
|---|---|---|
| 影片 | mp4, m4v, mov, mkv, webm, avi, wmv, flv, mpg/mpeg, m2v, ts, mts, m2ts, mxf, 3gp, ogv, vob, dv, f4v, y4m… | MP4、MOV、MKV、WebM、GIF；H.264、HEVC (H.265)、AV1、VP9、ProRes、DNxHR，或直接複製串流 |
| 音訊 | mp3, wav, aac, m4a, flac, ogg, opus, wma, aiff, alac, ac3, eac3, mka, amr | MP3、M4A (AAC)、WAV (PCM)、FLAC、OGG (Opus)；可調位元率、取樣率、聲道，支援 EBU R128 音量標準化 |
| 圖片 | jpg, png, webp, avif, gif（含動畫）, tiff, svg, heic/heif, bmp, tga, exr, hdr, jp2, jxl, ico, dds, pcx, ppm/pgm/pbm, qoi | JPEG、PNG、WebP、AVIF、TIFF、GIF，或維持原格式 |

sharp 無法直接讀取的圖片格式（bmp、tga、heic、exr、dds…）會自動交給 ffmpeg 解碼。

### 常見問題

**Windows 出現「Windows 已保護您的電腦」／「不明的發行者」？**
因為安裝檔沒有付費的程式碼簽章憑證，SmartScreen 會攔下來。點「其他資訊」→「仍要執行」即可。若公司電腦的原則禁止執行未簽章程式，請洽 IT。

**macOS 說「無法打開，因為無法驗證開發者」或「已損毀」？**
到「系統設定 → 隱私權與安全性」，在下方找到 Media Converter，按「強制打開」。若顯示「已損毀」，在終端機執行：
`xattr -cr "/Applications/Media Converter.app"` 後再開啟。

**偵測不到 GPU／硬體加速沒有作用？**
- 先更新顯示卡驅動程式（NVIDIA、Intel、AMD 官網版本）。驅動太舊時 ffmpeg 的硬體編碼器會測試失敗。
- 筆電有內顯＋獨顯時，NVENC 需要 NVIDIA 獨顯，Quick Sync 需要 Intel 內顯有啟用；可在「設定」選擇偏好的硬體。
- 遠端桌面、虛擬機通常無法使用 GPU 編碼。
- 程式會用一小段測試影片實際試編碼，只有測試成功的編碼器才會被使用；更新驅動後可在「設定」重新偵測。即使沒有 GPU，也會自動改用軟體編碼（較慢但結果相同）。

**設定和預設存在哪裡？**
在使用者資料夾中（安裝版和免安裝版相同）：
- Windows：`%APPDATA%\Media Converter\`
- macOS：`~/Library/Application Support/Media Converter/`
- Linux：`~/.config/Media Converter/`

裡面有 `settings.json`（設定）、`presets.json`（自訂預設）、`queue.json`（佇列）、`watch-folders.json`（監看資料夾）、`file-ops-journal.json`（上一次重新命名／移動的復原紀錄）。解除安裝不會刪除這些檔案；想重置就把整個資料夾刪掉。

**想用自己的 ffmpeg？**
到「設定」指定 ffmpeg 的路徑（`ffmpeg.exe` 或它所在的資料夾，同一個資料夾內必須也有 `ffprobe`）。程式尋找 ffmpeg 的順序是：自訂路徑 → 內建版本 → 系統 PATH。

**轉出來的檔案在哪？**
預設在來源檔案旁邊；可以在「設定」改成固定的輸出資料夾，或在個別工作上指定。

### 開發

需要 Node.js 22 以上（建議 24）。

```bash
npm ci                          # 安裝相依套件
npm run fetch-ffmpeg            # 下載 ffmpeg/ffprobe 到 resources/bin/<平台>-<架構>/
npm run fetch-ffmpeg -- --from-path   # 離線開發：改複製系統 PATH 上的 ffmpeg
npm run dev                     # Electron + HMR
npm run dev:web                 # 只開前端（瀏覽器，http://localhost:5199，使用 mockApi）
npm run typecheck               # TypeScript 型別檢查
npm test                        # Vitest 單元／整合測試（tests/）
npm run build && npm run e2e    # Playwright 端對端測試（e2e/，會先產生測試素材）
npm run dist                    # Windows 安裝版 + 免安裝版 → release/
npm run dist:dir                # 只打包成資料夾（快速檢查）
node scripts/make-icons.mjs     # 由 resources/icon.svg 重新產生 build/icon.png、build/icon.ico
node scripts/make-test-media.mjs  # 產生測試素材到 test-media/
npm run build:cep               # 建置並簽署 Premiere／After Effects 面板 → adobe/dist/（npm run dist 之前要先跑）
npm run test:ae                 # After Effects 自動測試：算圖 → bridge 請求（需要安裝 AE；加 -- --app 連同 Media Converter 轉檔一起測，需先 npm run build）
node --test adobe/tests/bridge-node.test.cjs  # 面板 Node 模組的單元測試
```

`build:cep` 第一次執行時，會從 Adobe 官方 GitHub（Adobe-CEP/CEP-Resources，固定版本並驗證 SHA-256）下載 ZXPSignCmd 到 `adobe/.tools/`，並建立自簽憑證 `adobe/.cert/`（密碼在同一個資料夾）；這兩個資料夾和 `adobe/dist/` 都不進 git。換一台電腦建置會產生新的憑證，對使用者沒有影響。面板原始碼在 `adobe/panel/`（不用框架；ExtendScript 部分是 ES3）。

`fetch-ffmpeg` 的其他參數：`--platform win32|darwin|linux`、`--arch x64,arm64`、`--force`、`--strict`（缺少必要編碼器時失敗）、`--url <壓縮檔>`。Windows 使用 BtbN FFmpeg-Builds 的 GPL shared 版（固定版本並驗證 SHA-256）。

`npm run dist` 會在 `release/` 產生 `Media Converter-Setup-<版本>.exe`（安裝版）和 `Media Converter-Portable-<版本>.exe`（免安裝版），各約 152 MB（大部分是內建的 ffmpeg）。兩者都沒有程式碼簽章，第一次執行時 SmartScreen 會顯示「Windows 已保護您的電腦」，點「其他資訊」→「仍要執行」即可。

### 更新與發佈

**程式怎麼更新**（版本號顯示在視窗左上角程式名稱旁，以及「設定 → 關於」）

- **安裝版（Windows）**：啟動約 10 秒後檢查一次，之後每 6 小時檢查 GitHub Releases。有新版就在背景下載，下載好後視窗上方會出現「新版 vX 已下載，重新啟動即可更新」，按「立即重新啟動」馬上更新；按「稍後」的話，下次關閉程式時會自動安裝。佇列還在轉檔時，重新啟動前會先詢問。
- **免安裝版（Portable）**：不會自己更新，只會提醒「有新版 vX，免安裝版需手動下載」，按「前往下載」開啟 Release 頁面，下載新的 `.exe` 取代舊檔即可。macOS、Linux 版本同樣只提醒、不自動安裝。
- 「設定 → 關於 → 更新」可以手動「檢查更新」，也可以關掉「自動檢查更新」。自動檢查失敗（沒有網路、GitHub 限制查詢次數、repo 還是私人的）時不會跳出任何訊息，只有手動檢查才會顯示。
- 開發模式（`npm run dev`）不檢查更新。設定環境變數 `MC_NO_UPDATE_CHECK=1` 也可以關閉。

**發佈新版本**（每次發佈都會自動升版號）

```bash
npm run release:patch    # 修正：0.1.0 → 0.1.1
npm run release:minor    # 新功能：0.1.0 → 0.2.0
node scripts/release.mjs patch --dry-run   # 只檢查、不做任何變更
```

`scripts/release.mjs` 會確認工作目錄是乾淨的、分支沒有落後遠端，然後執行 `npm version`（更新 `package.json` 與 `package-lock.json`、建立 commit「vX.Y.Z」和標籤 `vX.Y.Z`），再 `git push --follow-tags`。

推送 `v*` 標籤後，GitHub Actions（`.github/workflows/release.yml`）會：確認標籤和 `package.json` 版本一致 → 建立草稿 Release → 在 Windows、macOS、Linux 上分別打包，並用 `electron-builder --publish always` 把安裝版、免安裝版、`latest.yml` 和 `.blockmap` 上傳到草稿 → 全部成功後才把草稿發佈成最新版（已安裝的程式從這時起才會看到更新）。任何一個平台失敗時草稿會留著，可以在 GitHub 上檢查後手動發佈或刪除。electron-builder 上傳時會把檔名裡的空白換成 `-`（例如 `Media-Converter-Setup-0.1.1.exe`）。

**先試跑（dry run）**：手動執行 workflow 預設就是試跑，只打包、不發佈。

```bash
gh workflow run release.yml -f dry_run=true                         # 只打包 Windows
gh workflow run release.yml -f dry_run=true -f all_platforms=true   # Windows、macOS、Linux 都打包
gh run list --workflow release.yml                                  # 找到這次的 run ID
gh run download <run-id> --name media-converter-windows-dry-run     # 下載安裝版、免安裝版、latest.yml
```

試跑時用 `electron-builder --publish never` 打包，並檢查 `latest.yml`、安裝版、免安裝版都有產生（和正式發佈時檢查的檔案相同）。這些檔案連同 `.blockmap` 只會上傳成 workflow artifact（保留 30 天），不會建立草稿或正式 Release，已安裝的程式也看不到。macOS runner 的分鐘數以 10 倍計，所以試跑預設跳過 macOS 和 Linux，加 `-f all_platforms=true` 才會一起打包。`-f dry_run=false` 只能用在 `v*` 標籤上（`gh workflow run release.yml --ref v0.1.2 -f dry_run=false`），效果和推送該標籤一樣，會真的發佈；在分支上執行會直接失敗。

> repo 目前是私人的，安裝版在 repo 公開之前檢查更新會得到 404（不會顯示錯誤）。公開後即可正常更新。

### 專案結構

```
src/
  shared/      資料模型與 API 合約（types.ts、api.ts、media.ts、videoRules.ts、naming.ts）
  main/        Electron 主程序：視窗、IPC、media:// 協定、設定儲存、佇列、預設、監看資料夾
    ffmpeg/    探測、硬體偵測、預設 → 參數、轉檔執行、擷取影格
    image/     sharp 動作鏈、輸出格式、預覽、浮水印
  preload/     以 contextBridge 提供 window.api
  renderer/    React 介面（zustand、i18n、深色主題）
tests/         Vitest 測試
e2e/           Playwright（_electron）端對端測試
scripts/       fetch-ffmpeg、make-icons、make-test-media
resources/     圖示原始檔、bin/<平台>-<架構>/ 內建 ffmpeg（不進版控）
build/         打包用圖示（icon.ico、icon.png）
electron-builder.yml   安裝檔設定
```

### 授權

本程式原始碼採用 MIT 授權（見 [LICENSE](LICENSE)）。安裝檔內含以 GPLv3 授權的 FFmpeg（獨立執行檔）以及其他第三方元件，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

### What it is

Media Converter is a desktop batch converter that combines two familiar workflows:

- **An Adobe Media Encoder–style encode queue** for video and audio — drop files, pick a preset, press start. ffmpeg is bundled; nothing else to install.
- **XnConvert-style image action chains** — apply resize, crop, rotate, colour adjustments, watermarks and more to a batch of images and export to JPEG / PNG / WebP / AVIF and others.

UI languages: Traditional Chinese (default), English, Japanese.

### Features

- **Encode queue** — drag in files or whole folders; reorder, duplicate (several outputs from one source), cancel and retry jobs; failures show the ffmpeg error and log.
- **Presets** — built-ins for web sharing, social media, YouTube, editing (ProRes / DNxHR), archiving, GIF, audio-only and images; create your own, import/export as JSON.
- **Hardware acceleration** — detects and test-encodes NVIDIA NVENC, Intel Quick Sync, AMD AMF and Apple VideoToolbox, uses a working GPU encoder and falls back to software if the GPU encode fails.
- **Watch folders** — files dropped into a folder are converted automatically with one or more presets; sources are kept or moved afterwards.
- **Watermarks** — text (with `{name}` / `{date}`) or image logos, nine anchor positions, opacity and size; for video and images.
- **Preview & trim** — preview a video frame exactly as the preset renders it and set in/out points; before/after preview for images.
- **Image action chains** — resize (fit, fill, long/short edge, percent…), crop, rotate, flip, auto-orient, brightness/contrast/saturation/hue/gamma, grayscale, sepia, invert, sharpen, blur, canvas/border, auto-trim, watermark.
- **Batch rename / copy / move** — no converting, file contents are never touched, works with any file type. A "current name → new name" preview (conflicts highlighted) comes before anything happens, and renames/moves can be undone with one click. See [Batch rename / copy / move](#batch-rename--copy--move).
- **File-name templates** — `{name}` `{ext}` `{preset}` `{date}` `{time}` `{counter}` `{counter:3}` `{width}` `{height}` `{parent}` `{exifdate}` `{exiftime}` `{mdate}`; on conflicts add a number, overwrite or skip.
- **Keep folder structure** — when you add a whole folder and choose an output folder, its subfolders are recreated inside the output folder (conversions, file operations and watch folders).
- Outputs are written to a temporary file and renamed on success, so cancelled or failed jobs never leave partial files. Paths with spaces and CJK characters are fine.

### Install (end users)

**Windows** (from the Releases page)

| File | Use it when |
|---|---|
| `Media Converter-Setup-<version>.exe` | You want a normal installation: choose the folder, desktop + Start menu shortcuts, uninstall from Settings → Apps. Installer in Traditional Chinese / English / Japanese. |
| `Media Converter-Portable-<version>.exe` | You want no installation: a single exe you can run from any folder or USB stick (it unpacks itself on every start, so it opens a bit slower). |

Both include ffmpeg and are about 152 MB each.

**macOS / Linux** builds are produced by GitHub Actions (`.dmg` for Intel x64 and Apple Silicon arm64; `.AppImage` and `.deb` for Linux). These platforms are best-effort and not yet fully tested on real machines.

> The builds are not code-signed, so the OS warns on first launch — see the FAQ.

### Quick start

1. Open Media Converter and drag videos, audio files, images or folders into the **Queue**.
2. Pick a preset per job (e.g. "H.264 MP4 1080p" or "Web WebP (2048 px)"); select several jobs to apply one preset to all of them.
3. Optionally change the output folder and file-name template (default: next to the source).
4. Press the green ▶. When a job is done, open the file or reveal it in the file manager.

For hands-off processing, add a **Watch folder** with the presets you want; new files dropped into it are converted automatically.

### Batch rename / copy / move

For when you only want to tidy up file names, not convert anything. It renames or moves files and never changes their contents, so it works with any file type (photos, videos, PDFs, documents…).

1. Open the **Batch rename** tab at the top (next to **Queue**). Batch jobs don't appear in the conversion queue; their progress and results are shown on this tab.
2. Click **Add files** or **Add folder**, or drag files onto the window. **Include subfolders** also takes the files inside subfolders.
3. Choose what to do:

   | Operation | Result | Undo |
   |---|---|---|
   | Copy & rename | Copies the files into the output folder with new names; the originals stay as they are | Not needed (the originals are untouched; delete the copies yourself if you don't want them) |
   | Rename in place | Renames the files in the folder they are in | Yes |
   | Move & rename | Moves the files into the output folder with new names | Yes |

4. Pick the destination (copy and move only) and, if you like, turn on **Keep folder structure** so files from subfolders land in matching subfolders instead of all in one place.
5. Type the new-name template (click a tag to insert it), then pick the **Numbering order** and the **If the file exists** option. Live examples show the result.
6. Click **Preview**: a table lists every file's current name → new name; files that get a number added, overwrite something or are skipped are highlighted, and **Needs a look** shows only those. **Nothing has changed yet** — **Back** lets you adjust.
7. Click **Run**. Only the previewed files are processed; other jobs waiting in the queue stay there. The tab lists every file of the batch with its status. When it finishes, the notification and the tab offer **Undo**, which puts the files of the last rename or move back under their old names and locations; **New batch** starts over.

**Numbering order** (what `{counter}` counts by)

- **Name** — natural order: `2` comes before `10` (not `1, 10, 2`).
- **Date modified** — oldest first.
- **Date taken** — the photo's EXIF capture time, oldest first; files without one use their modified date.

The whole batch, including files in subfolders, is numbered consecutively from 1.

**Name tags**

| Tag | Meaning | Example |
|---|---|---|
| `{name}` | Original file name (without extension) | `IMG_0001` |
| `{ext}` | Original extension | `jpg` |
| `{counter}` | Running number | `1`, `2`, `3` |
| `{counter:3}` | Zero-padded running number; the digit after the colon is the width | `001`, `002` |
| `{exifdate}` | Date the photo was taken (EXIF); falls back to the modified date | `2026-07-15` |
| `{exiftime}` | Time the photo was taken (HHmmss); falls back to the modified time | `143005` |
| `{mdate}` | Date the file was last modified | `2026-09-30` |
| `{date}`, `{time}` | Date / time when the job runs | `2026-10-02`, `094512` |
| `{parent}` | Name of the folder the file is in | `Summer trip` |
| `{preset}` | Preset name | `Copy & rename` |
| `{width}`, `{height}` | Output width / height (conversions only) | `1920` |

For example, `{exifdate}_{counter:3}` turns photos into `2026-07-15_001.jpg`, `2026-07-15_002.jpg`, … The extension is kept automatically; you don't put it in the template.

**Good to know**

- On name clashes choose **Add a number** (`name (1).jpg`), **Overwrite** or **Skip**. One batch never produces two files with the same name; overwritten files cannot be restored.
- Undo keeps only the **last** rename/move. Files that were renamed or moved again in the meantime are reported as not restorable; the rest are restored.
- Hidden and system files (`Thumbs.db`, `desktop.ini`, names starting with `.`) are skipped.
- File operations never start by themselves, even with **Auto-start** on — they run only when you press **Run** after the preview.
- The three operations are built-in presets on the **Presets → File** tab; save your own variants there. File jobs in the queue can be edited (operation, name, output folder) in the job editor.

### Premiere Pro / After Effects panel

Like Adobe Media Encoder's "Send to Media Encoder": one button in Premiere Pro or After Effects renders the sequence or composition to a high-quality master, then Media Converter converts it with the presets you tick.

- **Versions**: Premiere Pro CC 2019 (13.0) and later, After Effects CC 2019 (16.0) and later; one CEP panel serves both.
- **Install**: in Media Converter open **Settings → Adobe integration → Install panel**, restart Premiere Pro / After Effects, then open **Window → Extensions → Media Converter**. The panel is signed (self-signed certificate) and goes into your own `%APPDATA%\Adobe\CEP\extensions\`: no admin rights, no registry change (PlayerDebugMode is not needed).
- **Use**: tick one or more presets (remembered), pick the output folder (default: next to the project file) and press **Render & Convert**.
  - Premiere Pro: renders the active sequence (entire, or In to Out) with Premiere's built-in "Apple ProRes 422 HQ" export preset (.epr); if it is missing, choose any .epr with **Choose .epr…**.
  - After Effects: renders the compositions selected in the Project panel (or the open one) through the render queue with a built-in output module template such as "High Quality" (ProRes 422). Items you had queued are paused during the render and restored afterwards.
- Masters go to `%APPDATA%\Media Converter\bridge\intermediates\` and are deleted once all of their conversions succeeded. If Media Converter is not running, the panel starts it.
- The panel and Media Converter only exchange JSON files through the `bridge` folder (format: `src/shared/bridge.ts`); no network.

### Supported formats

| Type | Input | Output |
|---|---|---|
| Video | mp4, m4v, mov, mkv, webm, avi, wmv, flv, mpg/mpeg, m2v, ts, mts, m2ts, mxf, 3gp, ogv, vob, dv, f4v, y4m… | MP4, MOV, MKV, WebM, GIF; H.264, HEVC (H.265), AV1, VP9, ProRes, DNxHR, or stream copy |
| Audio | mp3, wav, aac, m4a, flac, ogg, opus, wma, aiff, alac, ac3, eac3, mka, amr | MP3, M4A (AAC), WAV (PCM), FLAC, OGG (Opus); bitrate, sample rate, channels, EBU R128 loudness normalisation |
| Image | jpg, png, webp, avif, gif (incl. animated), tiff, svg, heic/heif, bmp, tga, exr, hdr, jp2, jxl, ico, dds, pcx, ppm/pgm/pbm, qoi | JPEG, PNG, WebP, AVIF, TIFF, GIF, or keep the source format |

Image formats sharp cannot read directly (bmp, tga, heic, exr, dds…) are decoded through ffmpeg automatically.

### FAQ

**Windows SmartScreen says "Windows protected your PC" / "Unknown publisher".**
The installer is not signed with a paid code-signing certificate. Click **More info → Run anyway**. Managed company PCs may block unsigned apps; ask your IT department.

**macOS says the app "can't be opened because the developer cannot be verified" or "is damaged".**
Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** for Media Converter. If it says "damaged", run `xattr -cr "/Applications/Media Converter.app"` in Terminal and open it again.

**My GPU is not detected / hardware acceleration does nothing.**
- Update the graphics driver from NVIDIA, Intel or AMD; old drivers make ffmpeg's hardware encoders fail the test encode.
- On laptops with hybrid graphics, NVENC needs the NVIDIA GPU and Quick Sync needs the Intel iGPU enabled; choose the preferred hardware in **Settings**.
- Remote Desktop sessions and virtual machines usually cannot use GPU encoders.
- Each encoder is verified with a tiny test encode and only working ones are used; re-run detection in **Settings** after updating drivers. Without a GPU the app uses software encoding (slower, same result).

**Where are settings stored?**
In the user-data folder (same for the installed and portable versions):
- Windows: `%APPDATA%\Media Converter\`
- macOS: `~/Library/Application Support/Media Converter/`
- Linux: `~/.config/Media Converter/`

It holds `settings.json`, `presets.json` (your presets), `queue.json`, `watch-folders.json` and `file-ops-journal.json` (the undo record of the last rename/move). Uninstalling keeps them; delete the folder to reset everything.

**How do I use my own ffmpeg?**
Set the ffmpeg path in **Settings** (the `ffmpeg` executable or its folder; `ffprobe` must be in the same folder). Lookup order: custom path → bundled → system PATH.

### Development

Requires Node.js 22+ (24 recommended).

```bash
npm ci                          # install dependencies
npm run fetch-ffmpeg            # download ffmpeg/ffprobe into resources/bin/<platform>-<arch>/
npm run fetch-ffmpeg -- --from-path   # offline: copy the ffmpeg found on PATH instead
npm run dev                     # Electron with HMR
npm run dev:web                 # renderer only, in a browser at http://localhost:5199 (mockApi)
npm run typecheck               # TypeScript
npm test                        # Vitest unit/integration tests (tests/)
npm run build && npm run e2e    # Playwright end-to-end tests (e2e/; generates test media first)
npm run dist                    # Windows installer + portable exe → release/
npm run dist:dir                # unpacked app folder only (quick check)
node scripts/make-icons.mjs     # regenerate build/icon.png + build/icon.ico from resources/icon.svg
node scripts/make-test-media.mjs  # synthetic test media → test-media/
npm run build:cep               # build + sign the Premiere / After Effects panel → adobe/dist/ (run before npm run dist)
npm run test:ae                 # After Effects test: render → bridge request (needs AE; add -- --app to include the Media Converter conversion, after npm run build)
node --test adobe/tests/bridge-node.test.cjs  # unit tests of the panel's Node module
```

On first run `build:cep` downloads ZXPSignCmd from Adobe's official GitHub (Adobe-CEP/CEP-Resources, pinned version, SHA-256 verified) into `adobe/.tools/` and creates a self-signed certificate in `adobe/.cert/` (password next to it); both folders and `adobe/dist/` stay out of git. Building on another machine creates a new certificate, which makes no difference to users. The panel source is in `adobe/panel/` (no framework; the ExtendScript part is ES3).

More `fetch-ffmpeg` options: `--platform win32|darwin|linux`, `--arch x64,arm64`, `--force`, `--strict` (fail if a required encoder is missing), `--url <archive>`. Windows uses the BtbN FFmpeg-Builds GPL shared build, pinned and SHA-256 verified.

`npm run dist` writes `Media Converter-Setup-<version>.exe` (installer) and `Media Converter-Portable-<version>.exe` (portable) to `release/`, about 152 MB each (mostly the bundled ffmpeg). Neither is code-signed, so on first launch SmartScreen shows "Windows protected your PC": click **More info → Run anyway**.

### Updates & releases

**How the app updates** (the version number is shown next to the app name in the header and in Settings → About)

- **Installed version (Windows)**: checks GitHub Releases about 10 seconds after start and then every 6 hours. A new version downloads in the background; when it is ready a bar under the header says "New version vX has been downloaded. Restart to update." **Restart now** installs it right away; **Later** installs it the next time you quit. If the queue is still encoding you are asked first.
- **Portable version**: never updates itself. It shows "New version vX is available. The portable version must be downloaded manually." with **Go to download**, which opens the release page; replace the old `.exe` with the new one. macOS and Linux builds also only remind you.
- Settings → About → Updates has **Check for updates** and the **Check for updates automatically** switch. Automatic checks fail silently (offline, GitHub rate limit, repository still private); only a manual check shows a message.
- Development runs (`npm run dev`) never check. `MC_NO_UPDATE_CHECK=1` turns checks off in a packaged build too.

**Cutting a release** (every release bumps the version)

```bash
npm run release:patch    # fixes:        0.1.0 → 0.1.1
npm run release:minor    # new features: 0.1.0 → 0.2.0
node scripts/release.mjs patch --dry-run   # checks only, changes nothing
```

`scripts/release.mjs` checks that the working tree is clean and the branch is not behind its upstream, runs `npm version` (bumps `package.json` + `package-lock.json`, commits "vX.Y.Z", tags `vX.Y.Z`) and then `git push --follow-tags`.

The pushed `v*` tag runs `.github/workflows/release.yml`: it checks that the tag matches `package.json`, creates a draft release, builds on Windows, macOS and Linux with `electron-builder --publish always` (uploading the installer, portable exe, `latest.yml` and `.blockmap` files into the draft), and publishes the draft as the latest release only when every build succeeded — installed apps see the update from that moment. If a platform fails, the draft stays for you to inspect and publish or delete by hand. electron-builder uploads the files with `-` instead of spaces in their names (e.g. `Media-Converter-Setup-0.1.1.exe`).

**Dry run first**: a manual run of the workflow is a dry run by default — it builds, it does not publish.

```bash
gh workflow run release.yml -f dry_run=true                         # Windows only
gh workflow run release.yml -f dry_run=true -f all_platforms=true   # Windows, macOS and Linux
gh run list --workflow release.yml                                  # find the run ID
gh run download <run-id> --name media-converter-windows-dry-run     # installer, portable exe, latest.yml
```

A dry run packages with `electron-builder --publish never` and checks that `latest.yml`, the installer and the portable exe were produced (the same files the real publish requires). They are uploaded, with the `.blockmap`, as workflow artifacts only (kept 30 days): no draft or release is created and installed apps see nothing. macOS runner minutes count 10×, so dry runs skip macOS and Linux unless you add `-f all_platforms=true`. `-f dry_run=false` only works on a `v*` tag (`gh workflow run release.yml --ref v0.1.2 -f dry_run=false`) and then does exactly what pushing that tag does — it really publishes; on a branch the run fails right away.

> While the repository is private, update checks get a 404 (silently). They work once it is public.

### Project structure

```
src/
  shared/      data model + API contract (types.ts, api.ts, media.ts, videoRules.ts, naming.ts)
  main/        Electron main process: window, IPC, media:// protocol, persistence, queue, presets, watch folders
    ffmpeg/    probe, hardware detection, preset → args, encode runner, frame extraction
    image/     sharp action pipeline, output formats, preview, watermark rendering
  preload/     window.api via contextBridge
  renderer/    React UI (zustand, i18n, dark theme)
tests/         Vitest
e2e/           Playwright (_electron) end-to-end tests
scripts/       fetch-ffmpeg, make-icons, make-test-media
resources/     icon sources, bin/<platform>-<arch>/ bundled ffmpeg (not committed)
build/         packaging icons (icon.ico, icon.png)
electron-builder.yml   installer configuration
```

### License

Media Converter's source code is MIT licensed (see [LICENSE](LICENSE)). The installers bundle FFmpeg under GPLv3 (as separate executables) and other third-party components — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

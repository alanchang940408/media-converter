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

1. 在「佇列」工具列按「**批次重新命名…**」。
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
7. 確認沒問題後按「**執行**」。完成後，通知和佇列工具列會出現「**復原**」，可以把上一次重新命名或移動的檔案放回原本的名稱和位置。

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
```

`fetch-ffmpeg` 的其他參數：`--platform win32|darwin|linux`、`--arch x64,arm64`、`--force`、`--strict`（缺少必要編碼器時失敗）、`--url <壓縮檔>`。Windows 使用 BtbN FFmpeg-Builds 的 GPL shared 版（固定版本並驗證 SHA-256）。

`npm run dist` 會在 `release/` 產生 `Media Converter-Setup-<版本>.exe`（安裝版）和 `Media Converter-Portable-<版本>.exe`（免安裝版），各約 152 MB（大部分是內建的 ffmpeg）。兩者都沒有程式碼簽章，第一次執行時 SmartScreen 會顯示「Windows 已保護您的電腦」，點「其他資訊」→「仍要執行」即可。

發佈：推送 `v*` 標籤後，GitHub Actions（`.github/workflows/release.yml`）會在 Windows、macOS、Linux 上分別打包，並建立草稿 Release。

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

1. In the **Queue** toolbar, click **Batch rename…**.
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
7. Click **Run**. When it finishes, the notification and the queue toolbar offer **Undo**, which puts the files of the last rename or move back under their old names and locations.

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
```

More `fetch-ffmpeg` options: `--platform win32|darwin|linux`, `--arch x64,arm64`, `--force`, `--strict` (fail if a required encoder is missing), `--url <archive>`. Windows uses the BtbN FFmpeg-Builds GPL shared build, pinned and SHA-256 verified.

`npm run dist` writes `Media Converter-Setup-<version>.exe` (installer) and `Media Converter-Portable-<version>.exe` (portable) to `release/`, about 152 MB each (mostly the bundled ffmpeg). Neither is code-signed, so on first launch SmartScreen shows "Windows protected your PC": click **More info → Run anyway**.

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds on Windows, macOS and Linux and creates a draft GitHub release.

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

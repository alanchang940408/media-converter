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
- **批次命名範本**：用 `{name}` `{ext}` `{preset}` `{date}` `{time}` `{counter}` `{counter:3}` `{width}` `{height}` `{parent}` 組合輸出檔名；檔名衝突時可自動改名、覆寫或略過。
- 輸出先寫入暫存檔，成功後才改名，取消或失敗不會留下半成品；路徑含空白或中日文都沒問題。

### 安裝（一般使用者）

**Windows**（從 Releases 頁面下載）

| 檔案 | 適合 |
|---|---|
| `Media Converter-Setup-<版本>.exe` | 安裝版。可選安裝位置，會建立桌面與開始選單捷徑，可從「設定 → 應用程式」解除安裝。安裝程式提供繁中／英文／日文。 |
| `Media Converter-Portable-<版本>.exe` | 免安裝版。單一執行檔，放在隨身碟或任何資料夾直接執行（每次啟動會先解壓縮，開啟稍慢）。 |

兩種版本都已內建 ffmpeg。

**macOS / Linux**：由 GitHub Actions 自動建置（`.dmg` 分 Intel x64 與 Apple Silicon arm64；Linux 提供 `.AppImage` 與 `.deb`）。這兩個平台目前屬於「盡力支援」，尚未在實機上完整測試。

> 本程式沒有程式碼簽章，第一次開啟時系統會跳出警告，處理方式見下方「常見問題」。

### 快速上手

1. 開啟 Media Converter，把影片、音訊或圖片（也可以是整個資料夾）拖進「佇列」。
2. 在每個工作上選擇預設（例如「H.264 MP4 1080p」或「網頁用 WebP（2048px）」）。可多選工作後一次套用。
3. 需要的話調整輸出資料夾與檔名範本（預設輸出在來源檔旁邊）。
4. 按下綠色 ▶ 開始。完成後可直接開啟檔案或在檔案總管中顯示。

想要固定流程自動化？到「監看資料夾」新增資料夾並選好預設，之後丟進去的檔案就會自動處理。

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

裡面有 `settings.json`（設定）、`presets.json`（自訂預設）、`queue.json`（佇列）、`watch-folders.json`（監看資料夾）。解除安裝不會刪除這些檔案；想重置就把整個資料夾刪掉。

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
- **Batch rename templates** — `{name}` `{ext}` `{preset}` `{date}` `{time}` `{counter}` `{counter:3}` `{width}` `{height}` `{parent}`; on conflicts rename, overwrite or skip.
- Outputs are written to a temporary file and renamed on success, so cancelled or failed jobs never leave partial files. Paths with spaces and CJK characters are fine.

### Install (end users)

**Windows** (from the Releases page)

| File | Use it when |
|---|---|
| `Media Converter-Setup-<version>.exe` | You want a normal installation: choose the folder, desktop + Start menu shortcuts, uninstall from Settings → Apps. Installer in Traditional Chinese / English / Japanese. |
| `Media Converter-Portable-<version>.exe` | You want no installation: a single exe you can run from any folder or USB stick (it unpacks itself on every start, so it opens a bit slower). |

Both include ffmpeg.

**macOS / Linux** builds are produced by GitHub Actions (`.dmg` for Intel x64 and Apple Silicon arm64; `.AppImage` and `.deb` for Linux). These platforms are best-effort and not yet fully tested on real machines.

> The builds are not code-signed, so the OS warns on first launch — see the FAQ.

### Quick start

1. Open Media Converter and drag videos, audio files, images or folders into the **Queue**.
2. Pick a preset per job (e.g. "H.264 MP4 1080p" or "Web WebP (2048 px)"); select several jobs to apply one preset to all of them.
3. Optionally change the output folder and file-name template (default: next to the source).
4. Press the green ▶. When a job is done, open the file or reveal it in the file manager.

For hands-off processing, add a **Watch folder** with the presets you want; new files dropped into it are converted automatically.

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

It holds `settings.json`, `presets.json` (your presets), `queue.json` and `watch-folders.json`. Uninstalling keeps them; delete the folder to reset everything.

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

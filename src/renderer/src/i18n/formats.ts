// Dictionaries for the legacy output formats (MPG / WMV / AVI): container group, codec notes, DVD profile.
// i18n/index.ts merges these into the main dictionaries; `formatsEn` defines the key set.

export const formatsEn = {
  'formats.legacyFormats': 'Older formats',
  'formats.wmvNote': 'WMV files use the WMV2 (Windows Media Video 8) codec — ffmpeg has no WMV9 / VC-1 encoder. They play in Windows Media Player, PowerPoint and most players.',
  'formats.mjpegNote': 'Every frame is stored as a JPEG image: easy to edit and scrub, but the files are large.',
  'formats.mpeg2Standard': 'Standard MPEG-2',
  'formats.dvdNote': 'DVD-Video fixes the frame at {size}, {fps} fps, 48 kHz audio and at most 9 Mbps video. The picture keeps its proportions inside a 16:9 frame (4:3 for sources closer to 4:3).',
  'profile.mpeg2.dvd-ntsc': 'DVD-Video NTSC (720×480, 29.97 fps)',
  'profile.mpeg2.dvd-pal': 'DVD-Video PAL (720×576, 25 fps)',
  'videoIssue.dvdNeedsMpg': 'The DVD profile only applies to MPG output — standard MPEG-2 is used here.',
}

export const formatsZhTW: Record<keyof typeof formatsEn, string> = {
  'formats.legacyFormats': '舊式格式',
  'formats.wmvNote': 'WMV 會使用 WMV2（Windows Media Video 8）編碼，因為 ffmpeg 沒有 WMV9 / VC-1 編碼器。Windows Media Player、PowerPoint 和大多數播放器都能播放。',
  'formats.mjpegNote': '每一格都存成一張 JPEG：剪輯和拖曳預覽很順，但檔案很大。',
  'formats.mpeg2Standard': '一般 MPEG-2',
  'formats.dvdNote': 'DVD 規格會固定為 {size}、{fps} fps、48 kHz 音訊，影片位元率最高 9 Mbps。畫面會維持原本比例放進 16:9 畫面（接近 4:3 的來源則用 4:3）。',
  'profile.mpeg2.dvd-ntsc': 'DVD 影片 NTSC（720×480、29.97 fps）',
  'profile.mpeg2.dvd-pal': 'DVD 影片 PAL（720×576、25 fps）',
  'videoIssue.dvdNeedsMpg': 'DVD 設定檔只適用於 MPG 輸出，這裡會改用一般 MPEG-2。',
}

export const formatsJa: Record<keyof typeof formatsEn, string> = {
  'formats.legacyFormats': '旧形式',
  'formats.wmvNote': 'WMV は WMV2（Windows Media Video 8）コーデックで書き出します。ffmpeg には WMV9 / VC-1 のエンコーダーがないためです。Windows Media Player や PowerPoint、多くのプレーヤーで再生できます。',
  'formats.mjpegNote': '全フレームを JPEG 画像として保存します。編集やスクラブは軽快ですが、ファイルは大きくなります。',
  'formats.mpeg2Standard': '標準の MPEG-2',
  'formats.dvdNote': 'DVD-Video では {size}・{fps} fps・48 kHz 音声、映像は最大 9 Mbps に固定されます。映像は元の比率のまま 16:9 の画面に収めます（4:3 に近い映像は 4:3）。',
  'profile.mpeg2.dvd-ntsc': 'DVD-Video NTSC（720×480・29.97 fps）',
  'profile.mpeg2.dvd-pal': 'DVD-Video PAL（720×576・25 fps）',
  'videoIssue.dvdNeedsMpg': 'DVD プロファイルは MPG 出力でのみ有効です。ここでは標準の MPEG-2 になります。',
}

// Built-in presets. Ids are a stable contract (settings, watch folders and the renderer refer to them).
import type {
  AudioCodecId,
  FileOperation,
  FilePreset,
  ImageAction,
  ImageOutputSettings,
  ImagePreset,
  LocalizedText,
  Preset,
  PresetCategory,
  VideoPreset,
  VideoPresetSettings,
} from '../../shared/types'

type L3 = { 'zh-TW': string; en: string; ja: string }

function video(id: string, category: PresetCategory, names: L3, descriptions: L3, settings: VideoPresetSettings): VideoPreset {
  return {
    id,
    kind: 'video',
    name: names.en,
    names: names as LocalizedText,
    description: descriptions.en,
    descriptions: descriptions as LocalizedText,
    category,
    builtIn: true,
    settings,
  }
}

function image(id: string, names: L3, descriptions: L3, actions: ImageAction[], output: ImageOutputSettings): ImagePreset {
  return {
    id,
    kind: 'image',
    name: names.en,
    names: names as LocalizedText,
    description: descriptions.en,
    descriptions: descriptions as LocalizedText,
    category: 'image',
    builtIn: true,
    actions,
    output,
  }
}

function file(id: string, operation: FileOperation, names: L3, descriptions: L3): FilePreset {
  return {
    id,
    kind: 'file',
    name: names.en,
    names: names as LocalizedText,
    description: descriptions.en,
    descriptions: descriptions as LocalizedText,
    category: 'file',
    builtIn: true,
    operation,
  }
}

type VideoPart = Partial<VideoPresetSettings['video']>
type AudioPart = Partial<VideoPresetSettings['audio']>

/** H.264 / AAC in MP4 with sane defaults; override per preset. */
function h264(v: VideoPart = {}, a: AudioPart = {}, extra: Partial<VideoPresetSettings> = {}): VideoPresetSettings {
  return {
    container: 'mp4',
    video: {
      codec: 'h264',
      hw: 'auto',
      rate: { mode: 'crf', crf: 20 },
      speed: 'balanced',
      profile: 'high',
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps: null,
      ...v,
    },
    audio: { codec: 'aac', bitrateKbps: 192, sampleRate: null, channels: null, ...a },
    faststart: true,
    ...extra,
  }
}

function prores(profile: string): VideoPresetSettings {
  return {
    container: 'mov',
    video: {
      codec: 'prores',
      hw: 'auto',
      rate: { mode: 'crf', crf: 20 },
      speed: 'balanced',
      profile,
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps: null,
    },
    audio: { codec: 'pcm', bitrateKbps: null, sampleRate: null, channels: null },
  }
}

function audioOnly(container: VideoPresetSettings['container'], codec: AudioCodecId, bitrateKbps: number | null): VideoPresetSettings {
  return {
    container,
    video: {
      codec: 'none',
      hw: 'auto',
      rate: { mode: 'crf', crf: 20 },
      speed: 'balanced',
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps: null,
    },
    audio: { codec, bitrateKbps, sampleRate: null, channels: null },
    ...(container === 'm4a' ? { faststart: true } : {}),
  }
}

/** Legacy containers (MPG / WMV / AVI): software encoders, no faststart. hw stays 'auto' and resolves to the CPU. */
function legacy(container: 'mpg' | 'wmv' | 'avi', v: VideoPart & Pick<VideoPresetSettings['video'], 'codec'>, a: AudioPart & Pick<VideoPresetSettings['audio'], 'codec'>): VideoPresetSettings {
  return {
    container,
    video: {
      hw: 'auto',
      rate: { mode: 'crf', crf: 20 },
      speed: 'balanced',
      profile: null,
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps: null,
      ...v,
    },
    audio: { bitrateKbps: 192, sampleRate: null, channels: null, ...a },
    faststart: false,
  }
}

/** DVD-Video MPEG-2: the engine enforces the standard frame, rate and bitrate limits; these fields mirror them for the UI. */
function dvd(standard: 'ntsc' | 'pal'): VideoPresetSettings {
  return legacy(
    'mpg',
    {
      codec: 'mpeg2',
      profile: `dvd-${standard}`,
      rate: { mode: 'vbr', bitrateKbps: 6000, maxKbps: 9000 },
      width: 720,
      height: standard === 'ntsc' ? 480 : 576,
      scaleMode: 'pad',
      noUpscale: false,
      fps: standard === 'ntsc' ? 29.97 : 25,
    },
    { codec: 'ac3', bitrateKbps: 192, sampleRate: 48000 },
  )
}

function gif(width: number, fps: number): VideoPresetSettings {
  return {
    container: 'gif',
    video: {
      codec: 'gif',
      hw: 'auto',
      rate: { mode: 'crf', crf: 20 },
      speed: 'balanced',
      width,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps,
      gif: { fps, width, colors: 256, dither: 'sierra2_4a', loop: 0 },
    },
    audio: { codec: 'none', bitrateKbps: null, sampleRate: null, channels: null },
  }
}

let actionSeq = 0
const act = <T extends Omit<ImageAction, 'id' | 'enabled'>>(a: T): ImageAction =>
  ({ id: `builtin-${++actionSeq}`, enabled: true, ...a }) as unknown as ImageAction

const autoOrient = (): ImageAction => act({ type: 'autoOrient' })

const jpegOut = (quality: number, keepMetadata: boolean): ImageOutputSettings => ({
  format: 'jpeg',
  quality,
  progressive: false,
  chromaSubsampling: '4:2:0',
  keepMetadata,
  background: '#ffffff',
  dpi: null,
})

export const BUILTIN_VIDEO_PRESETS: VideoPreset[] = [
  video(
    'h264-match',
    'web',
    { 'zh-TW': 'H.264 MP4（原始尺寸）', en: 'H.264 MP4 (match source)', ja: 'H.264 MP4（ソースと同じ）' },
    {
      'zh-TW': '最通用的格式，保留原始解析度與畫面更新率，高畫質。',
      en: 'Plays everywhere. Keeps the source size and frame rate at high quality.',
      ja: 'どこでも再生できる形式。解像度とフレームレートをそのまま高画質で保持。',
    },
    h264(),
  ),
  video(
    'h264-1080p',
    'web',
    { 'zh-TW': 'H.264 MP4 1080p', en: 'H.264 MP4 1080p', ja: 'H.264 MP4 1080p' },
    {
      'zh-TW': '縮放至 1920×1080 以內，不放大較小的影片。',
      en: 'Scales to fit 1920×1080. Smaller videos are not enlarged.',
      ja: '1920×1080 に収まるよう縮小。小さい動画は拡大しません。',
    },
    h264({ width: 1920, height: 1080 }),
  ),
  video(
    'h264-720p',
    'web',
    { 'zh-TW': 'H.264 MP4 720p', en: 'H.264 MP4 720p', ja: 'H.264 MP4 720p' },
    {
      'zh-TW': '縮放至 1280×720 以內，檔案較小，適合分享。',
      en: 'Scales to fit 1280×720. Smaller files, good for sharing.',
      ja: '1280×720 に収まるよう縮小。共有向けの小さめのファイル。',
    },
    h264({ width: 1280, height: 720 }, { bitrateKbps: 160 }),
  ),
  video(
    'h264-4k',
    'web',
    { 'zh-TW': 'H.264 MP4 4K', en: 'H.264 MP4 4K', ja: 'H.264 MP4 4K' },
    {
      'zh-TW': '縮放至 3840×2160 以內，高畫質 4K。',
      en: 'Scales to fit 3840×2160 at high quality.',
      ja: '3840×2160 に収まるよう縮小。高画質 4K。',
    },
    h264({ width: 3840, height: 2160 }),
  ),
  video(
    'youtube-1080p',
    'web',
    { 'zh-TW': 'YouTube 1080p', en: 'YouTube 1080p', ja: 'YouTube 1080p' },
    {
      'zh-TW': 'YouTube 建議的 1080p 上傳設定（10 Mbps）。',
      en: 'YouTube recommended upload settings for 1080p (10 Mbps).',
      ja: 'YouTube 推奨の 1080p アップロード設定（10 Mbps）。',
    },
    h264({ width: 1920, height: 1080, rate: { mode: 'vbr', bitrateKbps: 10000, maxKbps: 15000 } }, { bitrateKbps: 384 }),
  ),
  video(
    'social-vertical-1080x1920',
    'social',
    { 'zh-TW': '直式短影音 1080×1920', en: 'Vertical video 1080×1920', ja: '縦型動画 1080×1920' },
    {
      'zh-TW': 'Reels、Shorts、TikTok 用。裁切填滿 9:16 畫面。',
      en: 'For Reels, Shorts and TikTok. Crops to fill a 9:16 frame.',
      ja: 'リール・ショート・TikTok 向け。9:16 に合わせて切り抜き。',
    },
    h264({ width: 1080, height: 1920, scaleMode: 'crop', noUpscale: false }),
  ),
  video(
    'social-square-1080',
    'social',
    { 'zh-TW': '方形影片 1080×1080', en: 'Square video 1080×1080', ja: '正方形動画 1080×1080' },
    {
      'zh-TW': '社群貼文用。裁切填滿 1:1 畫面。',
      en: 'For social feeds. Crops to fill a 1:1 frame.',
      ja: 'SNS 投稿向け。1:1 に合わせて切り抜き。',
    },
    h264({ width: 1080, height: 1080, scaleMode: 'crop', noUpscale: false }),
  ),
  video(
    'h264-proxy-720p',
    'editing',
    { 'zh-TW': '剪輯代理檔 720p', en: 'Editing proxy 720p', ja: '編集用プロキシ 720p' },
    {
      'zh-TW': '快速產生的輕量 720p 檔，方便剪輯時流暢預覽。',
      en: 'Fast, lightweight 720p files for smooth editing.',
      ja: '編集を軽くするための高速・軽量な 720p ファイル。',
    },
    h264({ width: 1280, height: 720, speed: 'fast', rate: { mode: 'crf', crf: 26 } }, { bitrateKbps: 128 }),
  ),
  video(
    'hevc-match',
    'device',
    { 'zh-TW': 'HEVC (H.265) MP4（原始尺寸）', en: 'HEVC (H.265) MP4 (match source)', ja: 'HEVC (H.265) MP4（ソースと同じ）' },
    {
      'zh-TW': '同樣畫質下檔案約小一半，適合新款手機與電視。',
      en: 'About half the size of H.264 at the same quality. For newer phones and TVs.',
      ja: '同じ画質で H.264 の約半分のサイズ。新しいスマホやテレビ向け。',
    },
    h264({ codec: 'hevc', profile: null }),
  ),
  video(
    'hevc-4k-10bit',
    'archive',
    { 'zh-TW': 'HEVC 4K 10-bit', en: 'HEVC 4K 10-bit', ja: 'HEVC 4K 10-bit' },
    {
      'zh-TW': '10 位元 HEVC，保留漸層細節，適合保存 4K / HDR 素材。',
      en: '10-bit HEVC keeps smooth gradients. Good for archiving 4K footage.',
      ja: '10 ビット HEVC で滑らかな階調を保持。4K 素材の保存向け。',
    },
    h264({ codec: 'hevc', profile: null, width: 3840, height: 2160, tenBit: true }),
  ),
  video(
    'av1-match',
    'web',
    { 'zh-TW': 'AV1 MP4（原始尺寸）', en: 'AV1 MP4 (match source)', ja: 'AV1 MP4（ソースと同じ）' },
    {
      'zh-TW': '新一代高壓縮格式，檔案最小，轉檔較慢。',
      en: 'Next-generation codec with the smallest files. Slower to encode.',
      ja: '次世代の高圧縮コーデック。最小サイズだがエンコードは遅め。',
    },
    h264({ codec: 'av1', profile: null }),
  ),
  video(
    'webm-vp9-1080p',
    'web',
    { 'zh-TW': 'WebM VP9 1080p', en: 'WebM VP9 1080p', ja: 'WebM VP9 1080p' },
    {
      'zh-TW': '網頁用的開放格式（VP9 + Opus），1920×1080 以內。',
      en: 'Open web format (VP9 + Opus), fits 1920×1080.',
      ja: 'Web 向けのオープン形式（VP9 + Opus）、1920×1080 以内。',
    },
    h264({ codec: 'vp9', profile: null, width: 1920, height: 1080 }, { codec: 'opus', bitrateKbps: 128 }, {
      container: 'webm',
      faststart: false,
    }),
  ),
  video(
    'prores-422',
    'editing',
    { 'zh-TW': 'ProRes 422', en: 'ProRes 422', ja: 'ProRes 422' },
    {
      'zh-TW': '剪輯用的高品質中間檔（MOV），檔案很大。',
      en: 'High-quality intermediate for editing (MOV). Large files.',
      ja: '編集用の高品質な中間ファイル（MOV）。サイズは大きめ。',
    },
    prores('standard'),
  ),
  video(
    'prores-422-hq',
    'editing',
    { 'zh-TW': 'ProRes 422 HQ', en: 'ProRes 422 HQ', ja: 'ProRes 422 HQ' },
    {
      'zh-TW': '更高位元率的 ProRes，適合調光與特效。',
      en: 'Higher bitrate ProRes for grading and effects work.',
      ja: 'カラーグレーディングや VFX 向けの高ビットレート ProRes。',
    },
    prores('hq'),
  ),
  video(
    'prores-422-proxy',
    'editing',
    { 'zh-TW': 'ProRes 422 Proxy', en: 'ProRes 422 Proxy', ja: 'ProRes 422 Proxy' },
    {
      'zh-TW': '輕量的 ProRes 代理檔，適合剪輯預覽。',
      en: 'Lightweight ProRes proxy for offline editing.',
      ja: 'オフライン編集向けの軽量 ProRes プロキシ。',
    },
    prores('proxy'),
  ),
  video(
    'prores-4444',
    'editing',
    { 'zh-TW': 'ProRes 4444（含透明）', en: 'ProRes 4444 (with alpha)', ja: 'ProRes 4444（アルファ付き）' },
    {
      'zh-TW': '最高品質的 ProRes，可保留透明通道。',
      en: 'Top-quality ProRes that keeps transparency.',
      ja: '透明度を保持できる最高品質の ProRes。',
    },
    prores('4444'),
  ),
  video(
    'dnxhr-hq',
    'editing',
    { 'zh-TW': 'DNxHR HQ', en: 'DNxHR HQ', ja: 'DNxHR HQ' },
    {
      'zh-TW': 'Avid / DaVinci 常用的剪輯中間檔（MOV）。',
      en: 'Editing intermediate for Avid and DaVinci Resolve (MOV).',
      ja: 'Avid や DaVinci Resolve 向けの編集用中間ファイル（MOV）。',
    },
    {
      ...prores('hq'),
      video: { ...prores('hq').video, codec: 'dnxhr', profile: 'hq' },
    },
  ),
  video(
    'remux-mp4',
    'device',
    { 'zh-TW': '轉封裝為 MP4（不重新編碼）', en: 'Rewrap to MP4 (no re-encode)', ja: 'MP4 に再ラップ（再エンコードなし）' },
    {
      'zh-TW': '只換外殼不轉碼，幾秒完成且畫質不變（編碼需相容 MP4）。',
      en: 'Changes only the container: takes seconds, no quality loss (codecs must fit MP4).',
      ja: 'コンテナのみ変更。数秒で完了し画質劣化なし（MP4 対応コーデックのみ）。',
    },
    h264({ codec: 'copy', profile: null }, { codec: 'copy', bitrateKbps: null }),
  ),
  video(
    'gif-480',
    'gif',
    { 'zh-TW': 'GIF 動畫 480px', en: 'Animated GIF 480px', ja: 'GIF アニメ 480px' },
    {
      'zh-TW': '寬 480px、每秒 15 格，無限循環。',
      en: '480 px wide, 15 fps, loops forever.',
      ja: '幅 480px・15 fps・無限ループ。',
    },
    gif(480, 15),
  ),
  video(
    'gif-720-hq',
    'gif',
    { 'zh-TW': 'GIF 動畫 720px 高畫質', en: 'Animated GIF 720px HQ', ja: 'GIF アニメ 720px 高画質' },
    {
      'zh-TW': '寬 720px、每秒 24 格，畫面更順但檔案較大。',
      en: '720 px wide, 24 fps. Smoother, larger files.',
      ja: '幅 720px・24 fps。滑らかだがサイズは大きめ。',
    },
    gif(720, 24),
  ),
  video(
    'audio-mp3-320',
    'audio',
    { 'zh-TW': 'MP3 320 kbps', en: 'MP3 320 kbps', ja: 'MP3 320 kbps' },
    {
      'zh-TW': '最高音質的 MP3，也可從影片擷取聲音。',
      en: 'Best-quality MP3. Also extracts audio from videos.',
      ja: '最高音質の MP3。動画から音声の抽出にも。',
    },
    audioOnly('mp3', 'mp3', 320),
  ),
  video(
    'audio-mp3-192',
    'audio',
    { 'zh-TW': 'MP3 192 kbps', en: 'MP3 192 kbps', ja: 'MP3 192 kbps' },
    {
      'zh-TW': '音質與檔案大小兼顧的 MP3。',
      en: 'Good balance of quality and size.',
      ja: '音質とサイズのバランスがよい MP3。',
    },
    audioOnly('mp3', 'mp3', 192),
  ),
  video(
    'audio-aac-256',
    'audio',
    { 'zh-TW': 'AAC 256 kbps（M4A）', en: 'AAC 256 kbps (M4A)', ja: 'AAC 256 kbps（M4A）' },
    {
      'zh-TW': 'Apple 裝置常用的高品質音訊格式。',
      en: 'High-quality audio, great on Apple devices.',
      ja: 'Apple 製品でよく使われる高音質形式。',
    },
    audioOnly('m4a', 'aac', 256),
  ),
  video(
    'audio-wav',
    'audio',
    { 'zh-TW': 'WAV（無壓縮）', en: 'WAV (uncompressed)', ja: 'WAV（非圧縮）' },
    {
      'zh-TW': '無損無壓縮的 PCM 音訊，適合剪輯。',
      en: 'Uncompressed PCM audio for editing.',
      ja: '編集向けの非圧縮 PCM オーディオ。',
    },
    audioOnly('wav', 'pcm', null),
  ),
  video(
    'audio-flac',
    'audio',
    { 'zh-TW': 'FLAC（無損壓縮）', en: 'FLAC (lossless)', ja: 'FLAC（ロスレス）' },
    {
      'zh-TW': '無損壓縮，音質與原始相同但檔案較小。',
      en: 'Lossless compression: identical sound, smaller than WAV.',
      ja: 'ロスレス圧縮。音質はそのままで WAV より小さい。',
    },
    audioOnly('flac', 'flac', null),
  ),
  // ── Legacy formats (MPG / WMV / AVI) for older players, TVs and software ──
  video(
    'mpeg2-dvd-ntsc',
    'device',
    { 'zh-TW': 'DVD MPEG-2（NTSC）', en: 'DVD MPEG-2 (NTSC)', ja: 'DVD MPEG-2（NTSC）' },
    {
      'zh-TW': '符合 DVD 規格的 MPEG-2：720×480、29.97 fps、杜比數位音訊。適用台灣、日本、北美的 DVD 燒錄軟體與播放機。',
      en: 'DVD-Video compliant MPEG-2: 720×480, 29.97 fps, Dolby Digital audio. For DVD authoring and players in North America, Japan and Taiwan.',
      ja: 'DVD-Video 規格準拠の MPEG-2（720×480・29.97 fps・ドルビーデジタル音声）。日本・北米・台湾の DVD オーサリングやプレーヤー向け。',
    },
    dvd('ntsc'),
  ),
  video(
    'mpeg2-dvd-pal',
    'device',
    { 'zh-TW': 'DVD MPEG-2（PAL）', en: 'DVD MPEG-2 (PAL)', ja: 'DVD MPEG-2（PAL）' },
    {
      'zh-TW': '符合 DVD 規格的 MPEG-2：720×576、25 fps、杜比數位音訊。適用歐洲、中國、香港、澳洲等 PAL 地區。',
      en: 'DVD-Video compliant MPEG-2: 720×576, 25 fps, Dolby Digital audio. For PAL regions such as Europe, China, Hong Kong and Australia.',
      ja: 'DVD-Video 規格準拠の MPEG-2（720×576・25 fps・ドルビーデジタル音声）。ヨーロッパ・中国・香港・オーストラリアなど PAL 地域向け。',
    },
    dvd('pal'),
  ),
  video(
    'mpeg2-1080p',
    'device',
    { 'zh-TW': 'MPEG-2 1080p（MPG）', en: 'MPEG-2 1080p (MPG)', ja: 'MPEG-2 1080p（MPG）' },
    {
      'zh-TW': '高畫質 MPEG-2（約 20 Mbps）＋ MP2 音訊，1920×1080 以內。適合只支援 MPEG-2 的電視、播放機與舊版剪輯軟體。',
      en: 'High-definition MPEG-2 (about 20 Mbps) with MP2 audio, fits 1920×1080. For TVs, players and older editing software that only take MPEG-2.',
      ja: '高画質 MPEG-2（約 20 Mbps）＋ MP2 音声、1920×1080 以内。MPEG-2 しか扱えないテレビ・プレーヤー・古い編集ソフト向け。',
    },
    legacy(
      'mpg',
      { codec: 'mpeg2', rate: { mode: 'vbr', bitrateKbps: 20000, maxKbps: 25000 }, width: 1920, height: 1080 },
      { codec: 'mp2', bitrateKbps: 256 },
    ),
  ),
  video(
    'wmv-720p',
    'device',
    { 'zh-TW': 'WMV 720p', en: 'WMV 720p', ja: 'WMV 720p' },
    {
      'zh-TW': 'Windows Media 影片（WMV8 編碼），適合舊版 Windows、Windows Media Player 與 PowerPoint。1280×720 以內。',
      en: 'Windows Media video (WMV8 codec) for older Windows PCs, Windows Media Player and PowerPoint. Fits 1280×720.',
      ja: 'Windows Media 動画（WMV8 コーデック）。古い Windows・Windows Media Player・PowerPoint 向け。1280×720 以内。',
    },
    legacy('wmv', { codec: 'wmv2', width: 1280, height: 720 }, { codec: 'wmav2', bitrateKbps: 160 }),
  ),
  video(
    'avi-xvid-720p',
    'device',
    { 'zh-TW': 'AVI Xvid 720p', en: 'AVI Xvid 720p', ja: 'AVI Xvid 720p' },
    {
      'zh-TW': 'Xvid 相容的 MPEG-4 ＋ MP3 音訊（AVI），適合支援 DivX / Xvid 的舊型播放機與電視。1280×720 以內。',
      en: 'Xvid-compatible MPEG-4 with MP3 audio in AVI, for older DivX / Xvid players and TVs. Fits 1280×720.',
      ja: 'Xvid 互換の MPEG-4 ＋ MP3 音声（AVI）。DivX / Xvid 対応の古いプレーヤーやテレビ向け。1280×720 以内。',
    },
    legacy('avi', { codec: 'mpeg4', width: 1280, height: 720 }, { codec: 'mp3', bitrateKbps: 192 }),
  ),
  video(
    'avi-mjpeg',
    'editing',
    { 'zh-TW': 'AVI Motion JPEG（MJPEG）', en: 'AVI Motion JPEG (MJPEG)', ja: 'AVI Motion JPEG（MJPEG）' },
    {
      'zh-TW': '每一格都是獨立的 JPEG，舊版剪輯軟體也能流暢拖曳與剪接；無壓縮 PCM 音訊，保留原始尺寸。檔案很大。',
      en: 'Every frame is a separate JPEG, so even older editing software scrubs and cuts it smoothly. Uncompressed PCM audio, source size. Large files.',
      ja: '全フレームが独立した JPEG なので、古い編集ソフトでもスムーズにスクラブ・カットできます。非圧縮 PCM 音声、元のサイズ。サイズは大きめ。',
    },
    legacy('avi', { codec: 'mjpeg', rate: { mode: 'crf', crf: 18 }, noUpscale: true }, { codec: 'pcm', bitrateKbps: null }),
  ),
]

export const BUILTIN_IMAGE_PRESETS: ImagePreset[] = [
  image(
    'img-jpeg-q90',
    { 'zh-TW': 'JPEG（品質 90）', en: 'JPEG (quality 90)', ja: 'JPEG（品質 90）' },
    {
      'zh-TW': '轉成最通用的 JPEG，自動轉正方向。',
      en: 'Converts to widely compatible JPEG and fixes rotation.',
      ja: '互換性の高い JPEG に変換し、向きを自動補正。',
    },
    [autoOrient()],
    jpegOut(90, true),
  ),
  image(
    'img-web-2048-webp',
    { 'zh-TW': '網頁用 WebP（2048px）', en: 'Web WebP (2048 px)', ja: 'Web 用 WebP（2048px）' },
    {
      'zh-TW': '長邊縮至 2048px 的 WebP，檔案小、載入快。',
      en: 'WebP with the long edge at 2048 px. Small and fast to load.',
      ja: '長辺 2048px の WebP。軽くて表示が速い。',
    },
    [autoOrient(), act({ type: 'resize', mode: 'longEdge', size: 2048, withoutEnlargement: true, kernel: 'lanczos3' })],
    { format: 'webp', quality: 82, keepMetadata: false, dpi: null },
  ),
  image(
    'img-png',
    { 'zh-TW': 'PNG（無損）', en: 'PNG (lossless)', ja: 'PNG（ロスレス）' },
    {
      'zh-TW': '無損的 PNG，保留透明背景。',
      en: 'Lossless PNG that keeps transparency.',
      ja: '透明を保持するロスレス PNG。',
    },
    [autoOrient()],
    { format: 'png', quality: 100, pngCompression: 6, keepMetadata: true, dpi: null },
  ),
  image(
    'img-avif',
    { 'zh-TW': 'AVIF（品質 60）', en: 'AVIF (quality 60)', ja: 'AVIF（品質 60）' },
    {
      'zh-TW': '新一代圖片格式，同樣畫質下檔案最小。',
      en: 'Next-generation format with the smallest files at similar quality.',
      ja: '次世代の画像形式。同程度の画質で最小サイズ。',
    },
    [autoOrient()],
    { format: 'avif', quality: 60, keepMetadata: false, dpi: null },
  ),
  image(
    'img-thumb-512',
    { 'zh-TW': '縮圖 512px', en: 'Thumbnail 512 px', ja: 'サムネイル 512px' },
    {
      'zh-TW': '長邊 512px 的清晰 JPEG 縮圖。',
      en: 'Crisp JPEG thumbnail with the long edge at 512 px.',
      ja: '長辺 512px のくっきりした JPEG サムネイル。',
    },
    [
      autoOrient(),
      act({ type: 'resize', mode: 'longEdge', size: 512, withoutEnlargement: true, kernel: 'lanczos3' }),
      act({ type: 'sharpen', sigma: 0.5 }),
    ],
    jpegOut(85, false),
  ),
  image(
    'img-square-1080',
    { 'zh-TW': '方形 1080×1080', en: 'Square 1080×1080', ja: '正方形 1080×1080' },
    {
      'zh-TW': '智慧裁成 1:1 後縮放到 1080px，適合社群貼文。',
      en: 'Smart-crops to 1:1 and resizes to 1080 px for social posts.',
      ja: '主題を検出して 1:1 に切り抜き、1080px にリサイズ。SNS 投稿向け。',
    },
    [
      autoOrient(),
      act({ type: 'crop', mode: 'aspect', aspect: '1:1', gravity: 'attention' }),
      act({ type: 'resize', mode: 'fill', width: 1080, height: 1080, withoutEnlargement: false, kernel: 'lanczos3' }),
    ],
    jpegOut(90, false),
  ),
  image(
    'img-portrait-1080x1350',
    { 'zh-TW': '直式 1080×1350（4:5）', en: 'Portrait 1080×1350 (4:5)', ja: '縦長 1080×1350（4:5）' },
    {
      'zh-TW': '智慧裁成 4:5 直式，Instagram 動態最佳比例。',
      en: 'Smart-crops to 4:5 portrait, the best fit for Instagram feeds.',
      ja: '4:5 の縦長に切り抜き。Instagram フィードに最適。',
    },
    [
      autoOrient(),
      act({ type: 'crop', mode: 'aspect', aspect: '4:5', gravity: 'attention' }),
      act({ type: 'resize', mode: 'fill', width: 1080, height: 1350, withoutEnlargement: false, kernel: 'lanczos3' }),
    ],
    jpegOut(90, false),
  ),
  image(
    'img-tiff-archive',
    { 'zh-TW': 'TIFF 典藏（無損）', en: 'TIFF archive (lossless)', ja: 'TIFF アーカイブ（ロスレス）' },
    {
      'zh-TW': '無損 TIFF 並保留所有中繼資料，適合長期保存。',
      en: 'Lossless TIFF keeping all metadata, for long-term storage.',
      ja: 'メタデータをすべて保持するロスレス TIFF。長期保存向け。',
    },
    [],
    { format: 'tiff', quality: 100, lossless: true, keepMetadata: true, dpi: null },
  ),
  image(
    'img-half',
    { 'zh-TW': '縮小一半（50%）', en: 'Half size (50%)', ja: '半分のサイズ（50%）' },
    {
      'zh-TW': '尺寸縮為 50%，保留原本的格式。',
      en: 'Scales to 50% and keeps the original format.',
      ja: '50% に縮小し、元の形式のまま保存。',
    },
    [act({ type: 'resize', mode: 'percent', percent: 50, withoutEnlargement: true, kernel: 'lanczos3' })],
    { format: 'keep', quality: 90, keepMetadata: true, dpi: null },
  ),
  image(
    'img-grayscale',
    { 'zh-TW': '黑白', en: 'Grayscale', ja: 'モノクロ' },
    {
      'zh-TW': '轉成黑白，保留原本的格式。',
      en: 'Converts to black and white, keeping the original format.',
      ja: '白黒に変換し、元の形式のまま保存。',
    },
    [act({ type: 'grayscale' })],
    { format: 'keep', quality: 90, keepMetadata: true, dpi: null },
  ),
]

/** Rename / copy / move without touching file contents (any file type). */
export const BUILTIN_FILE_PRESETS: FilePreset[] = [
  file(
    'file-copy-rename',
    'copy',
    { 'zh-TW': '複製並重新命名', en: 'Copy & rename', ja: 'コピーして名前を変更' },
    {
      'zh-TW': '把檔案原樣複製到輸出資料夾並套用新檔名，原始檔案不會被更動。',
      en: 'Copies the files unchanged into the output folder with new names. The originals are left as they are.',
      ja: 'ファイルを変更せずに出力フォルダーへコピーし、新しい名前を付けます。元のファイルはそのままです。',
    },
  ),
  file(
    'file-rename',
    'rename',
    { 'zh-TW': '原地重新命名', en: 'Rename in place', ja: 'その場で名前を変更' },
    {
      'zh-TW': '在原本的資料夾裡直接改檔名，不複製也不轉檔，之後可以復原。',
      en: 'Renames the files where they are — no copying, no converting. Can be undone.',
      ja: '元のフォルダーのまま名前だけを変更します。コピーも変換もしません。あとで元に戻せます。',
    },
  ),
  file(
    'file-move-rename',
    'move',
    { 'zh-TW': '移動並重新命名', en: 'Move & rename', ja: '移動して名前を変更' },
    {
      'zh-TW': '把檔案搬到輸出資料夾並套用新檔名，不轉檔，之後可以復原。',
      en: 'Moves the files into the output folder with new names, without converting. Can be undone.',
      ja: 'ファイルを出力フォルダーへ移動し、新しい名前を付けます。変換はしません。あとで元に戻せます。',
    },
  ),
]

export const BUILTIN_PRESETS: Preset[] = [...BUILTIN_VIDEO_PRESETS, ...BUILTIN_IMAGE_PRESETS, ...BUILTIN_FILE_PRESETS]

const byId = new Map(BUILTIN_PRESETS.map((p) => [p.id, p]))

export function getBuiltinPreset(id: string): Preset | undefined {
  return byId.get(id)
}

export function isBuiltinId(id: string): boolean {
  return byId.has(id)
}

export const DEFAULT_VIDEO_PRESET_ID = 'h264-match'
export const DEFAULT_IMAGE_PRESET_ID = 'img-jpeg-q90'
export const DEFAULT_FILE_PRESET_ID = 'file-copy-rename'

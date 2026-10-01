// In-memory MediaApi for `npm run dev:web` (plain browser, no Electron).
// Simulates presets, a running queue with progress, watch folders, capabilities and
// generated SVG imagery so every screen can be demoed without the main process.
import type { MediaApi } from '../../shared/api'
import type {
  AddJobsRequest,
  AddJobsResult,
  AppInfo,
  AppSettings,
  EncoderCapabilities,
  FileKindFilter,
  ImageAction,
  ImageOutputSettings,
  ImagePreset,
  ImagePreviewResult,
  Job,
  JobPatch,
  JobProgress,
  Locale,
  MediaInfo,
  OutputContainer,
  Preset,
  QueueEvent,
  QueueSnapshot,
  VideoPreset,
  VideoPresetSettings,
  WatchFolder,
  Watermark,
} from '../../shared/types'
import { baseNameOf, classifyPath, extOf } from '../../shared/media'
import { renderNameTemplate } from '../../shared/naming'
import { isAudioOnlyContainer } from '../../shared/videoRules'
import { computeVideoOutputSize } from './lib/videoSize'
import { defaultImageOutput, defaultVideoSettings, newAction } from './lib/presets'
import { dirName, fileName, joinPath } from './lib/format'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

function hashStr(s: string): number {
  let h = 2166136261
  for (const ch of s) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
const today = (): string => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ───────────────────────────── generated imagery ─────────────────────────────

/** A small landscape scene drawn in a w×h box (SVG markup without the <svg> wrapper). */
function scene(seed: number, w: number, h: number, t = 0): string {
  const hue = seed % 360
  const sunX = w * (0.18 + ((seed >>> 5) % 55) / 100) + ((t * 0.012) % 0.5) * w
  const sunY = h * (0.24 + ((seed >>> 11) % 18) / 100)
  const r = Math.min(w, h) * 0.085
  const ridge = (base: number, amp: number, n: number, s: number): string => {
    let pts = `0,${h}`
    for (let i = 0; i <= n; i++) {
      const x = (w * i) / n
      const y = h * base - Math.abs(Math.sin((i + s) * 1.7 + (seed % 7))) * h * amp
      pts += ` ${x.toFixed(1)},${y.toFixed(1)}`
    }
    return `${pts} ${w},${h}`
  }
  return (
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 55% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 35) % 360} 70% 84%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>` +
    `<circle cx="${sunX.toFixed(1)}" cy="${sunY.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${(hue + 55) % 360} 95% 90%)"/>` +
    `<polygon points="${ridge(0.7, 0.24, 7, 1)}" fill="hsl(${(hue + 200) % 360} 22% 46%)"/>` +
    `<polygon points="${ridge(0.84, 0.17, 9, 3)}" fill="hsl(${(hue + 190) % 360} 28% 30%)"/>` +
    `<rect y="${(h * 0.9).toFixed(1)}" width="${w}" height="${(h * 0.1 + 1).toFixed(1)}" fill="hsl(${(hue + 180) % 360} 24% 19%)"/>`
  )
}

function fitBox(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

function wrapSvg(inner: string, vbW: number, vbH: number, max: number): string {
  const d = fitBox(vbW, vbH, max)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.w}" height="${d.h}" viewBox="0 0 ${vbW} ${vbH}">${inner}</svg>`
}

function textWidth(s: string, fs: number): number {
  let n = 0
  for (const ch of s) n += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.58
  return n * fs
}

function anchorPos(anchor: Watermark['anchor'], W: number, H: number, w: number, h: number, m: number): { x: number; y: number } {
  const col = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 2 : 1
  const row = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 2 : 1
  const x = col === 0 ? m : col === 2 ? W - w - m : (W - w) / 2
  const y = row === 0 ? m : row === 2 ? H - h - m : (H - h) / 2
  return { x, y }
}

function watermarkSvg(wm: Watermark, W: number, H: number, sourcePath: string): string {
  const m = (wm.marginPct / 100) * Math.min(W, H)
  if (wm.type === 'text') {
    const text = wm.text.replace(/\{name\}/g, baseNameOf(sourcePath)).replace(/\{date\}/g, today())
    const fs = Math.max(4, (wm.fontSizePct / 100) * H)
    const pad = wm.background ? fs * 0.35 : 0
    const tw = textWidth(text, fs) + pad * 2
    const th = fs * 1.25 + pad * 2
    const p = anchorPos(wm.anchor, W, H, tw, th, m)
    const shadow = wm.shadow ? ` filter="url(#wmShadow)"` : ''
    return (
      `<defs><filter id="wmShadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="${fs * 0.06}" stdDeviation="${fs * 0.08}" flood-color="#000" flood-opacity="0.7"/></filter></defs>` +
      `<g opacity="${wm.opacity}">` +
      (wm.background ? `<rect x="${p.x}" y="${p.y}" width="${tw}" height="${th}" rx="${fs * 0.15}" fill="${wm.background}"/>` : '') +
      `<text x="${p.x + pad}" y="${p.y + pad + fs * 0.98}" font-family="Segoe UI, Microsoft JhengHei UI, sans-serif" font-size="${fs}" font-weight="${wm.bold ? 700 : 400}" fill="${wm.color}"${shadow}>${esc(text)}</text>` +
      `</g>`
    )
  }
  const lw = (wm.scalePct / 100) * W
  const lh = lw * 0.36
  const p = anchorPos(wm.anchor, W, H, lw, lh, m)
  return (
    `<g opacity="${wm.opacity}"><rect x="${p.x}" y="${p.y}" width="${lw}" height="${lh}" rx="${lh * 0.18}" fill="#ffffff" fill-opacity="0.9"/>` +
    `<text x="${p.x + lw / 2}" y="${p.y + lh * 0.66}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="${lh * 0.5}" font-weight="700" fill="#1b1b1b">${esc(fileName(wm.path).replace(/\.[^.]+$/, '').toUpperCase().slice(0, 12) || 'LOGO')}</text></g>`
  )
}

/** Simulates the image action chain geometrically and with SVG filters. */
function renderImageChain(info: MediaInfo, actions: ImageAction[]): { svg: string; w: number; h: number } {
  const seed = hashStr(info.path)
  let cw = info.width ?? 1600
  let ch = info.height ?? 1200
  let content = scene(seed, cw, ch)
  const defs: string[] = []
  let fid = 0
  const filter = (prims: string): void => {
    fid++
    defs.push(`<filter id="f${fid}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">${prims}</filter>`)
    content = `<g filter="url(#f${fid})">${content}</g>`
  }
  for (const a of actions) {
    if (!a.enabled) continue
    switch (a.type) {
      case 'resize': {
        let nw = cw
        let nh = ch
        const k = (s: number): void => {
          if (a.withoutEnlargement && s > 1) s = 1
          nw = cw * s
          nh = ch * s
        }
        switch (a.mode) {
          case 'fit': k(Math.min((a.width ?? cw) / cw, (a.height ?? ch) / ch)); break
          case 'fill':
          case 'stretch':
            nw = a.width ?? cw
            nh = a.height ?? ch
            if (a.withoutEnlargement) {
              nw = Math.min(nw, cw)
              nh = Math.min(nh, ch)
            }
            break
          case 'percent': k((a.percent ?? 100) / 100); break
          case 'longEdge': k((a.size ?? 1000) / Math.max(cw, ch)); break
          case 'shortEdge': k((a.size ?? 1000) / Math.min(cw, ch)); break
          case 'width': k((a.width ?? cw) / cw); break
          case 'height': k((a.height ?? ch) / ch); break
        }
        nw = Math.max(1, Math.round(nw))
        nh = Math.max(1, Math.round(nh))
        const par = a.mode === 'fill' ? 'xMidYMid slice' : 'none'
        content = `<svg width="${nw}" height="${nh}" viewBox="0 0 ${cw} ${ch}" preserveAspectRatio="${par}">${content}</svg>`
        cw = nw
        ch = nh
        break
      }
      case 'crop': {
        let x = 0
        let y = 0
        let w = cw
        let h = ch
        if (a.mode === 'rect') {
          x = Math.min(a.left ?? 0, cw - 1)
          y = Math.min(a.top ?? 0, ch - 1)
          w = Math.min(a.width ?? cw, cw - x)
          h = Math.min(a.height ?? ch, ch - y)
        } else if (a.mode === 'edges') {
          const e = a.edges ?? { top: 0, right: 0, bottom: 0, left: 0 }
          x = e.left
          y = e.top
          w = Math.max(1, cw - e.left - e.right)
          h = Math.max(1, ch - e.top - e.bottom)
        } else {
          const [rw, rh] = (a.aspect ?? '1:1').split(':').map(Number)
          const ratio = rw > 0 && rh > 0 ? rw / rh : 1
          if (cw / ch > ratio) {
            w = ch * ratio
            h = ch
          } else {
            w = cw
            h = cw / ratio
          }
          const g = typeof a.gravity === 'string' && a.gravity.includes('-') ? a.gravity : a.gravity ?? 'center'
          x = String(g).endsWith('left') ? 0 : String(g).endsWith('right') ? cw - w : (cw - w) / 2
          y = String(g).startsWith('top') ? 0 : String(g).startsWith('bottom') ? ch - h : (ch - h) / 2
        }
        content = `<svg width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">${content}</svg>`
        cw = Math.max(1, Math.round(w))
        ch = Math.max(1, Math.round(h))
        break
      }
      case 'rotate': {
        const ang = ((a.angle % 360) + 360) % 360
        if (ang === 0) break
        if (ang === 90 || ang === 270) {
          const t = ang === 90 ? `translate(${ch},0) rotate(90)` : `translate(0,${cw}) rotate(270)`
          content = `<g transform="${t}">${content}</g>`
          ;[cw, ch] = [ch, cw]
        } else if (ang === 180) {
          content = `<g transform="translate(${cw},${ch}) rotate(180)">${content}</g>`
        } else {
          const rad = (ang * Math.PI) / 180
          const nw = Math.abs(cw * Math.cos(rad)) + Math.abs(ch * Math.sin(rad))
          const nh = Math.abs(cw * Math.sin(rad)) + Math.abs(ch * Math.cos(rad))
          content = `<rect width="${nw}" height="${nh}" fill="${a.background ?? '#000000'}"/><g transform="translate(${nw / 2},${nh / 2}) rotate(${ang}) translate(${-cw / 2},${-ch / 2})">${content}</g>`
          cw = Math.round(nw)
          ch = Math.round(nh)
        }
        break
      }
      case 'flip':
        content =
          a.axis === 'horizontal'
            ? `<g transform="translate(${cw},0) scale(-1,1)">${content}</g>`
            : `<g transform="translate(0,${ch}) scale(1,-1)">${content}</g>`
        break
      case 'canvas': {
        const u = a.unit === 'pct' ? Math.min(cw, ch) / 100 : 1
        const nw = cw + (a.left + a.right) * u
        const nh = ch + (a.top + a.bottom) * u
        content = `<rect width="${nw}" height="${nh}" fill="${a.color}"/><g transform="translate(${a.left * u},${a.top * u})">${content}</g>`
        cw = Math.round(nw)
        ch = Math.round(nh)
        break
      }
      case 'trim': {
        const dx = cw * 0.02
        const dy = ch * 0.02
        content = `<svg width="${cw - 2 * dx}" height="${ch - 2 * dy}" viewBox="${dx} ${dy} ${cw - 2 * dx} ${ch - 2 * dy}">${content}</svg>`
        cw = Math.round(cw - 2 * dx)
        ch = Math.round(ch - 2 * dy)
        break
      }
      case 'adjust': {
        const b = 1 + a.brightness / 100
        const c = 1 + a.contrast / 100
        const lin = (slope: number, icpt: number): string =>
          `<feComponentTransfer><feFuncR type="linear" slope="${slope}" intercept="${icpt}"/><feFuncG type="linear" slope="${slope}" intercept="${icpt}"/><feFuncB type="linear" slope="${slope}" intercept="${icpt}"/></feComponentTransfer>`
        const gam = 1 / Math.max(0.1, a.gamma)
        filter(
          lin(b, 0) +
            lin(c, 0.5 - 0.5 * c) +
            `<feColorMatrix type="saturate" values="${Math.max(0, 1 + a.saturation / 100)}"/>` +
            `<feColorMatrix type="hueRotate" values="${a.hue}"/>` +
            `<feComponentTransfer><feFuncR type="gamma" exponent="${gam}"/><feFuncG type="gamma" exponent="${gam}"/><feFuncB type="gamma" exponent="${gam}"/></feComponentTransfer>`,
        )
        break
      }
      case 'grayscale':
        filter(`<feColorMatrix type="saturate" values="0"/>`)
        break
      case 'sepia':
        filter(`<feColorMatrix type="matrix" values="0.393 0.769 0.189 0 0 0.349 0.686 0.168 0 0 0.272 0.534 0.131 0 0 0 0 0 1 0"/>`)
        break
      case 'invert':
        filter(`<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="table" tableValues="1 0"/><feFuncB type="table" tableValues="1 0"/></feComponentTransfer>`)
        break
      case 'blur':
        filter(`<feGaussianBlur stdDeviation="${a.sigma * Math.max(1, Math.max(cw, ch) / 1200)}"/>`)
        break
      case 'sharpen':
        filter(`<feConvolveMatrix order="3" kernelMatrix="0 -0.3 0 -0.3 2.2 -0.3 0 -0.3 0" preserveAlpha="true"/>`)
        break
      case 'watermark':
        content += watermarkSvg(a.watermark, cw, ch, info.path)
        break
      case 'autoOrient':
        break
    }
  }
  return { svg: `<defs>${defs.join('')}</defs>${content}`, w: Math.round(cw), h: Math.round(ch) }
}

// ───────────────────────────── fake media info ─────────────────────────────

function fakeInfo(path: string): MediaInfo {
  const kind = classifyPath(path) ?? 'video'
  const h = hashStr(path)
  const ext = extOf(path)
  if (kind === 'image') {
    const dims = [[6000, 4000], [4032, 3024], [3024, 4032], [2048, 1365], [1080, 1350], [3840, 2160]][h % 6]
    const fmt: Record<string, string> = { jpg: 'jpeg', jpeg: 'jpeg', heic: 'heif', heif: 'heif', png: 'png', webp: 'webp', tif: 'tiff', tiff: 'tiff', gif: 'gif', avif: 'heif', svg: 'svg' }
    return {
      path,
      kind,
      sizeBytes: Math.round(dims[0] * dims[1] * (ext === 'png' ? 1.9 : ext === 'heic' ? 0.18 : 0.32)),
      format: fmt[ext] ?? ext,
      width: dims[0],
      height: dims[1],
      hasAudio: false,
      hasAlpha: ext === 'png',
    }
  }
  if (kind === 'audio') {
    const dur = 90 + (h % 2700)
    const codec: Record<string, string> = { wav: 'pcm_s24le', flac: 'flac', mp3: 'mp3', m4a: 'aac', ogg: 'vorbis', opus: 'opus', aif: 'pcm_s16be', aiff: 'pcm_s16be' }
    const kbps = ext === 'wav' ? 2304 : ext === 'flac' ? 980 : 256
    return {
      path,
      kind,
      sizeBytes: Math.round((dur * kbps * 1000) / 8),
      format: ext,
      durationSec: dur,
      audioCodec: codec[ext] ?? 'aac',
      hasAudio: true,
      audioChannels: 2,
      audioSampleRate: ext === 'wav' ? 48000 : 44100,
      bitrateKbps: kbps,
    }
  }
  const dims = [[1920, 1080], [3840, 2160], [1280, 720], [1080, 1920], [2560, 1440]][h % 5]
  const fps = [23.976, 25, 29.97, 59.94, 30][(h >>> 3) % 5]
  const codec: Record<string, string> = { mov: 'prores', mxf: 'dnxhd', mkv: 'hevc', webm: 'vp9', avi: 'mpeg4', wmv: 'wmv2', mpg: 'mpeg2video' }
  const dur = 8 + (h % 640)
  const kbps = ext === 'mov' ? 180000 : ext === 'mxf' ? 120000 : 16000
  return {
    path,
    kind,
    sizeBytes: Math.round((dur * kbps * 1000) / 8),
    format: ext === 'mov' || ext === 'mp4' ? 'mov,mp4,m4a,3gp,3g2,mj2' : ext,
    durationSec: dur,
    width: dims[0],
    height: dims[1],
    fps,
    videoCodec: codec[ext] ?? 'h264',
    audioCodec: 'aac',
    pixFmt: 'yuv420p',
    rotation: 0,
    hasAudio: true,
    audioChannels: 2,
    audioSampleRate: 48000,
    bitrateKbps: kbps,
  }
}

// ───────────────────────────── built-in presets ─────────────────────────────

type VS = VideoPresetSettings
function vs(container: OutputContainer, video: Partial<VS['video']>, audio: Partial<VS['audio']> = {}, extra: Partial<VS> = {}): VS {
  const d = defaultVideoSettings()
  return { ...d, container, video: { ...d.video, ...video }, audio: { ...d.audio, ...audio }, ...extra }
}

function vp(
  id: string,
  category: VideoPreset['category'],
  names: [string, string, string],
  desc: [string, string, string],
  settings: VS,
): VideoPreset {
  return {
    id,
    kind: 'video',
    builtIn: true,
    category,
    name: names[0],
    names: { en: names[0], 'zh-TW': names[1], ja: names[2] },
    description: desc[0],
    descriptions: { en: desc[0], 'zh-TW': desc[1], ja: desc[2] },
    settings,
  }
}

function ip(
  id: string,
  category: ImagePreset['category'],
  names: [string, string, string],
  desc: [string, string, string],
  actions: ImageAction[],
  output: Partial<ImageOutputSettings>,
): ImagePreset {
  return {
    id,
    kind: 'image',
    builtIn: true,
    category,
    name: names[0],
    names: { en: names[0], 'zh-TW': names[1], ja: names[2] },
    description: desc[0],
    descriptions: { en: desc[0], 'zh-TW': desc[1], ja: desc[2] },
    actions,
    output: { ...defaultImageOutput(), ...output },
  }
}

function act<T extends ImageAction['type']>(type: T, patch: Partial<Extract<ImageAction, { type: T }>> = {}): ImageAction {
  return { ...newAction(type), ...patch } as ImageAction
}

function builtInPresets(): Preset[] {
  return [
    vp('builtin-h264-source', 'web', ['H.264 — Match source', 'H.264・與來源相同', 'H.264・ソースに合わせる'],
      ['High-quality MP4 at the source size and frame rate.', '以來源的解析度與影格率輸出高畫質 MP4。', 'ソースと同じ解像度・フレームレートの高画質 MP4。'],
      vs('mp4', { rate: { mode: 'crf', crf: 20 } })),
    vp('builtin-h264-1080p', 'web', ['H.264 1080p', 'H.264 1080p', 'H.264 1080p'],
      ['Universal MP4 that plays almost everywhere.', '通用 MP4，幾乎所有裝置都能播放。', 'ほぼすべての環境で再生できる汎用 MP4。'],
      vs('mp4', { width: 1920, height: 1080 })),
    vp('builtin-h264-720p', 'web', ['H.264 720p (small)', 'H.264 720p（小檔案）', 'H.264 720p（軽量）'],
      ['Smaller files for sharing by e-mail or chat.', '檔案較小，適合用通訊軟體或 Email 分享。', 'メールやチャットで共有しやすい小さなファイル。'],
      vs('mp4', { width: 1280, height: 720, rate: { mode: 'crf', crf: 26 } }, { bitrateKbps: 128 })),
    vp('builtin-hevc-4k', 'web', ['HEVC 4K 10-bit', 'HEVC 4K 10 位元', 'HEVC 4K 10ビット'],
      ['Efficient 4K with smooth gradients (HDR-friendly).', '高效率 4K，漸層更平滑（適合 HDR 素材）。', '効率的な 4K。グラデーションが滑らか（HDR 向き）。'],
      vs('mp4', { codec: 'hevc', width: 3840, height: 2160, tenBit: true, rate: { mode: 'crf', crf: 22 } })),
    vp('builtin-webm-vp9', 'web', ['WebM VP9 (web)', 'WebM VP9（網頁用）', 'WebM VP9（Web 用）'],
      ['Open format for websites and HTML5 video.', '開放格式，適合網站與 HTML5 影片。', 'Web サイトや HTML5 動画向けのオープンな形式。'],
      vs('webm', { codec: 'vp9', hw: 'none', rate: { mode: 'crf', crf: 31 } }, { codec: 'opus', bitrateKbps: 128 }, { faststart: false })),
    vp('builtin-youtube-1080p', 'social', ['YouTube 1080p', 'YouTube 1080p', 'YouTube 1080p'],
      ['Recommended upload settings for YouTube.', 'YouTube 建議的上傳設定。', 'YouTube 推奨のアップロード設定。'],
      vs('mp4', { width: 1920, height: 1080, rate: { mode: 'vbr', bitrateKbps: 12000, maxKbps: 16000 }, speed: 'quality' }, { bitrateKbps: 320 })),
    vp('builtin-reels', 'social', ['Reels / TikTok 9:16', 'IG Reels／TikTok 直式 9:16', 'リール / TikTok 縦型 9:16'],
      ['Vertical 1080×1920, cropped to fill, loudness normalized.', '直式 1080×1920，裁切填滿並標準化音量。', '縦型 1080×1920。トリミングで全面表示、音量を正規化。'],
      vs('mp4', { width: 1080, height: 1920, scaleMode: 'crop', rate: { mode: 'crf', crf: 21 } }, { normalize: true })),
    vp('builtin-ig-portrait', 'social', ['Instagram feed 4:5', 'Instagram 貼文 4:5', 'Instagram フィード 4:5'],
      ['1080×1350 portrait for the Instagram feed.', '適合 Instagram 動態的 1080×1350 直式影片。', 'Instagram フィード用 1080×1350 縦長。'],
      vs('mp4', { width: 1080, height: 1350, scaleMode: 'crop' })),
    vp('builtin-prores-hq', 'editing', ['Apple ProRes 422 HQ', 'Apple ProRes 422 HQ', 'Apple ProRes 422 HQ'],
      ['Mastering / editing intermediate. Very large files.', '後製與母帶用的中介格式，檔案非常大。', 'マスター・編集用の中間コーデック。ファイルは非常に大きくなります。'],
      vs('mov', { codec: 'prores', profile: 'hq', hw: 'none' }, { codec: 'pcm' }, { faststart: false })),
    vp('builtin-prores-proxy', 'editing', ['ProRes Proxy (offline edit)', 'ProRes Proxy（剪輯代理檔）', 'ProRes Proxy（編集用プロキシ）'],
      ['Lightweight proxies for smooth editing.', '輕量代理檔，讓剪輯更流暢。', '軽快に編集できるプロキシファイル。'],
      vs('mov', { codec: 'prores', profile: 'proxy', hw: 'none', width: 1280, height: null }, { codec: 'pcm' }, { faststart: false })),
    vp('builtin-dnxhr-hq', 'editing', ['Avid DNxHR HQ', 'Avid DNxHR HQ', 'Avid DNxHR HQ'],
      ['Editing intermediate for Avid / DaVinci Resolve.', '適用於 Avid 與 DaVinci Resolve 的剪輯格式。', 'Avid / DaVinci Resolve 向けの編集用コーデック。'],
      vs('mov', { codec: 'dnxhr', profile: 'hq', hw: 'none' }, { codec: 'pcm' }, { faststart: false })),
    vp('builtin-av1-archive', 'archive', ['AV1 MKV — Archive', 'AV1 MKV・長期保存', 'AV1 MKV・アーカイブ'],
      ['Smallest files at high quality. Slow to encode.', '高畫質下檔案最小，但編碼較慢。', '高画質で最小サイズ。エンコードは低速。'],
      vs('mkv', { codec: 'av1', hw: 'none', speed: 'quality', rate: { mode: 'crf', crf: 28 }, tenBit: true }, { codec: 'opus', bitrateKbps: 128 }, { faststart: false })),
    vp('builtin-device-tv', 'device', ['Smart TV / media player', '智慧電視／播放器', 'スマート TV / メディアプレーヤー'],
      ['H.264 High profile 1080p for TVs and USB playback.', 'H.264 High 1080p，適合電視與 USB 播放。', 'テレビや USB 再生向け H.264 High 1080p。'],
      vs('mp4', { width: 1920, height: 1080, profile: 'high', fps: 30 })),
    vp('builtin-gif-480', 'gif', ['Animated GIF 480 px', '動態 GIF 480 px', 'アニメーション GIF 480 px'],
      ['Looping GIF for chats and documents.', '循環播放的 GIF，適合聊天與文件。', 'チャットや資料向けのループ GIF。'],
      vs('gif', { codec: 'gif', hw: 'none', gif: { fps: 12, width: 480, colors: 256, dither: 'sierra2_4a', loop: 0 } }, { codec: 'none' }, { faststart: false })),
    vp('builtin-mp3-192', 'audio', ['MP3 192 kbps', 'MP3 192 kbps', 'MP3 192 kbps'],
      ['Audio only, compatible with every player.', '只輸出音訊，所有播放器都相容。', '音声のみ。あらゆるプレーヤーで再生可能。'],
      vs('mp3', { codec: 'none' }, { codec: 'mp3', bitrateKbps: 192 }, { faststart: false })),
    vp('builtin-m4a-256', 'audio', ['AAC (M4A) 256 kbps', 'AAC（M4A）256 kbps', 'AAC（M4A）256 kbps'],
      ['High-quality AAC for Apple devices.', '高音質 AAC，適合 Apple 裝置。', 'Apple デバイス向けの高音質 AAC。'],
      vs('m4a', { codec: 'none' }, { codec: 'aac', bitrateKbps: 256 }, { faststart: true })),
    vp('builtin-wav-48k', 'audio', ['WAV 48 kHz', 'WAV 48 kHz', 'WAV 48 kHz'],
      ['Uncompressed audio for editing.', '未壓縮音訊，適合後製剪輯。', '編集用の非圧縮オーディオ。'],
      vs('wav', { codec: 'none' }, { codec: 'pcm', sampleRate: 48000 }, { faststart: false })),
    vp('builtin-flac', 'audio', ['FLAC lossless', 'FLAC 無損', 'FLAC ロスレス'],
      ['Lossless compression, about half the size of WAV.', '無損壓縮，大小約為 WAV 的一半。', 'ロスレス圧縮。サイズは WAV の約半分。'],
      vs('flac', { codec: 'none' }, { codec: 'flac' }, { faststart: false })),
    vp('builtin-podcast', 'audio', ['Podcast MP3 (−16 LUFS)', 'Podcast MP3（響度標準化）', 'ポッドキャスト MP3（ラウドネス正規化）'],
      ['Mono 128 kbps with loudness normalization.', '單聲道 128 kbps，並將響度標準化。', 'モノラル 128 kbps、ラウドネスを正規化。'],
      vs('mp3', { codec: 'none' }, { codec: 'mp3', bitrateKbps: 128, channels: 1, normalize: true }, { faststart: false })),
    ip('builtin-img-web-jpeg', 'web', ['Web JPEG 2048 px', '網頁 JPEG 2048 px', 'Web 用 JPEG 2048 px'],
      ['Long edge 2048 px, quality 82, progressive.', '長邊 2048 px、品質 82、漸進式。', '長辺 2048 px・品質 82・プログレッシブ。'],
      [act('autoOrient'), act('resize', { mode: 'longEdge', size: 2048 })], { format: 'jpeg', quality: 82, progressive: true }),
    ip('builtin-img-webp', 'web', ['WebP (quality 80)', 'WebP（品質 80）', 'WebP（品質 80）'],
      ['Modern format, about 30% smaller than JPEG.', '新一代格式，比 JPEG 小約 30%。', 'JPEG より約 30% 小さいモダンな形式。'],
      [act('autoOrient')], { format: 'webp', quality: 80 }),
    ip('builtin-img-thumb', 'web', ['Square thumbnail 400 px', '正方形縮圖 400 px', '正方形サムネイル 400 px'],
      ['Smart crop to 1:1, then 400×400.', '智慧裁切成 1:1 後縮成 400×400。', 'スマートに 1:1 へトリミングして 400×400。'],
      [act('autoOrient'), act('crop', { mode: 'aspect', aspect: '1:1', gravity: 'attention' }), act('resize', { mode: 'fit', width: 400, height: 400 })],
      { format: 'jpeg', quality: 80 }),
    ip('builtin-img-ig', 'social', ['Instagram 1080×1350', 'Instagram 1080×1350', 'Instagram 1080×1350'],
      ['4:5 portrait crop for the Instagram feed.', '裁成 4:5 直式，適合 Instagram 動態。', 'Instagram フィード向けの 4:5 縦長トリミング。'],
      [act('autoOrient'), act('crop', { mode: 'aspect', aspect: '4:5', gravity: 'center' }), act('resize', { mode: 'fill', width: 1080, height: 1350 })],
      { format: 'jpeg', quality: 90 }),
    ip('builtin-img-png', 'image', ['PNG (lossless)', 'PNG（無損）', 'PNG（ロスレス）'],
      ['Lossless, keeps transparency.', '無損壓縮，保留透明背景。', 'ロスレス。透明部分も保持します。'],
      [], { format: 'png', pngCompression: 9 }),
    ip('builtin-img-avif', 'archive', ['AVIF (small files)', 'AVIF（小檔案）', 'AVIF（軽量）'],
      ['Very small files with excellent quality.', '檔案非常小，畫質依然出色。', '非常に小さく、それでいて高画質。'],
      [act('autoOrient')], { format: 'avif', quality: 55 }),
    ip('builtin-img-watermark', 'image', ['Photo watermark ©', '相片加浮水印 ©', '写真にウォーターマーク ©'],
      ['Resize to 2560 px and add a © text watermark.', '縮成 2560 px 並加上 © 文字浮水印。', '2560 px に縮小し © テキストのウォーターマークを追加。'],
      [act('autoOrient'), act('resize', { mode: 'longEdge', size: 2560 }), act('watermark', {
        watermark: { type: 'text', text: '© {date} Studio', fontSizePct: 3.5, color: '#ffffff', bold: true, shadow: true, background: null, anchor: 'bottom-right', marginPct: 3, opacity: 0.8 },
      })], { format: 'jpeg', quality: 88 }),
    ip('builtin-img-bw', 'image', ['Black & white print', '黑白列印', 'モノクロ印刷'],
      ['Grayscale with extra contrast, 300 dpi TIFF.', '轉灰階並加強對比，輸出 300 dpi TIFF。', 'グレースケール＋コントラスト強調、300 dpi TIFF。'],
      [act('grayscale'), act('adjust', { contrast: 15 }), act('sharpen', { sigma: 0.8 })], { format: 'tiff', quality: 95, dpi: 300 }),
  ]
}

function userPresets(): Preset[] {
  return [
    {
      id: 'user-client-review',
      kind: 'video',
      builtIn: false,
      category: 'custom',
      name: 'Client review 720p (watermark)',
      description: 'Small H.264 with a CONFIDENTIAL burn-in.',
      settings: vs('mp4', { width: 1280, height: 720, rate: { mode: 'crf', crf: 26 } }, { bitrateKbps: 128 }, {
        watermark: { type: 'text', text: '{name} · CONFIDENTIAL', fontSizePct: 5, color: '#ffffff', bold: true, shadow: true, background: null, anchor: 'center', marginPct: 3, opacity: 0.35 },
      }),
    },
  ]
}

// ───────────────────────────── settings ─────────────────────────────

const SETTINGS_KEY = 'mc-mock-settings'

function defaultSettings(): AppSettings {
  return {
    language: 'auto',
    theme: 'dark',
    videoConcurrency: 1,
    imageConcurrency: 4,
    autoStart: false,
    defaultOutputDir: null,
    defaultNameTemplate: '{name}_{preset}',
    conflict: 'rename',
    preferredHw: 'auto',
    lastVideoPresetId: 'builtin-h264-1080p',
    lastImagePresetId: 'builtin-img-web-jpeg',
    notifyOnFinish: true,
    preventSleep: true,
    removeFinished: false,
    ffmpegPath: null,
  }
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    /* storage unavailable */
  }
  return defaultSettings()
}

function navigatorLocale(): Locale {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'zh-TW').toLowerCase()
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('en')) return 'en'
  return 'zh-TW'
}

// ───────────────────────────── the mock ─────────────────────────────

export function createMockApi(): MediaApi {
  let presets: Preset[] = [...builtInPresets(), ...userPresets()]
  let settings = loadSettings()
  let running = true
  let jobs: Job[] = []
  let watchFolders: WatchFolder[] = [
    {
      id: 'wf-1',
      path: 'D:\\Dropbox\\客戶上傳',
      enabled: true,
      presetIds: ['builtin-h264-1080p', 'builtin-img-web-jpeg'],
      outputDir: null,
      includeSubfolders: true,
      afterProcess: 'move',
      processExisting: false,
    },
    {
      id: 'wf-2',
      path: '\\\\NAS\\Camera\\Ingest',
      enabled: false,
      presetIds: ['builtin-prores-proxy'],
      outputDir: 'E:\\Proxies',
      includeSubfolders: false,
      afterProcess: 'keep',
      processExisting: true,
    },
  ]
  const listeners = new Set<(e: QueueEvent) => void>()
  let counter = 0
  let pickCount = 0
  let runStats = { done: 0, failed: 0, cancelled: 0, skipped: 0 }
  let timer: ReturnType<typeof setInterval> | null = null
  let emptyVideoUrl: string | null = null

  const findPreset = (id: string): Preset | undefined => presets.find((p) => p.id === id)
  const localName = (p: Preset): string => p.names?.[resolvedLocale()] ?? p.name
  const resolvedLocale = (): Locale => (settings.language === 'auto' ? navigatorLocale() : settings.language)

  function makeJob(source: string, presetId: string, extra: Partial<Job> = {}, info?: Partial<MediaInfo>): Job {
    const sourceInfo = { ...fakeInfo(source), ...info }
    let preset = findPreset(presetId)
    const kind: Job['kind'] = sourceInfo.kind === 'image' ? 'image' : 'video'
    if (!preset || (kind === 'image') !== (preset.kind === 'image')) {
      preset = findPreset(kind === 'image' ? settings.lastImagePresetId : settings.lastVideoPresetId)!
    }
    if (sourceInfo.kind === 'audio' && preset.kind === 'video' && !isAudioOnlyContainer(preset.settings.container)) {
      preset = findPreset('builtin-mp3-192')!
    }
    const job: Job = {
      id: `job-${++counter}`,
      kind,
      source,
      sourceInfo,
      presetId: preset.id,
      presetName: localName(preset),
      output: { dir: settings.defaultOutputDir, nameTemplate: settings.defaultNameTemplate, conflict: settings.conflict },
      status: 'queued',
      progress: 0,
      createdAt: Date.now() - (1000 - counter) * 1000,
      ...extra,
    }
    if (preset.kind === 'video') job.video = { settings: clone(preset.settings), trim: null }
    else job.image = { actions: clone(preset.actions), output: clone(preset.output) }
    return job
  }

  function outputExt(job: Job): string {
    if (job.kind === 'video') return job.video!.settings.container
    const f = job.image!.output.format
    if (f === 'keep') {
      const e = extOf(job.source)
      return ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif'].includes(e) ? e : 'png'
    }
    return f === 'jpeg' ? 'jpg' : f === 'tiff' ? 'tif' : f
  }

  function encoderFor(job: Job): string {
    if (job.kind === 'image') return 'sharp'
    const s = job.video!.settings
    const c = s.video.codec
    if (c === 'none') return ({ mp3: 'libmp3lame', aac: 'aac', pcm: 'pcm_s16le', flac: 'flac', opus: 'libopus', copy: 'copy', none: 'none' } as const)[s.audio.codec]
    const hw = s.video.hw === 'auto' ? settings.preferredHw : s.video.hw
    if ((hw === 'auto' || hw === 'nvenc') && ['h264', 'hevc', 'av1'].includes(c)) return `${c}_nvenc`
    if (hw === 'qsv' && ['h264', 'hevc', 'av1'].includes(c)) return `${c}_qsv`
    return ({ h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1', vp9: 'libvpx-vp9', prores: 'prores_ks', dnxhr: 'dnxhd', gif: 'gif', copy: 'copy' } as Record<string, string>)[c] ?? c
  }

  function resolveOutputPath(job: Job): string {
    const dir = job.output.dir ?? dirName(job.source)
    const parent = fileName(dirName(job.source))
    const size = job.kind === 'video' ? computeVideoOutputSize(job.sourceInfo, job.video!.settings) : null
    const name = renderNameTemplate(job.output.nameTemplate, {
      name: baseNameOf(job.source),
      ext: extOf(job.source),
      preset: job.presetName,
      parent,
      width: size?.width ?? job.sourceInfo?.width,
      height: size?.height ?? job.sourceInfo?.height,
      counter: jobs.indexOf(job) + 1,
      now: new Date(),
    })
    return joinPath(dir, `${name}.${outputExt(job)}`)
  }

  function estimateOutputSize(job: Job): number {
    const info = job.sourceInfo
    if (job.kind === 'image') {
      const px = (info?.width ?? 2000) * (info?.height ?? 1500)
      return Math.round(px * 0.09 * ((job.image!.output.quality || 80) / 80))
    }
    const s = job.video!.settings
    const dur = job.video!.trim ? job.video!.trim.outSec - job.video!.trim.inSec : info?.durationSec ?? 60
    let kbps = 6000
    if (s.video.codec === 'none') kbps = s.audio.codec === 'pcm' ? 1536 : s.audio.codec === 'flac' ? 900 : s.audio.bitrateKbps ?? 192
    else if (s.video.codec === 'prores') kbps = 160000
    else if (s.video.codec === 'dnxhr') kbps = 140000
    else if (s.video.rate.mode !== 'crf') kbps = s.video.rate.bitrateKbps
    else kbps = 9000 * Math.pow(0.88, s.video.rate.crf - 20)
    return Math.round((dur * kbps * 1000) / 8)
  }

  function snapshot(): QueueSnapshot {
    return { jobs: clone(jobs), running }
  }

  function emit(e: QueueEvent): void {
    for (const cb of listeners) {
      try {
        cb(e)
      } catch (err) {
        console.error(err)
      }
    }
  }
  const emitSnapshot = (): void => emit({ type: 'snapshot', state: snapshot() })

  function ensureTimer(): void {
    if (timer) return
    timer = setInterval(tick, 250)
  }

  function startJob(job: Job): void {
    job.status = 'running'
    job.progress = 0
    job.startedAt = Date.now()
    job.elapsedSec = 0
    job.encoder = encoderFor(job)
    job.outputPath = resolveOutputPath(job)
    job.error = undefined
    job.logTail = undefined
  }

  function schedule(): void {
    if (!running) return
    const runningVideo = jobs.filter((j) => j.status === 'running' && j.kind === 'video').length
    const runningImage = jobs.filter((j) => j.status === 'running' && j.kind === 'image').length
    let freeV = Math.max(0, settings.videoConcurrency - runningVideo)
    let freeI = Math.max(0, settings.imageConcurrency - runningImage)
    for (const j of jobs) {
      if (j.status !== 'queued') continue
      if (j.kind === 'video' && freeV > 0) {
        startJob(j)
        freeV--
      } else if (j.kind === 'image' && freeI > 0) {
        startJob(j)
        freeI--
      }
    }
  }

  function tick(): void {
    if (!running) return
    const items: JobProgress[] = []
    let structural = false
    for (const j of jobs) {
      if (j.status !== 'running') continue
      const info = j.sourceInfo
      const gpu = /nvenc|qsv|amf/.test(j.encoder ?? '')
      const speed = j.kind === 'image' ? 1 : j.encoder === 'none' || j.video?.settings.video.codec === 'none' ? 38 : gpu ? 2.4 + (hashStr(j.id) % 20) / 10 : 0.7 + (hashStr(j.id) % 9) / 10
      const dur = j.kind === 'image' ? 1.4 : Math.min(80, Math.max(14, (info?.durationSec ?? 60) / speed))
      j.progress = Math.min(1, j.progress + 0.25 / dur)
      j.elapsedSec = (j.elapsedSec ?? 0) + 0.25
      j.speed = j.kind === 'video' ? Math.round((speed + Math.sin(Date.now() / 900) * 0.15) * 100) / 100 : undefined
      j.fps = j.kind === 'video' && info?.fps ? Math.round(info.fps * (j.speed ?? 1)) : undefined
      j.etaSec = Math.max(0, (1 - j.progress) * dur)
      if (/corrupt/i.test(j.source) && j.progress >= 0.35) {
        j.status = 'failed'
        j.error = 'Invalid data found when processing input'
        j.logTail = corruptLog(j.source, j.encoder ?? 'libx264')
        j.finishedAt = Date.now()
        runStats.failed++
        structural = true
        continue
      }
      if (j.progress >= 1) {
        j.status = 'done'
        j.progress = 1
        j.etaSec = 0
        j.outputSizeBytes = estimateOutputSize(j)
        j.finishedAt = Date.now()
        runStats.done++
        structural = true
        continue
      }
      items.push({ id: j.id, progress: j.progress, speed: j.speed, fps: j.fps, etaSec: j.etaSec, elapsedSec: j.elapsedSec })
    }
    if (items.length) emit({ type: 'progress', items })
    if (structural) {
      if (settings.removeFinished) jobs = jobs.filter((j) => j.status !== 'done')
      schedule()
      const active = jobs.some((j) => j.status === 'running' || j.status === 'queued')
      if (!active) {
        running = false
        emitSnapshot()
        emit({ type: 'finished', summary: { ...runStats } })
        return
      }
      emitSnapshot()
    }
  }

  function seedJobs(): void {
    const now = Date.now()
    jobs = [
      makeJob('C:\\Users\\Demo\\Videos\\screen recording 2026-09-30.mkv', 'builtin-hevc-4k', {
        status: 'done', progress: 1, encoder: 'hevc_nvenc', outputSizeBytes: 48_234_112,
        outputPath: 'C:\\Users\\Demo\\Videos\\screen recording 2026-09-30_HEVC 4K 10-bit.mp4', startedAt: now - 300_000, finishedAt: now - 240_000,
      }, { width: 2560, height: 1440, durationSec: 734, fps: 60, videoCodec: 'hevc' }),
      makeJob('C:\\Users\\Demo\\Pictures\\京都旅行\\IMG_2041.HEIC', 'builtin-img-web-jpeg', {
        status: 'done', progress: 1, encoder: 'sharp', outputSizeBytes: 1_284_301,
        outputPath: 'C:\\Users\\Demo\\Pictures\\京都旅行\\IMG_2041_Web JPEG 2048 px.jpg', finishedAt: now - 200_000,
      }, { width: 4032, height: 3024 }),
      makeJob('C:\\Users\\Demo\\Videos\\corrupted_clip.avi', 'builtin-h264-1080p', {
        status: 'failed', progress: 0.37, encoder: 'h264_nvenc', error: 'Invalid data found when processing input',
        logTail: corruptLog('C:\\Users\\Demo\\Videos\\corrupted_clip.avi', 'h264_nvenc'), finishedAt: now - 150_000,
      }, { width: 1280, height: 720, durationSec: 134, fps: 23.976, videoCodec: 'mpeg4' }),
      makeJob('D:\\Footage\\2026 春季發表會\\A001_C003_0412.mov', 'builtin-h264-1080p', {
        status: 'running', progress: 0.42, encoder: 'h264_nvenc', speed: 2.3, fps: 55, etaSec: 38, elapsedSec: 27, startedAt: now - 27_000,
        outputPath: 'D:\\Footage\\2026 春季發表會\\A001_C003_0412_H.264 1080p.mp4',
      }, { width: 3840, height: 2160, durationSec: 156, fps: 23.976, videoCodec: 'prores' }),
      makeJob('D:\\Footage\\2026 春季發表會\\訪談_王經理.mp4', 'builtin-youtube-1080p', {}, { width: 1920, height: 1080, durationSec: 1265, fps: 29.97, videoCodec: 'h264' }),
      makeJob('D:\\Footage\\Drone\\DJI_0042.MP4', 'builtin-reels', {}, { width: 3840, height: 2160, durationSec: 48, fps: 59.94, videoCodec: 'hevc' }),
      makeJob('C:\\Users\\Demo\\Music\\Podcast EP12 — 原始錄音.wav', 'builtin-podcast', {}, { durationSec: 2712 }),
      makeJob('C:\\Users\\Demo\\Pictures\\京都旅行\\IMG_2042.jpg', 'builtin-img-web-jpeg', {}, { width: 6000, height: 4000 }),
      makeJob('C:\\Users\\Demo\\Pictures\\product shots\\bottle_white_bg.png', 'builtin-img-webp', {}, { width: 3000, height: 3000, hasAlpha: true }),
      makeJob('C:\\Users\\Demo\\Videos\\old_intro.mp4', 'builtin-gif-480', { status: 'cancelled', progress: 0.12 }, { width: 1280, height: 720, durationSec: 12, fps: 30 }),
      makeJob('C:\\Users\\Demo\\Pictures\\京都旅行\\IMG_2040.jpg', 'builtin-img-web-jpeg', {
        status: 'skipped', progress: 0, error: 'Output file already exists', outputPath: 'C:\\Users\\Demo\\Pictures\\京都旅行\\IMG_2040_Web JPEG 2048 px.jpg',
      }, { width: 4032, height: 3024 }),
    ]
    jobs[0].output.dir = null
    jobs[3].output.dir = null
    jobs[4].output.dir = 'D:\\Exports\\2026 春季發表會'
    jobs[5].output.dir = 'D:\\Exports\\Social'
  }

  function corruptLog(src: string, encoder: string): string[] {
    return [
      `Input #0, avi, from '${src}':`,
      '  Duration: 00:02:14.08, start: 0.000000, bitrate: 8123 kb/s',
      '  Stream #0:0: Video: mpeg4 (Simple Profile) (XVID / 0x44495658), yuv420p, 1280x720, 23.98 fps',
      '  Stream #0:1: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s',
      'Stream mapping:',
      `  Stream #0:0 -> #0:0 (mpeg4 (native) -> h264 (${encoder}))`,
      '  Stream #0:1 -> #0:1 (mp3 (mp3float) -> aac (native))',
      '[mpeg4 @ 0000021f8c1d2a40] ac-tex damaged at 31 22',
      '[mpeg4 @ 0000021f8c1d2a40] Error at MB: 1013',
      '[mpeg4 @ 0000021f8c1d2a40] concealing 2700 DC, 2700 AC, 2700 MV errors in P frame',
      '[avi @ 0000021f8c1c9f80] Packet corrupt (stream = 0, dts = 1342).',
      '[in#0/avi @ 0000021f8c1c9e00] Error during demuxing: Invalid data found when processing input',
      `[vost#0:0/${encoder} @ 0000021f8c1e5b00] Error while encoding: Invalid data found when processing input`,
      'Conversion failed!',
    ]
  }

  function expandFolder(dir: string, recursive: boolean): string[] {
    const n = (hashStr(dir) % 3) + 2
    const out: string[] = []
    for (let i = 1; i <= n; i++) out.push(joinPath(dir, `IMG_${String(3000 + i)}.jpg`))
    out.push(joinPath(dir, 'clip_01.mov'), joinPath(dir, 'notes.txt'), joinPath(dir, 'Thumbs.db'))
    if (recursive) out.push(joinPath(joinPath(dir, 'Selects'), 'IMG_3100.png'), joinPath(joinPath(dir, 'Selects'), 'voiceover.m4a'))
    return out
  }

  function applyPresetTo(job: Job, preset: Preset): boolean {
    if (job.status === 'running' || job.status === 'done' || job.status === 'skipped') return false
    if ((job.kind === 'image') !== (preset.kind === 'image')) return false
    if (job.sourceInfo?.kind === 'audio' && preset.kind === 'video' && !isAudioOnlyContainer(preset.settings.container)) return false
    job.presetId = preset.id
    job.presetName = localName(preset)
    if (preset.kind === 'video') job.video = { settings: clone(preset.settings), trim: job.video?.trim ?? null }
    else job.image = { actions: clone(preset.actions), output: clone(preset.output) }
    requeue(job)
    return true
  }

  function requeue(job: Job): void {
    if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'done' || job.status === 'skipped') {
      job.status = 'queued'
      job.progress = 0
      job.error = undefined
      job.logTail = undefined
      job.outputSizeBytes = undefined
      job.speed = undefined
      job.etaSec = undefined
    }
  }

  seedJobs()
  ensureTimer()

  const api: MediaApi = {
    async getAppInfo(): Promise<AppInfo> {
      return {
        name: 'Media Converter',
        version: '0.1.0',
        platform: 'win32',
        arch: 'x64',
        locale: navigatorLocale(),
        userDataDir: 'C:\\Users\\Demo\\AppData\\Roaming\\Media Converter',
        electronVersion: '44.5.1 (browser mock)',
        sharpVersion: '0.35.5',
        libvipsVersion: '8.18.0',
      }
    },
    async getCapabilities(refresh?: boolean): Promise<EncoderCapabilities> {
      await delay(refresh ? 1400 : 120)
      return {
        ffmpegPath: settings.ffmpegPath ?? 'C:\\ffmpeg\\bin\\ffmpeg.exe',
        ffprobePath: settings.ffmpegPath ? joinPath(settings.ffmpegPath, 'ffprobe.exe') : 'C:\\ffmpeg\\bin\\ffprobe.exe',
        ffmpegVersion: '8.1.2-full_build-www.gyan.dev',
        ffmpegSource: settings.ffmpegPath ? 'custom' : 'system',
        compiledEncoders: [
          'libx264', 'libx265', 'libsvtav1', 'libaom-av1', 'libvpx-vp9', 'prores_ks', 'dnxhd', 'gif', 'aac', 'libmp3lame', 'libopus', 'flac', 'pcm_s16le',
          'h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv', 'h264_amf', 'hevc_amf', 'av1_amf',
        ],
        workingHwEncoders: ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'h264_qsv', 'hevc_qsv', 'av1_qsv'],
        hw: { nvenc: true, qsv: true, amf: false, videotoolbox: false },
      }
    },

    async pickFiles(kind: FileKindFilter, multi = true): Promise<string[]> {
      await delay(200)
      pickCount++
      const n = String(pickCount).padStart(2, '0')
      const pick = (list: string[]): string[] => (multi ? list : list.slice(0, 1))
      switch (kind) {
        case 'watermark':
          return ['C:\\Users\\Demo\\Pictures\\Brand\\studio_logo.png']
        case 'image':
          return pick([`C:\\Users\\Demo\\Pictures\\新增相片\\DSC0${n}21.jpg`, `C:\\Users\\Demo\\Pictures\\新增相片\\DSC0${n}22.jpg`])
        case 'video':
          return pick([`C:\\Users\\Demo\\Videos\\Project ${n}\\Interview take ${n}.mp4`])
        case 'audio':
          return pick([`C:\\Users\\Demo\\Music\\BGM ${n}.flac`])
        case 'presets':
          return ['C:\\Users\\Demo\\Documents\\presets.json']
        default:
          return pick([
            `C:\\Users\\Demo\\Videos\\Project ${n}\\Interview take ${n}.mp4`,
            `C:\\Users\\Demo\\Pictures\\新增相片\\DSC0${n}21.jpg`,
            `C:\\Users\\Demo\\Music\\BGM ${n}.flac`,
          ])
      }
    },
    async pickFolder(): Promise<string | null> {
      await delay(200)
      pickCount++
      return `D:\\Exports\\Batch ${String(pickCount).padStart(2, '0')}`
    },
    getPathForFile(file: File): string {
      const p = (file as File & { path?: string }).path
      return p || `C:\\Users\\Demo\\Desktop\\${file.name}`
    },
    async probe(path: string): Promise<MediaInfo> {
      await delay(60)
      return jobs.find((j) => j.source === path)?.sourceInfo ?? fakeInfo(path)
    },
    async getThumbnail(path: string, maxSize = 160): Promise<string | null> {
      await delay(120 + (hashStr(path) % 280))
      const info = jobs.find((j) => j.source === path)?.sourceInfo ?? fakeInfo(path)
      if (info.kind === 'audio') return null
      const w = info.width ?? 1600
      const h = info.height ?? 900
      return svgUrl(wrapSvg(scene(hashStr(path), w, h, 3), w, h, maxSize))
    },
    mediaUrl(): string {
      // An empty blob: the <video> element fires `error`, exercising the frame-scrubber fallback.
      if (!emptyVideoUrl) emptyVideoUrl = URL.createObjectURL(new Blob([], { type: 'video/mp4' }))
      return emptyVideoUrl
    },
    async revealInFolder(path: string): Promise<void> {
      console.info('[mock] reveal', path)
    },
    async openPath(path: string): Promise<void> {
      console.info('[mock] open', path)
    },

    async listPresets(): Promise<Preset[]> {
      await delay(40)
      return clone(presets)
    },
    async savePreset(preset: Preset): Promise<Preset> {
      await delay(80)
      const existing = presets.find((p) => p.id === preset.id)
      if (!preset.id || !existing || existing.builtIn) {
        const copy = clone(preset)
        copy.id = `user-${Date.now().toString(36)}-${(++counter).toString(36)}`
        copy.builtIn = false
        if (existing?.builtIn) {
          copy.name = `${localName(existing)} (copy)`
          copy.names = undefined
          copy.descriptions = undefined
          copy.category = existing.category
        }
        presets.push(copy)
        return clone(copy)
      }
      const saved = { ...clone(preset), builtIn: false }
      presets = presets.map((p) => (p.id === preset.id ? saved : p))
      return clone(saved)
    },
    async deletePreset(id: string): Promise<void> {
      await delay(60)
      const p = findPreset(id)
      if (!p) return
      if (p.builtIn) throw new Error('Built-in presets cannot be deleted')
      presets = presets.filter((x) => x.id !== id)
    },
    async importPresets(): Promise<Preset[]> {
      await delay(300)
      const imported: Preset = {
        id: `user-import-${(++counter).toString(36)}`,
        kind: 'video',
        builtIn: false,
        category: 'custom',
        name: 'Vimeo 1080p (imported)',
        settings: vs('mp4', { width: 1920, height: 1080, rate: { mode: 'vbr', bitrateKbps: 10000, maxKbps: 14000 } }, { bitrateKbps: 320 }),
      }
      presets.push(imported)
      return [clone(imported)]
    },
    async exportPresets(ids: string[]): Promise<boolean> {
      await delay(300)
      console.info('[mock] export presets', ids)
      return true
    },

    async getQueue(): Promise<QueueSnapshot> {
      return snapshot()
    },
    async addJobs(req: AddJobsRequest): Promise<AddJobsResult> {
      await delay(150)
      const added: Job[] = []
      const ignored: string[] = []
      const queue = [...req.paths]
      const expanded: string[] = []
      for (const p of queue) {
        if (!extOf(p)) expanded.push(...expandFolder(p, !!req.recursive))
        else expanded.push(p)
      }
      for (const p of expanded) {
        const kind = classifyPath(p)
        if (!kind) {
          ignored.push(p)
          continue
        }
        const presetId = kind === 'image' ? req.imagePresetId ?? settings.lastImagePresetId : req.videoPresetId ?? settings.lastVideoPresetId
        const job = makeJob(p, presetId, { createdAt: Date.now(), watchFolderId: req.watchFolderId })
        if (kind === 'image' && req.imageOverride) {
          job.image = clone(req.imageOverride)
          job.presetId = ''
          job.presetName = 'Custom'
        }
        job.output = { ...job.output, ...req.output }
        jobs.push(job)
        added.push(job)
      }
      if (settings.autoStart && added.length) {
        running = true
        runStats = { done: 0, failed: 0, cancelled: 0, skipped: 0 }
        schedule()
      }
      emitSnapshot()
      return { jobs: clone(added), ignored }
    },
    async updateJob(id: string, patch: JobPatch): Promise<Job> {
      await delay(60)
      const job = jobs.find((j) => j.id === id)
      if (!job) throw new Error(`Job not found: ${id}`)
      if (job.status === 'running') throw new Error('Running jobs cannot be edited')
      if (patch.presetId) {
        const p = findPreset(patch.presetId)
        if (p) applyPresetTo(job, p)
      }
      if (patch.video && job.video) {
        if (patch.video.settings) {
          job.video.settings = clone(patch.video.settings)
          if (!patch.presetId) job.presetName = job.presetName.endsWith('*') ? job.presetName : `${job.presetName}*`
        }
        if (patch.video.trim !== undefined) job.video.trim = patch.video.trim ? { ...patch.video.trim } : null
      }
      if (patch.image && job.image) {
        if (patch.image.actions) job.image.actions = clone(patch.image.actions)
        if (patch.image.output) job.image.output = clone(patch.image.output)
        if (!patch.presetId && !job.presetName.endsWith('*')) job.presetName = `${job.presetName}*`
      }
      if (patch.output) job.output = { ...job.output, ...patch.output }
      requeue(job)
      emitSnapshot()
      return clone(job)
    },
    async applyPreset(jobIds: string[], presetId: string): Promise<void> {
      await delay(60)
      const p = findPreset(presetId)
      if (!p) throw new Error(`Preset not found: ${presetId}`)
      for (const j of jobs) if (jobIds.includes(j.id)) applyPresetTo(j, p)
      if (p.kind === 'video') settings.lastVideoPresetId = p.id
      else settings.lastImagePresetId = p.id
      emitSnapshot()
    },
    async duplicateJobs(ids: string[]): Promise<void> {
      await delay(60)
      const next: Job[] = []
      for (const j of jobs) {
        next.push(j)
        if (ids.includes(j.id)) {
          const copy = clone(j)
          copy.id = `job-${++counter}`
          copy.createdAt = Date.now()
          copy.status = 'queued'
          copy.progress = 0
          copy.error = undefined
          copy.logTail = undefined
          copy.outputPath = undefined
          copy.outputSizeBytes = undefined
          copy.encoder = undefined
          copy.speed = undefined
          copy.etaSec = undefined
          next.push(copy)
        }
      }
      jobs = next
      emitSnapshot()
    },
    async removeJobs(ids: string[]): Promise<void> {
      await delay(40)
      jobs = jobs.filter((j) => !ids.includes(j.id))
      schedule()
      emitSnapshot()
    },
    async reorderJobs(ids: string[]): Promise<void> {
      const byId = new Map(jobs.map((j) => [j.id, j]))
      const ordered = ids.map((id) => byId.get(id)).filter((j): j is Job => !!j)
      const rest = jobs.filter((j) => !ids.includes(j.id))
      jobs = [...ordered, ...rest]
      emitSnapshot()
    },
    async retryJobs(ids: string[]): Promise<void> {
      await delay(40)
      for (const j of jobs) if (ids.includes(j.id)) requeue(j)
      schedule()
      emitSnapshot()
    },
    async clearFinished(): Promise<void> {
      await delay(40)
      jobs = jobs.filter((j) => j.status !== 'done' && j.status !== 'skipped')
      emitSnapshot()
    },
    async startQueue(): Promise<void> {
      await delay(40)
      running = true
      runStats = { done: 0, failed: 0, cancelled: 0, skipped: 0 }
      schedule()
      if (!jobs.some((j) => j.status === 'running' || j.status === 'queued')) running = false
      emitSnapshot()
    },
    async stopQueue(): Promise<void> {
      await delay(40)
      running = false
      for (const j of jobs) {
        if (j.status === 'running') {
          j.status = 'queued'
          j.progress = 0
          j.speed = undefined
          j.etaSec = undefined
        }
      }
      emitSnapshot()
    },
    async cancelJobs(ids: string[]): Promise<void> {
      await delay(40)
      for (const j of jobs) {
        if (ids.includes(j.id) && (j.status === 'running' || j.status === 'queued')) {
          j.status = 'cancelled'
          j.speed = undefined
          j.etaSec = undefined
          runStats.cancelled++
        }
      }
      schedule()
      emitSnapshot()
    },
    onQueueEvent(cb: (e: QueueEvent) => void): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    async getVideoFrame(path: string, timeSec: number, maxWidth = 960): Promise<string> {
      await delay(70)
      const info = jobs.find((j) => j.source === path)?.sourceInfo ?? fakeInfo(path)
      const W = info.width ?? 1920
      const H = info.height ?? 1080
      const fs = H * 0.045
      const tc = `${new Date(timeSec * 1000).toISOString().slice(11, 19)}`
      const overlay = `<rect x="${fs * 0.6}" y="${H - fs * 2.2}" width="${fs * 5.4}" height="${fs * 1.6}" rx="${fs * 0.2}" fill="#000" fill-opacity="0.55"/>` +
        `<text x="${fs * 0.95}" y="${H - fs * 1.0}" font-family="Consolas, monospace" font-size="${fs}" fill="#fff">${tc}</text>`
      return svgUrl(wrapSvg(scene(hashStr(path), W, H, timeSec) + overlay, W, H, maxWidth))
    },
    async previewVideoFrame(path: string, timeSec: number, s: VideoPresetSettings, maxWidth = 960): Promise<string> {
      await delay(160)
      const info = jobs.find((j) => j.source === path)?.sourceInfo ?? fakeInfo(path)
      const W = info.width ?? 1920
      const H = info.height ?? 1080
      const out = computeVideoOutputSize(info, s) ?? { width: W, height: H }
      const both = !!(s.video.width && s.video.height)
      const par = !both || s.container === 'gif' ? 'none' : s.video.scaleMode === 'pad' ? 'xMidYMid meet' : s.video.scaleMode === 'crop' ? 'xMidYMid slice' : 'none'
      const inner =
        `<rect width="${out.width}" height="${out.height}" fill="#000"/>` +
        `<svg width="${out.width}" height="${out.height}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="${par}">${scene(hashStr(path), W, H, timeSec)}</svg>` +
        (s.watermark && s.video.codec !== 'copy' ? watermarkSvg(s.watermark, out.width, out.height, path) : '')
      return svgUrl(wrapSvg(inner, out.width, out.height, maxWidth))
    },
    async previewImage(path: string, actions: ImageAction[], _output: ImageOutputSettings, maxSize = 1200): Promise<ImagePreviewResult> {
      await delay(180)
      const info = jobs.find((j) => j.source === path)?.sourceInfo ?? fakeInfo(path)
      const W = info.width ?? 1600
      const H = info.height ?? 1200
      const r = renderImageChain(info, actions)
      return {
        before: svgUrl(wrapSvg(scene(hashStr(path), W, H), W, H, maxSize)),
        after: svgUrl(wrapSvg(r.svg, r.w, r.h, maxSize)),
        outWidth: r.w,
        outHeight: r.h,
      }
    },

    async listWatchFolders(): Promise<WatchFolder[]> {
      await delay(40)
      return clone(watchFolders)
    },
    async saveWatchFolder(w: WatchFolder): Promise<WatchFolder> {
      await delay(50)
      const saved = clone(w)
      if (!saved.id) saved.id = `wf-${Date.now().toString(36)}`
      const i = watchFolders.findIndex((x) => x.id === saved.id)
      if (i >= 0) watchFolders[i] = saved
      else watchFolders = [...watchFolders, saved]
      return clone(saved)
    },
    async deleteWatchFolder(id: string): Promise<void> {
      await delay(40)
      watchFolders = watchFolders.filter((w) => w.id !== id)
    },

    async getSettings(): Promise<AppSettings> {
      return clone(settings)
    },
    async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
      settings = { ...settings, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch {
        /* storage unavailable */
      }
      if (patch.videoConcurrency || patch.imageConcurrency) schedule()
      return clone(settings)
    },

    onExternalFiles(): () => void {
      return () => {}
    },
  }
  return api
}

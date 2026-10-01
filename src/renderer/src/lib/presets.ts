// Preset helpers: display names, grouping, compatibility, defaults.
import type {
  ImageAction,
  ImageActionType,
  ImageOutputSettings,
  ImagePreset,
  Job,
  Locale,
  Preset,
  PresetCategory,
  VideoPreset,
  VideoPresetSettings,
  Watermark,
} from '../../../shared/types'
import { isAudioOnlyContainer } from '../../../shared/videoRules'
import { uid } from './format'

export const CATEGORY_ORDER: PresetCategory[] = ['web', 'social', 'editing', 'archive', 'device', 'gif', 'audio', 'image', 'custom']

export function presetName(p: Pick<Preset, 'name' | 'names'>, locale: Locale): string {
  return p.names?.[locale] ?? p.name
}

export function presetDescription(p: Pick<Preset, 'description' | 'descriptions'>, locale: Locale): string {
  return p.descriptions?.[locale] ?? p.description ?? ''
}

export function isAudioPreset(p: Preset): boolean {
  return p.kind === 'video' && isAudioOnlyContainer(p.settings.container)
}

/** Presets that can be applied to a job (audio sources only get audio-only presets). */
export function isPresetCompatible(job: Job, p: Preset): boolean {
  if (job.kind === 'image') return p.kind === 'image'
  if (p.kind !== 'video') return false
  if (job.sourceInfo?.kind === 'audio') return isAudioPreset(p)
  return true
}

export function groupByCategory<T extends Preset>(presets: T[]): [PresetCategory, T[]][] {
  const map = new Map<PresetCategory, T[]>()
  for (const p of presets) {
    const list = map.get(p.category) ?? []
    list.push(p)
    map.set(p.category, list)
  }
  return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => [c, map.get(c)!])
}

export function isEditableJob(job: Job): boolean {
  return job.status === 'queued' || job.status === 'failed' || job.status === 'cancelled'
}

export function defaultVideoSettings(): VideoPresetSettings {
  return {
    container: 'mp4',
    video: {
      codec: 'h264',
      hw: 'auto',
      rate: { mode: 'crf', crf: 23 },
      speed: 'balanced',
      profile: null,
      width: null,
      height: null,
      scaleMode: 'fit',
      noUpscale: true,
      fps: null,
      tenBit: false,
    },
    audio: { codec: 'aac', bitrateKbps: 192, sampleRate: null, channels: null, normalize: false },
    watermark: null,
    faststart: true,
    stripMetadata: false,
  }
}

export function defaultImageOutput(): ImageOutputSettings {
  return {
    format: 'jpeg',
    quality: 85,
    lossless: false,
    progressive: true,
    chromaSubsampling: '4:2:0',
    pngCompression: 6,
    keepMetadata: false,
    background: '#ffffff',
    dpi: null,
  }
}

export function newVideoPreset(name: string): VideoPreset {
  return { id: '', kind: 'video', name, category: 'custom', builtIn: false, settings: defaultVideoSettings() }
}

export function newImagePreset(name: string): ImagePreset {
  return {
    id: '',
    kind: 'image',
    name,
    category: 'image',
    builtIn: false,
    actions: [newAction('resize')],
    output: defaultImageOutput(),
  }
}

export function defaultTextWatermark(): Watermark {
  return {
    type: 'text',
    text: '© {name}',
    fontSizePct: 4,
    color: '#ffffff',
    bold: true,
    shadow: true,
    background: null,
    anchor: 'bottom-right',
    marginPct: 3,
    opacity: 0.85,
  }
}

export function newAction(type: ImageActionType): ImageAction {
  const base = { id: uid('act'), enabled: true }
  switch (type) {
    case 'resize':
      return { ...base, type, mode: 'longEdge', size: 2048, width: 1920, height: 1080, percent: 50, withoutEnlargement: true, kernel: 'lanczos3' }
    case 'crop':
      return { ...base, type, mode: 'aspect', aspect: '1:1', gravity: 'center', left: 0, top: 0, width: 1000, height: 1000, edges: { top: 0, right: 0, bottom: 0, left: 0 } }
    case 'rotate':
      return { ...base, type, angle: 90, background: '#000000' }
    case 'flip':
      return { ...base, type, axis: 'horizontal' }
    case 'autoOrient':
      return { ...base, type }
    case 'adjust':
      return { ...base, type, brightness: 0, contrast: 0, saturation: 0, hue: 0, gamma: 1 }
    case 'grayscale':
      return { ...base, type }
    case 'sepia':
      return { ...base, type }
    case 'invert':
      return { ...base, type }
    case 'sharpen':
      return { ...base, type, sigma: 1 }
    case 'blur':
      return { ...base, type, sigma: 2 }
    case 'canvas':
      return { ...base, type, top: 40, right: 40, bottom: 40, left: 40, unit: 'px', color: '#ffffff' }
    case 'trim':
      return { ...base, type, threshold: 10 }
    case 'watermark':
      return { ...base, type, watermark: defaultTextWatermark() }
  }
}

export const ACTION_GROUPS: { group: 'transform' | 'color' | 'filters' | 'overlay'; types: ImageActionType[] }[] = [
  { group: 'transform', types: ['resize', 'crop', 'rotate', 'flip', 'autoOrient', 'canvas', 'trim'] },
  { group: 'color', types: ['adjust', 'grayscale', 'sepia', 'invert'] },
  { group: 'filters', types: ['sharpen', 'blur'] },
  { group: 'overlay', types: ['watermark'] },
]

/** Deep clone for editable drafts. */
export function clone<T>(v: T): T {
  return structuredClone(v)
}

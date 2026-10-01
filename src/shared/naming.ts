// Output file-name templates. Pure — used by the queue (main) and the settings UI (live example).

export interface NamingVars {
  /** Source base name without extension */
  name: string
  /** Source extension without dot */
  ext: string
  preset: string
  /** Source parent folder name */
  parent: string
  width?: number
  height?: number
  /** 1-based running number within the batch */
  counter: number
  now: Date
}

export const NAME_TOKENS = ['{name}', '{ext}', '{preset}', '{date}', '{time}', '{counter}', '{counter:3}', '{width}', '{height}', '{parent}'] as const

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** Make a string safe as a single path segment on Windows/macOS/Linux. */
export function sanitizeFileName(s: string): string {
  let out = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  if (!out) out = 'output'
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`
  // keep well under MAX_PATH-ish limits; extension is added later
  if (out.length > 180) out = out.slice(0, 180)
  return out
}

/** Render a template like "{name}_{preset}_{counter:3}" into a sanitized file name (no extension). */
export function renderNameTemplate(template: string, vars: NamingVars): string {
  const d = vars.now
  const tpl = template && template.trim() ? template : '{name}'
  const rendered = tpl.replace(/\{(\w+)(?::(\d+))?\}/g, (whole, key: string, width?: string) => {
    switch (key) {
      case 'name': return vars.name
      case 'ext': return vars.ext
      case 'preset': return vars.preset
      case 'parent': return vars.parent
      case 'date': return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      case 'time': return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
      case 'counter': return width ? pad(vars.counter, Number(width)) : String(vars.counter)
      case 'width': return vars.width != null ? String(vars.width) : ''
      case 'height': return vars.height != null ? String(vars.height) : ''
      default: return whole
    }
  })
  return sanitizeFileName(rendered)
}

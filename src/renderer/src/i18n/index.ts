// i18n: dictionaries + a tiny translator. `en` defines the key set; zh-TW / ja are type-checked against it.
// Dictionaries for the views agent's namespaces (presetsView.*, watch.*, settings.*) live in ./extra and are merged here.
import type { AppSettings, Locale } from '../../../shared/types'
import { en } from './en'
import { zhTW } from './zh-TW'
import { ja } from './ja'
import { extraEn, extraJa, extraZhTW } from './extra'
import { fileopsEn, fileopsJa, fileopsZhTW } from './fileops'
import { uxEn, uxJa, uxZhTW } from './ux'
import { updateEn, updateJa, updateZhTW } from './update'
import { formatsEn, formatsJa, formatsZhTW } from './formats'
import { aspectEn, aspectJa, aspectZhTW } from './aspect'
import { jobErrorsEn, jobErrorsJa, jobErrorsZhTW } from './jobErrors'
import { adobeEn, adobeJa, adobeZhTW } from './adobe'

export type MessageKey = keyof typeof en | keyof typeof extraEn | keyof typeof fileopsEn | keyof typeof uxEn | keyof typeof updateEn | keyof typeof formatsEn | keyof typeof aspectEn | keyof typeof jobErrorsEn | keyof typeof adobeEn
export type MessageParams = Record<string, string | number>
export type TFunc = (key: MessageKey, params?: MessageParams) => string

export type Dictionary = Record<MessageKey, string>

const DICTS: Record<Locale, Dictionary> = {
  en: { ...en, ...extraEn, ...fileopsEn, ...uxEn, ...updateEn, ...formatsEn, ...aspectEn, ...jobErrorsEn, ...adobeEn },
  'zh-TW': { ...zhTW, ...extraZhTW, ...fileopsZhTW, ...uxZhTW, ...updateZhTW, ...formatsZhTW, ...aspectZhTW, ...jobErrorsZhTW, ...adobeZhTW },
  ja: { ...ja, ...extraJa, ...fileopsJa, ...uxJa, ...updateJa, ...formatsJa, ...aspectJa, ...jobErrorsJa, ...adobeJa },
}

export const LOCALES: readonly Locale[] = ['zh-TW', 'en', 'ja']

/** Each language's own name (shown in the language picker regardless of the UI language). */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
}

/** BCP-47 tag for <html lang> and Intl APIs. */
export const LOCALE_HTML_LANG: Record<Locale, string> = {
  'zh-TW': 'zh-Hant-TW',
  en: 'en',
  ja: 'ja',
}

/** settings.language ('auto' | Locale) → concrete locale. 'auto' follows the OS locale reported by main (AppInfo.locale). */
export function resolveLocale(language: AppSettings['language'] | undefined, systemLocale?: Locale | null): Locale {
  if (language && language !== 'auto') return language
  return systemLocale ?? 'zh-TW'
}

// {name} placeholders; {n|one|other} picks a plural form by params.n === 1 (used by the English dictionary).
const TOKEN = /\{(\w+)(?:\|([^|{}]*)\|([^{}]*))?\}/g

export function format(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(TOKEN, (whole, name: string, one?: string, other?: string) => {
    if (!(name in params)) return whole
    const v = params[name]
    if (one !== undefined) return Number(v) === 1 ? one : (other ?? '')
    return String(v)
  })
}

const cache = new Map<Locale, TFunc>()

export function makeT(locale: Locale): TFunc {
  let t = cache.get(locale)
  if (!t) {
    const dict = DICTS[locale] ?? DICTS.en
    const fallback = DICTS.en
    t = (key, params) => format(dict[key] ?? fallback[key] ?? key, params)
    cache.set(locale, t)
  }
  return t
}

/** True when `key` exists (for dynamic keys built at runtime, e.g. from engine codes). */
export function hasMessage(key: string): key is MessageKey {
  return key in DICTS.en
}

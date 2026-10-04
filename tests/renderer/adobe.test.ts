// Renderer: Settings → Adobe integration status text and the toast for requests from the Premiere / AE panel.
import { describe, expect, it } from 'vitest'
import { LOCALES, makeT } from '../../src/renderer/src/i18n'
import { adobeEn, adobeJa, adobeZhTW } from '../../src/renderer/src/i18n/adobe'
import { bridgeHostLabel, bridgeToast, panelStatusView } from '../../src/renderer/src/lib/adobe'
import type { AdobePanelStatus, BridgeRequestEvent } from '../../src/shared/types'

const zh = makeT('zh-TW')
const en = makeT('en')
const path = 'C:\\Users\\me\\AppData\\Roaming\\Adobe\\CEP\\extensions\\io.github.alan940408.mediaconverter.panel'

describe('Adobe integration (renderer)', () => {
  it('every language has every key, none empty', () => {
    for (const dict of [adobeZhTW, adobeJa]) expect(Object.keys(dict).sort()).toEqual(Object.keys(adobeEn).sort())
    for (const dict of [adobeEn, adobeZhTW, adobeJa]) for (const v of Object.values(dict)) expect(v.trim()).not.toBe('')
    for (const l of LOCALES) expect(makeT(l)('settings.tabAdobe')).not.toBe('settings.tabAdobe')
    expect(zh('settings.tabAdobe')).toBe('Adobe 整合')
    expect(makeT('ja')('settings.tabAdobe')).toBe('Adobe 連携')
  })

  it('status: install / update / reinstall / not bundled', () => {
    const base: AdobePanelStatus = { bundled: true, installed: false, bundledVersion: '1.1.0', path }
    expect(panelStatusView(null, zh)).toMatchObject({ primary: null, canUninstall: false })
    expect(panelStatusView(base, zh)).toEqual({ text: '尚未安裝。', tone: '', primary: 'install', canUninstall: false })
    expect(panelStatusView({ ...base, installed: true, installedVersion: '1.0.0' }, zh)).toEqual({
      text: '已安裝版本 1.0.0，可以更新為版本 1.1.0。',
      tone: 'accent',
      primary: 'update',
      canUninstall: true,
    })
    expect(panelStatusView({ ...base, installed: true, installedVersion: '1.1.0' }, en)).toEqual({
      text: 'Installed (version 1.1.0).',
      tone: 'ok',
      primary: 'reinstall',
      canUninstall: true,
    })
    expect(panelStatusView({ bundled: false, installed: false, path }, en)).toMatchObject({ tone: 'warn', primary: null, canUninstall: false })
    expect(panelStatusView({ bundled: false, installed: true, installedVersion: '1.0.0', path }, en)).toMatchObject({ primary: null, canUninstall: true })
  })

  it('toast for a request from the panel', () => {
    const e: BridgeRequestEvent = { id: 'r', host: 'aftereffects', status: 'accepted', jobCount: 2, fileCount: 1, errors: [] }
    expect(bridgeToast(e, zh)).toEqual({ kind: 'success', text: '已從 After Effects 收到 2 個轉檔工作', detail: undefined })
    expect(bridgeToast({ ...e, host: 'premiere', jobCount: 1 }, en).text).toBe('Received 1 conversion job from Premiere Pro')
    expect(bridgeToast({ ...e, host: 'PPRO', jobCount: 3, errors: ['a', 'b', 'c', 'd', 'e'] }, en)).toEqual({
      kind: 'info',
      text: 'Received 3 conversion jobs from Premiere Pro',
      detail: 'a\nb\nc\nd\n…',
    })
    expect(bridgeToast({ ...e, status: 'rejected', jobCount: 0, errors: ['檔案不見了'] }, zh)).toEqual({
      kind: 'error',
      text: '無法將 After Effects 送來的檔案加入佇列',
      detail: '檔案不見了',
    })
    expect(bridgeHostLabel('', zh)).toBe('Adobe 面板')
    expect(bridgeHostLabel('AEFT', en)).toBe('After Effects')
  })
})

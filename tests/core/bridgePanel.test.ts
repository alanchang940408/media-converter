// Installing the signed Premiere Pro / After Effects panel into a (temporary) per-user CEP extensions folder.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdobePanelInstaller, compareVersions, PANEL_BUNDLE_ID, readManifestVersion, shouldAutoUpdatePanel } from '../../src/main/bridge/panelInstall'
import { t } from '../../src/main/i18n'
import type { AdobePanelStatus } from '../../src/shared/types'
import { makeTempDir } from './helpers'

let tmp: { dir: string; cleanup: () => void }
let source: string
let extensions: string

const manifest = (version: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<ExtensionManifest Version="9.0" ExtensionBundleId="${PANEL_BUNDLE_ID}" ExtensionBundleVersion="${version}" ExtensionBundleName="Media Converter">\n  <ExtensionList><Extension Id="${PANEL_BUNDLE_ID}.main" Version="${version}"/></ExtensionList>\n</ExtensionManifest>\n`

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildPanel(version: string, extra: Record<string, string> = {}): void {
  rmSync(source, { recursive: true, force: true })
  write(join(source, 'CSXS', 'manifest.xml'), manifest(version))
  write(join(source, 'META-INF', 'signatures.xml'), `<signatures v="${version}"/>`)
  write(join(source, 'mimetype'), 'application/vnd.adobe.air-ucf-package+zip')
  write(join(source, 'client', 'index.html'), '<!doctype html><title>送出</title>')
  write(join(source, 'client', 'img', 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  for (const [rel, content] of Object.entries(extra)) write(join(source, rel), content)
}

beforeEach(() => {
  tmp = makeTempDir('mc-panel-')
  source = join(tmp.dir, 'resources', 'adobe-panel', PANEL_BUNDLE_ID)
  extensions = join(tmp.dir, 'App Data', 'Adobe', 'CEP', 'extensions')
  // another vendor's extension next to ours must never be touched
  write(join(extensions, 'com.other.panel', 'CSXS', 'manifest.xml'), manifest('5.0.0'))
})

afterEach(() => tmp.cleanup())

describe('Adobe panel install', () => {
  it('reports status, installs a byte-identical copy (signature included) and uninstalls only that folder', async () => {
    buildPanel('1.2.0')
    const panel = new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions })
    const target = join(extensions, PANEL_BUNDLE_ID)
    expect(await panel.status()).toEqual({ bundled: true, installed: false, bundledVersion: '1.2.0', path: target })

    const st = await panel.install()
    expect(st).toEqual({ bundled: true, installed: true, bundledVersion: '1.2.0', installedVersion: '1.2.0', path: target })
    for (const rel of ['CSXS/manifest.xml', 'META-INF/signatures.xml', 'mimetype', 'client/index.html', 'client/img/icon.png']) {
      expect(readFileSync(join(target, rel))).toEqual(readFileSync(join(source, rel)))
    }
    expect(readdirSync(extensions).sort()).toEqual(['com.other.panel', PANEL_BUNDLE_ID])

    const after = await panel.uninstall()
    expect(after).toEqual({ bundled: true, installed: false, bundledVersion: '1.2.0', path: target })
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(extensions)).toEqual(['com.other.panel'])
    expect(existsSync(join(extensions, 'com.other.panel', 'CSXS', 'manifest.xml'))).toBe(true)
    // uninstalling again is harmless
    expect((await panel.uninstall()).installed).toBe(false)
  })

  it('update replaces the old copy completely (no stale files) and creates the extensions folder when missing', async () => {
    rmSync(extensions, { recursive: true, force: true })
    buildPanel('1.0.0', { 'client/old.js': 'old' })
    const panel = new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions })
    await panel.install()
    const target = join(extensions, PANEL_BUNDLE_ID)
    expect(existsSync(join(target, 'client', 'old.js'))).toBe(true)

    buildPanel('1.1.0', { 'client/new.js': 'new' })
    const before = await panel.status()
    expect(before).toMatchObject({ installed: true, installedVersion: '1.0.0', bundledVersion: '1.1.0' })
    const st = await panel.install()
    expect(st.installedVersion).toBe('1.1.0')
    expect(existsSync(join(target, 'client', 'old.js'))).toBe(false)
    expect(readFileSync(join(target, 'client', 'new.js'), 'utf8')).toBe('new')
    expect(readdirSync(extensions)).toEqual([PANEL_BUNDLE_ID])
  })

  it('removes leftovers of an interrupted install', async () => {
    buildPanel('1.0.0')
    write(join(extensions, `${PANEL_BUNDLE_ID}.installing-99-1`, 'CSXS', 'manifest.xml'), manifest('0.0.1'))
    write(join(extensions, `${PANEL_BUNDLE_ID}.old-99-1`, 'CSXS', 'manifest.xml'), manifest('0.0.1'))
    const panel = new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions })
    await panel.install()
    expect(readdirSync(extensions).sort()).toEqual(['com.other.panel', PANEL_BUNDLE_ID])
  })

  it('a build without the panel reports bundled: false and refuses to install', async () => {
    const panel = new AdobePanelInstaller({ sourceDir: join(tmp.dir, 'nope'), extensionsDir: extensions })
    expect(await panel.status()).toEqual({ bundled: false, installed: false, path: join(extensions, PANEL_BUNDLE_ID) })
    await expect(panel.install()).rejects.toThrow(t('bridge.panelNotBundled'))
    expect(readdirSync(extensions)).toEqual(['com.other.panel'])
  })

  it('reads ExtensionBundleVersion from the manifest root only', async () => {
    const dir = join(tmp.dir, 'm')
    write(join(dir, 'CSXS', 'manifest.xml'), `<ExtensionManifest ExtensionBundleId='x' ExtensionBundleVersion='2.0.1'><Extension Version="9.9.9"/></ExtensionManifest>`)
    expect(await readManifestVersion(dir)).toBe('2.0.1')
    write(join(dir, 'CSXS', 'manifest.xml'), `<ExtensionManifest ExtensionBundleId="x"><Extension ExtensionBundleVersion="9"/></ExtensionManifest>`)
    expect(await readManifestVersion(dir)).toBeUndefined()
    expect(await readManifestVersion(join(tmp.dir, 'missing'))).toBeUndefined()
  })
})

describe('Adobe panel auto-update', () => {
  const status = (over: Partial<AdobePanelStatus>): AdobePanelStatus => ({ bundled: true, installed: true, path: 'x', ...over })

  it('compares versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions(' 1.2.0 ', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2', '10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '0.1.0')).toBeNull()
    expect(compareVersions(undefined, '0.1.0')).toBeNull()
    expect(compareVersions('0.1.0', '')).toBeNull()
  })

  it('updates only an installed panel that is older than the bundled one', () => {
    expect(shouldAutoUpdatePanel(status({ installedVersion: '0.1.0', bundledVersion: '0.2.0' }))).toBe(true)
    expect(shouldAutoUpdatePanel(status({ installedVersion: '0.9.0', bundledVersion: '0.10.0' }))).toBe(true)
    expect(shouldAutoUpdatePanel(status({ installedVersion: '0.2.0', bundledVersion: '0.2.0' }))).toBe(false)
    expect(shouldAutoUpdatePanel(status({ installedVersion: '0.3.0', bundledVersion: '0.2.0' }))).toBe(false)
    // never installs on its own
    expect(shouldAutoUpdatePanel(status({ installed: false, bundledVersion: '0.2.0' }))).toBe(false)
    expect(shouldAutoUpdatePanel(status({ bundled: false, installedVersion: '0.1.0' }))).toBe(false)
    // a version that cannot be read is left alone
    expect(shouldAutoUpdatePanel(status({ bundledVersion: '0.2.0' }))).toBe(false)
    expect(shouldAutoUpdatePanel(status({ installedVersion: '0.1.0' }))).toBe(false)
  })

  it('autoUpdate replaces an older installed panel and leaves everything else alone', async () => {
    const panel = new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions })
    const target = join(extensions, PANEL_BUNDLE_ID)

    // not installed: nothing happens
    buildPanel('0.2.0')
    expect(await panel.autoUpdate()).toEqual({ updated: false, from: undefined })
    expect(existsSync(target)).toBe(false)

    // installed 0.1.0, bundled 0.2.0: updated (stale files gone)
    buildPanel('0.1.0', { 'client/old.js': 'old' })
    await panel.install()
    buildPanel('0.2.0', { 'client/new.js': 'new' })
    expect(await panel.autoUpdate()).toEqual({ updated: true, from: '0.1.0', to: '0.2.0' })
    expect(await readManifestVersion(target)).toBe('0.2.0')
    expect(existsSync(join(target, 'client', 'old.js'))).toBe(false)
    expect(readFileSync(join(target, 'client', 'new.js'), 'utf8')).toBe('new')

    // same version: untouched
    writeFileSync(join(target, 'client', 'marker.txt'), 'mine')
    expect(await panel.autoUpdate()).toEqual({ updated: false, from: '0.2.0' })
    expect(existsSync(join(target, 'client', 'marker.txt'))).toBe(true)

    // the installed panel is newer than this build's (an older app started): never downgraded
    buildPanel('0.1.5')
    expect(await panel.autoUpdate()).toEqual({ updated: false, from: '0.2.0' })
    expect(await readManifestVersion(target)).toBe('0.2.0')
    expect(readdirSync(extensions).sort()).toEqual(['com.other.panel', PANEL_BUNDLE_ID])
  })

  it('a build without the panel never touches the installed one', async () => {
    buildPanel('0.1.0')
    await new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions }).install()
    const panel = new AdobePanelInstaller({ sourceDir: join(tmp.dir, 'nope'), extensionsDir: extensions })
    expect(await panel.autoUpdate()).toEqual({ updated: false, from: '0.1.0' })
    expect(await readManifestVersion(join(extensions, PANEL_BUNDLE_ID))).toBe('0.1.0')
  })

  it('install, uninstall and autoUpdate run one at a time', async () => {
    buildPanel('0.1.0')
    const panel = new AdobePanelInstaller({ sourceDir: source, extensionsDir: extensions })
    await panel.install()
    buildPanel('0.2.0')
    // started together (startup update + a click in Settings): each sees the previous one's result
    const [up, inst, un] = await Promise.all([panel.autoUpdate(), panel.install(), panel.uninstall()])
    expect(up).toEqual({ updated: true, from: '0.1.0', to: '0.2.0' })
    expect(inst.installedVersion).toBe('0.2.0')
    expect(un.installed).toBe(false)
    expect(readdirSync(extensions)).toEqual(['com.other.panel'])
    // a failure does not block the next call
    const broken = new AdobePanelInstaller({ sourceDir: join(tmp.dir, 'nope'), extensionsDir: extensions })
    await expect(broken.install()).rejects.toThrow(t('bridge.panelNotBundled'))
    expect((await broken.uninstall()).installed).toBe(false)
  })
})

// Install / update / uninstall the signed "Send to Media Converter" CEP panel for Premiere Pro and After Effects.
// Per user, no admin rights: <appData>/Adobe/CEP/extensions/<bundle id> (Windows: %APPDATA%\Adobe\CEP\extensions).
// The panel is signed, so no registry change (PlayerDebugMode) is ever needed. No Electron imports.
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { AdobePanelStatus } from '../../shared/types'
import { t } from '../i18n'

export const PANEL_BUNDLE_ID = 'io.github.alan940408.mediaconverter.panel'

const STAGING_MARK = '.installing-'
const OLD_MARK = '.old-'

/** ExtensionBundleVersion from <dir>/CSXS/manifest.xml, or undefined. */
export async function readManifestVersion(dir: string): Promise<string | undefined> {
  let xml: string
  try {
    xml = await readFile(join(dir, 'CSXS', 'manifest.xml'), 'utf8')
  } catch {
    return undefined
  }
  const root = /<ExtensionManifest\b[^>]*>/i.exec(xml)?.[0] ?? ''
  const m = /\bExtensionBundleVersion\s*=\s*["']([^"']+)["']/i.exec(root)
  return m ? m[1].trim() : undefined
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await sleep(100 * (attempt + 1))
    }
  }
}

export interface PanelInstallerOptions {
  /** The built, signed extension folder (packaged: <resources>/adobe-panel/<id>, dev: adobe/dist/<id>). */
  sourceDir: string
  /** The per-user CEP extensions folder. */
  extensionsDir: string
}

export class AdobePanelInstaller {
  readonly sourceDir: string
  readonly extensionsDir: string
  /** The only folder install / uninstall ever replace or remove. */
  readonly target: string

  constructor(opts: PanelInstallerOptions) {
    this.sourceDir = resolve(opts.sourceDir)
    this.extensionsDir = resolve(opts.extensionsDir)
    this.target = join(this.extensionsDir, PANEL_BUNDLE_ID)
  }

  async status(): Promise<AdobePanelStatus> {
    const bundled = existsSync(join(this.sourceDir, 'CSXS', 'manifest.xml'))
    const installed = existsSync(this.target)
    const [bundledVersion, installedVersion] = await Promise.all([
      bundled ? readManifestVersion(this.sourceDir) : undefined,
      installed ? readManifestVersion(this.target) : undefined,
    ])
    return {
      bundled,
      installed,
      ...(installedVersion ? { installedVersion } : {}),
      ...(bundledVersion ? { bundledVersion } : {}),
      path: this.target,
    }
  }

  /** Copy the bundled panel (replacing an installed one). The old copy stays in place if anything fails. */
  async install(): Promise<AdobePanelStatus> {
    this.assertTarget()
    if (!existsSync(join(this.sourceDir, 'CSXS', 'manifest.xml'))) throw new Error(t('bridge.panelNotBundled'))
    await mkdir(this.extensionsDir, { recursive: true })
    await this.removeLeftovers()
    const stamp = `${process.pid}-${Date.now()}`
    const staging = this.target + STAGING_MARK + stamp
    const old = this.target + OLD_MARK + stamp
    try {
      await cp(this.sourceDir, staging, { recursive: true, force: true, errorOnExist: false })
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    let movedOld = false
    try {
      if (existsSync(this.target)) {
        await renameWithRetry(this.target, old)
        movedOld = true
      }
      await renameWithRetry(staging, this.target)
    } catch (err) {
      if (movedOld && !existsSync(this.target)) await rename(old, this.target).catch(() => undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(t('bridge.panelBusy', { message: err instanceof Error ? err.message : String(err) }))
    }
    if (movedOld) await rm(old, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    return this.status()
  }

  /** Remove the installed panel folder (only that folder). */
  async uninstall(): Promise<AdobePanelStatus> {
    this.assertTarget()
    await this.removeLeftovers()
    if (existsSync(this.target)) {
      try {
        await rm(this.target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
      } catch (err) {
        throw new Error(t('bridge.panelBusy', { message: err instanceof Error ? err.message : String(err) }))
      }
    }
    return this.status()
  }

  /** Never touch anything but <extensionsDir>/<bundle id> (and our own staging / backup siblings of it). */
  private assertTarget(): void {
    if (basename(this.target) !== PANEL_BUNDLE_ID || dirname(this.target) !== this.extensionsDir) {
      throw new Error(`Refusing to modify ${this.target}`)
    }
  }

  /** Staging / backup folders of an interrupted install (CEP would otherwise see a second copy of the panel). */
  private async removeLeftovers(): Promise<void> {
    const names = await readdir(this.extensionsDir).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith(PANEL_BUNDLE_ID + STAGING_MARK) || name.startsWith(PANEL_BUNDLE_ID + OLD_MARK)) {
        await rm(join(this.extensionsDir, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}

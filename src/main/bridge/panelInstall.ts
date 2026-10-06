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

/**
 * Numeric compare of dotted versions ("0.10.0" > "0.9.2", "1.2" = "1.2.0"): < 0, 0 or > 0, or null when either side is
 * not plain digits and dots (e.g. "1.0.0-beta", missing).
 */
export function compareVersions(a: string | undefined, b: string | undefined): number | null {
  const parse = (v: string | undefined): number[] | null => {
    const s = typeof v === 'string' ? v.trim() : ''
    return /^\d+(\.\d+)*$/.test(s) ? s.split('.').map(Number) : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * Update the installed panel at startup? Only when it IS installed (never installs on its own), this build ships it
 * and the bundled version is newer than the installed one (both readable).
 */
export function shouldAutoUpdatePanel(status: AdobePanelStatus): boolean {
  if (!status.installed || !status.bundled) return false
  const cmp = compareVersions(status.bundledVersion, status.installedVersion)
  return cmp !== null && cmp > 0
}

export interface PanelAutoUpdateResult {
  updated: boolean
  /** Installed version before the update (when known). */
  from?: string
  /** Installed version afterwards (when updated). */
  to?: string
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
  /** install / uninstall / autoUpdate run one at a time (Settings and the startup update may overlap). */
  private chain: Promise<unknown> = Promise.resolve()

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

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Copy the bundled panel (replacing an installed one). The old copy stays in place if anything fails. */
  install(): Promise<AdobePanelStatus> {
    return this.serial(() => this.installNow())
  }

  /**
   * Startup: replace an installed panel older than the bundled one (see shouldAutoUpdatePanel). Never installs a panel
   * that is not installed. Throws when the copy fails (the old panel stays in place).
   */
  autoUpdate(): Promise<PanelAutoUpdateResult> {
    return this.serial(async () => {
      const before = await this.status()
      if (!shouldAutoUpdatePanel(before)) return { updated: false, from: before.installedVersion }
      const after = await this.installNow()
      return { updated: true, from: before.installedVersion, to: after.installedVersion }
    })
  }

  private async installNow(): Promise<AdobePanelStatus> {
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
  uninstall(): Promise<AdobePanelStatus> {
    return this.serial(async () => {
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
    })
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

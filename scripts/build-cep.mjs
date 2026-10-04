#!/usr/bin/env node
// npm run build:cep — build + sign the Premiere Pro / After Effects panel (CEP extension).
//
//   adobe/panel/                          source
//   adobe/dist/<bundleId>.zxp             signed package (ZXPSignCmd -sign)
//   adobe/dist/<bundleId>/                the same package extracted (incl. META-INF/signatures.xml) — shipped by
//                                         electron-builder as <resources>/adobe-panel/<bundleId>/ and copied by the app
//                                         to %APPDATA%\Adobe\CEP\extensions\<bundleId> ("install panel")
//
// Signing uses a self-signed certificate created on first run: adobe/.cert/media-converter-panel.p12 with its password in
// adobe/.cert/password.txt (both gitignored). CEP loads signed extensions without PlayerDebugMode, so nothing in the
// registry has to change. ZXPSignCmd comes from Adobe's official GitHub (Adobe-CEP/CEP-Resources) into adobe/.tools/
// (gitignored), pinned by SHA-256. Override with ZXPSIGNCMD=<path>. Set CEP_TSA_URL='' to skip timestamping.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ID = 'io.github.alan940408.mediaconverter.panel'
const SRC = path.join(ROOT, 'adobe', 'panel')
const DIST = path.join(ROOT, 'adobe', 'dist')
const STAGE = path.join(DIST, '.stage', BUNDLE_ID)
const OUT_DIR = path.join(DIST, BUNDLE_ID)
const OUT_ZXP = path.join(DIST, BUNDLE_ID + '.zxp')
const TOOLS = path.join(ROOT, 'adobe', '.tools')
const CERT_DIR = path.join(ROOT, 'adobe', '.cert')
const CERT = path.join(CERT_DIR, 'media-converter-panel.p12')
const CERT_PW = path.join(CERT_DIR, 'password.txt')
const TSA_URL = process.env.CEP_TSA_URL ?? 'http://timestamp.digicert.com'

const ZXP_BASE = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3'
const ZXP_TOOLS = {
  win32: { url: `${ZXP_BASE}/x64/ZXPSignCmd.exe`, file: 'ZXPSignCmd.exe', sha256: 'ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98' },
  darwin: { url: `${ZXP_BASE}/macOS/ZXPSignCmd`, file: 'ZXPSignCmd', sha256: 'bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095' }
}

const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '__MACOSX', '.debug'])

function log(msg) {
  console.log(`[build:cep] ${msg}`)
}

function die(msg) {
  console.error(`[build:cep] ERROR: ${msg}`)
  process.exit(1)
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function run(bin, args, { secret } = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true })
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim()
  const shown = secret ? out.split(secret).join('***') : out
  return { ok: r.status === 0 && !r.error, status: r.status, out: shown, error: r.error }
}

async function ensureZxpSignCmd() {
  if (process.env.ZXPSIGNCMD) {
    if (!fs.existsSync(process.env.ZXPSIGNCMD)) die(`ZXPSIGNCMD=${process.env.ZXPSIGNCMD} does not exist`)
    return process.env.ZXPSIGNCMD
  }
  const tool = ZXP_TOOLS[process.platform]
  if (!tool) die(`ZXPSignCmd is only published for Windows and macOS (this is ${process.platform}); set ZXPSIGNCMD=<path>`)
  const target = path.join(TOOLS, tool.file)
  if (fs.existsSync(target) && sha256(target) === tool.sha256) return target
  fs.mkdirSync(TOOLS, { recursive: true })
  log(`downloading ZXPSignCmd 4.1.3 from Adobe-CEP/CEP-Resources …`)
  const res = await fetch(tool.url)
  if (!res.ok) die(`download failed: HTTP ${res.status} ${tool.url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== tool.sha256) die(`ZXPSignCmd checksum mismatch (expected ${tool.sha256}, got ${got}) — not using it`)
  const part = target + '.part'
  fs.writeFileSync(part, buf)
  if (process.platform !== 'win32') fs.chmodSync(part, 0o755)
  fs.renameSync(part, target)
  log(`ZXPSignCmd → ${path.relative(ROOT, target)}`)
  return target
}

function ensureCert(zxp) {
  if (fs.existsSync(CERT) && fs.existsSync(CERT_PW)) return fs.readFileSync(CERT_PW, 'utf8').trim()
  fs.mkdirSync(CERT_DIR, { recursive: true })
  const pw = randomBytes(18).toString('base64url')
  if (fs.existsSync(CERT)) fs.rmSync(CERT)
  log('creating self-signed certificate (first run) …')
  const r = run(zxp, ['-selfSignedCert', 'TW', 'Taiwan', 'Media Converter', 'Media Converter Panel', pw, CERT, '-validityDays', '3650'], {
    secret: pw
  })
  if (!r.ok || !fs.existsSync(CERT)) die(`ZXPSignCmd -selfSignedCert failed (exit ${r.status}):\n${r.out}`)
  fs.writeFileSync(CERT_PW, pw + '\n', { mode: 0o600 })
  log(`certificate → ${path.relative(ROOT, CERT)} (password in ${path.relative(ROOT, CERT_PW)})`)
  return pw
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    // CEP signature checks break on symlinks (Adobe-CEP KnownIssue2024) — copy real files only
    const st = fs.statSync(s)
    if (st.isDirectory()) copyTree(s, d)
    else if (st.isFile()) fs.copyFileSync(s, d)
  }
}

function manifestVersion() {
  const xml = fs.readFileSync(path.join(SRC, 'CSXS', 'manifest.xml'), 'utf8')
  const id = /ExtensionBundleId="([^"]+)"/.exec(xml)?.[1]
  if (id !== BUNDLE_ID) die(`manifest ExtensionBundleId is ${id}, expected ${BUNDLE_ID}`)
  return /ExtensionBundleVersion="([^"]+)"/.exec(xml)?.[1] ?? '?'
}

function verify(zxp, target) {
  const r = run(zxp, ['-verify', target, '-certInfo', '-skipOnlineRevocationChecks'])
  const ok = r.ok && /Signature verified successfully/i.test(r.out)
  return { ok, out: r.out }
}

function listFiles(dir, base = dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listFiles(p, base))
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
  return out.sort()
}

async function main() {
  if (!fs.existsSync(SRC)) die(`missing ${SRC}`)
  const version = manifestVersion()
  const zxp = await ensureZxpSignCmd()
  const pw = ensureCert(zxp)

  // 1. stage a clean copy of adobe/panel
  fs.rmSync(path.join(DIST, '.stage'), { recursive: true, force: true })
  copyTree(SRC, STAGE)

  // 2. sign → .zxp (timestamped when the TSA answers, so the signature outlives the certificate)
  fs.rmSync(OUT_ZXP, { force: true })
  let signed = false
  if (TSA_URL) {
    const r = run(zxp, ['-sign', STAGE, OUT_ZXP, CERT, pw, '-tsa', TSA_URL], { secret: pw })
    signed = r.ok && fs.existsSync(OUT_ZXP)
    if (!signed) log(`timestamped signing failed (${r.out.split('\n')[0] || 'exit ' + r.status}) — signing without a timestamp`)
  }
  if (!signed) {
    fs.rmSync(OUT_ZXP, { force: true })
    const r = run(zxp, ['-sign', STAGE, OUT_ZXP, CERT, pw], { secret: pw })
    if (!r.ok || !fs.existsSync(OUT_ZXP)) die(`ZXPSignCmd -sign failed (exit ${r.status}):\n${r.out}`)
    log('note: no timestamp — the signature is valid as long as the self-signed certificate (10 years)')
  }

  // 3. extract the signed package → adobe/dist/<bundleId>/ (what the app installs into CEP/extensions)
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const x = run(tar, ['-xf', OUT_ZXP, '-C', OUT_DIR])
  if (!x.ok) die(`could not extract ${OUT_ZXP} (exit ${x.status}):\n${x.out}`)
  if (!fs.existsSync(path.join(OUT_DIR, 'META-INF', 'signatures.xml'))) die('extracted package has no META-INF/signatures.xml')
  fs.rmSync(path.join(DIST, '.stage'), { recursive: true, force: true })

  // 4. verify both the package and the extracted folder
  for (const target of [OUT_ZXP, OUT_DIR]) {
    const v = verify(zxp, target)
    if (!v.ok) die(`signature verification failed for ${path.relative(ROOT, target)}:\n${v.out}`)
    log(`verified: ${path.relative(ROOT, target)}`)
  }
  const certLine = verify(zxp, OUT_ZXP)
    .out.split('\n')
    .filter((l) => /timestamp|valid|expir/i.test(l))
    .slice(0, 4)
    .map((l) => '  ' + l.trim())
  if (certLine.length) console.log(certLine.join('\n'))

  const files = listFiles(OUT_DIR)
  log(`${BUNDLE_ID} ${version}: ${files.length} files, ${(fs.statSync(OUT_ZXP).size / 1024).toFixed(1)} KB zxp`)
  log(`→ ${path.relative(ROOT, OUT_ZXP)}`)
  log(`→ ${path.relative(ROOT, OUT_DIR)}${path.sep}`)
}

main().catch((e) => die(e?.stack || String(e)))

#!/usr/bin/env node
// Download ffmpeg + ffprobe into resources/bin/<platform>-<arch>/ (bundled into the installer by electron-builder).
//
//   node scripts/fetch-ffmpeg.mjs                          current platform/arch
//   node scripts/fetch-ffmpeg.mjs --platform darwin --arch x64,arm64
//   node scripts/fetch-ffmpeg.mjs --from-path              copy the ffmpeg/ffprobe found on PATH (offline dev)
//
// Options:
//   --force       re-download / re-extract even if the target folder is already up to date
//   --strict      exit 1 when a required encoder is missing from the build
//   --url <url>   override the archive URL (zip or tar.*, must contain ffmpeg + ffprobe)
//   --out <dir>   output root instead of resources/bin (the <platform>-<arch> folder is created inside)
//   --no-verify   skip the "ffmpeg -encoders" check
//
// No npm dependencies: Node fetch + the OS archive tools (Windows bsdtar / PowerShell, unzip / tar elsewhere).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BIN_ROOT = join(ROOT, 'resources', 'bin')
const CACHE_DIR = join(DEFAULT_BIN_ROOT, '.cache')
let BIN_ROOT = DEFAULT_BIN_ROOT
const STALL_MS = 60_000
const MAX_ATTEMPTS = 8

// ───────────────────────────── sources (pinned) ─────────────────────────────

// BtbN month-end autobuilds are kept long-term (daily ones are pruned after ~2 weeks).
// FFmpeg n8.1.2-50-g1a748fe2cd = release/8.1 branch, GPL "shared" variant: small ffmpeg.exe/ffprobe.exe sharing
// the av*/sw* DLLs, all external libraries (x264, x265, SVT-AV1, libvpx, lame, opus, nvenc/qsv/amf, …) linked in.
const BTBN_TAG = 'autobuild-2026-08-31-13-27'
const BTBN_VER = 'n8.1.2-50-g1a748fe2cd'
const BTBN = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`
const BTBN_INFO = {
  license: 'GPL-3.0-or-later (FFmpeg built with --enable-gpl --enable-version3)',
  build: `https://github.com/BtbN/FFmpeg-Builds/releases/tag/${BTBN_TAG}`,
  buildScripts: 'https://github.com/BtbN/FFmpeg-Builds',
  sourceCode: 'https://github.com/FFmpeg/FFmpeg/commit/1a748fe2cd',
}

// Martin Riedl's static macOS builds (FFmpeg 9.0.2, GPL). Versioned URLs, sha256 published next to each zip.
const MR = 'https://ffmpeg.martin-riedl.de'
const MR_INFO = {
  license: 'GPL-3.0-or-later',
  build: `${MR}/`,
  buildScripts: 'https://git.martin-riedl.de/ffmpeg/build-script',
  sourceCode: 'https://github.com/FFmpeg/FFmpeg/tree/n9.0.2',
}
const mrPair = (arch, id) => ['ffmpeg', 'ffprobe'].map((bin) => ({
  candidates: [
    { url: `${MR}/download/macos/${arch}/${id}/${bin}.zip`, sha256Url: `${MR}/download/macos/${arch}/${id}/${bin}.zip.sha256` },
    // pinned build pruned → latest release build of the same series
    { url: `${MR}/redirect/latest/macos/${arch}/release/${bin}.zip` },
  ],
}))

// John Van Sickle's static Linux builds (current release; md5 published next to each archive).
const JVS = 'https://johnvansickle.com/ffmpeg/releases'
const JVS_INFO = {
  license: 'GPL-3.0-or-later',
  build: 'https://johnvansickle.com/ffmpeg/',
  buildScripts: 'https://johnvansickle.com/ffmpeg/',
  sourceCode: 'https://johnvansickle.com/ffmpeg/release-source/',
}

/** @type {Record<string, { label: string, archives: { candidates: { url: string, sha256?: string, sha256Url?: string, md5Url?: string }[] }[], info: Record<string, string>, tested: boolean }>} */
const SOURCES = {
  'win32-x64': {
    label: `BtbN FFmpeg-Builds ${BTBN_VER} win64 GPL shared`,
    archives: [{ candidates: [{
      url: `${BTBN}/ffmpeg-${BTBN_VER}-win64-gpl-shared-8.1.zip`,
      sha256: '0a41f31caff48e3035b48f09f5d840bd8d1863008240fc43e457f15e589cf5b3',
    }] }],
    info: BTBN_INFO,
    tested: true,
  },
  'win32-arm64': {
    label: `BtbN FFmpeg-Builds ${BTBN_VER} winarm64 GPL shared`,
    archives: [{ candidates: [{
      url: `${BTBN}/ffmpeg-${BTBN_VER}-winarm64-gpl-shared-8.1.zip`,
      sha256: '9498c9cc25da7eab4f211b3a20bc85c318706d0634a449a9e5287eb4f9a59121',
    }] }],
    info: BTBN_INFO,
    tested: false,
  },
  'darwin-x64': {
    label: 'Martin Riedl static macOS amd64 FFmpeg 9.0.2',
    archives: mrPair('amd64', '1789931006_9.0.2'),
    info: MR_INFO,
    tested: false,
  },
  'darwin-arm64': {
    label: 'Martin Riedl static macOS arm64 FFmpeg 9.0.2',
    archives: mrPair('arm64', '1789931890_9.0.2'),
    info: MR_INFO,
    tested: false,
  },
  'linux-x64': {
    label: 'johnvansickle.com static amd64 (current release)',
    archives: [{ candidates: [{ url: `${JVS}/ffmpeg-release-amd64-static.tar.xz`, md5Url: `${JVS}/ffmpeg-release-amd64-static.tar.xz.md5` }] }],
    info: JVS_INFO,
    tested: false,
  },
  'linux-arm64': {
    label: 'johnvansickle.com static arm64 (current release)',
    archives: [{ candidates: [{ url: `${JVS}/ffmpeg-release-arm64-static.tar.xz`, md5Url: `${JVS}/ffmpeg-release-arm64-static.tar.xz.md5` }] }],
    info: JVS_INFO,
    tested: false,
  },
}

// Encoders the app's presets rely on. Hardware ones only need to be compiled in (the app test-encodes at runtime).
const REQUIRED_SOFTWARE = ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9', 'libmp3lame', 'libopus', 'prores_ks', 'dnxhd', 'aac', 'flac', 'gif', 'pcm_s16le']
const REQUIRED_HW = {
  win32: ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'h264_amf'],
  darwin: ['h264_videotoolbox', 'hevc_videotoolbox'],
  linux: [],
}
const OPTIONAL = ['av1_nvenc', 'hevc_qsv', 'av1_qsv', 'hevc_amf', 'av1_amf', 'prores_videotoolbox', 'h264_vaapi', 'hevc_vaapi', 'libaom-av1', 'libvpx', 'libwebp']

// ───────────────────────────── cli ─────────────────────────────

function parseArgs(argv) {
  const opts = { platform: process.platform, arch: [process.arch], fromPath: false, force: false, strict: false, url: null, out: null, verify: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]
      if (!v) fail(`missing value for ${a}`)
      return v
    }
    if (a.startsWith('--platform')) opts.platform = normalizePlatform(val())
    else if (a.startsWith('--arch')) opts.arch = val().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--from-path') opts.fromPath = true
    else if (a === '--force') opts.force = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--no-verify') opts.verify = false
    else if (a.startsWith('--url')) opts.url = val()
    else if (a.startsWith('--out')) opts.out = resolve(val())
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
      process.exit(0)
    } else fail(`unknown argument: ${a}`)
  }
  return opts
}

function normalizePlatform(p) {
  const s = p.toLowerCase()
  if (['win', 'win32', 'windows'].includes(s)) return 'win32'
  if (['mac', 'macos', 'darwin', 'osx'].includes(s)) return 'darwin'
  if (s === 'linux') return 'linux'
  fail(`unsupported platform: ${p}`)
}

function fail(msg) {
  console.error(`fetch-ffmpeg: ${msg}`)
  process.exit(1)
}

const log = (msg) => console.log(`[fetch-ffmpeg] ${msg}`)
const exeName = (platform, name) => (platform === 'win32' ? `${name}.exe` : name)
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── download ─────────────────────────────

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`)
    this.status = status
  }
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new HttpError(res.status, url)
  return res.text()
}

/** Resumable download with a stall watchdog (the connection here is slow and flaky). */
async function download(url, dest) {
  const part = `${dest}.part`
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let have = existsSync(part) ? statSync(part).size : 0
    const ac = new AbortController()
    let timer
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ac.abort(new Error(`no data for ${STALL_MS / 1000}s`)), STALL_MS)
    }
    let out = null
    try {
      arm()
      const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: have ? { Range: `bytes=${have}-` } : {} })
      if (res.status === 416 && have > 0) {
        // the .part already holds the whole file
        clearTimeout(timer)
        renameSync(part, dest)
        return
      }
      if (!res.ok) throw new HttpError(res.status, url)
      if (have && res.status !== 206) have = 0 // server ignored Range → start over
      const total = res.status === 206
        ? Number((res.headers.get('content-range') ?? '').split('/')[1]) || 0
        : Number(res.headers.get('content-length')) || 0
      out = createWriteStream(part, { flags: have ? 'a' : 'w' })
      let got = have
      const started = Date.now()
      let lastReport = 0
      const tty = process.stdout.isTTY
      if (have) log(`resuming at ${mb(have)}`)
      for await (const chunk of res.body) {
        arm()
        got += chunk.length
        if (!out.write(chunk)) await once(out, 'drain')
        const now = Date.now()
        if (now - lastReport > (tty ? 500 : 10_000)) {
          lastReport = now
          const rate = (got - have) / Math.max(1, (now - started) / 1000)
          const pct = total ? `${((got / total) * 100).toFixed(1)}% ` : ''
          const eta = total && rate > 0 ? ` eta ${Math.round((total - got) / rate)}s` : ''
          const line = `  ${pct}${mb(got)}${total ? ` / ${mb(total)}` : ''} @ ${(rate / 1024).toFixed(0)} KB/s${eta}`
          if (tty) process.stdout.write(`\r${line}   `)
          else console.log(line)
        }
      }
      clearTimeout(timer)
      await new Promise((ok, ko) => out.end((err) => (err ? ko(err) : ok())))
      out = null
      if (tty) process.stdout.write('\n')
      if (total && got < total) throw new Error(`incomplete: ${got} of ${total} bytes`)
      renameSync(part, dest)
      return
    } catch (err) {
      clearTimeout(timer)
      if (out) await new Promise((ok) => out.end(ok)).catch(() => {})
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) throw err
      if (attempt === MAX_ATTEMPTS) throw err
      log(`download interrupted (${err?.message ?? err}); retry ${attempt}/${MAX_ATTEMPTS - 1}`)
      await sleep(Math.min(30_000, 2000 * attempt))
    }
  }
}

async function hashFile(path, algo) {
  const h = createHash(algo)
  for await (const chunk of createReadStream(path)) h.update(chunk)
  return h.digest('hex')
}

async function expectedHash(c) {
  if (c.sha256) return { algo: 'sha256', hex: c.sha256 }
  for (const [algo, url] of [['sha256', c.sha256Url], ['md5', c.md5Url]]) {
    if (!url) continue
    try {
      const hex = (await fetchText(url)).trim().split(/\s+/)[0].toLowerCase()
      if (/^[0-9a-f]{32,64}$/.test(hex)) return { algo, hex }
    } catch (err) {
      log(`could not read checksum ${url}: ${err.message}`)
    }
  }
  return null
}

/** Download one archive (trying each candidate URL) into the cache; returns { path, url, hash }. */
async function obtain(archive) {
  mkdirSync(CACHE_DIR, { recursive: true })
  let lastErr
  for (const c of archive.candidates) {
    const tag = createHash('sha1').update(c.url).digest('hex').slice(0, 8)
    const dest = join(CACHE_DIR, `${tag}-${basename(new URL(c.url).pathname)}`)
    try {
      const want = await expectedHash(c)
      if (existsSync(dest) && want && (await hashFile(dest, want.algo)) !== want.hex) {
        log(`cached ${basename(dest)} has a wrong checksum, re-downloading`)
        rmSync(dest)
      }
      if (existsSync(dest)) log(`using cached ${basename(dest)}`)
      else {
        log(`downloading ${c.url}`)
        await download(c.url, dest)
      }
      if (want) {
        const got = await hashFile(dest, want.algo)
        if (got !== want.hex) {
          rmSync(dest)
          throw new Error(`${want.algo} mismatch for ${c.url}: expected ${want.hex}, got ${got}`)
        }
        log(`${want.algo} ok (${got.slice(0, 16)}…)`)
      } else log(`no published checksum for ${c.url}; size ${mb(statSync(dest).size)}`)
      return { path: dest, url: c.url, hash: want ? `${want.algo}:${want.hex}` : null }
    } catch (err) {
      lastErr = err
      log(`source failed: ${err.message}`)
    }
  }
  throw lastErr ?? new Error('no download candidates')
}

// ───────────────────────────── extract / install ─────────────────────────────

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

function extract(archive, dir) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const isZip = archive.toLowerCase().endsWith('.zip')
  const attempts = []
  if (process.platform === 'win32') {
    // Windows 10+ ships bsdtar (zip + tar); Git Bash's GNU tar on PATH cannot read zips, so call it by full path.
    const bsdtar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(bsdtar)) attempts.push([bsdtar, ['-xf', archive, '-C', dir]])
    if (isZip) {
      attempts.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:MC_ARCHIVE -DestinationPath $env:MC_DEST -Force']])
    }
  } else if (isZip) {
    attempts.push(['unzip', ['-q', '-o', archive, '-d', dir]], ['tar', ['-xf', archive, '-C', dir]])
  } else {
    attempts.push(['tar', ['-xf', archive, '-C', dir]])
  }
  for (const [bin, args] of attempts) {
    const r = run(bin, args, { env: { ...process.env, MC_ARCHIVE: archive, MC_DEST: dir } })
    if (!r.error && r.status === 0) return
    log(`${basename(bin)} failed: ${(r.error?.message ?? r.stderr ?? '').toString().trim().split('\n')[0]}`)
  }
  throw new Error(`could not extract ${archive}`)
}

function findFile(root, predicate, depth = 0) {
  if (depth > 6) return null
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) if (e.isFile() && predicate(e.name)) return join(root, e.name)
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = findFile(join(root, e.name), predicate, depth + 1)
    if (hit) return hit
  }
  return null
}

const SHARED_DLL = /^(av(codec|device|filter|format|util)|sw(resample|scale)|postproc)-\d+\.dll$/i

/** Copy ffmpeg, ffprobe (+ the FFmpeg DLLs of a Windows shared build, + its license) from `roots` into outDir. */
function install(platform, roots, outDir, { license = true } = {}) {
  const find = (pred) => roots.map((r) => findFile(r, pred)).find(Boolean) ?? null
  const ff = find((n) => n.toLowerCase() === exeName(platform, 'ffmpeg'))
  const fp = find((n) => n.toLowerCase() === exeName(platform, 'ffprobe'))
  if (!ff || !fp) throw new Error(`archive does not contain ${exeName(platform, 'ffmpeg')} and ${exeName(platform, 'ffprobe')}`)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const copied = []
  const put = (src, name = basename(src)) => {
    copyFileSync(src, join(outDir, name))
    copied.push(name)
  }
  put(ff, exeName(platform, 'ffmpeg'))
  put(fp, exeName(platform, 'ffprobe'))
  if (platform === 'win32') {
    for (const dir of new Set([dirname(ff), dirname(fp)])) {
      for (const name of readdirSync(dir)) if (SHARED_DLL.test(name) && !copied.includes(name)) put(join(dir, name))
    }
  } else {
    for (const name of [exeName(platform, 'ffmpeg'), exeName(platform, 'ffprobe')]) {
      try {
        chmodSync(join(outDir, name), 0o755)
      } catch { /* not supported on this host */ }
    }
  }
  const lic = license ? find((n) => /^(license(\.txt|\.md)?|copying(\.gplv3|\.txt)?|gplv3\.txt)$/i.test(n)) : null
  if (lic) put(lic, 'LICENSE-ffmpeg.txt')
  return copied
}

function folderSize(dir) {
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? folderSize(p) : statSync(p).size
  }
  return total
}

// ───────────────────────────── verify ─────────────────────────────

function verify(platform, outDir, strict) {
  const ffmpeg = join(outDir, exeName(platform, 'ffmpeg'))
  const ffprobe = join(outDir, exeName(platform, 'ffprobe'))
  const ver = run(ffmpeg, ['-hide_banner', '-version'])
  if (ver.error || ver.status !== 0) {
    log(`cannot run ${ffmpeg} on this machine (${ver.error?.code ?? `exit ${ver.status}`}); encoder check skipped`)
    return { version: null, missing: [] }
  }
  const version = ver.stdout.split('\n')[0].trim()
  const probe = run(ffprobe, ['-hide_banner', '-version'])
  if (probe.error || probe.status !== 0) throw new Error(`ffprobe does not run: ${probe.error?.message ?? probe.stderr}`)
  const enc = run(ffmpeg, ['-hide_banner', '-encoders'])
  const names = new Set()
  for (const line of enc.stdout.split('\n')) {
    const m = /^\s[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line)
    if (m) names.add(m[1])
  }
  const required = [...REQUIRED_SOFTWARE, ...(REQUIRED_HW[platform] ?? [])]
  const missing = required.filter((n) => !names.has(n))
  log(version)
  log(`required encoders: ${required.map((n) => (names.has(n) ? n : `${n} (MISSING)`)).join(', ')}`)
  const opt = OPTIONAL.filter((n) => names.has(n))
  if (opt.length) log(`also available: ${opt.join(', ')}`)
  if (missing.length) {
    log(`WARNING: missing required encoders: ${missing.join(', ')}`)
    if (strict) throw new Error('required encoders missing (--strict)')
  } else log('all required encoders present')
  return { version, missing }
}

// ───────────────────────────── main ─────────────────────────────

function readBuildInfo(outDir) {
  try {
    return JSON.parse(readFileSync(join(outDir, 'BUILDINFO.json'), 'utf8'))
  } catch {
    return null
  }
}

async function fetchTarget(platform, arch, opts) {
  const target = `${platform}-${arch}`
  const outDir = join(BIN_ROOT, target)
  const src = opts.url
    ? { label: `custom URL ${opts.url}`, archives: [{ candidates: [{ url: opts.url }] }], info: {}, tested: false }
    : SOURCES[target]
  if (!src) throw new Error(`no ffmpeg source configured for ${target} (use --url or --from-path)`)
  log(`target ${target}: ${src.label}${src.tested ? '' : ' (best-effort source, not tested on the dev machine)'}`)

  const sourceKey = src.archives.map((a) => a.candidates[0].url).join(' ')
  const prev = readBuildInfo(outDir)
  const ready = existsSync(join(outDir, exeName(platform, 'ffmpeg'))) && existsSync(join(outDir, exeName(platform, 'ffprobe')))
  if (!opts.force && ready && prev?.sourceKey === sourceKey) {
    log(`${target} already up to date (use --force to refetch)`)
  } else {
    const got = []
    for (const a of src.archives) got.push(await obtain(a))
    const work = join(CACHE_DIR, `extract-${target}`)
    const roots = got.map((g, i) => {
      const dir = join(work, String(i))
      log(`extracting ${basename(g.path)}`)
      extract(g.path, dir)
      return dir
    })
    const files = install(platform, roots, outDir)
    rmSync(work, { recursive: true, force: true })
    writeFileSync(join(outDir, 'BUILDINFO.json'), `${JSON.stringify({
      target,
      source: src.label,
      sourceKey,
      downloads: got.map((g) => ({ url: g.url, checksum: g.hash })),
      ...src.info,
      files,
      fetchedAt: new Date().toISOString(),
    }, null, 2)}\n`)
  }
  if (opts.verify) {
    const { version } = verify(platform, outDir, opts.strict)
    if (version) {
      const info = readBuildInfo(outDir) ?? {}
      if (info.ffmpegVersion !== version) writeFileSync(join(outDir, 'BUILDINFO.json'), `${JSON.stringify({ ...info, ffmpegVersion: version }, null, 2)}\n`)
    }
  }
  log(`${outDir}: ${readdirSync(outDir).length} files, ${mb(folderSize(outDir))}`)
}

function locateOnPath(name) {
  const skip = [BIN_ROOT, DEFAULT_BIN_ROOT].map((d) => resolve(d).toLowerCase())
  for (const raw of (process.env.PATH ?? '').split(delimiter)) {
    const dir = raw.replace(/^"|"$/g, '').trim()
    if (!dir || skip.some((d) => resolve(dir).toLowerCase().startsWith(d))) continue
    const p = join(dir, exeName(process.platform, name))
    try {
      if (statSync(p).isFile()) return p
    } catch { /* not here */ }
  }
  return null
}

function fromPath(opts) {
  const platform = process.platform
  const target = `${platform}-${process.arch}`
  const outDir = join(BIN_ROOT, target)
  const ff = locateOnPath('ffmpeg')
  const fp = locateOnPath('ffprobe')
  if (!ff || !fp) throw new Error('ffmpeg/ffprobe not found on PATH')
  log(`copying from PATH: ${ff}`)
  const files = install(platform, [...new Set([dirname(ff), dirname(fp)])], outDir, { license: false })
  writeFileSync(join(outDir, 'BUILDINFO.json'), `${JSON.stringify({
    target, source: `PATH (${dirname(ff)})`, sourceKey: `path:${ff}`, files, fetchedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  if (opts.verify) {
    const { version } = verify(platform, outDir, opts.strict)
    if (version) writeFileSync(join(outDir, 'BUILDINFO.json'), `${JSON.stringify({ ...readBuildInfo(outDir), ffmpegVersion: version }, null, 2)}\n`)
  }
  const size = folderSize(outDir)
  log(`${outDir}: ${readdirSync(outDir).length} files, ${mb(size)}`)
  if (size > 250 * 1048576) log('note: this build is large; fine for local dev, but run without --from-path for release builds')
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.out) BIN_ROOT = opts.out
  if (opts.fromPath) return fromPath(opts)
  for (const arch of opts.arch) await fetchTarget(opts.platform, arch, opts)
}

main().catch((err) => fail(err?.stack ?? String(err)))

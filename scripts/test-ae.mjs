#!/usr/bin/env node
// npm run test:ae — automated After Effects test of the panel's render + bridge path, without the panel UI.
//
//   1. temp userData (MC_USER_DATA_DIR-style) with a synthetic bridge/info.json — the user's real bridge is untouched
//   2. AfterFX.exe -r <temp>/run-ae-test.jsx → adobe/tests/ae-render-test.jsx (hard timeout, the process tree is killed if
//      AE hangs): new project, 1920×1080 3 s comp (solid + text), rendered by MCHost.aeRenderComps
//      (adobe/panel/jsx/host.jsx, the panel's own function) into bridge/intermediates/<id>/, project closed without
//      saving, AE quits. AfterFX.exe -r silently ignores a script path containing a space (it starts, runs nothing and
//      exits 0), so the paths go into a small launcher written to a space-free ASCII temp folder.
//      When Premiere Pro is installed, the same run also checks MCHost.pproFindPreset against its install folder.
//   3. ffprobe the intermediate (1920×1080, ~3 s)
//   4. write inbox/<id>.json with the panel's own Node bridge module (adobe/panel/js/bridge-node.cjs: .tmp + rename),
//      exactly as the panel does after a render, and validate it against the BridgeRequest contract
//   5. --app only: start the built Media Converter (npm run build first; electron . with the same MC_USER_DATA_DIR), as
//      the panel does when the app is not running, and check the whole round trip: the app writes info.json, answers
//      results/<id>.json "accepted", converts the intermediate with the requested preset and deletes it (deleteAfter)
//   --user-data <dir> instead: attach to a Media Converter that is ALREADY running with MC_USER_DATA_DIR=<dir> (dev or
//      built). Steps 1-4 then use <dir>/bridge as is (the app's own info.json and presets; nothing synthetic is written)
//      and the round trip of step 5 is checked against the running app.
//
// Options: --keep (keep the temp folder), --app (step 5), --user-data <dir> (attach, see above), AE_EXE=<AfterFX.exe>,
// AE_TEST_TIMEOUT_MS (default 180000), FFPROBE=<path>, AE_TEST_TMP=<folder> (base for the temp folder; ASCII without
// spaces), PPRO_DIR=<Premiere Pro install folder>, AE_TEST_PRESET=<preset id> (attach mode; default h264-720p when the
// app offers it, else its last video preset).
// Refuses to run while After Effects is already open (AfterFX.exe -r would hand the script to that instance and the
// test creates/closes projects).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = require(path.join(ROOT, 'adobe', 'panel', 'js', 'bridge-node.cjs'))
const HOST_JSX = path.join(ROOT, 'adobe', 'panel', 'jsx', 'host.jsx')
const TEST_JSX = path.join(ROOT, 'adobe', 'tests', 'ae-render-test.jsx')
const TIMEOUT_MS = Number(process.env.AE_TEST_TIMEOUT_MS || 180000)
const KEEP = process.argv.includes('--keep')
const WITH_APP = process.argv.includes('--app')
/** --user-data <dir> | --user-data=<dir>: MC_USER_DATA_DIR of a Media Converter that is already running. */
function argValue(name) {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] || ''
    if (args[i].startsWith(name + '=')) return args[i].slice(name.length + 1)
  }
  return null
}
const ATTACH_USER_DATA = argValue('--user-data')
const APP_TIMEOUT_MS = Number(process.env.APP_TEST_TIMEOUT_MS || 180000)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return !!ok
}
function info(msg) {
  console.log(`      ${msg}`)
}

function findAfterEffects() {
  if (process.env.AE_EXE) return process.env.AE_EXE
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')
  let dirs = []
  try {
    dirs = fs.readdirSync(base).filter((d) => /^Adobe After Effects/i.test(d))
  } catch {
    return null
  }
  dirs.sort().reverse() // "Adobe After Effects 2025" before "… 2023"
  for (const d of dirs) {
    const exe = path.join(base, d, 'Support Files', 'AfterFX.exe')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

function runningImages(name) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return (r.stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.toLowerCase().startsWith(`"${name.toLowerCase()}"`))
    .map((l) => Number(l.split('","')[1]))
}

function findPremiereDir() {
  if (process.env.PPRO_DIR) return fs.existsSync(process.env.PPRO_DIR) ? process.env.PPRO_DIR : null
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')
  let dirs = []
  try {
    dirs = fs.readdirSync(base).filter((d) => /^Adobe Premiere Pro/i.test(d))
  } catch {
    return null
  }
  dirs.sort().reverse()
  for (const d of dirs) if (fs.existsSync(path.join(base, d, 'MediaIO', 'systempresets'))) return path.join(base, d)
  return null
}

// AfterFX.exe -r cannot take a path with spaces; non-ASCII is avoided as well.
const launchSafe = (p) => /^[\x21-\x7e]+$/.test(p)

/** 8.3 short form of an existing folder (Scripting.FileSystemObject), or null when short names are disabled. */
function shortPath(dir) {
  const ps =
    "$ProgressPreference = 'SilentlyContinue'; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:MC_P).ShortPath"
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MC_P: dir },
    timeout: 30000
  })
  const out = (r.stdout || '').trim()
  return out && launchSafe(out) && fs.existsSync(out) ? out : null
}

/** ExtendScript (ES3) string literal: forward slashes, everything outside printable ASCII as \uXXXX. */
function esString(s) {
  let out = '"'
  for (const ch of String(s).replace(/\\/g, '/')) {
    for (let i = 0; i < ch.length; i++) {
      const c = ch.charCodeAt(i)
      if (ch[i] === '"' || ch[i] === '\\') out += '\\' + ch[i]
      else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).padStart(4, '0')
      else out += ch[i]
    }
  }
  return out + '"'
}

/** Writes <dir>/run-ae-test.jsx, which sets MC_AE_TEST and evaluates adobe/tests/ae-render-test.jsx. */
function writeLauncher(dir, cfg) {
  const fields = Object.entries(cfg)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${esString(v)}`)
    .join(', ')
  const src = ['// generated by scripts/test-ae.mjs', `var MC_AE_TEST = { ${fields} };`, `$.evalFile(new File(${esString(TEST_JSX)}));`, ''].join('\n')
  const file = path.join(dir, 'run-ae-test.jsx')
  fs.writeFileSync(file, src, 'utf8')
  return file
}

function findFfprobe() {
  if (process.env.FFPROBE) return process.env.FFPROBE
  const bundled = path.join(ROOT, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return fs.existsSync(bundled) ? bundled : 'ffprobe'
}

// Visible window titles of the given processes + a screenshot — so a hang (first-run dialog, licensing, crash
// reporter …) can be reported exactly. PowerShell, ASCII only, passed as -EncodedCommand.
function diagnose(pids, shotPath) {
  const ps = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class MCWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public static List<string> Titles() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      list.Add(pid + "\\t" + c.ToString() + "\\t" + t.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
$pids = @(${pids.join(',') || '0'})
$names = @{}
Get-Process | ForEach-Object { $names[[uint32]$_.Id] = $_.ProcessName }
foreach ($line in [MCWin]::Titles()) {
  $p = $line.Split("\`t")
  $n = $names[[uint32]$p[0]]
  if ($pids -contains [int]$p[0] -or $n -match 'AfterFX|Adobe|CEPHtml|Crash|CoreSync|Creative') { Write-Output ("WINDOW " + $n + " [" + $p[1] + "] " + $p[2]) }
}
try {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($env:MC_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("SCREENSHOT " + $env:MC_SHOT)
} catch { Write-Output ("SCREENSHOT failed: " + $_) }
`
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, MC_SHOT: shotPath },
    timeout: 60000
  })
  return `${r.stdout || ''}`.trim()
}

function killTree(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
}

function runAfterEffects(aeExe, launcher, env, tmp) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(aeExe, ['-r', launcher], { env, stdio: 'ignore', windowsHide: false })
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ...r, seconds: Math.round((Date.now() - started) / 1000) })
    }
    child.on('error', (e) => finish({ exited: false, error: e.message }))
    child.on('exit', (code) => finish({ exited: true, code }))
    const timer = setTimeout(() => {
      const pids = [child.pid, ...runningImages('AfterFX.exe')]
      const diag = diagnose(pids, path.join(tmp, 'ae-timeout.png'))
      killTree(child.pid)
      for (const pid of runningImages('AfterFX.exe')) killTree(pid) // none were running before the test
      finish({ exited: false, timedOut: true, diag })
    }, TIMEOUT_MS)
  })
}

function ffprobe(file) {
  const r = spawnSync(
    findFfprobe(),
    ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true }
  )
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || 'ffprobe failed').trim() }
  return JSON.parse(r.stdout)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) return null
    await sleep(intervalMs)
  }
}

/** Step 5: the built app (out/) picks up the pending inbox request, converts the intermediate and deletes it. */
async function runAppRoundTrip({ userData, bridgeDir, id, presetId, renderedFile, outDir }) {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    check('built app present (out/main/index.js)', false, 'run npm run build first')
    return
  }
  let electronExe
  try {
    electronExe = createRequire(path.join(ROOT, 'package.json'))('electron')
  } catch (e) {
    check('electron binary found', false, e.message)
    return
  }
  const env = { ...process.env, MC_USER_DATA_DIR: userData, MC_NO_QUIT_CONFIRM: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  console.log('Starting Media Converter (built app, temp userData) …')
  const child = spawn(electronExe, [ROOT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false })
  let exited = null
  child.on('exit', (code) => (exited = code))
  child.on('error', (e) => (exited = e.message))
  try {
    await verifyRoundTrip({ bridgeDir, id, presetId, renderedFile, outDir, appExited: () => exited })
  } finally {
    if (exited === null) killTree(child.pid)
    await sleep(1000)
  }
}

/**
 * The app (launched by step 5, or already running in --user-data mode) answers results/<id>.json "accepted", converts
 * the intermediate into outDir and deletes it (deleteAfter). appExited() turns non-null once a launched app is gone.
 */
async function verifyRoundTrip({ bridgeDir, id, presetId, renderedFile, outDir, appExited = () => null }) {
  const paths = bridge.bridgePaths(bridgeDir)
  const started = Date.now()
  const result = await waitFor(() => bridge.readResult(bridgeDir, id) || (appExited() !== null ? { exitedEarly: true } : null), 60000)
  if (!result || result.exitedEarly) {
    check('app answered results/<id>.json', false, result ? `app exited (${appExited()})` : 'no answer within 60 s')
    return
  }
  const secs = Math.round((Date.now() - started) / 1000)
  check('app answered results/<id>.json', true, `${result.status} after ${secs} s`)
  check('request accepted with 1 job', result.status === 'accepted' && result.jobIds.length === 1, (result.errors || []).join('; '))
  check('inbox file consumed', !fs.existsSync(path.join(paths.inbox, `${id}.json`)))
  const appInfo = bridge.readInfo(bridgeDir)
  check(
    'app wrote bridge/info.json',
    appInfo && appInfo.appVersion !== 'test' && appInfo.presets.some((p) => p.id === presetId && p.kind === 'video'),
    appInfo ? `v${appInfo.appVersion}, ${appInfo.presets.length} video presets, locale ${appInfo.locale}` : 'unreadable'
  )
  if (result.status !== 'accepted') return

  // deleteAfter: the intermediate disappears only after its job succeeded
  const outputs = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !/\.(tmp|part)$/i.test(f) && !f.startsWith('.')) : [])
  const gone = await waitFor(() => !fs.existsSync(renderedFile) && outputs().length > 0, APP_TIMEOUT_MS, 1000)
  const listing = outputs().join(', ') || 'nothing'
  check('converted file written to outputDir', outputs().length === 1, listing)
  check('intermediate deleted after the job succeeded (deleteAfter)', !!gone && !fs.existsSync(renderedFile))
  if (outputs().length === 1) {
    const outFile = path.join(outDir, outputs()[0])
    const probe = ffprobe(outFile)
    const v = (probe.streams || []).find((st) => st.codec_type === 'video')
    check(
      'converted file is a valid video',
      !probe.error && v && Math.abs(Number(probe.format?.duration) - 3) < 0.2,
      probe.error || `${probe.format?.format_name}, ${v?.codec_name} ${v?.width}×${v?.height}, ${Number(probe.format?.duration).toFixed(2)} s`
    )
    const expected = { 'h264-720p': [1280, 720], 'h264-1080p': [1920, 1080] }[presetId]
    if (expected && v) check(`converted size matches ${presetId}`, v.width === expected[0] && v.height === expected[1], `${v.width}×${v.height}`)
    info(`output: ${outFile}`)
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('test:ae: Windows only for now (AfterFX.exe -r). Skipped.')
    process.exit(2)
  }
  const aeExe = findAfterEffects()
  if (!aeExe || !fs.existsSync(aeExe)) {
    console.log('test:ae: After Effects not found (set AE_EXE=<…\\Support Files\\AfterFX.exe>). Skipped.')
    process.exit(2)
  }
  if (runningImages('AfterFX.exe').length) {
    console.log('test:ae: After Effects is already running — close it first (the test starts its own instance and quits it).')
    process.exit(2)
  }
  if (ATTACH_USER_DATA !== null && (!ATTACH_USER_DATA.trim() || WITH_APP)) {
    console.log('test:ae: --user-data needs a folder (the MC_USER_DATA_DIR of the running app) and cannot be combined with --app.')
    process.exit(2)
  }
  console.log(`After Effects: ${aeExe}`)

  // 1. temp bridge
  const tmp = fs.mkdtempSync(path.join(process.env.AE_TEST_TMP || os.tmpdir(), 'mc-ae-test-'))
  const launchDir = launchSafe(tmp) ? tmp : shortPath(tmp)
  if (!launchDir) {
    console.log(`test:ae: the temp folder ${tmp} contains spaces or non-ASCII characters and has no 8.3 short name;`)
    console.log('AfterFX.exe -r cannot run a script from there. Set AE_TEST_TMP to a folder such as C:\\mc-ae-test.')
    fs.rmSync(tmp, { recursive: true, force: true })
    process.exit(2)
  }
  const userData = ATTACH_USER_DATA ? path.resolve(ATTACH_USER_DATA) : path.join(tmp, 'userData')
  const env = { ...process.env, MC_USER_DATA_DIR: userData }
  const bridgeDir = bridge.defaultBridgeDir(env)
  check('bridge dir follows MC_USER_DATA_DIR', bridgeDir === path.join(userData, 'bridge'), bridgeDir)
  const paths = bridge.bridgePaths(bridgeDir)
  let bridgeInfo
  let presetId
  if (ATTACH_USER_DATA) {
    // the running app's own info.json (written on startup)
    bridgeInfo = await waitFor(() => bridge.readInfo(bridgeDir), 30000)
    const ok = check('running Media Converter wrote bridge/info.json', bridgeInfo && bridgeInfo.presets.length > 0, bridgeInfo ? `v${bridgeInfo.appVersion}, ${bridgeInfo.presets.length} video presets` : `nothing in ${paths.info}`)
    if (!ok) {
      console.log(`Start Media Converter with MC_USER_DATA_DIR=${userData} first (npm run dev, or electron . after npm run build).`)
      fs.rmSync(tmp, { recursive: true, force: true })
      process.exit(1)
    }
    const offered = (pid) => bridgeInfo.presets.some((p) => p.id === pid && p.kind === 'video')
    presetId = process.env.AE_TEST_PRESET || (offered('h264-720p') ? 'h264-720p' : bridgeInfo.lastVideoPresetId)
    check(`preset ${presetId} offered by the app`, offered(presetId))
  } else {
    bridge.mkdirp(bridgeDir)
    const fakeInfo = {
      bridgeVersion: bridge.BRIDGE_VERSION,
      appVersion: 'test',
      exePath: process.execPath,
      locale: 'zh-TW',
      updatedAt: Date.now(),
      presets: [{ id: 'h264-1080p', kind: 'video', name: 'H.264 1080p', category: 'web', builtIn: true, summary: 'MP4 · H.264 · 1920×1080' }],
      lastVideoPresetId: 'h264-1080p',
      defaultOutputDir: null
    }
    fs.writeFileSync(paths.info, JSON.stringify(fakeInfo, null, 2))
    bridgeInfo = bridge.readInfo(bridgeDir)
    check('panel reads bridge/info.json', bridgeInfo && bridgeInfo.presets.length === 1)
    presetId = bridgeInfo.lastVideoPresetId
  }

  const id = bridge.newId('ae')
  const interDir = bridge.makeIntermediateDir(bridgeDir, id)
  const reportPath = path.join(tmp, 'ae-report.json')
  const pproDir = findPremiereDir()
  const launcher = writeLauncher(launchDir, { hostJsx: HOST_JSX, outDir: interDir, report: reportPath, pproDir })

  // 2. After Effects
  console.log(`Starting After Effects (timeout ${Math.round(TIMEOUT_MS / 1000)} s) …`)
  const ae = await runAfterEffects(aeExe, launcher, env, tmp)
  if (ae.timedOut) {
    check('After Effects ran the script and quit', false, `still running after ${ae.seconds} s — killed`)
    for (const l of (ae.diag || '').split(/\r?\n/)) if (l.trim()) info(l.trim())
  } else if (!ae.exited) {
    check('After Effects started', false, ae.error)
  } else {
    check('After Effects ran the script and quit', true, `exit ${ae.code} after ${ae.seconds} s`)
  }
  let leftover = runningImages('AfterFX.exe')
  for (let i = 0; i < 20 && leftover.length; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    leftover = runningImages('AfterFX.exe')
  }
  if (leftover.length) {
    check('no After Effects process left behind', false, `pids ${leftover.join(', ')} — killed`)
    for (const pid of leftover) killTree(pid)
  }

  // AE-side report (only written when AE allows scripts to write files)
  let report = null
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    } catch (e) {
      check('AE report readable', false, e.message)
    }
  }
  if (report) {
    check('MCHost.aeRenderComps reported ok', report.ok, report.error || (report.render && report.render.errors.join('; ')) || '')
    if (report.render) info(`output module template: ${report.render.template || '(AE default)'}`)
    if (report.omTemplates && report.omTemplates.length) info(`AE output module templates: ${report.omTemplates.join(' | ')}`)
    info(`AE ${report.aeVersion}; steps: ${report.steps.join(' → ')}; "Allow Scripts to Write Files" pref: ${report.canWriteFiles ? 'on' : 'off'}`)
    if (pproDir) {
      const epr = report.pproPreset
      check('MCHost.pproFindPreset finds a Premiere Pro .epr', !!epr && fs.existsSync(epr), epr || `nothing under ${pproDir}`)
    }
  } else if (ae.exited && fs.existsSync(interDir) && !fs.readdirSync(interDir).length) {
    check('After Effects ran the test script', false, `no report and nothing rendered: AE ignored -r ${launcher}?`)
  } else {
    info('no AE-side report (the script could not write it) — judging by the rendered file only')
  }

  // 3. the intermediate
  const rendered = fs.existsSync(interDir) ? fs.readdirSync(interDir).filter((f) => !f.startsWith('.')) : []
  const ok3 = check('intermediate rendered into bridge/intermediates/<id>/', rendered.length === 1, rendered.join(', ') || 'nothing')
  let renderedFile = null
  if (ok3) {
    renderedFile = path.join(interDir, rendered[0])
    const size = fs.statSync(renderedFile).size
    const probe = ffprobe(renderedFile)
    if (probe.error) {
      check('ffprobe reads the intermediate', false, probe.error)
    } else {
      const v = (probe.streams || []).find((s) => s.codec_type === 'video')
      const dur = Number(probe.format?.duration)
      check('ffprobe reads the intermediate', !!v, `${probe.format?.format_name}, ${v?.codec_name}, ${(size / 1048576).toFixed(1)} MB`)
      check('intermediate is 1920×1080', v && v.width === 1920 && v.height === 1080, v ? `${v.width}×${v.height}` : '')
      check('intermediate is ~3 s', Math.abs(dur - 3) < 0.15, `${dur} s`)
    }
  }

  // 4. inbox request, written by the panel's own bridge module (as the panel does after the host render returns)
  if (renderedFile) {
    const outDir = path.join(tmp, 'out')
    const req = bridge.buildRequest({
      id,
      host: 'aftereffects',
      files: [renderedFile],
      presetIds: [presetId],
      outputDir: outDir,
      deleteAfter: true,
      start: true
    })
    const written = bridge.writeRequest(bridgeDir, req)
    check('inbox/<id>.json written', written === path.join(paths.inbox, `${id}.json`) && fs.existsSync(written), path.relative(tmp, written))
    check('no .tmp left in inbox', !fs.readdirSync(paths.inbox).some((f) => f.endsWith('.tmp')))
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(written, 'utf8'))
    } catch (e) {
      check('inbox file is JSON', false, e.message)
    }
    if (parsed) {
      const errs = bridge.validateRequest(parsed)
      check('inbox request matches the BridgeRequest contract', errs.length === 0, errs.join('; '))
      const insideIntermediates = parsed.files.every((f) => !path.relative(paths.intermediates, f).startsWith('..') && fs.existsSync(f))
      check('request files exist inside bridge/intermediates/', insideIntermediates)
      check('deleteAfter and start are true', parsed.deleteAfter === true && parsed.start === true)
    }

    // 5. the app round trip: the already running app (--user-data), or the built app started now (--app)
    if (ATTACH_USER_DATA) {
      await verifyRoundTrip({ bridgeDir, id, presetId, renderedFile, outDir })
      // as the panel does: drop the answer once read; the app deletes the file only (the panel prunes old empty folders
      // later) — tidy up the running app's bridge now
      bridge.removeResult(bridgeDir, id)
      if (fs.existsSync(interDir) && !fs.readdirSync(interDir).length) bridge.removeDirIfInside(interDir, paths.intermediates)
    } else if (WITH_APP) await runAppRoundTrip({ userData, bridgeDir, id, presetId, renderedFile, outDir })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length ? 'FAILED' : 'PASSED'}: ${results.length - failed.length}/${results.length} checks`)
  if (failed.length || KEEP) console.log(`temp folder kept: ${tmp}`)
  else fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

#!/usr/bin/env node
// npm run test:ae — automated After Effects test of the panel's background render + bridge path, without the panel UI.
//
//   1. temp userData (MC_USER_DATA_DIR-style, its path has a space + CJK) with a synthetic bridge/info.json — the user's
//      real bridge is untouched
//   2. AfterFX.exe -r <temp>/run-ae-test.jsx → adobe/tests/ae-render-test.jsx (hard timeout, the process tree is killed if
//      AE hangs): a throwaway project with two 1920×1080 3 s comps ("MC Bridge Test", "測試 合成"); MCHost.planBackground
//      (adobe/panel/jsx/host.jsx, the panel's own function) on the unsaved project → unsavedProject; the project saved
//      into <temp>/專案 資料夾/; a duplicate comp name → duplicateComp; both comps selected → the plan. After Effects
//      STAYS OPEN with the project, as it does for a user. AfterFX.exe -r silently ignores a script path containing a
//      space (it starts, runs nothing and exits 0), so the paths go into a small launcher written to a space-free ASCII
//      temp folder. When Premiere Pro is installed, the same run also checks MCHost.pproFindPreset against its folder.
//   3. every plan item rendered by aerender through adobe/panel/js/aerender.cjs (the panel's own module) into
//      bridge/intermediates/<id>/ while the After Effects GUI has the project open: progress never decreasing, reaching
//      100 %, frames = planned; ffprobe 1920×1080, ~3 s. One more render is cancelled (aerender's process tree gone, the
//      partial file deleted).
//   4. After Effects quit through a second AfterFX.exe -r script (close the project without saving, quit)
//   5. inbox/<id>.json written with the panel's own Node bridge module (adobe/panel/js/bridge-node.cjs: .tmp + rename)
//      with two outputs of the same preset — the default name and a custom "{name} 自訂" — and validated against the
//      BridgeRequest contract
//   6. --app only: start the built Media Converter (npm run build first; electron . with the same MC_USER_DATA_DIR), as
//      the panel does when the app is not running, and check the whole round trip: the app writes info.json, answers
//      results/<id>.json "accepted" (files × outputs jobs), converts the intermediates with the per-output names and
//      deletes them (deleteAfter)
//   --user-data <dir> instead: attach to a Media Converter that is ALREADY running with MC_USER_DATA_DIR=<dir> (dev or
//      built). Steps 1-5 then use <dir>/bridge as is (the app's own info.json and presets; nothing synthetic is written)
//      and the round trip of step 6 is checked against the running app.
//
// Options: --keep (keep the temp folder), --app (step 6), --user-data <dir> (attach, see above), AE_EXE=<AfterFX.exe>,
// AE_TEST_TIMEOUT_MS (After Effects start-up + script, default 180000), AE_RENDER_TIMEOUT_MS (each aerender run, default
// 180000), AE_QUIT_TIMEOUT_MS (default 60000), FFPROBE=<path>, AE_TEST_TMP=<folder> (base for the temp folder; ASCII
// without spaces), PPRO_DIR=<Premiere Pro install folder>, AE_TEST_PRESET=<preset id> (attach mode; default h264-720p
// when the app offers it, else its last video preset).
// Refuses to run while After Effects is already open (AfterFX.exe -r would hand the script to that instance and the
// test creates/closes projects). Only processes this test started are ever killed.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = require(path.join(ROOT, 'adobe', 'panel', 'js', 'bridge-node.cjs'))
const aerender = require(path.join(ROOT, 'adobe', 'panel', 'js', 'aerender.cjs'))
const HOST_JSX = path.join(ROOT, 'adobe', 'panel', 'jsx', 'host.jsx')
const TEST_JSX = path.join(ROOT, 'adobe', 'tests', 'ae-render-test.jsx')
const TIMEOUT_MS = Number(process.env.AE_TEST_TIMEOUT_MS || 180000)
const RENDER_TIMEOUT_MS = Number(process.env.AE_RENDER_TIMEOUT_MS || 180000)
const QUIT_TIMEOUT_MS = Number(process.env.AE_QUIT_TIMEOUT_MS || 60000)
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
const COMP_NAMES = ['MC Bridge Test', '測試 合成']
const CUSTOM_NAME = '{name} 自訂'

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

/** aerender and the render engine it starts (AfterFX.com) — to spot what a cancel left behind. */
const renderPids = () => [...runningImages('aerender.exe'), ...runningImages('AfterFX.com')]

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

/** Writes <dir>/quit-ae-test.jsx: close the (saved) test project without saving again and quit After Effects. */
function writeQuitScript(dir) {
  const src = [
    '// generated by scripts/test-ae.mjs: close the test project and quit After Effects',
    'try { app.beginSuppressDialogs(); } catch (e) {}',
    'try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e1) {}',
    'app.quit();',
    ''
  ].join('\n')
  const file = path.join(dir, 'quit-ae-test.jsx')
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

/**
 * Start After Effects with a script. It keeps running after the script (the test quits it in step 4). ae.pids collects
 * the AfterFX.exe processes seen while it runs: none ran before the test and After Effects is single-instance (another
 * launch meanwhile is handed to this one), so those - and only those - are the test's to kill.
 */
function startAfterEffects(aeExe, script, env) {
  const ae = { child: null, exit: null, error: null, killed: false, started: Date.now(), pids: new Set() }
  ae.child = spawn(aeExe, ['-r', script], { env, stdio: 'ignore', windowsHide: false })
  ae.pids.add(ae.child.pid)
  ae.exited = new Promise((resolve) => {
    ae.child.on('error', (e) => {
      ae.error = e.message
      resolve()
    })
    ae.child.on('exit', (code) => {
      ae.exit = code
      resolve()
    })
  })
  ae.running = () => ae.exit === null && !ae.error && !ae.killed
  ae.sample = () => {
    if (ae.running()) for (const pid of runningImages('AfterFX.exe')) ae.pids.add(pid)
  }
  return ae
}

/** Kill the After Effects processes this test started (see startAfterEffects). */
function killOurAfterEffects(ae) {
  ae.sample()
  ae.killed = true
  for (const pid of ae.pids) killTree(pid)
}

/** The AE-side report once complete ("done": true), { exitedEarly } when AE is gone without one, null on timeout. */
async function waitForReport(reportPath, ae, timeoutMs) {
  return waitFor(
    () => {
      ae.sample()
      try {
        const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
        if (r && r.done) return r
      } catch {
        /* not written (completely) yet */
      }
      return ae.running() ? null : { exitedEarly: true }
    },
    timeoutMs,
    1000
  )
}

function ffprobe(file) {
  const r = spawnSync(
    findFfprobe(),
    ['-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,nb_frames', '-of', 'json', file],
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

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** One aerender run through aerender.cjs, as the panel does it (hard timeout: cancelled). */
async function renderItem(plan, item, outputPath, cancelAtFrame = 0) {
  const progress = []
  const lines = []
  const started = Date.now()
  let timedOut = false
  const handle = aerender.render({
    aerenderPath: plan.aerenderPath,
    projectPath: plan.projectPath,
    comp: item.comp,
    outputPath,
    omTemplate: item.omTemplate,
    totalFrames: item.frames,
    onProgress: (p) => {
      progress.push(p)
      if (cancelAtFrame && p.frame >= cancelAtFrame) handle.cancel()
    },
    onLine: (l) => lines.push(l)
  })
  const timer = setTimeout(() => {
    timedOut = true
    handle.cancel()
  }, RENDER_TIMEOUT_MS)
  const r = await handle.promise
  clearTimeout(timer)
  return { r, progress, lines, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10 }
}

function checkVideo(label, file, frames) {
  const probe = ffprobe(file)
  if (probe.error) return check(`ffprobe reads ${label}`, false, probe.error)
  const v = (probe.streams || []).find((s) => s.codec_type === 'video')
  const dur = Number(probe.format?.duration)
  const size = fs.statSync(file).size
  check(`ffprobe reads ${label}`, !!v, `${probe.format?.format_name}, ${v?.codec_name}, ${(size / 1048576).toFixed(1)} MB`)
  check(`${label} is 1920×1080`, v && v.width === 1920 && v.height === 1080, v ? `${v.width}×${v.height}` : '')
  check(`${label} is ~3 s`, Math.abs(dur - 3) < 0.15, `${dur} s`)
  if (frames && v && v.nb_frames !== undefined) check(`${label} has the planned ${frames} frames`, Number(v.nb_frames) === frames, `${v.nb_frames}`)
}

/** Step 3: every plan item rendered by aerender while the After Effects GUI keeps the project open. */
async function renderPlan(plan, interDir, ae) {
  const rendered = []
  for (const item of plan.items) {
    const outputPath = path.join(interDir, item.baseName + item.ext)
    const guiBefore = ae.running()
    console.log(`Rendering "${item.comp}" with aerender (${item.frames} frames) …`)
    const { r, progress, lines, timedOut, seconds } = await renderItem(plan, item, outputPath)
    const ok = check(
      `aerender rendered "${item.comp}"`,
      r.ok && !timedOut,
      timedOut ? `no result within ${RENDER_TIMEOUT_MS / 1000} s — cancelled` : r.ok ? `${seconds} s, ${progress.length} progress updates` : r.errors.join('; ')
    )
    check(`  … while the After Effects GUI had the project open`, guiBefore && ae.running())
    let mono = true
    for (let i = 1; i < progress.length; i++) if (progress[i].percent < progress[i - 1].percent || progress[i].frame < progress[i - 1].frame) mono = false
    check('  progress never decreasing', mono && progress.length > 1, `${progress.length} updates`)
    const last = progress[progress.length - 1] || {}
    if (ok) check('  progress reaches 100 % with frame = planned frames', last.percent === 100 && last.frame === item.frames && last.total === item.frames, JSON.stringify(last))
    const lineFrames = lines.map((l) => aerender.parseLine(l)).filter((p) => p && p.type === 'frame').map((p) => p.frame)
    const maxLine = lineFrames.length ? Math.max(...lineFrames) : 0
    // aerender sometimes leaves out the last frame's line
    check('  aerender frame lines match the planned frames', maxLine === item.frames || maxLine === item.frames - 1, `highest (n) ${maxLine} of ${item.frames}`)
    const withEta = progress.find((p) => typeof p.remainingMs === 'number' && p.frame < item.frames)
    info(`first time-remaining estimate: ${withEta ? `${Math.round(withEta.remainingMs)} ms at frame ${withEta.frame}` : 'none'}`)
    if (!ok) {
      for (const l of lines.slice(-8)) info(l)
      continue
    }
    check('  only the final file is left in the folder', fs.existsSync(outputPath) && fs.readdirSync(interDir).every((f) => rendered.includes(path.join(interDir, f)) || f === path.basename(outputPath)))
    checkVideo(`"${path.basename(outputPath)}"`, outputPath, item.frames)
    rendered.push(outputPath)
  }
  return rendered
}

/** Step 3b: a real cancel — aerender's whole process tree goes, the partial file is deleted. */
async function cancelOnce(plan, tmp) {
  const dir = path.join(tmp, 'cancel 測試')
  const before = new Set(renderPids())
  console.log('Rendering once more and cancelling at the first frame …')
  const { r } = await renderItem(plan, plan.items[0], path.join(dir, 'cancelled.mov'), 1)
  if (!r.cancelled) {
    info(`render finished before the cancel took effect (ok=${r.ok}) — cancel not checked`)
    return
  }
  check('cancelled render resolves { ok: false, cancelled: true }', r.ok === false && r.cancelled === true)
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  check('cancelled render left no file', files.length === 0, files.join(', '))
  const left = await waitFor(() => (renderPids().every((p) => before.has(p)) ? 'none' : null), 5000)
  const extra = renderPids().filter((p) => !before.has(p))
  // reported only: an orphan cannot be told apart from an aerender someone else started meanwhile
  check('cancel killed aerender and its render engine', !!left, extra.length ? `still running: pids ${extra.join(', ')}` : '')
}

/** Step 6: the built app (out/) picks up the pending inbox request, converts the intermediates and deletes them. */
async function runAppRoundTrip(opts) {
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
  const env = { ...process.env, MC_USER_DATA_DIR: opts.userData, MC_NO_QUIT_CONFIRM: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  console.log('Starting Media Converter (built app, temp userData) …')
  const child = spawn(electronExe, [ROOT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false })
  let exited = null
  child.on('exit', (code) => (exited = code))
  child.on('error', (e) => (exited = e.message))
  try {
    await verifyRoundTrip({ ...opts, appExited: () => exited })
  } finally {
    if (exited === null) killTree(child.pid)
    await sleep(1000)
  }
}

/**
 * The app (launched by step 6, or already running in --user-data mode) answers results/<id>.json "accepted" with one job
 * per file × output, converts the intermediates into outDir (the custom output with its own name) and deletes them
 * (deleteAfter). appExited() turns non-null once a launched app is gone.
 */
async function verifyRoundTrip({ bridgeDir, id, presetId, renderedFiles, outputs, outDir, appExited = () => null }) {
  const paths = bridge.bridgePaths(bridgeDir)
  const started = Date.now()
  const result = await waitFor(() => bridge.readResult(bridgeDir, id) || (appExited() !== null ? { exitedEarly: true } : null), 60000)
  if (!result || result.exitedEarly) {
    check('app answered results/<id>.json', false, result ? `app exited (${appExited()})` : 'no answer within 60 s')
    return
  }
  const secs = Math.round((Date.now() - started) / 1000)
  check('app answered results/<id>.json', true, `${result.status} after ${secs} s`)
  const jobs = renderedFiles.length * outputs.length
  check(`request accepted with ${jobs} jobs (files × outputs)`, result.status === 'accepted' && result.jobIds.length === jobs, (result.errors || []).join('; '))
  check('inbox file consumed', !fs.existsSync(path.join(paths.inbox, `${id}.json`)))
  const appInfo = bridge.readInfo(bridgeDir)
  check(
    'app wrote bridge/info.json',
    appInfo && appInfo.appVersion !== 'test' && appInfo.presets.some((p) => p.id === presetId && p.kind === 'video'),
    appInfo ? `v${appInfo.appVersion}, ${appInfo.presets.length} video presets, locale ${appInfo.locale}` : 'unreadable'
  )
  if (result.status !== 'accepted') return

  // deleteAfter: an intermediate disappears only after all of its jobs succeeded
  const converted = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !/\.(tmp|part)$/i.test(f) && !f.startsWith('.')) : [])
  const done = await waitFor(() => renderedFiles.every((f) => !fs.existsSync(f)) && converted().length >= jobs, APP_TIMEOUT_MS, 1000)
  const list = converted()
  check(`${jobs} converted files written to outputDir`, list.length === jobs, list.join(', ') || 'nothing')
  check('intermediates deleted after their jobs succeeded (deleteAfter)', !!done && renderedFiles.every((f) => !fs.existsSync(f)))
  const marker = CUSTOM_NAME.replace('{name}', '').trim()
  const custom = list.filter((f) => f.includes(marker))
  check(
    `custom output name "${CUSTOM_NAME}" used once per file`,
    custom.length === renderedFiles.length && renderedFiles.every((rf) => custom.some((f) => f.startsWith(`${path.parse(rf).name} ${marker}`))),
    custom.join(', ') || 'none'
  )
  const expected = { 'h264-720p': [1280, 720], 'h264-1080p': [1920, 1080] }[presetId]
  for (const name of list) {
    const outFile = path.join(outDir, name)
    const probe = ffprobe(outFile)
    const v = (probe.streams || []).find((st) => st.codec_type === 'video')
    check(
      `converted "${name}" is a valid video`,
      !probe.error && v && Math.abs(Number(probe.format?.duration) - 3) < 0.2,
      probe.error || `${probe.format?.format_name}, ${v?.codec_name} ${v?.width}×${v?.height}, ${Number(probe.format?.duration).toFixed(2)} s`
    )
    if (expected && v) check(`  size matches ${presetId}`, v.width === expected[0] && v.height === expected[1], `${v.width}×${v.height}`)
  }
  info(`outputs: ${outDir}`)
}

/** Step 2 checks on the AE-side report. Returns the plan when it can be rendered. */
function checkReport(report, { projectPath, aeExe, pproDir }) {
  info(`AE ${report.aeVersion}; host.jsx ${report.hostVersion}; steps: ${report.steps.join(' → ')}; "Allow Scripts to Write Files" pref: ${report.canWriteFiles ? 'on' : 'off'}`)
  if (report.omTemplates && report.omTemplates.length) info(`AE output module templates: ${report.omTemplates.join(' | ')}`)
  if (report.error) check('AE test script ran without an exception', false, report.error)
  const u = report.unsaved
  check('planBackground on an unsaved project → unsavedProject', u && u.ok === false && u.error === 'unsavedProject', u ? `${u.error}` : 'no result')
  check('project saved into a folder with a space + CJK', samePath(report.savedAs, projectPath) && fs.existsSync(projectPath), report.savedAs)
  const d = report.duplicate
  check('planBackground with a duplicate comp name → duplicateComp', d && d.ok === false && d.error === 'duplicateComp' && d.message === COMP_NAMES[0], d ? `${d.error}: ${d.message}` : 'no result')
  const p = report.plan
  if (!check('MCHost.planBackground planned the selected comps', p && p.ok, p ? p.error ? `${p.error}: ${p.message}` : '' : 'no plan')) return null
  check('plan: host aftereffects, the saved project', p.host === 'aftereffects' && samePath(p.projectPath, projectPath), p.projectPath)
  check('plan: aerender.exe next to AfterFX.exe', samePath(path.dirname(p.aerenderPath), path.dirname(aeExe)) && fs.existsSync(p.aerenderPath), p.aerenderPath)
  const items = p.items || []
  check('plan: both comps', items.length === 2 && COMP_NAMES.every((n) => items.some((i) => i.comp === n)), items.map((i) => i.comp).join(', '))
  for (const i of items) {
    check(
      `plan "${i.comp}": 90 frames at 30 fps, .mov, a template, file-name safe unique base name`,
      i.frames === 90 && i.fps === 30 && i.ext === '.mov' && !!i.omTemplate && i.baseName === bridgeSafe(i.comp),
      `${i.frames} frames, ${i.fps} fps, ${i.ext}, "${i.omTemplate}", "${i.baseName}"`
    )
  }
  if (pproDir) {
    const epr = report.pproPreset
    check('MCHost.pproFindPreset finds a Premiere Pro .epr', !!epr && fs.existsSync(epr), epr || `nothing under ${pproDir}`)
  }
  return items.length ? p : null
}

/** host.jsx safeName for the plain names used here (no reserved characters). */
const bridgeSafe = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\s+|[\s.]+$/g, '')

/** Step 4: quit After Effects through a second AfterFX.exe -r script; kill it (ours) when that does not work. */
async function quitAfterEffects(aeExe, launchDir, ae, env) {
  ae.sample()
  if (!ae.running()) return
  const script = writeQuitScript(launchDir)
  const started = Date.now()
  const q = spawn(aeExe, ['-r', script], { env, stdio: 'ignore', windowsHide: false })
  q.on('error', () => {})
  const quit = await Promise.race([ae.exited.then(() => true), sleep(QUIT_TIMEOUT_MS).then(() => false)])
  const secs = Math.round((Date.now() - started) / 1000)
  if (!check('After Effects quit through a second AfterFX.exe -r script', quit, quit ? `after ${secs} s` : `still running after ${secs} s — killed`)) {
    for (const l of diagnose([...ae.pids], path.join(launchDir, 'ae-quit-timeout.png')).split(/\r?\n/)) if (l.trim()) info(l.trim())
    killOurAfterEffects(ae)
  }
  if (q.exitCode === null && q.pid) killTree(q.pid)
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
  const renderPidsAtStart = new Set(renderPids())

  // 1. temp bridge
  const tmp = fs.mkdtempSync(path.join(process.env.AE_TEST_TMP || os.tmpdir(), 'mc-ae-test-'))
  const launchDir = launchSafe(tmp) ? tmp : shortPath(tmp)
  if (!launchDir) {
    console.log(`test:ae: the temp folder ${tmp} contains spaces or non-ASCII characters and has no 8.3 short name;`)
    console.log('AfterFX.exe -r cannot run a script from there. Set AE_TEST_TMP to a folder such as C:\\mc-ae-test.')
    fs.rmSync(tmp, { recursive: true, force: true })
    process.exit(2)
  }
  // spaces + CJK on purpose: real user folders (and so %APPDATA%\Media Converter\bridge) have them
  const userData = ATTACH_USER_DATA ? path.resolve(ATTACH_USER_DATA) : path.join(tmp, 'user 資料')
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
      presets: [{ id: 'h264-1080p', kind: 'video', name: 'H.264 1080p', category: 'web', builtIn: true, summary: 'MP4 · H.264 · 1920×1080', ext: 'mp4' }],
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
  const projectDir = path.join(tmp, '專案 資料夾')
  fs.mkdirSync(projectDir)
  const projectPath = path.join(projectDir, 'MC 測試 專案.aep')
  const pproDir = findPremiereDir()
  const launcher = writeLauncher(launchDir, { hostJsx: HOST_JSX, projectPath, report: reportPath, pproDir })

  // 2. After Effects: build + save the project, plan the background render; AE stays open
  console.log(`Starting After Effects (timeout ${Math.round(TIMEOUT_MS / 1000)} s) …`)
  const ae = startAfterEffects(aeExe, launcher, env)
  let plan = null
  let rendered = []
  try {
    const report = await waitForReport(reportPath, ae, TIMEOUT_MS)
    const aeSecs = Math.round((Date.now() - ae.started) / 1000)
    if (!report) {
      check('After Effects ran the test script', false, `no report after ${aeSecs} s — killed`)
      for (const l of diagnose([...ae.pids], path.join(tmp, 'ae-timeout.png')).split(/\r?\n/)) if (l.trim()) info(l.trim())
      killOurAfterEffects(ae)
    } else if (report.exitedEarly) {
      check('After Effects ran the test script', false, ae.error || `After Effects exited (code ${ae.exit}) after ${aeSecs} s without a report — did it ignore -r ${launcher}?`)
    } else {
      check('After Effects ran the test script and stayed open', ae.running(), `report after ${aeSecs} s`)
      plan = checkReport(report, { projectPath, aeExe, pproDir })
    }

    // 3. aerender, while the After Effects GUI has the project open
    if (plan) {
      rendered = await renderPlan(plan, interDir, ae)
      await cancelOnce(plan, tmp)
    }
  } finally {
    // 4. quit After Effects (also after a failure above: never leave the test's instance running)
    await quitAfterEffects(aeExe, launchDir, ae, env)
  }
  let leftover = runningImages('AfterFX.exe').filter((p) => ae.pids.has(p))
  for (let i = 0; i < 20 && leftover.length; i++) {
    await sleep(1000)
    leftover = runningImages('AfterFX.exe').filter((p) => ae.pids.has(p))
  }
  if (leftover.length) {
    check('no After Effects process left behind', false, `pids ${leftover.join(', ')} — killed`)
    for (const pid of leftover) killTree(pid) // the test's own instance (see startAfterEffects)
  }
  const renderLeft = renderPids().filter((p) => !renderPidsAtStart.has(p))
  check('no aerender process left behind', !renderLeft.length, renderLeft.length ? `pids ${renderLeft.join(', ')} (not killed)` : '')

  // 5. inbox request with two outputs, written by the panel's own bridge module (as the panel does after the renders)
  if (plan && rendered.length === plan.items.length) {
    const outDir = path.join(tmp, 'out')
    const outputs = [
      { presetId, nameTemplate: null },
      { presetId, nameTemplate: CUSTOM_NAME }
    ]
    let req = null
    try {
      req = bridge.buildRequest({ id, host: 'aftereffects', files: rendered, outputs, outputDir: outDir, deleteAfter: true, start: true })
    } catch (e) {
      check('bridge-node.cjs buildRequest accepts outputs', false, e.message)
    }
    if (req) {
      check('request carries both outputs', JSON.stringify(req.outputs) === JSON.stringify(outputs), JSON.stringify(req.outputs))
      check('request presetIds = the unique preset ids of the outputs (older apps)', JSON.stringify(req.presetIds) === JSON.stringify([presetId]), JSON.stringify(req.presetIds))
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
        const bad = [bridge.validateRequest({ ...parsed, outputs: [] }), bridge.validateRequest({ ...parsed, outputs: [{ presetId: '' }] })]
        check('validateRequest rejects empty / malformed outputs', bad.every((e) => e.length > 0), bad.map((e) => e.join('; ')).join(' | '))
        const insideIntermediates = parsed.files.every((f) => !path.relative(paths.intermediates, f).startsWith('..') && fs.existsSync(f))
        check('request files exist inside bridge/intermediates/', insideIntermediates && parsed.files.length === 2)
        check('deleteAfter and start are true', parsed.deleteAfter === true && parsed.start === true)
      }

      // 6. the app round trip: the already running app (--user-data), or the built app started now (--app)
      const rt = { bridgeDir, id, presetId, renderedFiles: rendered, outputs, outDir, userData }
      if (ATTACH_USER_DATA) {
        await verifyRoundTrip(rt)
        // as the panel does: drop the answer once read; the app deletes the files only (the panel prunes old empty
        // folders later) — tidy up the running app's bridge now
        bridge.removeResult(bridgeDir, id)
        if (fs.existsSync(interDir) && !fs.readdirSync(interDir).length) bridge.removeDirIfInside(interDir, paths.intermediates)
      } else if (WITH_APP) await runAppRoundTrip(rt)
    }
  } else if (ATTACH_USER_DATA && fs.existsSync(interDir)) {
    bridge.removeDirIfInside(interDir, paths.intermediates)
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

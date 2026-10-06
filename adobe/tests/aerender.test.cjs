'use strict'
// Unit tests for the panel's background After Effects render (adobe/panel/js/aerender.cjs) and the After Effects side of
// it (MCHost.planBackground in adobe/panel/jsx/host.jsx, against a mock of the After Effects object model). Plain
// node:test, no dependencies:
//   node --test adobe/tests/aerender.test.cjs
// render() runs against a fake aerender: a Node script (aerender.cjs spawns process.execPath for a .cjs aerenderPath)
// that prints what the real aerender 23.0 prints. The real thing is exercised by npm run test:ae.
const assert = require('node:assert')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const aer = require('../panel/js/aerender.cjs')

const HOST_JSX = path.join(__dirname, '..', 'panel', 'jsx', 'host.jsx')

// ------------------------------------------------------------------ real aerender output (After Effects 2023, 23.0x59)
// Captured from real runs (comp / folder names replaced). Frame lines count from 1 within the rendered span, whatever
// the timecode; drop-frame comps print "0;00;01;12".
const REAL_LINES = [
  ['aerender version 23.0x59', null],
  ['PROGRESS: Launching After Effects...', null],
  ['PROGRESS: Adding specified comp to Render Queue', null],
  ['PROGRESS:  2026/10/05 下午 05:12:32: Starting composition “測試 合成”.', null],
  ['PROGRESS:  Render Settings: Best Settings', null],
  ['PROGRESS:  Quality: Best', null],
  ['PROGRESS:  Size: 3840 x 2160', null],
  ['PROGRESS:  Time Span: Custom', null],
  ['PROGRESS:  Start: 0:00:00:10', null],
  ['PROGRESS:  End: 0:00:00:15', null],
  ['PROGRESS:  Duration: 0:00:00:06', null],
  ['PROGRESS:  Frame Rate: 24.00 (comp)', null],
  ['PROGRESS:  ', null],
  ['PROGRESS:  Output Module: High Quality', null],
  ['PROGRESS:  Output To: C:\\Users\\me\\AppData\\Local\\Temp\\輸出 dir\\_mc-aerender-30292-muv1k0qq9le7.mov', null],
  ['PROGRESS:  Format: QuickTime', null],
  ['PROGRESS:  Output Info: Apple ProRes 422', null],
  ['PROGRESS:  Output Audio: On (if comp has audio)', null],
  ['PROGRESS:  Final Size: 3840 x 2160', null],
  ['PROGRESS:  Post-Render Action: None', null],
  ['PROGRESS:  0:00:00:10 (1): 0 Seconds', { type: 'frame', frame: 1 }],
  ['PROGRESS:  0:00:00:14 (5): 1 Seconds', { type: 'frame', frame: 5 }],
  ['PROGRESS:  0:00:07:22 (191): 0 Seconds', { type: 'frame', frame: 191 }],
  ['PROGRESS:  0;00;01;12 (43): 0 Seconds', { type: 'frame', frame: 43 }],
  ['PROGRESS:  0;00;02;11 (72): 0 Seconds\r', { type: 'frame', frame: 72 }],
  ['PROGRESS:  2026/10/05 下午 05:12:56: Finished composition “測試 合成”.', null],
  ['PROGRESS:  Total Time Elapsed: 1 Seconds', null],
  ['aerender ERROR: No comp was found with the given name.', { type: 'error', message: 'No comp was found with the given name.' }],
  [
    'aerender ERROR: No output module template was found with the given name.',
    { type: 'error', message: 'No output module template was found with the given name.' }
  ],
  [
    'aerender Error: After Effects error: Error in output for render queue item 1, output module 1. Directory does not exist: C:\\Temp\\no such dir\\sub.',
    {
      type: 'error',
      message: 'After Effects error: Error in output for render queue item 1, output module 1. Directory does not exist: C:\\Temp\\no such dir\\sub.'
    }
  ],
  [
    'aerender Error: After Effects error: Unable to call “openFast” because of parameter 1. Path is not valid. Path: “C:\\Temp\\cafe ??\\p.aep”',
    { type: 'error', message: 'After Effects error: Unable to call “openFast” because of parameter 1. Path is not valid. Path: “C:\\Temp\\cafe ??\\p.aep”' }
  ],
  // a failing output module (the H.264 writer on a 4K comp): no "aerender ERROR" line, exit code 0
  [
    'PROGRESS:  An unexpected error occurred while exporting a composition.',
    { type: 'error', message: 'An unexpected error occurred while exporting a composition.' }
  ],
  ['Error Code: 9988', { type: 'error', message: 'Error Code: 9988' }],
  ['Please restart After Effects and retry the export.', null],
  [
    'WARNING:After Effects warning: logged one error — “error: Rendering error while writing to file “C:\\Temp\\輸出\\_mc-aerender-29476-muv2c1opmmk4.mp4”. An output module failed. The file may be damaged or corrupted. (-1610153423)”',
    {
      type: 'error',
      message:
        'After Effects warning: logged one error — “error: Rendering error while writing to file “C:\\Temp\\輸出\\_mc-aerender-29476-muv2c1opmmk4.mp4”. An output module failed. The file may be damaged or corrupted. (-1610153423)”'
    }
  ],
  // (made up) a plain warning does not fail a render
  ['aerender Error: After Effects warning: a font is missing', null],
  // not frames: a comp name with "(n):" in it, the date of the start line
  ['PROGRESS:  2026/10/05 下午 05:12:32: Starting composition “Shot (2): A”.', null],
  ['', null]
]

// The start line above as aerender wrote it on a Traditional Chinese (code page 950 / Big5) system
const BIG5_START_LINE = Buffer.from(
  '50524f47524553533a2020323032362f31302f303520a455a4c82030353a31323a33323a205374617274696e6720636f6d706f736974696f6e20a1a7b4fab8d520a658a6a8a1a82e',
  'hex'
)

test('parseLine: real aerender lines', () => {
  for (const [line, expected] of REAL_LINES) assert.deepStrictEqual(aer.parseLine(line), expected, line)
})

test('decodeLine: the ANSI code page (Big5 here), UTF-8, or ASCII with "?"', () => {
  assert.strictEqual(aer.decodeLine(BIG5_START_LINE, 'big5'), REAL_LINES[3][0])
  assert.strictEqual(aer.decodeLine(Buffer.from('PROGRESS:  Output To: C:\\輸出\\a.mov', 'utf8'), 'utf-8'), 'PROGRESS:  Output To: C:\\輸出\\a.mov')
  // unknown code page: valid UTF-8 is kept, anything else keeps its ASCII
  assert.strictEqual(aer.decodeLine(Buffer.from('測試', 'utf8'), ''), '測試')
  // (Big5 trail bytes in the ASCII range stay: this is only the last resort when the code page is unknown)
  assert.strictEqual(aer.decodeLine(BIG5_START_LINE, ''), 'PROGRESS:  2026/10/05 ?U? 05:12:32: Starting composition ? ?X?.')
  assert.strictEqual(aer.encodingLabel(950), 'big5')
  assert.strictEqual(aer.encodingLabel('932'), 'shift_jis')
  assert.strictEqual(aer.encodingLabel(1252), 'windows-1252')
  assert.strictEqual(aer.encodingLabel(65001), 'utf-8')
  assert.strictEqual(aer.encodingLabel(12345), null)
})

// ------------------------------------------------------------------ fake aerender
// Runs as "node fake-aerender.cjs <aerender args>". The comp name picks the scenario: "<label> mode=<m> frames=<n>
// id=<id>"; the arguments are logged to logs/<id>.json next to the script.
function fakeAerender() {
  const fs = require('fs')
  const path = require('path')
  const args = process.argv.slice(2)
  const arg = (k) => {
    const i = args.indexOf(k)
    return i >= 0 ? args[i + 1] : null
  }
  const comp = arg('-comp') || ''
  const tok = (k, d) => {
    const m = new RegExp('\\b' + k + '=(\\S+)').exec(comp)
    return m ? m[1] : d
  }
  const mode = tok('mode', 'ok')
  const frames = Number(tok('frames', '12'))
  const id = tok('id', 'x')
  const out = arg('-output')
  const logs = path.join(__dirname, 'logs')
  try {
    fs.mkdirSync(logs)
  } catch (e) {}
  fs.writeFileSync(path.join(logs, id + '.json'), JSON.stringify({ args, pid: process.pid }))
  fs.appendFileSync(path.join(logs, id + '.runs'), 'x')
  const w = (s) => process.stdout.write(typeof s === 'string' ? s : Buffer.from(s))
  const BIG5 = Buffer.from(process.env.FAKE_BIG5_LINE || '', 'hex')
  w('aerender version 23.0x59\r\nPROGRESS: Launching After Effects...\r\n')
  // templates this "After Effects" does not have (as with localized template names)
  if (arg('-RStemplate') === 'Missing RS') {
    w('PROGRESS: Adding specified comp to Render Queue\r\naerender ERROR: No render settings template was found with the given name.\r\n')
    process.exit(0)
  }
  if (arg('-OMtemplate') === 'Missing OM') {
    w('PROGRESS: Adding specified comp to Render Queue\r\naerender ERROR: No output module template was found with the given name.\r\n')
    process.exit(0)
  }
  if (mode === 'errorExit0') {
    w('PROGRESS: Adding specified comp to Render Queue\r\naerender ERROR: No comp was found with the given name.\r\n')
    process.exit(0)
  }
  if (mode === 'h264fail') {
    // what the real H.264 writer does: its own temp file next to the output, error lines, exit code 0
    fs.writeFileSync(out.replace(/\.[^.\\/]+$/, '.32152.460.m4v'), 'partial')
    w('PROGRESS: Adding specified comp to Render Queue\r\nPROGRESS:  Output To: ' + out.replace(/\.[^.\\/]+$/, '.mp4') + '\r\n')
    w('PROGRESS:  An unexpected error occurred while exporting a composition.\r\nError Code: 9988\r\n')
    w('Please restart After Effects and retry the export.\r\nPROGRESS:  Total Time Elapsed: 1 Seconds\r\n')
    w('WARNING:After Effects warning: logged one error - "error: Rendering error while writing to file. An output module failed."\r\n')
    process.exit(0)
  }
  if (mode === 'exit3') {
    w('PROGRESS: Adding specified comp to Render Queue\r\nsomething went wrong\r\n')
    process.exit(3)
  }
  let target = out
  if (mode === 'renamed') target = path.join(path.dirname(out), 'renamed-by-ae.mov')
  w('PROGRESS: Adding specified comp to Render Queue\r\n')
  w(Buffer.concat([BIG5, Buffer.from('\r\n\r\n')]))
  w('PROGRESS:  Render Settings: Best Settings\r\nPROGRESS:  Output To: ' + target + '\r\nPROGRESS:  \r\n')
  if (mode === 'slow') {
    const gc = require('child_process').spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(logs, id + '.grandchild'), String(gc.pid))
  }
  const writeFrames = mode !== 'noOutput'
  if (writeFrames) fs.writeFileSync(target, 'MOV')
  // Multi-Frame Rendering order: 1 2 3 5 4 6 6 7 … ; the last frame's line is left out, as aerender sometimes does
  const order = []
  for (let f = 1; f < frames; f++) order.push(f)
  if (order.length > 4) order.splice(3, 2, 5, 4)
  if (order.length > 6) order.splice(6, 0, 6)
  let i = 0
  const tick = () => {
    if (mode === 'slow') {
      fs.appendFileSync(target, 'x')
      w('PROGRESS:  0:00:00:00 (' + ((i++ % 50) + 1) + '): 0 Seconds\r\n')
      return setTimeout(tick, 80)
    }
    if (i < order.length) {
      const f = order[i++]
      const line = 'PROGRESS:  0:00:00:' + String(f - 1).padStart(2, '0') + ' (' + f + '): 0 Seconds\r\n'
      if (i === 2) {
        // a line split across two writes
        w(line.slice(0, 15))
        setTimeout(() => w(line.slice(15)), 5)
      } else w(line)
      if (writeFrames) fs.appendFileSync(target, 'frame')
      return setTimeout(tick, 25)
    }
    if (mode === 'errorWithFile') w('aerender Error: After Effects error: Error in output for render queue item 1, output module 1. Disk full.\r\n')
    w('PROGRESS:  2026/10/05 05:12:56: Finished composition.\r\n\r\n\r\nPROGRESS:  Total Time Elapsed: 1 Seconds\r\n')
    process.exit(0)
  }
  setTimeout(tick, 30)
}

function systemCodePage() {
  if (process.platform !== 'win32') return 65001
  const r = childProcess.spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], {
    encoding: 'latin1',
    windowsHide: true
  })
  const m = /ACP\s+REG_SZ\s+(\d+)/.exec(r.stdout || '')
  return m ? Number(m[1]) : 0
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !!fn()
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-aerender-'))
// spaces + CJK on purpose (real project and user folders have them)
const fakeDir = path.join(tmp, 'fake 工具')
fs.mkdirSync(fakeDir)
const FAKE = path.join(fakeDir, 'fake-aerender.cjs')
fs.writeFileSync(FAKE, "'use strict'\n;(" + fakeAerender.toString() + ')()\n')
const PROJECT = path.join(tmp, '專案 資料夾', 'MC 測試.aep')
fs.mkdirSync(path.dirname(PROJECT))
fs.writeFileSync(PROJECT, 'RIFX')
process.env.FAKE_BIG5_LINE = BIG5_START_LINE.toString('hex')
const spawnedGrandchildren = []
let caseNo = 0

test.after(() => {
  for (const pid of spawnedGrandchildren) {
    try {
      process.kill(pid)
    } catch (e) {
      /* gone */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** One fake render into its own output folder; the comp name gets "mode=<mode> id=<id>" (see fakeAerender). */
function run(mode, extra) {
  const id = 'c' + ++caseNo
  const outDir = path.join(tmp, '輸出 ' + id)
  extra = extra || {}
  const o = Object.assign(
    {
      aerenderPath: FAKE,
      projectPath: PROJECT,
      outputPath: path.join(outDir, 'MC 測試 ' + id + '.mov'),
      omTemplate: 'High Quality',
      totalFrames: 12
    },
    extra,
    { comp: (extra.comp || 'Comp') + ' mode=' + mode + ' id=' + id }
  )
  const progress = []
  const lines = []
  o.onProgress = (p) => progress.push(p)
  o.onLine = (l) => lines.push(l)
  const handle = aer.render(o)
  const log = () => {
    const f = path.join(fakeDir, 'logs', id + '.json')
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
  }
  return { id, outDir, opts: o, handle, progress, lines, log, files: () => (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) }
}

function assertMonotonic(progress) {
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].percent >= progress[i - 1].percent, `percent went back at ${i}: ${JSON.stringify(progress.slice(i - 1, i + 1))}`)
    assert.ok(progress[i].frame >= progress[i - 1].frame, `frame went back at ${i}`)
  }
}

test('render: success - arguments, out-of-order frames, progress to 100, temp file renamed to outputPath', async () => {
  const c = run('ok', { comp: 'Comp frames=12', totalFrames: 12 })
  const r = await c.handle.promise
  assert.deepStrictEqual(r, { ok: true, cancelled: false, code: 0, outputPath: c.opts.outputPath, errors: [] })
  assert.ok(fs.statSync(c.opts.outputPath).size > 0)
  assert.deepStrictEqual(c.files(), [path.basename(c.opts.outputPath)], 'only the final file is left')

  const { args } = c.log()
  const val = (k) => args[args.indexOf(k) + 1]
  assert.strictEqual(args[0], '-project')
  // ANSI-safe paths go as they are (Big5 has these characters), others as their 8.3 short path
  if (systemCodePage() === 950) assert.strictEqual(val('-project'), PROJECT)
  else assert.ok(fs.existsSync(val('-project')))
  assert.strictEqual(val('-comp'), c.opts.comp)
  assert.strictEqual(val('-RStemplate'), 'Best Settings')
  assert.strictEqual(val('-OMtemplate'), 'High Quality')
  assert.strictEqual(val('-v'), 'ERRORS_AND_PROGRESS')
  assert.strictEqual(val('-close'), 'DO_NOT_SAVE_CHANGES')
  const output = val('-output')
  assert.match(path.basename(output), /^_mc-aerender-\d+-[a-z0-9]+\.mov$/, 'ASCII temp name, no leading dot')
  assert.ok(/^[\x20-\x7e]+$/.test(path.basename(output)))

  // progress: starts at 0, never goes back, ends at exactly 100 with frame = total
  assert.ok(c.progress.length >= 5)
  assert.deepStrictEqual([c.progress[0].frame, c.progress[0].percent, c.progress[0].remainingMs], [0, 0, null])
  assertMonotonic(c.progress)
  const last = c.progress[c.progress.length - 1]
  assert.deepStrictEqual([last.frame, last.total, last.percent, last.remainingMs], [12, 12, 100, 0])
  assert.ok(c.progress.every((p) => p.percent >= 0 && p.percent <= 100 && p.total === 12 && typeof p.elapsedMs === 'number'))
  // remainingMs: null until a few frames are done, then a number
  assert.strictEqual(c.progress.find((p) => p.frame === 1).remainingMs, null)
  assert.strictEqual(typeof c.progress.find((p) => p.frame === 6).remainingMs, 'number')
  // frame 11 is the highest frame line; 12 (the missing last line) only comes with the successful end
  assert.ok(c.progress.some((p) => p.frame === 11 && p.percent === 91.6))

  // lines: decoded, CR stripped, the split line joined, empty lines dropped
  assert.ok(c.lines.includes('PROGRESS:  0:00:00:01 (2): 0 Seconds'))
  assert.ok(c.lines.every((l) => l.trim() && !/\r/.test(l)))
  const start = c.lines.find((l) => /Starting composition/.test(l))
  assert.ok(start, 'start line reported')
  if (systemCodePage() === 950) assert.strictEqual(start, REAL_LINES[3][0], 'Big5 output decoded')
})

test('render: After Effects writes to another name ("Output To:") - that file is used', async () => {
  const c = run('renamed')
  const r = await c.handle.promise
  assert.strictEqual(r.ok, true, r.errors.join('; '))
  assert.deepStrictEqual(c.files(), [path.basename(c.opts.outputPath)])
})

test('render: a render settings / output module template After Effects lacks -> rendered again without it', async () => {
  const c = run('ok', { rsTemplate: 'Missing RS', omTemplate: 'Missing OM' })
  const r = await c.handle.promise
  assert.strictEqual(r.ok, true, r.errors.join('; '))
  assert.strictEqual(fs.readFileSync(path.join(fakeDir, 'logs', c.id + '.runs'), 'utf8'), 'xxx', 'three runs: both, without -RStemplate, without both')
  const { args } = c.log()
  assert.ok(!args.includes('-RStemplate') && !args.includes('-OMtemplate'), args.join(' '))
  assertMonotonic(c.progress)
  assert.deepStrictEqual(c.files(), [path.basename(c.opts.outputPath)])
})

test('render: ERROR line with exit code 0 and no file -> not ok, the ERROR line is reported', async () => {
  const c = run('errorExit0')
  const r = await c.handle.promise
  assert.deepStrictEqual(r, {
    ok: false,
    cancelled: false,
    code: 0,
    outputPath: c.opts.outputPath,
    errors: ['No comp was found with the given name.']
  })
  assert.deepStrictEqual(c.files(), [])
})

test('render: ERROR line although a file was written -> not ok, the partial file is deleted', async () => {
  const c = run('errorWithFile')
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.errors, ['After Effects error: Error in output for render queue item 1, output module 1. Disk full.'])
  assert.deepStrictEqual(c.files(), [])
  assert.ok(c.progress.every((p) => p.percent < 100), 'no 100 % for a failed render')
})

test('render: output module failure (no ERROR line, exit 0) -> not ok, its lines reported, its temp file deleted', async () => {
  const c = run('h264fail')
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 0)
  assert.deepStrictEqual(r.errors, [
    'An unexpected error occurred while exporting a composition.',
    'Error Code: 9988',
    'After Effects warning: logged one error - "error: Rendering error while writing to file. An output module failed."'
  ])
  assert.deepStrictEqual(c.files(), [], 'the writer\'s "<temp>.32152.460.m4v" is gone too')
})

test('render: non-zero exit without ERROR lines -> not ok, code and the last lines reported', async () => {
  const c = run('exit3')
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.cancelled, false)
  assert.strictEqual(r.code, 3)
  assert.deepStrictEqual(r.errors.slice(-2), ['PROGRESS: Adding specified comp to Render Queue', 'something went wrong'])
})

test('render: exit 0 but no output file -> not ok (noOutput + last lines)', async () => {
  const c = run('noOutput')
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 0)
  assert.strictEqual(r.errors[0], 'noOutput: ' + c.opts.outputPath)
  assert.ok(r.errors.some((e) => /Total Time Elapsed/.test(e)))
  assert.deepStrictEqual(c.files(), [])
})

test('render: cancel kills the whole process tree, deletes the partial file and resolves cancelled', async () => {
  const c = run('slow', { totalFrames: 500 })
  const gcFile = path.join(fakeDir, 'logs', c.id + '.grandchild')
  assert.ok(await waitFor(() => c.progress.some((p) => p.frame >= 3) && fs.existsSync(gcFile), 15000), 'fake started rendering')
  const gcPid = Number(fs.readFileSync(gcFile, 'utf8'))
  spawnedGrandchildren.push(gcPid)
  const fakePid = c.log().pid
  assert.ok(alive(gcPid) && alive(fakePid))
  assert.ok(c.files().length === 1, 'partial file exists while rendering')
  c.handle.cancel()
  c.handle.cancel() // idempotent
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.cancelled, true)
  assert.strictEqual(r.outputPath, c.opts.outputPath)
  assert.deepStrictEqual(c.files(), [], 'partial file deleted')
  assert.ok(await waitFor(() => !alive(fakePid) && !alive(gcPid), 5000), 'aerender and its children are gone')
})

test('render: cancel(true) - the tree is gone when it returns (a closing panel page)', async () => {
  const c = run('slow', { totalFrames: 500 })
  const gcFile = path.join(fakeDir, 'logs', c.id + '.grandchild')
  assert.ok(await waitFor(() => c.progress.some((p) => p.frame >= 3) && fs.existsSync(gcFile), 15000), 'fake started rendering')
  const gcPid = Number(fs.readFileSync(gcFile, 'utf8'))
  spawnedGrandchildren.push(gcPid)
  const fakePid = c.log().pid
  c.handle.cancel(true)
  assert.ok(await waitFor(() => !alive(fakePid) && !alive(gcPid), 1000), 'aerender and its children are gone')
  const r = await c.handle.promise
  assert.deepStrictEqual([r.ok, r.cancelled], [false, true])
})

test('render: cancel right away - nothing is started', async () => {
  const c = run('ok')
  c.handle.cancel()
  const r = await c.handle.promise
  assert.strictEqual(r.cancelled, true)
  assert.strictEqual(r.ok, false)
  await new Promise((res) => setTimeout(res, 300))
  assert.strictEqual(c.log(), null, 'fake aerender never ran')
  assert.deepStrictEqual(c.files(), [])
})

test('render: bad options / missing files resolve with an error (never reject)', async () => {
  let r = await aer.render({}).promise
  assert.strictEqual(r.ok, false)
  assert.match(r.errors[0], /^invalidOptions: missing aerenderPath, projectPath, comp, outputPath$/)
  r = await aer.render({ aerenderPath: path.join(tmp, 'nope', 'aerender.exe'), projectPath: PROJECT, comp: 'A', outputPath: path.join(tmp, 'a.mov') }).promise
  assert.match(r.errors[0], /^noAerender: /)
  r = await aer.render({ aerenderPath: FAKE, projectPath: path.join(tmp, 'missing.aep'), comp: 'A', outputPath: path.join(tmp, 'a.mov') }).promise
  assert.match(r.errors[0], /^noProject: /)
  assert.strictEqual(r.cancelled, false)
})

test('render: a comp name outside the ANSI code page fails up front (compNameNotAnsi), one inside it is passed', async () => {
  const cp = systemCodePage()
  if (process.platform !== 'win32' || cp === 65001) return // every name fits
  // Hangul + Devanagari: no single ANSI code page has both
  const c = run('ok', { comp: '한글 हिन्दी' })
  const r = await c.handle.promise
  assert.strictEqual(r.ok, false)
  assert.deepStrictEqual(r.errors, ['compNameNotAnsi: ' + c.opts.comp])
  assert.strictEqual(c.log(), null, 'aerender not started')
  if ([932, 936, 950, 54936].includes(cp)) {
    const c2 = run('ok', { comp: '測試 合成' })
    const r2 = await c2.handle.promise
    assert.strictEqual(r2.ok, true, r2.errors.join('; '))
    const { args } = c2.log()
    assert.strictEqual(args[args.indexOf('-comp') + 1], c2.opts.comp)
  }
})

test('checkArgs: the comps / paths aerender could not receive, for a whole plan before anything renders', async () => {
  const outDir = path.join(tmp, '輸出 check')
  fs.mkdirSync(outDir)
  assert.deepStrictEqual(await aer.checkArgs({}), { comps: [], paths: [] })
  let r = await aer.checkArgs({ projectPath: PROJECT, outputDir: outDir, comps: ['Comp 1', 'Comp 2'] })
  assert.deepStrictEqual(r.comps, [])
  const cp = systemCodePage()
  if (process.platform !== 'win32' || cp === 65001) return // every name fits
  r = await aer.checkArgs({ projectPath: PROJECT, outputDir: outDir, comps: ['Comp 1', '한글 हिन्दी'] })
  assert.deepStrictEqual(r.comps, ['한글 हिन्दी'])
  if ([932, 936, 950, 54936].includes(cp)) {
    r = await aer.checkArgs({ projectPath: PROJECT, outputDir: outDir, comps: ['測試 合成'] })
    assert.deepStrictEqual(r, { comps: [], paths: [] })
  }
})

// ------------------------------------------------------------------ MCHost.planBackground (mock After Effects)
/** A small After Effects object model: just what host.jsx touches. */
function mockAfterEffects(opts) {
  opts = opts || {}
  const existing = new Set((opts.existing || ['C:\\AE\\Support Files\\aerender.exe']).map((p) => p.toLowerCase()))
  const norm = (p) => String(p).replace(/\//g, '\\')
  function File(p) {
    this.fsName = norm(p)
    this.name = this.fsName.split('\\').pop()
  }
  Object.defineProperty(File.prototype, 'exists', {
    get() {
      return existing.has(this.fsName.toLowerCase())
    }
  })
  function Folder(p) {
    this.fsName = norm(p)
  }
  Object.defineProperty(Folder.prototype, 'parent', {
    get() {
      return new Folder(this.fsName.replace(/\\[^\\]*$/, ''))
    }
  })
  Folder.appPackage = new Folder(opts.appDir || 'C:\\AE\\Support Files')
  function CompItem(name, duration, fps) {
    this.name = name
    this.duration = duration
    this.frameRate = fps
    this.frameDuration = 1 / fps
    this.workAreaDuration = duration
  }
  function FolderItem(name) {
    this.name = name
  }
  const comps = (opts.comps || []).map((c) => new CompItem(c.name, c.duration || 3, c.fps || 30))
  const items = comps.concat([new FolderItem('Solids')])
  const RQItemStatus = { NEEDS_OUTPUT: 3010, UNQUEUED: 3011, QUEUED: 3012, RENDERING: 3013, DONE: 3015 }
  // the user's own Render Queue items: [comp name, status name]
  const rqItems = (opts.queued || []).map(([name, status]) => ({ comp: comps.find((c) => c.name === name), status: RQItemStatus[status] }))
  const omTemplates = opts.omTemplates || ['High Quality', 'High Quality with Alpha', 'Lossless', 'H.264 - Match Render Settings - 15 Mbps']
  const log = []
  const rq = {
    rendering: !!opts.rendering,
    get numItems() {
      return rqItems.length
    },
    item(i) {
      return rqItems[i - 1]
    },
    items: {
      add(comp) {
        const item = {
          comp,
          status: RQItemStatus.QUEUED,
          templates: ['Best Settings', 'Draft Settings', 'Multi-Machine Settings'],
          timeSpanDuration: 0,
          applyTemplate(t) {
            log.push('rs:' + t)
            if (t === 'Best Settings') this.timeSpanDuration = comp.workAreaDuration
          },
          om: {
            templates: omTemplates,
            // the module's default template (After Effects 2023: H.264)
            name: opts.omDefault || 'H.264 - Match Render Settings - 15 Mbps',
            file: new File('C:\\Users\\me\\Desktop\\' + comp.name + '.mp4'),
            applyTemplate(t) {
              log.push('om:' + t)
              this.name = t
              this.file = new File('C:\\Users\\me\\Desktop\\' + comp.name + (/H\.264/.test(t) ? '.mp4' : '.mov'))
            }
          },
          outputModule(i) {
            assert.strictEqual(i, 1)
            return this.om
          },
          remove() {
            rqItems.splice(rqItems.indexOf(this), 1)
            log.push('remove:' + comp.name)
          }
        }
        rqItems.push(item)
        log.push('add:' + comp.name)
        return item
      }
    }
  }
  const project = {
    file: opts.unsaved ? null : new File(opts.projectPath || 'D:\\專案 資料夾\\MC 測試.aep'),
    renderQueue: rq,
    selection: (opts.selected || []).map((n) => comps.find((c) => c.name === n)),
    activeItem: opts.active ? comps.find((c) => c.name === opts.active) : null,
    get numItems() {
      return items.length
    },
    item(i) {
      return items[i - 1]
    },
    save() {
      log.push('save:' + rqItems.length)
      if (opts.saveThrows) throw new Error('disk full')
    }
  }
  const ctx = {
    app: { project, version: '23.0.0' },
    BridgeTalk: { appName: 'aftereffects' },
    $: { os: 'Windows 10/64' },
    File,
    Folder,
    CompItem,
    RQItemStatus,
    log,
    rqItems
  }
  vm.createContext(ctx)
  vm.runInContext(fs.readFileSync(HOST_JSX, 'utf8'), ctx, { filename: HOST_JSX })
  return ctx
}

function plan(ctx, args) {
  const json = ctx.MCHost.planBackground(args === undefined ? '{}' : JSON.stringify(args))
  assert.ok(/^[\x20-\x7e]*$/.test(json), 'ASCII JSON (CJK escaped for the evalScript round trip)')
  return JSON.parse(json)
}

test('planBackground: selected comps -> frames / fps / template / ext / unique safe names; temp items removed, then saved', () => {
  const ctx = mockAfterEffects({
    comps: [{ name: 'MC Bridge Test' }, { name: '測試 合成', duration: 2, fps: 24 }, { name: 'A:B', fps: 29.97 }, { name: 'A_B' }, { name: 'Other' }],
    selected: ['MC Bridge Test', '測試 合成', 'A:B', 'A_B'],
    active: 'Other'
  })
  assert.strictEqual(ctx.MCHost.version, '0.2.0')
  const r = plan(ctx)
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(r.host, 'aftereffects')
  assert.strictEqual(r.projectPath, 'D:\\專案 資料夾\\MC 測試.aep')
  assert.strictEqual(r.aerenderPath, 'C:\\AE\\Support Files\\aerender.exe')
  assert.deepStrictEqual(r.items, [
    { comp: 'MC Bridge Test', frames: 90, fps: 30, omTemplate: 'High Quality', ext: '.mov', baseName: 'MC Bridge Test' },
    { comp: '測試 合成', frames: 48, fps: 24, omTemplate: 'High Quality', ext: '.mov', baseName: '測試 合成' },
    { comp: 'A:B', frames: 90, fps: 29.97, omTemplate: 'High Quality', ext: '.mov', baseName: 'A_B' },
    { comp: 'A_B', frames: 90, fps: 30, omTemplate: 'High Quality', ext: '.mov', baseName: 'A_B_2' }
  ])
  assert.strictEqual(ctx.rqItems.length, 0, 'temporary render queue items removed')
  assert.strictEqual(ctx.log[ctx.log.length - 1], 'save:0', 'saved last, with the temporary items gone')
  assert.ok(ctx.log.includes('rs:Best Settings'))
})

test('planBackground: active comp when nothing is selected; template preference from args', () => {
  const ctx = mockAfterEffects({ comps: [{ name: 'Main' }, { name: 'Other' }], active: 'Main' })
  const r = plan(ctx, { templates: ['Missing Template', 'H.264 - Match Render Settings - 15 Mbps'] })
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(
    r.items.map((i) => [i.comp, i.omTemplate, i.ext]),
    [['Main', 'H.264 - Match Render Settings - 15 Mbps', '.mp4']]
  )
})

test('planBackground: localized template names -> the first QuickTime template; none -> the default module', () => {
  let ctx = mockAfterEffects({
    comps: [{ name: 'Main' }],
    active: 'Main',
    omTemplates: ['H.264 - 符合演算設定 - 15 Mbps', '_HIDDEN X-Factor 8', '高品質', '無損']
  })
  let r = plan(ctx)
  assert.deepStrictEqual(r.items.map((i) => [i.omTemplate, i.ext]), [['高品質', '.mov']])
  ctx = mockAfterEffects({ comps: [{ name: 'Main' }], active: 'Main', omTemplates: ['H.264 A', 'H.264 B'], omDefault: 'H.264 B' })
  r = plan(ctx)
  assert.deepStrictEqual(r.items.map((i) => [i.omTemplate, i.ext]), [['', '.mp4']])
  assert.strictEqual(ctx.log.filter((l) => /^om:/.test(l)).pop(), 'om:H.264 B', 'the default template is put back')
})

test('planBackground: failures', () => {
  const comps = [{ name: 'Main' }, { name: 'Main' }, { name: 'Solo' }]
  let r = plan(mockAfterEffects({ comps, selected: ['Solo'], unsaved: true }))
  assert.deepStrictEqual([r.ok, r.error, r.host], [false, 'unsavedProject', 'aftereffects'])
  assert.ok(Array.isArray(r.errors) && r.errors[0] === 'unsavedProject')
  r = plan(mockAfterEffects({ comps, selected: ['Solo'], rendering: true }))
  assert.strictEqual(r.error, 'busy')
  r = plan(mockAfterEffects({ comps }))
  assert.strictEqual(r.error, 'noComps')
  r = plan(mockAfterEffects({ comps, selected: ['Solo', 'Main'] }))
  assert.deepStrictEqual([r.error, r.message], ['duplicateComp', 'Main'])
  r = plan(mockAfterEffects({ comps, selected: ['Solo'], existing: [] }))
  assert.deepStrictEqual([r.error, r.message], ['noAerender', 'C:\\AE\\Support Files\\aerender.exe'])
  const ctx = mockAfterEffects({ comps, selected: ['Solo'], saveThrows: true })
  r = plan(ctx)
  assert.strictEqual(r.error, 'saveFailed')
  assert.match(r.message, /disk full/)
  assert.strictEqual(ctx.rqItems.length, 0)
})

test('planBackground: a target comp queued in the Render Queue -> compQueued (aerender -comp would render that item)', () => {
  const comps = [{ name: 'Main' }, { name: 'Other' }]
  let ctx = mockAfterEffects({ comps, selected: ['Main'], queued: [['Main', 'QUEUED']] })
  let r = plan(ctx)
  assert.deepStrictEqual([r.ok, r.error, r.message], [false, 'compQueued', 'Main'])
  assert.ok(!ctx.log.some((l) => /^(add|save):/.test(l)), 'nothing added, not saved')
  assert.strictEqual(ctx.rqItems.length, 1, "the user's item is left alone")
  r = plan(mockAfterEffects({ comps, active: 'Main', queued: [['Other', 'DONE'], ['Main', 'UNQUEUED']] }))
  assert.deepStrictEqual([r.error, r.message], ['compQueued', 'Main'])
  // rendered / not renderable items and other comps do not matter
  ctx = mockAfterEffects({ comps, selected: ['Main'], queued: [['Main', 'DONE'], ['Main', 'NEEDS_OUTPUT'], ['Other', 'QUEUED']] })
  r = plan(ctx)
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.strictEqual(ctx.rqItems.length, 3, 'only the temporary item was removed')
  assert.strictEqual(ctx.log[ctx.log.length - 1], 'save:3')
})

test('host.jsx: no in-After Effects render any more (render is Premiere only)', () => {
  const ctx = mockAfterEffects({ comps: [{ name: 'Main' }], active: 'Main' })
  assert.strictEqual(ctx.MCHost.aeRenderComps, undefined)
  const r = JSON.parse(ctx.MCHost.render(JSON.stringify({ outDir: 'C:\\out' })))
  assert.deepStrictEqual([r.ok, r.error], [false, 'unsupportedHost'])
  assert.strictEqual(ctx.rqItems.length, 0)
})

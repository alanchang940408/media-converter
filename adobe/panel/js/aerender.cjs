'use strict'
// Background After Effects render with aerender (After Effects stays usable; the panel shows the progress).
// CommonJS, Node 8 syntax level, no dependencies: loaded by the panel (js/main.js, through CEP's require), by
// scripts/test-ae.mjs and by adobe/tests/aerender.test.cjs.
//
//   render(opts) -> { promise, cancel(sync) }
//     opts: { aerenderPath, projectPath, comp, outputPath, omTemplate, rsTemplate = 'Best Settings', totalFrames,
//             onProgress(p), onLine(line) }    p = { frame, total, percent, elapsedMs, remainingMs }
//     promise resolves (never rejects) { ok, cancelled, code, outputPath, errors }
//     cancel(true) kills synchronously (a closing panel page cannot wait for callbacks)
//   parseLine(line) -> { type: 'frame', frame } | { type: 'error', message } | null
//   checkArgs({ projectPath, outputDir, comps }) -> Promise of { comps, paths } that aerender could not receive (below)
//
// What aerender (After Effects 2023, 23.0x59) really prints, one line each, in the system ANSI code page:
//   aerender version 23.0x59
//   PROGRESS: Launching After Effects...
//   PROGRESS: Adding specified comp to Render Queue
//   PROGRESS:  2026/10/05 下午 05:12:32: Starting composition “Comp 1”.     (localized date, ANSI curly quotes)
//   PROGRESS:  Output To: C:\...\Comp 1.mov                                 (settings block)
//   PROGRESS:  0:00:00:23 (24): 0 Seconds          (timecode, or 0;00;00;00 drop-frame; (n) counts from 1 within the
//                                                   rendered span; the last frame's line is sometimes missing)
//   PROGRESS:  2026/10/05 下午 05:12:34: Finished composition “Comp 1”.
//   PROGRESS:  Total Time Elapsed: 1 Seconds
//   aerender ERROR: No comp was found with the given name.
//   aerender Error: After Effects error: Error in output for render queue item 1, output module 1. Directory does not exist: …
// It exits 0 after errors too, so success = exit 0 + no error line (RENDER_ERROR_RES: a failing output module prints
// no ERROR line) + a non-empty output file. A render settings / output module template the installed After Effects
// does not have (localized names) is retried without it. aerender starts AfterFX.com (+ crashpad_handler.exe) as
// children: cancel kills the whole tree.
// aerender reads its command line in the ANSI code page: other characters turn into "?" or a look-alike (a project
// in "café 한글\" is "Path is not valid" on a Big5 system, while "專案\" works there). A project / output folder that
// does not survive the ANSI round trip is passed as its 8.3 short path (when the volume has one; short names keep
// the characters the code page has), aerender writes to an ASCII temp name next to outputPath, renamed on success
// (the project's temp-file-then-rename rule). What still cannot be passed (a comp name, a path without a short form)
// fails up front with compNameNotAnsi / pathNotAnsi; checkArgs lets the panel find that out for every comp before the
// first one renders.

const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const DEFAULT_RS_TEMPLATE = 'Best Settings'
const TAIL_LINES = 6
// "PROGRESS:  0:00:00:23 (24): 0 Seconds" / "PROGRESS:  0;00;01;12 (43): 1 Seconds" / "PROGRESS:  00023 (24): 0 Seconds"
const FRAME_RE = /^PROGRESS:\s+\d[\d:;.,+]*\s+\((\d+)\):\s*\d/
// "aerender ERROR: …" / "aerender Error: After Effects error: …"
const ERROR_RE = /^aerender\s+error\s*:\s*(.*)$/i
// a failing output module (e.g. the H.264 writer) prints no "aerender ERROR" line, only these (exit code 0):
//   PROGRESS:  An unexpected error occurred while exporting a composition.
//   Error Code: 9988
//   WARNING:After Effects warning: logged one error — “error: Rendering error while writing to file “…”. An output module failed. …”
const RENDER_ERROR_RES = [
  /^PROGRESS:\s+(An unexpected error occurred\b.*)$/i,
  /^(Error Code:\s*-?\d+.*)$/i,
  /^WARNING:\s*(.*\blogged\s+(?:one|an|\d+)\s+errors?\b.*)$/i
]
// "aerender Error: After Effects warning: …" without an error in it does not fail the render
const WARNING_RE = /^after effects warning\b/i
const OUTPUT_TO_RE = /^PROGRESS:\s+Output To:\s*(.+)$/i
// a template name the installed After Effects does not have (localized names): rendered again without it, i.e. with
// the comp's default template - the one MCHost.planBackground measured when it did not find the name either
const NO_RS_TEMPLATE_RE = /no render settings template was found/i
const NO_OM_TEMPLATE_RE = /no output module template was found/i

/** One aerender output line -> what it means for the render (null = informational). */
function parseLine(line) {
  const s = String(line == null ? '' : line).replace(/^\uFEFF/, '').trim()
  let m = FRAME_RE.exec(s)
  if (m) return { type: 'frame', frame: Number(m[1]) }
  m = ERROR_RE.exec(s)
  if (m) {
    const message = m[1].trim() || s
    if (WARNING_RE.test(message) && !/\berror/i.test(message.replace(WARNING_RE, ''))) return null
    return { type: 'error', message: message }
  }
  for (let i = 0; i < RENDER_ERROR_RES.length; i++) {
    m = RENDER_ERROR_RES[i].exec(s)
    if (m) return { type: 'error', message: m[1].trim() }
  }
  return null
}

function isAscii(s) {
  return /^[\x20-\x7e]*$/.test(String(s))
}

// ------------------------------------------------------------------ output decoding (system ANSI code page)
const CODE_PAGES = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  20932: 'euc-jp',
  28591: 'iso-8859-1',
  54936: 'gb18030',
  65001: 'utf-8'
}

/** WHATWG encoding label of a Windows code page (null = unknown). */
function encodingLabel(cp) {
  const n = Number(cp)
  if (CODE_PAGES[n]) return CODE_PAGES[n]
  if (n >= 1250 && n <= 1258) return 'windows-' + n
  return null
}

const decoders = {}
function decoderFor(label) {
  if (Object.prototype.hasOwnProperty.call(decoders, label)) return decoders[label]
  let d = null
  try {
    // the panel's mixed context has Chromium's TextDecoder (every WHATWG encoding); plain Node 8 has util.TextDecoder
    // (only utf-8 / utf-16le / latin1 without full ICU)
    const Ctor = typeof TextDecoder === 'function' ? TextDecoder : require('util').TextDecoder
    if (Ctor) d = new Ctor(label)
  } catch (e) {
    d = null
  }
  decoders[label] = d
  return d
}

/** Bytes of one line -> string: the given encoding when this runtime knows it, else UTF-8 when valid, else the ASCII
 *  characters with "?" for each run of other bytes. */
function decodeLine(buf, label) {
  if (!buf || !buf.length) return ''
  if (label) {
    const d = label === 'utf-8' ? null : decoderFor(label)
    if (d) {
      try {
        return d.decode(buf)
      } catch (e) {
        /* fall through */
      }
    }
  }
  const utf8 = buf.toString('utf8')
  if (label === 'utf-8' || utf8.indexOf('\uFFFD') < 0) return utf8
  let out = ''
  let inRun = false
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c < 0x80) {
      out += String.fromCharCode(c)
      inRun = false
    } else if (!inRun) {
      out += '?'
      inRun = true
    }
  }
  return out
}

let codePageCache = null
/** cb(label) - encoding of aerender's output: the Windows ANSI code page (registry), UTF-8 elsewhere. Cached. */
function outputEncoding(cb) {
  if (codePageCache !== null) return cb(codePageCache)
  if (process.platform !== 'win32') {
    codePageCache = 'utf-8'
    return cb(codePageCache)
  }
  childProcess.execFile(
    'reg',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
    { windowsHide: true, timeout: 10000 },
    function (err, stdout) {
      const m = /ACP\s+REG_SZ\s+(\d+)/i.exec(String(stdout || ''))
      codePageCache = (!err && m && encodingLabel(m[1])) || ''
      cb(codePageCache)
    }
  )
}

/** Splits a byte stream into lines (LF, optional CR before it) without decoding across a multi-byte character. In every
 *  ANSI code page aerender may use (DBCS included), 0x0A / 0x0D never occur inside a character. */
function lineSplitter(label, onLine) {
  let pending = null
  function emit(buf) {
    let end = buf.length
    while (end > 0 && buf[end - 1] === 0x0d) end--
    onLine(decodeLine(buf.slice(0, end), label))
  }
  return {
    push: function (chunk) {
      let buf = pending ? Buffer.concat([pending, chunk]) : chunk
      let start = 0
      let i
      while ((i = buf.indexOf(0x0a, start)) >= 0) {
        emit(buf.slice(start, i))
        start = i + 1
      }
      pending = start < buf.length ? buf.slice(start) : null
    },
    end: function () {
      if (pending && pending.length) emit(pending)
      pending = null
    }
  }
}

// ------------------------------------------------------------------ file-system helpers
function mkdirp(dir) {
  if (fs.existsSync(dir)) return
  mkdirp(path.dirname(dir))
  try {
    fs.mkdirSync(dir)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
}

function fileSize(file) {
  try {
    const st = fs.statSync(file)
    return st.isFile() ? st.size : -1
  } catch (e) {
    return -1
  }
}

/** Delete a file, retrying while a just-killed process still holds it. cb() when gone (or given up). */
function removeWithRetry(file, tries, cb) {
  if (!file || !fs.existsSync(file)) return cb()
  try {
    fs.unlinkSync(file)
    return cb()
  } catch (e) {
    if (tries <= 1) return cb()
    setTimeout(function () {
      removeWithRetry(file, tries - 1, cb)
    }, 250)
  }
}

function renameWithRetry(from, to, tries, cb) {
  try {
    fs.renameSync(from, to)
    cb(null)
  } catch (e) {
    if (tries <= 1) return cb(e)
    setTimeout(function () {
      renameWithRetry(from, to, tries - 1, cb)
    }, 250)
  }
}

/**
 * cb({ args, unsafe }) - how to pass non-ASCII strings on aerender's ANSI command line (Windows; PowerShell 5.1, whose
 * Encoding.Default is the ANSI code page; the strings travel in environment variables, never in a command string).
 * items: [{ value, file: true when it is an existing file / folder }]. args maps each value to what to pass: itself
 * when it survives the ANSI round trip, else its 8.3 short path when that one does; unsafe lists the values that have
 * neither. When PowerShell is not available every value maps to itself.
 */
function ansiArgs(items, cb) {
  const res = { args: {}, unsafe: [] }
  items.forEach(function (it) {
    res.args[it.value] = it.value
  })
  if (process.platform !== 'win32' || !items.length) return cb(res)
  const ps = [
    "$ProgressPreference = 'SilentlyContinue'",
    '$enc = [System.Text.Encoding]::Default',
    '$fso = New-Object -ComObject Scripting.FileSystemObject',
    'for ($i = 0; $i -lt [int]$env:MC_AER_N; $i++) {',
    "  $v = [Environment]::GetEnvironmentVariable('MC_AER_' + $i)",
    "  if ($enc.GetString($enc.GetBytes($v)) -ceq $v) { Write-Output '=1'; continue }",
    "  $s = ''",
    "  if ([Environment]::GetEnvironmentVariable('MC_AER_F' + $i) -eq '1') {",
    '    try { if (Test-Path -LiteralPath $v -PathType Container) { $s = $fso.GetFolder($v).ShortPath } elseif (Test-Path -LiteralPath $v) { $s = $fso.GetFile($v).ShortPath } } catch {}',
    '  }',
    "  if ($s -and ($enc.GetString($enc.GetBytes($s)) -ceq $s)) { Write-Output ('=S' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))) }",
    "  else { Write-Output '=0' }",
    '}'
  ].join('\n')
  const env = {}
  Object.keys(process.env).forEach(function (k) {
    env[k] = process.env[k]
  })
  env.MC_AER_N = String(items.length)
  items.forEach(function (it, i) {
    env['MC_AER_' + i] = it.value
    env['MC_AER_F' + i] = it.file ? '1' : '0'
  })
  childProcess.execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    { windowsHide: true, env: env, timeout: 20000 },
    function (err, stdout) {
      const lines = String(stdout || '')
        .split(/\r?\n/)
        .filter(function (l) {
          return l.charAt(0) === '='
        })
      if (err || lines.length !== items.length) return cb(res)
      items.forEach(function (it, i) {
        const l = lines[i]
        if (l.charAt(1) === 'S') {
          const short = Buffer.from(l.slice(2).trim(), 'base64').toString('utf8')
          if (short && fs.existsSync(short)) res.args[it.value] = short
          else res.unsafe.push(it.value)
        } else if (l.charAt(1) !== '1') {
          res.unsafe.push(it.value)
        }
      })
      cb(res)
    }
  )
}

/** killTree, but returns only once the processes are gone (Windows: taskkill run synchronously). */
function killTreeSync(child) {
  if (process.platform !== 'win32') return killTree(child, function () {}) // synchronous there already
  try {
    childProcess.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000, stdio: 'ignore' })
  } catch (e) {
    try {
      child.kill()
    } catch (e2) {
      /* already gone */
    }
  }
}

/** Kill a process and everything it started. cb() once the kill command returned. */
function killTree(child, cb) {
  if (process.platform === 'win32') {
    childProcess.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, function (err) {
      if (err) {
        try {
          child.kill()
        } catch (e) {
          /* already gone */
        }
      }
      cb()
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL') // the child leads its own process group (spawned detached)
  } catch (e) {
    try {
      child.kill('SIGKILL')
    } catch (e2) {
      /* already gone */
    }
  }
  cb()
}

// ------------------------------------------------------------------ render
function render(opts) {
  opts = opts || {}
  const started = Date.now()
  const total = Number(opts.totalFrames) > 0 ? Math.round(Number(opts.totalFrames)) : 0
  const outputPath = opts.outputPath ? path.resolve(String(opts.outputPath)) : ''
  const comp = opts.comp == null ? '' : String(opts.comp)
  let resolveFn = null
  const promise = new Promise(function (resolve) {
    resolveFn = resolve
  })

  let settled = false
  let cancelled = false
  let finishing = false
  let child = null
  let outDir = ''
  let tempPath = ''
  // where After Effects says it writes ("Output To:"): it rewrites some names (a leading "." becomes "_")
  let reportedPath = ''
  const errorLines = []
  const tail = []
  let useRs = true
  let useOm = !!opts.omTemplate
  let launchArgs = null
  let maxFrame = 0
  let lastPercent = 0
  let firstAt = 0
  let firstFrame = 0

  function settle(ok, code, errors) {
    if (settled) return
    settled = true
    resolveFn({ ok: ok, cancelled: cancelled, code: code === undefined ? null : code, outputPath: outputPath, errors: errors || [] })
  }

  function progress(frame, done) {
    if (typeof opts.onProgress !== 'function') return
    const now = Date.now()
    let percent = done ? 100 : total > 0 ? Math.floor((Math.min(frame, total) / total) * 1000) / 10 : 0
    if (percent < lastPercent) percent = lastPercent
    lastPercent = percent
    let remainingMs = null
    if (done) remainingMs = 0
    else if (total > 0 && firstAt && frame - firstFrame >= 2) {
      // time per frame measured from the first finished frame (After Effects' start-up is not part of it)
      remainingMs = Math.max(0, Math.round(((now - firstAt) / (frame - firstFrame)) * Math.max(0, total - frame)))
    }
    try {
      opts.onProgress({ frame: frame, total: total || null, percent: percent, elapsedMs: now - started, remainingMs: remainingMs })
    } catch (e) {
      /* a failing callback must not break the render */
    }
  }

  function handleLine(line) {
    if (!line.trim()) return
    tail.push(line.trim())
    if (tail.length > TAIL_LINES) tail.shift()
    if (typeof opts.onLine === 'function') {
      try {
        opts.onLine(line)
      } catch (e) {
        /* ignore */
      }
    }
    const out = OUTPUT_TO_RE.exec(line.trim())
    if (out) {
      const name = out[1].trim().split(/[\\/]/).pop()
      if (name && isAscii(name)) reportedPath = path.join(outDir, name)
    }
    const p = parseLine(line)
    if (!p) return
    if (p.type === 'error') {
      errorLines.push(p.message)
      return
    }
    // Multi-Frame Rendering may report frames out of order: progress follows the highest frame, never goes back
    if (p.frame <= maxFrame) return
    if (!firstAt) {
      firstAt = Date.now()
      firstFrame = p.frame
    }
    maxFrame = p.frame
    progress(maxFrame, false)
  }

  /** Delete the partial output: the temp name, the name After Effects reported, and what an output module left under
   *  the temp name (the H.264 writer: "<temp base>.32152.460.m4v"). */
  function cleanup(tries, cb) {
    const base = path.basename(tempPath, path.extname(tempPath)) + '.'
    let strays = []
    try {
      strays = fs
        .readdirSync(outDir)
        .filter(function (f) {
          return f.indexOf(base) === 0
        })
        .map(function (f) {
          return path.join(outDir, f)
        })
    } catch (e) {
      /* folder gone */
    }
    const files = [tempPath, reportedPath].concat(strays).filter(function (f, i, all) {
      return f && all.indexOf(f) === i
    })
    ;(function next() {
      if (!files.length) return cb()
      removeWithRetry(files.shift(), tries, next)
    })()
  }

  function finish(code) {
    finishing = true
    if (cancelled) {
      cleanup(20, function () {
        settle(false, code, [])
      })
      return
    }
    const produced = fileSize(tempPath) > 0 ? tempPath : reportedPath && fileSize(reportedPath) > 0 ? reportedPath : ''
    const missingTemplate = function (re) {
      return !produced && errorLines.some(function (l) {
        return re.test(l)
      })
    }
    if (useRs && missingTemplate(NO_RS_TEMPLATE_RE)) {
      useRs = false
      return relaunch()
    }
    if (useOm && missingTemplate(NO_OM_TEMPLATE_RE)) {
      useOm = false
      return relaunch()
    }
    if (code === 0 && !errorLines.length && produced) {
      renameWithRetry(produced, outputPath, 8, function (err) {
        if (err) {
          cleanup(4, function () {
            settle(false, code, ['renameFailed: ' + err.message])
          })
          return
        }
        progress(Math.max(maxFrame, total), true)
        if (produced === tempPath) return settle(true, code, [])
        removeWithRetry(tempPath, 4, function () {
          settle(true, code, [])
        })
      })
      return
    }
    let errors = errorLines.length ? errorLines.slice() : tail.slice()
    if (!errorLines.length && code === 0) errors.unshift('noOutput: ' + outputPath)
    if (!errors.length) errors = ['exitCode: ' + code]
    cleanup(8, function () {
      settle(false, code, errors)
    })
  }

  /** aerender ran but lacked a template: once more without it (see NO_RS_TEMPLATE_RE). */
  function relaunch() {
    finishing = false
    errorLines.length = 0
    reportedPath = ''
    cleanup(4, function () {
      if (cancelled) return settle(false, null, [])
      launch(launchArgs.label, launchArgs.ansi)
    })
  }

  function start(label, ansi) {
    if (cancelled) return settle(false, null, [])
    if (ansi.unsafe.length) {
      // aerender would see "?" instead of these characters: say so instead of a cryptic "Path is not valid"
      return settle(
        false,
        null,
        ansi.unsafe.map(function (v) {
          return (v === comp ? 'compNameNotAnsi: ' : 'pathNotAnsi: ') + v
        })
      )
    }
    launchArgs = { label: label, ansi: ansi }
    launch(label, ansi)
  }

  function launch(label, ansi) {
    const args = ['-project', ansi.args[opts.projectPath] || opts.projectPath, '-comp', comp]
    if (useRs) args.push('-RStemplate', opts.rsTemplate || DEFAULT_RS_TEMPLATE)
    if (useOm) args.push('-OMtemplate', String(opts.omTemplate))
    args.push(
      '-output', path.join(ansi.args[outDir] || outDir, path.basename(tempPath)),
      '-v', 'ERRORS_AND_PROGRESS',
      '-close', 'DO_NOT_SAVE_CHANGES',
      '-sound', 'OFF'
    )
    let bin = opts.aerenderPath
    // test hook: a Node script stands in for aerender (adobe/tests/aerender.test.cjs)
    if (/\.c?js$/i.test(bin)) {
      args.unshift(bin)
      bin = process.execPath
    }
    try {
      child = childProcess.spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
    } catch (e) {
      return settle(false, null, ['spawnFailed: ' + e.message])
    }
    const out = lineSplitter(label, handleLine)
    const err = lineSplitter(label, handleLine)
    child.stdout.on('data', out.push)
    child.stderr.on('data', err.push)
    let exitCode = null
    let done = false
    let graceTimer = null
    function end(code) {
      if (done) return
      done = true
      if (graceTimer) clearTimeout(graceTimer)
      out.end()
      err.end()
      finish(code)
    }
    child.on('error', function (e) {
      if (!child.pid) {
        errorLines.push('spawnFailed: ' + e.message)
        end(null)
      }
    })
    child.on('exit', function (code) {
      exitCode = code
      // 'close' follows once the pipes are drained; a grandchild still holding them must not hang the result
      graceTimer = setTimeout(function () {
        end(exitCode)
      }, 2000)
    })
    child.on('close', function (code) {
      end(exitCode !== null ? exitCode : code)
    })
    progress(0, false)
  }

  /** sync = true: the tree is dead when cancel returns (the partial file is deleted later, when the event loop still
   *  runs - a closing panel removes the whole folder itself). */
  function cancel(sync) {
    // once aerender has exited its result stands (a finished render is not thrown away by a late Cancel)
    if (settled || cancelled || finishing) return
    cancelled = true
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      if (sync === true) killTreeSync(child)
      else killTree(child, function () {})
    }
    // not spawned yet: start() sees the flag; already exiting: finish() sees it
  }

  // ---- validate, then resolve the encoding and short paths, then spawn
  const missing = ['aerenderPath', 'projectPath', 'comp', 'outputPath'].filter(function (k) {
    return !opts[k]
  })
  if (missing.length) {
    settle(false, null, ['invalidOptions: missing ' + missing.join(', ')])
    return { promise: promise, cancel: cancel }
  }
  if (!fs.existsSync(opts.aerenderPath)) {
    settle(false, null, ['noAerender: ' + opts.aerenderPath])
    return { promise: promise, cancel: cancel }
  }
  if (!fs.existsSync(opts.projectPath)) {
    settle(false, null, ['noProject: ' + opts.projectPath])
    return { promise: promise, cancel: cancel }
  }
  outDir = path.dirname(outputPath)
  try {
    mkdirp(outDir)
  } catch (e) {
    settle(false, null, ['noOutputDir: ' + e.message])
    return { promise: promise, cancel: cancel }
  }
  const ext = path.extname(outputPath) || '.mov'
  // ASCII temp name (aerender's command line is ANSI); no leading "." - After Effects would turn it into "_"
  tempPath = path.join(outDir, '_mc-aerender-' + process.pid + '-' + started.toString(36) + Math.random().toString(36).slice(2, 6) + ext)

  // always asynchronous: the caller has the handle (and can cancel) before anything is spawned or reported
  setImmediate(function () {
    outputEncoding(function (label) {
      const items = [
        { value: opts.projectPath, file: true },
        { value: outDir, file: true },
        { value: comp, file: false }
      ].filter(function (it) {
        return !isAscii(it.value)
      })
      ansiArgs(items, function (ansi) {
        start(label, ansi)
      })
    })
  })
  return { promise: promise, cancel: cancel }
}

/**
 * Which of these comp names / paths aerender could not receive on its ANSI command line (neither as is nor as an 8.3
 * short path) - the same test render() makes, for a whole plan at once.
 *   opts: { projectPath, outputDir (an existing folder), comps: [names] }
 * Resolves (never rejects) { comps: [names], paths: [paths] }; both empty = every render can start.
 */
function checkArgs(opts) {
  opts = opts || {}
  const comps = (Array.isArray(opts.comps) ? opts.comps : []).map(String)
  const paths = [opts.projectPath, opts.outputDir ? path.resolve(String(opts.outputDir)) : ''].filter(Boolean).map(String)
  const items = paths
    .map(function (p) {
      return { value: p, file: true }
    })
    .concat(
      comps.map(function (c) {
        return { value: c, file: false }
      })
    )
    .filter(function (it) {
      return !isAscii(it.value)
    })
  return new Promise(function (resolve) {
    ansiArgs(items, function (ansi) {
      function bad(v) {
        return ansi.unsafe.indexOf(v) >= 0
      }
      resolve({ comps: comps.filter(bad), paths: paths.filter(bad) })
    })
  })
}

module.exports = {
  DEFAULT_RS_TEMPLATE,
  render,
  checkArgs,
  parseLine,
  decodeLine,
  encodingLabel
}

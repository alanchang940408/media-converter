'use strict'
// Node side of the panel <-> Media Converter folder bridge (contract: src/shared/bridge.ts).
// CommonJS + Node 8 compatible: Premiere Pro CC 2019 runs CEP 9 (Node 8.6) - no fs.promises, no mkdir {recursive}.
// Used by the panel (js/main.js, through CEP's require) and by scripts/test-ae.mjs (createRequire).

const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')

const BRIDGE_VERSION = 1

function userDataDir(env) {
  env = env || process.env
  if (env.MC_USER_DATA_DIR) return env.MC_USER_DATA_DIR
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Media Converter')
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Media Converter')
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Media Converter')
}

function bridgePaths(bridgeDir) {
  return {
    dir: bridgeDir,
    info: path.join(bridgeDir, 'info.json'),
    inbox: path.join(bridgeDir, 'inbox'),
    results: path.join(bridgeDir, 'results'),
    intermediates: path.join(bridgeDir, 'intermediates')
  }
}

function defaultBridgeDir(env) {
  return path.join(userDataDir(env), 'bridge')
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return
  mkdirp(path.dirname(dir))
  try {
    fs.mkdirSync(dir)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/** info.json, or null when Media Converter has never run (or wrote something unreadable). */
function readInfo(bridgeDir) {
  try {
    const info = readJson(bridgePaths(bridgeDir).info)
    if (!info || typeof info !== 'object' || !Array.isArray(info.presets)) return null
    return info
  } catch (e) {
    return null
  }
}

function pad(n, w) {
  let s = String(n)
  while (s.length < (w || 2)) s = '0' + s
  return s
}

/** File-name safe unique id, e.g. "ae-20261004-153012-k3f9". */
function newId(hostTag, now) {
  const d = now ? new Date(now) : new Date()
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  const rand = Math.random().toString(36).slice(2, 6)
  return (hostTag || 'panel') + '-' + stamp + '-' + rand
}

/** Folder the host renders into for one request: bridge/intermediates/<id>/ (created). */
function makeIntermediateDir(bridgeDir, id) {
  const dir = path.join(bridgePaths(bridgeDir).intermediates, id)
  mkdirp(dir)
  return dir
}

function buildRequest(opts) {
  return {
    bridgeVersion: BRIDGE_VERSION,
    id: opts.id,
    host: opts.host,
    files: opts.files.slice(),
    presetIds: opts.presetIds.slice(),
    outputDir: opts.outputDir || null,
    nameTemplate: opts.nameTemplate === undefined ? null : opts.nameTemplate,
    deleteAfter: opts.deleteAfter === undefined ? true : !!opts.deleteAfter,
    start: opts.start === undefined ? true : !!opts.start,
    createdAt: opts.createdAt || Date.now()
  }
}

/** Problems with a request object (empty array = well-formed per src/shared/bridge.ts BridgeRequest). */
function validateRequest(req) {
  const errs = []
  if (!req || typeof req !== 'object') return ['not an object']
  if (req.bridgeVersion !== BRIDGE_VERSION) errs.push('bridgeVersion must be ' + BRIDGE_VERSION)
  if (typeof req.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(req.id)) errs.push('id must be a file-name safe string')
  if (typeof req.host !== 'string') errs.push('host must be a string')
  if (!Array.isArray(req.files) || !req.files.length || req.files.some((f) => typeof f !== 'string' || !path.isAbsolute(f))) {
    errs.push('files must be a non-empty array of absolute paths')
  }
  if (!Array.isArray(req.presetIds) || !req.presetIds.length || req.presetIds.some((p) => typeof p !== 'string')) {
    errs.push('presetIds must be a non-empty array of strings')
  }
  if (!(req.outputDir === null || (typeof req.outputDir === 'string' && path.isAbsolute(req.outputDir)))) {
    errs.push('outputDir must be null or an absolute path')
  }
  if (!(req.nameTemplate === undefined || req.nameTemplate === null || typeof req.nameTemplate === 'string')) {
    errs.push('nameTemplate must be a string or null')
  }
  if (typeof req.deleteAfter !== 'boolean') errs.push('deleteAfter must be a boolean')
  if (typeof req.start !== 'boolean') errs.push('start must be a boolean')
  if (typeof req.createdAt !== 'number') errs.push('createdAt must be a number')
  return errs
}

/** Write inbox/<id>.json atomically (<id>.json.tmp, then rename). Returns the final path. */
function writeRequest(bridgeDir, req) {
  const inbox = bridgePaths(bridgeDir).inbox
  mkdirp(inbox)
  const finalPath = path.join(inbox, req.id + '.json')
  const tmpPath = finalPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(req, null, 2), 'utf8')
  try {
    fs.renameSync(tmpPath, finalPath)
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath)
    } catch (e2) {
      /* ignore */
    }
    throw e
  }
  return finalPath
}

/** results/<id>.json, or null while Media Converter has not answered yet. */
function readResult(bridgeDir, id) {
  const file = path.join(bridgePaths(bridgeDir).results, id + '.json')
  try {
    const r = readJson(file)
    return r && typeof r === 'object' && r.id === id ? r : null
  } catch (e) {
    return null
  }
}

function removeResult(bridgeDir, id) {
  try {
    fs.unlinkSync(path.join(bridgePaths(bridgeDir).results, id + '.json'))
  } catch (e) {
    /* ignore */
  }
}

/** Remove an intermediates/<id> folder (used when rendering failed before anything was sent). */
function removeDirIfInside(dir, parent) {
  const rel = path.relative(parent, dir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) removeDirIfInside(p, parent)
      else fs.unlinkSync(p)
    }
    fs.rmdirSync(dir)
  } catch (e) {
    /* ignore */
  }
}

/**
 * Remove empty bridge/intermediates/<id>/ folders that Media Converter emptied (deleteAfter deletes the file only).
 * Only folders that have been empty for minAgeMs (default 6 h) - a render that has not created its file yet (the other
 * host's panel may be rendering right now) is never touched. Junctions / symlinks are skipped. Returns the count.
 */
function pruneEmptyIntermediateDirs(bridgeDir, minAgeMs, now) {
  const root = bridgePaths(bridgeDir).intermediates
  const minAge = typeof minAgeMs === 'number' ? minAgeMs : 6 * 3600 * 1000
  const t = now || Date.now()
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch (e) {
    return 0
  }
  let removed = 0
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const st = fs.lstatSync(dir)
      if (!st.isDirectory() || t - st.mtime.getTime() < minAge) continue
      if (fs.readdirSync(dir).length) continue
      fs.rmdirSync(dir)
      removed++
    } catch (e) {
      /* ignore: in use, already gone, not empty */
    }
  }
  return removed
}

/** Calls back (err, running) - whether a process with the executable's file name is running. */
function isProcessRunning(exePath, cb) {
  const exe = path.basename(exePath)
  if (process.platform === 'win32') {
    childProcess.execFile('tasklist', ['/FI', 'IMAGENAME eq ' + exe, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return cb(err, false)
      cb(null, String(stdout).toLowerCase().indexOf('"' + exe.toLowerCase() + '"') >= 0)
    })
  } else {
    childProcess.execFile('ps', ['-A', '-o', 'comm='], (err, stdout) => {
      if (err) return cb(err, false)
      cb(null, String(stdout).split('\n').some((l) => path.basename(l.trim()) === exe))
    })
  }
}

/** Start Media Converter detached (it is single-instance, so a second launch only focuses the running one). */
function launchApp(exePath) {
  if (!exePath || !fs.existsSync(exePath)) throw new Error('exePath not found: ' + exePath)
  const appBundle = process.platform === 'darwin' ? /^(.*?\.app)\//.exec(exePath) : null
  const child = appBundle
    ? childProcess.spawn('open', ['-a', appBundle[1]], { detached: true, stdio: 'ignore' })
    : childProcess.spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false, cwd: path.dirname(exePath) })
  child.on('error', () => {})
  child.unref()
}

/** Launch Media Converter unless it is already running. cb(err, launched). */
function ensureAppRunning(exePath, cb) {
  isProcessRunning(exePath, (err, running) => {
    if (!err && running) return cb(null, false)
    try {
      launchApp(exePath)
      cb(null, true)
    } catch (e) {
      cb(e, false)
    }
  })
}

module.exports = {
  BRIDGE_VERSION,
  userDataDir,
  defaultBridgeDir,
  bridgePaths,
  mkdirp,
  readInfo,
  newId,
  makeIntermediateDir,
  buildRequest,
  validateRequest,
  writeRequest,
  readResult,
  removeResult,
  removeDirIfInside,
  pruneEmptyIntermediateDirs,
  isProcessRunning,
  launchApp,
  ensureAppRunning
}

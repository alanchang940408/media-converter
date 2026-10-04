// Media Converter panel UI. Runs in CEP 9+ (Chromium 61 / Node 8.6 in Premiere Pro CC 2019): ES2017, no frameworks,
// no optional chaining / nullish coalescing. Opened outside CEP (plain browser) it runs with mock data for UI work.
;(function (global) {
  'use strict'
  var MC = global.MC
  var t = MC.i18n.t
  function $(id) {
    return document.getElementById(id)
  }

  var LS = { presets: 'mc.presetIds', outMode: 'mc.outMode', customDir: 'mc.customDir', range: 'mc.range', epr: 'mc.eprPath' }
  function lsGet(k, def) {
    try {
      var v = global.localStorage.getItem(k)
      return v === null ? def : v
    } catch (e) {
      return def
    }
  }
  function lsSet(k, v) {
    try {
      global.localStorage.setItem(k, v)
    } catch (e) {
      /* ignore */
    }
  }

  var RESULT_TIMEOUT_MS = 120000
  var state = {
    mock: !MC.cep.available,
    node: null, // { fs, path, bridge }
    bridgeDir: '',
    info: null,
    infoStamp: '',
    hostCode: '', // 'PPRO' | 'AEFT'
    hostInfo: null,
    appDir: '',
    autoEpr: null, // { path, name } | null
    selected: [],
    busy: false
  }

  // ------------------------------------------------------------------ setup
  function loadNode() {
    var req = (global.cep_node && global.cep_node.require) || (typeof global.require === 'function' ? global.require : null)
    if (!req) return null
    try {
      var path = req('path')
      var ext = MC.cep.extensionPath()
      return { fs: req('fs'), path: path, bridge: req(path.join(ext, 'js', 'bridge-node.cjs')), process: global.process || req('process') }
    } catch (e) {
      console.error(e)
      return null
    }
  }

  function applyTheme() {
    var env = MC.cep.hostEnvironment()
    var skin = env && env.appSkinInfo
    var c = skin && skin.panelBackgroundColor && skin.panelBackgroundColor.color
    if (!c) return
    var r = Math.round(c.red), g = Math.round(c.green), b = Math.round(c.blue)
    var root = document.documentElement
    root.style.setProperty('--bg', 'rgb(' + r + ',' + g + ',' + b + ')')
    var light = (0.299 * r + 0.587 * g + 0.114 * b) > 140
    root.classList.toggle('light', light)
    if (skin.baseFontSize) root.style.setProperty('--fs', Math.max(10, Math.min(14, skin.baseFontSize)) + 'px')
  }

  function hostLabel() {
    return state.hostCode === 'AEFT' ? t('hostAEFT') : t('hostPPRO')
  }

  function chooseLocale() {
    var env = MC.cep.hostEnvironment()
    var loc = (state.info && MC.i18n.normalize(state.info.locale)) || (env && MC.i18n.normalize(env.appUILocale)) || MC.i18n.normalize(global.navigator.language)
    MC.i18n.setLocale(loc || 'en')
  }

  // ------------------------------------------------------------------ bridge info
  function readInfo() {
    if (state.mock) return mockInfo()
    if (!state.node) return null
    return state.node.bridge.readInfo(state.bridgeDir)
  }

  function infoStamp() {
    if (state.mock || !state.node) return 'mock'
    try {
      var st = state.node.fs.statSync(state.node.bridge.bridgePaths(state.bridgeDir).info)
      return st.mtime.getTime() + ':' + st.size
    } catch (e) {
      return ''
    }
  }

  function reloadInfo() {
    state.info = readInfo()
    state.infoStamp = infoStamp()
    chooseLocale()
    var ids = videoPresets().map(function (p) {
      return p.id
    })
    var stored = []
    try {
      stored = JSON.parse(lsGet(LS.presets, '[]')) || []
    } catch (e) {
      stored = []
    }
    state.selected = stored.filter(function (id) {
      return ids.indexOf(id) >= 0
    })
    if (!state.selected.length && state.info && ids.indexOf(state.info.lastVideoPresetId) >= 0) state.selected = [state.info.lastVideoPresetId]
    renderAll()
  }

  function videoPresets() {
    return state.info && state.info.presets
      ? state.info.presets.filter(function (p) {
          return p && p.kind === 'video'
        })
      : []
  }

  // ------------------------------------------------------------------ host
  function ensureHostScript() {
    // ScriptPath normally loads host.jsx; re-evaluate it if MCHost is missing (e.g. after an ExtendScript engine reset).
    return MC.cep.evalScript('typeof MCHost').then(function (r) {
      if (r === 'object') return
      var file = state.node ? state.node.path.join(MC.cep.extensionPath(), 'jsx', 'host.jsx') : ''
      return MC.cep.evalScript('$.evalFile(' + MC.cep.scriptString(file.replace(/\\/g, '/')) + ')')
    })
  }

  function refreshHost() {
    if (state.mock) {
      state.hostInfo = mockHostInfo()
      renderSource()
      renderOutput()
      return Promise.resolve(state.hostInfo)
    }
    return ensureHostScript()
      .then(function () {
        return MC.cep.callHost('info')
      })
      .then(function (r) {
        state.hostInfo = r && r.ok ? r : { ok: false, items: [], projectPath: '', message: r && r.message }
        renderSource()
        renderOutput()
        return state.hostInfo
      })
  }

  function findAutoEpr() {
    if (state.hostCode !== 'PPRO') return Promise.resolve()
    if (state.mock) {
      state.autoEpr = { path: 'C:/Program Files/Adobe/.../Apple ProRes 422 HQ.epr', name: 'Apple ProRes 422 HQ' }
      renderSource()
      return Promise.resolve()
    }
    return MC.cep.callHost('findPreset', { appDir: state.appDir }).then(function (r) {
      state.autoEpr = r && r.ok ? { path: r.path, name: r.name } : null
      renderSource()
    })
  }

  // ------------------------------------------------------------------ rendering (DOM)
  function text(el, s) {
    el.textContent = s
    return el
  }
  function el(tag, cls, s) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (s !== undefined) e.textContent = s
    return e
  }

  function renderStatic() {
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'))
    var titled = document.querySelectorAll('[data-i18n-title]')
    for (var j = 0; j < titled.length; j++) titled[j].title = t(titled[j].getAttribute('data-i18n-title'))
    text($('hostBadge'), state.hostCode ? hostLabel() : '')
    text($('goBtn'), state.busy ? t('working') : t('go'))
    $('rangeSel').value = lsGet(LS.range, 'entire') === 'inout' ? 'inout' : 'entire'
  }

  function renderAll() {
    renderStatic()
    var hasInfo = !!state.info
    $('noInfo').hidden = hasInfo
    $('main').hidden = !hasInfo
    if (!hasInfo) {
      text($('noInfoText'), state.node || state.mock ? t('noInfo') : t('noNode'))
      text($('noInfoHint'), state.node ? t('noInfoHint', { path: state.node.bridge.bridgePaths(state.bridgeDir).info }) : '')
      return
    }
    renderSource()
    renderPresets()
    renderOutput()
  }

  function renderSource() {
    var box = $('sourceText')
    box.textContent = ''
    var hi = state.hostInfo
    var isAE = state.hostCode === 'AEFT'
    if (hi && hi.items && hi.items.length) {
      box.appendChild(el('div', 'muted', isAE ? t('sourceComps') : t('sourceSeq')))
      box.appendChild(el('div', 'strong', hi.items.join(', ')))
      box.classList.remove('warn')
    } else {
      box.appendChild(el('div', null, isAE ? t('noComps') : t('noSequence')))
      box.classList.add('warn')
    }
    $('rangeRow').hidden = isAE
    $('eprRow').hidden = isAE
    if (!isAE) {
      var custom = lsGet(LS.epr, '')
      var label
      if (custom) label = t('eprCustom', { name: baseName(custom).replace(/\.epr$/i, '') })
      else if (state.autoEpr) label = t('eprAuto', { name: state.autoEpr.name })
      else label = t('eprNone')
      text($('eprName'), label)
      $('eprName').title = custom || (state.autoEpr ? state.autoEpr.path : '')
      $('eprReset').hidden = !custom
    }
  }

  function renderPresets() {
    var list = $('presetList')
    list.textContent = ''
    var presets = videoPresets()
    if (!presets.length) {
      list.appendChild(el('div', 'empty', t('noPresets')))
    }
    var lastCat = null
    presets.forEach(function (p) {
      if (p.category !== lastCat) {
        lastCat = p.category
        var key = 'category.' + p.category
        var label = t(key)
        list.appendChild(el('div', 'cat', label === key ? p.category : label))
      }
      var row = el('label', 'preset')
      var cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = state.selected.indexOf(p.id) >= 0
      cb.addEventListener('change', function () {
        var i = state.selected.indexOf(p.id)
        if (cb.checked && i < 0) state.selected.push(p.id)
        if (!cb.checked && i >= 0) state.selected.splice(i, 1)
        lsSet(LS.presets, JSON.stringify(state.selected))
        renderCount()
      })
      var body = el('span', 'preset-body')
      body.appendChild(el('span', 'preset-name', presetName(p)))
      if (p.summary) body.appendChild(el('span', 'preset-summary', p.summary))
      row.appendChild(cb)
      row.appendChild(body)
      list.appendChild(row)
    })
    renderCount()
  }

  function presetName(p) {
    var loc = MC.i18n.locale()
    return (p.names && p.names[loc]) || p.name || p.id
  }

  function renderCount() {
    text($('presetCount'), t('selectedCount', { n: state.selected.length }))
  }

  function outMode() {
    var m = lsGet(LS.outMode, 'project')
    return m === 'app' || m === 'custom' ? m : 'project'
  }

  function resolveOutDir() {
    var m = outMode()
    if (m === 'custom') return lsGet(LS.customDir, '')
    if (m === 'app') return (state.info && state.info.defaultOutputDir) || ''
    var proj = state.hostInfo && state.hostInfo.projectPath
    return proj ? dirName(proj) : ''
  }

  function renderOutput() {
    var sel = $('outMode')
    sel.value = outMode()
    var dir = resolveOutDir()
    var p = $('outPath')
    var m = outMode()
    if (dir) {
      text(p, dir)
      p.classList.remove('warn')
    } else {
      text(p, m === 'project' ? t('projectUnsaved') : m === 'app' ? t('appNoDefault') : t('notChosen'))
      p.classList.add('warn')
    }
    p.title = dir
  }

  function setBusy(b) {
    state.busy = b
    $('goBtn').disabled = b
    $('refreshBtn').disabled = b
    text($('goBtn'), b ? t('working') : t('go'))
  }

  function log(msg, level) {
    var box = $('log')
    var d = new Date()
    var line = el('div', 'log-line' + (level ? ' ' + level : ''))
    line.appendChild(el('span', 'log-time', pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())))
    line.appendChild(el('span', 'log-msg', msg))
    box.appendChild(line)
    while (box.childNodes.length > 200) box.removeChild(box.firstChild)
    box.scrollTop = box.scrollHeight
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n)
  }
  function baseName(p) {
    return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  }
  function dirName(p) {
    var s = String(p).replace(/[\\/]+$/, '')
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i > 0 ? s.slice(0, i) : s
  }

  function describeRenderError(r) {
    if (r.error === 'busy') return t('busy')
    if (r.error === 'noSequence') return t('noSequence')
    if (r.error === 'noComps') return t('noComps')
    var parts = (r.errors && r.errors.length ? r.errors : [r.error || 'unknown']).slice()
    if (r.message && parts.join(' ').indexOf(r.message) < 0) parts.push(r.message)
    return parts.join('; ')
  }

  // ------------------------------------------------------------------ actions
  function waitResult(id, timeoutMs) {
    var start = Date.now()
    return new Promise(function (resolve) {
      ;(function tick() {
        var r = state.node.bridge.readResult(state.bridgeDir, id)
        if (r) return resolve(r)
        if (Date.now() - start > timeoutMs) return resolve(null)
        setTimeout(tick, 500)
      })()
    })
  }

  function ensureApp() {
    return new Promise(function (resolve) {
      var exe = state.info && state.info.exePath
      if (!exe) return resolve()
      state.node.bridge.ensureAppRunning(exe, function (err, launched) {
        if (err) log(t('logLaunchFailed', { msg: err.message || String(err) }), 'error')
        else if (launched) log(t('logLaunching'))
        resolve()
      })
    })
  }

  function go() {
    if (state.busy) return
    var presetIds = state.selected.filter(function (id) {
      return videoPresets().some(function (p) {
        return p.id === id
      })
    })
    if (!presetIds.length) return log(t('errNoPresetSel'), 'error')
    var outDir = resolveOutDir()
    if (!outDir) return log(t('errNoOutDir'), 'error')
    setBusy(true)
    run(presetIds, outDir)
      .catch(function (e) {
        log(t('logError', { msg: (e && e.message) || String(e) }), 'error')
      })
      .then(function () {
        setBusy(false)
      })
  }

  async function run(presetIds, outDir) {
    var hi = await refreshHost()
    if (!hi || !hi.items || !hi.items.length) {
      log(state.hostCode === 'AEFT' ? t('noComps') : t('noSequence'), 'error')
      return
    }
    if (state.mock) return mockRun(presetIds, outDir)

    var bridge = state.node.bridge
    var isAE = state.hostCode === 'AEFT'
    var id = bridge.newId(isAE ? 'ae' : 'ppro')
    var interRoot = bridge.bridgePaths(state.bridgeDir).intermediates
    var interDir = bridge.makeIntermediateDir(state.bridgeDir, id)

    log(t('logRendering', { host: hostLabel(), items: hi.items.join(', ') }))
    var args = { outDir: interDir, range: lsGet(LS.range, 'entire'), appDir: state.appDir, eprPath: '' }
    if (!isAE) args.eprPath = lsGet(LS.epr, '') || (state.autoEpr ? state.autoEpr.path : '')
    var r = await MC.cep.callHost('render', args)
    var files = (r && r.files) || []
    if (!files.length) {
      bridge.removeDirIfInside(interDir, interRoot)
      if (r && r.error === 'noPreset') log(t('logNoPreset'), 'error')
      else log(t('logRenderFailed', { msg: describeRenderError(r || {}) }), 'error')
      return
    }
    files.forEach(function (f) {
      log(t('logRendered', { file: baseName(f) }), 'ok')
    })
    if (r.errors && r.errors.length) log(t('logWarn', { msg: r.errors.join('; ') }), 'warn')

    var req = bridge.buildRequest({
      id: id,
      host: isAE ? 'aftereffects' : 'premiere',
      files: files,
      presetIds: presetIds,
      outputDir: outDir,
      deleteAfter: true,
      start: true
    })
    bridge.writeRequest(state.bridgeDir, req)
    log(t('logSent', { files: files.length, presets: presetIds.length }))

    await ensureApp()
    log(t('logWaiting'))
    var res = await waitResult(id, RESULT_TIMEOUT_MS)
    if (!res) {
      log(t('logTimeout'), 'warn')
      return
    }
    if (res.status === 'accepted') {
      log(t('logAccepted', { n: (res.jobIds || []).length }), 'ok')
      if (res.errors && res.errors.length) log(t('logWarn', { msg: res.errors.join('; ') }), 'warn')
    } else {
      log(t('logRejected', { msg: (res.errors || []).join('; ') || res.status }), 'error')
    }
    bridge.removeResult(state.bridgeDir, id)
  }

  function chooseOutFolder() {
    var initial = resolveOutDir() || lsGet(LS.customDir, '')
    MC.cep.chooseFolder(t('chooseFolderTitle'), initial).then(function (p) {
      if (!p) return
      lsSet(LS.customDir, p)
      lsSet(LS.outMode, 'custom')
      renderOutput()
    })
  }

  function chooseEpr() {
    var initial = state.autoEpr ? dirName(state.autoEpr.path) : ''
    MC.cep.chooseFile(t('chooseEprTitle'), initial, ['epr']).then(function (p) {
      if (!p) return
      lsSet(LS.epr, p)
      renderSource()
    })
  }

  // ------------------------------------------------------------------ mock (plain browser, UI work only)
  function mockInfo() {
    return {
      bridgeVersion: 1,
      appVersion: '0.0.0-mock',
      exePath: '',
      locale: MC.i18n.normalize(global.navigator.language) || 'zh-TW',
      updatedAt: Date.now(),
      lastVideoPresetId: 'h264-1080p',
      defaultOutputDir: null,
      presets: [
        { id: 'h264-match', kind: 'video', name: 'H.264 (match source)', category: 'web', builtIn: true, summary: 'MP4 · H.264 · source size' },
        { id: 'h264-1080p', kind: 'video', name: 'H.264 1080p', category: 'web', builtIn: true, summary: 'MP4 · H.264 · 1920×1080' },
        { id: 'h264-720p', kind: 'video', name: 'H.264 720p', category: 'web', builtIn: true, summary: 'MP4 · H.264 · 1280×720' },
        { id: 'ig-reels', kind: 'video', name: 'Instagram Reels', category: 'social', builtIn: true, summary: 'MP4 · H.264 · 1080×1920' },
        { id: 'prores-hq', kind: 'video', name: 'ProRes 422 HQ', category: 'editing', builtIn: true, summary: 'MOV · ProRes 422 HQ' },
        { id: 'user-1', kind: 'video', name: 'My delivery preset with a fairly long name', category: 'custom', builtIn: false, summary: 'MP4 · HEVC · 3840×2160' }
      ]
    }
  }
  function mockHostInfo() {
    return { ok: true, host: 'premiere', hostVersion: 'mock', projectPath: 'C:/Projects/Demo/demo.prproj', items: ['Sequence 01'] }
  }
  function mockRun(presetIds, outDir) {
    log(t('logRendering', { host: hostLabel(), items: state.hostInfo.items.join(', ') }))
    return new Promise(function (resolve) {
      setTimeout(function () {
        log(t('logRendered', { file: 'Sequence 01.mov' }), 'ok')
        log(t('logSent', { files: 1, presets: presetIds.length }))
        log(t('logWaiting'))
        log(t('logAccepted', { n: presetIds.length }), 'ok')
        resolve()
      }, 600)
    })
  }

  // ------------------------------------------------------------------ init
  function init() {
    var env = MC.cep.hostEnvironment()
    state.hostCode = env && env.appName ? env.appName : state.mock ? 'PPRO' : ''
    applyTheme()
    MC.cep.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme)

    if (!state.mock) {
      state.node = loadNode()
      if (state.node) {
        state.bridgeDir = state.node.bridge.defaultBridgeDir()
        state.node.bridge.pruneEmptyIntermediateDirs(state.bridgeDir)
        // Premiere Pro: <install>/CEPHtmlEngine/CEPHtmlEngine.exe -> <install> (where MediaIO/systempresets lives)
        try {
          var exec = state.node.process.execPath || ''
          state.appDir = state.node.path.dirname(state.node.path.dirname(exec))
        } catch (e) {
          state.appDir = ''
        }
      }
    }

    $('retryBtn').addEventListener('click', function () {
      reloadInfo()
      refreshHost()
    })
    $('refreshBtn').addEventListener('click', function () {
      refreshHost()
    })
    $('rangeSel').addEventListener('change', function () {
      lsSet(LS.range, $('rangeSel').value)
    })
    $('eprBtn').addEventListener('click', chooseEpr)
    $('eprReset').addEventListener('click', function () {
      lsSet(LS.epr, '')
      renderSource()
    })
    $('outMode').addEventListener('change', function () {
      var m = $('outMode').value
      lsSet(LS.outMode, m)
      if (m === 'custom' && !lsGet(LS.customDir, '')) chooseOutFolder()
      renderOutput()
    })
    $('browseBtn').addEventListener('click', chooseOutFolder)
    $('goBtn').addEventListener('click', go)
    global.addEventListener('focus', function () {
      if (!state.busy) refreshHost()
    })

    reloadInfo()
    refreshHost().then(findAutoEpr)

    // pick up preset / language changes made in Media Converter
    setInterval(function () {
      if (state.busy) return
      var s = infoStamp()
      if (s !== state.infoStamp) reloadInfo()
    }, 3000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})(window)

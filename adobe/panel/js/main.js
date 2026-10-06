// Media Converter panel UI. Runs in CEP 9+ (Chromium 61 / Node 8.6 in Premiere Pro CC 2019): ES2017, no frameworks,
// no optional chaining / nullish coalescing (adobe/tests/panel-compat.test.cjs checks). Opened outside CEP (plain browser)
// it runs with mock data for UI work:
//   index.html                 Premiere Pro               index.html?host=AEFT     After Effects (background render)
//   &items=Comp 1|Comp 2       several source items       &items=                  no source item
//   &unsaved=1                 project never saved        &lang=en | ja | zh-TW    UI language
//
// One export: the user picks Media Converter presets (output rows). Every preset the host can produce natively is
// written by the host itself, straight into the output folder, with settings mapped from the preset's
// VideoPresetSettings - no intermediate, Media Converter is not involved:
//   Premiere Pro   js/ppro-epr.cjs classify() + writeEpr() patch one of Premiere's own system presets into a temporary
//                  .epr; MCHost.exportDirect runs sequence.exportAsMediaDirect with it (Premiere shows its own progress).
//   After Effects  js/ae-om.cjs classify() + omSpec(); MCHost.planBackground creates an output module template per spec
//                  (and saves the project); js/aerender.cjs renders each comp x output in the background.
// Only rows the host cannot produce faithfully (classify -> direct: false, a preset without settings from an older app,
// a missing module) use two steps: the host renders a ProRes master into bridge/intermediates/<id>/ and Media Converter
// converts it. Each row says which of the two it gets before the user starts.
//
// File names of direct rows are final names: "<name><ext>" in the output folder, written to "<name>.mcpart<ext>" first
// and renamed on success; an existing file is never replaced (" (1)", " (2)"… like Media Converter). A custom name may use
// Media Converter's tokens: {name} {preset} {date} {time} {mdate} {exifdate} {exiftime} {counter} {counter:N} are rendered
// here the way Media Converter renders them for a freshly rendered master; {width} {height} {ext} {parent} describe a
// real source file, so a row whose custom name uses one of them is converted by Media Converter (two steps).
;(function (global) {
  'use strict'
  var MC = global.MC
  var t = MC.i18n.t
  function $(id) {
    return document.getElementById(id)
  }

  var LS = {
    outputs: 'mc.outputs', // JSON array of preset ids, one per output row
    legacyPresets: 'mc.presetIds', // panel 0.1 checkbox selection, migrated into mc.outputs on first run
    outMode: 'mc.outMode',
    customDir: 'mc.customDir',
    range: 'mc.range'
  }
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
  var RS_TEMPLATE = 'Best Settings'
  // temporary name of a direct output until it is complete (Media Converter uses the same suffix)
  var TEMP_SUFFIX = '.mcpart'
  // characters Windows does not allow in file names (the app would silently replace them with "_")
  var BAD_NAME_CHARS = /[\\\/:*?"<>|]/
  // the app's name tokens ({name}, {date}, {counter:3}…) - ignored by the character check
  var TOKEN_RE = /\{\w+(?::\d+)?\}/g
  // tokens whose value only Media Converter knows (the converted file's size, the source file's extension / folder)
  var SOURCE_TOKEN_RE = /\{(width|height|ext|parent)(?::\d+)?\}/

  var state = {
    mock: !MC.cep.available,
    node: null, // { fs, path, os, process, bridge, aerender, pproEpr, aeOm }
    bridgeDir: '',
    info: null,
    infoStamp: '',
    hostCode: '', // 'PPRO' | 'AEFT'
    hostInfo: null,
    hostCaps: { exportDirect: true }, // what the loaded host script can do (checked in refreshHost)
    appDir: '',
    rows: [], // output rows: { presetId, custom, name, dom }
    rowsLoaded: false,
    classified: {}, // preset id -> { direct, ext, reason } for the current host and info.json
    sourceKey: '', // host + source item names; custom file names are kept only while it stays the same
    outputsValid: false,
    busy: false,
    cancelRequested: false,
    cancelFn: null,
    interDir: '', // bridge/intermediates/<id>/ while After Effects renders into it (removed if the panel closes)
    directDir: '', // output folder while aerender writes a direct output into it (its temp file is removed then)
    currentTemp: '', // "<name>.mcpart<ext>" being written right now
    progressPct: 0
  }

  // ------------------------------------------------------------------ setup
  function loadNode() {
    var req = (global.cep_node && global.cep_node.require) || (typeof global.require === 'function' ? global.require : null)
    if (!req) return null
    try {
      var path = req('path')
      var ext = MC.cep.extensionPath()
      var node = {
        fs: req('fs'),
        path: path,
        os: req('os'),
        bridge: req(path.join(ext, 'js', 'bridge-node.cjs')),
        process: global.process || req('process'),
        aerender: null,
        pproEpr: null,
        aeOm: null
      }
      // host specific modules: a broken or missing one only turns its rows into two-step rows
      function optional(file) {
        try {
          return req(path.join(ext, 'js', file))
        } catch (e) {
          console.error(e)
          return null
        }
      }
      node.aerender = optional('aerender.cjs')
      node.pproEpr = optional('ppro-epr.cjs')
      node.aeOm = optional('ae-om.cjs')
      return node
    } catch (e) {
      console.error(e)
      return null
    }
  }

  var THEME_VARS = ['--sel-bg', '--sel-bg-hover', '--sel-border', '--sel-border-hover', '--opt-bg', '--input-bg']

  function shade(r, g, b, d) {
    function c(v) {
      return Math.max(0, Math.min(255, Math.round(v + d)))
    }
    return 'rgb(' + c(r) + ',' + c(g) + ',' + c(b) + ')'
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
    if (light) {
      // fixed white-ish fields from panel.css
      THEME_VARS.forEach(function (v) {
        root.style.removeProperty(v)
      })
    } else {
      // dark skins differ (Premiere's brightness slider): keep dropdowns clearly lighter than the panel itself
      root.style.setProperty('--sel-bg', shade(r, g, b, 26))
      root.style.setProperty('--sel-bg-hover', shade(r, g, b, 38))
      root.style.setProperty('--sel-border', shade(r, g, b, 60))
      root.style.setProperty('--sel-border-hover', shade(r, g, b, 84))
      root.style.setProperty('--opt-bg', shade(r, g, b, 20))
      root.style.setProperty('--input-bg', shade(r, g, b, -12))
    }
    if (skin.baseFontSize) root.style.setProperty('--fs', Math.max(10, Math.min(14, skin.baseFontSize)) + 'px')
  }

  function isAE() {
    return state.hostCode === 'AEFT'
  }

  function hostLabel() {
    return isAE() ? t('hostAEFT') : t('hostPPRO')
  }

  function chooseLocale() {
    var env = MC.cep.hostEnvironment()
    var loc = (state.info && MC.i18n.normalize(state.info.locale)) || (env && MC.i18n.normalize(env.appUILocale)) || MC.i18n.normalize(global.navigator.language)
    MC.i18n.setLocale(loc || 'en')
  }

  function queryParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search || '')
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null
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
    state.classified = {}
    chooseLocale()
    syncRows()
    renderAll()
  }

  function videoPresets() {
    return state.info && state.info.presets
      ? state.info.presets.filter(function (p) {
          return p && p.kind === 'video'
        })
      : []
  }

  function presetById(id) {
    var list = videoPresets()
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  function presetName(p) {
    var loc = MC.i18n.locale()
    return (p.names && p.names[loc]) || p.name || p.id
  }

  /** Extension without the dot, lower case ('' when unknown). */
  function extNoDot(ext) {
    return typeof ext === 'string' ? ext.replace(/^\./, '').toLowerCase() : ''
  }

  /** Output extension Media Converter writes for the preset ('' when info.json comes from an app that does not say). */
  function presetExt(p) {
    return p ? extNoDot(p.ext) : ''
  }

  function categoryLabel(cat) {
    var key = 'category.' + cat
    var label = t(key)
    return label === key ? cat || '-' : label
  }

  // ------------------------------------------------------------------ one export or two steps (per host and preset)
  /** The host's format module: ppro-epr.cjs (Premiere Pro) or ae-om.cjs (After Effects); mock rules in a browser. */
  function formatModule() {
    if (state.mock) return mockFormats
    if (!state.node) return null
    return isAE() ? state.node.aeOm : state.node.pproEpr
  }

  function tempRoot() {
    var node = state.node
    return node.path.join(node.os.tmpdir(), 'MediaConverterPanel')
  }

  function presetsDir() {
    return state.appDir ? state.node.path.join(state.appDir, 'MediaIO', 'systempresets') : ''
  }

  /**
   * Premiere Pro: patch the preset into a throwaway .epr once, so a row only says "one export" when this Premiere
   * really has the system preset the .epr is made from. -> { ok, ext } | { ok: false, reason }
   */
  function probeEpr(mod, settings) {
    if (typeof mod.writeEpr !== 'function') return { ok: false, reason: 'noModule' }
    if (!presetsDir()) return { ok: false, reason: 'hostPreset' }
    var node = state.node
    var dir = node.path.join(tempRoot(), 'probe-' + node.process.pid)
    var file = node.path.join(dir, 'probe.epr')
    var r = null
    try {
      node.bridge.mkdirp(dir)
      r = mod.writeEpr(settings, { presetsDir: presetsDir(), outFile: file })
      // an asynchronous writeEpr is checked when the export runs
      if (r && typeof r.then === 'function') return { ok: true, ext: '' }
      return r && r.ok ? { ok: true, ext: r.ext } : { ok: false, reason: (r && r.reason) || 'hostPreset' }
    } catch (e) {
      console.error(e)
      return { ok: false, reason: 'hostPreset' }
    } finally {
      removeFileSync(file)
      if (r && typeof r.path === 'string' && r.path !== file) removeFileSync(r.path)
      try {
        node.fs.rmdirSync(dir)
      } catch (e2) {
        /* not empty / gone */
      }
    }
  }

  function classifyUncached(p) {
    var fallbackExt = presetExt(p)
    function twoStep(reason) {
      return { direct: false, ext: fallbackExt, reason: reason }
    }
    if (!p.settings || typeof p.settings !== 'object') return twoStep('noSettings')
    var mod = formatModule()
    if (!mod || typeof mod.classify !== 'function') return twoStep('noModule')
    if (!isAE() && !state.hostCaps.exportDirect) return twoStep('hostScript')
    if (isAE() && typeof mod.omSpec !== 'function') return twoStep('noModule')
    var c = null
    try {
      c = mod.classify(p.settings)
    } catch (e) {
      console.error(e)
      return twoStep('classifyFailed')
    }
    if (!c || c.direct !== true) return twoStep((c && c.reason) || 'unsupported')
    var ext = extNoDot(c.ext) || fallbackExt
    if (!isAE() && !state.mock) {
      var probe = probeEpr(mod, p.settings)
      if (!probe.ok) return twoStep(probe.reason)
      if (probe.ext) ext = extNoDot(probe.ext)
    }
    return { direct: true, ext: ext, reason: '' }
  }

  /** { direct, ext (no dot), reason } of a preset for the current host (cached until info.json / the host changes). */
  function classifyPreset(p) {
    if (!p) return { direct: false, ext: '', reason: 'unknownPreset' }
    var key = 'p:' + p.id
    if (!state.classified[key]) state.classified[key] = classifyUncached(p)
    return state.classified[key]
  }

  /** A row's mode: the preset's, except that a custom name using a source-only token needs Media Converter. */
  function classifyRow(row, p, single) {
    var c = classifyPreset(p)
    if (c.direct && single && row.custom) {
      var m = SOURCE_TOKEN_RE.exec(row.name)
      if (m) return { direct: false, ext: presetExt(p), reason: 'nameToken', token: m[0] }
    }
    return c
  }

  var CONTAINER_LABELS = { mp4: 'MP4', mov: 'QuickTime (MOV)', mkv: 'MKV', webm: 'WebM', gif: 'GIF', mpg: 'MPEG (MPG)', wmv: 'WMV', avi: 'AVI', mp3: 'MP3', m4a: 'M4A', wav: 'WAV', flac: 'FLAC', ogg: 'Ogg' }
  var VIDEO_CODEC_LABELS = { h264: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', prores: 'ProRes', dnxhr: 'DNxHR', mpeg2: 'MPEG-2', mpeg1: 'MPEG-1', mpeg4: 'MPEG-4 (Xvid)', wmv2: 'WMV', mjpeg: 'Motion JPEG', gif: 'GIF' }
  var AUDIO_CODEC_LABELS = { aac: 'AAC', mp3: 'MP3', opus: 'Opus', pcm: 'PCM', flac: 'FLAC', mp2: 'MPEG Layer II', ac3: 'Dolby Digital (AC-3)', wmav2: 'WMA' }
  var PROFILE_LABELS = { proxy: 'Proxy', lt: 'LT', standard: '422', hq: 'HQ', hqx: 'HQX', '4444': '4444', '4444xq': '4444 XQ', lb: 'LB', sq: 'SQ', '444': '444', baseline: 'Baseline', main: 'Main', high: 'High', 'dvd-ntsc': 'DVD NTSC', 'dvd-pal': 'DVD PAL' }
  var SCALE_KEYS = { fit: 'scaleFit', pad: 'scalePad', crop: 'scaleCrop', stretch: 'scaleStretch' }

  // reason code (from ppro-epr.cjs / ae-om.cjs or the panel) -> text; matched loosely so "audioCodec", "audio-codec:opus"
  // or "opus" all read the same. Order matters ("noUpscale" before "scale", "sampleRate" before "rate").
  var REASON_RULES = [
    [/nosettings|oldapp|legacy/i, 'reasonNoSettings'],
    [/hostscript|exportdirect/i, 'reasonHostScript'],
    [/nomodule|classifyfailed/i, 'reasonNoModule'],
    [/nametoken/i, 'reasonNameToken'],
    [/watermark|overlay/i, 'reasonWatermark'],
    [/normali[sz]|loudness|loudnorm/i, 'reasonNormalize'],
    [/metadata/i, 'reasonMetadata'],
    [/copy|remux|rewrap/i, 'reasonCopy'],
    [/audio.?only|novideo|video.?none/i, 'reasonAudioOnly'],
    [/sample.?rate|samplerate|\bhz\b/i, 'reasonSampleRate'],
    [/channel|mono|stereo/i, 'reasonChannels'],
    [/audio.?(bit)?rate|abitrate|audio.?kbps/i, 'reasonAudioBitrate'],
    [/audio.?codec|acodec|^(opus|flac|mp2|ac3|wmav2|pcm|mp3|aac)$/i, 'reasonAudioCodec'],
    [/audio/i, 'reasonAudio'],
    [/ten.?bit|10.?bit|bit.?depth|pix.?fmt|pixel.?format/i, 'reasonTenBit'],
    [/container|muxer|^(webm|mkv|avi|mpg|wmv|gif|m4a|wav|ogg)$|format/i, 'reasonContainer'],
    [/profile/i, 'reasonProfile'],
    [/upscale/i, 'reasonNoUpscale'],
    [/scale|crop|pad|stretch|letterbox/i, 'reasonScaleMode'],
    [/fps|frame.?rate/i, 'reasonFps'],
    [/size|width|height|resolution|dimension|odd/i, 'reasonSize'],
    [/video.?codec|vcodec|codec|^(vp9|av1|hevc|h265|mpeg[124]|xvid|wmv2|mjpeg|dnxhr|prores)$/i, 'reasonVideoCodec'],
    [/rate|bitrate|crf|quality|cbr|vbr|kbps/i, 'reasonRate'],
    [/hostpreset|epr|system.?preset|base.?preset|template|preset|omspec/i, 'reasonHostPreset']
  ]

  /** Why a row needs two steps, in words (host + the preset's own values). */
  function reasonText(c, p) {
    var s = (p && p.settings) || {}
    var v = s.video || {}
    var a = s.audio || {}
    var code = String(c.reason || '')
    var key = 'reasonGeneric'
    for (var i = 0; i < REASON_RULES.length; i++) {
      if (REASON_RULES[i][0].test(code)) {
        key = REASON_RULES[i][1]
        break
      }
    }
    var size = v.width && v.height ? v.width + '×' + v.height : v.width ? v.width + ' px' : v.height ? v.height + ' px' : ''
    var vars = {
      host: hostLabel(),
      format: CONTAINER_LABELS[s.container] || String(s.container || '?').toUpperCase(),
      vcodec: VIDEO_CODEC_LABELS[v.codec] || String(v.codec || '?'),
      acodec: AUDIO_CODEC_LABELS[a.codec] || String(a.codec || '?'),
      mode: SCALE_KEYS[v.scaleMode] ? t(SCALE_KEYS[v.scaleMode]) : String(v.scaleMode || '?'),
      size: size || '?',
      fps: v.fps ? v.fps + ' fps' : '?',
      profile: PROFILE_LABELS[v.profile] || String(v.profile || '?'),
      token: c.token || '{…}'
    }
    return t(key, vars)
  }

  // ------------------------------------------------------------------ output rows (state)
  function newRow(presetId) {
    return { presetId: presetId, custom: false, name: '', dom: null }
  }

  function parseIdList(raw) {
    try {
      var v = JSON.parse(raw)
      return Array.isArray(v)
        ? v.filter(function (s) {
            return typeof s === 'string' && s !== ''
          })
        : []
    } catch (e) {
      return []
    }
  }

  function loadStoredRows() {
    var raw = lsGet(LS.outputs, null)
    var ids = raw === null ? parseIdList(lsGet(LS.legacyPresets, null)) : parseIdList(raw)
    return ids.map(newRow)
  }

  function saveRows() {
    lsSet(
      LS.outputs,
      JSON.stringify(
        state.rows.map(function (r) {
          return r.presetId
        })
      )
    )
  }

  function defaultPresetId() {
    var list = videoPresets()
    if (!list.length) return ''
    var last = state.info && state.info.lastVideoPresetId
    return presetById(last) ? last : list[0].id
  }

  /** Rows follow info.json: unknown presets are dropped; no valid row left -> one row with the app's last video preset. */
  function syncRows() {
    if (!state.info) return
    var list = videoPresets()
    if (!list.length) {
      // nothing to choose from: keep the stored rows for when presets come back
      state.rows = []
      state.rowsLoaded = false
      return
    }
    if (!state.rowsLoaded) {
      state.rows = loadStoredRows()
      state.rowsLoaded = true
    }
    state.rows = state.rows.filter(function (r) {
      return !!presetById(r.presetId)
    })
    if (!state.rows.length) state.rows = [newRow(defaultPresetId())]
    saveRows()
  }

  function sourceItems() {
    return (state.hostInfo && state.hostInfo.items) || []
  }

  function sourceKey() {
    return state.hostCode + '\n' + sourceItems().join('\n')
  }

  // File-system safe base name - the same rules as safeName in jsx/host.jsx, which names the intermediate (and the app's
  // {name} token is the intermediate's base name). Keep both in sync.
  function safeName(name) {
    var s = String(name || '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_')
    s = s.replace(/^\s+|[\s.]+$/g, '')
    if (s.length > 120) s = s.substring(0, 120)
    if (s === '' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = '_' + s
    return s
  }

  // Media Converter's sanitizeFileName (src/shared/naming.ts) - a rendered name gets exactly the app's treatment.
  function sanitizeFileName(s) {
    var out = String(s).replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').replace(/^\s+|\s+$/g, '')
    if (!out) out = 'output'
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(out)) out = '_' + out
    if (out.length > 180) out = out.slice(0, 180)
    return out
  }

  /**
   * A name template rendered like Media Converter's renderNameTemplate for a freshly rendered master: vars = { name,
   * preset, counter, now }. {width} {height} {ext} {parent} never reach this (those rows use two steps).
   */
  function renderName(template, vars) {
    var d = vars.now
    function ymd(x) {
      return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate())
    }
    function hms(x) {
      return pad(x.getHours()) + pad(x.getMinutes()) + pad(x.getSeconds())
    }
    var tpl = template && String(template).trim() ? String(template) : '{name}'
    var rendered = tpl.replace(/\{(\w+)(?::(\d+))?\}/g, function (whole, key, width) {
      switch (key) {
        case 'name':
          return vars.name
        case 'preset':
          return vars.preset
        case 'date':
        case 'exifdate':
        case 'mdate':
          return ymd(d)
        case 'time':
        case 'exiftime':
          return hms(d)
        case 'counter':
          var c = String(vars.counter)
          if (width) while (c.length < Number(width)) c = '0' + c
          return c
        default:
          return whole
      }
    })
    return sanitizeFileName(rendered)
  }

  /**
   * Lower-cased final name of a custom template for duplicate checks; null when it cannot be known ({counter}).
   * {preset}, {width} and {height} depend on the preset: the same preset gives the same text, another one may not
   * (a miss is harmless - Media Converter numbers colliding outputs itself, the panel never overwrites).
   */
  function comparableName(template, base, presetId) {
    if (/\{counter(?::\d+)?\}/.test(template)) return null
    var s = template
    ;['{preset}', '{width}', '{height}'].forEach(function (tok) {
      s = s.split(tok).join('\u0001' + tok.slice(1, -1) + ':' + presetId + '\u0001')
    })
    s = s.split('{name}').join(base)
    return s.replace(/[. ]+$/, '').replace(/^\s+|\s+$/g, '').toLowerCase()
  }

  /**
   * One entry per row: { index, presetId, preset, ext, template, value, warn, direct, reason, token }. Default rows use
   * "{name}" and get "_2", "_3"… when an earlier row already has the same final name + extension; custom rows keep the
   * typed text and get a warning instead. Several source items (or none): every row is a default row.
   */
  function planOutputs() {
    var items = sourceItems()
    var single = items.length === 1
    var base = single ? safeName(items[0]) : ''
    var used = {} // "<final name>\n<ext>" -> 1-based row number
    return state.rows.map(function (row, i) {
      var p = presetById(row.presetId)
      var c = classifyRow(row, p, single)
      var ext = c.ext
      // unknown extension: only the same preset is known to produce the same extension
      var extKey = '\n' + (ext ? ext : '#' + row.presetId)
      var out = { index: i, presetId: row.presetId, preset: p, ext: ext, template: '{name}', value: '', warn: '', direct: !!c.direct, reason: c.reason || '', token: c.token || '' }
      if (!(single && row.custom && row.name.trim() !== '')) {
        var stem = single ? base.toLowerCase() : '{name}'
        var n = 1
        while (used[stem + (n > 1 ? '_' + n : '') + extKey]) n++
        used[stem + (n > 1 ? '_' + n : '') + extKey] = i + 1
        var suffix = n > 1 ? '_' + n : ''
        out.template = '{name}' + suffix
        out.value = single ? base + suffix : ''
        return out
      }
      out.template = row.name
      out.value = row.name
      if (BAD_NAME_CHARS.test(row.name.replace(TOKEN_RE, ''))) {
        out.warn = t('warnBadChars')
        return out
      }
      var key = comparableName(row.name, base, row.presetId)
      if (key !== null) {
        if (used[key + extKey]) out.warn = t('warnDupName', { n: used[key + extKey] })
        else used[key + extKey] = i + 1
      }
      return out
    })
  }

  /** Final file name (no extension) of a direct output for one source item (index = its 1-based place in the batch). */
  function finalStem(o, itemBase, index) {
    return renderName(o.template, { name: itemBase, preset: o.preset ? presetName(o.preset) : '', counter: index, now: new Date() })
  }

  // ------------------------------------------------------------------ host
  function hostCall(fn, arg) {
    return state.mock ? mockHost(fn, arg) : MC.cep.callHost(fn, arg)
  }

  function ensureHostScript() {
    // ScriptPath normally loads host.jsx; re-evaluate it if MCHost is missing (e.g. after an ExtendScript engine reset).
    return MC.cep.evalScript('typeof MCHost').then(function (r) {
      if (r === 'object') return
      var file = state.node ? state.node.path.join(MC.cep.extensionPath(), 'jsx', 'host.jsx') : ''
      return MC.cep.evalScript('$.evalFile(' + MC.cep.scriptString(file.replace(/\\/g, '/')) + ')')
    })
  }

  /** Premiere Pro: whether the loaded host script has exportDirect (an older one only renders intermediates). */
  function checkHostCaps() {
    if (state.mock || isAE()) return Promise.resolve()
    return MC.cep.evalScript('typeof MCHost.exportDirect').then(function (r) {
      var can = r === 'function'
      if (can !== state.hostCaps.exportDirect) {
        state.hostCaps.exportDirect = can
        state.classified = {}
      }
    })
  }

  function refreshHost() {
    var ready = state.mock ? Promise.resolve() : ensureHostScript().then(checkHostCaps)
    return ready
      .then(function () {
        return hostCall('info')
      })
      .then(function (r) {
        state.hostInfo = r && r.ok ? r : { ok: false, items: [], projectPath: '', message: r && r.message }
        var key = sourceKey()
        if (key !== state.sourceKey) {
          // another sequence / comp: custom file names belonged to the previous one
          state.sourceKey = key
          state.rows.forEach(function (row) {
            row.custom = false
            row.name = ''
          })
        }
        renderSource()
        renderOutput()
        updateOutputs()
        return state.hostInfo
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
    renderOutputs()
    renderOutput()
  }

  function renderSource() {
    var box = $('sourceText')
    box.textContent = ''
    var hi = state.hostInfo
    var ae = isAE()
    if (hi && hi.items && hi.items.length) {
      box.appendChild(el('div', 'muted', ae ? t('sourceComps') : t('sourceSeq')))
      box.appendChild(el('div', 'strong', hi.items.join(', ')))
      box.classList.remove('warn')
    } else {
      box.appendChild(el('div', null, ae ? t('noComps') : t('noSequence')))
      box.classList.add('warn')
    }
    $('aeNote').hidden = !ae
    $('aeWarn').hidden = !(ae && hi && hi.ok && !hi.projectPath)
    $('rangeRow').hidden = ae
  }

  function fillPresetOptions(sel, presets) {
    var cats = []
    var byCat = {}
    presets.forEach(function (p) {
      var k = 'c:' + (p.category || '')
      if (!byCat[k]) {
        byCat[k] = []
        cats.push(p.category || '')
      }
      byCat[k].push(p)
    })
    cats.forEach(function (cat) {
      var group = document.createElement('optgroup')
      group.label = categoryLabel(cat)
      byCat['c:' + cat].forEach(function (p) {
        var o = document.createElement('option')
        o.value = p.id
        o.textContent = presetName(p)
        group.appendChild(o)
      })
      sel.appendChild(group)
    })
  }

  var rowSeq = 0
  function buildRow(row, presets) {
    var id = 'mc-out-name-' + ++rowSeq
    var card = el('div', 'out-row')

    var line1 = el('div', 'out-line')
    var num = el('span', 'out-num')
    var sel = document.createElement('select')
    fillPresetOptions(sel, presets)
    sel.value = row.presetId
    sel.addEventListener('change', function () {
      row.presetId = sel.value
      saveRows()
      updateOutputs()
    })
    var rm = el('button', 'icon-btn', '\u00d7')
    rm.type = 'button'
    rm.title = t('removeOutput')
    rm.setAttribute('aria-label', t('removeOutput'))
    rm.addEventListener('click', function () {
      removeRow(row)
    })
    line1.appendChild(num)
    line1.appendChild(sel)
    line1.appendChild(rm)

    var summary = el('div', 'out-summary muted small ellipsis')

    // one export / two steps, decided before the user starts
    var mode = el('div', 'out-mode small')
    var pill = el('span', 'mode-pill')
    var why = el('span', 'mode-why')
    mode.appendChild(pill)
    mode.appendChild(why)

    var line3 = el('div', 'out-line')
    var label = el('label', 'out-label', t('fileName'))
    label.htmlFor = id
    var input = document.createElement('input')
    input.type = 'text'
    input.id = id
    input.spellcheck = false
    input.autocomplete = 'off'
    input.addEventListener('input', function () {
      row.custom = true
      row.name = input.value
      updateOutputs()
    })
    input.addEventListener('blur', function () {
      if (row.custom && !input.value.trim()) {
        // empty -> back to the default name
        row.custom = false
        row.name = ''
      }
      updateOutputs()
    })
    var ext = el('span', 'out-ext')
    line3.appendChild(label)
    line3.appendChild(input)
    line3.appendChild(ext)

    var warn = el('div', 'out-warn small')
    warn.hidden = true

    card.appendChild(line1)
    card.appendChild(summary)
    card.appendChild(mode)
    card.appendChild(line3)
    card.appendChild(warn)
    row.dom = { card: card, num: num, sel: sel, rm: rm, summary: summary, mode: mode, pill: pill, why: why, input: input, ext: ext, warn: warn }
    return card
  }

  /** Which row control has the keyboard focus (to restore it after a rebuild). */
  function focusedRowControl() {
    var a = document.activeElement
    for (var i = 0; i < state.rows.length; i++) {
      var d = state.rows[i].dom
      if (!d) continue
      if (d.input === a) return { index: i, input: true, start: a.selectionStart, end: a.selectionEnd }
      if (d.sel === a) return { index: i, input: false }
    }
    return null
  }

  /** Rebuild the output rows (presets list changed, row added / removed). */
  function renderOutputs() {
    var list = $('outputList')
    var focus = focusedRowControl()
    state.rows.forEach(function (row) {
      row.dom = null
    })
    list.textContent = ''
    var presets = videoPresets()
    $('noPresets').hidden = presets.length > 0
    $('addOutputBtn').hidden = !presets.length
    if (presets.length) {
      state.rows.forEach(function (row) {
        list.appendChild(buildRow(row, presets))
      })
    }
    updateOutputs()
    if (focus && state.rows[focus.index] && state.rows[focus.index].dom) {
      var d = state.rows[focus.index].dom
      if (focus.input) {
        d.input.focus()
        try {
          d.input.setSelectionRange(focus.start, focus.end)
        } catch (e) {
          /* ignore */
        }
      } else {
        d.sel.focus()
      }
    }
  }

  function renderMode(d, o) {
    d.mode.classList.toggle('direct', o.direct)
    d.mode.classList.toggle('two-step', !o.direct)
    if (o.direct) {
      text(d.pill, t('modeDirect'))
      text(d.why, '')
      d.why.hidden = true
      d.mode.title = t('modeDirectTitle', { host: hostLabel() })
    } else {
      var why = reasonText(o, o.preset)
      text(d.pill, t('modeTwoStep'))
      text(d.why, why)
      d.why.hidden = false
      d.mode.title = why + '\n' + t('modeTwoStepTitle', { host: hostLabel() })
    }
  }

  /** The line under the rows: what pressing the button will do. */
  function renderPlanNote(plan) {
    var nDirect = plan.filter(function (o) {
      return o.direct
    }).length
    var nTwo = plan.length - nDirect
    var note = $('planNote')
    note.hidden = !plan.length
    if (!plan.length) return
    var s
    if (!nTwo) s = t('planAllDirect', { host: hostLabel() })
    else if (!nDirect) s = t('planAllTwoStep', { host: hostLabel() })
    else s = t('planMixed', { direct: nDirect, two: nTwo })
    text(note, s)
    note.classList.toggle('two-step', nTwo > 0)
  }

  /** Refresh names, extensions, modes and warnings of the existing rows without rebuilding them (keeps typing focus). */
  function updateOutputs() {
    var plan = planOutputs()
    var items = sourceItems()
    var placeholder = items.length > 1 ? t('nameMultiPlaceholder') : items.length ? '' : t('nameAutoPlaceholder')
    var bad = false
    state.rows.forEach(function (row, i) {
      var o = plan[i]
      if (o.warn) bad = true
      var d = row.dom
      if (!d) return
      var p = o.preset
      text(d.num, String(i + 1))
      if (d.sel.value !== row.presetId) d.sel.value = row.presetId
      d.sel.title = p ? presetName(p) : ''
      text(d.summary, (p && p.summary) || '')
      d.summary.title = (p && p.summary) || ''
      renderMode(d, o)
      d.rm.hidden = state.rows.length < 2
      text(d.ext, o.ext ? '.' + o.ext : '')
      d.ext.hidden = !o.ext
      d.input.disabled = items.length !== 1
      d.input.placeholder = placeholder
      // never overwrite what the user is typing
      if (!(row.custom && document.activeElement === d.input) && d.input.value !== o.value) d.input.value = o.value
      d.input.title = o.value ? o.value + (o.ext ? '.' + o.ext : '') : ''
      d.input.classList.toggle('invalid', !!o.warn)
      d.card.classList.toggle('invalid', !!o.warn)
      text(d.warn, o.warn)
      d.warn.hidden = !o.warn
    })
    if ($('planNote')) renderPlanNote(state.rows.length && state.rows[0].dom ? plan : [])
    state.outputsValid = !bad && plan.length > 0
    updateGoState()
    return plan
  }

  function addRow() {
    var last = state.rows[state.rows.length - 1]
    var pid = last ? last.presetId : defaultPresetId()
    if (!pid) return
    var row = newRow(pid)
    state.rows.push(row)
    saveRows()
    renderOutputs()
    // keep the new row in view inside the settings scroller
    var sc = $('scroll')
    if (row.dom && sc) {
      var bottom = row.dom.card.offsetTop + row.dom.card.offsetHeight
      if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight + 4
    }
  }

  function removeRow(row) {
    var i = state.rows.indexOf(row)
    if (i < 0 || state.rows.length < 2) return
    state.rows.splice(i, 1)
    saveRows()
    renderOutputs()
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

  function updateGoState() {
    $('goBtn').disabled = state.busy || !state.outputsValid
  }

  function setBusy(b) {
    state.busy = b
    $('settings').disabled = b
    text($('goBtn'), b ? t('working') : t('go'))
    updateGoState()
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
  function joinPath(dir, name) {
    return state.node ? state.node.path.join(dir, name) : dir.replace(/[\\/]+$/, '') + '/' + name
  }
  function dotExt(ext) {
    var e = String(ext || '.mov')
    return e.charAt(0) === '.' ? e : '.' + e
  }
  /** m:ss (h:mm:ss from one hour). */
  function fmtDuration(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000))
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var sec = s % 60
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec)
  }

  function describeRenderError(r) {
    if (r.error === 'busy') return t('busy')
    if (r.error === 'noSequence') return t('noSequence')
    if (r.error === 'noComps') return t('noComps')
    var parts = (r.errors && r.errors.length ? r.errors : [r.error || 'unknown']).slice()
    if (r.message && parts.join(' ').indexOf(r.message) < 0) parts.push(r.message)
    return parts.join('; ')
  }

  /** MCHost.planBackground failure -> what the user should do. */
  function describePlanError(r) {
    switch (r.error) {
      case 'unsavedProject':
        return t('errUnsavedProject', { go: t('go') })
      case 'duplicateComp':
        return t('errDuplicateComp', { name: r.message || '?' })
      case 'compQueued':
        return t('errCompQueued', { name: r.message || '?', go: t('go') })
      case 'saveFailed':
        return t('errSaveFailed', { msg: r.message || r.error })
      case 'noAerender':
        return t('errNoAerender', { path: r.message || 'aerender.exe' })
      case 'busy':
        return t('busy')
      case 'noComps':
        return t('noComps')
      default:
        return t('errPlanFailed', { msg: describeRenderError(r) })
    }
  }

  function samePath(a, b) {
    return !!a && !!b && String(a).replace(/[\\/]+/g, '/').toLowerCase() === String(b).replace(/[\\/]+/g, '/').toLowerCase()
  }

  /** A path aerender cannot receive on its ANSI command line: the project (save it elsewhere) or another folder. */
  function describePathNotAnsi(p, projectPath) {
    return samePath(p, projectPath) ? t('errProjectPathNotAnsi', { path: p, go: t('go') }) : t('errPathNotAnsi', { path: p })
  }

  // js/aerender.cjs reports its own problems as "<code>: <detail>"; everything else is aerender's own output
  var AERENDER_CODE_RE = /^(compNameNotAnsi|pathNotAnsi|noOutput|renameFailed|spawnFailed|noProject|noAerender|noOutputDir|exitCode): ([\s\S]*)$/

  /** One aerender.cjs error line -> what the user should know / do (aerender's own lines unchanged). */
  function describeAerenderLine(line, projectPath) {
    var m = AERENDER_CODE_RE.exec(line)
    if (!m) return line
    var v = m[2]
    switch (m[1]) {
      case 'compNameNotAnsi':
        return t('errCompNameNotAnsi', { name: v, go: t('go') })
      case 'pathNotAnsi':
        return describePathNotAnsi(v, projectPath)
      case 'noOutput':
        return t('errNoOutput', { path: v })
      case 'renameFailed':
        return t('errRenameFailed', { msg: v })
      case 'spawnFailed':
        return t('errSpawnFailed', { msg: v })
      case 'noProject':
        return t('errNoProject', { path: v })
      case 'noAerender':
        return t('errNoAerender', { path: v })
      case 'noOutputDir':
        return t('errNoOutputDir', { msg: v })
      default:
        return t('errExitCode', { code: v })
    }
  }

  /** Why aerender failed: aerender.cjs' own codes (translated) + the last lines aerender printed (its ERROR lines when
   *  there are any). */
  function errorTail(r, projectPath) {
    var errs = (r.errors || []).filter(function (s) {
      return typeof s === 'string' && s.trim() !== ''
    })
    if (!errs.length) return [t('errExitCode', { code: r.code === undefined || r.code === null ? '?' : r.code })]
    var coded = errs.filter(function (s) {
      return AERENDER_CODE_RE.test(s)
    })
    var other = errs.filter(function (s) {
      return !AERENDER_CODE_RE.test(s)
    })
    return coded.concat(other.slice(-4)).map(function (s) {
      return describeAerenderLine(s, projectPath)
    })
  }

  // ------------------------------------------------------------------ progress
  /** i/n: <source> -> <file>. Premiere Pro shows its own progress (the export blocks it): an endless bar here. */
  function showProgress(i, n, source, file) {
    var ppro = !isAE()
    state.progressPct = 0
    $('progress').hidden = false
    var label = t(ppro ? 'progressLabelPpro' : 'progressLabel', { i: i, n: n, comp: source, file: file })
    text($('progressLabel'), label)
    $('progressLabel').title = label
    $('progressBarBox').classList.toggle('endless', ppro)
    $('progressBar').style.width = ppro ? '' : '0%'
    text($('progressText'), state.cancelRequested ? t('cancelling') : ppro ? t('progressPpro') : t('progressNoEta', { pct: 0 }))
    $('cancelBtn').disabled = state.cancelRequested
  }

  function updateProgress(p) {
    if (!p || state.cancelRequested) return
    var pct = Math.max(0, Math.min(100, Math.floor(Number(p.percent) || 0)))
    if (pct < state.progressPct) pct = state.progressPct
    state.progressPct = pct
    $('progressBar').style.width = pct + '%'
    var eta = typeof p.remainingMs === 'number' && isFinite(p.remainingMs) ? p.remainingMs : null
    text($('progressText'), eta === null ? t('progressNoEta', { pct: pct }) : t('progressEta', { pct: pct, time: fmtDuration(eta) }))
  }

  function hideProgress() {
    $('progress').hidden = true
    $('progressBarBox').classList.remove('endless')
  }

  function cancelRender() {
    if (state.cancelRequested || !state.busy) return
    state.cancelRequested = true
    $('cancelBtn').disabled = true
    // Premiere Pro cannot be interrupted from here: its own export window has a Cancel button
    text($('progressText'), isAE() ? t('cancelling') : t('pproCancelNote'))
    if (state.cancelFn) state.cancelFn()
  }

  // ------------------------------------------------------------------ files (Node; no-ops in mock mode)
  function fileExists(p) {
    if (state.mock || !p) return false
    try {
      return state.node.fs.existsSync(p)
    } catch (e) {
      return false
    }
  }

  function removeFileSync(p) {
    if (state.mock || !p) return
    try {
      state.node.fs.unlinkSync(p)
    } catch (e) {
      /* gone / in use */
    }
  }

  /** Create a folder (and its parents); returns the error or null. */
  function ensureDir(dir) {
    if (state.mock) return null
    try {
      state.node.bridge.mkdirp(dir)
      return null
    } catch (e) {
      return e
    }
  }

  function pathKey(p) {
    return String(p).replace(/[\\/]+/g, '/').toLowerCase()
  }

  /** "<stem><ext>", else "<stem> (1)<ext>", "<stem> (2)<ext>"… - a name no file and no earlier output of this run has. */
  function freePath(dir, stem, ext, reserved) {
    for (var n = 0; n < 10000; n++) {
      var p = joinPath(dir, (n ? stem + ' (' + n + ')' : stem) + ext)
      if (!reserved[pathKey(p)] && !fileExists(p)) return p
    }
    return joinPath(dir, stem + ' (' + Date.now() + ')' + ext)
  }

  /** "<dir>/<stem>.mcpart<ext>": where a direct output is written until it is complete (a stale one is replaced). */
  function tempOutputPath(dir, stem, ext) {
    var p = joinPath(dir, stem + TEMP_SUFFIX + ext)
    removeFileSync(p)
    return p
  }

  /** Rename a finished temp file to its final name (never replacing a file; retried while the writer still holds it). */
  function moveToFinal(src, dir, stem, ext, reserved) {
    return new Promise(function (resolve, reject) {
      var tries = 0
      ;(function attempt() {
        var dest = freePath(dir, stem, ext, reserved)
        if (state.mock) {
          reserved[pathKey(dest)] = true
          return resolve(dest)
        }
        try {
          // checked right before: fs.renameSync would replace an existing file on Windows
          if (state.node.fs.existsSync(dest)) throw new Error('exists: ' + dest)
          state.node.fs.renameSync(src, dest)
          reserved[pathKey(dest)] = true
          resolve(dest)
        } catch (e) {
          if (++tries >= 12) return reject(e)
          setTimeout(attempt, 250)
        }
      })()
    })
  }

  /** aerender.cjs writes "_mc-aerender-<pid>-…" next to its output: remove what a killed render left in dir. */
  function removeAerenderTemps(dir) {
    if (state.mock || !dir) return
    var fs = state.node.fs
    var prefix = '_mc-aerender-' + state.node.process.pid + '-'
    var names = []
    try {
      names = fs.readdirSync(dir)
    } catch (e) {
      return
    }
    names.forEach(function (name) {
      if (name.indexOf(prefix) === 0) removeFileSync(joinPath(dir, name))
    })
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

  function newRequestId(tag) {
    return state.mock ? tag + '-mock-' + Date.now() : state.node.bridge.newId(tag)
  }
  function makeInterDir(id) {
    return state.mock ? 'C:/Users/me/AppData/Roaming/Media Converter/bridge/intermediates/' + id : state.node.bridge.makeIntermediateDir(state.bridgeDir, id)
  }
  function removeInterDir(dir) {
    if (state.mock || !dir) return
    var bridge = state.node.bridge
    bridge.removeDirIfInside(dir, bridge.bridgePaths(state.bridgeDir).intermediates)
  }
  function aerenderApi() {
    return state.mock ? mockAerender : state.node && state.node.aerender
  }

  function go() {
    if (state.busy) return
    setBusy(true)
    state.cancelRequested = false
    run()
      .catch(function (e) {
        log(t('logError', { msg: (e && e.message) || String(e) }), 'error')
      })
      .then(function () {
        state.cancelFn = null
        state.cancelRequested = false
        hideProgress()
        setBusy(false)
      })
  }

  async function run() {
    var hi = await refreshHost()
    var ae = isAE()
    if (!hi || !hi.items || !hi.items.length) {
      log(ae ? t('noComps') : t('noSequence'), 'error')
      return
    }
    var plan = updateOutputs()
    if (!plan.length) return log(t('noPresets'), 'error')
    if (!state.outputsValid) return log(t('errFixOutputs'), 'error')
    // aerender renders the saved project file, so After Effects needs one before anything else
    if (ae && !hi.projectPath) return log(t('errUnsavedProject', { go: t('go') }), 'error')
    var outDir = resolveOutDir()
    if (!outDir) return log(t('errNoOutDir'), 'error')
    var dirErr = ensureDir(outDir)
    if (dirErr) return log(t('errNoOutputDir', { msg: dirErr.message || String(dirErr) }), 'error')

    var id = newRequestId(ae ? 'ae' : 'ppro')
    if (ae) await runAE(id, hi, plan, outDir)
    else await runPremiere(id, hi, plan, outDir)
  }

  /** A direct row the host could not prepare after all: it joins the two-step rows (logged, never silent). */
  function fallBack(o, twoStep, reason) {
    o.direct = false
    o.reason = reason
    o.ext = presetExt(o.preset)
    log(t('logFallback', { n: o.index + 1, preset: o.preset ? presetName(o.preset) : o.presetId, why: reasonText(o, o.preset) }), 'warn')
    twoStep.push(o)
    twoStep.sort(function (a, b) {
      return a.index - b.index
    })
  }

  function outputsOf(rows) {
    return rows.map(function (o) {
      return { presetId: o.presetId, nameTemplate: o.template }
    })
  }

  function logSummary(done, failed) {
    if (failed) log(t('logDoneFailed', { n: done, failed: failed }), 'warn')
    else if (done) log(t('logDone', { n: done }), 'ok')
  }

  // ---- Premiere Pro
  /**
   * Direct rows: writeEpr (temporary .epr) -> MCHost.exportDirect into "<name>.mcpart<ext>" in the output folder ->
   * rename to the final name. Two-step rows: one master render, then the Media Converter request with only those rows.
   */
  async function runPremiere(id, hi, plan, outDir) {
    var seq = hi.items[0]
    var seqBase = safeName(seq)
    var range = lsGet(LS.range, 'entire') === 'inout' ? 'inout' : 'entire'
    var direct = []
    var twoStep = []
    plan.forEach(function (o) {
      ;(o.direct ? direct : twoStep).push(o)
    })
    log(t('logStart', { items: seq, n: plan.length }))

    var eprDir = ''
    var done = 0
    var failed = 0
    var cancelled = false
    try {
      if (direct.length) {
        var mod = formatModule()
        eprDir = state.mock ? 'C:/Users/me/AppData/Local/Temp/MediaConverterPanel/' + id : joinPath(tempRoot(), id)
        var dirErr = ensureDir(eprDir)
        var ready = []
        for (var k = 0; k < direct.length; k++) {
          var o = direct[k]
          var r = null
          if (!dirErr && mod && typeof mod.writeEpr === 'function') {
            try {
              r = await mod.writeEpr(o.preset.settings, { presetsDir: state.mock ? 'C:/Program Files/Adobe/MediaIO/systempresets' : presetsDir(), outFile: joinPath(eprDir, 'output-' + (o.index + 1) + '.epr') })
            } catch (e) {
              console.error(e)
              r = null
            }
          }
          if (r && r.ok && r.path) {
            o.eprPath = r.path
            if (r.ext) o.ext = extNoDot(r.ext)
            ready.push(o)
          } else {
            fallBack(o, twoStep, (r && r.reason) || 'hostPreset')
          }
        }
        direct = ready
      }

      var total = direct.length + (twoStep.length ? 1 : 0)
      var reserved = {}
      for (var i = 0; i < direct.length; i++) {
        if (state.cancelRequested) {
          cancelled = true
          break
        }
        var d = direct[i]
        var ext = '.' + d.ext
        var stem = finalStem(d, seqBase, 1)
        showProgress(i + 1, total, seq, stem + ext)
        var tmp = tempOutputPath(outDir, stem, ext)
        state.currentTemp = tmp
        var res = await hostCall('exportDirect', { outPath: tmp, eprPath: d.eprPath, range: range })
        state.currentTemp = ''
        var written = (res && res.file) || tmp
        if (!res || !res.ok) {
          removeFileSync(written)
          removeFileSync(tmp)
          failed++
          log(t('logExportFailed', { file: stem + ext }), 'error')
          log(describeRenderError(res || {}), 'error')
          continue
        }
        try {
          var dest = await moveToFinal(written, outDir, stem, ext, reserved)
          done++
          log(t('logExported', { path: dest }), 'ok')
        } catch (e) {
          failed++
          log(t('errRenameKept', { msg: (e && e.message) || String(e), path: written }), 'error')
        }
      }
    } finally {
      if (eprDir && !state.mock) state.node.bridge.removeDirIfInside(eprDir, tempRoot())
    }
    if (!cancelled && state.cancelRequested && twoStep.length) cancelled = true
    if (cancelled) {
      hideProgress()
      log(done ? t('logCancelledKept', { n: done }) : t('logCancelled'), 'warn')
      return
    }

    if (twoStep.length) {
      var masterName = seqBase + '.mov'
      showProgress(direct.length + 1, direct.length + 1, seq, t('masterFile', { file: masterName }))
      var files = await renderPremiereMaster(id, hi, range, twoStep.length)
      hideProgress()
      if (state.cancelRequested) {
        // the master is done, but the user does not want the conversion any more
        if (files) removeInterDir(dirName(files[0]))
        log(done ? t('logCancelledKept', { n: done }) : t('logCancelled'), 'warn')
        return
      }
      if (!files) failed += twoStep.length
      logSummary(done, failed)
      if (files && files.length) await sendRequest(id, files, outputsOf(twoStep), outDir, 'premiere')
      return
    }
    hideProgress()
    logSummary(done, failed)
  }

  /** Premiere Pro two-step part: the master (automatic high-quality preset). Resolves with files or null. */
  async function renderPremiereMaster(id, hi, range, nOutputs) {
    var interDir = makeInterDir(id)
    log(t('logMaster', { n: nOutputs }))
    var r = await hostCall('render', { outDir: interDir, range: range, appDir: state.appDir, eprPath: '' })
    var files = (r && r.files) || []
    if (!files.length) {
      removeInterDir(interDir)
      if (r && r.error === 'noPreset') log(t('logNoPreset'), 'error')
      else log(t('logMasterFailed', { msg: describeRenderError(r || {}) }), 'error')
      return null
    }
    files.forEach(function (f) {
      log(t('logMasterDone', { file: baseName(f) }), 'ok')
    })
    if (r.errors && r.errors.length) log(t('logWarn', { msg: r.errors.join('; ') }), 'warn')
    return files
  }

  // ---- After Effects
  /** One aerender run; resolves (never rejects) with the aerender.cjs result. */
  function renderInBackground(aer, bg, job, outputPath) {
    var handle
    try {
      handle = aer.render({
        aerenderPath: bg.aerenderPath,
        projectPath: bg.projectPath,
        comp: job.comp,
        outputPath: outputPath,
        omTemplate: job.omTemplate,
        rsTemplate: RS_TEMPLATE,
        totalFrames: job.frames,
        onProgress: updateProgress
      })
    } catch (e) {
      return Promise.resolve({ ok: false, cancelled: false, code: null, outputPath: outputPath, errors: [(e && e.message) || String(e)] })
    }
    state.cancelFn = handle.cancel
    if (state.cancelRequested) handle.cancel()
    return Promise.resolve(handle.promise).then(
      function (r) {
        state.cancelFn = null
        return r || { ok: false, cancelled: false, code: null, outputPath: outputPath, errors: [] }
      },
      function (e) {
        state.cancelFn = null
        return { ok: false, cancelled: false, code: null, outputPath: outputPath, errors: [(e && e.message) || String(e)] }
      }
    )
  }

  /**
   * Comp names / paths aerender could not receive on its ANSI command line (js/aerender.cjs checkArgs) - checked before
   * the project is saved and anything renders. Logs why and resolves false when there are any.
   */
  async function checkAerenderArgs(aer, projectPath, dirs, comps) {
    if (typeof aer.checkArgs !== 'function') return true
    var badComps = []
    var badPaths = []
    for (var i = 0; i < dirs.length; i++) {
      var bad = await aer.checkArgs({ projectPath: i === 0 ? projectPath : '', outputDir: dirs[i], comps: i === 0 ? comps : [] })
      if (!bad) continue
      ;(bad.comps || []).forEach(function (c) {
        if (badComps.indexOf(c) < 0) badComps.push(c)
      })
      ;(bad.paths || []).forEach(function (p) {
        if (badPaths.indexOf(p) < 0) badPaths.push(p)
      })
    }
    badComps.forEach(function (c) {
      log(t('errCompNameNotAnsi', { name: c, go: t('go') }), 'error')
    })
    badPaths.forEach(function (p) {
      log(describePathNotAnsi(p, projectPath), 'error')
    })
    return !badComps.length && !badPaths.length
  }

  /**
   * After Effects: MCHost.planBackground saves the project, lists the comps and creates an output module template per
   * direct row; aerender.exe then renders each comp x direct row straight into the output folder, and (two-step rows)
   * each comp's ProRes master into bridge/intermediates/<id>/ for Media Converter, while AE stays usable.
   */
  async function runAE(id, hi, plan, outDir) {
    var aer = aerenderApi()
    if (!aer) {
      log(t('errNoAerenderModule'), 'error')
      return
    }
    var interDir = makeInterDir(id)
    // the panel page may go away while aerender runs (see abandonRender)
    state.interDir = interDir
    state.directDir = outDir
    var handedOver = false
    try {
      handedOver = await runAEInto(aer, id, hi, plan, outDir, interDir)
    } finally {
      state.interDir = ''
      state.directDir = ''
      // nothing for Media Converter (all direct, failed or cancelled): aerender.cjs deleted partial files, this removes
      // the rest
      if (!handedOver) removeInterDir(interDir)
    }
  }

  /** Resolves true when the masters were handed to Media Converter (it deletes them after converting). */
  async function runAEInto(aer, id, hi, plan, outDir, interDir) {
    var direct = []
    var twoStep = []
    plan.forEach(function (o) {
      ;(o.direct ? direct : twoStep).push(o)
    })
    if (!(await checkAerenderArgs(aer, hi.projectPath, [interDir, outDir], hi.items))) return false

    // an output module spec per direct row; planBackground turns each into an output module template
    var mod = formatModule()
    var specs = []
    direct = direct.filter(function (o) {
      var spec = null
      try {
        spec = mod && typeof mod.omSpec === 'function' ? mod.omSpec(o.preset.settings) : null
      } catch (e) {
        console.error(e)
      }
      if (!spec) {
        fallBack(o, twoStep, 'omSpec')
        return false
      }
      o.key = 'out' + (o.index + 1)
      specs.push({ key: o.key, om: spec })
      return true
    })

    var bg = await hostCall('planBackground', specs.length ? { outputs: specs } : {})
    if (!bg || !bg.ok) {
      log(describePlanError(bg || {}), 'error')
      return false
    }
    var items = bg.items || []
    if (!items.length) {
      log(t('noComps'), 'error')
      return false
    }
    var templates = bg.templates || {}
    direct = direct.filter(function (o) {
      var tpl = templates[o.key]
      if (!tpl || !tpl.name) {
        fallBack(o, twoStep, 'template')
        return false
      }
      o.omTemplate = tpl.name
      if (tpl.ext) o.ext = extNoDot(tpl.ext)
      return true
    })
    log(t('logProjectSaved'), 'ok')
    var names = items.map(function (it) {
      return it.comp
    })
    log(t('logBgStart', { items: names.join(', '), n: items.length * plan.length }))

    var total = items.length * (direct.length + (twoStep.length ? 1 : 0))
    var step = 0
    var files = []
    var reserved = {}
    var done = 0
    var failed = 0
    var cancelled = false
    for (var ci = 0; ci < items.length && !cancelled; ci++) {
      var item = items[ci]
      for (var di = 0; di < direct.length; di++) {
        var o = direct[di]
        var ext = '.' + o.ext
        var stem = finalStem(o, item.baseName, ci + 1)
        showProgress(++step, total, item.comp, stem + ext)
        var tmp = tempOutputPath(outDir, stem, ext)
        state.currentTemp = tmp
        var r = await renderInBackground(aer, bg, { comp: item.comp, frames: item.frames, omTemplate: o.omTemplate }, tmp)
        if (r.ok) {
          // finished before a late Cancel: it is complete, keep it
          try {
            var dest = await moveToFinal(r.outputPath || tmp, outDir, stem, ext, reserved)
            done++
            log(t('logExported', { path: dest }), 'ok')
          } catch (e) {
            failed++
            log(t('errRenameKept', { msg: (e && e.message) || String(e), path: r.outputPath || tmp }), 'error')
          }
        }
        state.currentTemp = ''
        if (r.cancelled || state.cancelRequested) {
          cancelled = true
          break
        }
        if (!r.ok) {
          failed++
          log(t('logExportFailed', { file: item.comp + ' → ' + stem + ext }), 'error')
          errorTail(r, bg.projectPath).forEach(function (line) {
            log(line, 'error')
          })
        }
      }
      if (cancelled || !twoStep.length) continue
      // the master of this comp for the two-step rows
      var masterName = item.baseName + dotExt(item.ext)
      showProgress(++step, total, item.comp, t('masterFile', { file: masterName }))
      var outputPath = joinPath(interDir, masterName)
      var m = await renderInBackground(aer, bg, item, outputPath)
      if (m.cancelled || state.cancelRequested) {
        cancelled = true
        break
      }
      if (m.ok) {
        files.push(m.outputPath || outputPath)
        log(t('logMasterDone', { file: masterName }), 'ok')
      } else {
        failed += twoStep.length
        log(t('logMasterFailed', { msg: item.comp }), 'error')
        errorTail(m, bg.projectPath).forEach(function (line) {
          log(line, 'error')
        })
      }
    }
    hideProgress()
    if (cancelled) {
      // runAE removes the masters rendered so far
      log(done ? t('logCancelledKept', { n: done }) : t('logCancelled'), 'warn')
      return false
    }
    logSummary(done, failed)
    if (!twoStep.length || !files.length) return false
    await sendRequest(id, files, outputsOf(twoStep), outDir, 'aftereffects')
    return true
  }

  /** Closing / reloading the panel during a background render: stop aerender (it would go on rendering headless) and
   *  remove its files - the masters' folder and a partial direct output. */
  function abandonRender() {
    var dir = state.interDir
    var outDir = state.directDir
    if (!dir && !outDir) return
    state.interDir = ''
    state.directDir = ''
    state.cancelRequested = true
    // synchronous kill: the page cannot wait for callbacks
    if (state.cancelFn) state.cancelFn(true)
    if (state.mock) return
    for (var i = 0; i < 5; i++) {
      removeInterDir(dir)
      removeAerenderTemps(outDir)
      removeFileSync(state.currentTemp)
      if (!fileExists(dir) && !fileExists(state.currentTemp)) return
      // the killed processes may hold their file for a moment
      var until = Date.now() + 120
      while (Date.now() < until) {
        /* wait */
      }
    }
  }

  // ---- Media Converter (two-step rows only)
  async function sendRequest(id, files, outputs, outDir, host) {
    if (state.mock) return mockSend(files, outputs)
    var bridge = state.node.bridge
    var presetIds = []
    outputs.forEach(function (o) {
      if (presetIds.indexOf(o.presetId) < 0) presetIds.push(o.presetId)
    })
    // every file is in bridge/intermediates/<id>/; Media Converter deletes them only after their jobs succeeded
    var interDir = dirName(files[0])
    try {
      var req = bridge.buildRequest({
        id: id,
        host: host,
        files: files,
        presetIds: presetIds, // older apps ignore outputs and use these
        outputs: outputs,
        outputDir: outDir,
        deleteAfter: true,
        start: true
      })
      bridge.writeRequest(state.bridgeDir, req)
    } catch (e) {
      // never sent: nothing else would delete them
      removeInterDir(interDir)
      throw e
    }
    log(t('logSent', { files: files.length, outputs: outputs.length }))

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
      // rejected = no job was queued, so nothing will ever delete the intermediates
      removeInterDir(interDir)
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

  // ------------------------------------------------------------------ mock (plain browser, UI work only)
  function mockSettings(container, vcodec, v, a, extra) {
    var s = {
      container: container,
      video: { codec: vcodec, hw: 'auto', rate: { mode: 'crf', crf: 20 }, speed: 'balanced', profile: null, width: null, height: null, scaleMode: 'fit', noUpscale: true, fps: null },
      audio: { codec: 'aac', bitrateKbps: 192, sampleRate: null, channels: null }
    }
    var k
    for (k in v || {}) s.video[k] = v[k]
    for (k in a || {}) s.audio[k] = a[k]
    for (k in extra || {}) s[k] = extra[k]
    return s
  }

  function mockInfo() {
    function preset(id, cat, name, summary, ext, settings) {
      return { id: id, kind: 'video', name: name, category: cat, builtIn: cat !== 'custom', summary: summary, ext: ext, settings: settings }
    }
    var older = preset('legacy', 'custom', 'Preset from an older Media Converter', 'MP4 · H.264 · 1280×720', 'mp4', null)
    delete older.settings
    return {
      bridgeVersion: 1,
      appVersion: '0.0.0-mock',
      exePath: '',
      locale: MC.i18n.normalize(queryParam('lang')) || MC.i18n.normalize(global.navigator.language) || 'zh-TW',
      updatedAt: Date.now(),
      lastVideoPresetId: 'h264-1080p',
      defaultOutputDir: null,
      presets: [
        preset('h264-match', 'web', 'H.264 MP4 (match source)', 'MP4 · H.264 · source size', 'mp4', mockSettings('mp4', 'h264', { profile: 'high' })),
        preset('h264-1080p', 'web', 'H.264 MP4 1080p', 'MP4 · H.264 · 1920×1080', 'mp4', mockSettings('mp4', 'h264', { profile: 'high', width: 1920, height: 1080 })),
        preset('webm-vp9-1080p', 'web', 'WebM VP9 1080p', 'WebM · VP9 · 1920×1080 · Opus', 'webm', mockSettings('webm', 'vp9', { width: 1920, height: 1080 }, { codec: 'opus', bitrateKbps: 128 })),
        preset('av1-match', 'web', 'AV1 MP4 (match source)', 'MP4 · AV1 · source size', 'mp4', mockSettings('mp4', 'av1')),
        preset('social-vertical-1080x1920', 'social', 'Vertical video 1080×1920', 'MP4 · H.264 · 1080×1920 · fill and crop', 'mp4', mockSettings('mp4', 'h264', { profile: 'high', width: 1080, height: 1920, scaleMode: 'crop', noUpscale: false })),
        preset('prores-422-hq', 'editing', 'ProRes 422 HQ', 'MOV · ProRes 422 HQ', 'mov', mockSettings('mov', 'prores', { profile: 'hq' }, { codec: 'pcm', bitrateKbps: null })),
        preset('hevc-match', 'device', 'HEVC (H.265) MP4 (match source)', 'MP4 · HEVC · source size', 'mp4', mockSettings('mp4', 'hevc')),
        preset('user-logo', 'custom', 'My delivery preset with a logo and a fairly long name', 'MP4 · H.264 · 1920×1080 · watermark', 'mp4', mockSettings('mp4', 'h264', { width: 1920, height: 1080 }, null, { watermark: { type: 'text', text: '©', anchor: 'bottom-right', marginPct: 3, opacity: 0.8, fontSizePct: 5, color: '#ffffff' } })),
        older
      ]
    }
  }

  // stand-in for js/ppro-epr.cjs / js/ae-om.cjs: a rough idea of what each host writes natively
  var mockFormats = {
    classify: function (s) {
      var v = s.video || {}
      var a = s.audio || {}
      var ae = isAE()
      if (s.watermark) return { direct: false, reason: 'watermark' }
      if (s.container === 'mp4') {
        if (v.codec === 'av1' || (v.codec === 'hevc' && ae)) return { direct: false, reason: 'videoCodec' }
        if (v.codec !== 'h264' && v.codec !== 'hevc') return { direct: false, reason: 'videoCodec' }
        if (a.codec !== 'aac' && a.codec !== 'none') return { direct: false, reason: 'audioCodec' }
        if (ae && v.scaleMode === 'crop') return { direct: false, reason: 'scaleMode' }
        return { direct: true, ext: '.mp4' }
      }
      if (s.container === 'mov' && v.codec === 'prores') return { direct: true, ext: '.mov' }
      return { direct: false, reason: 'container' }
    },
    writeEpr: function (s, opts) {
      var c = mockFormats.classify(s)
      return c.direct ? { ok: true, path: opts.outFile, ext: c.ext, base: 'Match Source - High bitrate' } : { ok: false, reason: c.reason }
    },
    omSpec: function (s) {
      var c = mockFormats.classify(s)
      return c.direct ? { ext: c.ext, base: c.ext === '.mov' ? 'Apple ProRes 422 HQ' : 'H.264 - Match Render Settings - 15 Mbps' } : null
    }
  }

  function mockHostInfo() {
    var ae = isAE()
    var items = queryParam('items')
    var list = items === null ? [ae ? 'Comp 1' : 'Sequence 01'] : items.split('|').filter(Boolean)
    var unsaved = queryParam('unsaved') === '1'
    return {
      ok: true,
      host: ae ? 'aftereffects' : 'premiere',
      hostVersion: 'mock',
      projectPath: unsaved ? '' : ae ? 'C:/Projects/Demo/demo.aep' : 'C:/Projects/Demo/demo.prproj',
      items: list,
      canWriteFiles: true
    }
  }

  function delay(ms, value) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(value)
      }, ms)
    })
  }

  function mockHost(fn, args) {
    var hi = mockHostInfo()
    if (fn === 'info') return Promise.resolve(hi)
    if (fn === 'exportDirect') return delay(1800, { ok: true, file: args.outPath })
    if (fn === 'render') {
      return delay(1500, { ok: true, host: 'premiere', files: [args.outDir + '/' + safeName(hi.items[0]) + '.mov'], errors: [] })
    }
    if (fn === 'planBackground') {
      if (!hi.projectPath) return delay(150, { ok: false, host: 'aftereffects', error: 'unsavedProject', message: '', errors: ['unsavedProject'] })
      if (!hi.items.length) return delay(150, { ok: false, host: 'aftereffects', error: 'noComps', message: '', errors: ['noComps'] })
      var used = {}
      var templates = {}
      ;((args && args.outputs) || []).forEach(function (o) {
        templates[o.key] = { name: 'Media Converter - ' + o.om.base, ext: o.om.ext }
      })
      return delay(300, {
        ok: true,
        host: 'aftereffects',
        projectPath: hi.projectPath,
        aerenderPath: 'C:/Program Files/Adobe/Adobe After Effects 2023/Support Files/aerender.exe',
        items: hi.items.map(function (comp) {
          var base = safeName(comp)
          var name = base
          for (var n = 2; used[name.toLowerCase()]; n++) name = base + '_' + n
          used[name.toLowerCase()] = true
          return { comp: comp, frames: 90, fps: 30, omTemplate: 'Apple ProRes 422 HQ', ext: '.mov', baseName: name }
        }),
        templates: templates
      })
    }
    return Promise.resolve({ ok: false, error: 'unsupported', message: fn })
  }

  // ~3 s per render, Cancel works - same handle shape as js/aerender.cjs render()
  var mockAerender = {
    render: function (opts) {
      var start = Date.now()
      var total = opts.totalFrames || 90
      var done = false
      var resolveFn
      var promise = new Promise(function (resolve) {
        resolveFn = resolve
      })
      function finish(r) {
        if (done) return
        done = true
        clearInterval(timer)
        resolveFn(r)
      }
      var timer = setInterval(function () {
        var elapsed = Date.now() - start
        var frame = Math.min(total, Math.round((total * elapsed) / 3000))
        opts.onProgress({
          frame: frame,
          total: total,
          percent: Math.floor((frame * 100) / total),
          elapsedMs: elapsed,
          remainingMs: frame > 5 ? Math.max(0, (elapsed * (total - frame)) / frame) : null
        })
        if (frame >= total) finish({ ok: true, cancelled: false, code: 0, outputPath: opts.outputPath, errors: [] })
      }, 100)
      return {
        promise: promise,
        cancel: function () {
          finish({ ok: false, cancelled: true, code: null, outputPath: opts.outputPath, errors: [] })
        }
      }
    },
    checkArgs: function () {
      return Promise.resolve({ comps: [], paths: [] })
    }
  }

  function mockSend(files, outputs) {
    log(t('logSent', { files: files.length, outputs: outputs.length }))
    log(t('logWaiting'))
    return delay(400).then(function () {
      log(t('logAccepted', { n: files.length * outputs.length }), 'ok')
      console.log('[mock] request outputs', JSON.stringify(outputs))
    })
  }

  // ------------------------------------------------------------------ init
  function init() {
    var env = MC.cep.hostEnvironment()
    var mockHostCode = queryParam('host') === 'AEFT' ? 'AEFT' : 'PPRO'
    state.hostCode = env && env.appName ? env.appName : state.mock ? mockHostCode : ''
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
    $('addOutputBtn').addEventListener('click', addRow)
    $('outMode').addEventListener('change', function () {
      var m = $('outMode').value
      lsSet(LS.outMode, m)
      if (m === 'custom' && !lsGet(LS.customDir, '')) chooseOutFolder()
      renderOutput()
    })
    $('browseBtn').addEventListener('click', chooseOutFolder)
    $('goBtn').addEventListener('click', go)
    $('cancelBtn').addEventListener('click', cancelRender)
    global.addEventListener('focus', function () {
      if (!state.busy) refreshHost()
    })
    global.addEventListener('beforeunload', abandonRender)
    global.addEventListener('unload', abandonRender)

    reloadInfo()
    refreshHost()

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

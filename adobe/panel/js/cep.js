// Minimal stand-in for Adobe's CSInterface.js - only what this panel needs, on top of window.__adobe_cep__ / window.cep.
;(function (global) {
  'use strict'
  var MC = global.MC || (global.MC = {})
  var native = global.__adobe_cep__ || null

  function parseJson(s) {
    try {
      return JSON.parse(s)
    } catch (e) {
      return null
    }
  }

  // ExtendScript source literal for a string argument (U+2028/2029 are line terminators in ES3 string literals).
  var LS_CHAR = String.fromCharCode(0x2028)
  var PS_CHAR = String.fromCharCode(0x2029)
  function scriptString(s) {
    return JSON.stringify(String(s)).split(LS_CHAR).join('\\u2028').split(PS_CHAR).join('\\u2029')
  }

  function systemPath(type) {
    if (!native) return ''
    var p = decodeURI(native.getSystemPath(type) || '')
    if (/^file:\/\/\/[A-Za-z]:/.test(p)) return p.replace(/^file:\/\/\//, '')
    return p.replace(/^file:\/\//, '')
  }

  MC.cep = {
    available: !!native,
    hostEnvironment: function () {
      return native ? parseJson(native.getHostEnvironment()) : null
    },
    extensionPath: function () {
      return systemPath('extension')
    },
    /** Resolves with the raw string ExtendScript returned ('EvalScript error.' on failure). */
    evalScript: function (script) {
      return new Promise(function (resolve) {
        if (!native) return resolve('EvalScript error.')
        native.evalScript(script, function (r) {
          resolve(r)
        })
      })
    },
    /** Calls MCHost.<fn>(arg) in the host and resolves with the parsed JSON result (or { ok: false, error }). */
    callHost: function (fn, arg) {
      var script = 'MCHost.' + fn + '(' + (arg === undefined ? '' : scriptString(JSON.stringify(arg))) + ')'
      return MC.cep.evalScript(script).then(function (raw) {
        var r = parseJson(raw)
        return r && typeof r === 'object' ? r : { ok: false, error: 'evalScript', message: String(raw) }
      })
    },
    scriptString: scriptString,
    addEventListener: function (type, fn) {
      if (native && native.addEventListener) native.addEventListener(type, fn)
    },
    /** Folder picker; resolves with a path or null. */
    chooseFolder: function (title, initialPath) {
      return dialog(true, title, initialPath, null)
    },
    /** File picker; resolves with a path or null. */
    chooseFile: function (title, initialPath, extensions) {
      return dialog(false, title, initialPath, extensions)
    }
  }

  function dialog(chooseDirectory, title, initialPath, types) {
    return new Promise(function (resolve) {
      var fsApi = global.cep && global.cep.fs
      if (!fsApi) return resolve(null)
      var r
      try {
        r = fsApi.showOpenDialogEx
          ? fsApi.showOpenDialogEx(false, chooseDirectory, title, initialPath || '', types || undefined)
          : fsApi.showOpenDialog(false, chooseDirectory, title, initialPath || '', types || undefined)
      } catch (e) {
        r = null
      }
      resolve(r && r.err === 0 && r.data && r.data.length ? r.data[0] : null)
    })
  }
})(window)

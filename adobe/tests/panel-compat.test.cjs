'use strict'
// Compatibility guard for the CEP panel (adobe/panel). Premiere Pro CC 2019 runs CEP 9 = Chromium 61 + Node 8.6, so the
// panel stays at ES2017 syntax / 2017-era CSS, and every UI string must exist in zh-TW, en and ja. Plain node:test, no
// dependencies:
//   node --test adobe/tests/panel-compat.test.cjs
const assert = require('node:assert')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const PANEL = path.resolve(__dirname, '..', 'panel')
const JS_DIR = path.join(PANEL, 'js')
const LOCALES = ['zh-TW', 'en', 'ja']

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function panelScripts() {
  return fs
    .readdirSync(JS_DIR)
    .filter((f) => /\.(js|cjs)$/.test(f))
    .sort()
    .map((f) => path.join(JS_DIR, f))
}

// ---------------------------------------------------------------- a small JS scanner
// Keywords after which a "/" starts a regular expression literal (after identifiers, numbers, ")" or "]" it divides).
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])

function regexAllowed(prev) {
  if (prev === '') return true
  if (prev === 'value' || prev === ')' || prev === ']') return false
  if (/^[\w$]+$/.test(prev)) return REGEX_AFTER_WORDS.has(prev)
  return true
}

/**
 * The source with comments, string / template literal text and regular expression literals blanked out (same length,
 * newlines kept, so indexes still map to lines). Code inside template substitutions is kept.
 */
function stripJs(src) {
  const out = []
  const braces = [] // one entry per open "{": true = it opened a template substitution
  const n = src.length
  let i = 0
  let prev = '' // previous significant token: a word, a punctuator, or 'value' (string / regex / template)
  const keep = (s) => out.push(s)
  const blank = (s) => out.push(s.replace(/[^\n]/g, ' '))

  // template text from i (just after "`" or a substitution's "}") up to the closing "`" or the next "${"
  function templateText() {
    let j = i
    while (j < n) {
      if (src[j] === '\\') {
        j += 2
        continue
      }
      if (src[j] === '`') {
        blank(src.slice(i, j))
        keep('`')
        i = j + 1
        prev = 'value'
        return
      }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(src.slice(i, j))
        keep('${')
        i = j + 2
        braces.push(true)
        prev = '{'
        return
      }
      j++
    }
    blank(src.slice(i))
    i = n
  }

  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i)
      if (j < 0) j = n
      blank(src.slice(i, j))
      i = j
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2)
      j = j < 0 ? n : j + 2
      blank(src.slice(i, j))
      i = j
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      keep(c)
      blank(src.slice(i + 1, j))
      keep(c)
      i = j + 1
      prev = 'value'
    } else if (c === '`') {
      keep('`')
      i++
      templateText()
    } else if (c === '/' && regexAllowed(prev)) {
      let j = i + 1
      let inClass = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) break
        j++
      }
      j++
      while (j < n && /[a-z]/i.test(src[j])) j++
      blank(src.slice(i, j))
      i = j
      prev = 'value'
    } else if (c === '{') {
      braces.push(false)
      keep(c)
      i++
      prev = c
    } else if (c === '}') {
      const substitution = braces.pop()
      keep(c)
      i++
      if (substitution) templateText()
      else prev = c
    } else if (/[\w$]/.test(c)) {
      let j = i
      while (j < n && /[\w$]/.test(src[j])) j++
      const word = src.slice(i, j)
      keep(word)
      i = j
      prev = word
    } else if (/\s/.test(c)) {
      keep(c)
      i++
    } else {
      keep(c)
      i++
      prev = c
    }
  }
  return out.join('')
}

// ES2018+ syntax / APIs that CEP 9 (Chromium 61, Node 8.6) does not have
const FORBIDDEN_JS = [
  [/\?\.(?!\d)/g, 'optional chaining ?.'],
  [/\?\?/g, 'nullish coalescing ??'],
  [/\.flat\s*\(/g, '.flat('],
  [/\.flatMap\s*\(/g, '.flatMap('],
  [/\bObject\s*\.\s*fromEntries\b/g, 'Object.fromEntries'],
  [/\breplaceAll\s*\(/g, 'replaceAll('],
  [/\bmatchAll\s*\(/g, 'matchAll('],
  [/\bcatch\s*\{/g, 'optional catch binding "catch {"']
]

// CSS newer than Chromium 61
const FORBIDDEN_CSS = [
  [/\bgap\s*:/g, 'gap: (flexbox gap is Chromium 84)'],
  [/:focus-visible\b/g, ':focus-visible'],
  [/(^|[\s;{])inset\s*:/g, 'inset:'],
  [/\baspect-ratio\b/g, 'aspect-ratio'],
  [/:is\(/g, ':is('],
  [/:where\(/g, ':where(']
]

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

function findForbidden(text, rules) {
  const hits = []
  for (const [re, what] of rules) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) hits.push({ what, line: lineOf(text, m.index) })
  }
  return hits
}

function loadI18n() {
  const sandbox = { window: {}, document: { documentElement: {} } }
  vm.runInNewContext(read(path.join(JS_DIR, 'i18n.js')), sandbox, { filename: 'i18n.js' })
  return sandbox.window.MC.i18n
}

function htmlKeys() {
  const html = read(path.join(PANEL, 'index.html'))
  const keys = new Set()
  const re = /data-i18n(?:-title)?="([^"]+)"/g
  let m
  while ((m = re.exec(html))) keys.add(m[1])
  return keys
}

function mainJsKeys() {
  const src = read(path.join(JS_DIR, 'main.js'))
  const keys = new Set()
  // t('key') / t('key', vars) with a literal key; t('category.' + cat) is dynamic and skipped
  const re = /\bt\(\s*(['"])([^'"\\]+)\1\s*[,)]/g
  let m
  while ((m = re.exec(src))) keys.add(m[2])
  return keys
}

// ---------------------------------------------------------------- tests
test('scanner: strings, comments, regexes and template text are ignored, code is not', () => {
  const src = [
    "var a = '?.' + \"??\" + 'catch {' // ?. ?? .flat(",
    '/* replaceAll( matchAll( */ var r = /a?.b??/g, q = x / 2 / y',
    'var s = `x?.y ${b?.c} z ${`n?.m`}`; d?.e',
    'try { f() } catch (e) { g() }'
  ].join('\n')
  const hits = findForbidden(stripJs(src), FORBIDDEN_JS)
  assert.deepStrictEqual(hits, [
    { what: 'optional chaining ?.', line: 3 },
    { what: 'optional chaining ?.', line: 3 }
  ])
  assert.strictEqual(stripJs(src).length, src.length)
})

test('every panel script passes node --check', () => {
  const files = panelScripts()
  assert.ok(files.some((f) => path.basename(f) === 'main.js'), 'adobe/panel/js/main.js missing')
  for (const file of files) {
    const r = childProcess.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
    assert.strictEqual(r.status, 0, `${path.basename(file)}: ${(r.stderr || r.stdout || '').trim()}`)
  }
})

test('panel scripts use no syntax / API newer than CEP 9 (Chromium 61, Node 8.6)', () => {
  const problems = []
  for (const file of panelScripts()) {
    for (const hit of findForbidden(stripJs(read(file)), FORBIDDEN_JS)) {
      problems.push(`${path.basename(file)}:${hit.line} ${hit.what}`)
    }
  }
  assert.deepStrictEqual(problems, [])
})

test('panel.css uses no CSS newer than Chromium 61', () => {
  const css = read(path.join(PANEL, 'css', 'panel.css')).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const problems = findForbidden(css, FORBIDDEN_CSS).map((h) => `panel.css:${h.line} ${h.what}`)
  assert.deepStrictEqual(problems, [])
})

test('every i18n key used by index.html and main.js exists in zh-TW, en and ja', () => {
  const i18n = loadI18n()
  assert.deepStrictEqual(Array.from(i18n.locales), LOCALES)
  const used = new Set([...htmlKeys(), ...mainJsKeys()])
  assert.ok(used.size > 20, `only ${used.size} keys found - did the key patterns break?`)
  const missing = []
  for (const key of used) {
    for (const loc of LOCALES) if (!i18n.has(key, loc)) missing.push(`${loc}: ${key}`)
  }
  assert.deepStrictEqual(missing, [])
})

test('the three dictionaries have the same keys and no unused ones', () => {
  const i18n = loadI18n()
  const base = Array.from(i18n.keys('en')).sort()
  for (const loc of LOCALES) assert.deepStrictEqual(Array.from(i18n.keys(loc)).sort(), base, `${loc} keys differ from en`)
  const html = read(path.join(PANEL, 'index.html'))
  const main = read(path.join(JS_DIR, 'main.js'))
  const unused = base.filter((key) => {
    if (key.indexOf('category.') === 0) return false // t('category.' + preset.category)
    return html.indexOf(`"${key}"`) < 0 && main.indexOf(`'${key}'`) < 0 && main.indexOf(`"${key}"`) < 0
  })
  assert.deepStrictEqual(unused, [])
})

test('manifest: bundle and extension versions match', () => {
  const xml = read(path.join(PANEL, 'CSXS', 'manifest.xml'))
  const bundle = /ExtensionBundleVersion="([^"]+)"/.exec(xml)
  const ext = /<Extension Id="[^"]+" Version="([^"]+)"/.exec(xml)
  assert.ok(bundle && ext, 'versions not found in manifest.xml')
  assert.match(bundle[1], /^\d+\.\d+\.\d+$/)
  assert.strictEqual(ext[1], bundle[1])
})

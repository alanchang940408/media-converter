'use strict'
// Unit tests for the panel's Node bridge module (adobe/panel/js/bridge-node.cjs). Plain node:test, no dependencies:
//   node --test adobe/tests/bridge-node.test.cjs
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const b = require('../panel/js/bridge-node.cjs')

const ROOT = path.resolve(__dirname, '..', '..')

function tempBridge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bridge-node-'))
  // spaces + CJK on purpose: real user names / folders have them
  const userData = path.join(tmp, '使用者 資料')
  const dir = b.defaultBridgeDir({ MC_USER_DATA_DIR: userData })
  return { tmp, userData, dir, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

test('BRIDGE_VERSION matches src/shared/bridge.ts', () => {
  const ts = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'bridge.ts'), 'utf8')
  const m = /export const BRIDGE_VERSION\s*=\s*(\d+)/.exec(ts)
  assert.ok(m, 'BRIDGE_VERSION not found in src/shared/bridge.ts')
  assert.strictEqual(b.BRIDGE_VERSION, Number(m[1]))
})

test('bridge folder follows MC_USER_DATA_DIR; info.json is read (BOM tolerated) or null', () => {
  const t = tempBridge()
  try {
    assert.strictEqual(t.dir, path.join(t.userData, 'bridge'))
    assert.strictEqual(b.readInfo(t.dir), null)
    b.mkdirp(t.dir)
    fs.writeFileSync(path.join(t.dir, 'info.json'), '{ broken')
    assert.strictEqual(b.readInfo(t.dir), null)
    fs.writeFileSync(path.join(t.dir, 'info.json'), '﻿' + JSON.stringify({ bridgeVersion: 1, presets: [{ id: 'h264-match', kind: 'video' }] }))
    assert.strictEqual(b.readInfo(t.dir).presets[0].id, 'h264-match')
  } finally {
    t.cleanup()
  }
})

test('request: built, validated and written atomically to inbox/<id>.json', () => {
  const t = tempBridge()
  try {
    const id = b.newId('ppro')
    assert.match(id, /^ppro-\d{8}-\d{6}-[a-z0-9]{1,4}$/)
    const inter = b.makeIntermediateDir(t.dir, id)
    const file = path.join(inter, '序列 01.mov')
    fs.writeFileSync(file, 'x')
    const req = b.buildRequest({ id, host: 'premiere', files: [file], presetIds: ['h264-match'], outputDir: t.tmp })
    assert.strictEqual(req.deleteAfter, true)
    assert.strictEqual(req.start, true)
    assert.deepStrictEqual(b.validateRequest(req), [])
    const written = b.writeRequest(t.dir, req)
    assert.strictEqual(written, path.join(t.dir, 'inbox', `${id}.json`))
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(written, 'utf8')), req)
    assert.deepStrictEqual(fs.readdirSync(path.join(t.dir, 'inbox')), [`${id}.json`])

    assert.ok(b.validateRequest({ ...req, files: ['relative.mov'] }).length)
    assert.ok(b.validateRequest({ ...req, presetIds: [] }).length)
    assert.ok(b.validateRequest({ ...req, id: '../x' }).length)
    assert.ok(b.validateRequest({ ...req, deleteAfter: 'yes' }).length)
  } finally {
    t.cleanup()
  }
})

test('results/<id>.json is read only when its id matches, and removed', () => {
  const t = tempBridge()
  try {
    const id = 'ae-20261004-120000-abcd'
    assert.strictEqual(b.readResult(t.dir, id), null)
    b.mkdirp(path.join(t.dir, 'results'))
    const res = path.join(t.dir, 'results', `${id}.json`)
    fs.writeFileSync(res, JSON.stringify({ id: 'other', status: 'accepted' }))
    assert.strictEqual(b.readResult(t.dir, id), null)
    fs.writeFileSync(res, JSON.stringify({ id, status: 'accepted', jobIds: ['j1'], errors: [], handledAt: 1 }))
    assert.strictEqual(b.readResult(t.dir, id).status, 'accepted')
    b.removeResult(t.dir, id)
    assert.ok(!fs.existsSync(res))
  } finally {
    t.cleanup()
  }
})

test('empty intermediates/<id> folders are pruned only when old; files and young folders stay', () => {
  const t = tempBridge()
  try {
    const empty = b.makeIntermediateDir(t.dir, 'empty')
    const full = b.makeIntermediateDir(t.dir, 'full')
    fs.writeFileSync(path.join(full, 'a.mov'), 'x')
    assert.strictEqual(b.pruneEmptyIntermediateDirs(t.dir), 0)
    assert.strictEqual(b.pruneEmptyIntermediateDirs(t.dir, undefined, Date.now() + 7 * 3600 * 1000), 1)
    assert.ok(!fs.existsSync(empty))
    assert.ok(fs.existsSync(path.join(full, 'a.mov')))
  } finally {
    t.cleanup()
  }
})

test('removeDirIfInside only removes folders inside the given parent', () => {
  const t = tempBridge()
  try {
    const root = b.bridgePaths(t.dir).intermediates
    const inter = b.makeIntermediateDir(t.dir, 'x')
    fs.writeFileSync(path.join(inter, 'a.mov'), 'x')
    b.removeDirIfInside(t.tmp, root)
    b.removeDirIfInside(root, root)
    assert.ok(fs.existsSync(path.join(inter, 'a.mov')))
    b.removeDirIfInside(inter, root)
    assert.ok(!fs.existsSync(inter))
    assert.ok(fs.existsSync(root))
  } finally {
    t.cleanup()
  }
})

test('outputs: copied into the request; presetIds default to their unique preset ids, in order', () => {
  const outputs = [
    { presetId: 'h264-1080p', nameTemplate: '序列 01' },
    { presetId: 'prores-422', nameTemplate: null },
    { presetId: 'h264-1080p', nameTemplate: '序列 01 小' },
    { presetId: 'h264-match' }
  ]
  const req = b.buildRequest({ id: 'ppro-x', host: 'premiere', files: [path.resolve('a.mov')], outputs, outputDir: null })
  assert.deepStrictEqual(req.outputs, outputs)
  assert.notStrictEqual(req.outputs, outputs)
  assert.notStrictEqual(req.outputs[0], outputs[0])
  assert.deepStrictEqual(req.presetIds, ['h264-1080p', 'prores-422', 'h264-match'])
  assert.deepStrictEqual(b.validateRequest(req), [])
  // the copy does not follow later edits of the panel's list
  outputs[0].nameTemplate = 'changed'
  outputs.push({ presetId: 'later' })
  assert.strictEqual(req.outputs[0].nameTemplate, '序列 01')
  assert.strictEqual(req.outputs.length, 4)
  // explicit presetIds win
  const both = b.buildRequest({ id: 'ppro-y', host: 'premiere', files: [path.resolve('a.mov')], presetIds: ['h264-match'], outputs: outputs.slice(0, 1) })
  assert.deepStrictEqual(both.presetIds, ['h264-match'])
  assert.strictEqual(both.outputs.length, 1)
})

test('legacy requests (presetIds only) carry no outputs and stay valid', () => {
  const req = b.buildRequest({ id: 'ae-1', host: 'aftereffects', files: [path.resolve('c.mov')], presetIds: ['h264-match'], outputDir: null })
  assert.ok(!Object.prototype.hasOwnProperty.call(req, 'outputs'))
  assert.deepStrictEqual(b.validateRequest(req), [])
  assert.ok(JSON.parse(JSON.stringify(req)).outputs === undefined)
})

test('validateRequest checks outputs when present', () => {
  const base = b.buildRequest({ id: 'ae-2', host: 'aftereffects', files: [path.resolve('c.mov')], presetIds: ['h264-match'], outputDir: null })
  const ok = (outputs) => b.validateRequest(Object.assign({}, base, { outputs })).length === 0
  assert.ok(ok([{ presetId: 'h264-match' }]))
  assert.ok(ok([{ presetId: 'h264-match', nameTemplate: null }, { presetId: 'h264-match', nameTemplate: '{name}_小' }]))
  assert.ok(!ok([]))
  assert.ok(!ok('h264-match'))
  assert.ok(!ok(null))
  assert.ok(!ok([{ presetId: '' }]))
  assert.ok(!ok([{ presetId: 42 }]))
  assert.ok(!ok([{ nameTemplate: 'x' }]))
  assert.ok(!ok([{ presetId: 'h264-match', nameTemplate: 5 }]))
  assert.ok(!ok([{ presetId: 'h264-match' }, null]))
  // buildRequest copies malformed entries as they are, so validateRequest still sees them
  const bad = b.buildRequest({ id: 'ae-3', host: 'aftereffects', files: [path.resolve('c.mov')], outputs: [{ presetId: 'h264-match' }, 'oops'] })
  assert.deepStrictEqual(bad.presetIds, ['h264-match'])
  assert.ok(b.validateRequest(bad).length)
  // no presets at all: presetIds empty → invalid
  const none = b.buildRequest({ id: 'ae-4', host: 'aftereffects', files: [path.resolve('c.mov')], outputs: [] })
  assert.deepStrictEqual(none.presetIds, [])
  assert.ok(b.validateRequest(none).length)
})

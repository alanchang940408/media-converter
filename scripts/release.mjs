#!/usr/bin/env node
// Cut a release: bump the version (package.json + package-lock.json), commit "vX.Y.Z", tag vX.Y.Z and push both.
// The pushed v* tag starts .github/workflows/release.yml, which builds Windows / macOS / Linux and publishes the
// GitHub Release (installer, portable exe, latest.yml, blockmaps) that the installed app updates from.
//
//   npm run release:patch                      0.1.0 → 0.1.1  (fixes)
//   npm run release:minor                      0.1.0 → 0.2.0  (new features)
//   npm run release:major                      0.1.0 → 1.0.0
//   node scripts/release.mjs patch --dry-run   checks only, changes nothing
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'alan940408/media-converter'
const TYPES = ['patch', 'minor', 'major']

const args = process.argv.slice(2)
const type = args.find((a) => !a.startsWith('-'))
const dryRun = args.includes('--dry-run')

function fail(msg) {
  console.error(`\nRelease aborted: ${msg}\n`)
  process.exit(1)
}

if (!TYPES.includes(type)) fail(`usage: node scripts/release.mjs <${TYPES.join('|')}> [--dry-run]`)

function git(...a) {
  return execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOrNull(...a) {
  try {
    return git(...a)
  } catch {
    return null
  }
}

function run(cmd, a, opts = {}) {
  console.log(`> ${[cmd, ...a].join(' ')}`)
  const r = spawnSync(cmd, a, { cwd: root, stdio: 'inherit', ...opts })
  if (r.error) fail(`${cmd} failed to start: ${r.error.message}`)
  if (r.status !== 0) fail(`${cmd} exited with code ${r.status}`)
}

/** npm without a shell: under `npm run`, npm_execpath is npm-cli.js. */
function npm(a) {
  const cli = process.env.npm_execpath
  if (cli && /\.[cm]?js$/i.test(cli)) run(process.execPath, [cli, ...a])
  // fixed arguments only, so the shell is safe here (npm is npm.cmd on Windows)
  else run('npm', a, { shell: process.platform === 'win32' })
}

const readVersion = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

/** Same result as `npm version <type>` (semver.inc) for x.y.z and x.y.z-pre versions. */
function bump(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(v)
  if (!m) return null
  const [major, minor, patch] = m.slice(1, 4).map(Number)
  const pre = !!m[4]
  if (kind === 'major') return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`
  if (kind === 'minor') return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`
  return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
}

// ── checks ──
if (!gitOrNull('rev-parse', '--show-toplevel')) fail('not a git repository.')

const dirty = git('status', '--porcelain')
if (dirty) fail(`the working tree is not clean. Commit or stash these first:\n${dirty}`)

const branch = gitOrNull('symbolic-ref', '--short', '-q', 'HEAD')
if (!branch) fail('HEAD is detached. Check out the branch you release from (e.g. main).')

const upstream = gitOrNull('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
if (!upstream) fail(`branch "${branch}" has no upstream. Push it once with: git push -u origin ${branch}`)

console.log(`Fetching ${upstream}…`)
run('git', ['fetch', '--quiet'])
const behind = Number(git('rev-list', '--count', `HEAD..${upstream}`))
if (behind > 0) fail(`"${branch}" is ${behind} commit(s) behind ${upstream}. Pull first.`)

const current = readVersion()
const next = bump(current, type)
if (!next) fail(`package.json version "${current}" is not x.y.z.`)
const tag = `v${next}`
if (gitOrNull('rev-parse', '-q', '--verify', `refs/tags/${tag}`)) fail(`tag ${tag} already exists locally.`)
const remote = upstream.split('/')[0]
if (gitOrNull('ls-remote', '--tags', remote, `refs/tags/${tag}`)) fail(`tag ${tag} already exists on ${remote}.`)

console.log(`\n${current} → ${next} (${type}) on ${branch}, pushing to ${upstream}`)
if (dryRun) {
  console.log('\n--dry-run: nothing changed. Without it this runs:')
  console.log(`  npm version ${type} -m "v%s"   (package.json + package-lock.json, commit "${tag}", tag ${tag})`)
  console.log('  git push --follow-tags')
  process.exit(0)
}

// ── bump, commit, tag, push ──
npm(['version', type, '-m', 'v%s'])
const bumped = readVersion()
if (bumped !== next) console.warn(`note: npm set the version to ${bumped} (expected ${next}).`)
run('git', ['push', '--follow-tags'])

console.log(`\nPushed v${bumped}. GitHub Actions now builds and publishes the release:`)
console.log(`  https://github.com/${REPO}/actions/workflows/release.yml`)
console.log(`  https://github.com/${REPO}/releases/tag/v${bumped}  (appears once every build has finished)`)

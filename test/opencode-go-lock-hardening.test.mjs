// D2/D3/N3 lock-hardening behavior tests. Every assertion is on observable
// outcomes (store bytes, error name/code/message, lock file contents), not on
// "a function was called". Real OS child processes hold / swap / contend for
// the same lock file the production store derives from the store path.
// All stores are scratch files under os.tmpdir(); the real ~/.dsh is untouched
// and no network requests are made.
//
// De-flake notes (N1): result files are published atomically (temp+rename) by
// the writer fixture, and the holder releases only on an explicit parent signal
// (not a fixed sleep). Before relying on a contention result we re-check the
// holder is still alive and still owns the exact nonce we saw, so a scheduler
// delay can never turn "contended" into "lock silently released".
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadModelsStore, resetModelsStoreCache } from '../lib/remote-catalog.js'

const HERE = new URL('.', import.meta.url).pathname
const LIB_REMOTE = pathToFileURL(join(HERE, '../lib/remote-catalog.js')).href
const STALE_AGE_MS = 20_000 // > LOCK_STALE_MS (10_000)

function lockPathFor(file) {
  return join(tmpdir(), `${createHash('sha256').update(file).digest('hex')}.dsh-store.lock`)
}

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lock-hardening-'))
  const file = join(dir, 'models-store.json')
  const lockPath = lockPathFor(file)
  try {
    await fn({ dir, file, lockPath })
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(lockPath, { force: true })
    resetModelsStoreCache()
  }
}

/** Spawn a child with stderr captured so a timeout error can show why it never signalled. */
function spawnTracked(script, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...env },
  })
  child.stderrText = ''
  child.stderr.on('data', (chunk) => { child.stderrText += chunk })
  child.on('error', (err) => { child.stderrText += `\nspawn error: ${err.message}` })
  return child
}

/**
 * Minimal long-lived process used only as a lock owner PID. The parent writes
 * the lock stamp itself, so the test never waits on a child readiness marker —
 * a slow spawn under parallel test-load can no longer make the test flaky.
 */
function spawnKeeper() {
  const child = spawnTracked('-e', ['setInterval(() => {}, 1000)'])
  assert.ok(Number.isInteger(child.pid) && child.pid > 0, 'keeper must have a live pid')
  return child
}

async function waitForFile(path, timeoutMs = 5000, diagnostic = '') {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await readFile(path, 'utf8')
      return
    } catch {}
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${path}${diagnostic ? ` — ${diagnostic}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fileExists(path) {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

function waitExit(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child exit timeout — ${child.stderrText}`)), timeoutMs)
    const done = (fn, value) => {
      clearTimeout(timer)
      fn(value)
    }
    child.once('error', (err) => done(reject, err))
    child.once('exit', (code, signal) => code === 0
      ? done(resolve)
      : done(reject, new Error(`child exited code=${code} signal=${signal} — ${child.stderrText}`)))
  })
}

function spawnWriter(cfg, extraEnv = {}) {
  return spawnTracked(join(HERE, 'fixtures/lock-writer.mjs'), [JSON.stringify(cfg)], extraEnv)
}

// Atomic result: waitForFile sees the path only after rename, so JSON.parse is
// always reading complete content (no more "Unexpected end of JSON input").
async function readResult(path, diagnostic = '') {
  await waitForFile(path, 5000, diagnostic)
  return JSON.parse(await readFile(path, 'utf8'))
}

function processAlive(child) {
  return child.exitCode === null && child.signalCode === null && !child.killed
}

/** Get a PID that is conclusively gone (ESRCH), so "dead owner" is unambiguous. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  const pid = Number(out.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `bad child pid: ${out}`)
  assert.throws(() => process.kill(pid, 0), (err) => err.code === 'ESRCH', 'pid must be conclusively dead')
  return pid
}

function writeLock(lockPath, owner) {
  return writeFile(lockPath, typeof owner === 'string' ? owner : JSON.stringify(owner))
}

function readLock(lockPath) {
  return readFile(lockPath, 'utf8').then((raw) => JSON.parse(raw))
}

function ageBack(path, ms) {
  const old = new Date(Date.now() - ms)
  return utimes(path, old, old)
}

// ---------------------------------------------------------------------------
// D2 — lock wait timeout is fail-closed
// ---------------------------------------------------------------------------
test('D2: another OS process holding the lock makes the write fail closed (store bytes unchanged)', async () => withStore(async ({ dir, file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const before = await readFile(file, 'utf8')

  // Parent writes the stamp itself (no child readiness marker to race). The
  // keeper process exists only so the stamped PID is genuinely alive.
  const keeper = spawnKeeper()
  const nonce = `live-${randomUUID()}`
  await writeLock(lockPath, { pid: keeper.pid, nonce, createdAt: Date.now() })
  const result = join(dir, 'result.json')
  const writer = spawnWriter({ file, key: 'probe', value: { marked: true }, libRemote: LIB_REMOTE, result })
  try {
    assert.ok(processAlive(keeper), 'keeper must be alive while the writer contends')
    const held = await readLock(lockPath)
    assert.equal(held.pid, keeper.pid, 'keeper must own the lock at assertion time')
    assert.equal(held.nonce, nonce, 'keeper must own the exact nonce at assertion time')

    const res = await readResult(result, `writer stderr: ${writer.stderrText}`)
    assert.ok(processAlive(keeper), 'keeper must still be alive after the contended write')
    assert.equal(res.ok, false, 'a contended lock must not be bypassed')
    assert.equal(res.name, 'StoreLockTimeoutError', 'distinguishable error type')
    assert.equal(res.code, 'DSH_STORE_LOCK_TIMEOUT', 'stable machine-readable code')
    assert.match(res.message, /Timed out after 2000ms waiting for the models-store lock/, 'what happened')
    assert.ok(res.message.includes(lockPath), 'error must name the lock file path')
    assert.match(res.message, /Retry the operation/, 'actionable: retry')
    assert.match(res.message, /check other running dsh processes/i, 'actionable: check other processes')
    assert.equal(await readFile(file, 'utf8'), before, 'store bytes must be unchanged on timeout')
    assert.equal((await readLock(lockPath)).nonce, nonce, 'contender must not delete the keeper lock')
  } finally {
    if (keeper.exitCode === null) keeper.kill()
    if (writer.exitCode === null) writer.kill()
  }
}))

// ---------------------------------------------------------------------------
// D3 — stale break requires age + dead owner + compare-and-delete
// ---------------------------------------------------------------------------
test('D3: over-age lock owned by a dead PID is broken and the write succeeds', async () => withStore(async ({ file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const pid = await deadPid()
  await writeLock(lockPath, { pid, nonce: `stale-${randomUUID()}`, createdAt: Date.now() - STALE_AGE_MS })

  await loadModelsStore(file).writeRaw('probe', { marked: true })

  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc.probe, { marked: true }, 'write must succeed after a validated stale break')
  assert.deepEqual(doc.seed, { v: 1 }, 'existing keys survive')
  assert.equal(await fileExists(lockPath), false, 'stale lock must be released after the guarded write')
}))

test('D3: over-age lock with a LIVE owner PID must NOT be broken (fail closed)', async () => withStore(async ({ dir, file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const before = await readFile(file, 'utf8')

  // Stamp is old, but the owning PID is alive → age alone is not enough.
  const keeper = spawnKeeper()
  const stamp = { pid: keeper.pid, nonce: `stale-${randomUUID()}`, createdAt: Date.now() - STALE_AGE_MS }
  await writeLock(lockPath, stamp)
  const result = join(dir, 'result.json')
  const writer = spawnWriter({ file, key: 'probe', value: { marked: true }, libRemote: LIB_REMOTE, result })
  try {
    assert.ok(processAlive(keeper), 'keeper must be alive')
    assert.ok(Date.now() - stamp.createdAt > 10_000, 'holder stamp must look stale')

    const res = await readResult(result, `writer stderr: ${writer.stderrText}`)
    assert.ok(processAlive(keeper), 'keeper survived the contended write')
    assert.equal(res.ok, false, 'a stale-looking lock with a live owner must not be broken')
    assert.equal(res.name, 'StoreLockTimeoutError')
    assert.equal(await readFile(file, 'utf8'), before, 'store bytes unchanged')
    assert.deepEqual(await readLock(lockPath), stamp, 'live owner lock must be left intact')
  } finally {
    if (keeper.exitCode === null) keeper.kill()
    if (writer.exitCode === null) writer.kill()
  }
}))

test('D3: lock replaced between stale check and delete must not be removed (fail closed)', async () => withStore(async ({ dir, file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const before = await readFile(file, 'utf8')

  const pid = await deadPid()
  await writeLock(lockPath, { pid, nonce: `stale-${randomUUID()}`, createdAt: Date.now() - STALE_AGE_MS })

  const ready = join(dir, 'writer-ready')
  const result = join(dir, 'result.json')
  // The test-only delay widens the compare-and-delete window: the writer has
  // already read the stale owner when the parent swaps in a fresh lock.
  const writer = spawnWriter(
    { file, key: 'probe', value: { marked: true }, libRemote: LIB_REMOTE, ready, result },
    { DSH_LOCK_BREAK_VERIFY_DELAY_MS: '500' },
  )
  const replacement = { pid: process.pid, nonce: `fresh-${randomUUID()}`, createdAt: Date.now() }
  try {
    await waitForFile(ready, 5000, `writer stderr: ${writer.stderrText}`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await writeLock(lockPath, replacement)
    const res = await readResult(result, `writer stderr: ${writer.stderrText}`)
    assert.equal(res.ok, false, 'a replaced lock must not be deleted to let the write through')
    assert.equal(res.name, 'StoreLockTimeoutError')
    assert.equal(await readFile(file, 'utf8'), before, 'store bytes unchanged')
    assert.deepEqual(await readLock(lockPath), replacement, 'the replacement lock must survive')
  } finally {
    if (writer.exitCode === null) writer.kill()
  }
}))

// ---------------------------------------------------------------------------
// N3 — unstamped (empty / unparseable) orphan lock recovery via mtime + byte-compare
// ---------------------------------------------------------------------------
test('N3: over-age unstamped (empty) lock is reclaimed and the write succeeds', async () => withStore(async ({ file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  await writeFile(lockPath, '') // open(wx) succeeded, crash before stamp
  await ageBack(lockPath, STALE_AGE_MS)

  await loadModelsStore(file).writeRaw('probe', { marked: true })

  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc.probe, { marked: true }, 'write must succeed after reclaiming the orphan lock')
  assert.deepEqual(doc.seed, { v: 1 }, 'existing keys survive')
  assert.equal(await fileExists(lockPath), false, 'orphan lock must be released after the guarded write')
}))

test('N3: fresh unstamped (empty) lock is NOT broken (fail closed)', async () => withStore(async ({ dir, file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const before = await readFile(file, 'utf8')
  await writeFile(lockPath, '') // mtime is fresh — not old enough to reclaim

  const result = join(dir, 'result.json')
  const writer = spawnWriter({ file, key: 'probe', value: { marked: true }, libRemote: LIB_REMOTE, result })
  try {
    const res = await readResult(result, `writer stderr: ${writer.stderrText}`)
    assert.equal(res.ok, false, 'a fresh unstamped lock must not be reclaimed')
    assert.equal(res.name, 'StoreLockTimeoutError')
    assert.equal(await readFile(file, 'utf8'), before, 'store bytes unchanged')
    assert.equal(await readFile(lockPath, 'utf8'), '', 'fresh empty lock must be left intact')
  } finally {
    if (writer.exitCode === null) writer.kill()
  }
}))

test('N3: unstamped lock replaced before the break must not be removed', async () => withStore(async ({ dir, file, lockPath }) => {
  await writeFile(file, '{"seed":{"v":1}}')
  const before = await readFile(file, 'utf8')
  await writeFile(lockPath, '')
  await ageBack(lockPath, STALE_AGE_MS)

  const ready = join(dir, 'writer-ready')
  const result = join(dir, 'result.json')
  const writer = spawnWriter(
    { file, key: 'probe', value: { marked: true }, libRemote: LIB_REMOTE, ready, result },
    { DSH_LOCK_BREAK_VERIFY_DELAY_MS: '500' },
  )
  const replacement = JSON.stringify({ pid: process.pid, nonce: `fresh-${randomUUID()}`, createdAt: Date.now() })
  try {
    await waitForFile(ready, 5000, `writer stderr: ${writer.stderrText}`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    await writeLock(lockPath, replacement)
    const res = await readResult(result, `writer stderr: ${writer.stderrText}`)
    assert.equal(res.ok, false, 'a replaced unstamped lock must not be deleted to let the write through')
    assert.equal(res.name, 'StoreLockTimeoutError')
    assert.equal(await readFile(file, 'utf8'), before, 'store bytes unchanged')
    assert.equal(await readFile(lockPath, 'utf8'), replacement, 'the replacement lock must survive')
  } finally {
    if (writer.exitCode === null) writer.kill()
  }
}))

// ---------------------------------------------------------------------------
// Regression — normal single-process and two-process concurrent writes
// ---------------------------------------------------------------------------
test('regression: single-process write is not affected by the hardened lock', async () => withStore(async ({ file, lockPath }) => {
  await loadModelsStore(file).writeRaw('solo', { v: 7 })
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc.solo, { v: 7 })
  assert.equal(await fileExists(lockPath), false, 'lock is released after a normal write')
}))

test('regression: two real OS processes writing 30 keys each lose none', async () => withStore(async ({ dir, file }) => {
  const start = join(dir, 'start')
  const cfg = (profile) => ({ file, profile, count: 30, barrier: start, libRemote: LIB_REMOTE })
  const child1 = spawnWriter(cfg('P1'))
  const child2 = spawnWriter(cfg('P2'))
  try {
    await writeFile(start, 'go')
    await Promise.all([waitExit(child1), waitExit(child2)])
    const doc = JSON.parse(await readFile(file, 'utf8'))
    for (const profile of ['P1', 'P2']) {
      for (let i = 0; i < 30; i += 1) {
        const key = `${profile}#go-fp-${i}`
        assert.deepEqual(doc[key], { managed: { [i]: { hash: 'h' } } }, `lost concurrent write: ${key}`)
      }
    }
  } finally {
    if (child1.exitCode === null) child1.kill()
    if (child2.exitCode === null) child2.kill()
  }
}))

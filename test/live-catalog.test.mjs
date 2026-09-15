// Live builtin-catalog loader tests.
//
// The loader must prefer the host's live pi-ai data (located via
// DSH_CLOSURE_DIR in tests) over the frozen snapshot, and degrade to
// undefined per-route (callers then fall back to the snapshot) when the
// route file is missing. Regression context: a stale snapshot made
// keepBuiltinOnly emit grok-4.5 after pi-ai 0.84.4 dropped it, and the
// alpha line's strict llm-pi-ai registration rejected the whole namespace.
//
// Discovery also has to stay off the host's event loop and stay lazy: the
// probes spawn `which`/`npm` on the loop 5s after every boot, and the
// synchronous form froze every surface ~0.2s per round (2026-09-15). The
// last two tests pin both properties with PATH shims.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshLiveCatalog, getLiveBuiltinCatalogForRoute } from '../lib/live-catalog.js'

/** Build a fake host closure: <root>/node_modules with both sibling scopes. */
function makeFakeClosure(routes) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-sync-live-'))
  const closure = join(root, 'node_modules', '@deepseek-ai')
  const dataDir = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data')
  mkdirSync(closure, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  for (const [route, models] of Object.entries(routes)) {
    const byApi = {}
    for (const model of models) {
      byApi[model.api] = byApi[model.api] ?? {}
      byApi[model.api][model.id] = model
    }
    writeFileSync(join(dataDir, `${route}.json`), JSON.stringify(byApi))
  }
  return { root, closure, dataDir }
}

/** Write an executable /bin/sh shim named `name` into `dir`; returns its path. */
function makeShim(dir, name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

/** Run `fn` with PATH prefixed by `dir`, restoring the environment afterwards. */
async function withPathPrefix(dir, fn) {
  const previous = process.env.PATH
  process.env.PATH = `${dir}:${previous ?? ''}`
  try {
    return await fn()
  } finally {
    process.env.PATH = previous
  }
}

test('live catalog wins over the snapshot when DSH_CLOSURE_DIR resolves', async () => {
  const { closure } = makeFakeClosure({
    'opencode-go': [
      { id: 'live-only-model', api: 'openai-completions', maxTokens: 4096 },
    ],
  })
  process.env.DSH_CLOSURE_DIR = closure
  await refreshLiveCatalog(['opencode-go'])

  const live = getLiveBuiltinCatalogForRoute('opencode-go')
  assert.ok(Array.isArray(live), 'live catalog should be loaded')
  // An id the frozen snapshot cannot know — proof the data came from the
  // host closure, not the snapshot.
  assert.ok(live.some(m => m.id === 'live-only-model'), 'live-only model present')
  delete process.env.DSH_CLOSURE_DIR
})

test('missing route file degrades to undefined → callers fall back to snapshot', async () => {
  const { closure } = makeFakeClosure({ 'opencode-go': [{ id: 'x', api: 'openai-completions' }] })
  process.env.DSH_CLOSURE_DIR = closure
  await refreshLiveCatalog(['opencode-go', 'zai-coding-cn'])

  assert.ok(Array.isArray(getLiveBuiltinCatalogForRoute('opencode-go')))
  assert.equal(getLiveBuiltinCatalogForRoute('zai-coding-cn'), undefined, 'unreadable route → undefined')
  assert.equal(getLiveBuiltinCatalogForRoute('never-seeded-route'), undefined)
  delete process.env.DSH_CLOSURE_DIR
})

test('a bogus DSH_CLOSURE_DIR falls through to real discovery — fixture data must not leak', async () => {
  process.env.DSH_CLOSURE_DIR = join(tmpdir(), `no-such-closure-${Date.now()}`)
  await refreshLiveCatalog(['opencode-go'])
  const live = getLiveBuiltinCatalogForRoute('opencode-go')
  if (live === undefined) return // no host install on this machine — fallback is the only correct outcome
  // With a real dsh install the fall-through resolves it; the bogus
  // override's (nonexistent) data must never surface.
  assert.equal(live.some(m => m.id === 'live-only-model'), false, 'fixture data from a bogus override must not leak')
  delete process.env.DSH_CLOSURE_DIR
})

test('a working `which dsh` hit skips the npm probe entirely', async () => {
  const { root } = makeFakeClosure({ 'opencode-go': [{ id: 'via-which', api: 'openai-completions' }] })
  const shims = mkdtempSync(join(tmpdir(), 'dsh-model-sync-shims-'))
  const marker = join(shims, 'npm-was-called')
  // `which dsh` reports <root>/lib/bin.js → dirname(dirname()) is the fake
  // closure root, exactly the layout the real CLI presents.
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'bin.js'), '')
  makeShim(shims, 'which', `echo ${join(root, 'lib', 'bin.js')}; exit 0`)
  makeShim(shims, 'npm', `touch ${marker}; exit 1`)

  delete process.env.DSH_CLOSURE_DIR
  const live = await withPathPrefix(shims, async () => {
    await refreshLiveCatalog(['opencode-go'])
    return getLiveBuiltinCatalogForRoute('opencode-go')
  })

  assert.ok(live?.some(m => m.id === 'via-which'), 'the which-dsh candidate must win')
  assert.equal(existsSync(marker), false, 'npm must not be spawned once which-dsh resolved')
})

test('discovery never blocks the event loop (no synchronous subprocess)', async () => {
  const shims = mkdtempSync(join(tmpdir(), 'dsh-model-sync-shims-'))
  // Both probes hang for 200ms and then fail: the round must still leave the
  // loop free to run timers while it waits.
  makeShim(shims, 'which', 'sleep 0.2; exit 1')
  makeShim(shims, 'npm', 'sleep 0.2; exit 1')
  process.env.DSH_CLOSURE_DIR = join(tmpdir(), `no-such-closure-${Date.now()}`)

  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  try {
    await withPathPrefix(shims, () => refreshLiveCatalog(['opencode-go']))
  } finally {
    clearInterval(timer)
    delete process.env.DSH_CLOSURE_DIR
  }

  // The old synchronous form blocked the loop for the whole subprocess wait —
  // zero ticks. Async form: ~20.
  assert.ok(ticks >= 4, `event loop must keep ticking during discovery (saw ${ticks})`)
  assert.equal(getLiveBuiltinCatalogForRoute('opencode-go'), undefined, 'no host found → cache cleared')
})

// Live builtin-catalog loader tests.
//
// The loader must prefer the host's live pi-ai data (located via
// DSH_CLOSURE_DIR in tests) over the frozen snapshot, and degrade to
// undefined per-route (callers then fall back to the snapshot) when the
// route file is missing. Regression context: a stale snapshot made
// keepBuiltinOnly emit grok-4.5 after pi-ai 0.84.4 dropped it, and the
// alpha line's strict llm-pi-ai registration rejected the whole namespace.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
  return { closure, dataDir }
}

test('live catalog wins over the snapshot when DSH_CLOSURE_DIR resolves', () => {
  const { closure } = makeFakeClosure({
    'opencode-go': [
      { id: 'live-only-model', api: 'openai-completions', maxTokens: 4096 },
    ],
  })
  process.env.DSH_CLOSURE_DIR = closure
  refreshLiveCatalog(['opencode-go'])

  const live = getLiveBuiltinCatalogForRoute('opencode-go')
  assert.ok(Array.isArray(live), 'live catalog should be loaded')
  // An id the frozen snapshot cannot know — proof the data came from the
  // host closure, not the snapshot.
  assert.ok(live.some(m => m.id === 'live-only-model'), 'live-only model present')
  delete process.env.DSH_CLOSURE_DIR
})

test('missing route file degrades to undefined → callers fall back to snapshot', () => {
  const { closure } = makeFakeClosure({ 'opencode-go': [{ id: 'x', api: 'openai-completions' }] })
  process.env.DSH_CLOSURE_DIR = closure
  refreshLiveCatalog(['opencode-go', 'zai-coding-cn'])

  assert.ok(Array.isArray(getLiveBuiltinCatalogForRoute('opencode-go')))
  assert.equal(getLiveBuiltinCatalogForRoute('zai-coding-cn'), undefined, 'unreadable route → undefined')
  assert.equal(getLiveBuiltinCatalogForRoute('never-seeded-route'), undefined)
  delete process.env.DSH_CLOSURE_DIR
})

test('a bogus DSH_CLOSURE_DIR falls through to real discovery — fixture data must not leak', () => {
  process.env.DSH_CLOSURE_DIR = join(tmpdir(), `no-such-closure-${Date.now()}`)
  refreshLiveCatalog(['opencode-go'])
  const live = getLiveBuiltinCatalogForRoute('opencode-go')
  if (live === undefined) return // no host install on this machine — fallback is the only correct outcome
  // With a real dsh install the fall-through resolves it; the bogus
  // override's (nonexistent) data must never surface.
  assert.equal(live.some(m => m.id === 'live-only-model'), false, 'fixture data from a bogus override must not leak')
  delete process.env.DSH_CLOSURE_DIR
})

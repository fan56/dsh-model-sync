// Plan C (settings-seam): tests for the remote-catalog module.

/**
 * Tests for remote-catalog.ts — covers fetchRemoteCatalog with mocked fetch,
 * ETag caching, modelsStore read/write (B5: uses tmpdir, never touches real store).
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRemoteCatalog,
  loadModelsStore,
  resetModelsStoreCache,
  fetchRemoteCatalog,
} from '../lib/remote-catalog.js'

let failed = 0
let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

/** Create a temp dir with a models-store.json path for isolated testing. */
async function createTmpStorePath() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-sync-test-'))
  return { dir, storePath: join(dir, 'models-store.json') }
}

// ---------------------------------------------------------------------------
// parseRemoteCatalog
// ---------------------------------------------------------------------------
check('parseRemoteCatalog: handles array input', () => {
  const result = parseRemoteCatalog('test', [
    { id: 'm1', api: 'openai-completions' },
    { id: 'm2', api: 'openai-completions' },
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].id, 'm1')
  assert.equal(result[0].provider, 'test')
})

check('parseRemoteCatalog: handles { models: [...] } input', () => {
  const result = parseRemoteCatalog('test', { models: [{ id: 'm1', api: 'openai-completions' }] })
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'm1')
})

check('parseRemoteCatalog: handles object of entries input', () => {
  const result = parseRemoteCatalog('test', {
    a: { id: 'm1', api: 'openai-completions' },
    b: { id: 'm2', api: 'openai-completions' },
  })
  assert.equal(result.length, 2)
})

check('parseRemoteCatalog: throws on invalid input', () => {
  assert.throws(() => parseRemoteCatalog('test', 'invalid'))
  assert.throws(() => parseRemoteCatalog('test', null))
})

check('parseRemoteCatalog: filters non-object entries', () => {
  const result = parseRemoteCatalog('test', [
    { id: 'm1', api: 'openai-completions' },
    null,
    'string',
    { id: 'm2', api: 'openai-completions' },
  ])
  assert.equal(result.length, 2)
})

// ---------------------------------------------------------------------------
// parseRemoteCatalog: I-11 — validate typeof id/api === 'string'
// ---------------------------------------------------------------------------
check('parseRemoteCatalog: I-11 — filters entries without string id', () => {
  const result = parseRemoteCatalog('test', [
    { id: 'valid', api: 'openai-completions' },
    { id: 123, api: 'openai-completions' },
    { api: 'openai-completions' },
    { id: null, api: 'openai-completions' },
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'valid')
})

check('parseRemoteCatalog: I-11 — filters entries without string api', () => {
  const result = parseRemoteCatalog('test', [
    { id: 'valid', api: 'openai-completions' },
    { id: 'no-api' },
    { id: 'null-api', api: null },
    { id: 'num-api', api: 123 },
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].id, 'valid')
})

// ---------------------------------------------------------------------------
// loadModelsStore: singleton pattern (uses default path check only)
// ---------------------------------------------------------------------------
check('loadModelsStore: returns same instance for default path', () => {
  resetModelsStoreCache()
  const a = loadModelsStore()
  const b = loadModelsStore()
  assert.strictEqual(a, b, 'should return the same singleton')
  resetModelsStoreCache()
})

// ---------------------------------------------------------------------------
// loadModelsStore: custom storePath creates fresh accessor (B5)
// ---------------------------------------------------------------------------
await checkAsync('loadModelsStore: custom storePath uses isolated file', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const entry = {
      models: [{ id: 'test-model', name: 'Test', api: 'openai-completions', provider: 'test', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now(),
      lastModified: Date.now(),
      etag: '"test-etag"',
    }
    await store.write('test-route', entry)
    const result = await store.read('test-route')
    assert.ok(result, 'should read back the entry')
    assert.equal(result.models[0].id, 'test-model')
    assert.equal(result.etag, '"test-etag"')

    // Delete
    await store.delete('test-route')
    const afterDelete = await store.read('test-route')
    assert.equal(afterDelete, undefined, 'should be deleted')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// ---------------------------------------------------------------------------
// loadModelsStore: read returns undefined for missing route
// ---------------------------------------------------------------------------
await checkAsync('loadModelsStore: read returns undefined for missing route', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const result = await store.read('nonexistent-route-xyz')
    assert.equal(result, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// ---------------------------------------------------------------------------
// I-4: fetchRemoteCatalog with mocked fetch
// ---------------------------------------------------------------------------
await checkAsync('fetchRemoteCatalog: I-4a — 200 returns parsed entries', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const mockModels = [{ id: 'm1', name: 'M1', api: 'openai-completions' }]
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify(mockModels), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"etag1"' },
    })
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries.length, 1)
      assert.equal(result.entries[0].id, 'm1')
      assert.equal(result.fromCache, false)
      // Verify it was persisted
      const stored = await store.read('test-route')
      assert.ok(stored, 'should have persisted')
      assert.equal(stored.models.length, 1)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

await checkAsync('fetchRemoteCatalog: I-4b — 304 returns cached entries', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Seed the cache
    const cachedEntry = {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 10000,
      lastModified: Date.now(),
      etag: '"etag-cached"',
    }
    await store.write('test-route', cachedEntry)

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 304 })
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries.length, 1)
      assert.equal(result.entries[0].id, 'cached')
      assert.equal(result.fromCache, true)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

await checkAsync('fetchRemoteCatalog: I-4c — network error returns cached entries', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Seed the cache with old checkedAt to bypass throttle
    const cachedEntry = {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 5 * 60 * 60 * 1000, // 5 hours ago (past 4h throttle)
      lastModified: Date.now(),
      etag: '"etag-cached"',
    }
    await store.write('test-route', cachedEntry)

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries.length, 1)
      assert.equal(result.entries[0].id, 'cached')
      assert.ok(result.error, 'should have error')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

await checkAsync('fetchRemoteCatalog: I-4d — 404 returns empty entries', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 404 })
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries.length, 0)
      assert.equal(result.fromCache, false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

await checkAsync('fetchRemoteCatalog: I-4e — 501 returns empty entries', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 501 })
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries.length, 0)
      assert.equal(result.fromCache, false)
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// ---------------------------------------------------------------------------
// modelOverrides preservation: the catalog refresh must carry the route's
// stored `overrides` through every write path, like the ETag — otherwise the
// writer's fold+unset+persist would be wiped on the next refresh and the
// v0.1.5 data-loss bug would return.
// ---------------------------------------------------------------------------
await checkAsync('fetchRemoteCatalog preserves stored overrides across refresh writes (200/304/404/501/503)', async () => {
  const overrides = { 'model-a': { contextWindow: 8192 } }
  const cachedModels = [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }]

  for (const status of [200, 304, 404, 501, 503]) {
    const { dir, storePath } = await createTmpStorePath()
    try {
      resetModelsStoreCache()
      const store = loadModelsStore(storePath)
      // Old checkedAt so the 4h throttle never short-circuits the fetch.
      await store.write('test-route', {
        models: cachedModels,
        checkedAt: Date.now() - 5 * 60 * 60 * 1000,
        lastModified: Date.now(),
        etag: '"etag-cached"',
        overrides,
      })

      const origFetch = globalThis.fetch
      globalThis.fetch = async () => status === 200
        ? new Response(JSON.stringify([{ id: 'fresh', name: 'Fresh', api: 'openai-completions' }]), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"etag-fresh"' },
          })
        : new Response(null, { status })
      try {
        const result = await fetchRemoteCatalog('test-route', 5000, store)
        const stored = await store.read('test-route')
        assert.deepEqual(stored.overrides, overrides, `status ${status}: overrides must survive the refresh write`)
        if (status === 200) {
          assert.equal(stored.models[0].id, 'fresh', 'status 200: fresh models stored')
          assert.equal(stored.etag, '"etag-fresh"')
        } else if (status === 304) {
          assert.equal(result.fromCache, true, 'status 304: cached entries served')
          assert.equal(stored.models[0].id, 'cached')
        } else if (status === 404 || status === 501) {
          assert.equal(result.entries.length, 0, `status ${status}: empty overlay returned`)
        } else {
          assert.ok(result.error, 'status 503: transient failure reported')
          assert.equal(stored.models[0].id, 'cached', 'status 503: cached entries kept')
        }
      } finally {
        globalThis.fetch = origFetch
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      resetModelsStoreCache()
    }
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

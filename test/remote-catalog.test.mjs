// Plan C (settings-seam): tests for the remote-catalog module.

/**
 * Tests for remote-catalog.ts — covers fetchRemoteCatalog with mocked fetch,
 * ETag caching, modelsStore read/write (B5: uses tmpdir, never touches real store).
 */

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
// Fail-closed read: readDoc distinguishes ENOENT (a normal first run) from
// every other failure (corrupt JSON, EACCES, …). The latter propagate so the
// writer can fail closed (settings.models is the authoritative fallback)
// instead of silently clobbering user-folded values on the next replay.
// ---------------------------------------------------------------------------

// ENOENT first run: file does not exist → read returns undefined for any
// route. The accessor does NOT auto-create the file (write is explicit).
await checkAsync('loadModelsStore: ENOENT first run → read returns undefined, no file is auto-created', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const result = await store.read('any-route')
    assert.equal(result, undefined, 'ENOENT → empty doc → undefined for the route')
    // The accessor must not have materialized the file on read.
    const files = await readdir(dir)
    assert.equal(files.length, 0, 'no file is created by a read')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// Corrupt JSON: garbage in the file → read rejects with the parse error.
// The previous behavior swallowed every error and returned {}, which let
// the writer's replay overwrite settings.models with raw pi.dev values.
await checkAsync('loadModelsStore: corrupt JSON → read rejects with the SyntaxError', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    await writeFile(storePath, '{not valid json', 'utf8')
    const store = loadModelsStore(storePath)
    await assert.rejects(
      () => store.read('any-route'),
      (err) => err instanceof SyntaxError,
      'corrupt store must surface the parse error so the writer can fail closed',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// Atomic write (tmp + rename): the staging temp file must not linger after
// a successful write. A concurrent reader either sees the pre-rename doc
// or the post-rename doc — never a half-written file.
await checkAsync('loadModelsStore: atomic write — no tmp file lingers after a successful write', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    await store.write('test-route', {
      models: [{ id: 'm', name: 'M', api: 'openai-completions' }],
      checkedAt: 1,
      lastModified: 1,
      etag: '"e"',
    })
    const files = (await readdir(dir)).sort()
    assert.deepEqual(files, ['models-store.json'], `no tmp staging file: got ${JSON.stringify(files)}`)
    const content = await readFile(storePath, 'utf8')
    assert.equal(content, JSON.stringify({
      'test-route': {
        models: [{ id: 'm', name: 'M', api: 'openai-completions' }],
        checkedAt: 1,
        lastModified: 1,
        etag: '"e"',
      },
    }))
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// Atomic write heals a corrupt file: a well-formed write replaces the bad
// JSON atomically via rename(2), so the next read returns the new entry
// (and no longer rejects with SyntaxError). This is the auto-heal path for
// the v0.1.5 data-loss shape: settings-wins lands a fresh entry with the
// overrides, and the next refresh is clean.
await checkAsync('loadModelsStore: atomic write heals a corrupt file (next read returns the fresh entry)', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    await writeFile(storePath, 'this is not json {', 'utf8')
    const corruptStore = loadModelsStore(storePath)
    await assert.rejects(() => corruptStore.read('any-route'))

    const healStore = loadModelsStore(storePath)
    const freshEntry = {
      models: [{ id: 'healed', name: 'Healed', api: 'openai-completions' }],
      checkedAt: 2,
      lastModified: 2,
      etag: '"healed-etag"',
      overrides: { 'healed': { contextWindow: 8192 } },
    }
    await healStore.write('test-route', freshEntry)
    const readBack = await healStore.read('test-route')
    assert.deepEqual(readBack, freshEntry, 'atomic rename replaced the corrupt file with a well-formed entry')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// ---------------------------------------------------------------------------
// C1 fix (2026-09-04): update() / updateOverrides() — the queue-internal
// read-modify-write surface that makes the four fetch-side write paths
// safe against concurrent rounds. The fetch no longer carries `overrides`
// forward from its pre-fetch snapshot; it patches only fetch-owned
// fields, and the accessor's queue-internal merge preserves everything
// else (notably `overrides`) from whatever the route currently holds.
// ---------------------------------------------------------------------------

// update() preserves the route's existing overrides while patching the
// fetch-owned fields. Verified across every status path with a contrived
// pre-existing overrides payload that mirrors what persistOverridesToStore
// would have staged in a prior round.
await checkAsync('update() preserves overrides across the fetch-side write paths (200/304/404/501/503)', async () => {
  const overrides = { 'model-a': { contextWindow: 8192 } }
  const cachedModels = [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }]

  for (const status of [200, 304, 404, 501, 503]) {
    const { dir, storePath } = await createTmpStorePath()
    try {
      resetModelsStoreCache()
      const store = loadModelsStore(storePath)
      await store.write('test-route', {
        models: cachedModels,
        checkedAt: Date.now() - 5 * 60 * 60 * 1000, // past the 4h throttle
        lastModified: 100,
        etag: '"old"',
        overrides,
      })

      const origFetch = globalThis.fetch
      globalThis.fetch = async () => status === 200
        ? new Response(JSON.stringify([{ id: 'fresh', name: 'Fresh', api: 'openai-completions' }]), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"fresh"' },
          })
        : new Response(null, { status })
      try {
        await fetchRemoteCatalog('test-route', 5000, store)
        const stored = await store.read('test-route')
        assert.deepEqual(stored.overrides, overrides,
          `status ${status}: pre-existing overrides must survive the fetch-side update`)
        // The fetch-owned fields are refreshed.
        if (status === 200) {
          assert.equal(stored.models[0].id, 'fresh')
          assert.equal(stored.etag, '"fresh"')
        } else if (status === 304) {
          assert.equal(stored.models[0].id, 'cached')
          assert.equal(stored.etag, '"old"', '304 keeps the cached etag (refresh checkedAt only)')
        } else if (status === 404 || status === 501) {
          assert.equal(stored.models[0].id, 'cached', '404/501 keep the cached models (empty overlay)')
          assert.equal(stored.etag, '"old"', '404/501 preserve the cached etag (seed: patch omits etag → falls through to current)')
        } else {
          // 503: cached entries kept; etag preserved (not cleared — the
          // server didn't say the resource is gone, just that this
          // request failed).
          assert.equal(stored.models[0].id, 'cached')
          assert.equal(stored.etag, '"old"', '503 keeps the cached etag for the next conditional')
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

// update() does not invent or touch an absent `overrides` field (B1).
//
// The real regression lock is the race test below: the fetch-side call
// sites must not carry `overrides: stored?.overrides` forward, or a
// concurrent stage (a writer's `persistOverridesToStore`) would be
// clobbered on the write-back. This test pins the negative contract on
// the entry that had no overrides to begin with: the fetch must not
// introduce or remove the field. The positive contract (overrides
// survive the fetch) is locked by the "update() preserves overrides…"
// test above.
await checkAsync('update() does not invent or touch an absent overrides field', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Pre-seed with only fetch-owned fields (no overrides at all).
    const pre = {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      lastModified: 100,
      etag: '"old"',
    }
    await store.write('test-route', pre)

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'fresh', name: 'Fresh', api: 'openai-completions' }]), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"fresh"' },
    })
    try {
      await fetchRemoteCatalog('test-route', 5000, store)
      const stored = await store.read('test-route')
      // The patch only mentions fetch-owned fields; the seed preserves
      // the absent `overrides` field (falls through to current.overrides
      // which is undefined). Crucially, no `overrides` field is
      // introduced or removed by the fetch write.
      assert.equal(stored.overrides, undefined,
        'fetch-side update must not touch the overrides field on an entry that had none')
      assert.equal(stored.models[0].id, 'fresh')
      assert.equal(stored.etag, '"fresh"')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// updateOverrides() merges cleanly with whatever the route currently
// holds. Models / checkedAt / lastModified / etag stay intact across a
// stage.
await checkAsync('updateOverrides() preserves fetch-owned fields while replacing only overrides', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    await store.write('test-route', {
      models: [{ id: 'm', name: 'M', api: 'openai-completions' }],
      checkedAt: 100,
      lastModified: 200,
      etag: '"e"',
    })
    const overrides = { 'm': { contextWindow: 8192 } }
    await store.updateOverrides('test-route', overrides)
    const stored = await store.read('test-route')
    assert.deepEqual(stored.overrides, overrides)
    assert.equal(stored.checkedAt, 100)
    assert.equal(stored.lastModified, 200)
    assert.equal(stored.etag, '"e"')
    assert.equal(stored.models[0].id, 'm')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// update() on ENOENT: the route did not exist yet. The merge treats the
// missing current entry as `{}`, so the patch supplies whatever it names
// and every other field lands with the per-field default. B1: the seed
// guarantees the entry is well-formed even when the patch only carries a
// subset of fields — no more `{overrides}-only` incomplete shapes.
await checkAsync('update() on ENOENT route → entry created from the patch only, missing fields get seeded defaults', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Partial patch: only `models` is named. The seed must fill in the
    // rest — checkedAt with a current timestamp, lastModified with 0,
    // etag and overrides with undefined. This is the regression lock on
    // the entry-shape invariant (B1): without the seed, the persisted
    // entry would lack checkedAt/lastModified/etag and the next round
    // would crash on `stored.checkedAt` / `stored.models.length`.
    await store.update('test-route', {
      models: [{ id: 'm', name: 'M', api: 'openai-completions' }],
    })
    const stored = await store.read('test-route')
    assert.deepEqual(stored.models, [{ id: 'm', name: 'M', api: 'openai-completions' }])
    assert.equal(typeof stored.checkedAt, 'number', 'B1: checkedAt seeded to a timestamp even when the patch omits it')
    assert.ok(stored.checkedAt > 0, 'B1: checkedAt is a real wall-clock timestamp')
    assert.equal(stored.lastModified, 0, 'B1: lastModified seeded to 0 when the patch omits it')
    assert.equal(stored.etag, undefined, 'B1: etag seeded to undefined when the patch omits it')
    assert.equal(stored.overrides, undefined, 'B1: overrides seeded to undefined when the patch omits it')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// update() / updateOverrides() on a corrupt file: the queue-internal read
// catches, treats the doc as empty, and the atomic writeDoc heals the
// file. The read-stays-strict contract on the accessor's `read()` is
// preserved — it's the merge inside the queue that tolerates the failure.
// B1: the field-level seed guarantees the healed entry has the full
// shape — models is always `[]` at minimum and checkedAt is always a
// timestamp, regardless of which method healed the file. This is the
// entry-shape invariant that protects the next round's
// `fetchRemoteCatalog` from a stale-read TypeError on `stored.models.length`.
await checkAsync('update() / updateOverrides() heal a corrupt store file via the atomic writeDoc', async () => {
  // update() path: corrupt → write a fresh entry.
  {
    const { dir, storePath } = await createTmpStorePath()
    try {
      resetModelsStoreCache()
      await writeFile(storePath, '{not valid json', 'utf8')
      const store = loadModelsStore(storePath)
      await store.update('test-route', {
        models: [{ id: 'healed-via-update', name: 'H', api: 'openai-completions' }],
        checkedAt: 1,
        lastModified: 1,
        etag: '"e"',
      })
      const readBack = await store.read('test-route')
      assert.equal(readBack.models[0].id, 'healed-via-update', 'update heals the corrupt file')
      assert.deepEqual(readBack.overrides, undefined, 'no overrides seeded when the patch did not name it')
    } finally {
      await rm(dir, { recursive: true, force: true })
      resetModelsStoreCache()
    }
  }

  // updateOverrides() path: corrupt → write a fresh entry carrying the
  // overrides; the seed fills every other field with a sensible default
  // so the next round's fetch sees a well-formed entry (B1). The fetch
  // side will fill in the actual catalog values on its next round.
  {
    const { dir, storePath } = await createTmpStorePath()
    try {
      resetModelsStoreCache()
      await writeFile(storePath, '{still not valid', 'utf8')
      const store = loadModelsStore(storePath)
      await store.updateOverrides('test-route', { 'm1': { contextWindow: 8192 } })
      const readBack = await store.read('test-route')
      assert.deepEqual(readBack.overrides, { 'm1': { contextWindow: 8192 } },
        'updateOverrides heals the corrupt file and stages the overrides')
      assert.deepEqual(readBack.models, [],
        'B1: updateOverrides seeds models to [] (entry shape invariant — the fetch side populates the real entries on its next round)')
      assert.equal(typeof readBack.checkedAt, 'number',
        'B1: updateOverrides seeds checkedAt to a timestamp (entry shape invariant)')
      assert.equal(readBack.lastModified, 0,
        'B1: updateOverrides seeds lastModified to 0 (entry shape invariant)')
      assert.equal(readBack.etag, undefined,
        'B1: updateOverrides seeds etag to undefined (entry shape invariant)')
    } finally {
      await rm(dir, { recursive: true, force: true })
      resetModelsStoreCache()
    }
  }
})

// ---------------------------------------------------------------------------
// C1 race regression: pre-fetch snapshot captured, then a concurrent
// `updateOverrides` writes new overrides, then the fetch completes its
// own update with the stale snapshot's data. Under the OLD carry-forward
// design the write-back would have clobbered the concurrent stage
// (re-attaching the snapshot's overrides). Under the NEW merge design the
// stage survives by construction: the fetch writes only fetch-owned
// fields, the queue-internal merge preserves whatever overrides the
// route currently holds.
// ---------------------------------------------------------------------------

// Accessor-level race: drive update() and updateOverrides() manually to
// reproduce the exact interleaving the bug report describes.
await checkAsync('race: staged overrides survive a fetch-side update that runs after them (accessor level)', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Pre-seed the route: a prior round fetched and persisted the catalog
    // metadata (no overrides yet).
    await store.write('test-route', {
      models: [{ id: 'model-a', name: 'M1', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: 100,
      lastModified: 100,
      etag: '"old"',
    })

    // Step 1: Round A's fetch reads its snapshot (overrides: undefined).
    const snapshot = await store.read('test-route')
    assert.equal(snapshot.overrides, undefined, 'pre-fetch snapshot has no overrides')

    // Step 2: Round B's writer stages overrides (concurrent round).
    await store.updateOverrides('test-route', { 'model-a': { contextWindow: 8192 } })

    // Step 3: Round A's fetch completes its network round and writes its
    // own update — this is where the OLD design clobbered (re-attached
    // snapshot.overrides = undefined → wiped the stage). The NEW design
    // patches only fetch-owned fields.
    await store.update('test-route', {
      models: [{ id: 'model-a', name: 'M1 v2', api: 'openai-completions' }],
      checkedAt: 200,
      lastModified: 200,
      etag: '"new"',
    })

    const final = await store.read('test-route')
    assert.deepEqual(final.overrides, { 'model-a': { contextWindow: 8192 } },
      'C1 fix: overrides staged by the concurrent round survive the fetch-side update')
    assert.equal(final.models[0].name, 'M1 v2', 'fetch-side models applied')
    assert.equal(final.checkedAt, 200)
    assert.equal(final.lastModified, 200)
    assert.equal(final.etag, '"new"')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// fetchRemoteCatalog-level race: drive the full API end-to-end with a
// fetch that pauses until we release it, so the snapshot is captured
// and the network round is in flight before we inject a concurrent
// `updateOverrides` between them. The final on-disk state must show the
// concurrent overrides intact, not the (empty) snapshot overrides.
await checkAsync('race: fetchRemoteCatalog + concurrent updateOverrides — overrides survive (fetchRemoteCatalog level)', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    // Pre-seed with a stale catalog entry so the 4h throttle doesn't
    // short-circuit the fetch.
    await store.write('test-route', {
      models: [{ id: 'model-a', name: 'M1', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      lastModified: 100,
      etag: '"old"',
    })

    // Deferred fetch: holds until releaseFetch() resolves.
    let releaseFetch
    const fetchHeld = new Promise((resolve) => { releaseFetch = resolve })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => {
      await fetchHeld
      return new Response(JSON.stringify([
        { id: 'model-a', name: 'M1 v2', api: 'openai-completions' },
        { id: 'model-b', name: 'M2', api: 'openai-completions' },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"new"' },
      })
    }

    try {
      // Kick off the fetch round — it will capture the snapshot, decide
      // to bypass the throttle (checkedAt is stale), build the request,
      // and suspend on `await fetch(...)`.
      const fetchPromise = fetchRemoteCatalog('test-route', 5000, store)

      // Yield to the event loop so fetchRemoteCatalog reaches
      // `await fetch(...)`. Two awaits are enough: one for the accessor's
      // `store.read(route)`, one for the fetch itself.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))

      // Inject the concurrent round's stage between the snapshot capture
      // and the fetch write.
      await store.updateOverrides('test-route', { 'model-a': { contextWindow: 8192 } })

      // Release the fetch and let the round complete.
      releaseFetch()
      await fetchPromise

      const stored = await store.read('test-route')
      assert.deepEqual(stored.overrides, { 'model-a': { contextWindow: 8192 } },
        'C1 fix at the fetchRemoteCatalog level: concurrent updateOverrides survives the fetch-side update')
      assert.equal(stored.models.length, 2, 'fetched models applied')
      assert.equal(stored.models[0].name, 'M1 v2')
      assert.equal(stored.etag, '"new"')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// Inverse race: the concurrent `updateOverrides` runs AFTER the fetch's
// update. The queue order makes the final state carry the concurrent
// overrides; the fetch's catalog metadata is preserved by the merge.
// This pins the symmetric invariant: updateOverrides always wins over
// update's current state for the overrides field, never the other way.
await checkAsync('race: fetchRemoteCatalog + late-arriving updateOverrides — overrides still applied', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    await store.write('test-route', {
      models: [{ id: 'model-a', name: 'M1', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      lastModified: 100,
      etag: '"old"',
    })

    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: 'model-a', name: 'M1 v2', api: 'openai-completions' }]), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"new"' },
    })
    try {
      await fetchRemoteCatalog('test-route', 5000, store)
      // Now stage overrides after the fetch round. The merge keeps the
      // fetch's models / etag / checkedAt and replaces only overrides.
      await store.updateOverrides('test-route', { 'model-a': { contextWindow: 8192 } })
      const stored = await store.read('test-route')
      assert.deepEqual(stored.overrides, { 'model-a': { contextWindow: 8192 } })
      assert.equal(stored.models[0].name, 'M1 v2', 'fetch-side models still in place')
      assert.equal(stored.etag, '"new"', 'fetch-side etag still in place')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// ---------------------------------------------------------------------------
// Regression locks for the four classic fetch paths — the change-only
// short-circuit, the 4h throttle, ENOENT first run, and the cached-
// entries-on-network-error behavior all still hold after the
// write-path refactor. Re-asserted here so a future change to `update()`
// can't silently break them.
// ---------------------------------------------------------------------------

// 304 short-circuit behavior is unaffected: a 304 response only refreshes
// checkedAt via `update`, the cached entries are returned, fromCache:true.
// Note: the seeded checkedAt must be older than the 4h throttle window
// (`REMOTE_CATALOG_REFRESH_INTERVAL_MS`) — otherwise the throttle short-
// circuits and the 304 update is never reached. Use 5h ago.
await checkAsync('regression: 304 still returns cached entries + refreshes checkedAt', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const oldCheckedAt = Date.now() - 5 * 60 * 60 * 1000 // 5h ago — past the 4h throttle
    await store.write('test-route', {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: oldCheckedAt,
      lastModified: 100,
      etag: '"old"',
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 304 })
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.fromCache, true)
      assert.equal(result.entries[0].id, 'cached')
      const stored = await store.read('test-route')
      assert.ok(stored.checkedAt > oldCheckedAt, 'checkedAt refreshed by the 304 update')
      assert.equal(stored.models[0].id, 'cached', 'cached models unchanged')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// 4h throttle still short-circuits when the route's checkedAt is fresh.
// The check is on `stored.checkedAt` from `store.read(route)` — the
// accessor-level read, not the queue-internal merge.
await checkAsync('regression: 4h throttle short-circuits when checkedAt is fresh', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    await store.write('test-route', {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 60_000, // 1 minute ago — well inside the 4h window
      lastModified: 100,
      etag: '"old"',
    })
    let fetchCalled = false
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { fetchCalled = true; return new Response(null, { status: 200 }) }
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.fromCache, true)
      assert.equal(result.entries[0].id, 'cached')
      assert.equal(fetchCalled, false, 'no network round when the throttle is fresh')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// 404 / 501 still return empty entries and the store's overrides are
// preserved.
await checkAsync('regression: 404/501 → empty entries returned, overrides preserved', async () => {
  for (const status of [404, 501]) {
    const { dir, storePath } = await createTmpStorePath()
    try {
      resetModelsStoreCache()
      const store = loadModelsStore(storePath)
      const overrides = { 'model-a': { contextWindow: 8192 } }
      await store.write('test-route', {
        models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
        checkedAt: Date.now() - 5 * 60 * 60 * 1000,
        lastModified: 100,
        etag: '"old"',
        overrides,
      })
      const origFetch = globalThis.fetch
      globalThis.fetch = async () => new Response(null, { status })
      try {
        const result = await fetchRemoteCatalog('test-route', 5000, store)
        assert.equal(result.entries.length, 0)
        assert.equal(result.fromCache, false)
        const stored = await store.read('test-route')
        assert.deepEqual(stored.overrides, overrides)
        // 404/501 = the route is gone from pi.dev. The 404/501 patch
        // (post-B1 / N1) no longer names `etag` — the seed preserves
        // current's etag, so the next round's conditional request still
        // uses the cached etag. Harmless if the resource stays gone
        // (server replies 404/501 again) and useful if it comes back
        // (server replies 304).
        assert.equal(stored.etag, '"old"', `status ${status}: etag preserved by the seed`)
        // lastModified is zeroed to reflect "no known server-side last-mod time".
        assert.equal(stored.lastModified, 0, `status ${status}: lastModified zeroed by the 404/501 patch`)
      } finally {
        globalThis.fetch = origFetch
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
      resetModelsStoreCache()
    }
  }
})

// ENOENT first-run: read returns undefined for the route (no auto-
// create), the accessor's first update creates the entry.
await checkAsync('regression: ENOENT first-run read returns undefined; first update creates the entry', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const pre = await store.read('any-route')
    assert.equal(pre, undefined, 'ENOENT → empty doc → undefined for the route')
    await store.update('any-route', {
      models: [{ id: 'm', name: 'M', api: 'openai-completions' }],
      checkedAt: 1,
      lastModified: 1,
      etag: '"e"',
    })
    const post = await store.read('any-route')
    assert.equal(post.models[0].id, 'm')
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
})

// Network error: cached entries returned with an error message; nothing
// clobbered on disk.
await checkAsync('regression: network error → cached entries returned, store unchanged', async () => {
  const { dir, storePath } = await createTmpStorePath()
  try {
    resetModelsStoreCache()
    const store = loadModelsStore(storePath)
    const overrides = { 'model-a': { contextWindow: 8192 } }
    await store.write('test-route', {
      models: [{ id: 'cached', name: 'Cached', api: 'openai-completions', provider: 'r', baseUrl: '', reasoning: false, input: ['text'] }],
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      lastModified: 100,
      etag: '"old"',
      overrides,
    })
    const origFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    try {
      const result = await fetchRemoteCatalog('test-route', 5000, store)
      assert.equal(result.entries[0].id, 'cached')
      assert.ok(result.error)
      const stored = await store.read('test-route')
      // The store is untouched on network error — the catch path returns
      // before reaching the update.
      assert.deepEqual(stored.overrides, overrides, 'overrides untouched on network error')
      assert.equal(stored.models[0].id, 'cached')
      assert.equal(stored.etag, '"old"')
    } finally {
      globalThis.fetch = origFetch
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
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

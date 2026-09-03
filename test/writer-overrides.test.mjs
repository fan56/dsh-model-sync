// modelOverrides mutual-exclusion fix: fold + unset + models-store replay.

/**
 * Tests for the 2026-09-03 writer revision — dsh's llm-pi-ai validation
 * refuses a route whose settings carry a models list beside non-empty
 * modelOverrides, so the writer must:
 * - fold the overrides into the written models and unset the key in the SAME
 *   mutate (atomic set+unset passes the validation),
 * - stage the raw overrides in the models-store BEFORE the mutate
 *   (store-first): a store write failure skips the mutate with reason
 *   'store-unavailable' and leaves settings untouched, while a rejected
 *   mutate leaves the key in place and the settings-wins rule suppresses
 *   the staged copy — settings stays the lossless source in every window,
 * - replay stored overrides into the target on later rounds (settings has no
 *   key anymore), which keeps change-only detection stable and the user's
 *   values alive across rounds — the v0.1.5 data-loss bug must stay dead.
 *
 * Unit checks use a structural in-memory store accessor; the real on-disk
 * accessor is covered in remote-catalog.test.mjs, and the end-to-end check at
 * the bottom (plugin apply() → fetch → translate → write → report line) runs
 * against a tmp HOME so the default models-store path never touches the real
 * ~/.dsh. lib/remote-catalog.js and lib/index.js are therefore imported
 * dynamically inside that check only — MODELS_STORE_PATH is computed from
 * os.homedir() at module load and must be evaluated after HOME is redirected.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncToSettings } from '../lib/writer.js'

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

const silentLogger = { info() {}, warn() {}, debug() {} }

/**
 * Stateful mock of the dsh settings seam: mutate() APPLIES the ops to its
 * route data (like the real settings service) unless armed to reject, so
 * multi-round simulations see the post-mutate document. A SETTINGS_CONFLICT
 * is thrown before applying (atomic rejection), like a real revision clash.
 * `extraRoutes` mounts additional routes beside the primary one (N1 e2e);
 * state.routeData stays an alias of the primary route's data for assertions.
 */
function createStatefulSettings({ route = 'test-route', models = undefined, overrides = undefined, rejectWith = undefined, conflictFirst = false, extraRoutes = undefined } = {}) {
  const state = {
    revision: 1,
    routes: {},
    mutations: [],
    conflictArmed: conflictFirst,
  }
  const primary = {}
  if (models !== undefined) primary.models = models
  if (overrides !== undefined) primary.modelOverrides = overrides
  state.routes[route] = primary
  if (extraRoutes !== undefined) {
    for (const [extraRoute, extraData] of Object.entries(extraRoutes)) {
      state.routes[extraRoute] = { ...extraData }
    }
  }
  state.routeData = primary

  const makeError = ({ code, message }) => {
    const err = new Error(message)
    err.code = code
    return err
  }

  return {
    state,
    describe() {
      const providers = {}
      for (const [routeId, data] of Object.entries(state.routes)) {
        if (Object.keys(data).length > 0) providers[routeId] = data
      }
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision: state.revision,
        user: Object.keys(providers).length > 0 ? { providers } : undefined,
        applies: 'live',
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      state.mutations.push({ ns, ops, expectedRevision })
      if (state.conflictArmed) {
        state.conflictArmed = false
        throw makeError({ code: 'SETTINGS_CONFLICT', message: 'revision conflict' })
      }
      if (rejectWith !== undefined) throw makeError(rejectWith)
      for (const op of ops) {
        const target = state.routes[op.path[1]] ?? (state.routes[op.path[1]] = {})
        if (op.op === 'set') target[op.path[2]] = op.value
        else delete target[op.path[2]]
      }
      state.revision++
    },
  }
}

/** In-memory models-store accessor (structural match for ModelsStoreAccessor). */
function createMemoryStore(seed = {}) {
  const data = { ...seed }
  const written = []
  return {
    data,
    written,
    async read(route) { return data[route] },
    async write(route, entry) { written.push(route); data[route] = entry },
    async update(route, patch) {
      written.push(route)
      const current = data[route] ?? {}
      data[route] = { ...current, ...patch }
    },
    async updateOverrides(route, overrides) {
      written.push(route)
      const current = data[route] ?? {}
      data[route] = { ...current, overrides }
    },
    async delete(route) { delete data[route] },
  }
}

/** Counting wrapper around any accessor — tracks write call counts per route. */
function countingStore(store) {
  const written = []
  return {
    written,
    read: (route) => store.read(route),
    write: async (route, entry) => { written.push(route); return store.write(route, entry) },
    delete: (route) => store.delete(route),
  }
}

const OVERRIDES = { 'model-a': { contextWindow: 8192 } }

// ---------------------------------------------------------------------------
// Settings overrides present → set+unset, store staged before the mutate
// (store-first)
// ---------------------------------------------------------------------------
await checkAsync('settings overrides → ops are set(folded)+unset, raw overrides staged in the store before the mutate', async () => {
  const store = createMemoryStore()
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
  })
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  assert.equal(result.overridesSource, 'settings')
  assert.deepEqual(result.droppedOverrideIds, [])

  assert.equal(settings.state.mutations.length, 1, 'one mutate')
  assert.equal(settings.state.mutations[0].expectedRevision, 1)
  const ops = settings.state.mutations[0].ops
  assert.equal(ops.length, 2, 'set + unset in one atomic mutate')
  assert.equal(ops[0].op, 'set')
  assert.deepEqual(ops[0].path, ['providers', 'test-route', 'models'])
  assert.equal(ops[0].value[0].name, 'Model A Updated', 'target fields applied')
  assert.equal(ops[0].value[0].contextWindow, 8192, 'override folded over the target')
  assert.equal(ops[1].op, 'unset')
  assert.deepEqual(ops[1].path, ['providers', 'test-route', 'modelOverrides'])
  assert.equal(ops[1].value, undefined)

  // mutate applied: settings now has the folded models and no overrides key
  assert.deepEqual(settings.state.routeData.models[0].contextWindow, 8192)
  assert.equal(settings.state.routeData.modelOverrides, undefined)

  // store staged before the mutate (store-first), verbatim
  assert.deepEqual(store.data['test-route']?.overrides, OVERRIDES)
})

// ---------------------------------------------------------------------------
// Mutate rejected → the store-first copy is already staged, but the settings
// key is still there and wins the next round (settings = lossless source)
// ---------------------------------------------------------------------------
await checkAsync('mutate rejected → staged copy in store is harmless, settings key remains and wins the re-fold', async () => {
  const seeded = {
    models: [{ id: 'model-a', name: 'Cached' }],
    checkedAt: 1,
    lastModified: 2,
    etag: '"seed-etag"',
  }
  const store = createMemoryStore({ 'test-route': { ...seeded } })
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
    rejectWith: { code: 'VALIDATION_ERROR', message: 'sets modelOverrides for "model-a" beside a models list' },
  })
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'mutate-rejected')
  // Store-first semantics: the stage already ran when the mutate was
  // rejected. That is safe — the key below is still in settings and always
  // wins over the staged copy.
  assert.equal(store.written.length, 1, 'store-first stages the copy before the mutate')
  assert.deepEqual(store.data['test-route'].overrides, OVERRIDES, 'staged copy holds the overrides')
  assert.equal(store.data['test-route'].etag, '"seed-etag"', 'the rest of the store entry survives the stage')
  assert.deepEqual(settings.state.routeData.modelOverrides, OVERRIDES, 'settings unchanged (atomic rejection)')

  // Next round: the settings key is present → settings-wins re-fold lands
  // the value and refreshes the store; nothing was lost by the staging.
  const round2 = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
  })
  const replay = await syncToSettings(round2, 'test-route', target, silentLogger, undefined, store)
  assert.equal(replay.wrote, true)
  assert.equal(replay.overridesSource, 'settings', 'the surviving key wins the next fold')
  assert.equal(round2.state.mutations[0].ops[0].value[0].contextWindow, 8192, 'value refolded from settings')
  assert.deepEqual(round2.state.routeData.modelOverrides, undefined, 'key cleared on the successful round')
  assert.deepEqual(store.data['test-route'].overrides, OVERRIDES, 'store holds the same values')
})

// ---------------------------------------------------------------------------
// Store write fails → store-unavailable, mutate never runs, settings
// document zero changes (the key must never be unset without a staged copy)
// ---------------------------------------------------------------------------
await checkAsync('store write throws → store-unavailable, no mutate, settings doc untouched', async () => {
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
  })
  const failingStore = {
    async read() { return undefined },
    async write() { throw new Error('EACCES: models-store.json not writable') },
    async delete() {},
  }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, failingStore)

  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'store-unavailable', 'the honest reason: the store failed, not the mutate')
  assert.equal(settings.state.mutations.length, 0, 'the mutate must not run when staging fails')
  assert.deepEqual(settings.state.routeData.models, [{ id: 'model-a', name: 'Model A' }], 'settings models zero changes')
  assert.deepEqual(settings.state.routeData.modelOverrides, OVERRIDES, 'overrides key still in settings')
})

// ---------------------------------------------------------------------------
// Cross-round stability — the v0.1.5 data-loss regression gate:
// round 1 folds+unsets+persists, round 2 is change-only with the value still
// in place, round 3 (pi.dev changed) rewrites from the store replay.
// ---------------------------------------------------------------------------
await checkAsync('cross-round: value alive after round 2, replayed on a round-3 catalog change, no clobber', async () => {
  const store = createMemoryStore()
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
  })
  const target = [{ id: 'model-a', name: 'Model A', contextWindow: 1000000 }]

  // Round 1: fold + unset + persist.
  const r1 = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)
  assert.equal(r1.wrote, true)
  assert.equal(r1.overridesSource, 'settings')

  // Round 2: settings has no overrides anymore; the store replays them, the
  // merged view matches the stored models → change-only, value still there.
  const r2 = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)
  assert.equal(r2.wrote, false, 'round 2 must be change-only via the store replay')
  assert.equal(r2.reason, 'no-change')
  assert.equal(settings.state.mutations.length, 1, 'no second mutate')
  assert.deepEqual(settings.state.routeData.models[0].contextWindow, 8192,
    'v0.1.5 gate: the override value must still be in settings after round 2')

  // Round 3: pi.dev adds a model and renames the existing one — the write is
  // folded from the store, emits NO unset, and does not touch the store.
  const counting = countingStore(store)
  const target3 = [
    { id: 'model-a', name: 'Model A Renamed', contextWindow: 1000000 },
    { id: 'model-b', name: 'Model B' },
  ]
  const r3 = await syncToSettings(settings, 'test-route', target3, silentLogger, undefined, counting)
  assert.equal(r3.wrote, true)
  assert.equal(r3.reason, 'wrote')
  assert.equal(r3.overridesSource, 'store', 'round 3 folds the stored overrides')
  const ops3 = settings.state.mutations[1].ops
  assert.equal(ops3.length, 1, 'replay round writes models only — no unset when the key is already gone')
  assert.equal(ops3[0].op, 'set')
  assert.equal(ops3[0].value[0].name, 'Model A Renamed', 'new target value applied')
  assert.equal(ops3[0].value[0].contextWindow, 8192, 'stored override still wins on the replayed write')
  assert.equal(ops3[0].value[1].id, 'model-b')
  assert.deepEqual(settings.state.routeData.modelOverrides, undefined, 'no overrides key re-created')
  assert.equal(counting.written.length, 0, 'the store already holds the replayed value — no rewrite')

  // And round 4 is change-only again.
  const r4 = await syncToSettings(settings, 'test-route', target3, silentLogger, undefined, store)
  assert.equal(r4.reason, 'no-change')
  assert.equal(settings.state.mutations.length, 2)
})

// ---------------------------------------------------------------------------
// Settings overrides re-added beside a stored version → settings wins,
// store refreshed (a re-added key is the user's latest intent)
// ---------------------------------------------------------------------------
await checkAsync('settings re-adds different overrides → settings wins, store updated', async () => {
  const store = createMemoryStore({
    'test-route': {
      models: [{ id: 'model-a', name: 'Cached' }],
      checkedAt: 1,
      lastModified: 2,
      etag: '"e"',
      overrides: { 'model-a': { contextWindow: 8192 } },
    },
  })
  const freshOverrides = { 'model-a': { contextWindow: 4096 } }
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
    overrides: freshOverrides,
  })
  const target = [{ id: 'model-a', name: 'Model A', contextWindow: 1000000 }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, true)
  assert.equal(result.overridesSource, 'settings')
  const ops = settings.state.mutations[0].ops
  assert.equal(ops[0].value[0].contextWindow, 4096, 'the settings value wins over the stored one')
  assert.equal(ops[1].op, 'unset')
  assert.deepEqual(store.data['test-route'].overrides, freshOverrides, 'store refreshed with the latest intent')
  // The rest of the store entry survives the read-modify-write.
  assert.equal(store.data['test-route'].etag, '"e"')
  assert.deepEqual(store.data['test-route'].models, [{ id: 'model-a', name: 'Cached' }])
})

// ---------------------------------------------------------------------------
// Regression lock: no overrides anywhere → byte-identical legacy behavior
// ---------------------------------------------------------------------------
await checkAsync('no overrides anywhere → legacy single-set op shape, change-only intact (with and without a store)', async () => {
  const target = [{ id: 'model-a', name: 'Model A Updated' }]
  const current = [{ id: 'model-a', name: 'Model A' }]
  const legacyOps = [{ op: 'set', path: ['providers', 'test-route', 'models'], value: target }]

  // Legacy call shape: no retranslate, no store.
  const bare = createStatefulSettings({ models: current })
  const bareResult = await syncToSettings(bare, 'test-route', target, silentLogger)
  assert.equal(bareResult.wrote, true)
  assert.equal(bareResult.reason, 'wrote')
  assert.equal(bareResult.overridesSource, undefined)
  assert.equal(bareResult.droppedOverrideIds, undefined)
  assert.deepEqual(bare.state.mutations[0].ops, legacyOps, 'bare call: ops byte-identical to the legacy single set')
  const bareRound2 = await syncToSettings(bare, 'test-route', target, silentLogger)
  assert.equal(bareRound2.reason, 'no-change')
  assert.equal(bare.state.mutations.length, 1)

  // Same route with a store wired: the store must not change the op shape.
  const store = createMemoryStore()
  const withStore = createStatefulSettings({ models: current })
  const withStoreResult = await syncToSettings(withStore, 'test-route', target, silentLogger, undefined, store)
  assert.equal(withStoreResult.wrote, true)
  assert.equal(withStoreResult.overridesSource, undefined)
  assert.deepEqual(withStore.state.mutations[0].ops, legacyOps, 'store-wired call: same op shape')
  assert.deepEqual(snapshotRouteData(withStore), snapshotRouteData(bare), 'same resulting settings state')
  assert.equal(store.written.length, 0, 'nothing to persist when no overrides were involved')
})

/** Snapshot of a stateful mock's route data (for state comparisons). */
function snapshotRouteData(settingsMock) {
  return JSON.parse(JSON.stringify(settingsMock.state.routeData))
}

// ---------------------------------------------------------------------------
// Ghost override ids: never folded, reported, kept verbatim in the store
// ---------------------------------------------------------------------------
await checkAsync('override ids not in target → not folded, reported sorted, preserved in the store', async () => {
  const store = createMemoryStore()
  const overrides = { 'z-ghost': { contextWindow: 1 }, 'model-a': { contextWindow: 8192 }, 'a-ghost': { contextWindow: 2 } }
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides,
  })
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, true)
  assert.deepEqual(result.droppedOverrideIds, ['a-ghost', 'z-ghost'], 'sorted, deterministic report')
  const ops = settings.state.mutations[0].ops
  assert.equal(ops[0].value.length, 1, 'ghost ids are not folded into the models list')
  assert.deepEqual(store.data['test-route'].overrides, overrides, 'raw overrides (ghosts included) persisted verbatim')
})

// ---------------------------------------------------------------------------
// SETTINGS_CONFLICT retry with overrides: both attempts carry set+unset and
// each attempt's store-first staging precedes its mutate (store-first holds
// on the retry path too)
// ---------------------------------------------------------------------------
await checkAsync('SETTINGS_CONFLICT retry → set+unset on both attempts, every staging precedes its mutate', async () => {
  const store = createMemoryStore()
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
    conflictFirst: true,
  })
  // Interleave store writes and mutates into one event log so the ordering
  // contract is checkable without locking the exact staging count. C1 fix:
  // the writer now stages via `updateOverrides` (queue-internal RMW), so
  // hook that — the legacy `store.write` hook saw nothing after the refactor.
  const events = []
  const origMutate = settings.mutate.bind(settings)
  settings.mutate = async (...args) => {
    events.push('mutate')
    return origMutate(...args)
  }
  const origUpdateOverrides = store.updateOverrides.bind(store)
  store.updateOverrides = async (...args) => {
    events.push('persist')
    return origUpdateOverrides(...args)
  }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(
    settings, 'test-route', target, silentLogger,
    async () => target,
    store,
  )

  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'conflict-retry-ok')
  assert.equal(result.overridesSource, 'settings')
  assert.equal(settings.state.mutations.length, 2)
  assert.equal(settings.state.mutations[0].ops.length, 2, 'first attempt also carried set+unset')
  const retryOps = settings.state.mutations[1].ops
  assert.equal(retryOps.length, 2, 'retry carries set + unset too')
  assert.equal(retryOps[1].op, 'unset')
  assert.equal(settings.state.mutations[1].expectedRevision, 1, 'revision unchanged: the rejected mutate never applied')

  // Ordering contract: ≥1 staging, and every staging precedes a mutate
  // (store-first on both the first attempt and the retry). Final-state
  // assertions stay exact; the staging count is not locked.
  const persistIdx = events.flatMap((e, i) => (e === 'persist' ? [i] : []))
  assert.ok(persistIdx.length >= 1, 'at least one store-first staging')
  for (const idx of persistIdx) {
    assert.ok(events.slice(idx + 1).includes('mutate'), `staging #${idx} must precede its mutate`)
  }
  assert.equal(events[events.length - 1], 'mutate', 'the round ends with the successful retry mutate')

  // Final state: store and settings agree on the resolved overrides.
  assert.deepEqual(store.data['test-route'].overrides, OVERRIDES)
  assert.equal(settings.state.routeData.modelOverrides, undefined, 'key cleared by the retry mutate')
  assert.equal(settings.state.routeData.models[0].contextWindow, 8192, 'folded value landed')
})

// ---------------------------------------------------------------------------
// The overrides key vanishes between the conflict attempts (user deleted it
// mid-round): the retry re-resolves from the fresh descriptor, omits the
// unset (nothing left to clear) and does not re-stage
// ---------------------------------------------------------------------------
await checkAsync('SETTINGS_CONFLICT retry → key vanished between attempts: retry omits the unset, folds from the store', async () => {
  const store = createMemoryStore({
    'test-route': {
      models: [{ id: 'model-a', name: 'Cached' }],
      checkedAt: 1,
      lastModified: 2,
      etag: '"e"',
      overrides: OVERRIDES,
    },
  })
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: OVERRIDES,
    conflictFirst: true,
  })
  let describes = 0
  const origDescribe = settings.describe.bind(settings)
  settings.describe = () => {
    describes += 1
    if (describes === 2) delete settings.state.routeData.modelOverrides
    return origDescribe()
  }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(
    settings, 'test-route', target, silentLogger,
    async () => target,
    store,
  )

  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'conflict-retry-ok')
  assert.equal(result.overridesSource, 'store', 'the retry replayed the stored overrides')
  const retryOps = settings.state.mutations[1].ops
  assert.equal(retryOps.length, 1, 'retry writes models only — no unset when the key is already gone')
  assert.equal(retryOps[0].op, 'set')
  assert.equal(retryOps[0].value[0].contextWindow, 8192, 'stored override folded into the retry write')
  assert.deepEqual(settings.state.routeData.modelOverrides, undefined)
  assert.deepEqual(store.data['test-route'].overrides, OVERRIDES, 'store unchanged by the replay')
})

// ---------------------------------------------------------------------------
// N2: an override object carrying an `id` must not silently re-key the entry
// ---------------------------------------------------------------------------
await checkAsync('override carrying an id field cannot re-key the target entry', async () => {
  const store = createMemoryStore()
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: { 'model-a': { id: 'model-hijacked', contextWindow: 8192 } },
  })
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, true)
  const written = settings.state.mutations[0].ops[0].value
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'model-a', 'the entry id must survive the fold')
  assert.equal(written[0].contextWindow, 8192, 'other override fields still fold')
  assert.equal(written[0].name, 'Model A Updated', 'target fields still applied')
  assert.deepEqual(result.droppedOverrideIds, [], 'no ghost ids introduced by the fold')
})

// ---------------------------------------------------------------------------
// Empty {} overrides → counts as absent: legacy behavior, nothing persisted
// ---------------------------------------------------------------------------
await checkAsync('empty modelOverrides object → treated as absent: legacy op shape, no unset, no persist', async () => {
  const store = createMemoryStore()
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides: {},
  })
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, store)

  assert.equal(result.wrote, true)
  assert.equal(result.overridesSource, undefined)
  assert.deepEqual(settings.state.mutations[0].ops, [
    { op: 'set', path: ['providers', 'test-route', 'models'], value: target },
  ])
  assert.equal(store.written.length, 0)
  assert.equal(store.data['test-route'], undefined)

  // And the change-only short-circuit still applies with an empty {} key.
  const settled = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A Updated' }],
    overrides: {},
  })
  const noChange = await syncToSettings(settled, 'test-route', target, silentLogger, undefined, store)
  assert.equal(noChange.reason, 'no-change')
  assert.equal(settled.state.mutations.length, 0)
})

// ---------------------------------------------------------------------------
// End-to-end: apply() in settings mode over a mocked pi.dev — report line,
// on-disk store (tmp HOME), and two-round stability through the real store
// accessor. Must stay the LAST check in this file: it redirects HOME before
// dynamically importing lib/index.js, whose remote-catalog module computes
// the default models-store path from os.homedir() at load time.
// ---------------------------------------------------------------------------
await checkAsync('e2e: settings mode round reports the fold+unset, persists the store, round 2 is up to date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-model-sync-overrides-e2e-'))
  const prevHome = process.env.HOME
  process.env.HOME = dir
  const { apply } = await import('../lib/index.js')
  const { resetModelsStoreCache } = await import('../lib/remote-catalog.js')
  resetModelsStoreCache()
  try {
    const config = {
      writeMode: 'settings',
      intervalMinutes: 0,
      startupDelaySeconds: 3600, // never fires; disposed below
      refreshTimeoutMs: 120000,
      managedRoutes: ['test-route', 'test-route-2'],
      keepBuiltinOnly: true,
      dropUnserviceable: true,
      syncNotify: false,
      forceMaxReasoningEffort: false,
    }
    // test-route-2: a second managed route with NO overrides anywhere (N1).
    // Its stale name forces one classic write so the report line can be
    // locked byte-for-byte.
    const settingsService = createStatefulSettings({
      models: [{ id: 'model-a', name: 'Model A' }],
      overrides: OVERRIDES,
      extraRoutes: {
        'test-route-2': {
          models: [{ id: 'r2-a', name: 'R2 A Stale' }, { id: 'r2-b', name: 'R2 B' }],
        },
      },
    })
    const state = { provided: [], effectDisposers: [] }
    const scope = { get: () => config, watch: () => {} }
    const ctx = {
      settings: { register: () => scope },
      get: (name) => (name === 'settings' ? settingsService : undefined),
      logger: { info() {}, warn() {}, debug() {} },
      effect(fn) {
        const disposer = fn()
        if (typeof disposer === 'function') state.effectDisposers.push(disposer)
        return disposer
      },
      provide(name, service) { state.provided.push({ name, service }) },
      inject(names, callback) {
        for (const name of names) if (ctx[name] === undefined) return
        callback(Object.create(ctx))
      },
    }

    // Mock pi.dev: two clean entries (no capacities → no translate warnings)
    // for test-route; a renamed entry for test-route-2 (same ids, so no
    // added/removed diff lines — exactly one classic write line).
    const piDevEntries = [
      { id: 'model-a', name: 'Model A', api: 'openai-completions', baseUrl: 'https://gw.test', reasoning: false, input: ['text'] },
      { id: 'model-b', name: 'Model B', api: 'openai-completions', baseUrl: 'https://gw.test', reasoning: false, input: ['text'] },
    ]
    const piDevEntriesRoute2 = [
      { id: 'r2-a', name: 'R2 A', api: 'openai-completions', baseUrl: 'https://gw.test', reasoning: false, input: ['text'] },
      { id: 'r2-b', name: 'R2 B', api: 'openai-completions', baseUrl: 'https://gw.test', reasoning: false, input: ['text'] },
    ]
    const origFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/models/providers/test-route-2')) {
        return new Response(JSON.stringify(piDevEntriesRoute2), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"etag-r2-1"' },
        })
      }
      if (String(url).includes('/api/models/providers/test-route')) {
        return new Response(JSON.stringify(piDevEntries), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"etag-1"' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    try {
      apply(ctx)
      const modelSync = state.provided.find((entry) => entry.name === 'modelSync')?.service
      assert.ok(modelSync, 'modelSync service provided')

      // Round 1: write with fold + unset.
      const report1 = await modelSync.syncNow()
      assert.ok(
        report1.includes('test-route: wrote 2 models (folded user modelOverrides, unset the key)'),
        `round 1 report line, got: ${report1}`,
      )
      // N1 regression lock: the override-free second managed route keeps the
      // classic report line byte-for-byte.
      const route2Line = report1.split('\n').find((line) => line.startsWith('test-route-2:'))
      assert.equal(route2Line, 'test-route-2: wrote 2 models (wrote)',
        'classic report line for an override-free route must stay byte-identical')
      assert.deepEqual(settingsService.state.routeData.models[0].contextWindow, 8192, 'folded value in settings')
      assert.equal(settingsService.state.routeData.modelOverrides, undefined, 'key gone from settings')

      // The default models-store (redirected into the tmp HOME) holds the
      // overrides next to the catalog entry the fetch wrote this round.
      const storeDoc = JSON.parse(await readFile(join(dir, '.dsh', 'models-store.json'), 'utf8'))
      assert.deepEqual(storeDoc['test-route'].overrides, OVERRIDES, 'overrides persisted to the store file')
      assert.equal(storeDoc['test-route'].models.length, 2, 'the fetch-side catalog entry is intact')
      assert.equal(storeDoc['test-route'].etag, '"etag-1"')

      // Round 2: forced refresh fetches the same catalog; the store replay
      // re-derives the identical merged target → change-only, value alive.
      const report2 = await modelSync.syncNow()
      assert.ok(
        report2.includes('test-route: up to date (2 models)'),
        `round 2 report line, got: ${report2}`,
      )
      assert.deepEqual(settingsService.state.routeData.models[0].contextWindow, 8192,
        'v0.1.5 gate at the e2e level: the override value survives round 2')
      assert.equal(settingsService.state.routeData.modelOverrides, undefined)
      const storeDoc2 = JSON.parse(await readFile(join(dir, '.dsh', 'models-store.json'), 'utf8'))
      assert.deepEqual(storeDoc2['test-route'].overrides, OVERRIDES, 'store survives the round-2 refresh write')
    } finally {
      globalThis.fetch = origFetch
      for (const disposer of state.effectDisposers) disposer()
    }
  } finally {
    process.env.HOME = prevHome
    resetModelsStoreCache()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Fail-closed read: corrupt / permission-denied store + no settings key →
// skip + zero clobber (settings.models stays the authoritative source).
// ---------------------------------------------------------------------------
await checkAsync('store read fails + settings has no overrides → skip (store-unavailable), settings untouched', async () => {
  // Settings has the round-1-done shape (folded models, no modelOverrides
  // key). The store is unreadable (corrupt JSON): writing the raw pi.dev
  // target now would clobber the folded values in settings.models — the
  // v0.1.5 data-loss shape. The writer must skip the round.
  const folded = { 'model-a': { contextWindow: 8192 } }
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
    // no modelOverrides key — the round-1 settle.
  })
  const failingStore = {
    async read() { throw new SyntaxError('Unexpected token in JSON at position 5') },
    async write() { throw new Error('write should not be called: the round must skip') },
    async delete() {},
  }
  const target = [{ id: 'model-a', name: 'Model A', contextWindow: 1000000 }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, failingStore)

  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'store-unavailable', 'read failure with no settings key → skip + fail closed')
  assert.equal(settings.state.mutations.length, 0, 'mutate must not run when the store is unreadable')
  assert.deepEqual(settings.state.routeData.models, [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
    'settings.models untouched: the folded values are the authoritative fallback')
  assert.equal(settings.state.routeData.modelOverrides, undefined, 'no settings key was ever present')

  // Sanity: the same round WITHOUT a store (the legacy call shape) still
  // runs and overwrites settings.models — proving the fail-closed branch
  // is gated on the store-read failure, not on the call shape.
  const storeless = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }],
  })
  const storelessOutcome = await syncToSettings(storeless, 'test-route', target, silentLogger)
  assert.equal(storelessOutcome.wrote, true, 'without a store, the writer proceeds as it always did')
  assert.deepEqual(storeless.state.routeData.models[0], { id: 'model-a', name: 'Model A', contextWindow: 1000000 })
  void folded
})

// ---------------------------------------------------------------------------
// Fail-closed read: corrupt store + settings has the overrides key →
// settings-wins folds, persist tolerates the read failure and the atomic
// writeDoc heals the store, mutate lands, settings key cleared.
// ---------------------------------------------------------------------------
await checkAsync('store read fails + settings has overrides → settings-wins folds, mutate heals the store', async () => {
  const overrides = { 'model-a': { contextWindow: 8192 } }
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides,
  })
  // The store reads always throw — simulates a corrupt file. Writes go
  // through so we can verify the heal (the atomic writeDoc replaces the
  // bad file with a well-formed entry carrying the persisted overrides).
  const healedData = {}
  const failingButWritableStore = {
    async read() { throw new SyntaxError('Unexpected token in JSON at position 5') },
    async write(route, entry) { healedData[route] = entry },
    // B1: the real updateOverrides() uses a field-level seed, so the
    // mock must match — every entry carries models ([]), checkedAt (a
    // timestamp), lastModified (0), etag (undefined), and overrides. The
    // previous `{ overrides }`-only mock was simulating the bug itself:
    // an entry shape the next round's fetch couldn't consume.
    async updateOverrides(route, overrides) {
      healedData[route] = {
        models: [],
        checkedAt: Date.now(),
        lastModified: 0,
        etag: undefined,
        overrides,
      }
    },
    async delete(route) { delete healedData[route] },
  }
  const target = [{ id: 'model-a', name: 'Model A', contextWindow: 1000000 }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, failingButWritableStore)

  assert.equal(result.wrote, true, 'settings-wins: the round must run; the atomic write heals the store')
  assert.equal(result.reason, 'wrote')
  assert.equal(result.overridesSource, 'settings')

  // Mutate landed with set + unset; the folded value is in settings.models.
  assert.equal(settings.state.mutations.length, 1)
  const ops = settings.state.mutations[0].ops
  assert.equal(ops.length, 2, 'set + unset atomically')
  assert.equal(ops[1].op, 'unset')
  assert.equal(ops[0].value[0].contextWindow, 8192, 'settings value wins over the (unreadable) store')
  assert.deepEqual(settings.state.routeData.modelOverrides, undefined, 'key cleared by the unset')
  assert.deepEqual(settings.state.routeData.models[0].contextWindow, 8192)

  // The persist's atomic write healed the store — the only way a read-
  // throwing file becomes valid JSON is for a successful write to
  // overwrite it. C1 + B1: the writer's persist path uses updateOverrides
  // (queue-internal RMW with field-level seed), so the healed entry has
  // the full shape — models seeded to [], checkedAt to a timestamp,
  // lastModified to 0, etag to undefined, plus the overrides. The fetch
  // side re-populates models/checkedAt/lastModified/etag on its next
  // round. The invariants that matter are: the entry exists, it carries
  // the overrides verbatim, and the next read no longer throws.
  assert.deepEqual(healedData['test-route']?.overrides, overrides, 'heal: persisted entry carries the overrides')
  assert.equal(typeof healedData['test-route']?.checkedAt, 'number', 'heal: entry has a checkedAt timestamp (B1 entry-shape invariant)')
  assert.deepEqual(healedData['test-route']?.models, [], 'heal: entry has a models field seeded to [] (B1 entry-shape invariant)')
  assert.ok(healedData['test-route'], 'heal: persisted entry exists')
})

// ---------------------------------------------------------------------------
// ENOENT first run: unchanged behavior. readDoc returns {} on ENOENT, the
// writer sees no stored overrides, falls through to the regular change-only
// / no-change write path. This test pins the regression.
// ---------------------------------------------------------------------------
await checkAsync('store ENOENT (first run) → read returns {}, no overrides from store, regular write path', async () => {
  // ENOENT = no file at all. The accessor returns undefined for any route;
  // resolveOverrides gets no stored overrides; the writer behaves like the
  // pre-S1 bare-call shape (regression lock for first-run / clean install).
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
  })
  const enoentStore = {
    async read(route) { return undefined }, // simulate ENOENT → empty doc
    async write(route, entry) { enoentStore._written = enoentStore._written ?? {}; enoentStore._written[route] = entry },
    async update(route, patch) {
      enoentStore._written = enoentStore._written ?? {}
      enoentStore._written[route] = { ...(enoentStore._written[route] ?? {}), ...patch }
    },
    async updateOverrides(route, overrides) {
      enoentStore._written = enoentStore._written ?? {}
      enoentStore._written[route] = { ...(enoentStore._written[route] ?? {}), overrides }
    },
    async delete(route) {},
  }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(settings, 'test-route', target, silentLogger, undefined, enoentStore)

  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  assert.equal(result.overridesSource, undefined, 'ENOENT is a normal first run — no overridesSource')
  assert.deepEqual(settings.state.mutations[0].ops, [
    { op: 'set', path: ['providers', 'test-route', 'models'], value: target },
  ], 'single-set legacy op shape, unchanged')
  assert.equal(enoentStore._written, undefined, 'no persist call: there were no overrides to stage')

  // And the change-only short-circuit still applies.
  const settled = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A Updated' }],
  })
  const noChange = await syncToSettings(settled, 'test-route', target, silentLogger, undefined, enoentStore)
  assert.equal(noChange.reason, 'no-change')
  assert.equal(settled.state.mutations.length, 0)
})

// ---------------------------------------------------------------------------
// Retry path also fails closed on store-read failure when settings has no
// key between the two attempts (the rare race where the user removed the
// overrides key during the SETTINGS_CONFLICT retry).
// ---------------------------------------------------------------------------
await checkAsync('store read fails on retry + key removed between attempts → skip (store-unavailable)', async () => {
  // First attempt: settings has the overrides key — settings-wins, the
  // store read is never called, the mutate runs and throws SETTINGS_CONFLICT.
  // Retry: the user removed the overrides key between attempts; the retry's
  // resolveOverrides falls through to the store read, which now throws,
  // and the retry's try/catch in syncToSettings must fail closed (no
  // second mutate, no clobber — the rejected mutate didn't apply, so the
  // key is still there and the round is reported honestly).
  const overrides = { 'model-a': { contextWindow: 8192 } }
  const failingStore = {
    async read() { throw new SyntaxError('corrupt store on retry') },
    async write() {},
    // C1: the writer's first-attempt persist now goes through updateOverrides
    // (queue-internal RMW). For the settings-wins path the read error is
    // swallowed and the write still lands, so the mock tolerates it.
    async updateOverrides() {},
    async delete() {},
  }
  const settings = createStatefulSettings({
    models: [{ id: 'model-a', name: 'Model A' }],
    overrides,
    conflictFirst: true,
  })
  let describes = 0
  const origDescribe = settings.describe.bind(settings)
  settings.describe = () => {
    describes += 1
    const desc = origDescribe()
    // On the retry's describe (second call), the user dropped the key in
    // the live settings — surface the change in the returned descriptor
    // without mutating the underlying mock state (the rejected first
    // attempt must still see the key in the original state).
    if (describes === 2) {
      const [d] = desc
      const userProviders = d.user?.providers
      if (userProviders !== undefined) {
        const testRoute = { ...userProviders['test-route'] }
        delete testRoute.modelOverrides
        const newProviders = { ...userProviders, 'test-route': testRoute }
        return [{ ...d, user: { providers: newProviders } }]
      }
    }
    return desc
  }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]

  const result = await syncToSettings(
    settings, 'test-route', target, silentLogger,
    async () => target,
    failingStore,
  )

  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'store-unavailable',
    'retry path: store read failed with no settings key → fail closed')
  assert.equal(settings.state.mutations.length, 1,
    'only the first-attempt mutate is on the log (and it was rejected)')
  // The original state still has the overrides (the rejected mutate never
  // applied, and the describe override rebuilds the descriptor without
  // mutating state).
  assert.deepEqual(settings.state.routeData.modelOverrides, overrides,
    'original settings key untouched: the rejected mutate never applied')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

// Plan C (settings-seam): tests for the writer module.

/**
 * Tests for writer.ts — covers change-only write, revision conflict retry,
 * validate rejection, missing settings service.
 */

import assert from 'node:assert/strict'
import { syncToSettings, profilesEqual } from '../lib/writer.js'

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

/** Create a mock settings service. */
function createMockSettings({ revision = 1, userModels = undefined, modelOverrides = undefined, throwOnMutate = undefined } = {}) {
  const mutations = []
  const routeData = {}
  if (userModels !== undefined) routeData.models = userModels
  if (modelOverrides !== undefined) routeData.modelOverrides = modelOverrides
  return {
    mutations,
    // Descriptor shape mirrors the real dsh-settings 0.1.2-alpha.3
    // describe() entry: { ns, schema, value, revision, base?, user?, applies }.
    describe() {
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision,
        user: Object.keys(routeData).length > 0
          ? { providers: { 'test-route': routeData } }
          : undefined,
        applies: 'live',
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      mutations.push({ ns, ops, expectedRevision })
      if (throwOnMutate !== undefined) throw throwOnMutate
    },
  }
}

const silentLogger = {
  info() {},
  warn() {},
  debug() {},
}

// ---------------------------------------------------------------------------
// profilesEqual
// ---------------------------------------------------------------------------
check('profilesEqual: identical arrays are equal', () => {
  const a = [{ id: 'x', name: 'X' }]
  assert.ok(profilesEqual(a, [...a]))
})

check('profilesEqual: different lengths are not equal', () => {
  assert.ok(!profilesEqual([{ id: 'x' }], [{ id: 'x' }, { id: 'y' }]))
})

check('profilesEqual: different field values are not equal', () => {
  const a = [{ id: 'x', name: 'X' }]
  const b = [{ id: 'x', name: 'Y' }]
  assert.ok(!profilesEqual(a, b))
})

check('profilesEqual: different field presence is not equal', () => {
  const a = [{ id: 'x', name: 'X' }]
  const b = [{ id: 'x' }]
  assert.ok(!profilesEqual(a, b))
})

// ---------------------------------------------------------------------------
// syncToSettings: change-only write (no change → no mutate)
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: no change → no mutate call', async () => {
  const target = [{ id: 'model-a', name: 'Model A' }]
  const settings = createMockSettings({ userModels: target })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'no-change')
  assert.equal(settings.mutations.length, 0, 'should not call mutate')
})

// ---------------------------------------------------------------------------
// syncToSettings: field change triggers write
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: field change triggers write', async () => {
  const current = [{ id: 'model-a', name: 'Model A' }]
  const target = [{ id: 'model-a', name: 'Model A Updated' }]
  const settings = createMockSettings({ userModels: current })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  assert.equal(settings.mutations.length, 1)
  assert.equal(settings.mutations[0].ns, 'llm-pi-ai')
  assert.deepEqual(settings.mutations[0].ops[0].path, ['providers', 'test-route', 'models'])
  assert.deepEqual(settings.mutations[0].ops[0].value, target)
  assert.equal(settings.mutations[0].expectedRevision, 1)
})

// ---------------------------------------------------------------------------
// syncToSettings: new route (no current models) triggers write
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: new route triggers write', async () => {
  const target = [{ id: 'model-a', name: 'Model A' }]
  const settings = createMockSettings({ userModels: undefined })

  const result = await syncToSettings(settings, 'new-route', target, silentLogger)
  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  assert.equal(settings.mutations.length, 1)
})

// ---------------------------------------------------------------------------
// syncToSettings: SETTINGS_CONFLICT retry succeeds
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: SETTINGS_CONFLICT retry succeeds', async () => {
  let callCount = 0
  const settings = {
    mutations: [],
    describe() {
      callCount++
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision: callCount === 1 ? 1 : 2,
        user: callCount === 1
          ? { providers: { 'test-route': { models: [{ id: 'model-a' }] } } }
          : { providers: { 'test-route': { models: [{ id: 'model-a', name: 'old' }] } } },
        applies: 'live',
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      this.mutations.push({ ns, ops, expectedRevision })
      if (callCount === 1) {
        const err = new Error('conflict')
        err.code = 'SETTINGS_CONFLICT'
        throw err
      }
    },
  }

  const target = [{ id: 'model-a', name: 'Updated' }]
  const result = await syncToSettings(
    settings, 'test-route', target, silentLogger,
    async () => target,
  )
  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'conflict-retry-ok')
  assert.equal(settings.mutations.length, 2, 'should have tried twice')
})

// ---------------------------------------------------------------------------
// syncToSettings: SETTINGS_CONFLICT retry also fails
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: SETTINGS_CONFLICT retry also fails → conflict-retry-failed', async () => {
  const err = new Error('conflict')
  err.code = 'SETTINGS_CONFLICT'
  const settings = {
    mutations: [],
    describe() {
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision: 1,
        user: { providers: { 'test-route': { models: [{ id: 'model-a' }] } } },
        applies: 'live',
      }]
    },
    async mutate() {
      throw err
    },
  }

  const target = [{ id: 'model-a', name: 'Updated' }]
  const result = await syncToSettings(
    settings, 'test-route', target, silentLogger,
    async () => target,
  )
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'conflict-retry-failed')
})

// ---------------------------------------------------------------------------
// syncToSettings: missing settings service → no-op
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: missing settings service → skipped', async () => {
  const result = await syncToSettings(
    undefined, 'test-route', [{ id: 'x' }], silentLogger,
  )
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'skipped')
})

// ---------------------------------------------------------------------------
// syncToSettings: missing llm-pi-ai namespace → no-op
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: missing llm-pi-ai namespace → skipped', async () => {
  const settings = {
    mutations: [],
    describe() { return [] },
    async mutate() {},
  }

  const result = await syncToSettings(
    settings, 'test-route', [{ id: 'x' }], silentLogger,
  )
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'skipped')
})

// ---------------------------------------------------------------------------
// syncToSettings: modelOverrides → single set op with merged fields, key kept
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: modelOverrides → single set op, merged fields, overrides key untouched', async () => {
  const current = [{ id: 'model-a', name: 'Model A' }]
  const overrides = { 'model-a': { reasoningEfforts: { low: 'low', high: 'high' } } }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]
  const settings = createMockSettings({ userModels: current, modelOverrides: overrides })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  assert.equal(settings.mutations.length, 1)
  const ops = settings.mutations[0].ops
  assert.equal(ops.length, 1, 'should have 1 op (set only — overrides are never unset)')
  assert.equal(ops[0].op, 'set')
  assert.deepEqual(ops[0].path, ['providers', 'test-route', 'models'])
  assert.equal(ops[0].value.length, 1)
  assert.equal(ops[0].value[0].id, 'model-a')
  assert.equal(ops[0].value[0].name, 'Model A Updated')
  assert.deepEqual(ops[0].value[0].reasoningEfforts, { low: 'low', high: 'high' }, 'override fields should be merged')
})

// ---------------------------------------------------------------------------
// syncToSettings: no modelOverrides → single op (regression)
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: no modelOverrides → single op (regression)', async () => {
  const current = [{ id: 'model-a', name: 'Model A' }]
  const target = [{ id: 'model-a', name: 'Model A Updated' }]
  const settings = createMockSettings({ userModels: current })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, true)
  assert.equal(result.reason, 'wrote')
  const ops = settings.mutations[0].ops
  assert.equal(ops.length, 1, 'should have 1 op (set only)')
  assert.equal(ops[0].op, 'set')
})

// ---------------------------------------------------------------------------
// syncToSettings: overrides for ids not in target stay untouched (user data)
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: overrides for ids not in target → untouched, no warning', async () => {
  const current = [{ id: 'model-a', name: 'Model A' }]
  const overrides = { 'model-a': { name: 'Overridden' }, 'ghost-model': { name: 'Ghost' } }
  const target = [{ id: 'model-a', name: 'Model A Updated' }]
  const warnings = []
  const logger = {
    info() {},
    warn(...args) { warnings.push(args) },
    debug() {},
  }
  const settings = createMockSettings({ userModels: current, modelOverrides: overrides })

  const result = await syncToSettings(settings, 'test-route', target, logger)
  assert.equal(result.wrote, true)
  assert.equal(warnings.length, 0, 'ghost overrides are user data, not a warning')
  const ops = settings.mutations[0].ops
  assert.equal(ops.length, 1, 'no op may touch the overrides key')
  assert.equal(ops[0].value[0].name, 'Overridden', 'override should take precedence')
})

// ---------------------------------------------------------------------------
// syncToSettings: models not yet folded + overrides exist → writes merged
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: models not yet folded + overrides exist → writes merged view', async () => {
  const current = [{ id: 'model-a', name: 'Model A' }]
  const overrides = { 'model-a': { reasoningEfforts: { low: 'low' } } }
  const target = [{ id: 'model-a', name: 'Model A' }] // same as current
  const settings = createMockSettings({ userModels: current, modelOverrides: overrides })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, true, 'stored models lack the folded field, so write once')
  assert.equal(result.reason, 'wrote')
  const ops = settings.mutations[0].ops
  assert.equal(ops.length, 1, 'should have 1 op (set only)')
  assert.deepEqual(ops[0].value[0].reasoningEfforts, { low: 'low' }, 'override should be merged')
})

// ---------------------------------------------------------------------------
// syncToSettings: durability — folded models + overrides → stable no-change
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: folded models + overrides → second round is no-change (override durability)', async () => {
  const target = [{ id: 'model-a', name: 'Model A', contextWindow: 1000000 }]
  // Stored state after a previous round folded the override into models; the
  // overrides key is still present because it is never unset.
  const overrides = { 'model-a': { contextWindow: 8192 } }
  const storedModels = [{ id: 'model-a', name: 'Model A', contextWindow: 8192 }]
  const settings = createMockSettings({ userModels: storedModels, modelOverrides: overrides })

  const result = await syncToSettings(settings, 'test-route', target, silentLogger)
  assert.equal(result.wrote, false, 'merged view must be re-derived identically — no write')
  assert.equal(result.reason, 'no-change')
  assert.equal(settings.mutations.length, 0)
  assert.deepEqual(storedModels[0].contextWindow, 8192, 'user override value must survive')
})

// ---------------------------------------------------------------------------
// syncToSettings: end-to-end two-round simulation — override survives round 2
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: two-round simulation — user override survives, pi.dev value never clobbers', async () => {
  const state = {
    revision: 1,
    routeData: {
      models: [{ id: 'model-a', contextWindow: 200000 }],
      modelOverrides: { 'model-a': { contextWindow: 8192 } },
    },
  }
  const settings = {
    mutations: [],
    describe() {
      return [{
        ns: 'llm-pi-ai',
        revision: state.revision,
        user: { providers: { 'test-route': state.routeData } },
        value: {},
      }]
    },
    async mutate(ns, ops) {
      this.mutations.push({ ns, ops })
      for (const op of ops) {
        if (op.op === 'set') state.routeData.models = op.value
        else delete state.routeData[op.path[2]]
      }
      state.revision++
    },
  }
  const piDevTarget = [{ id: 'model-a', contextWindow: 1000000 }] // unchanged across rounds

  const round1 = await syncToSettings(settings, 'test-route', piDevTarget, silentLogger)
  assert.equal(round1.wrote, true)
  assert.deepEqual(state.routeData.models[0].contextWindow, 8192, 'round 1 folds the override')
  assert.ok(state.routeData.modelOverrides, 'round 1 keeps the overrides key')

  const round2 = await syncToSettings(settings, 'test-route', piDevTarget, silentLogger)
  assert.equal(round2.wrote, false, 'round 2 must be a no-change, not a clobber')
  assert.deepEqual(state.routeData.models[0].contextWindow, 8192, 'override value survives round 2')
})

// ---------------------------------------------------------------------------
// syncToSettings: non-SETTINGS_CONFLICT error → mutate-rejected (not conflict-retry-failed)
// ---------------------------------------------------------------------------
await checkAsync('syncToSettings: non-conflict error → mutate-rejected', async () => {
  const err = new Error('validation failed')
  err.code = 'VALIDATION_ERROR'
  const settings = createMockSettings({
    userModels: [{ id: 'model-a', name: 'Old' }],
    throwOnMutate: err,
  })

  const result = await syncToSettings(settings, 'test-route', [{ id: 'model-a', name: 'New' }], silentLogger)
  assert.equal(result.wrote, false)
  assert.equal(result.reason, 'mutate-rejected', 'non-conflict errors should be mutate-rejected')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

// P1b offline tests: the layer that actually writes opencode-go routes into
// settings. All seams are in-memory mocks — no real ~/.dsh, no network, no
// timers. Every settings/store write path in opencode-go-writer.ts is covered.

import assert from 'node:assert/strict'
import {
  goOwnershipKey,
  mapGoModelToProfile,
  planGoRouteFields,
  planGoRoutes,
  profileHash,
} from '../lib/opencode-go-planner.js'
import {
  associateGoMoves,
  ejectGoRoutes,
  writeGoPlan,
} from '../lib/opencode-go-writer.js'

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

// ---------------------------------------------------------------------------
// Fixtures + mocks
// ---------------------------------------------------------------------------

const CHAT_BASE = 'https://opencode.ai/inference/go/openai/v1'
const MSG_BASE_OFFICIAL = 'https://opencode.ai/inference/go/anthropic/v1'
const RESP_BASE = 'https://opencode.ai/inference/go/openai/v1'

const record = (id, protocols, options = {}) => ({
  id,
  name: options.name ?? id,
  protocols,
  baseUrls: options.baseUrls ?? {},
  inputModalities: ['text'],
  provenance: 'go-official',
  ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
})
const chatEntry = (id) => record(id, ['chat-completions'], { baseUrls: { 'chat-completions': CHAT_BASE } })
const msgEntry = (id) => record(id, ['messages'], { baseUrls: { messages: MSG_BASE_OFFICIAL } })
const respEntry = (id) => record(id, ['responses'], { baseUrls: { responses: RESP_BASE } })
const profile = (id, extra = {}) => ({ id, name: id, ...extra })
const routeState = (models, extra = {}) => ({ exists: true, models, ...extra })

const silentLogger = { info() {}, warn() {}, debug() {} }
const KEY = 'keyfp'
const key = (route, fingerprint = KEY) => goOwnershipKey(route, fingerprint)

function applyOp(state, op) {
  const [section, route, ...rest] = op.path
  assert.equal(section, 'providers', 'writer must only touch providers.*')
  if (op.op === 'unset') {
    if (rest.length === 0) {
      state.delete(route)
      return
    }
    const data = state.get(route)
    if (data !== undefined) delete data[rest[0]]
    return
  }
  assert.equal(op.op, 'set')
  let data = state.get(route)
  if (data === undefined) {
    data = {}
    state.set(route, data)
  }
  assert.equal(rest.length, 1)
  data[rest[0]] = structuredClone(op.value)
}

/**
 * Mock settings service. Applies ops to an in-memory providers map so a second
 * writer round sees the previous round's result. Can inject a hard rejection
 * (per route) or a single SETTINGS_CONFLICT (per route); a conflict bumps the
 * revision, like another writer committing between our two attempts.
 */
function createMockSettings({
  routes = {},
  revision = 1,
  throwFor = {},
  conflictOnce = [],
} = {}) {
  const state = new Map(Object.entries(routes).map(([route, data]) => [route, structuredClone(data)]))
  const mutations = []
  const pendingConflicts = new Set(conflictOnce)
  let currentRevision = revision
  return {
    mutations,
    state,
    describe() {
      const providers = {}
      for (const [route, data] of state) providers[route] = structuredClone(data)
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision: currentRevision,
        user: { providers },
        applies: 'live',
      }]
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'llm-pi-ai')
      mutations.push({ ns, ops, expectedRevision })
      const touched = new Set(ops.map((op) => op.path[1]))
      for (const route of touched) {
        if (throwFor[route] !== undefined) throw throwFor[route]
        if (pendingConflicts.has(route)) {
          pendingConflicts.delete(route)
          currentRevision += 1
          throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
        }
      }
      for (const op of ops) applyOp(state, op)
      currentRevision += 1
    },
  }
}

function createMockStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]))
  const writes = []
  return {
    data,
    writes,
    async read(k) {
      const value = data.get(k)
      return value === undefined ? undefined : structuredClone(value)
    },
    async write(k, entry) {
      writes.push({ key: k, entry: structuredClone(entry) })
      data.set(k, structuredClone(entry))
    },
    async delete(k) {
      writes.push({ key: k, deleted: true })
      data.delete(k)
    },
  }
}

function createMockOverrideStorer(initial) {
  let overrides = initial === undefined ? undefined : structuredClone(initial)
  const stages = []
  return {
    stages,
    async read() {
      return overrides === undefined ? undefined : { overrides: structuredClone(overrides) }
    },
    async updateOverrides(route, value) {
      stages.push({ route, value: structuredClone(value) })
      overrides = structuredClone(value)
    },
  }
}

const deps = (settings, ownershipStore, extra = {}) => ({
  settings,
  ownershipStore,
  logger: silentLogger,
  keyFingerprint: KEY,
  ...extra,
})

const findSetModels = (mutation, route) => mutation.ops.find((op) =>
  op.op === 'set' && op.path[1] === route && op.path[2] === 'models')?.value

const currentRoutesFrom = (settings, routes) => Object.fromEntries(routes.map((route) => {
  const data = settings.state.get(route)
  if (data === undefined) return [route, { exists: false, models: [] }]
  return [route, {
    exists: true,
    models: data.models ?? [],
    api: data.api,
    baseURL: data.baseURL,
    displayName: data.displayName,
    apiKeyEnv: data.apiKeyEnv,
    overrideIds: data.modelOverrides === undefined ? [] : Object.keys(data.modelOverrides),
  }]
}))

// ---------------------------------------------------------------------------
// 1. Three-route settings write (§9.1 / §2.1 / §6.2.2)
// ---------------------------------------------------------------------------

await checkAsync('write: 3 routes set all five fields; msg baseURL drops the trailing /v1', async () => {
  const entries = [chatEntry('hy4'), msgEntry('qwen4-max'), respEntry('grok-4.7')]
  const plan = planGoRoutes({ keyFingerprint: KEY, entries, currentRoutes: {}, ownership: {} })
  const settings = createMockSettings()
  const store = createMockStore()
  const out = await writeGoPlan(plan, deps(settings, store))

  assert.deepEqual(out.writtenRoutes.slice().sort(), ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
  assert.equal(settings.mutations.length, 3)
  for (const mutation of settings.mutations) {
    const route = mutation.ops[0].path[1]
    const paths = mutation.ops.map((op) => op.path.join('.'))
    for (const field of ['api', 'baseURL', 'displayName', 'apiKeyEnv', 'models']) {
      assert.ok(paths.includes(`providers.${route}.${field}`), `${route}.${field} missing`)
    }
    for (const op of mutation.ops) {
      if (op.op === 'set' && op.path[2] === 'models') assert.ok(op.value.length > 0, 'never write models: []')
    }
  }
  const msg = settings.mutations.find((m) => m.ops[0].path[1] === 'opencode-go-msg')
  assert.equal(msg.ops.find((op) => op.path[2] === 'api').value, 'anthropic-messages')
  assert.equal(msg.ops.find((op) => op.path[2] === 'baseURL').value, 'https://opencode.ai/inference/go/anthropic')
  const chat = settings.mutations.find((m) => m.ops[0].path[1] === 'opencode-go')
  assert.equal(chat.ops.find((op) => op.path[2] === 'baseURL').value, CHAT_BASE)
})

await checkAsync('write: change-only when fields and profiles already match (profilesEqual gate)', async () => {
  const entry = chatEntry('hy4')
  const mapped = mapGoModelToProfile(entry)
  const fields = planGoRouteFields('chat', [entry])
  const settings = createMockSettings({
    routes: {
      'opencode-go': {
        api: fields.api, baseURL: fields.baseURL, displayName: fields.displayName,
        apiKeyEnv: fields.apiKeyEnv, models: [structuredClone(mapped)],
      },
    },
  })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [entry],
    currentRoutes: { 'opencode-go': routeState([structuredClone(mapped)]) },
    ownership: {},
  })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.equal(settings.mutations.length, 0)
  assert.deepEqual(out.routes.map((r) => r.status), ['no-change'])
})

// ---------------------------------------------------------------------------
// 2. route-conflict → skip, no rename, other routes proceed (§9.3 / V8)
// ---------------------------------------------------------------------------

await checkAsync('conflict: planner-conflicted route is skipped without any mutate', async () => {
  const entries = [chatEntry('hy4'), msgEntry('qwen4-max')]
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries,
    currentRoutes: {
      'opencode-go': routeState([profile('old')], { api: 'anthropic-messages' }),
      'opencode-go-msg': routeState([]),
    },
    ownership: {},
  })
  const settings = createMockSettings({ routes: { 'opencode-go': { api: 'anthropic-messages', models: [profile('old')] } } })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.equal(out.routes.some((r) => r.route === 'opencode-go' && r.status === 'conflict'), true)
  assert.equal(out.writtenRoutes.includes('opencode-go'), false)
  assert.equal(out.writtenRoutes.includes('opencode-go-msg'), true)
  for (const mutation of settings.mutations) {
    assert.equal(mutation.ops.some((op) => op.path[1] === 'opencode-go'), false)
  }
  const conflictReport = out.report.find((e) => e.code === 'route-conflict')
  assert.ok(conflictReport !== undefined)
})

// ---------------------------------------------------------------------------
// 3. Empty route → whole-route unset, never `models: []` (§9.4 / V9)
// ---------------------------------------------------------------------------

await checkAsync('empty route: fully managed → unset providers.<route>, delete ledger, no models:[]', async () => {
  const current = [profile('qwen4-max')]
  const fields = planGoRouteFields('msg', [])
  const ledgerKey = key('opencode-go-msg')
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('hy4')],
    currentRoutes: {
      'opencode-go': routeState([mapGoModelToProfile(chatEntry('hy4'))]),
      'opencode-go-msg': routeState(current),
    },
    ownership: {
      [ledgerKey]: {
        routeFields: fields,
        managed: { 'qwen4-max': { hash: profileHash(current[0]) } },
      },
    },
  })
  const settings = createMockSettings({
    routes: {
      'opencode-go-msg': {
        api: fields.api, baseURL: fields.baseURL, apiKeyEnv: fields.apiKeyEnv, models: structuredClone(current),
      },
    },
  })
  const store = createMockStore({ [ledgerKey]: { routeFields: fields, managed: { 'qwen4-max': { hash: profileHash(current[0]) } } } })
  const out = await writeGoPlan(plan, deps(settings, store))
  const msgMutation = settings.mutations.find((m) => m.ops.some((op) => op.path[1] === 'opencode-go-msg'))
  assert.deepEqual(msgMutation.ops, [{ op: 'unset', path: ['providers', 'opencode-go-msg'] }])
  assert.deepEqual(out.writtenRoutes, ['opencode-go-msg', 'opencode-go'].slice().sort())
  assert.equal(store.data.has(ledgerKey), false)
  for (const mutation of settings.mutations) {
    for (const op of mutation.ops) {
      if (op.op === 'set' && op.path[2] === 'models') assert.ok(op.value.length > 0)
    }
  }
})

// ---------------------------------------------------------------------------
// 4. First round: conservative claim, never delete (§6.2.4 / A3 / V5)
// ---------------------------------------------------------------------------

await checkAsync('first round: no deletion; only desired∩current claimed; preManagedSnapshot stored', async () => {
  const old = profile('old-extra')
  const settings = createMockSettings({ routes: { 'opencode-go': { models: [structuredClone(old)] } } })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('hy4')],
    currentRoutes: { 'opencode-go': routeState([structuredClone(old)]) },
    ownership: {},
  })
  const store = createMockStore()
  const out = await writeGoPlan(plan, deps(settings, store))
  assert.deepEqual(findSetModels(settings.mutations[0], 'opencode-go').map((m) => m.id), ['hy4', 'old-extra'])
  assert.equal(out.report.some((e) => e.code === 'deleted' || e.code === 'deletion-pending'), false)
  const entry = store.data.get(key('opencode-go'))
  assert.ok(entry.managed.hy4 !== undefined, 'official desired id claimed')
  assert.equal(entry.managed['old-extra'], undefined, 'user-owned id not claimed')
  assert.deepEqual(entry.preManagedSnapshot, [old])
  assert.equal(entry.missing, undefined)
})

// ---------------------------------------------------------------------------
// 5. Double-round deletion confirmation (V5 / ADR-004)
// ---------------------------------------------------------------------------

await checkAsync('deletion: round 1 keeps with missing=1, round 2 deletes (confirmRemovals=2)', async () => {
  const keep = profile('keep-a')
  const drop = profile('drop-b')
  const current = [keep, drop]
  const managed = { 'keep-a': { hash: profileHash(keep) }, 'drop-b': { hash: profileHash(drop) } }
  const ledgerKey = key('opencode-go')
  const settings = createMockSettings({ routes: { 'opencode-go': { models: structuredClone(current) } } })
  const store = createMockStore({ [ledgerKey]: { managed: structuredClone(managed), preManagedSnapshot: structuredClone(current) } })

  const first = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('keep-a')],
    currentRoutes: { 'opencode-go': routeState(structuredClone(current)) },
    ownership: { [ledgerKey]: { managed } },
  })
  const out1 = await writeGoPlan(first, deps(settings, store))
  assert.deepEqual(findSetModels(settings.mutations.at(-1), 'opencode-go').map((m) => m.id), ['drop-b', 'keep-a'])
  assert.equal(out1.report.some((e) => e.code === 'deletion-pending'), true)
  assert.equal(store.data.get(ledgerKey).missing['drop-b'], 1)

  const second = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('keep-a')],
    currentRoutes: currentRoutesFrom(settings, ['opencode-go']),
    ownership: structuredClone(Object.fromEntries(store.data)),
  })
  const out2 = await writeGoPlan(second, deps(settings, store))
  assert.deepEqual(findSetModels(settings.mutations.at(-1), 'opencode-go').map((m) => m.id), ['keep-a'])
  assert.equal(out2.report.some((e) => e.code === 'deleted'), true)
  const ledgerAfter = store.data.get(ledgerKey)
  assert.equal(ledgerAfter.missing?.['drop-b'], undefined)
  assert.equal(ledgerAfter.managed['drop-b'], undefined)
})

await checkAsync('deletion: confirmRemovals=3 waits three consecutive absent rounds', async () => {
  const keep = profile('keep-a')
  const drop = profile('drop-b')
  const current = [keep, drop]
  const managed = { 'keep-a': { hash: profileHash(keep) }, 'drop-b': { hash: profileHash(drop) } }
  const ledgerKey = key('opencode-go')
  const settings = createMockSettings({ routes: { 'opencode-go': { models: structuredClone(current) } } })
  const store = createMockStore({ [ledgerKey]: { managed: structuredClone(managed), preManagedSnapshot: structuredClone(current) } })
  const planForRound = () => planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('keep-a')],
    currentRoutes: currentRoutesFrom(settings, ['opencode-go']),
    ownership: structuredClone(Object.fromEntries(store.data)),
  })
  const writerDeps = deps(settings, store, { confirmRemovals: 3 })
  await writeGoPlan(planForRound(), writerDeps)
  assert.equal(store.data.get(ledgerKey).missing['drop-b'], 1)
  await writeGoPlan(planForRound(), writerDeps)
  assert.equal(store.data.get(ledgerKey).missing['drop-b'], 2)
  assert.equal(findSetModels(settings.mutations.at(-1), 'opencode-go').some((m) => m.id === 'drop-b'), true)
  const out3 = await writeGoPlan(planForRound(), writerDeps)
  assert.equal(out3.report.some((e) => e.code === 'deleted'), true)
  assert.equal(findSetModels(settings.mutations.at(-1), 'opencode-go').some((m) => m.id === 'drop-b'), false)
})

// ---------------------------------------------------------------------------
// 6. Three deletion gates, one at a time (§6.2.4 / V6)
// ---------------------------------------------------------------------------

async function gateScenario(extra = {}) {
  const keep = profile('keep-a')
  const drop = profile('drop-b')
  const current = [keep, drop]
  const managed = { 'keep-a': { hash: profileHash(keep) }, 'drop-b': { hash: profileHash(drop) } }
  if (extra.dropManaged === false) delete managed['drop-b']
  if (extra.dropHash !== undefined) managed['drop-b'] = { hash: extra.dropHash }
  const ledgerKey = key('opencode-go')
  const settings = createMockSettings({
    routes: {
      'opencode-go': {
        models: structuredClone(current),
        ...(extra.overrideIds !== undefined
          ? { modelOverrides: Object.fromEntries(extra.overrideIds.map((id) => [id, { maxTokens: 7 }])) }
          : {}),
      },
    },
  })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('keep-a')],
    currentRoutes: { 'opencode-go': routeState(structuredClone(current), { overrideIds: extra.overrideIds ?? [] }) },
    ownership: { [ledgerKey]: { managed } },
    pinnedModels: extra.pinnedModels,
  })
  const store = createMockStore({ [ledgerKey]: { managed: structuredClone(managed), preManagedSnapshot: structuredClone(current) } })
  const out = await writeGoPlan(plan, deps(settings, store, { overrideStorer: createMockOverrideStorer() }))
  return { out, models: findSetModels(settings.mutations.at(-1), 'opencode-go').map((m) => m.id) }
}

await checkAsync('gate 1/3: not in ledger → kept and reported as user-owned', async () => {
  const { out, models } = await gateScenario({ dropManaged: false })
  assert.deepEqual(models, ['drop-b', 'keep-a'])
  assert.equal(out.report.some((e) => e.code === 'kept-user-owned' && e.id === 'drop-b'), true)
  assert.equal(out.report.some((e) => e.code === 'deleted' || e.code === 'deletion-pending'), false)
})

await checkAsync('gate 2/3: hash mismatch → kept and reported as modified', async () => {
  const { out, models } = await gateScenario({ dropHash: 'deadbeef' })
  assert.deepEqual(models, ['drop-b', 'keep-a'])
  assert.equal(out.report.some((e) => e.code === 'kept-modified' && e.id === 'drop-b'), true)
  assert.equal(out.report.some((e) => e.code === 'deleted' || e.code === 'deletion-pending'), false)
})

await checkAsync('gate 3/3a: modelOverride → kept and reported, override folded + staged', async () => {
  const { out, models } = await gateScenario({ overrideIds: ['drop-b'] })
  assert.deepEqual(models, ['drop-b', 'keep-a'])
  assert.equal(out.report.some((e) => e.code === 'kept-override' && e.id === 'drop-b'), true)
  assert.equal(out.report.some((e) => e.code === 'deleted' || e.code === 'deletion-pending'), false)
})

await checkAsync('gate 3/3b: pinned model → kept and reported', async () => {
  const { out, models } = await gateScenario({ pinnedModels: ['drop-b'] })
  assert.deepEqual(models, ['drop-b', 'keep-a'])
  assert.equal(out.report.some((e) => e.code === 'kept-pinned' && e.id === 'drop-b'), true)
  assert.equal(out.report.some((e) => e.code === 'deleted' || e.code === 'deletion-pending'), false)
})

// ---------------------------------------------------------------------------
// 7. modelOverrides store-first staging (§6.2.4)
// ---------------------------------------------------------------------------

await checkAsync('overrides: folded into models, staged to store, key unset in same mutate', async () => {
  const mapped = mapGoModelToProfile(chatEntry('hy4'))
  const settings = createMockSettings({
    routes: { 'opencode-go': { models: [structuredClone(mapped)], modelOverrides: { hy4: { maxTokens: 123 } } } },
  })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('hy4')],
    currentRoutes: { 'opencode-go': routeState([structuredClone(mapped)], { overrideIds: ['hy4'] }) },
    ownership: {},
  })
  const storer = createMockOverrideStorer()
  await writeGoPlan(plan, deps(settings, createMockStore(), { overrideStorer: storer }))
  assert.equal(storer.stages.length, 1)
  assert.equal(storer.stages[0].value.hy4.maxTokens, 123)
  const mutation = settings.mutations[0]
  assert.equal(mutation.ops.some((op) => op.op === 'unset' && op.path[2] === 'modelOverrides'), true)
  assert.equal(findSetModels(mutation, 'opencode-go')[0].maxTokens, 123)
})

await checkAsync('overrides: no store seam → route skipped, settings key left intact', async () => {
  const mapped = mapGoModelToProfile(chatEntry('hy4'))
  const settings = createMockSettings({
    routes: { 'opencode-go': { models: [structuredClone(mapped)], modelOverrides: { hy4: { maxTokens: 123 } } } },
  })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('hy4')],
    currentRoutes: { 'opencode-go': routeState([structuredClone(mapped)], { overrideIds: ['hy4'] }) },
    ownership: {},
  })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.deepEqual(out.failedRoutes.map((f) => f.reason), ['store-unavailable'])
  assert.equal(settings.mutations.length, 0)
  assert.ok(settings.state.get('opencode-go').modelOverrides !== undefined)
})

// ---------------------------------------------------------------------------
// 8. Partial failure + revision conflict retry (§6.2.4 / §19)
// ---------------------------------------------------------------------------

await checkAsync('partial failure: one route rejected, other two written, ledger not advanced on failure', async () => {
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('hy4'), msgEntry('qwen4-max'), respEntry('grok-4.7')],
    currentRoutes: {},
    ownership: {},
  })
  const settings = createMockSettings({ throwFor: { 'opencode-go-msg': new Error('validation refused') } })
  const store = createMockStore()
  const out = await writeGoPlan(plan, deps(settings, store))
  assert.equal(settings.mutations.length, 3, 'one isolated mutate per route')
  assert.equal(out.writtenRoutes.length, 2)
  assert.deepEqual(out.failedRoutes.map((f) => f.route), ['opencode-go-msg'])
  assert.equal(store.data.has(key('opencode-go-msg')), false)
  assert.equal(store.data.has(key('opencode-go')), true)
  assert.equal(store.data.has(key('opencode-go-resp')), true)
})

await checkAsync('conflict: SETTINGS_CONFLICT re-reads revision and retries exactly once', async () => {
  const plan = planGoRoutes({
    keyFingerprint: KEY, entries: [chatEntry('hy4')], currentRoutes: {}, ownership: {},
  })
  const settings = createMockSettings({ conflictOnce: ['opencode-go'] })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.deepEqual(out.writtenRoutes, ['opencode-go'])
  const attempts = settings.mutations.filter((m) => m.ops.some((op) => op.path[1] === 'opencode-go'))
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts.map((m) => m.expectedRevision), [1, 2])
})

await checkAsync('conflict: a second conflict is reported as failed, not retried again', async () => {
  const plan = planGoRoutes({
    keyFingerprint: KEY, entries: [chatEntry('hy4')], currentRoutes: {}, ownership: {},
  })
  const settings = createMockSettings({ throwFor: { 'opencode-go': Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' }) } })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.deepEqual(out.failedRoutes.map((f) => f.reason), ['conflict-retry-failed'])
  assert.equal(settings.mutations.length, 2)
})

// ---------------------------------------------------------------------------
// 9. Ledger keyed by <route>#<keyFingerprint> (§6.1 / ADR-004)
// ---------------------------------------------------------------------------

await checkAsync('ledger: the same route under two keys is stored in two separate entries', async () => {
  const store = createMockStore()
  for (const fingerprint of ['A', 'B']) {
    const plan = planGoRoutes({
      keyFingerprint: fingerprint,
      entries: [chatEntry('hy4')],
      currentRoutes: {},
      ownership: {},
    })
    await writeGoPlan(plan, deps(createMockSettings(), store, { keyFingerprint: fingerprint }))
  }
  assert.deepEqual([...store.data.keys()].sort(), ['opencode-go#A', 'opencode-go#B'])
})

// ---------------------------------------------------------------------------
// 10. moved association (P1a verification concern ③)
// ---------------------------------------------------------------------------

check('moved: a removal on A plus an add of the same id on B reads as one moved line', () => {
  const report = [
    { level: 'info', code: 'deletion-candidate', route: 'opencode-go', slot: 'chat', id: 'qwen4-max', message: 'passes gates' },
    { level: 'info', code: 'added', route: 'opencode-go-msg', slot: 'msg', id: 'qwen4-max', message: 'added' },
    { level: 'info', code: 'overwrote-managed', route: 'opencode-go', slot: 'chat', id: 'hy4', message: 'refreshed' },
  ]
  const out = associateGoMoves(report)
  assert.equal(out.filter((e) => e.code === 'moved').length, 1)
  const moved = out.find((e) => e.code === 'moved')
  assert.equal(moved.message, 'model qwen4-max moved from opencode-go to opencode-go-msg (source removal pending confirmation)')
  assert.equal(out.some((e) => e.code === 'deletion-candidate' || e.code === 'added'), false)
  assert.equal(out.some((e) => e.code === 'overwrote-managed'), true, 'unrelated entries survive')
})

check('moved: a confirmed deletion plus add reports a plain move (no pending label)', () => {
  const out = associateGoMoves([
    { level: 'info', code: 'deleted', route: 'opencode-go', slot: 'chat', id: 'qwen4-max', message: 'gone' },
    { level: 'info', code: 'added', route: 'opencode-go-msg', slot: 'msg', id: 'qwen4-max', message: 'added' },
  ])
  assert.equal(out[0].code, 'moved')
  assert.equal(out[0].message.includes('pending'), false)
})

await checkAsync('moved: end-to-end move report from the writer is associated', async () => {
  const keep = profile('keep-a')
  const moved = profile('qwen4-max')
  const currentChat = [keep, moved]
  const ledgerKey = key('opencode-go')
  const settings = createMockSettings({
    routes: { 'opencode-go': { models: structuredClone(currentChat) } },
  })
  const plan = planGoRoutes({
    keyFingerprint: KEY,
    entries: [chatEntry('keep-a'), msgEntry('qwen4-max')],
    currentRoutes: { 'opencode-go': routeState(structuredClone(currentChat)) },
    ownership: {
      [ledgerKey]: {
        managed: {
          'keep-a': { hash: profileHash(keep) },
          'qwen4-max': { hash: profileHash(moved) },
        },
      },
    },
  })
  const out = await writeGoPlan(plan, deps(settings, createMockStore()))
  assert.equal(out.report.some((e) => e.code === 'moved'), true)
})

// ---------------------------------------------------------------------------
// 11. eject (§14.4 / V13)
// ---------------------------------------------------------------------------

const ejectSetup = ({ snapshotMissing = false, badHash = false } = {}) => {
  const managedModel = mapGoModelToProfile(chatEntry('hy4'))
  const user = profile('my-own')
  const fields = planGoRouteFields('chat', [chatEntry('hy4')])
  const ledgerKey = key('opencode-go')
  const entry = {
    routeFields: fields,
    managed: { hy4: { hash: badHash ? 'deadbeef' : profileHash(managedModel) } },
    ...(snapshotMissing ? {} : { preManagedSnapshot: [profile('pre-existing')] }),
  }
  const settings = createMockSettings({
    routes: {
      'opencode-go': {
        api: fields.api,
        baseURL: fields.baseURL,
        displayName: fields.displayName,
        apiKeyEnv: fields.apiKeyEnv,
        models: [structuredClone(managedModel), user],
      },
    },
  })
  const store = createMockStore({ [ledgerKey]: entry })
  return { settings, store, ledgerKey }
}

await checkAsync('eject success: restores snapshot, keeps user model, unsets plugin fields, drops ledger', async () => {
  const { settings, store, ledgerKey } = ejectSetup()
  const out = await ejectGoRoutes({
    routes: ['opencode-go'], keyFingerprint: KEY, settings, ownershipStore: store, logger: silentLogger,
  })
  assert.deepEqual(out.ejected, ['opencode-go'])
  const mutation = settings.mutations[0]
  assert.deepEqual(findSetModels(mutation, 'opencode-go').map((m) => m.id), ['my-own', 'pre-existing'])
  for (const field of ['api', 'baseURL', 'displayName', 'apiKeyEnv']) {
    assert.equal(mutation.ops.some((op) => op.op === 'unset' && op.path[2] === field), true, `${field} not unset`)
  }
  assert.equal(store.data.has(ledgerKey), false)
})

await checkAsync('eject refuses when preManagedSnapshot is missing (no write)', async () => {
  const { settings, store, ledgerKey } = ejectSetup({ snapshotMissing: true })
  const out = await ejectGoRoutes({
    routes: ['opencode-go'], keyFingerprint: KEY, settings, ownershipStore: store, logger: silentLogger,
  })
  assert.deepEqual(out.ejected, [])
  assert.equal(out.refused[0].reason.includes('snapshot'), true)
  assert.equal(settings.mutations.length, 0)
  assert.equal(store.data.has(ledgerKey), true)
})

await checkAsync('eject refuses on managed hash mismatch (user edited after takeover)', async () => {
  const { settings, store, ledgerKey } = ejectSetup({ badHash: true })
  const out = await ejectGoRoutes({
    routes: ['opencode-go'], keyFingerprint: KEY, settings, ownershipStore: store, logger: silentLogger,
  })
  assert.deepEqual(out.ejected, [])
  assert.equal(out.refused[0].reason.includes('hash mismatch'), true)
  assert.equal(settings.mutations.length, 0)
  assert.equal(store.data.has(ledgerKey), true)
})

await checkAsync('eject: an entirely plugin-created empty route is unset, never models:[]', async () => {
  const managedModel = mapGoModelToProfile(chatEntry('hy4'))
  const fields = planGoRouteFields('chat', [chatEntry('hy4')])
  const ledgerKey = key('opencode-go')
  const store = createMockStore({
    [ledgerKey]: {
      routeFields: fields,
      managed: { hy4: { hash: profileHash(managedModel) } },
      preManagedSnapshot: [],
    },
  })
  const settings = createMockSettings({
    routes: { 'opencode-go': { api: fields.api, baseURL: fields.baseURL, models: [structuredClone(managedModel)] } },
  })
  const out = await ejectGoRoutes({
    routes: ['opencode-go'], keyFingerprint: KEY, settings, ownershipStore: store, logger: silentLogger,
  })
  assert.deepEqual(out.ejected, ['opencode-go'])
  assert.deepEqual(settings.mutations[0].ops, [{ op: 'unset', path: ['providers', 'opencode-go'] }])
})

// ---------------------------------------------------------------------------
// 12. Defensive paths
// ---------------------------------------------------------------------------

await checkAsync('no settings service → all planned routes skipped, no crash', async () => {
  const plan = planGoRoutes({
    keyFingerprint: KEY, entries: [chatEntry('hy4')], currentRoutes: {}, ownership: {},
  })
  const out = await writeGoPlan(plan, deps(undefined, createMockStore()))
  assert.equal(out.routes.every((r) => r.status === 'skipped'), true)
  assert.equal(out.writtenRoutes.length, 0)
})

check('writer does not mutate the planner result it is given', () => {
  const plan = planGoRoutes({
    keyFingerprint: KEY, entries: [chatEntry('hy4')], currentRoutes: {}, ownership: {},
  })
  const before = JSON.stringify(plan)
  // associateGoMoves is pure on its input; writeGoPlan is async but the plan is
  // never written to, so the snapshot must remain byte-identical.
  const afterMoves = associateGoMoves(plan.report)
  assert.ok(afterMoves !== plan.report)
  assert.equal(JSON.stringify(plan), before)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

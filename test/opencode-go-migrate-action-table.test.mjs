// B2/B6 behaviour assertions: the per-id action table is the ONLY write source.
//
// All I/O is injected (in-memory settings/ledger/migration store, fixture
// catalog, no real ~/.dsh, no network). Tests assert SETTINGS/OUTCOMES, not
// "function was called": every plan row is checked against the resulting route
// contents, ledger and consent result.
//
// Scenarios (task B2 implementation brief §测试):
//   1 ack tri-state  2 adopt keeps KEEP rows  3 pinned config → both routes
//   4 user-extra prune switch  5 no catalog → unclassified never deleted
//   6 unknown-retired adopt-only  7 plan↔apply row-by-row (update untouched)
//   8 conservative ledger = actual writes  9 adopt-disabled refusal

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'
import { parseGoModelsPayload } from '../lib/opencode-go-source.js'
import { buildMigrationPlanFromDeps, applyMigration } from '../lib/opencode-go-migrate.js'
import {
  GO_MIGRATION_STORE_SERVICE,
} from '../lib/opencode-go-migration.js'
import {
  GO_FETCH_SERVICE,
  GO_OWNERSHIP_STORE_SERVICE,
  GO_OVERRIDE_STORER_SERVICE,
} from '../lib/opencode-go-sync.js'
import {
  GO_MIGRATION_ENTRIES_SERVICE,
  GO_MIGRATION_PUBLIC_CATALOG_SERVICE,
  GO_MIGRATION_ADOPT_DISABLED_SERVICE,
} from '../lib/index.js'
import {
  GO_SCHEDULER_RANDOM_SERVICE,
  GO_SCHEDULER_TIMERS_SERVICE,
} from '../lib/opencode-go-scheduler.js'

let failed = 0
let passed = 0
const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.stack ?? error.message}`)
  }
}

const KEY = 'test-go-key'
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))
const OFFICIAL = parseGoModelsPayload(FIXTURE).filter((entry) => entry.id !== 'gemini-4-argon')
const OFFICIAL_IDS = OFFICIAL.map((entry) => entry.id)

const LEGACY_CHAT = {
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://opencode.ai/inference/go/openai/v1',
  displayName: 'OpenCode Go',
  models: [{ id: 'custom-test-model', name: 'custom-test-model', input: ['text'] }],
}

function mockSettings(initialRoutes = {}) {
  const state = new Map(Object.entries(initialRoutes).map(([r, d]) => [r, structuredClone(d)]))
  const mutations = []
  let revision = 1
  return {
    state, mutations,
    get revision() { return revision },
    describe() {
      return [
        { ns: 'llm-pi-ai', revision, user: { providers: Object.fromEntries([...state].map(([r, d]) => [r, structuredClone(d)])) } },
        { ns: 'dsh-model-sync', revision: 1, user: {} },
      ]
    },
    async mutate(ns, ops, expectedRevision) {
      if (ns !== 'llm-pi-ai') throw new Error('unexpected namespace')
      if (expectedRevision !== revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
      mutations.push(structuredClone(ops))
      for (const op of ops) {
        const route = op.path[1]
        if (op.op === 'unset' && op.path.length === 2) { state.delete(route); continue }
        let data = state.get(route)
        if (data === undefined) { data = {}; state.set(route, data) }
        if (op.op === 'unset') delete data[op.path[2]]
        else data[op.path[2]] = structuredClone(op.value)
      }
      revision += 1
    },
  }
}

function makeConfig(overrides = {}) {
  const base = {
    writeMode: 'settings', intervalMinutes: 0, startupDelaySeconds: 0,
    refreshTimeoutMs: 120000, managedRoutes: ['opencode-go'], keepBuiltinOnly: false,
    dropUnserviceable: true, syncNotify: false, forceMaxReasoningEffort: false,
    providerNativeFetch: false, keepDeprecatedBuiltin: false,
  }
  const config = Object.fromEntries(Object.entries({ ...base, ...overrides }).map(([k, v]) => [k, { get: () => v }]))
  config.opencode = {
    go: {
      enabled: true, ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      pinnedModels: [], confirmRemovals: 2, adoptExisting: false,
      routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp', google: 'opencode-go-google' },
      ...(overrides.go ?? {}),
    },
  }
  return config
}

function createHarness({
  initialRoutes = {},
  configOverrides = {},
  publicCatalog,
  adoptDisabled,
} = {}) {
  const settings = mockSettings(initialRoutes)
  const timers = []
  const state = { definitions: [], disposers: [], provided: {} }
  let storedRecord
  const counters = { migrationWrites: 0, ledgerWrites: 0 }
  const migrationStore = {
    async read() { return storedRecord === undefined ? undefined : structuredClone(storedRecord) },
    async write(next) { counters.migrationWrites += 1; storedRecord = structuredClone(next) },
    get record() { return storedRecord === undefined ? undefined : structuredClone(storedRecord) },
    set record(v) { storedRecord = v },
  }
  const ledgerData = new Map()
  const ownership = {
    async read(k) { const v = ledgerData.get(k); return v === undefined ? undefined : structuredClone(v) },
    async write(k, v) { counters.ledgerWrites += 1; ledgerData.set(k, structuredClone(v)) },
    async delete(k) { ledgerData.delete(k) },
    get data() { return ledgerData },
  }
  const fetchImpl = async () => ({ status: 200, json: async () => ({ object: 'list', data: [] }) })
  const services = {
    settings,
    [GO_MIGRATION_STORE_SERVICE]: migrationStore,
    [GO_OWNERSHIP_STORE_SERVICE]: ownership,
    [GO_OVERRIDE_STORER_SERVICE]: { async read() { return undefined }, async updateOverrides() {} },
    [GO_FETCH_SERVICE]: fetchImpl,
    [GO_MIGRATION_ENTRIES_SERVICE]: OFFICIAL,
    [GO_SCHEDULER_TIMERS_SERVICE]: {
      setTimeout(fn, ms) { const h = { fn, ms }; timers.push(h); return h },
      clearTimeout(h) { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1) },
    },
    [GO_SCHEDULER_RANDOM_SERVICE]: { next: () => 0 },
    credentials: {
      describe: async () => ({ configured: true }),
      resolve: async () => ({ value: KEY }),
      set: async () => {}, unset: async () => {},
    },
    launchEnvironment: { get: () => undefined },
  }
  if (publicCatalog !== undefined) services[GO_MIGRATION_PUBLIC_CATALOG_SERVICE] = publicCatalog
  if (adoptDisabled !== undefined) services[GO_MIGRATION_ADOPT_DISABLED_SERVICE] = adoptDisabled

  const ctx = {
    settings,
    get: (name) => services[name],
    logger: { info() {}, warn() {}, debug() {} },
    on() { return () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposers.push(d); return d },
    provide(name, service) { state.provided[name] = service },
    inject(names, cb) { cb(Object.create(ctx)) },
    commands: { register(def) { state.definitions.push(def); return () => {} } },
  }
  apply(ctx, makeConfig(configOverrides))
  const invoke = (text) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text })
  }
  return {
    settings, state, invoke, services, migrationStore, ownership, counters,
    dispose: () => { for (const d of state.disposers) d() },
  }
}

const idsOf = (h, route) => h.settings.state.get(route)?.models?.map((m) => m.id) ?? []
const parsePlan = (text) => ({
  planHash: /planHash: ([0-9a-f]{64})/.exec(text)?.[1],
  confirmCode: /confirmCode: (\d{6})/.exec(text)?.[1],
  text,
})

/** Direct deps for pure plan + apply calls (no command-layer flag parsing). */
function directDeps(h, overrides = {}) {
  return {
    settings: h.settings,
    ownershipStore: h.ownership,
    migrationStore: h.migrationStore,
    logger: { info() {}, warn() {}, debug() {} },
    entries: overrides.entries ?? OFFICIAL,
    publicCatalogIds: 'publicCatalogIds' in overrides ? overrides.publicCatalogIds : OFFICIAL_IDS,
    pinnedModels: overrides.pinnedModels ?? [],
    pruneUserExtra: overrides.pruneUserExtra ?? false,
    adopt: overrides.adopt ?? false,
    adoptDisabled: overrides.adoptDisabled ?? false,
    routes: {}, ref: 'OPENCODE_GO_API_KEY', keyFingerprint: 'fp', now: 1,
  }
}
const buildPlan = (deps) => buildMigrationPlanFromDeps(deps, undefined)
const applyPlan = async (deps, plan, ackManaged = true) =>
  applyMigration({ planHash: plan.planHash, confirmCode: plan.confirmCode, ackManaged }, deps)

// ---------------------------------------------------------------------------
// 1. ack tri-state (command layer + apply layer)
// ---------------------------------------------------------------------------
await checkAsync('1. ack tri-state: no --ack-managed → ack-required with zero writes; true → applied', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const before = h.settings.mutations.length

  const noAck = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  assert.equal(noAck.kind, 'error')
  assert.match(noAck.text, /ack-required/)
  assert.equal(h.settings.mutations.length, before, 'no ack → zero settings writes')
  assert.equal(h.counters.ledgerWrites, 0, 'no ack → zero ledger writes')

  const deps = directDeps(h)
  const directPlan = buildPlan(deps)
  const directNoAck = await applyMigration({ planHash: directPlan.planHash, confirmCode: directPlan.confirmCode, ackManaged: false }, deps)
  assert.equal(directNoAck.ok, false)
  assert.equal(directNoAck.reason, 'ack-required')

  const ok = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(ok.kind, 'success', ok.text)
  assert.match(ok.text, /fingerprint persisted/)
  h.dispose()
})

// ---------------------------------------------------------------------------
// 2. adopt: a plan row marked KEEP is never deleted
// ---------------------------------------------------------------------------
await checkAsync('2. adopt: KEEP row (pinned user id) survives apply unchanged', async () => {
  const h = createHarness({
    initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) },
    configOverrides: { go: { pinnedModels: ['custom-test-model'] } },
  })
  const planText = (await h.invoke('migrate plan --adopt')).text
  assert.match(planText, /KEEP\s+opencode-go\/custom-test-model.*\[pinned\]/, 'plan marks the id KEEP/pinned')
  assert.doesNotMatch(planText, /DELETE\s+opencode-go\/custom-test-model/, 'no delete row for a KEEP id')
  const plan = parsePlan(planText)
  const applied = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.ok(idsOf(h, 'opencode-go').includes('custom-test-model'), 'KEEP id was NOT deleted under adopt')
  h.dispose()
})

// ---------------------------------------------------------------------------
// 3. pinned via config path → the id lives on BOTH the old and target route
// ---------------------------------------------------------------------------
await checkAsync('3. pinned via config path: old copy kept AND copy added to official route', async () => {
  const initial = structuredClone(LEGACY_CHAT)
  initial.models.push({ id: 'qwen4-max', name: 'user-pinned-qwen', input: ['text'] })
  const h = createHarness({
    initialRoutes: { 'opencode-go': initial },
    configOverrides: { go: { pinnedModels: ['qwen4-max'] } },
  })
  const planText = (await h.invoke('migrate plan')).text
  assert.match(planText, /KEEP\s+opencode-go\/qwen4-max.*\[pinned\]/, 'old copy forced keep')
  assert.match(planText, /ADD\s+opencode-go-msg\/qwen4-max.*\[pinned\]/, 'desired id added to target route')
  const plan = parsePlan(planText)
  const applied = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.ok(idsOf(h, 'opencode-go').includes('qwen4-max'), 'old route still has the pinned id')
  assert.ok(idsOf(h, 'opencode-go-msg').includes('qwen4-max'), 'target route also has the pinned id')
  h.dispose()
})

// ---------------------------------------------------------------------------
// 4. user-extra default keep; only --prune-user-extra deletes
// ---------------------------------------------------------------------------
await checkAsync('4. user-extra default kept; --prune-user-extra deletes only the listed row', async () => {
  const h1 = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
  const p1 = parsePlan((await h1.invoke('migrate plan')).text)
  const r1 = await h1.invoke(`migrate apply --plan ${p1.planHash} --confirm ${p1.confirmCode} --ack-managed`)
  assert.equal(r1.kind, 'success', r1.text)
  assert.ok(idsOf(h1, 'opencode-go').includes('custom-test-model'), 'default keeps user-extra')
  h1.dispose()

  const h2 = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
  const planText = (await h2.invoke('migrate plan --prune-user-extra')).text
  assert.match(planText, /DELETE\s+opencode-go\/custom-test-model.*\[user-extra\]/, 'prune lists the user-extra id')
  const p2 = parsePlan(planText)
  const r2 = await h2.invoke(`migrate apply --prune-user-extra --plan ${p2.planHash} --confirm ${p2.confirmCode} --ack-managed`)
  assert.equal(r2.kind, 'success', r2.text)
  assert.ok(!idsOf(h2, 'opencode-go').includes('custom-test-model'), '--prune-user-extra removed it')
  h2.dispose()
})

// ---------------------------------------------------------------------------
// 5. public catalog unavailable → unclassified ids are NEVER deleted
// ---------------------------------------------------------------------------
await checkAsync('5. no public catalog → unclassified, never deleted even with both delete flags', async () => {
  const initial = structuredClone(LEGACY_CHAT)
  initial.models.push({ id: 'retired-official-id', name: 'retired', input: ['text'] })
  const h = createHarness({
    initialRoutes: { 'opencode-go': initial },
    publicCatalog: async () => undefined, // fetch failure → no catalog at all
  })
  const planText = (await h.invoke('migrate plan --adopt --prune-user-extra')).text
  assert.match(planText, /public catalog: UNAVAILABLE/, 'plan declares fail-closed mode')
  assert.match(planText, /unclassified/, 'ids classified as unclassified')
  assert.doesNotMatch(planText, /DELETE\s+opencode-go\/(custom-test-model|retired-official-id)/, 'no delete rows')
  const plan = parsePlan(planText)
  const applied = await h.invoke(`migrate apply --adopt --prune-user-extra --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  for (const id of ['custom-test-model', 'retired-official-id']) {
    assert.ok(idsOf(h, 'opencode-go').includes(id), `${id} never deleted without a catalog`)
  }
  h.dispose()
})

// ---------------------------------------------------------------------------
// 6. unknown-retired (public but not authorized) is deleted only by --adopt
// ---------------------------------------------------------------------------
await checkAsync('6. unknown-retired: default keep; --adopt deletes the listed row', async () => {
  const withRetired = (extra) => {
    const initial = structuredClone(LEGACY_CHAT)
    initial.models.push({ id: 'retired-official-id', name: 'retired', input: ['text'] })
    return createHarness({
      initialRoutes: { 'opencode-go': initial },
      publicCatalog: [...OFFICIAL_IDS, 'retired-official-id'],
      ...extra,
    })
  }

  const h1 = withRetired({})
  const deps1 = directDeps(h1, { publicCatalogIds: [...OFFICIAL_IDS, 'retired-official-id'] })
  const plan1 = buildPlan(deps1)
  assert.equal(plan1.idActions.find((a) => a.id === 'retired-official-id')?.kind, 'unknown-retired')
  assert.equal(plan1.idActions.find((a) => a.id === 'retired-official-id')?.op, 'keep')
  const r1 = await applyPlan(deps1, plan1)
  assert.equal(r1.ok, true, r1.text)
  assert.ok(idsOf(h1, 'opencode-go').includes('retired-official-id'), 'default keeps unknown-retired')
  h1.dispose()

  const h2 = withRetired({})
  const deps2 = directDeps(h2, { adopt: true, publicCatalogIds: [...OFFICIAL_IDS, 'retired-official-id'] })
  const plan2 = buildPlan(deps2)
  const del = plan2.idActions.find((a) => a.id === 'retired-official-id')
  assert.equal(del?.kind, 'unknown-retired')
  assert.equal(del?.op, 'delete', '--adopt lists the unknown-retired id for deletion')
  const r2 = await applyPlan(deps2, plan2)
  assert.equal(r2.ok, true, r2.text)
  assert.ok(!idsOf(h2, 'opencode-go').includes('retired-official-id'), '--adopt deleted it')
  h2.dispose()
})

// ---------------------------------------------------------------------------
// 7. plan rows ↔ settings results one-by-one; user-edited UPDATE is untouched
// ---------------------------------------------------------------------------
await checkAsync('7. every plan row matches the settings outcome; UPDATE writes nothing and is unmanaged', async () => {
  const initial = structuredClone(LEGACY_CHAT)
  // A user-edited desired id: drift vs the official profile → UPDATE row.
  initial.models.push({ id: 'deepseek-v4.1-flash', name: 'USER EDITED VALUE', input: ['text'] })
  const h = createHarness({ initialRoutes: { 'opencode-go': initial } })
  const deps = directDeps(h)
  const plan = buildPlan(deps)

  const update = plan.idActions.find((a) => a.op === 'update')
  assert.ok(update, 'plan contains an UPDATE row for the user-edited id')
  assert.equal(update.id, 'deepseek-v4.1-flash')
  assert.equal(update.before?.name, 'USER EDITED VALUE', 'before value captured')
  assert.match(plan.managedAfterMigration, /opencode-go-msg: qwen4-max/, 'managed notice lists actual managed ids')
  assert.doesNotMatch(plan.managedAfterMigration, /deepseek-v4.1-flash/, 'drifted id NOT advertised as managed')

  const beforeById = new Map(initial.models.map((m) => [m.id, m]))
  const result = await applyPlan(deps, plan)
  assert.equal(result.ok, true, result.text)
  assert.equal(result.actions.length, plan.idActions.length, 'one result per plan row')

  for (let i = 0; i < plan.idActions.length; i += 1) {
    const row = plan.idActions[i]
    const outcome = result.actions[i]
    assert.equal(outcome.id, row.id, `row ${i}: same id`)
    assert.equal(outcome.op, row.op, `row ${i}: same op`)
    assert.equal(outcome.route, row.route, `row ${i}: same route`)
    if (row.op === 'delete' || (row.op === 'move' && outcome.status !== 'applied')) continue
    if (row.op === 'move') {
      assert.ok(!idsOf(h, row.route).includes(row.id), `move removed ${row.id} from ${row.route}`)
      assert.ok(idsOf(h, row.to).includes(row.id), `move added ${row.id} to ${row.to}`)
      continue
    }
    const models = h.settings.state.get(row.route)?.models ?? []
    const found = models.find((m) => m.id === row.id)
    assert.ok(found !== undefined, `${row.op} ${row.id} present on ${row.route} after apply`)
    if (row.op === 'update') {
      assert.equal(found.name, beforeById.get(row.id).name, 'UPDATE leaves the user value untouched')
      assert.equal(outcome.status, 'skipped', 'UPDATE result is a no-op notice')
      assert.equal(outcome.status === 'skipped', true)
    }
  }

  // The drifted id is not in any ledger `managed` set.
  for (const entry of h.ownership.data.values()) {
    assert.equal(Object.hasOwn(entry.managed ?? {}, 'deepseek-v4.1-flash'), false, 'UPDATE id never claimed as managed')
  }
  h.dispose()
})

// ---------------------------------------------------------------------------
// 8. conservative apply: ledger managed/appliedManagedIds = actual writes
// ---------------------------------------------------------------------------
await checkAsync('8. conservative apply: ledger contains only ids actually written/adopted', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
  const deps = directDeps(h)
  const plan = buildPlan(deps)
  const result = await applyPlan(deps, plan)
  assert.equal(result.ok, true, result.text)

  const added = plan.idActions.filter((a) => a.op === 'add').map((a) => a.id).sort()
  assert.deepEqual(added, ['deepseek-v4.1-flash', 'grok-4.7', 'qwen4-max'])
  for (const [key, entry] of h.ownership.data) {
    const route = key.split('#')[0]
    // Only add/move-to rows for THIS route are actual writes on it; a
    // pre-existing user-extra id must never appear in either ledger field.
    const expectedAdded = plan.idActions
      .filter((a) => (a.op === 'add' && a.route === route) || (a.op === 'move' && a.to === route))
      .map((a) => a.id).sort()
    assert.deepEqual(entry.appliedAddedIds, expectedAdded, `${key}: appliedAddedIds == ids actually written`)
    assert.deepEqual(Object.keys(entry.managed).sort(), expectedAdded,
      `${key}: managed == ids actually written`)
  }
  const chatEntry = [...h.ownership.data.entries()].find(([k]) => k.startsWith('opencode-go#'))?.[1]
  assert.deepEqual(Object.keys(chatEntry.managed), ['deepseek-v4.1-flash'], 'user-extra id NOT managed')
  assert.deepEqual(h.migrationStore.record.appliedManagedIds['opencode-go'], ['deepseek-v4.1-flash'])
  assert.deepEqual(h.migrationStore.record.appliedManagedIds['opencode-go-msg'], ['qwen4-max'])
  assert.deepEqual(h.migrationStore.record.appliedManagedIds['opencode-go-resp'], ['grok-4.7'])
  h.dispose()
})

// ---------------------------------------------------------------------------
// 9. adopt-disabled fallback: plan label + command-layer / apply-layer refusal
// ---------------------------------------------------------------------------
await checkAsync('9. adopt-disabled: plan labelled, --adopt refused with zero writes', async () => {
  const h = createHarness({
    initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) },
    adoptDisabled: true,
  })
  const planText = (await h.invoke('migrate plan --adopt')).text
  assert.match(planText, /mode: adopt-disabled/, 'plan reports adopt-disabled mode')
  assert.doesNotMatch(planText, /MOVE\s+opencode-go\/custom-test-model/, 'no adopt action printed as executable')
  const plan = parsePlan(planText)
  const before = h.settings.mutations.length
  const refused = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /adopt-disabled/)
  assert.equal(h.settings.mutations.length, before, 'refusal made zero settings writes')
  assert.equal(h.counters.ledgerWrites, 0, 'refusal made zero ledger writes')

  // Apply layer also refuses when the capability flag is set directly.
  const deps = directDeps(h, { adopt: true, adoptDisabled: true })
  const direct = await applyPlan(deps, buildPlan(deps))
  assert.equal(direct.ok, false)
  assert.equal(direct.reason, 'adopt-disabled')
  h.dispose()
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

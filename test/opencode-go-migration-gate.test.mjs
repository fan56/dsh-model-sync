// P1d-1 integration gates (design §14.6 / §14.7, V23/V24; ADR-008).
// Everything is offline: injected settings/fetch/migration store, injected
// timers, no real ~/.dsh, no network, no wall-clock dependency.
//
// V23: one go round writes, then a document-updated echo + the legacy pi.dev
//      auto path must produce ZERO mutate on `opencode-go*` and a skip report.
// V24: un-migrated state blocks the go round; own-write reentry schedules no
//      round; applying drops auto rounds; dispose keeps zero writes.

import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import {
  appliedFingerprintOf,
  fingerprintGoIdentity,
  fingerprintSection,
} from '../lib/opencode-go-migration.js'
import { goOwnershipKey, planGoRouteFields } from '../lib/opencode-go-planner.js'
import { fingerprintKey } from '../lib/opencode-go-source.js'
import { createFileOwnershipStore } from '../lib/opencode-go-store.js'
import {
  GO_FETCH_SERVICE,
  GO_OWNERSHIP_STORE_SERVICE,
  GO_OVERRIDE_STORER_SERVICE,
} from '../lib/opencode-go-sync.js'
import {
  GO_MIGRATION_STORE_SERVICE,
} from '../lib/opencode-go-migration.js'
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
const OFFICIAL = {
  object: 'list',
  data: [
    { id: 'hy4-flash-free', name: 'hy4', api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } }, inputModalities: ['text'] },
    { id: 'qwen4-max', name: 'qwen', api: { messages: { base_url: 'https://opencode.ai/inference/go/anthropic' } }, inputModalities: ['text'] },
    { id: 'grok-4.7', name: 'grok', api: { responses: { base_url: 'https://opencode.ai/inference/go/openai/v1' } }, inputModalities: ['text'] },
  ],
}

function mockSettings(initialRoutes = {}) {
  const state = new Map(Object.entries(initialRoutes).map(([r, d]) => [r, structuredClone(d)]))
  const mutations = []
  let revision = 1
  return {
    state,
    mutations,
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
    writeMode: 'settings', // expose the legacy pi.dev path via modelSync.syncNow()
    intervalMinutes: 0,
    startupDelaySeconds: 0,
    refreshTimeoutMs: 120000,
    managedRoutes: ['opencode-go'], // pi.dev path targets the go route
    keepBuiltinOnly: false,
    dropUnserviceable: true,
    syncNotify: false,
    forceMaxReasoningEffort: false,
    providerNativeFetch: false,
    keepDeprecatedBuiltin: false,
  }
  const config = Object.fromEntries(Object.entries({ ...base, ...overrides }).map(([k, v]) => [k, { get: () => v }]))
  config.opencode = {
    go: {
      enabled: true,
      ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      pinnedModels: [],
      confirmRemovals: 2,
      adoptExisting: false,
      routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp', google: 'opencode-go-google' },
      ...(overrides.go ?? {}),
    },
  }
  return config
}

/**
 * Build an offline harness. `migrationRecord` is injected via the seam:
 * - 'applied' (default, function) → appliedFingerprint tracks current sections
 * - undefined / 'none' → no record (un-migrated)
 * - { applying: true, ... } → M-5 applying state
 */
function createHarness({
  initialRoutes = {}, migrationRecord = 'applied', configOverrides = {}, payloads, ledgerSeed = {},
} = {}) {
  const settings = mockSettings(initialRoutes)
  const logs = []
  const fetchCalls = []
  const listeners = []
  const timers = []
  const state = { definitions: [], disposers: [], provided: {} }

  // A plain-object record is mutable through the injected write seam, so an
  // integration test can observe the appliedFingerprint the writer persisted.
  let storedRecord = migrationRecord !== undefined && migrationRecord !== 'applied'
    && migrationRecord !== 'none' && typeof migrationRecord !== 'function'
    ? structuredClone(migrationRecord)
    : undefined
  const migrationStore = {
    async read() {
      if (migrationRecord === 'applied') {
        // legacy test mode: appliedFingerprint tracks the current go sections
        const sections = Object.fromEntries(
          [...settings.state].filter(([route]) => route.startsWith('opencode-go')),
        )
        return { appliedFingerprint: fingerprintSection(sections) }
      }
      if (migrationRecord === undefined || migrationRecord === 'none') return undefined
      if (typeof migrationRecord === 'function') return migrationRecord()
      return storedRecord === undefined ? undefined : structuredClone(storedRecord)
    },
    async write(next) { storedRecord = structuredClone(next) },
    get record() { return storedRecord === undefined ? undefined : structuredClone(storedRecord) },
  }
  // Real in-memory ledger: the writer's managed-id commits are visible to the
  // live migration-status reads (§14.7.4 fingerprint contract). `ledgerSeed`
  // models a post-apply ledger for onboarding tests (keys are full ledger keys).
  const ledgerData = new Map(Object.entries(ledgerSeed).map(([k, v]) => [k, structuredClone(v)]))
  const ownership = {
    async read(key) { const value = ledgerData.get(key); return value === undefined ? undefined : structuredClone(value) },
    async write(key, entry) { ledgerData.set(key, structuredClone(entry)) },
    async delete(key) { ledgerData.delete(key) },
  }
  const fetchImpl = async (url) => {
    fetchCalls.push(url)
    const payload = payloads === undefined ? OFFICIAL
      : payloads[Math.min(fetchCalls.length - 1, payloads.length - 1)] ?? OFFICIAL
    return { status: 200, json: async () => structuredClone(payload) }
  }
  const services = {
    settings,
    [GO_MIGRATION_STORE_SERVICE]: migrationStore,
    [GO_OWNERSHIP_STORE_SERVICE]: ownership,
    [GO_OVERRIDE_STORER_SERVICE]: { async read() { return undefined }, async updateOverrides() {} },
    [GO_FETCH_SERVICE]: fetchImpl,
    [GO_SCHEDULER_TIMERS_SERVICE]: {
      setTimeout(fn, ms) { const handle = { fn, ms }; timers.push(handle); return handle },
      clearTimeout(handle) { const i = timers.indexOf(handle); if (i >= 0) timers.splice(i, 1) },
    },
    [GO_SCHEDULER_RANDOM_SERVICE]: { next: () => 0 },
    credentials: {
      describe: async () => ({ configured: true }),
      resolve: async () => ({ value: KEY }),
      set: async () => {},
      unset: async () => {},
    },
    launchEnvironment: { get: () => undefined },
  }

  const ctx = {
    settings,
    get: (name) => services[name],
    logger: {
      info(...args) { logs.push(args.map(String).join(' ')) },
      warn(...args) { logs.push(args.map(String).join(' ')) },
      debug() {},
    },
    on(event, listener) { listeners.push({ event, listener }); return () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposers.push(d); return d },
    provide(name, service) { state.provided[name] = service },
    inject(names, callback) { callback(Object.create(ctx)) },
    commands: {
      register(definition) { state.definitions.push(definition); return () => {} },
    },
  }

  apply(ctx, makeConfig(configOverrides))

  const invoke = async (text) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text })
  }
  const emitDocumentUpdated = (ns, revision) => {
    for (const entry of listeners.filter((l) => l.event === 'settings/document-updated')) {
      entry.listener(ns, revision)
    }
  }
  const dispose = () => { for (const d of state.disposers) d() }

  return { settings, logs, fetchCalls, timers, state, invoke, emitDocumentUpdated, dispose, services, migrationStore }
}

const idsOf = (settings, route) => settings.state.get(route)?.models?.map((m) => m.id) ?? []

// ---------------------------------------------------------------------------
// V23: go writes → document-updated echo → pi.dev auto path zero-write + skip
// ---------------------------------------------------------------------------

await checkAsync('V23: after a go round, own-write echo + pi.dev auto round never mutate go routes and report skip', async () => {
  const h = createHarness({
    initialRoutes: {
      'opencode-go': {
        apiKeyEnv: 'OPENCODE_GO_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/inference/go/openai/v1',
        models: [{ id: 'custom-test-model', name: 'custom-test-model', input: ['text'] }],
      },
    },
  })

  const go = await h.invoke('go')
  assert.equal(go.kind, 'success', go.text)
  assert.match(go.text, /opencode-go: wrote/)
  assert.ok(idsOf(h.settings, 'opencode-go').includes('custom-test-model'), 'user id survives the go round')
  assert.equal(h.fetchCalls.length, 1, 'one official source request')
  const afterGo = h.settings.mutations.length
  assert.ok(afterGo > 0, 'go round wrote settings')

  // The host echoes our own write with the post-mutate revision.
  h.emitDocumentUpdated('llm-pi-ai', h.settings.revision)
  assert.ok(h.logs.some((line) => line.includes('reentry-ignored')), `reentry recognised; logs=${JSON.stringify(h.logs)}`)
  assert.equal(h.fetchCalls.length, 1, 'echo did not run another go round')

  // The legacy pi.dev auto/manual path (same syncNow surface) must skip go routes.
  const report = await h.state.provided.modelSync.syncNow()
  assert.equal(h.settings.mutations.length, afterGo, 'pi.dev path made ZERO settings mutations on go routes')
  assert.match(report, /skipped-route-owner/, 'skip is reported, never silent')
  assert.match(report, /opencode-go: skipped/, 'the go route is named in the report')
  assert.ok(idsOf(h.settings, 'opencode-go').includes('custom-test-model'), 'user id not clobbered')
  assert.deepEqual(idsOf(h.settings, 'opencode-go-msg'), ['qwen4-max'])
  assert.deepEqual(idsOf(h.settings, 'opencode-go-resp'), ['grok-4.7'])
  h.dispose()
})

// ---------------------------------------------------------------------------
// V24: un-migrated state → go round zero-write + migration hint
// ---------------------------------------------------------------------------

await checkAsync('V24: legacy-inline (no migrate record) → go round zero mutate, zero fetch, fixed migration report', async () => {
  const h = createHarness({
    initialRoutes: { 'opencode-go': { models: [{ id: 'custom-test-model', name: 'custom' }] } },
    migrationRecord: 'none',
  })
  const result = await h.invoke('go')
  assert.match(result.text, /migration gate/, result.text)
  assert.match(result.text, /migrate plan/, 'report tells the user to run migrate plan')
  assert.match(result.text, /skipped-route-owner: none/, 'gate owner reported')
  assert.deepEqual(h.settings.mutations, [], 'un-migrated go round made zero settings writes')
  assert.deepEqual(h.fetchCalls, [], 'gate short-circuits before any source request')
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['custom-test-model'], 'hand-written list untouched')
  h.dispose()
})

await checkAsync('V24: drifted state also blocks the go round with zero writes', async () => {
  const h = createHarness({
    initialRoutes: { 'opencode-go': { models: [{ id: 'custom' }] } },
    migrationRecord: { appliedFingerprint: 'stale', legacyFingerprint: 'older' },
  })
  const result = await h.invoke('go')
  assert.match(result.text, /migration gate: drifted/, result.text)
  assert.deepEqual(h.settings.mutations, [])
  assert.deepEqual(h.fetchCalls, [])
  h.dispose()
})

await checkAsync('V24: applying state drops the go round with zero writes', async () => {
  const h = createHarness({
    initialRoutes: {},
    migrationRecord: { appliedFingerprint: fingerprintSection({}), applying: true },
  })
  const result = await h.invoke('go')
  assert.match(result.text, /apply in progress|applying/, result.text)
  assert.deepEqual(h.settings.mutations, [])
  assert.deepEqual(h.fetchCalls, [])
  h.dispose()
})

// ---------------------------------------------------------------------------
// V24: reentry never schedules a second round; dispose keeps zero writes
// ---------------------------------------------------------------------------

await checkAsync('V24: own-write document-updated does not schedule an immediate round', async () => {
  const h = createHarness({ initialRoutes: {} })
  await h.invoke('go')
  const before = h.fetchCalls.length
  assert.ok(before > 0)

  const timersBefore = h.timers.length
  h.emitDocumentUpdated('llm-pi-ai', h.settings.revision)
  h.emitDocumentUpdated('dsh-model-sync', h.settings.revision)
  assert.ok(h.logs.some((line) => line.includes('reentry-ignored')), 'reentry logged')
  assert.equal(h.fetchCalls.length, before, 'no round ran after the echo')
  assert.equal(h.timers.length, timersBefore, 'no +1s runAuto timer armed (design §14.7.2 item 2)')
  h.dispose()
})

await checkAsync('V24: a foreign llm-pi-ai event schedules no round either', async () => {
  const h = createHarness({ initialRoutes: {} })
  await h.invoke('go')
  const before = h.fetchCalls.length
  const timersBefore = h.timers.length
  h.emitDocumentUpdated('llm-pi-ai', h.settings.revision + 42) // not our marker
  assert.equal(h.fetchCalls.length, before)
  assert.equal(h.timers.length, timersBefore)
  h.dispose()
})

await checkAsync('V24 dispose regression: pending go timer after dispose never writes (C2)', async () => {
  const h = createHarness({ initialRoutes: {} })
  // The startup timer is the injected fake handle; dispose clears it, so
  // invoking its callback simulates a stale host callback after unload.
  const pending = [...h.timers]
  const mutationsBefore = h.settings.mutations.length
  h.dispose()
  for (const handle of pending) handle.fn()
  await Promise.resolve()
  assert.equal(h.settings.mutations.length, mutationsBefore, 'disposed scheduler wrote nothing')
  assert.deepEqual(h.fetchCalls, [], 'disposed scheduler ran no fetch')
})

// ---------------------------------------------------------------------------
// §14.7.4 / §14.7.5: identity fingerprint, self-heal, live second gate
// ---------------------------------------------------------------------------

const GO_KEY = 'OPENCODE_GO_API_KEY'
const CHAT_FIELDS = planGoRouteFields('chat', [{
  baseUrls: { 'chat-completions': 'https://opencode.ai/inference/go/openai/v1' },
}], GO_KEY)
const GO_ROUTES = ['opencode-go', 'opencode-go-msg', 'opencode-go-resp', 'opencode-go-google']
const INITIAL = {
  'opencode-go': {
    ...CHAT_FIELDS,
    models: [{ id: 'hy4-flash-free', name: 'hy4' }, { id: 'seed', name: 'seed' }],
  },
}
const seededRecord = (sections) => {
  const routes = Object.keys(sections)
  const identity = fingerprintGoIdentity(sections, routes)
  const managedIds = Object.fromEntries(GO_ROUTES.map((route) => [route, []]))
  return {
    appliedIdentity: identity,
    appliedIdentityRoutes: routes,
    appliedManagedIds: managedIds,
    appliedFingerprint: appliedFingerprintOf(identity, managedIds),
  }
}

await checkAsync('§14.7.4: own write after apply never drifts; upstream addition still writes next round', async () => {
  const withNew = {
    object: 'list',
    data: [...OFFICIAL.data, {
      id: 'brand-new', name: 'brand-new',
      api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } },
      inputModalities: ['text'],
    }],
  }
  const h = createHarness({
    initialRoutes: INITIAL, migrationRecord: seededRecord(INITIAL), payloads: [OFFICIAL, withNew],
  })
  const first = await h.invoke('go')
  assert.ok(!first.text.includes('migration gate'), first.text)
  assert.ok(h.settings.mutations.length > 0, 'own write landed after apply')
  const stored = h.migrationStore.record
  assert.equal(stored.appliedIdentity, seededRecord(INITIAL).appliedIdentity, 'identity untouched by our write')
  assert.ok(stored.appliedManagedIds['opencode-go'].includes('hy4-flash-free'), 'ledger ids captured')
  assert.notEqual(stored.appliedFingerprint, seededRecord(INITIAL).appliedFingerprint, 'fingerprint re-persisted after commit')

  const second = await h.invoke('go')
  assert.ok(!second.text.includes('migration gate'), second.text)
  assert.ok(idsOf(h.settings, 'opencode-go').includes('brand-new'), 'upstream addition written — gate stayed open')
  h.dispose()
})

await checkAsync('§14.7.4: external identity edit → drifted, zero writes and zero fetch', async () => {
  const h = createHarness({ initialRoutes: INITIAL, migrationRecord: seededRecord(INITIAL) })
  h.settings.state.get('opencode-go').api = 'anthropic-messages' // external identity edit
  const before = h.settings.mutations.length
  const result = await h.invoke('go')
  assert.match(result.text, /migration gate: drifted/, result.text)
  assert.equal(h.settings.mutations.length, before, 'zero settings writes')
  assert.deepEqual(h.fetchCalls, [], 'gate short-circuits before the source request')
  h.dispose()
})

await checkAsync('§14.7.4: external models edit → gate stays open and models are repaired', async () => {
  const h = createHarness({ initialRoutes: INITIAL, migrationRecord: seededRecord(INITIAL) })
  h.settings.state.get('opencode-go').models.push({ id: 'user-added', name: 'user-added' })
  const before = h.settings.mutations.length
  const result = await h.invoke('go')
  assert.ok(!result.text.includes('migration gate'), result.text)
  assert.ok(h.settings.mutations.length > before, 'repair write landed')
  assert.ok(idsOf(h.settings, 'opencode-go').includes('user-added'), 'models edit handled by owner semantics, not closure')
  h.dispose()
})

await checkAsync('§14.7.4: stale appliedFingerprint with matching identity self-heals without closing the gate', async () => {
  const record = { ...seededRecord(INITIAL), appliedFingerprint: 'stale' }
  const h = createHarness({ initialRoutes: INITIAL, migrationRecord: record })
  const result = await h.invoke('go')
  assert.ok(!result.text.includes('migration gate'), result.text)
  assert.ok(h.settings.mutations.length > 0, 'healed round still writes')
  assert.ok(h.logs.some((line) => line.includes('fingerprint-healed')), `heal logged; logs=${JSON.stringify(h.logs)}`)
  assert.notEqual(h.migrationStore.record.appliedFingerprint, 'stale', 'fingerprint rewritten in the store')
  h.dispose()
})

await checkAsync('O1 residual: healthy first round + own write emit no fingerprint-healed; a real stale fingerprint still heals', async () => {
  // Mirrors a freshly applied migration: the record and ledger carry ONLY the
  // routes actually written (chat), not `<route>: []` for every configured slot.
  const identityRoutes = ['opencode-go']
  const identity = fingerprintGoIdentity({ 'opencode-go': INITIAL['opencode-go'] }, identityRoutes)
  const managedIds = { 'opencode-go': ['hy4-flash-free', 'seed'] }
  const record = {
    appliedIdentity: identity,
    appliedIdentityRoutes: identityRoutes,
    appliedManagedIds: managedIds,
    appliedFingerprint: appliedFingerprintOf(identity, managedIds),
  }
  const ledgerSeed = {
    [goOwnershipKey('opencode-go', fingerprintKey(KEY))]: {
      routeFields: CHAT_FIELDS,
      managed: Object.fromEntries(managedIds['opencode-go'].map((id) => [id, { hash: 'seeded' }])),
    },
  }
  const h = createHarness({ initialRoutes: INITIAL, migrationRecord: record, ledgerSeed })

  const first = await h.invoke('go')
  assert.ok(!first.text.includes('migration gate'), first.text)
  assert.ok(!h.logs.some((line) => line.includes('fingerprint-healed')),
    `clean onboarding must not log a phantom heal; logs=${JSON.stringify(h.logs)}`)

  const second = await h.invoke('go')
  assert.ok(!second.text.includes('migration gate'), second.text)
  assert.ok(!h.logs.some((line) => line.includes('fingerprint-healed')),
    `healthy own-write round must not log a phantom heal; logs=${JSON.stringify(h.logs)}`)
  const healthy = h.migrationStore.record
  assert.ok(Object.values(healthy.appliedManagedIds).every((ids) => ids.length > 0),
    'no fabricated empty-route entries in the persisted route set')
  assert.equal(healthy.appliedFingerprint,
    appliedFingerprintOf(healthy.appliedIdentity, healthy.appliedManagedIds),
    'persisted fingerprint matches the shared route-set convention')

  // A genuine mismatch (record fingerprint stale vs present ledger) must still
  // produce the self-heal notice — the fix must not silence real repairs.
  await h.migrationStore.write({ ...(await h.migrationStore.read()), appliedFingerprint: 'stale-on-purpose' })
  const third = await h.invoke('go')
  assert.ok(!third.text.includes('migration gate'), third.text)
  assert.ok(h.logs.some((line) => line.includes('fingerprint-healed')),
    `a real stale fingerprint must still heal; logs=${JSON.stringify(h.logs)}`)
  assert.notEqual(h.migrationStore.record.appliedFingerprint, 'stale-on-purpose', 'fingerprint repaired')
  h.dispose()
})

await checkAsync('§14.7.5: live status re-read failure skips the mutate with canWrite-unavailable', async () => {
  const h = createHarness({ initialRoutes: INITIAL, migrationRecord: seededRecord(INITIAL) })
  const store = h.migrationStore
  const originalRead = store.read.bind(store)
  let reads = 0
  store.read = async () => {
    reads += 1
    // Reads before the source fetch (scheduler/round gate) succeed; the second
    // gate's live re-read happens after the fetch and finds a corrupt store.
    if (h.fetchCalls.length > 0) throw new Error('migration store corrupted mid-round')
    return originalRead()
  }
  const before = h.settings.mutations.length
  const result = await h.invoke('go')
  assert.ok(reads >= 2, 'second gate re-read the persisted store')
  assert.equal(h.settings.mutations.length, before, 'zero settings mutate on re-read failure')
  assert.match(result.text, /canWrite-unavailable/, result.text)
  h.dispose()
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

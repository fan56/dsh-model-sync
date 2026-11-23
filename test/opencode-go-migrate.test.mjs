// P1d-2: `/model-sync migrate plan|apply|rollback|status` — all offline.
//
// Every I/O dependency is injected: in-memory settings/migration store/ledger,
// a fixture official listing, injected timers, no real ~/.dsh, no network.
// Acceptance: V16 (plan read-only), V17 (consent gate), V19 (apply writes),
// V20 (rollback), V22 (single-flight), plus the two mutation-killers:
//   - removing the consent check turns the wrong-hash/no-flag tests red;
//   - removing the mutex turns the in-flight-apply test red.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply } from '../lib/index.js'
import {
  confirmCodeOf,
  hashCanonical,
  verifyConsent,
  buildMigrationPlan,
} from '../lib/opencode-go-migrate.js'
import { parseGoModelsPayload } from '../lib/opencode-go-source.js'
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
  GO_MIGRATION_REF_WRITER_SERVICE,
  GO_MIGRATION_MUTEX_SERVICE,
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
// Three-route topology (chat/msg/resp): the google slot is conditional and off.
const OFFICIAL = parseGoModelsPayload(FIXTURE).filter((entry) => entry.id !== 'gemini-4-argon')

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
    writeMode: 'settings',
    intervalMinutes: 0,
    startupDelaySeconds: 0,
    refreshTimeoutMs: 120000,
    managedRoutes: ['opencode-go'],
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

const LEGACY_CHAT = {
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://opencode.ai/inference/go/openai/v1',
  displayName: 'OpenCode Go',
  models: [{ id: 'custom-test-model', name: 'custom-test-model', input: ['text'] }],
}

/**
 * Offline harness. `fetchGate` optionally controls the go-round fetch (for the
 * in-flight mutex test); migrate plan/apply use the injected entries array, so
 * they never touch the fetch seam.
 */
function createHarness({
  initialRoutes = {},
  initialRecord,
  entries = OFFICIAL,
  roundEntries = OFFICIAL,
  fetchGate,
  rewriteLog,
  mutex,
  configOverrides = {},
} = {}) {
  const settings = mockSettings(initialRoutes)
  const logs = []
  const fetchCalls = []
  const listeners = []
  const timers = []
  const state = { definitions: [], disposers: [], provided: {} }
  const counters = { migrationWrites: 0, ledgerWrites: 0, rewrites: 0 }

  let storedRecord = initialRecord === undefined ? undefined : structuredClone(initialRecord)
  const migrationStore = {
    async read() { return storedRecord === undefined ? undefined : structuredClone(storedRecord) },
    async write(next) { counters.migrationWrites += 1; storedRecord = structuredClone(next) },
    get record() { return storedRecord === undefined ? undefined : structuredClone(storedRecord) },
    set record(value) { storedRecord = value === undefined ? undefined : structuredClone(value) },
  }
  const ledgerData = new Map()
  const ownership = {
    async read(key) { const value = ledgerData.get(key); return value === undefined ? undefined : structuredClone(value) },
    async write(key, entry) { counters.ledgerWrites += 1; ledgerData.set(key, structuredClone(entry)) },
    async delete(key) { ledgerData.delete(key) },
    get data() { return ledgerData },
  }
  const fetchImpl = async (url) => {
    fetchCalls.push(url)
    if (fetchGate !== undefined) await fetchGate(fetchCalls.length)
    return { status: 200, json: async () => structuredClone({ object: 'list', data: roundEntries.map((entry) => ({
      id: entry.id, name: entry.name,
      api: Object.fromEntries(entry.protocols.map((p) => [p, { base_url: entry.baseUrls[p] }])),
      inputModalities: entry.inputModalities,
    })) }) }
  }
  const services = {
    settings,
    [GO_MIGRATION_STORE_SERVICE]: migrationStore,
    [GO_OWNERSHIP_STORE_SERVICE]: ownership,
    [GO_OVERRIDE_STORER_SERVICE]: { async read() { return undefined }, async updateOverrides() {} },
    [GO_FETCH_SERVICE]: fetchImpl,
    [GO_MIGRATION_ENTRIES_SERVICE]: entries,
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
  if (rewriteLog !== undefined) {
    services[GO_MIGRATION_REF_WRITER_SERVICE] = async (rewrite) => {
      counters.rewrites += 1
      rewriteLog.push(rewrite)
    }
  }
  if (mutex !== undefined) services[GO_MIGRATION_MUTEX_SERVICE] = mutex

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
    commands: { register(definition) { state.definitions.push(definition); return () => {} } },
  }
  apply(ctx, makeConfig(configOverrides))
  const invoke = (text) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text })
  }
  return {
    settings, logs, fetchCalls, timers, state, invoke, services,
    migrationStore, ownership, counters, rewriteLog,
    dispose: () => { for (const d of state.disposers) d() },
  }
}

const idsOf = (settings, route) => settings.state.get(route)?.models?.map((m) => m.id) ?? []
const parsePlan = (text) => ({
  planHash: /planHash: ([0-9a-f]{64})/.exec(text)?.[1],
  confirmCode: /confirmCode: (\d{6})/.exec(text)?.[1],
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

await checkAsync('planHash is canonical + changes with the plan; confirmCode is 6 digits', async () => {
  const desc = { ns: 'llm-pi-ai', revision: 1, user: { providers: { 'opencode-go': LEGACY_CHAT } } }
  const input = { descriptor: desc, entries: OFFICIAL, routes: {}, ref: 'OPENCODE_GO_API_KEY', keyFingerprint: 'fp', now: 1 }
  const a = buildMigrationPlan(input)
  const b = buildMigrationPlan(input)
  assert.equal(a.planHash, b.planHash, 'identical inputs → identical hash')
  assert.equal(a.confirmCode, confirmCodeOf(a.planHash))
  assert.match(a.confirmCode, /^\d{6}$/)
  assert.equal(hashCanonical({ b: 1, a: 2 }), hashCanonical({ a: 2, b: 1 }))

  const changed = buildMigrationPlan({ ...input, adopt: true })
  assert.notEqual(changed.planHash, a.planHash, 'adopt changes the plan hash')
  const changedEntries = buildMigrationPlan({ ...input, entries: OFFICIAL.slice(0, 2) })
  assert.notEqual(changedEntries.planHash, a.planHash, 'desired model list changes the plan hash')
  assert.equal(buildMigrationPlan({ ...input, now: 999 }).planHash, a.planHash, 'timestamps never affect the hash')
})

await checkAsync('verifyConsent: missing / wrong hash / wrong code never pass', async () => {
  const plan = { planHash: 'a'.repeat(64), confirmCode: '123456' }
  assert.deepEqual(verifyConsent(plan, undefined, undefined), { ok: false, reason: 'consent-required' })
  assert.deepEqual(verifyConsent(plan, 'b'.repeat(64), '123456'), { ok: false, reason: 'plan-hash-mismatch' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, '000000'), { ok: false, reason: 'confirm-code-mismatch' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode), { ok: true })
})

// ---------------------------------------------------------------------------
// V16: plan is strictly read-only, zero external calls
// ---------------------------------------------------------------------------

await checkAsync('V16: migrate plan writes nothing (settings/store/ledger) and makes zero outbound calls', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const result = await h.invoke('migrate plan')
  assert.equal(result.kind, 'success', result.text)
  const { planHash, confirmCode } = parsePlan(result.text)
  assert.match(planHash ?? '', /^[0-9a-f]{64}$/)
  assert.match(confirmCode ?? '', /^\d{6}$/)
  assert.match(result.text, /legacy-inline/)
  assert.match(result.text, /custom-test-model/)
  assert.match(result.text, /three-gate|gates:/)
  assert.deepEqual(h.settings.mutations, [], 'zero settings mutations')
  assert.equal(h.counters.migrationWrites, 0, 'zero migration-store writes')
  assert.equal(h.counters.ledgerWrites, 0, 'zero ledger writes')
  assert.deepEqual(h.fetchCalls, [], 'zero outbound fetch calls')
  h.dispose()
})

// ---------------------------------------------------------------------------
// V17: consent gate (also the mutation-killer for "remove the confirmation check")
// ---------------------------------------------------------------------------

await checkAsync('V17 MUTATION-KILLER: wrong planHash → refused, zero writes', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const result = await h.invoke(`migrate apply --plan ${'0'.repeat(64)} --confirm ${plan.confirmCode}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan-hash-mismatch/)
  assert.deepEqual(h.settings.mutations, [])
  assert.equal(h.counters.migrationWrites, 0)
  assert.equal(h.counters.ledgerWrites, 0)
  h.dispose()
})

await checkAsync('V17 MUTATION-KILLER: wrong confirm code → refused, zero writes', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const wrong = plan.confirmCode === '000000' ? '111111' : '000000'
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${wrong}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /confirm-code-mismatch/)
  assert.deepEqual(h.settings.mutations, [])
  assert.equal(h.counters.migrationWrites, 0)
  assert.equal(h.counters.ledgerWrites, 0)
  h.dispose()
})

await checkAsync('V17 MUTATION-KILLER: apply with no consent flags (or --yes/--auto) never executes', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  for (const text of [
    'migrate apply',
    'migrate apply --plan ' + parsePlan((await h.invoke('migrate plan')).text).planHash,
    'migrate apply --yes',
    'migrate apply --auto',
  ]) {
    const result = await h.invoke(text)
    assert.equal(result.kind, 'error', text)
    assert.match(result.text, /consent-required|--yes\/--auto/)
    assert.deepEqual(h.settings.mutations, [], `${text}: zero settings writes`)
  }
  assert.equal(h.counters.migrationWrites, 0, 'zero migration-store writes')
  assert.equal(h.counters.ledgerWrites, 0, 'zero ledger writes')
  h.dispose()
})

await checkAsync('V17: apply refuses when the plan has drifted (settings changed after plan)', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  // External edit after the plan → the rebuilt planHash no longer matches.
  h.settings.state.get('opencode-go').models.push({ id: 'user-added', name: 'user-added' })
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /plan-hash-mismatch/)
  assert.deepEqual(h.settings.mutations, [])
  h.dispose()
})

// ---------------------------------------------------------------------------
// V19: apply writes the three routes, ledger + fingerprint, then go sync is writable
// ---------------------------------------------------------------------------

await checkAsync('V19: apply writes three routes + ledger + fingerprint; next go round may write', async () => {
  const withNew = [...OFFICIAL, {
    ...OFFICIAL[0],
    id: 'brand-new',
    name: 'brand-new',
  }]
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT }, roundEntries: withNew })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const applied = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.match(applied.text, /fingerprint persisted/)
  assert.deepEqual(h.settings.mutations.length >= 3, true, 'settings written')

  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['custom-test-model', 'deepseek-v4.1-flash'].sort())
  assert.deepEqual(idsOf(h.settings, 'opencode-go-msg'), ['qwen4-max'])
  assert.deepEqual(idsOf(h.settings, 'opencode-go-resp'), ['grok-4.7'])
  assert.equal(h.settings.state.get('opencode-go-msg').api, 'anthropic-messages')
  assert.equal(h.settings.state.get('opencode-go-resp').api, 'openai-responses')

  const record = h.migrationStore.record
  assert.match(record.appliedFingerprint, /^[0-9a-f]{64}$/)
  assert.equal(record.planHash, plan.planHash)
  assert.equal(record.applying, false)
  assert.ok(h.ownership.data.size >= 3, 'ledger entries persisted')

  // Apply released the gate: a go round now writes without a migration skip.
  const mutationsBefore = h.settings.mutations.length
  const go = await h.invoke('go')
  assert.ok(!go.text.includes('migration gate'), go.text)
  assert.ok(h.settings.mutations.length > mutationsBefore, 'go round wrote after apply')
  assert.ok(idsOf(h.settings, 'opencode-go').includes('brand-new'), 'upstream addition written — go write authority granted')
  h.dispose()
})

// ---------------------------------------------------------------------------
// V22: single-flight mutex — apply rejects while a go round holds the lock
// ---------------------------------------------------------------------------

await checkAsync('V22 MUTATION-KILLER: apply rejected while a go round is in flight, zero writes', async () => {
  // The mutex seam is injected as "held" — exactly the state goScheduler's
  // `inFlight` flag reports while a round owns the routes. Removing the mutex
  // check from applyMigration makes this test fail (settings would be written).
  const h = createHarness({
    initialRoutes: { 'opencode-go': LEGACY_CHAT },
    mutex: () => true,
  })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const mutationsBefore = h.settings.mutations.length
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /sync-in-flight|retry/)
  assert.equal(h.settings.mutations.length, mutationsBefore, 'apply made zero settings writes')
  assert.equal(h.counters.migrationWrites, 0, 'apply made zero migration-store writes')
  assert.equal(h.counters.ledgerWrites, 0, 'apply made zero ledger writes')
  h.dispose()
})

await checkAsync('V22: while applying, the go scheduler drops its round (M-5)', async () => {
  const h = createHarness({
    initialRoutes: { 'opencode-go': LEGACY_CHAT },
    initialRecord: { applying: true },
  })
  const result = await h.invoke('go')
  assert.match(result.text, /apply in progress|applying|migration-applying/, result.text)
  assert.deepEqual(h.settings.mutations, [])
  assert.deepEqual(h.fetchCalls, [])
  h.dispose()
})

// ---------------------------------------------------------------------------
// V20: rollback restores the pre-apply snapshot and re-locks; refusal is zero-write
// ---------------------------------------------------------------------------

await checkAsync('V20: adopt apply deletes a legacy id; rollback restores it and re-locks', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  const applied = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['deepseek-v4.1-flash'], 'adopt removed the legacy id')

  // Refusal paths first: all zero writes.
  const before = h.settings.mutations.length
  assert.equal((await h.invoke('migrate rollback')).kind, 'error', 'no --plan refused')
  assert.equal((await h.invoke('migrate rollback --plan ' + 'f'.repeat(64))).kind, 'error', 'wrong hash refused')
  assert.equal(h.settings.mutations.length, before, 'refused rollbacks made zero settings writes')

  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  assert.match(rolled.text, /re-locked/)
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['custom-test-model'], 'pre-apply id restored')
  assert.equal(h.migrationStore.record.appliedFingerprint, undefined, 'fingerprint cleared')
  assert.equal(h.ownership.data.size, 0, 'ledger cleared')

  // State fell back to legacy → go sync gate is closed again.
  const go = await h.invoke('go')
  assert.match(go.text, /migration gate/, go.text)
  assert.deepEqual(h.fetchCalls, [], 'zero fetch after rollback')
  h.dispose()
})

await checkAsync('V20: rollback refuses when preManagedSnapshot is missing (zero writes)', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  // Corrupt the snapshot on purpose.
  const key = [...h.ownership.data.keys()][0]
  const entry = structuredClone(h.ownership.data.get(key))
  delete entry.preManagedSnapshot
  h.ownership.data.set(key, entry)
  const before = h.settings.mutations.length
  const result = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /snapshot-missing/)
  assert.equal(h.settings.mutations.length, before, 'zero settings writes')
  h.dispose()
})

await checkAsync('V20: rollback refuses on a post-apply managed-hash edit (zero writes)', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  h.settings.state.get('opencode-go').models.find((m) => m.id === 'deepseek-v4.1-flash').name = 'user-edited'
  const before = h.settings.mutations.length
  const result = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /hash-mismatch/)
  assert.equal(h.settings.mutations.length, before, 'zero settings writes')
  h.dispose()
})

// ---------------------------------------------------------------------------
// status + reference rewrites (report-only by default)
// ---------------------------------------------------------------------------

await checkAsync('status: reports per-route state and write authority', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const legacy = await h.invoke('migrate status')
  assert.equal(legacy.kind, 'success')
  assert.match(legacy.text, /state=legacy-inline/)
  assert.match(legacy.text, /owner=none/)
  assert.deepEqual(h.settings.mutations, [])
  h.dispose()

  const h2 = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h2.invoke('migrate plan')).text)
  await h2.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode}`)
  const applied = await h2.invoke('migrate status')
  assert.match(applied.text, /state=applied/)
  assert.match(applied.text, /owner=go/)
  h2.dispose()
})

await checkAsync('references: session storage is report-only; opt-in rewrite touches only verified keys', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT }, rewriteLog: [] })
  const planText = (await h.invoke('migrate plan --rewrite-refs=config')).text
  assert.match(planText, /report-only.*session|session\/conversation/i, 'session reference reported')
  assert.match(planText, /NEVER rewritten/)

  const { applyMigration } = await import('../lib/opencode-go-migrate.js')
  const references = [
    { surface: 'agent-default-model', location: 'patch.yml', before: 'old', after: 'new', verified: true, rewritable: true, reportOnly: false },
    { surface: 'session', location: 'session.v4.jsonl.zstd', before: 'old', after: 'new', verified: false, rewritable: false, reportOnly: true },
  ]
  const deps = {
    settings: h.settings,
    ownershipStore: h.ownership,
    migrationStore: h.migrationStore,
    logger: { info() {}, warn() {}, debug() {} },
    entries: OFFICIAL,
    routes: {},
    ref: 'OPENCODE_GO_API_KEY',
    keyFingerprint: 'fp',
    rewriteRefs: 'config',
    references,
    now: 1,
    applyReferenceRewrite: async (rewrite) => h.services[GO_MIGRATION_REF_WRITER_SERVICE](rewrite),
  }
  const plan = buildMigrationPlan({
    descriptor: h.settings.describe().find((d) => d.ns === 'llm-pi-ai'),
    entries: OFFICIAL,
    routes: {},
    ref: 'OPENCODE_GO_API_KEY',
    keyFingerprint: 'fp',
    rewriteRefs: 'config',
    references,
    now: 1,
  })
  const result = await applyMigration({ planHash: plan.planHash, confirmCode: plan.confirmCode }, deps)
  assert.equal(result.ok, true, result.text)
  assert.equal(h.rewriteLog.length, 1, 'only the verified config key was rewritten')
  assert.equal(h.rewriteLog[0].surface, 'agent-default-model')
  h.dispose()
})

await checkAsync('V20: rollback from the pre-apply backup works when apply crashed before ledger/fingerprint', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  // Crash window: applying flag + captured backup, no ledger, no fingerprint;
  // settings already carry the first half of the adopt write.
  h.migrationStore.record = {
    applying: true,
    planHash: plan.planHash,
    backup: {
      planHash: plan.planHash,
      capturedAt: 1,
      routes: { 'opencode-go': { section: structuredClone(LEGACY_CHAT) } },
    },
  }
  h.settings.state.get('opencode-go').models = [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017', input: ['text'] }]
  const result = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['custom-test-model'])
  assert.equal(h.migrationStore.record.applying, false)
  h.dispose()
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

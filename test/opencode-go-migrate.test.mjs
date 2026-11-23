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
  assert.deepEqual(verifyConsent(plan, 'b'.repeat(64), '123456', true), { ok: false, reason: 'plan-hash-mismatch' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, '000000', true), { ok: false, reason: 'confirm-code-mismatch' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode, true), { ok: true })
})

// B6: --ack-managed is a mandatory third consent token (tri-state).
await checkAsync('B6 ack tri-state: absent / non-true → ack-required; true → ok', async () => {
  const plan = { planHash: 'a'.repeat(64), confirmCode: '123456' }
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode), { ok: false, reason: 'ack-required' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode, undefined), { ok: false, reason: 'ack-required' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode, false), { ok: false, reason: 'ack-required' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode, 'true'), { ok: false, reason: 'ack-required' })
  assert.deepEqual(verifyConsent(plan, plan.planHash, plan.confirmCode, true), { ok: true })
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
  const result = await h.invoke(`migrate apply --plan ${'0'.repeat(64)} --confirm ${plan.confirmCode} --ack-managed`)
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
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${wrong} --ack-managed`)
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
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
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
  const applied = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
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
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
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

// B2/R-11: a user-written id is `user-extra` and is NEVER removed by bare
// `--adopt` — only `--prune-user-extra` may delete a plan-listed user-extra id.
await checkAsync('V20: adopt + prune-user-extra deletes a plan-listed user-extra id; rollback restores it', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt --prune-user-extra')).text)
  const applied = await h.invoke(`migrate apply --adopt --prune-user-extra --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['deepseek-v4.1-flash'], 'the plan-listed user-extra id was removed')

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

await checkAsync('V20: rollback refuses when the full preManagedSection snapshot is missing (zero writes)', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  // Corrupt the authoritative whole-section snapshot on purpose.
  const key = [...h.ownership.data.keys()][0]
  const entry = structuredClone(h.ownership.data.get(key))
  delete entry.preManagedSection
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
  await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
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
  await h2.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
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
  const result = await applyMigration({ planHash: plan.planHash, confirmCode: plan.confirmCode, ackManaged: true }, deps)
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

// ---------------------------------------------------------------------------
// P2 (P1d-2 verification 6a/6b): byte-exact whole-section rollback. These turn
// red both when the snapshot stores only models and when rollback leaves
// migration-introduced ids behind.
// ---------------------------------------------------------------------------

const chatLedger = (h) => h.ownership.data.get([...h.ownership.data.keys()].find((k) => k.startsWith('opencode-go#')))

await checkAsync('P2-1: default apply→rollback restores the exact pre-apply section (all fields + order)', async () => {
  const before = structuredClone(LEGACY_CHAT)
  const expected = JSON.stringify(before)
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(before) } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const applied = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  assert.ok(idsOf(h.settings, 'opencode-go').includes('deepseek-v4.1-flash'), 'apply added a desired id')

  // The whole section (not just models) is persisted on the ledger queue, and
  // the captured backup is retained on the applied record.
  const entry = chatLedger(h)
  assert.ok(entry, 'chat ledger entry written')
  assert.equal(entry.preManagedSection.apiKeyEnv, 'OPENCODE_GO_API_KEY', 'route fields in snapshot')
  assert.equal(entry.preManagedSection.api, 'openai-completions')
  assert.equal(entry.preManagedSection.baseURL, before.baseURL)
  assert.equal(entry.preManagedSection.displayName, 'OpenCode Go')
  assert.deepEqual(entry.appliedAddedIds, ['deepseek-v4.1-flash'])
  assert.equal(entry.preManagedSection.models.length, 1)
  assert.ok(h.migrationStore.record.backup?.routes['opencode-go']?.section, 'backup retained after success')

  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  assert.equal(JSON.stringify(h.settings.state.get('opencode-go')), expected, 'byte-identical section after rollback')
  assert.equal(idsOf(h.settings, 'opencode-go').includes('deepseek-v4.1-flash'), false, 'apply-added id removed')
  assert.equal(h.settings.state.has('opencode-go-msg'), false, 'plugin-created route removed')
  assert.equal(h.settings.state.has('opencode-go-resp'), false, 'plugin-created route removed')
  h.dispose()
})

await checkAsync('P2-2: adopt apply→rollback restores the exact pre-apply section (all fields + order)', async () => {
  const before = structuredClone(LEGACY_CHAT)
  const expected = JSON.stringify(before)
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(before) } })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  const applied = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  assert.equal(JSON.stringify(h.settings.state.get('opencode-go')), expected, 'byte-identical section after adopt rollback')
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['custom-test-model'], 'adopt-added id removed, legacy id restored')
  h.dispose()
})

await checkAsync('P2-3: rollback removes apply-added ids but keeps ids the user added after apply', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const applied = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)
  h.settings.state.get('opencode-go').models.push({ id: 'my-new-note', name: 'my-new-note' })
  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  const ids = idsOf(h.settings, 'opencode-go')
  assert.ok(ids.includes('custom-test-model'), 'pre-existing id restored')
  assert.ok(!ids.includes('deepseek-v4.1-flash'), 'migration-added id gone')
  assert.ok(ids.includes('my-new-note'), 'post-apply user id preserved')
  h.dispose()
})

await checkAsync('P2-4: crash-window rollback restores exact section incl. fields that never existed', async () => {
  const original = { apiKeyEnv: 'OPENCODE_GO_API_KEY' }
  const expected = JSON.stringify(original)
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(original) } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  h.migrationStore.record = {
    applying: true,
    planHash: plan.planHash,
    backup: { planHash: plan.planHash, capturedAt: 1, routes: { 'opencode-go': { section: structuredClone(original) } } },
  }
  // Half-finished apply: a field + a model the crash introduced.
  h.settings.state.get('opencode-go').api = 'openai-completions'
  h.settings.state.get('opencode-go').models = [{ id: 'deepseek-v4.1-flash', name: 'x' }]
  const result = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(result.kind, 'success', result.text)
  assert.equal(JSON.stringify(h.settings.state.get('opencode-go')), expected, 'exact original section; missing fields stay missing')
  assert.equal(h.migrationStore.record.applying, false)
  h.dispose()
})

// ---------------------------------------------------------------------------
// P2-5 (third rollback gap): go rounds after apply must not erase the migration
// snapshot / applied-added-id fields, or rollback reports `snapshot-missing`.
// This is the apply → 3 go rounds → rollback path found broken on the real host.
// ---------------------------------------------------------------------------

await checkAsync('P2-5: apply → 3 go rounds (no-change + upstream change + revert) → byte-exact rollback; migration fields never change', async () => {
  const before = structuredClone(LEGACY_CHAT)
  const expected = JSON.stringify(before)
  // `roundEntries` is read by the injected fetch on every go round, so mutating
  // this array in place simulates an upstream catalog change between rounds.
  const roundEntries = [...OFFICIAL]
  const h = createHarness({
    initialRoutes: { 'opencode-go': structuredClone(before) },
    roundEntries,
  })
  const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
  const applied = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)

  const keys = [...h.ownership.data.keys()].sort()
  assert.equal(keys.length, 3, 'chat/msg/resp ledger entries exist')
  // Snapshot of ONLY the migration-owned fields across all three entries.
  const snapshotOf = () => Object.fromEntries(keys.map((k) => {
    const e = h.ownership.data.get(k)
    return [k, JSON.stringify({
      preManagedSection: e.preManagedSection,
      appliedAddedIds: e.appliedAddedIds,
    })]
  }))
  for (const k of keys) {
    const e = h.ownership.data.get(k)
    assert.ok(e.preManagedSection !== undefined, `${k}: preManagedSection present right after apply`)
    assert.ok(Array.isArray(e.appliedAddedIds), `${k}: appliedAddedIds present right after apply`)
  }
  const baseline = snapshotOf()

  const chatKey = keys.find((k) => k.startsWith('opencode-go#'))
  const chatManagedIds = Object.keys(h.ownership.data.get(chatKey).managed)
  assert.ok(chatManagedIds.length > 0, 'adopt populated the chat managed set')
  const changedId = chatManagedIds[0]
  const changedEntry = roundEntries.find((e) => e.id === changedId)
  assert.ok(changedEntry !== undefined, 'changed id is in the upstream catalog')
  const originalName = changedEntry.name

  // Round 1: no-change — same catalog apply just converged to.
  const r1 = await h.invoke('go')
  assert.match(r1.text, /source ok/i, r1.text)
  assert.deepEqual(snapshotOf(), baseline, 'round 1 (no-change): migration fields byte-identical')

  // Round 2: upstream metadata change on a managed model → a real settings
  // write + ledger refresh. Writer-owned fields change; migration fields must
  // stay byte-identical.
  changedEntry.name = `${originalName} (upstream v2)`
  const r2 = await h.invoke('go')
  assert.match(r2.text, /source ok/i, r2.text)
  assert.equal(
    h.settings.state.get('opencode-go').models.find((m) => m.id === changedId)?.name,
    changedEntry.name,
    'round 2 wrote the upstream change',
  )
  assert.deepEqual(snapshotOf(), baseline, 'round 2 (upstream change): migration fields byte-identical')

  // Round 3: upstream reverts the metadata → another real write, fields still
  // byte-identical.
  changedEntry.name = originalName
  const r3 = await h.invoke('go')
  assert.match(r3.text, /source ok/i, r3.text)
  assert.equal(
    h.settings.state.get('opencode-go').models.find((m) => m.id === changedId)?.name,
    originalName,
    'round 3 wrote the reverted value',
  )
  assert.deepEqual(snapshotOf(), baseline, 'round 3 (revert): migration fields byte-identical')

  // Rollback must now find the authoritative snapshot and restore byte-exactly.
  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  assert.equal(JSON.stringify(h.settings.state.get('opencode-go')), expected, 'byte-identical section after 3 go rounds')
  assert.equal(h.ownership.data.size, 0, 'ledger cleared by rollback')
  h.dispose()
})

// ---------------------------------------------------------------------------
// N4-b — plain-object lock error on the B2 apply/ledger path keeps actionable
// text in the user-visible output (same口径 as the writer-side N4 fix).
// ---------------------------------------------------------------------------

await checkAsync('N4-b: plain-object DSH_STORE_LOCK_TIMEOUT on ledger write is readable (no [object Object]) and never counts as success', async () => {
  const LOCK_PATH = '/tmp/hash.dsh-store.lock'
  const advice = 'The store was NOT modified. Retry the operation; if it keeps failing, check other running dsh processes.'
  // A non-Error plain object thrown from the ownership store's write(): the
  // migrate path must lift its structured `message` instead of degrading to
  // String(err) === "[object Object]"; classification / fail-closed unchanged.
  const plainLockError = {
    name: 'StoreLockTimeoutError',
    code: 'DSH_STORE_LOCK_TIMEOUT',
    lockPath: LOCK_PATH,
    message: `Timed out after 2000ms waiting for the models-store lock (${LOCK_PATH}). ${advice}`,
  }
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const originalWrite = h.ownership.write
  h.ownership.write = async () => { throw plainLockError }

  const plan = parsePlan((await h.invoke('migrate plan')).text)
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)

  // Not counted as success: refused, no fingerprint, no ledger entry committed.
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /migrate apply refused \(write-failed\)/, 'apply is reported as a failure, not a success')
  assert.equal(h.migrationStore.record?.appliedFingerprint, undefined, 'no appliedFingerprint on failure')
  assert.equal(h.migrationStore.record?.applying, false, 'applying flag cleared after failure')
  assert.equal(h.ownership.data.size, 0, 'no ledger entry committed')

  // Readable user-visible text: structured message lifted, actionable fields kept.
  assert.equal(result.text.includes('[object Object]'), false, 'user-visible text must not degrade to [object Object]')
  assert.ok(result.text.includes(LOCK_PATH), 'user-visible text must carry the lock path')
  assert.ok(result.text.includes('Retry the operation'), 'user-visible text must carry the retry advice')
  assert.ok(result.text.includes('check other running dsh processes'), 'user-visible text must carry the process advice')

  h.ownership.write = originalWrite
  h.dispose()
})

// ---------------------------------------------------------------------------
// O1-minimal (P2) — S3 (refresh + ledger failure → rollback hash-mismatch),
// S8a (apply failure after writes → truthful "writes reverted" text), and
// S8c (stuck `applying` is recoverable). All offline; no real ~/.dsh.
// ---------------------------------------------------------------------------

await checkAsync('O1 #4 (S3): refresh + ledger failure → rollback refused hash-mismatch; healthy control rolls back', async () => {
  const makeRound = (breakLedger) => {
    const roundEntries = [...OFFICIAL.map((e) => ({ ...e }))]
    const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) }, roundEntries })
    return { h, roundEntries }
  }
  const runRefresh = async (h, roundEntries, breakLedger) => {
    const plan = parsePlan((await h.invoke('migrate plan --adopt')).text)
    const applied = await h.invoke(`migrate apply --adopt --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
    assert.equal(applied.kind, 'success', applied.text)
    const chatKey = [...h.ownership.data.keys()].find((k) => k.startsWith('opencode-go#'))
    const changedId = Object.keys(h.ownership.data.get(chatKey).managed)[0]
    const changedEntry = roundEntries.find((e) => e.id === changedId)
    changedEntry.name = `${changedEntry.name} (upstream v2)`
    if (breakLedger) {
      const originalWrite = h.ownership.write
      h.ownership.write = async () => { throw new Error('ledger full') }
      const round = await h.invoke('go')
      h.ownership.write = originalWrite
      return { plan, round, changedId, changedEntry }
    }
    const round = await h.invoke('go')
    return { plan, round, changedId, changedEntry }
  }

  // Broken ledger: settings carry the refreshed value, ledger hash stays old.
  const bad = makeRound(true)
  const broken = await runRefresh(bad.h, bad.roundEntries, true)
  assert.equal(broken.round.kind, 'error', broken.round.text)
  assert.match(broken.round.text, /settings-written-unaccounted/)
  assert.equal(
    bad.h.settings.state.get('opencode-go').models.find((m) => m.id === broken.changedId)?.name,
    broken.changedEntry.name,
    'the refreshed metadata did land in settings',
  )
  const refused = await bad.h.invoke(`migrate rollback --plan ${broken.plan.planHash}`)
  assert.equal(refused.kind, 'error', refused.text)
  assert.match(refused.text, /hash-mismatch/, 'rollback refuses a stale managed hash')

  // Healthy control: same refresh with a working ledger, rollback succeeds.
  const good = makeRound(false)
  const healthy = await runRefresh(good.h, good.roundEntries, false)
  assert.equal(healthy.round.kind, 'success', healthy.round.text)
  const ok = await good.h.invoke(`migrate rollback --plan ${healthy.plan.planHash}`)
  assert.equal(ok.kind, 'success', ok.text)
  bad.h.dispose()
  good.h.dispose()
})

await checkAsync('O1 #7 (S8a): apply failure after writes restores exact bytes and reports the rollback truthfully', async () => {
  const before = structuredClone(LEGACY_CHAT)
  const expected = JSON.stringify(before)
  const h = createHarness({ initialRoutes: { 'opencode-go': structuredClone(before) } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  // Fail at step 4 (after settings + ledger landed), so writes did happen.
  const originalWrite = h.migrationStore.write
  h.migrationStore.write = async (record) => {
    if (record.appliedFingerprint !== undefined) throw new Error('record persist failed')
    return originalWrite(record)
  }
  const result = await h.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /settings writes were rolled back/, 'truthful: writes happened then were reverted')
  assert.doesNotMatch(result.text, /; zero writes/, 'no false zero-write claim')
  assert.equal(JSON.stringify(h.settings.state.get('opencode-go')), expected, 'byte-identical section restored')
  assert.equal(h.migrationStore.record?.applying, false, 'applying flag cleared')
  assert.equal(h.ownership.data.size, 0, 'ledger entries dropped by the restore')
  h.migrationStore.write = originalWrite
  h.dispose()
})

await checkAsync('O1 #7 (S8c): a stuck applying flag still lets a later rollback recover', async () => {
  const h = createHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  const plan = parsePlan((await h.invoke('migrate plan')).text)
  // Crash window: applying flag + captured backup, no settings/ledger change.
  h.migrationStore.record = {
    applying: true,
    planHash: plan.planHash,
    backup: {
      planHash: plan.planHash,
      capturedAt: 1,
      routes: { 'opencode-go': { section: structuredClone(LEGACY_CHAT) } },
    },
  }
  const during = await h.invoke('go')
  assert.match(during.text, /applying|skipped/i, 'go round drops while applying')
  assert.equal(h.settings.mutations.length, 0, 'no settings write while applying')
  const rolled = await h.invoke(`migrate rollback --plan ${plan.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)
  assert.equal(h.migrationStore.record.applying, false, 'applying flag cleared by recovery')
  h.dispose()
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

// B1 profile isolation for the SHARED ~/.dsh/models-store.json.
// All offline: two plugin instances with separate settings but ONE temp store
// file, injected fetch/entries/timers, no network, no real ~/.dsh.
//
// Scenarios:
//  1. A applied; B (never migrated, same Go key) → B's go round and bare sync
//     make ZERO writes and report the migration-gate skip.
//  2. A rollback touches only A's keys; B's ledger + migration record in the
//     shared store and B's settings stay byte-identical.
//  3. Unscoped legacy keys (no profile prefix) are reported but never claimed.
//  4. Key format is <profileKey>#<route>#<keyFingerprint> — removing the
//     profile dimension makes these assertions (and scenarios 1-2) go red.
//  5. Cross-process write guard keeps both profiles' keys on concurrent RMW.

import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { apply, GO_MIGRATION_ENTRIES_SERVICE } from '../lib/index.js'
import { fingerprintSection } from '../lib/opencode-go-migration.js'
import { createFileMigrationStateStore, GO_MIGRATION_STORE_KEY } from '../lib/opencode-go-migration.js'
import { createFileOwnershipStore } from '../lib/opencode-go-store.js'
import { goOwnershipKey } from '../lib/opencode-go-planner.js'
import { parseGoModelsPayload } from '../lib/opencode-go-source.js'
import { loadModelsStore, resetModelsStoreCache } from '../lib/remote-catalog.js'
import {
  GO_FETCH_SERVICE,
  GO_OWNERSHIP_STORE_SERVICE,
  GO_OVERRIDE_STORER_SERVICE,
} from '../lib/opencode-go-sync.js'
import { GO_MIGRATION_STORE_SERVICE } from '../lib/opencode-go-migration.js'
import {
  GO_SCHEDULER_RANDOM_SERVICE,
  GO_SCHEDULER_TIMERS_SERVICE,
} from '../lib/opencode-go-scheduler.js'
import { fingerprintKey } from '../lib/opencode-go-source.js'
import { resolveProfileKey } from '../lib/opencode-go-profile.js'

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

const KEY = 'shared-go-key' // SAME key for both profiles — the B1 trigger
const KEY_FP = fingerprintKey(KEY)
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))
const OFFICIAL = parseGoModelsPayload(FIXTURE).filter((entry) => entry.id !== 'gemini-4-argon')

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

function makeConfig() {
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
  const config = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { get: () => v }]))
  config.opencode = {
    go: {
      enabled: true,
      ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      pinnedModels: [],
      confirmRemovals: 2,
      adoptExisting: false,
      routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp', google: 'opencode-go-google' },
    },
  }
  return config
}

/**
 * One plugin instance for `profileKey`, sharing `accessor` (one store file)
 * with the other profiles. Everything else is isolated per instance.
 */
function makeProfile(accessor, profileKey, initialRoutes) {
  const settings = mockSettings(initialRoutes)
  const fetchCalls = []
  const listeners = []
  const timers = []
  const state = { definitions: [], disposers: [], provided: {} }
  const services = {
    settings,
    // Host-provided identity — this is what the fix keys on.
    profileContext: { name: profileKey },
    launchEnvironment: { get: () => undefined },
    [GO_OVERRIDE_STORER_SERVICE]: { async read() { return undefined }, async updateOverrides() {} },
    [GO_FETCH_SERVICE]: async (url) => {
      fetchCalls.push(url)
      return { status: 200, json: async () => ({ object: 'list', data: OFFICIAL.map((e) => ({
        id: e.id,
        name: e.name,
        api: Object.fromEntries(Object.entries(e.api ?? {}).map(([p, v]) => [p, { base_url: v.baseUrl ?? v.base_url }])),
        inputModalities: e.inputModalities,
      })) }) }
    },
    [GO_MIGRATION_ENTRIES_SERVICE]: OFFICIAL,
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
  }
  // Derive the key through the SAME production resolver apply() uses, so a
  // mutation that drops the profile dimension turns these tests red.
  const resolvedKey = resolveProfileKey({ get: (name) => services[name] })
  services[GO_MIGRATION_STORE_SERVICE] = createFileMigrationStateStore(accessor, resolvedKey)
  services[GO_OWNERSHIP_STORE_SERVICE] = createFileOwnershipStore(accessor, resolvedKey)
  const ctx = {
    settings,
    get: (name) => services[name],
    logger: { info() {}, warn() {}, debug() {} },
    on(event, listener) { listeners.push({ event, listener }); return () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposers.push(d); return d },
    provide(name, service) { state.provided[name] = service },
    inject(names, callback) { callback(Object.create(ctx)) },
    commands: { register(definition) { state.definitions.push(definition); return () => {} } },
  }
  apply(ctx, makeConfig())
  const invoke = (text) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text })
  }
  return {
    profileKey, settings, fetchCalls, state, invoke,
    dispose() { for (const d of state.disposers) d() },
  }
}

const parsePlan = (text) => ({
  planHash: /planHash: ([0-9a-f]{64})/.exec(text)?.[1],
  confirmCode: /confirmCode: (\d{6})/.exec(text)?.[1],
})
const idsOf = (settings, route) => settings.state.get(route)?.models?.map((m) => m.id) ?? []

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-go-profile-'))
  const file = join(dir, 'models-store.json')
  try {
    await fn({ accessor: loadModelsStore(file), file, dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
}

// ---------------------------------------------------------------------------
// 1 + 4: key format and isolation of the migration gate
// ---------------------------------------------------------------------------
await checkAsync('B1: key format is <profileKey>#<route>#<keyFingerprint> and record is profile-stamped', () => withStore(async ({ accessor, file }) => {
  const a = makeProfile(accessor, 'A', { 'opencode-go': structuredClone(LEGACY_CHAT) })
  const plan = parsePlan((await a.invoke('migrate plan')).text)
  const applied = await a.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
  assert.equal(applied.kind, 'success', applied.text)

  const doc = JSON.parse(await readFile(file, 'utf8'))
  const recordKey = `A#${GO_MIGRATION_STORE_KEY}`
  const ledgerKey = `A#${goOwnershipKey('opencode-go', KEY_FP)}`
  assert.equal(doc[`A#${GO_MIGRATION_STORE_KEY}`]?.profileKey, 'A', 'record carries the profile stamp')
  assert.ok(recordKey in doc && ledgerKey in doc, `scoped keys present: ${Object.keys(doc).join(', ')}`)
  assert.equal(doc[GO_MIGRATION_STORE_KEY], undefined, 'no unscoped migration record written')
  assert.equal(doc[goOwnershipKey('opencode-go', KEY_FP)], undefined, 'no unscoped ledger key written')

  // Mutation killer: with the profile dimension removed, both profiles would
  // read the SAME unscoped slot. Show the scoped store does NOT cross-read.
  const bRecord = await createFileMigrationStateStore(accessor, 'B').read()
  assert.equal(bRecord, undefined, 'profile B cannot read profile A record')
  a.dispose()
}))

await checkAsync('B1: A applied + B never migrated → B go round and bare sync are zero-write with skip', () => withStore(async ({ accessor }) => {
  const a = makeProfile(accessor, 'A', { 'opencode-go': structuredClone(LEGACY_CHAT) })
  const plan = parsePlan((await a.invoke('migrate plan')).text)
  assert.equal((await a.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)).kind, 'success')

  const b = makeProfile(accessor, 'B', { 'opencode-go': structuredClone(LEGACY_CHAT) })
  const status = await b.invoke('migrate status')
  assert.doesNotMatch(status.text, /status: applied/, 'B must NOT inherit A applied state')
  // D6: A's record is foreign to B; the unclaimable label replaces the old
  // generic legacy-inline text so automation can tell it from "never migrated".
  assert.match(status.text, /status: foreign-profile/, status.text)
  assert.match(status.text, /owner=none/, status.text)

  const before = b.settings.mutations.length
  const go = await b.invoke('go')
  assert.equal(b.settings.mutations.length, before, 'B go round made ZERO settings writes')
  assert.deepEqual(b.fetchCalls, [], 'B go round made ZERO source requests (gate short-circuits)')
  assert.match(go.text, /migration gate/, go.text)
  assert.match(go.text, /migrate plan/, 'gate report tells B to migrate')
  assert.deepEqual(idsOf(b.settings, 'opencode-go'), ['custom-test-model'], 'B hand-written list untouched')

  const bare = await b.state.provided.modelSync.syncNow()
  assert.equal(b.settings.mutations.length, before, 'B bare sync made ZERO settings writes')
  assert.match(bare, /skipped-route-owner/, 'bare sync reports the skip')
  assert.match(bare, /opencode-go: skipped/, 'the go route is named in the skip')
  a.dispose()
  b.dispose()
}))

// ---------------------------------------------------------------------------
// 2: rollback isolation
// ---------------------------------------------------------------------------
await checkAsync('B1: A rollback leaves B ledger + migration record byte-identical and B settings untouched', () => withStore(async ({ accessor, file }) => {
  const a = makeProfile(accessor, 'A', { 'opencode-go': structuredClone(LEGACY_CHAT) })
  // B's pre-apply section differs → a different planHash, so a cross-profile
  // hash cannot be mistaken for A's own consent token.
  const bLegacy = structuredClone(LEGACY_CHAT)
  bLegacy.models.push({ id: 'b-user-model', name: 'b-user-model', input: ['text'] })
  const b = makeProfile(accessor, 'B', { 'opencode-go': bLegacy })
  const planA = parsePlan((await a.invoke('migrate plan')).text)
  const planB = parsePlan((await b.invoke('migrate plan')).text)
  assert.equal((await a.invoke(`migrate apply --plan ${planA.planHash} --confirm ${planA.confirmCode} --ack-managed`)).kind, 'success')
  assert.equal((await b.invoke(`migrate apply --plan ${planB.planHash} --confirm ${planB.confirmCode} --ack-managed`)).kind, 'success')

  const bSettingsBefore = JSON.stringify(b.settings.describe())
  const docBefore = JSON.parse(await readFile(file, 'utf8'))
  const bKeys = Object.keys(docBefore).filter((k) => k.startsWith('B#'))
  const bSliceBefore = Object.fromEntries(bKeys.map((k) => [k, docBefore[k]]))

  // A uses its OWN hash; cross-profile hash must be refused.
  const cross = await a.invoke(`migrate rollback --plan ${planB.planHash}`)
  assert.equal(cross.kind, 'error', 'A cannot roll back with B plan hash')
  const rolled = await a.invoke(`migrate rollback --plan ${planA.planHash}`)
  assert.equal(rolled.kind, 'success', rolled.text)

  const bSettingsAfter = JSON.stringify(b.settings.describe())
  assert.equal(bSettingsAfter, bSettingsBefore, 'B settings byte-identical after A rollback')
  const docAfter = JSON.parse(await readFile(file, 'utf8'))
  const bSliceAfter = Object.fromEntries(Object.keys(docAfter).filter((k) => k.startsWith('B#')).map((k) => [k, docAfter[k]]))
  assert.deepEqual(bSliceAfter, bSliceBefore, 'B ledger + migration record byte-identical after A rollback')
  assert.equal(docAfter[`A#${GO_MIGRATION_STORE_KEY}`]?.applying, false, 'A record cleared by rollback')
  assert.equal(docAfter[`A#${goOwnershipKey('opencode-go', KEY_FP)}`], undefined, 'A ledger removed by rollback')

  // B still applied after A rollback — its gate stays open, unaffected.
  const statusB = await b.invoke('migrate status')
  assert.match(statusB.text, /status: applied/, statusB.text)
  a.dispose()
  b.dispose()
}))

// ---------------------------------------------------------------------------
// 3: legacy (unscoped) keys are reported, never claimed
// ---------------------------------------------------------------------------
await checkAsync('B1: unscoped legacy keys are reported but never adopted or deleted', () => withStore(async ({ accessor, file }) => {
  const legacySections = { 'opencode-go': structuredClone(LEGACY_CHAT) }
  const legacyRecord = {
    appliedFingerprint: fingerprintSection(legacySections),
    appliedIdentityRoutes: ['opencode-go'],
    appliedIdentity: fingerprintSection(legacySections),
  }
  // Seed a pre-fix record + ledger entry with NO profile prefix.
  await accessor.writeRaw(GO_MIGRATION_STORE_KEY, legacyRecord)
  await accessor.writeRaw(goOwnershipKey('opencode-go', KEY_FP), { managed: {} })
  const legacyBefore = JSON.parse(await readFile(file, 'utf8'))
  const legacySnapshot = {
    record: structuredClone(legacyBefore[GO_MIGRATION_STORE_KEY]),
    ledger: structuredClone(legacyBefore[goOwnershipKey('opencode-go', KEY_FP)]),
  }

  const c = makeProfile(accessor, 'C', { 'opencode-go': structuredClone(LEGACY_CHAT) })
  const status = await c.invoke('migrate status')
  assert.doesNotMatch(status.text, /status: applied/, 'legacy record is NOT adopted')
  assert.match(status.text, /旧键|无 profile/, 'status warns about ignored legacy keys')
  assert.match(status.text, new RegExp(GO_MIGRATION_STORE_KEY), 'status names the legacy key')

  const before = c.settings.mutations.length
  const go = await c.invoke('go')
  assert.equal(c.settings.mutations.length, before, 'legacy record cannot open the gate: zero writes')
  assert.match(go.text, /migration gate/, go.text)

  const docAfter = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(docAfter[GO_MIGRATION_STORE_KEY], legacySnapshot.record, 'legacy migration key untouched')
  assert.deepEqual(docAfter[goOwnershipKey('opencode-go', KEY_FP)], legacySnapshot.ledger, 'legacy ledger key untouched')
  assert.equal(docAfter[`C#${GO_MIGRATION_STORE_KEY}`], undefined, 'no C record written by read-only paths')
  c.dispose()
}))

// ---------------------------------------------------------------------------
// 5: minimal cross-process guard — concurrent RMW from two accessors
// ---------------------------------------------------------------------------
await checkAsync('B1: concurrent writes from two independent accessors keep both profiles keys', () => withStore(async ({ file }) => {
  // Two accessors = two processes in this test. The in-process queue cannot
  // serialize them; the lock file must prevent last-writer-wins loss.
  const acc1 = loadModelsStore(file)
  const acc2 = loadModelsStore(file)
  const s1 = createFileOwnershipStore(acc1, 'A')
  const s2 = createFileOwnershipStore(acc2, 'B')
  const m1 = createFileMigrationStateStore(acc1, 'A')
  const m2 = createFileMigrationStateStore(acc2, 'B')
  const entry = { managed: { x: { hash: 'h' } } }
  await Promise.all([
    s1.write(goOwnershipKey('opencode-go', KEY_FP), entry),
    s2.write(goOwnershipKey('opencode-go', KEY_FP), entry),
    m1.write({ appliedIdentity: 'a' }),
    m2.write({ appliedIdentity: 'b' }),
  ])
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc[`A#${goOwnershipKey('opencode-go', KEY_FP)}`], entry, 'A ledger survived concurrent writers')
  assert.deepEqual(doc[`B#${goOwnershipKey('opencode-go', KEY_FP)}`], entry, 'B ledger survived concurrent writers')
  assert.equal(doc[`A#${GO_MIGRATION_STORE_KEY}`]?.appliedIdentity, 'a')
  assert.equal(doc[`B#${GO_MIGRATION_STORE_KEY}`]?.appliedIdentity, 'b')
}))

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

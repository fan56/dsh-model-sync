// B1 follow-up (D1/D4/D5): behavior assertions for exact legacy-key
// classification and fail-closed profile identity. All offline: scratch HOME,
// temp store files, injected fetch/entries/timers, no network, no real ~/.dsh.
//
// HOME is redirected BEFORE the lib modules load so `MODELS_STORE_PATH`
// (computed at import time from os.homedir()) points at a scratch store. That
// lets the no-identity case exercise the REAL file-backed store path — the one
// that must refuse to build an unscoped `default#...` ledger.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH_HOME = await mkdtemp(join(tmpdir(), 'dsh-profile-identity-'))
await mkdir(join(SCRATCH_HOME, '.dsh'), { recursive: true })
process.env.HOME = SCRATCH_HOME
const STORE_FILE = join(SCRATCH_HOME, '.dsh', 'models-store.json')
const LOCK_PATH = join(
  tmpdir(),
  `${createHash('sha256').update(STORE_FILE).digest('hex')}.dsh-store.lock`,
)

const { apply } = await import('../lib/index.js')
const { fingerprintSection, createFileMigrationStateStore, GO_MIGRATION_STORE_KEY } = await import('../lib/opencode-go-migration.js')
const { migrationStatusReport } = await import('../lib/opencode-go-migrate.js')
const { createFileOwnershipStore } = await import('../lib/opencode-go-store.js')
const { goOwnershipKey } = await import('../lib/opencode-go-planner.js')
const { parseGoModelsPayload, fingerprintKey } = await import('../lib/opencode-go-source.js')
const { loadModelsStore, resetModelsStoreCache } = await import('../lib/remote-catalog.js')
const { resolveProfileKey, isUnscopedStoreKey, GO_MIGRATION_STORE_KEY_BASE, PROFILE_IDENTITY_REQUIRED_MESSAGE } = await import('../lib/opencode-go-profile.js')
const {
  GO_FETCH_SERVICE,
  GO_OWNERSHIP_STORE_SERVICE,
  GO_OVERRIDE_STORER_SERVICE,
} = await import('../lib/opencode-go-sync.js')
const { GO_MIGRATION_STORE_SERVICE, GO_MIGRATION_ENTRIES_SERVICE } = await import('../lib/opencode-go-migration.js')
const { GO_SCHEDULER_TIMERS_SERVICE, GO_SCHEDULER_RANDOM_SERVICE } = await import('../lib/opencode-go-scheduler.js')

const { readFileSync } = await import('node:fs')
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))
const OFFICIAL = parseGoModelsPayload(FIXTURE)
const KEY = 'shared-go-key'
const KEY_FP = fingerprintKey(KEY)
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

function makeConfig() {
  const base = {
    writeMode: 'settings', intervalMinutes: 0, startupDelaySeconds: 0,
    refreshTimeoutMs: 120000, managedRoutes: ['opencode-go'], keepBuiltinOnly: false,
    dropUnserviceable: true, syncNotify: false, forceMaxReasoningEffort: false,
    providerNativeFetch: false, keepDeprecatedBuiltin: false,
  }
  const config = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { get: () => v }]))
  config.opencode = {
    go: {
      enabled: true, ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      pinnedModels: [], confirmRemovals: 2, adoptExisting: false,
      routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp', google: 'opencode-go-google' },
    },
  }
  return config
}

/**
 * Build one plugin instance. `identity` supplies the host seam(s). When
 * `injectStores` is false (default) the production file-backed stores are used,
 * so a missing identity must take the fail-closed path at the real call site.
 */
function makeInstance({ identity = {}, injectStores = false, initialRoutes = {} } = {}) {
  const settings = mockSettings(initialRoutes)
  const fetchCalls = []
  const timers = []
  const logs = []
  const state = { definitions: [], disposers: [], provided: {} }
  const services = {
    settings,
    [GO_OVERRIDE_STORER_SERVICE]: { async read() { return undefined }, async updateOverrides() {} },
    [GO_FETCH_SERVICE]: async (url) => {
      fetchCalls.push(url)
      return { status: 200, json: async () => ({ object: 'list', data: OFFICIAL.map((e) => ({
        id: e.id, name: e.name,
        api: Object.fromEntries(Object.entries(e.api ?? {}).map(([p, v]) => [p, { base_url: v.baseUrl ?? v.base_url }])),
        inputModalities: e.inputModalities,
      })) }) }
    },
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
  }
  if (identity.profileContext !== undefined) services.profileContext = identity.profileContext
  if (identity.launchEnvironment !== undefined) services.launchEnvironment = identity.launchEnvironment
  if (injectStores) {
    const resolved = resolveProfileKey({ get: (name) => services[name] })
    assert.notEqual(resolved, undefined, 'injected-store fixtures must supply a resolvable identity')
    services[GO_MIGRATION_STORE_SERVICE] = createFileMigrationStateStore(loadModelsStore(STORE_FILE), resolved)
    services[GO_OWNERSHIP_STORE_SERVICE] = createFileOwnershipStore(loadModelsStore(STORE_FILE), resolved)
  }
  const ctx = {
    settings,
    get: (name) => services[name],
    logger: {
      info(...args) { logs.push(args.map(String).join(' ')) },
      warn(...args) { logs.push(args.map(String).join(' ')) },
      debug() {},
    },
    on() { return () => {} },
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
  return { settings, fetchCalls, invoke, logs, dispose() { for (const d of state.disposers) d() } }
}

const parsePlan = (text) => ({
  planHash: /planHash: ([0-9a-f]{64})/.exec(text)?.[1],
  confirmCode: /confirmCode: (\d{6})/.exec(text)?.[1],
})

async function resetStore(seed = {}) {
  await rm(LOCK_PATH, { force: true })
  await writeFile(STORE_FILE, JSON.stringify(seed), 'utf8')
  resetModelsStoreCache()
}

test.after(async () => {
  await rm(SCRATCH_HOME, { recursive: true, force: true })
  await rm(LOCK_PATH, { force: true })
})

// ---------------------------------------------------------------------------
// 1. D1: exact legacy-key classification
// ---------------------------------------------------------------------------
test('D1: isUnscopedStoreKey uses explicit key shapes (scoped keys never legacy)', () => {
  assert.equal(GO_MIGRATION_STORE_KEY, GO_MIGRATION_STORE_KEY_BASE)
  assert.equal(isUnscopedStoreKey('opencode-go#abc123'), true, 'unscoped ownership key is legacy')
  assert.equal(isUnscopedStoreKey('migration:opencode-go'), false, 'unscoped migration base is reported by caller, not this predicate')
  assert.equal(isUnscopedStoreKey(`A#${GO_MIGRATION_STORE_KEY}`), false, 'scoped migration key is NOT legacy')
  assert.equal(isUnscopedStoreKey(`A#opencode-go#abc123`), false, 'scoped ownership key is NOT legacy')
  assert.equal(isUnscopedStoreKey('A#'), false, 'malformed empty tail is not legacy')
})

test('D1: legacyKeys() excludes owned scoped keys but keeps genuine unscoped keys', async () => {
  await resetStore()
  try {
    const accessor = loadModelsStore(STORE_FILE)
    const migration = createFileMigrationStateStore(accessor, 'A')
    const ownership = createFileOwnershipStore(accessor, 'A')
    await migration.write({ appliedIdentity: 'owned-by-A' })
    await ownership.write(goOwnershipKey('opencode-go', KEY_FP), { managed: {} })
    // Original D1 probe: owned scoped keys must produce ZERO legacy keys.
    assert.deepEqual(await migration.legacyKeys(), [])

    // Genuine unscoped legacy keys are still reported.
    await accessor.writeRaw(GO_MIGRATION_STORE_KEY, { appliedIdentity: 'legacy' })
    await accessor.writeRaw(goOwnershipKey('opencode-go', KEY_FP), { managed: {} })
    const legacy = await migration.legacyKeys()
    assert.ok(legacy.includes(GO_MIGRATION_STORE_KEY), `unscoped migration key reported: ${legacy.join(', ')}`)
    assert.ok(legacy.includes(goOwnershipKey('opencode-go', KEY_FP)), `unscoped ownership key reported: ${legacy.join(', ')}`)
    assert.ok(!legacy.includes(`A#${GO_MIGRATION_STORE_KEY}`), 'scoped key never enters legacy list')

    // Never claimed / never deleted: raw slots stay byte-identical.
    const before = await readFile(STORE_FILE, 'utf8')
    assert.equal((await createFileMigrationStateStore(accessor, 'A').read())?.appliedIdentity, 'owned-by-A', 'scoped record still readable')
    assert.deepEqual(await accessor.readRaw(GO_MIGRATION_STORE_KEY), { appliedIdentity: 'legacy' })
    await migration.legacyKeys?.()
    assert.equal(await readFile(STORE_FILE, 'utf8'), before, 'legacyKeys is advisory and mutates nothing')
  } finally {
    await rm(LOCK_PATH, { force: true })
  }
})

test('D1: migrate status no longer mislabels an owned scoped record as legacy', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({ identity: { profileContext: { name: 'A', dir: '/profiles/A' } }, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const plan = parsePlan((await inst.invoke('migrate plan')).text)
    assert.equal((await inst.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)).kind, 'success')

    const status = await inst.invoke('migrate status')
    assert.match(status.text, /status: applied/, status.text)
    assert.doesNotMatch(status.text, /无 profile 前缀的旧键/, `status must not mislabel owned keys: ${status.text}`)

    const doc = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    assert.equal(doc[`A#${GO_MIGRATION_STORE_KEY}`]?.profileKey, 'A')
    assert.equal(doc['migration:opencode-go'], undefined)
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. D4: no identity + no fallback → fail closed
// ---------------------------------------------------------------------------
test('D4: no profileContext and no fallback → apply/rollback/status/go rejected, bytes unchanged', async () => {
  const seed = { 'opencode-go': structuredClone(LEGACY_CHAT) }
  await resetStore(seed)
  let inst
  try {
    inst = makeInstance({ identity: {}, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const beforeStore = await readFile(STORE_FILE, 'utf8')
    const beforeSettings = JSON.stringify(inst.settings.describe())

    for (const cmd of ['migrate plan', 'migrate apply --plan deadbeef --confirm 123456', 'migrate rollback --plan deadbeef', 'migrate status']) {
      const result = await inst.invoke(cmd)
      assert.equal(result.kind, 'error', `${cmd} must be rejected: ${result.text}`)
      assert.match(result.text, /cannot resolve the dsh profile identity/, result.text)
      assert.match(result.text, /profileContext\.name|DSH_PROFILE/, result.text, 'error must say how to fix (verified variable names)')
    }

    const go = await inst.invoke('go')
    assert.equal(inst.fetchCalls.length, 0, 'no source request without a scoped ledger')
    assert.equal(inst.settings.mutations.length, 0, 'go round made zero settings writes without identity')

    assert.equal(await readFile(STORE_FILE, 'utf8'), beforeStore, 'store bytes unchanged')
    assert.equal(JSON.stringify(inst.settings.describe()), beforeSettings, 'settings bytes unchanged')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. D4: host profileContext → normal apply
// ---------------------------------------------------------------------------
test('D4: injected host profileContext resolves and apply writes only scoped keys', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({
      identity: { profileContext: { name: 'HOST-A', dir: '/profiles/HOST-A' }, launchEnvironment: { get: () => undefined } },
      initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) },
    })
    const plan = parsePlan((await inst.invoke('migrate plan')).text)
    assert.ok(plan.planHash, 'plan produced under host identity')
    const applied = await inst.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)
    assert.equal(applied.kind, 'success', applied.text)

    const doc = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    assert.equal(doc[`HOST-A#${GO_MIGRATION_STORE_KEY}`]?.profileKey, 'HOST-A')
    assert.equal(doc[GO_MIGRATION_STORE_KEY], undefined, 'no unscoped migration record')
    assert.ok(Object.keys(doc).some((k) => k.startsWith(`HOST-A#${goOwnershipKey('opencode-go', '')}`)), 'ledger key scoped to HOST-A')
    assert.ok(Object.keys(doc).every((k) => k === 'opencode-go' || k.startsWith('HOST-A#')), `all raw ledger keys scoped: ${Object.keys(doc).join(', ')}`)
    assert.match((await inst.invoke('migrate status')).text, /status: applied/)
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. D4: DSH_PROFILE fallback (explicit opt-in; verified name in launcher source)
// ---------------------------------------------------------------------------
test('D4: DSH_PROFILE fallback resolves and scopes the ledger', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({
      identity: { launchEnvironment: { get: (name) => name === 'DSH_PROFILE' ? { value: 'ENV-P' } : undefined } },
      initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) },
    })
    assert.equal(resolveProfileKey({ get: (name) => ({ launchEnvironment: { get: (k) => k === 'DSH_PROFILE' ? { value: 'ENV-P' } : undefined } })[name] }), 'ENV-P')
    const plan = parsePlan((await inst.invoke('migrate plan')).text)
    assert.equal((await inst.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)).kind, 'success')

    const doc = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    assert.equal(doc[`ENV-P#${GO_MIGRATION_STORE_KEY}`]?.profileKey, 'ENV-P')
    assert.equal(doc[GO_MIGRATION_STORE_KEY], undefined)
    assert.match((await inst.invoke('migrate status')).text, /status: applied/)
    // No silent 'default' slot was created.
    assert.ok(!Object.keys(doc).some((k) => k.startsWith('default#')), `no default# keys: ${Object.keys(doc).join(', ')}`)
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Regressions: name-stable move / rename orphan / foreign stamp rejected
// ---------------------------------------------------------------------------
test('regression: same name, moved directory → same key; rename → no inheritance', async () => {
  const at = (name, dir) => resolveProfileKey({ get: (n) => (n === 'profileContext' ? { name, dir } : undefined) })
  assert.equal(at('P', '/old/P'), 'P')
  assert.equal(at('P', '/new/P'), 'P', 'moving directory with same basename keeps the key')
  assert.equal(at('Q', '/old/P'), 'Q', 'rename changes the key')

  await resetStore()
  const accessor = loadModelsStore(STORE_FILE)
  try {
    const a = createFileMigrationStateStore(accessor, at('P', '/old/P'))
    await a.write({ appliedIdentity: 'P-marker' })
    const moved = createFileMigrationStateStore(accessor, at('P', '/new/P'))
    assert.equal((await moved.read())?.appliedIdentity, 'P-marker', 'same name after move still reads the record')
    const renamed = createFileMigrationStateStore(accessor, at('Q', '/new/P'))
    assert.equal(await renamed.read(), undefined, 'renamed profile must NOT inherit the old record')
    const doc = JSON.parse(await readFile(STORE_FILE, 'utf8'))
    assert.equal(doc[`P#${GO_MIGRATION_STORE_KEY}`]?.appliedIdentity, 'P-marker', 'old record left intact, fail-closed')
  } finally {
    await rm(LOCK_PATH, { force: true })
  }
})

test('regression: a foreign profile stamp in this profile slot is rejected', async () => {
  await resetStore()
  const accessor = loadModelsStore(STORE_FILE)
  try {
    await accessor.writeRaw(`A#${GO_MIGRATION_STORE_KEY}`, {
      profileKey: 'B', appliedIdentity: fingerprintSection({ 'opencode-go': structuredClone(LEGACY_CHAT) }),
    })
    const a = createFileMigrationStateStore(accessor, 'A')
    assert.equal(await a.read(), undefined, 'stamp mismatch → no record → gate closed')
    assert.deepEqual(await accessor.readRaw(`A#${GO_MIGRATION_STORE_KEY}`), {
      profileKey: 'B', appliedIdentity: fingerprintSection({ 'opencode-go': structuredClone(LEGACY_CHAT) }),
    }, 'foreign record untouched')
  } finally {
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. N1: go command reports failure via `kind` when no identity is available
// ---------------------------------------------------------------------------
test('N1: no identity → go command returns kind=error and exposes the identity error (real command path)', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({ identity: {}, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const beforeStore = await readFile(STORE_FILE, 'utf8')
    const beforeSettings = JSON.stringify(inst.settings.describe())

    const go = await inst.invoke('go')
    // The round throws (ownership store refuses to build) → scheduler-error.
    // A consumer reading only `kind` must see a failure, not 'success'.
    assert.equal(go.kind, 'error', `go must report failure via kind: ${go.text}`)
    assert.match(go.text, /cannot resolve the dsh profile identity/, 'the identity error must be the exposed failure reason')
    assert.match(go.text, /profileContext\.name|DSH_PROFILE/, 'failure text must say how to fix')
    assert.equal(inst.fetchCalls.length, 0, 'no source request without identity')
    assert.equal(inst.settings.mutations.length, 0, 'zero settings writes without identity')
    assert.equal(await readFile(STORE_FILE, 'utf8'), beforeStore, 'store bytes unchanged')
    assert.equal(JSON.stringify(inst.settings.describe()), beforeSettings, 'settings bytes unchanged')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. N2: non-strict status refresh / status output must surface identity error
// ---------------------------------------------------------------------------
test('N2: no identity → status output and non-strict refresh show an actionable identity hint (not silent legacy)', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({ identity: {}, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const beforeStore = await readFile(STORE_FILE, 'utf8')

    // Bare /model-sync → syncSettings → single-writer gate → loadMigrationStatus().
    // This is the status output the report said silently showed 'legacy' before.
    const report = await inst.invoke('')
    assert.match(report.text, /opencode-go: skipped/, report.text)
    assert.match(report.text, /profile 身份不可用/, 'status output must name the identity failure')
    assert.match(report.text, /fail-closed/, 'status output must state migration/ledger are fail-closed')
    assert.match(report.text, /DSH_PROFILE|profileContext/, 'status hint must say how to fix')
    assert.doesNotMatch(report.text, /检测到未迁移配置，已跳过写入/, 'must NOT masquerade as a normal legacy state')

    // The same non-strict read also warns on the background-refresh path (boot /
    // document-updated have no report line): the actionable error must be logged.
    assert.ok(
      inst.logs.some((line) => line.includes('non-strict status refresh degraded')
        && line.includes('cannot resolve the dsh profile identity')),
      `background refresh must log the identity failure; logs=${JSON.stringify(inst.logs)}`,
    )

    // Regression: explicit `migrate status` keeps its original fail-closed behavior.
    const status = await inst.invoke('migrate status')
    assert.equal(status.kind, 'error', 'explicit status still fails closed')
    assert.match(status.text, /cannot resolve the dsh profile identity/, status.text)

    assert.equal(inst.settings.mutations.length, 0, 'zero writes')
    assert.equal(await readFile(STORE_FILE, 'utf8'), beforeStore, 'store bytes unchanged')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

test('N2: resolved identity → no identity hint (no false positive); legacy hint and go round unchanged', async () => {
  await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
  let inst
  try {
    inst = makeInstance({
      identity: { profileContext: { name: 'OK', dir: '/profiles/OK' } },
      initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) },
    })

    const report = await inst.invoke('')
    assert.match(report.text, /opencode-go: skipped/, report.text)
    assert.doesNotMatch(report.text, /profile 身份不可用/, 'must not report an identity failure when one is available')
    assert.match(report.text, /检测到未迁移配置，已跳过写入/, 'normal legacy hint is preserved with identity')
    assert.ok(
      !inst.logs.some((line) => line.includes('non-strict status refresh degraded')),
      'no identity-degradation warning with identity',
    )

    // Regression: after a normal apply, the go command still succeeds (N1 did
    // not misclassify success rounds as errors).
    const plan = parsePlan((await inst.invoke('migrate plan')).text)
    assert.equal((await inst.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)).kind, 'success')
    const go = await inst.invoke('go')
    assert.equal(go.kind, 'success', go.text)
    assert.ok(inst.fetchCalls.length > 0, 'go round fetched the official listing')
    assert.ok(inst.settings.mutations.length > 0, 'go round wrote settings')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. D6: distinct status labels for unclaimable migration records
// ---------------------------------------------------------------------------

const IDENTITY_A = { profileContext: { name: 'A', dir: '/profiles/A' } }
const APPLIED_IDENTITY = fingerprintSection({ 'opencode-go': structuredClone(LEGACY_CHAT) })

/** Structured status over the real file-backed store (same path as the command). */
const structuredStatus = async (settings) => migrationStatusReport({
  settings,
  migrationStore: createFileMigrationStateStore(loadModelsStore(STORE_FILE), 'A'),
  keyFingerprint: KEY_FP,
  routes: {},
  now: Date.now(),
}, { caller: 'go', goEnabled: true })

test('D6: foreign-profile record → distinct label, writeAuthority=none, zero writes', async () => {
  await resetStore({
    'opencode-go': structuredClone(LEGACY_CHAT),
    [`A#${GO_MIGRATION_STORE_KEY}`]: { profileKey: 'B', appliedIdentity: APPLIED_IDENTITY },
  })
  let inst
  try {
    inst = makeInstance({ identity: IDENTITY_A, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const before = await readFile(STORE_FILE, 'utf8')
    const text = (await inst.invoke('migrate status')).text
    assert.match(text, /status: foreign-profile/, text)
    assert.match(text, /state=foreign-profile/)
    assert.match(text, /owner=none/)
    assert.match(text, /writeAuthority=none/)
    assert.match(text, /profileKey=B/)

    const report = await structuredStatus(inst.settings)
    assert.equal(report.overall, 'foreign-profile')
    assert.equal(report.writeAuthority, 'none')
    assert.deepEqual(report.unclaimed.map((u) => u.kind), ['foreign-profile'])
    assert.ok(report.routes.every((r) => r.owner === 'none' && r.decision === 'skip'), 'every go route gated')
    assert.equal(inst.settings.mutations.length, 0, 'zero settings writes')
    assert.equal(await readFile(STORE_FILE, 'utf8'), before, 'store bytes unchanged')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

test('D6: legacy unscoped record → distinct label, writeAuthority=none, zero writes', async () => {
  await resetStore({
    'opencode-go': structuredClone(LEGACY_CHAT),
    [GO_MIGRATION_STORE_KEY]: { appliedIdentity: APPLIED_IDENTITY }, // no profileKey = old format
  })
  let inst
  try {
    inst = makeInstance({ identity: IDENTITY_A, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const before = await readFile(STORE_FILE, 'utf8')
    const text = (await inst.invoke('migrate status')).text
    assert.match(text, /status: legacy-store/, text)
    assert.match(text, /state=legacy-store/)
    assert.match(text, /owner=none/)
    assert.match(text, /writeAuthority=none/)

    const report = await structuredStatus(inst.settings)
    assert.equal(report.overall, 'legacy-store')
    assert.equal(report.writeAuthority, 'none')
    assert.deepEqual(report.unclaimed.map((u) => u.kind), ['legacy-store'])
    assert.equal(report.unclaimed[0].key, GO_MIGRATION_STORE_KEY)
    assert.ok(report.routes.every((r) => r.owner === 'none' && r.decision === 'skip'))
    assert.equal(inst.settings.mutations.length, 0, 'zero settings writes')
    assert.equal(await readFile(STORE_FILE, 'utf8'), before, 'store bytes unchanged')

    // No rollback deletion either: the legacy record survives a status read.
    assert.deepEqual(await createFileMigrationStateStore(loadModelsStore(STORE_FILE), 'A').read(), undefined)
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

test('D6: no record stays legacy-inline/absent; normal applied unchanged', async () => {
  let inst
  try {
    // No record, section present → legacy-inline (NOT legacy-store/absent).
    await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
    inst = makeInstance({ identity: IDENTITY_A, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const legacyText = (await inst.invoke('migrate status')).text
    assert.match(legacyText, /status: legacy-inline/, legacyText)
    assert.doesNotMatch(legacyText, /status: (foreign-profile|legacy-store)/)
    const legacyReport = await structuredStatus(inst.settings)
    assert.equal(legacyReport.overall, 'legacy-inline')
    assert.deepEqual(legacyReport.unclaimed, [])
    assert.ok(legacyReport.routes.every((r) => r.owner === 'none'))
    inst.dispose()
    inst = undefined

    // No record, no section → absent (gate is open by design, unchanged).
    await resetStore({})
    inst = makeInstance({ identity: IDENTITY_A })
    const absentText = (await inst.invoke('migrate status')).text
    assert.match(absentText, /status: absent/, absentText)
    const absentReport = await structuredStatus(inst.settings)
    assert.equal(absentReport.overall, 'absent')
    assert.deepEqual(absentReport.unclaimed, [])
    assert.equal(absentReport.writeAuthority, 'go')
    inst.dispose()
    inst = undefined

    // A normal apply still yields the applied label + go authority.
    await resetStore({ 'opencode-go': structuredClone(LEGACY_CHAT) })
    inst = makeInstance({ identity: IDENTITY_A, initialRoutes: { 'opencode-go': structuredClone(LEGACY_CHAT) } })
    const plan = parsePlan((await inst.invoke('migrate plan')).text)
    assert.equal((await inst.invoke(`migrate apply --plan ${plan.planHash} --confirm ${plan.confirmCode} --ack-managed`)).kind, 'success')
    const appliedText = (await inst.invoke('migrate status')).text
    assert.match(appliedText, /status: applied/, appliedText)
    assert.match(appliedText, /owner=go/)
    const appliedReport = await structuredStatus(inst.settings)
    assert.equal(appliedReport.overall, 'applied')
    assert.equal(appliedReport.writeAuthority, 'go')
    assert.deepEqual(appliedReport.unclaimed, [], 'our own stamped record is not unclaimed')
  } finally {
    inst?.dispose()
    await rm(LOCK_PATH, { force: true })
  }
})

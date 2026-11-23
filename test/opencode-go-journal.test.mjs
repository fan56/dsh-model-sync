// O1/C2: write-ahead journal + next-round reconciliation. All seams are in
// memory / temp dirs — no network, no real ~/.dsh, no timers. Every scenario
// below drives two or more real `runGoSyncRound` calls through the same
// settings + ledger + journal + migration-record state, so assertions are about
// converged behavior, not about a function having been called.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createFileJournalStore,
  formatReconcileSummary,
  goJournalKey,
  isJournalKey,
  journalContentHash,
  parseJournal,
  reconcileJournals,
} from '../lib/opencode-go-journal.js'
import { isUnscopedStoreKey } from '../lib/opencode-go-profile.js'
import { goOwnershipKey, mapGoModelToProfile, profileHash } from '../lib/opencode-go-planner.js'
import { fingerprintKey, parseGoModelsPayload } from '../lib/opencode-go-source.js'
import { runGoSyncRound } from '../lib/opencode-go-sync.js'
import {
  appliedFingerprintOf,
  fingerprintGoIdentity,
  migrationStatusOf,
  readGoProviderSections,
} from '../lib/opencode-go-migration.js'
import {
  applyMigration,
  buildMigrationPlan,
  rollbackMigration,
} from '../lib/opencode-go-migrate.js'
import { GO_SLOT_ROUTES } from '../lib/opencode-go-grouping.js'

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

const PROFILE = 'c2-profile'
const KEY = 'test-go-key'
const FP = fingerprintKey(KEY)
const ROUTES = { ...GO_SLOT_ROUTES }
const ROUTE_IDS = Object.values(ROUTES)
const CHAT = 'https://opencode.ai/inference/go/openai/v1'
const MSG = 'https://opencode.ai/inference/go/anthropic/v1'
const RESP = 'https://opencode.ai/inference/go/openai/v1'

const model = (id, overrides = {}) => ({
  id, name: id,
  api: { 'chat-completions': { base_url: CHAT } },
  inputModalities: ['text'],
  ...overrides,
})
const official = (entries) => ({ object: 'list', data: entries })
const initialPayload = official([
  model('hy4-flash-free'),
  model('qwen4-max', { api: { messages: { base_url: MSG } } }),
  model('grok-4.7', { api: { responses: { base_url: RESP } } }),
])
const chatModel = (settings) => settings.state.get('opencode-go')?.models ?? []

// ---------------------------------------------------------------------------
// Fixtures + memory seams
// ---------------------------------------------------------------------------

function mockSettings(initialRoutes = {}) {
  const state = new Map(Object.entries(initialRoutes).map(([route, data]) => [route, structuredClone(data)]))
  const mutations = []
  let revision = 1
  return {
    state, mutations,
    describe: () => [{
      ns: 'llm-pi-ai', revision,
      user: { providers: Object.fromEntries([...state].map(([route, data]) => [route, structuredClone(data)])) },
    }],
    get revision() { return revision },
    userEdit(route, models) {
      state.set(route, { ...(state.get(route) ?? {}), models: structuredClone(models) })
      revision += 1
      return revision
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'llm-pi-ai')
      if (expectedRevision !== revision) {
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
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

function memoryOwnership(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    async read(key) { return map.get(key) },
    async write(key, entry) { map.set(key, structuredClone(entry)) },
    async delete(key) { map.delete(key) },
  }
}

function memoryJournal() {
  const map = new Map()
  return {
    map,
    async read(key) {
      const raw = map.get(key)
      if (raw === undefined) return {}
      if (typeof raw === 'string') {
        try {
          const parsed = parseJournal(JSON.parse(raw))
          return parsed.journal !== undefined ? { journal: parsed.journal } : { parseError: parsed.error }
        } catch (err) { return { parseError: `bad JSON: ${String(err)}` } }
      }
      const parsed = parseJournal(raw)
      return parsed.journal !== undefined ? { journal: parsed.journal } : { parseError: parsed.error }
    },
    async write(key, journal) { map.set(key, structuredClone(journal)) },
    async delete(key) { map.delete(key) },
    async list(profileKey) { return [...map.keys()].filter((k) => isJournalKey(k, profileKey)) },
    async clearProfile(profileKey) {
      let n = 0
      for (const k of await this.list(profileKey)) { map.delete(k); n += 1 }
      return n
    },
    rawSet(key, value) { map.set(key, value) },
    keys() { return [...map.keys()] },
  }
}

function memoryMigration(initial) {
  let record = initial === undefined ? undefined : structuredClone(initial)
  return {
    get() { return record },
    async read() { return record === undefined ? undefined : structuredClone(record) },
    async write(next) { record = structuredClone(next) },
    set(next) { record = structuredClone(next) },
  }
}

/** An applied migration record whose identity matches the given settings. */
function appliedRecord(settings, extra = {}) {
  const sections = readGoProviderSections(settings.describe()[0], ROUTE_IDS)
  // Only routes that already exist are part of the identity set — routes a sync
  // round creates later must not flip the gate to drifted.
  const appliedIdentityRoutes = Object.keys(sections ?? {})
  const identity = fingerprintGoIdentity(sections, appliedIdentityRoutes)
  return {
    planHash: 'plan-applied', appliedFingerprint: 'fp',
    appliedIdentity: identity, appliedIdentityRoutes,
    appliedManagedIds: {}, ...extra,
  }
}

/** Mirror of index.ts's onOwnWrite: re-persist the applied fingerprint. */
function recordPersister(migrationStore, settings, opts = {}) {
  return async (route, managedIds) => {
    if (opts.throws === true) throw new Error('migration record store full (seam)')
    const prior = await migrationStore.read()
    const desc = settings.describe().find((d) => d.ns === 'llm-pi-ai')
    const sections = readGoProviderSections(desc, ROUTE_IDS)
    const appliedIdentityRoutes = prior?.appliedIdentityRoutes ?? Object.keys(sections ?? {})
    const identity = fingerprintGoIdentity(sections, appliedIdentityRoutes)
    const appliedManagedIds = { ...(prior?.appliedManagedIds ?? {}), [route]: [...managedIds].sort() }
    await migrationStore.write({
      ...(prior ?? {}),
      appliedIdentity: identity,
      appliedIdentityRoutes,
      appliedManagedIds,
      appliedFingerprint: appliedFingerprintOf(identity, appliedManagedIds),
    })
  }
}

/** A harness that persists all four stores across rounds. */
function makeHarness({
  initialRoutes = {},
  payload = initialPayload,
  ledgerSeed = {},
  migrationRecord,
  fault = {},
} = {}) {
  const settings = mockSettings(initialRoutes)
  const ownershipBase = memoryOwnership(ledgerSeed)
  const ownershipStore = {
    async read(key) { return ownershipBase.read(key) },
    async write(key, entry) {
      if (fault.ledgerWrite === true) throw new Error('ledger full (seam)')
      return ownershipBase.write(key, entry)
    },
    async delete(key) {
      if (fault.ledgerWrite === true) throw new Error('ledger full (seam)')
      return ownershipBase.delete(key)
    },
  }
  const journalStore = memoryJournal()
  const migrationStore = memoryMigration(migrationRecord)
  const onOwnWrite = recordPersister(migrationStore, settings, fault)
  const status = async () => {
    const desc = settings.describe().find((d) => d.ns === 'llm-pi-ai')
    return migrationStatusOf(desc, await migrationStore.read(), ROUTE_IDS)
  }
  const roundWithStatus = async (overrides = {}) => runGoSyncRound({
    settings,
    ownershipStore,
    logger: { info() {}, warn() {}, debug() {} },
    config: {
      enabled: true, ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      routes: ROUTES, pinnedModels: [], confirmRemovals: 2, adoptExisting: false,
    },
    apiKey: KEY,
    observedAt: 0,
    migration: await status(),
    reloadMigration: status,
    fetchImpl: async () => {
      if (overrides.onFetch !== undefined) await overrides.onFetch()
      return { status: 200, json: async () => structuredClone(overrides.payload ?? payload) }
    },
    journalStore,
    profileKey: PROFILE,
    keyFingerprint: FP,
    onOwnWrite,
    ...overrides,
  })
  const rollback = (planHash) => rollbackMigration({ planHash }, {
    settings, ownershipStore: ownershipBase, migrationStore,
    logger: { info() {}, warn() {}, debug() {} }, entries: [], routes: ROUTES,
    ref: 'OPENCODE_GO_API_KEY', keyFingerprint: FP, now: 0,
    journalStore, profileKey: PROFILE,
  })
  return {
    settings, ownershipStore, ownershipBase, journalStore, migrationStore, fault,
    status, round: roundWithStatus, rollback,
  }
}

const idsOf = (settings, route) => (settings.state.get(route)?.models ?? []).map((m) => m.id)

// ---------------------------------------------------------------------------
// 1. Key shape + parse + hash (unit)
// ---------------------------------------------------------------------------

await checkAsync('C2 key: 4-part journal key is NOT an unscoped legacy slot', () => {
  const key = goJournalKey(PROFILE, 'opencode-go', FP)
  assert.equal(key, `${PROFILE}#opencode-go#${FP}#journal`)
  assert.equal(key.split('#').length, 4)
  assert.equal(isUnscopedStoreKey(key), false, 'isUnscopedStoreKey only classifies 2-part keys')
  assert.equal(isJournalKey(key, PROFILE), true)
  assert.equal(isJournalKey(key, 'other-profile'), false)
  assert.equal(isJournalKey(`${PROFILE}#opencode-go#${FP}`, PROFILE), false)
})

await checkAsync('C2 content hash: stable across key order and array order', () => {
  const a = mapGoModelToProfile(model('hy4-flash-free'))
  const b = mapGoModelToProfile(model('qwen4-max', { api: { messages: { base_url: MSG } } }))
  assert.equal(journalContentHash([a, b]), journalContentHash([b, a]))
  assert.notEqual(journalContentHash([a, b]), journalContentHash([a]))
  assert.notEqual(journalContentHash([a]), journalContentHash([{ ...a, name: 'renamed' }]))
})

await checkAsync('C2 parse: strict validation rejects corrupt/mistyped journals', () => {
  const good = {
    version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
    modelIds: ['hy4-flash-free'], contentHash: 'abc', unset: false,
    entry: { managed: { 'hy4-flash-free': { hash: 'h' } } }, at: 1,
  }
  assert.ok(parseJournal(good).journal !== undefined)
  assert.ok(parseJournal({ ...good, version: 99 }).error !== undefined)
  assert.ok(parseJournal({ ...good, profileKey: '' }).error !== undefined)
  assert.ok(parseJournal({ ...good, modelIds: [1] }).error !== undefined)
  assert.ok(parseJournal({ ...good, unset: false, entry: undefined }).error !== undefined)
  assert.ok(parseJournal('not an object').error !== undefined)
})

await checkAsync('C2 file store: atomic write/read/list/clear + parse failure degrades', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadModelsStore, resetModelsStoreCache } = await import('../lib/remote-catalog.js')
  const dir = await mkdtemp(join(tmpdir(), 'c2-journal-store-'))
  try {
    const accessor = loadModelsStore(join(dir, 'models-store.json'))
    const store = createFileJournalStore(accessor)
    const key = goJournalKey(PROFILE, 'opencode-go', FP)
    const journal = {
      version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
      modelIds: ['x'], contentHash: 'h', unset: false,
      entry: { managed: { x: { hash: 'h' } } }, at: 7,
    }
    await store.write(key, journal)
    assert.deepEqual((await store.read(key)).journal, journal)
    assert.deepEqual(await store.list(PROFILE), [key])
    await store.write(goJournalKey(PROFILE, 'opencode-go-msg', FP), { ...journal, route: 'opencode-go-msg' })
    assert.equal(await store.clearProfile(PROFILE), 2)
    assert.deepEqual(await store.list(PROFILE), [])
    await accessor.writeRaw(key, { version: 1 })
    assert.ok((await store.read(key)).parseError !== undefined)
  } finally {
    resetModelsStoreCache()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. S1 — absent first round (one route writes; gate closes), then reconcile
// ---------------------------------------------------------------------------

await checkAsync('S1: absent first round journals the one write; next round reconciles ledger+record, reopens gate, deletes journal', async () => {
  const h = await makeHarness({ fault: { ledgerWrite: true, throws: true } })
  const first = await h.round()
  assert.equal(first.reason, 'write-failed', first.text)
  // With no persisted record the second gate closes after chat writes: the
  // real S1 shape is one landed mutate, not three.
  assert.equal(first.write.failedRoutes.length, 1)
  assert.equal(first.write.settingsLandedRoutes.length, 1)
  assert.equal(h.migrationStore.get(), undefined, 'record never persisted on round 1')
  const journalKeys = await h.journalStore.list(PROFILE)
  assert.equal(journalKeys.length, 1, `chat journal survives; keys=${journalKeys.join(',')}`)
  const j = (await h.journalStore.read(journalKeys[0])).journal
  assert.equal(j.route, 'opencode-go')
  assert.equal(j.profileKey, PROFILE)
  assert.equal(j.keyFingerprint, FP)
  assert.equal(j.contentHash, journalContentHash(chatModel(h.settings)))
  assert.deepEqual(j.modelIds, Object.keys(j.entry.managed).sort())

  h.fault.ledgerWrite = false
  h.fault.throws = false
  assert.equal((await h.status()).state, 'legacy-inline', 'premise: gate would be closed')
  const second = await h.round()
  assert.equal(second.reason, 'completed', `gate must be reopened by reconciliation: ${second.text}`)
  assert.notEqual(second.reason, 'migration-gate')
  assert.equal(second.journal.reconciled.length, 1, 'the single journal reconciled')
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'journal removed after convergence')
  assert.ok((await h.migrationStore.read())?.appliedIdentity !== undefined, 'migration record re-persisted')
  assert.equal((await h.status()).state, 'applied', 'gate is open, not permanently closed')
  const chat = await h.ownershipBase.read(goOwnershipKey('opencode-go', FP))
  assert.ok(chat?.managed['hy4-flash-free'], 'ledger re-committed with the managed id')
  assert.ok(idsOf(h.settings, 'opencode-go-msg').includes('qwen4-max'))
  assert.ok(idsOf(h.settings, 'opencode-go-resp').includes('grok-4.7'))
})

// ---------------------------------------------------------------------------
// 3. S1b — record write only fails → journal kept → next round re-persists it
// ---------------------------------------------------------------------------

await checkAsync('S1b: ledger landed but record failed → journal kept → next round re-persists record and reopens gate', async () => {
  const h = await makeHarness({ fault: { throws: true } })
  const first = await h.round()
  assert.equal(first.reason, 'completed', 'record gap is not a failed route')
  assert.match(first.text, /settings-written-unaccounted/)
  assert.match(first.text, /migration record could not be persisted/)
  assert.equal(h.migrationStore.get(), undefined, 'record write failed on round 1')
  assert.equal((await h.journalStore.list(PROFILE)).length, 1, 'journal kept after record failure')
  assert.ok(await h.ownershipBase.read(goOwnershipKey('opencode-go', FP)), 'ledger did land')

  h.fault.throws = false
  const second = await h.round()
  assert.equal(second.journal.reconciled.length, 1)
  assert.deepEqual(await h.journalStore.list(PROFILE), [])
  assert.ok((await h.migrationStore.read())?.appliedIdentity !== undefined)
  assert.equal((await h.status()).state, 'applied')
})

// ---------------------------------------------------------------------------
// 4. K1 — seam-simulated crash between mutate and ledger (already migrated)
// ---------------------------------------------------------------------------

await checkAsync('K1: mutate-then-ledger interruption converges next round; model becomes managed and refreshes', async () => {
  const seed = mockSettings()
  const h = await makeHarness({ migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true } })
  const first = await h.round()
  assert.equal(first.reason, 'write-failed')
  assert.equal(first.write.failedRoutes.length, 3, first.text)
  assert.match(first.text, /settings-written-unaccounted/)
  assert.equal((await h.journalStore.list(PROFILE)).length, 3)

  h.fault.ledgerWrite = false
  const second = await h.round()
  assert.equal(second.reason, 'completed')
  assert.equal(second.journal.reconciled.length, 3)
  assert.deepEqual(await h.journalStore.list(PROFILE), [])
  const chat = await h.ownershipBase.read(goOwnershipKey('opencode-go', FP))
  assert.ok(chat?.managed['hy4-flash-free'], 'model is now ledger-managed (not user-owned)')
  const third = await h.round()
  assert.equal(third.reason, 'completed')
  assert.ok(third.write.report.some((e) => e.code === 'overwrote-managed'), 'managed model refreshes normally')
})

// ---------------------------------------------------------------------------
// 5. S2 — already migrated + new model + ledger failure → reconcile → deletable
// ---------------------------------------------------------------------------

await checkAsync('S2: new model written with ledger failure becomes managed after reconcile and is deletable', async () => {
  const seed = mockSettings()
  const withNew = official([...initialPayload.data, model('new-model')])
  const h = await makeHarness({
    payload: withNew, migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true },
  })
  const first = await h.round()
  assert.equal(first.reason, 'write-failed')
  assert.ok(idsOf(h.settings, 'opencode-go').includes('new-model'), 'new model was written to settings')
  assert.equal(first.journal.reconciled.length, 0, 'nothing reconciled while the store still fails')

  h.fault.ledgerWrite = false
  const second = await h.round()
  assert.equal(second.journal.reconciled.length, 3)
  const chat = await h.ownershipBase.read(goOwnershipKey('opencode-go', FP))
  assert.ok(chat.managed['new-model'], 'new model is now in the ledger → plugin-managed')

  const withoutNew = official(initialPayload.data)
  const third = await h.round({ payload: withoutNew })
  assert.ok(idsOf(h.settings, 'opencode-go').includes('new-model'), 'round 1 of 2: still present')
  const fourth = await h.round({ payload: withoutNew })
  assert.equal(idsOf(h.settings, 'opencode-go').includes('new-model'), false, 'round 2 of 2: deleted')
})

// ---------------------------------------------------------------------------
// 6. S3 — refresh + ledger failure → reconcile → rollback hash check passes
// ---------------------------------------------------------------------------

await checkAsync('S3: refreshed hash re-committed by reconcile → rollback no longer refused with hash-mismatch', async () => {
  const oldProfile = mapGoModelToProfile(model('hy4-flash-free'))
  const initialRoutes = { 'opencode-go': { models: [oldProfile] } }
  const record = appliedRecord(mockSettings(initialRoutes), {
    planHash: 'plan-s3',
    appliedManagedIds: { 'opencode-go': ['hy4-flash-free'] },
    backup: { planHash: 'plan-s3', capturedAt: 0, routes: {} },
  })
  const ledgerSeed = {
    [goOwnershipKey('opencode-go', FP)]: {
      managed: { 'hy4-flash-free': { hash: profileHash(oldProfile) } },
      preManagedSection: null,
    },
  }
  const refreshed = official([model('hy4-flash-free', { name: 'renamed-by-upstream' })])
  const h = await makeHarness({
    initialRoutes, payload: refreshed, ledgerSeed, migrationRecord: record, fault: { ledgerWrite: true },
  })

  const first = await h.round()
  assert.equal(first.reason, 'write-failed')
  assert.equal((await h.journalStore.list(PROFILE)).length, 1, 'only chat had a settings write')

  const preRollback = await h.rollback('plan-s3')
  assert.equal(preRollback.ok, false)
  assert.match(preRollback.text, /hash-mismatch/, 'premise: stale ledger hash refuses rollback')

  h.fault.ledgerWrite = false
  const second = await h.round()
  assert.equal(second.journal.reconciled.length, 1)
  const currentProfile = chatModel(h.settings)[0]
  const chat = await h.ownershipBase.read(goOwnershipKey('opencode-go', FP))
  assert.equal(chat.managed['hy4-flash-free'].hash, profileHash(currentProfile), 'reconciled hash == current settings hash')

  const postRollback = await h.rollback('plan-s3')
  assert.equal(postRollback.ok, true, `rollback must pass the hash check after reconcile: ${postRollback.text}`)
  assert.equal(postRollback.reason, 'rolled-back')
})

// ---------------------------------------------------------------------------
// 7. Stale / orphan / parse-failure journals — never block, never overwrite
// ---------------------------------------------------------------------------

await checkAsync('stale journal: user-edited current value → journal discarded, user value untouched', async () => {
  const seed = mockSettings()
  const h = await makeHarness({ migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true } })
  await h.round()
  assert.equal((await h.journalStore.list(PROFILE)).length, 3)
  const userModel = { id: 'hand-written', name: 'user' }
  h.settings.userEdit('opencode-go', [userModel])
  h.fault.ledgerWrite = false
  const second = await h.round()
  assert.equal(second.journal.discarded.length, 1, 'chat journal discarded on hash mismatch')
  assert.ok(second.journal.notices.some((n) => n.code === 'journal-stale'))
  assert.ok(idsOf(h.settings, 'opencode-go').includes('hand-written'), 'user value kept verbatim')
  const chat = await h.ownershipBase.read(goOwnershipKey('opencode-go', FP))
  assert.equal(chat?.managed['hand-written'], undefined, 'user-added model never claimed by the stale journal')
})

await checkAsync('orphan journal: profile/key mismatch is discarded, never replayed', async () => {
  const h = await makeHarness()
  await h.round()
  h.journalStore.rawSet(goJournalKey(PROFILE, 'opencode-go', FP), {
    version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: 'other-key',
    modelIds: ['x'], contentHash: 'whatever', unset: false,
    entry: { managed: { x: { hash: 'h' } } }, at: 1,
  })
  const result = await h.round()
  assert.ok(result.journal.notices.some((n) => n.code === 'journal-orphan'), result.text)
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'orphan removed')
})

await checkAsync('unparseable journal: recognized warning, round not blocked, slot cleaned', async () => {
  const h = await makeHarness()
  await h.round()
  h.journalStore.rawSet(goJournalKey(PROFILE, 'opencode-go', FP), '{not-json')
  const result = await h.round()
  assert.ok(result.journal.notices.some((n) => n.code === 'journal-unparseable'), result.text)
  assert.match(result.text, /journal-unparseable/)
  assert.equal(result.reason, 'completed', 'round still completes')
  assert.deepEqual(await h.journalStore.list(PROFILE), [])
})

await checkAsync('reconcile store failure keeps the journal for a later retry', async () => {
  const seed = mockSettings()
  const h = await makeHarness({ migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true } })
  await h.round()
  assert.equal((await h.journalStore.list(PROFILE)).length, 3)
  const result = await reconcileJournals({
    journalStore: h.journalStore,
    ownershipStore: h.ownershipStore,
    settings: h.settings,
    profileKey: PROFILE, keyFingerprint: FP,
    logger: { info() {}, warn() {}, debug() {} },
  })
  assert.equal(result.reconciled.length, 0)
  assert.ok(result.notices.some((n) => n.code === 'journal-reconcile-failed'))
  assert.equal((await h.journalStore.list(PROFILE)).length, 3, 'journals kept on reconcile failure')
})

// ---------------------------------------------------------------------------
// 7a. N-1: raw-type corrupted journal slots (warn + clean), non-journal keys safe
// ---------------------------------------------------------------------------

await checkAsync('N-1: primitive/null journal slots warn + are cleaned, reconciliation continues, non-journal keys untouched', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadModelsStore, resetModelsStoreCache } = await import('../lib/remote-catalog.js')
  const dir = await mkdtemp(join(tmpdir(), 'c2-raw-journal-'))
  try {
    const accessor = loadModelsStore(join(dir, 'models-store.json'))
    const store = createFileJournalStore(accessor)
    const settings = mockSettings({ 'opencode-go': { models: [model('keep-me')] } })
    const validKey = goJournalKey(PROFILE, 'opencode-go', FP)
    await accessor.writeRaw(validKey, {
      version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
      modelIds: ['keep-me'], contentHash: journalContentHash([model('keep-me')]),
      unset: false, entry: { managed: { 'keep-me': { hash: 'h' } } }, at: 1,
    })
    const corrupted = [
      goJournalKey(PROFILE, 'opencode-go-msg', FP),
      goJournalKey(PROFILE, 'opencode-go-resp', FP),
      goJournalKey(PROFILE, 'opencode-go-extra', FP),
    ]
    await accessor.writeRaw(corrupted[0], 'not-a-journal')
    await accessor.writeRaw(corrupted[1], 42)
    await accessor.writeRaw(corrupted[2], null)
    // Non-journal keys with primitive values must NEVER be touched.
    const foreignKey = goJournalKey('other-profile', 'opencode-go', FP)
    await accessor.writeRaw(foreignKey, null)
    await accessor.writeRaw('plain-non-journal-key', 'keep-me')

    const ledger = memoryOwnership()
    const recorded = []
    const result = await reconcileJournals({
      journalStore: store, ownershipStore: ledger, settings,
      profileKey: PROFILE, keyFingerprint: FP,
      logger: { info() {}, warn() {}, debug() {} },
      onRecord: (route, ids) => { recorded.push([route, ids]) },
    })

    const rawNotices = result.notices.filter((n) => n.code === 'journal-unparseable' && n.rawTypeCorrupt === true)
    assert.equal(rawNotices.length, 3, result.text)
    assert.match(rawNotices[0].message, /raw-type corruption/, 'the raw-type case is recognizable')
    assert.ok(result.notices.every((n) => n.level !== 'error'))
    assert.deepEqual(result.reconciled, ['opencode-go'], 'a healthy slot still reconciles in the same round')
    assert.equal(result.discarded.length, 3)
    for (const key of corrupted) {
      assert.equal(await accessor.readRaw(key), undefined, `corrupt slot ${key} was cleaned`)
    }
    assert.deepEqual(recorded, [['opencode-go', ['keep-me']]])
    assert.ok((await ledger.read(goOwnershipKey('opencode-go', FP)))?.managed['keep-me'] !== undefined)
    assert.equal(await accessor.readRaw(foreignKey), null, 'another profile\'s slot is not deleted')
    assert.equal(await accessor.readRaw('plain-non-journal-key'), 'keep-me', 'non-journal key is not deleted')
  } finally {
    resetModelsStoreCache()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7b. N-2: store enumeration failure surfaces journal-list-failed (not silent)
// ---------------------------------------------------------------------------

await checkAsync('N-2: list failure surfaces journal-list-failed, skips reconciliation visibly, recovers next round', async () => {
  const seed = mockSettings()
  const h = await makeHarness({ migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true } })
  await h.round()
  assert.equal((await h.journalStore.list(PROFILE)).length, 3, 'premise: journals survive a ledger failure')
  const inner = h.journalStore
  let failList = true
  const failingStore = {
    ...inner,
    async list(profileKey) {
      if (failList) throw new Error('models-store.json unreadable (seam)')
      return inner.list(profileKey)
    },
  }
  let recorded = 0
  const skipped = await reconcileJournals({
    journalStore: failingStore, ownershipStore: h.ownershipStore, settings: h.settings,
    profileKey: PROFILE, keyFingerprint: FP,
    logger: { info() {}, warn() {}, debug() {} },
    onRecord: () => { recorded += 1 },
  })
  assert.equal(skipped.reconciled.length, 0)
  assert.ok(skipped.notices.some((n) => n.code === 'journal-list-failed'), 'enumeration failure is a recognizable notice')
  assert.match(skipped.lines.join('\n'), /journal-list-failed/, 'notice is visible in the round lines')
  assert.equal(recorded, 0, 'no ledger/record re-commit when enumeration failed')
  assert.equal((await h.journalStore.list(PROFILE)).length, 3, 'journals kept, not treated as "no journal"')

  // The notice must also be visible through the real round/report surface.
  const gated = await h.round({ journalStore: failingStore })
  assert.ok(gated.journal?.notices.some((n) => n.code === 'journal-list-failed'), gated.text)
  assert.match(gated.text, /journal-list-failed/, gated.text)

  failList = false
  h.fault.ledgerWrite = false
  const recovered = await h.round({ journalStore: failingStore })
  assert.equal(recovered.reason, 'completed', recovered.text)
  assert.equal(recovered.journal.reconciled.length, 3, 'recovery converges the kept journals')
  assert.deepEqual(await h.journalStore.list(PROFILE), [])
})

await checkAsync('N-2 file store: an unreadable models-store.json makes list() throw, not return []', async () => {
  const { mkdtemp, rm, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { loadModelsStore, resetModelsStoreCache } = await import('../lib/remote-catalog.js')
  const dir = await mkdtemp(join(tmpdir(), 'c2-list-fail-'))
  try {
    const file = join(dir, 'models-store.json')
    const accessor = loadModelsStore(file)
    const store = createFileJournalStore(accessor)
    const key = goJournalKey(PROFILE, 'opencode-go', FP)
    await accessor.writeRaw(key, {
      version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
      modelIds: ['x'], contentHash: 'h', unset: false,
      entry: { managed: { x: { hash: 'h' } } }, at: 1,
    })
    assert.deepEqual(await store.list(PROFILE), [key], 'healthy store enumerates the journal')
    const goodBytes = await readFile(file, 'utf8')

    await writeFile(file, '{not-json', 'utf8')
    await assert.rejects(() => store.list(PROFILE), 'enumeration failure is no longer swallowed')
    const result = await reconcileJournals({
      journalStore: store, ownershipStore: memoryOwnership(), settings: mockSettings(),
      profileKey: PROFILE, keyFingerprint: FP, logger: { info() {}, warn() {}, debug() {} },
    })
    assert.ok(result.notices.some((n) => n.code === 'journal-list-failed'), 'the real file-store path surfaces the notice')
    assert.equal(result.reconciled.length, 0)

    await writeFile(file, goodBytes, 'utf8')
    assert.deepEqual(await store.list(PROFILE), [key], 'recovery restores enumeration')
  } finally {
    resetModelsStoreCache()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7c. Journal write failure is fail-closed: zero settings writes, then converges
// ---------------------------------------------------------------------------

await checkAsync('journal write failure: zero settings/ledger/fingerprint writes, journal-unavailable reason, next round converges', async () => {
  const h = await makeHarness()
  const inner = h.journalStore
  let failWrite = true
  const failingStore = {
    ...inner,
    async write(key, journal) {
      if (failWrite) throw new Error('journal store lock timeout (seam)')
      return inner.write(key, journal)
    },
  }
  const first = await h.round({ journalStore: failingStore })
  assert.equal(first.reason, 'write-failed', first.text)
  assert.equal(first.write.settingsLandedRoutes.length, 0, 'no settings mutate landed')
  assert.equal(first.write.writtenRoutes.length, 0)
  assert.deepEqual(first.write.failedRoutes.map((f) => f.reason).sort(),
    ['journal-unavailable', 'journal-unavailable', 'journal-unavailable'])
  assert.ok(first.write.report.some((e) => e.code === 'journal-unavailable'), first.text)
  assert.match(first.text, /journal-unavailable/)
  assert.equal(h.settings.mutations.length, 0, 'zero settings writes')
  assert.equal(h.ownershipBase.map.size, 0, 'zero ledger writes')
  assert.equal(h.migrationStore.get(), undefined, 'zero fingerprint/record writes')
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'no partially written journal')

  failWrite = false
  const second = await h.round({ journalStore: failingStore })
  assert.equal(second.reason, 'completed', second.text)
  assert.equal(second.write.writtenRoutes.length, 3)
  assert.equal(h.settings.mutations.length, 3, 'journal recovery unblocks the normal write path')
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'fully accounted write closes its journal')
  assert.ok((await h.migrationStore.read())?.appliedIdentity !== undefined)
})

// ---------------------------------------------------------------------------
// 8. Healthy path: journals written and cleaned; no extra settings writes
// ---------------------------------------------------------------------------

await checkAsync('healthy path: three routes write, journals removed, second round idempotent', async () => {
  const h = await makeHarness()
  const first = await h.round()
  assert.equal(first.reason, 'completed')
  assert.deepEqual(first.write.writtenRoutes.sort(), ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
  assert.equal(h.settings.mutations.length, 3)
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'no journal left on a fully accounted write')
  assert.ok((await h.migrationStore.read())?.appliedIdentity !== undefined)

  const second = await h.round()
  assert.equal(second.reason, 'completed')
  assert.deepEqual(second.write.writtenRoutes, [], 'second round is a no-change round')
  assert.equal(h.settings.mutations.length, 3, 'no extra settings writes')
  assert.deepEqual(await h.journalStore.list(PROFILE), [])
  assert.equal(formatReconcileSummary({ reconciled: [], discarded: [], notices: [], lines: [] }), '')
})

// ---------------------------------------------------------------------------
// 9. Migrate apply/rollback clear this profile's journals
// ---------------------------------------------------------------------------

await checkAsync('migrate rollback clears the profile journal after undoing settings', async () => {
  const seed = mockSettings()
  const h = await makeHarness({ migrationRecord: appliedRecord(seed), fault: { ledgerWrite: true } })
  await h.round()
  assert.equal((await h.journalStore.list(PROFILE)).length, 3, 'premise: journals exist')
  h.migrationStore.set({
    planHash: 'plan-clear', appliedFingerprint: 'fp', legacyFingerprint: 'legacy',
    backup: { planHash: 'plan-clear', capturedAt: 0, routes: {} },
  })
  const result = await h.rollback('plan-clear')
  assert.equal(result.ok, true, result.text)
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'rollback cleared all profile journals')
})


// ---------------------------------------------------------------------------
// 10. Migrate apply success / failure-restore clear this profile's journals
// ---------------------------------------------------------------------------

const OFFICIAL = parseGoModelsPayload(
  JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8')),
).filter((entry) => entry.id !== 'gemini-4-argon')
const LEGACY_CHAT = {
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://opencode.ai/inference/go/openai/v1',
  displayName: 'OpenCode Go',
  models: [{ id: 'custom-test-model', name: 'custom-test-model', input: ['text'] }],
}

function validJournal(route) {
  return {
    version: 1, profileKey: PROFILE, route, keyFingerprint: FP,
    modelIds: ['custom-test-model'], contentHash: 'irrelevant', unset: false,
    entry: { managed: { 'custom-test-model': { hash: 'h' } } }, at: 1,
  }
}

await checkAsync('migrate apply success clears the profile journal', async () => {
  const h = await makeHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  h.journalStore.rawSet(goJournalKey(PROFILE, 'opencode-go', FP), validJournal('opencode-go'))
  assert.equal((await h.journalStore.list(PROFILE)).length, 1, 'premise: journal exists')
  const plan = buildMigrationPlan({
    descriptor: h.settings.describe()[0], entries: OFFICIAL,
    routes: ROUTES, ref: 'OPENCODE_GO_API_KEY', keyFingerprint: FP, now: 1,
  })
  const result = await applyMigration(
    { planHash: plan.planHash, confirmCode: plan.confirmCode, ackManaged: true },
    {
      settings: h.settings, ownershipStore: h.ownershipBase, migrationStore: h.migrationStore,
      logger: { info() {}, warn() {}, debug() {} }, entries: OFFICIAL, routes: ROUTES,
      ref: 'OPENCODE_GO_API_KEY', keyFingerprint: FP, now: 1,
      journalStore: h.journalStore, profileKey: PROFILE,
    },
  )
  assert.equal(result.ok, true, result.text)
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'apply cleared the stale journal')
})

await checkAsync('migrate apply failure restore clears the profile journal', async () => {
  const h = await makeHarness({ initialRoutes: { 'opencode-go': LEGACY_CHAT } })
  h.journalStore.rawSet(goJournalKey(PROFILE, 'opencode-go', FP), validJournal('opencode-go'))
  h.fault.ledgerWrite = true // ledger write fails after settings mutate → apply restores
  const plan = buildMigrationPlan({
    descriptor: h.settings.describe()[0], entries: OFFICIAL,
    routes: ROUTES, ref: 'OPENCODE_GO_API_KEY', keyFingerprint: FP, now: 1,
  })
  const result = await applyMigration(
    { planHash: plan.planHash, confirmCode: plan.confirmCode, ackManaged: true },
    {
      settings: h.settings, ownershipStore: h.ownershipStore, migrationStore: h.migrationStore,
      logger: { info() {}, warn() {}, debug() {} }, entries: OFFICIAL, routes: ROUTES,
      ref: 'OPENCODE_GO_API_KEY', keyFingerprint: FP, now: 1,
      journalStore: h.journalStore, profileKey: PROFILE,
    },
  )
  assert.equal(result.ok, false, 'apply must fail via the faulted ledger')
  assert.match(result.text, /rolled back/)
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'apply-failure restore cleared the journal')
})

// ---------------------------------------------------------------------------
// 11. Lock timeout / settings-changed semantics unchanged with journal wired
// ---------------------------------------------------------------------------

await checkAsync('journal wired: settings-changed-during-sync stays zero-write with no journal', async () => {
  const h = await makeHarness()
  const user = { id: 'user-saved', name: 'user' }
  const result = await h.round({
    onFetch: () => { h.settings.userEdit('opencode-go', [user]) },
  })
  assert.equal(result.reason, 'settings-changed-during-sync', result.text)
  assert.deepEqual(h.settings.mutations, [], 'zero settings writes')
  assert.deepEqual(idsOf(h.settings, 'opencode-go'), ['user-saved'], 'user edit kept')
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'no journal for a discarded round')
})

await checkAsync('journal wired: ledger-read lock timeout still reports store-lock-timeout with zero writes', async () => {
  const h = await makeHarness()
  const lockError = Object.assign(new Error('store lock timeout'), {
    code: 'DSH_STORE_LOCK_TIMEOUT', name: 'StoreLockTimeoutError',
  })
  h.ownershipStore.read = async () => { throw lockError }
  const result = await h.round()
  assert.equal(result.reason, 'write-failed')
  assert.deepEqual(result.write.failedRoutes.map((f) => f.reason), [
    'store-lock-timeout', 'store-lock-timeout', 'store-lock-timeout',
  ])
  assert.deepEqual(h.settings.mutations, [], 'lock timeout produces zero settings writes')
  assert.deepEqual(await h.journalStore.list(PROFILE), [], 'no journal written after a failed ledger read')
})

// ---------------------------------------------------------------------------
// oldfox #2/#4/#5 — final-gate suggestions (journal side)
// ---------------------------------------------------------------------------

await checkAsync('oldfox #2: descriptor-unavailable reconciliation has its own code, keeps every journal', async () => {
  const store = memoryJournal()
  const key = goJournalKey(PROFILE, 'opencode-go', FP)
  store.rawSet(key, {
    version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
    modelIds: ['x'], contentHash: 'whatever', unset: false,
    entry: { managed: { x: { hash: 'h' } } }, at: 1,
  })
  const result = await reconcileJournals({
    journalStore: store,
    ownershipStore: memoryOwnership(),
    settings: { describe: () => [] }, // no llm-pi-ai descriptor
    profileKey: PROFILE, keyFingerprint: FP,
    logger: { info() {}, warn() {}, debug() {} },
  })
  assert.equal(result.reconciled.length, 0)
  assert.deepEqual(result.notices.map((n) => n.code), ['journal-descriptor-unavailable'])
  assert.equal(result.notices.some((n) => n.code === 'journal-list-failed'), false, 'not mislabelled as a list failure')
  assert.match(result.notices[0].message, /descriptor unavailable/)
  assert.match(result.notices[0].message, /journals kept/)
  assert.deepEqual(await store.list(PROFILE), [key], 'the journal is kept, never discarded')
})

await checkAsync('oldfox #4: parseJournal rejects malformed ownership entries (missing / mistyped / oversized)', () => {
  const good = {
    version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
    modelIds: ['hy4-flash-free'], contentHash: 'abc', unset: false,
    entry: { managed: { 'hy4-flash-free': { hash: 'h' } } }, at: 1,
  }
  assert.ok(parseJournal(good).journal !== undefined, 'a valid entry is accepted')
  const rejects = (patch) => {
    const parsed = parseJournal({ ...good, ...patch })
    assert.ok(parsed.error !== undefined && /invalid ledger entry/.test(parsed.error), `expected rejection: ${JSON.stringify(patch)}`)
  }
  rejects({ entry: {} })                                             // missing required `managed`
  rejects({ entry: { managed: [] } })                                // wrong type (array)
  rejects({ entry: { managed: { x: { hash: 42 } } } })                // wrong hash type
  rejects({ entry: { managed: { x: {} } } })                         // hash field missing
  rejects({ entry: { ...good.entry, missing: { x: 'two' } } })       // wrong optional type
  rejects({ entry: { ...good.entry, appliedAddedIds: [1, 2] } })     // wrong array element type
  rejects({ entry: { ...good.entry, preManagedSection: 'nope' } })   // wrong nullable-object type
  rejects({ entry: { ...good.entry, appliedAddedIds: Array(100001).fill('x') } }) // oversized array
  rejects({ unset: true, entry: { managed: 'nope' } })               // malformed entry on unset too
})

await checkAsync('oldfox #4: a malformed-entry journal is warned+cleaned and never re-committed to the ledger', async () => {
  const settings = mockSettings({ 'opencode-go': { models: [model('keep-me')] } })
  const store = memoryJournal()
  const key = goJournalKey(PROFILE, 'opencode-go', FP)
  store.rawSet(key, {
    version: 1, profileKey: PROFILE, route: 'opencode-go', keyFingerprint: FP,
    modelIds: ['keep-me'], contentHash: journalContentHash([model('keep-me')]),
    unset: false, entry: { managed: { 'keep-me': { hash: 123 } } }, at: 1,
  })
  const ledger = memoryOwnership()
  const recorded = []
  const result = await reconcileJournals({
    journalStore: store, ownershipStore: ledger, settings,
    profileKey: PROFILE, keyFingerprint: FP,
    logger: { info() {}, warn() {}, debug() {} },
    onRecord: (route, ids) => { recorded.push([route, ids]) },
  })
  assert.equal(result.reconciled.length, 0, 'never reconciled')
  assert.equal(result.discarded.length, 1, 'discarded as a corrupt slot')
  assert.ok(result.notices.some((n) => n.code === 'journal-unparseable' && /invalid ledger entry/.test(n.message)),
    'warned as an unparseable journal')
  assert.equal(await ledger.read(goOwnershipKey('opencode-go', FP)), undefined, 'ledger untouched')
  assert.deepEqual(recorded, [], 'migration record untouched')
  assert.deepEqual(await store.list(PROFILE), [], 'slot cleaned')
})

await checkAsync('oldfox #5: journalContentHash uses deterministic code-unit order, not localeCompare', async () => {
  // Code-unit order puts 'Zed' (0x5A) before 'alpha' (0x61); an English collator
  // orders 'alpha' first. A hash computed with localeCompare would differ from
  // the byte-order reference below and could be judged `journal-stale`.
  assert.ok('Zed' < 'alpha', 'sanity: code-unit order')
  assert.equal('Zed'.localeCompare('alpha') > 0, true, 'sanity: locale disagrees with code units')
  const z = { id: 'Zed' }
  const a = { id: 'alpha' }
  const { createHash } = await import('node:crypto')
  const reference = createHash('sha256').update(JSON.stringify([z, a])).digest('hex')
  assert.equal(journalContentHash([a, z]), reference, 'hash equals the byte-order reference')
  assert.equal(journalContentHash([a, z]), journalContentHash([z, a]), 'array order is irrelevant')

  // Cross-locale proof: 'I'/'i' order flips between en and tr collators, so a
  // localeCompare-based hash would change between the two processes.
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const modulePath = fileURLToPath(new URL('../lib/opencode-go-journal.js', import.meta.url))
  const childHash = execFileSync(process.execPath, ['-e', `
    import { journalContentHash } from ${JSON.stringify(modulePath)}
    process.stdout.write(journalContentHash([{ id: 'I' }, { id: 'i' }]))
  `], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'tr_TR.UTF-8', LANG: 'tr_TR.UTF-8' },
  })
  assert.equal(journalContentHash([{ id: 'I' }, { id: 'i' }]), childHash,
    'hash is identical in a Turkish-locale process (no journal-stale false positive)')
})

console.log(`\n${passed} assertions passed, ${failed} failed.`)
if (failed > 0) process.exitCode = 1

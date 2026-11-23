// P1c wiring: one complete opencode-go round through the REAL command surface.
// source → planner → writer runs with an injected fetch, an injected ledger in
// a temp dir, and an in-memory settings seam. No network, no real ~/.dsh, no
// timers. The go/adopt write paths are exercised; the retired `eject` command
// is asserted rejected (B3) instead of falling through to a sync round.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { loadModelsStore, resetModelsStoreCache } from '../lib/remote-catalog.js'
import { createFileOwnershipStore } from '../lib/opencode-go-store.js'
import { fingerprintKey } from '../lib/opencode-go-source.js'
import {
  GO_FETCH_SERVICE,
  GO_OWNERSHIP_STORE_SERVICE,
  GO_OVERRIDE_STORER_SERVICE,
  runGoSyncRound,
} from '../lib/opencode-go-sync.js'
import {
  GO_MIGRATION_STORE_SERVICE,
  fingerprintSection,
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
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const KEY = 'test-go-key'
const FP = fingerprintKey(KEY)
const BASE_CHAT = 'https://opencode.ai/inference/go/openai/v1'
const BASE_MSG = 'https://opencode.ai/inference/go/anthropic/v1'
const BASE_RESP = 'https://opencode.ai/inference/go/openai/v1'

const officialPayload = {
  object: 'list',
  data: [
    { id: 'hy4-flash-free', name: 'hy4', api: { 'chat-completions': { base_url: BASE_CHAT } }, inputModalities: ['text'] },
    { id: 'qwen4-max', name: 'qwen', api: { messages: { base_url: BASE_MSG } }, inputModalities: ['text'] },
    { id: 'grok-4.7', name: 'grok', api: { responses: { base_url: BASE_RESP } }, inputModalities: ['text'] },
  ],
}

function mockSettings(initialRoutes = {}) {
  const state = new Map(Object.entries(initialRoutes).map(([route, data]) => [route, structuredClone(data)]))
  const mutations = []
  let revision = 1
  return {
    state,
    mutations,
    describe: () => [{
      ns: 'llm-pi-ai',
      revision,
      user: { providers: Object.fromEntries([...state].map(([route, data]) => [route, structuredClone(data)])) },
    }],
    /**
     * B4 seam: a user saving models in the host settings while a fetch is in
     * flight. Bumps the document revision exactly like a real settings edit.
     */
    userEdit(route, models) {
      state.set(route, { ...(state.get(route) ?? {}), models: structuredClone(models) })
      revision += 1
      return revision
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'llm-pi-ai')
      if (expectedRevision !== revision) {
        // Real dsh settings rejects a stale revision with SETTINGS_CONFLICT;
        // the writer is supposed to re-read and retry once.
        throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
      }
      mutations.push(structuredClone(ops))
      for (const op of ops) {
        const route = op.path[1]
        if (op.op === 'unset' && op.path.length === 2) {
          state.delete(route)
          continue
        }
        let data = state.get(route)
        if (data === undefined) {
          data = {}
          state.set(route, data)
        }
        if (op.op === 'unset') delete data[op.path[2]]
        else data[op.path[2]] = structuredClone(op.value)
      }
      revision += 1
    },
  }
}

function makeConfig(overrides = {}) {
  const base = {
    writeMode: 'overlay', // never enter the legacy sync path
    intervalMinutes: 0,
    startupDelaySeconds: 0,
    refreshTimeoutMs: 120000,
    managedRoutes: [],
    keepBuiltinOnly: true,
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
      routes: {
        chat: 'opencode-go',
        msg: 'opencode-go-msg',
        resp: 'opencode-go-resp',
        google: 'opencode-go-google',
      },
      ...overrides,
    },
  }
  return config
}

async function withHarness(fn, { initialRoutes = {}, configOverrides = {}, payload = officialPayload, apiKey = KEY, migrationRecord, onFetch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-go-round-'))
  const storeFile = join(dir, 'models-store.json')
  const settings = mockSettings(initialRoutes)
  const fetchCalls = []
  const credentialWrites = []
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, headers: init.headers })
    // B4 seam: mutate the document/revision before the fetch resolves, so the
    // round sees a stale pre-fetch descriptor but a fresh post-fetch one.
    if (onFetch !== undefined) await onFetch(settings)
    return { status: 200, json: async () => structuredClone(payload) }
  }
  const tempAccessor = loadModelsStore(storeFile)
  // P1d-1: by default simulate an already-migrated profile whose
  // appliedFingerprint tracks the current go sections, so these writer-mechanics
  // tests keep exercising write/idempotency instead of the migration gate.
  // Gate-specific tests pass an explicit legacy record via `migrationRecord`.
  const migrationStore = {
    async read() {
      if (migrationRecord !== undefined) {
        return typeof migrationRecord === 'function' ? migrationRecord() : migrationRecord
      }
      const sections = Object.fromEntries(
        [...settings.state].filter(([route]) => route.startsWith('opencode-go')),
      )
      return { appliedFingerprint: fingerprintSection(sections) }
    },
  }
  const services = {
    [GO_OWNERSHIP_STORE_SERVICE]: createFileOwnershipStore(tempAccessor),
    [GO_OVERRIDE_STORER_SERVICE]: tempAccessor,
    [GO_FETCH_SERVICE]: fetchImpl,
    [GO_MIGRATION_STORE_SERVICE]: migrationStore,
    // P1c-2: keep the go scheduler dormant in this command-path test — no real
    // timer may fire an extra round (the jitter window is otherwise 0–5s).
    [GO_SCHEDULER_TIMERS_SERVICE]: { setTimeout: () => ({ stub: true }), clearTimeout: () => {} },
    [GO_SCHEDULER_RANDOM_SERVICE]: { next: () => 0 },
    credentials: {
      describe: async () => ({ configured: true }),
      resolve: async () => (apiKey === undefined ? undefined : { value: apiKey }),
      set: async () => { credentialWrites.push('set') },
      unset: async () => { credentialWrites.push('unset') },
    },
    launchEnvironment: { get: () => undefined },
  }
  const state = { definitions: [], disposers: [] }
  const ctx = {
    settings,
    get(name) {
      if (name === 'settings') return settings
      return services[name]
    },
    logger: { info() {}, warn() {}, debug() {} },
    on() { return () => {} },
    effect(handler) {
      const dispose = handler()
      if (typeof dispose === 'function') state.disposers.push(dispose)
      return dispose
    },
    provide() {},
    inject(names, callback) {
      for (const name of names) if (ctx[name] === undefined) return
      callback(Object.create(ctx))
    },
    commands: {
      register(definition) {
        state.definitions.push(definition)
        return () => {}
      },
    },
  }
  try {
    apply(ctx, makeConfig(configOverrides))
    const invoke = async (text) => {
      const command = state.definitions.find((d) => d.name === 'model-sync')
      return command.handler({ rawInput: text })
    }
    await fn({ invoke, settings, fetchCalls, credentialWrites, storeFile })
  } finally {
    for (const dispose of state.disposers) dispose()
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
}

const modelsOf = (settings, route) => settings.state.get(route)?.models?.map((m) => m.id) ?? []

await checkAsync('full round: fetch → plan → write, ledger persisted under <route>#<keyFingerprint>', () => withHarness(async ({ invoke, settings, fetchCalls, credentialWrites, storeFile }) => {
  const result = await invoke('go')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(fetchCalls.length, 1, `exactly one official /v1/models request; report=${result.text}`)
  assert.equal(fetchCalls[0].headers.authorization, `Bearer ${KEY}`)
  assert.match(result.text, /source ok \(3 models/)
  assert.match(result.text, /opencode-go: wrote/)
  assert.match(result.text, /opencode-go-msg: wrote/)
  assert.match(result.text, /opencode-go-resp: wrote/)
  assert.deepEqual(modelsOf(settings, 'opencode-go'), ['hy4-flash-free'])
  assert.deepEqual(modelsOf(settings, 'opencode-go-msg'), ['qwen4-max'])
  assert.deepEqual(modelsOf(settings, 'opencode-go-resp'), ['grok-4.7'])
  assert.deepEqual(credentialWrites, [], 'sync never writes credentials')
  const doc = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.ok(doc[`opencode-go#${FP}`] !== undefined, 'chat ledger persisted with the source fingerprint')
  assert.ok(doc[`opencode-go-msg#${FP}`] !== undefined)
  assert.ok(doc[`opencode-go-resp#${FP}`] !== undefined)
}))

await checkAsync('round is idempotent: a second identical payload writes no settings', () => withHarness(async ({ invoke, settings, fetchCalls }) => {
  await invoke('status go')
  const firstCount = settings.mutations.length
  await invoke('go')
  assert.equal(settings.mutations.length, firstCount, 'identical payload → no revision bump')
  assert.equal(fetchCalls.length, 2)
}))

await checkAsync('no key: no request, no settings write (V4)', () => withHarness(async ({ invoke, settings, fetchCalls }) => {
  const result = await invoke('go')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /skipped — no credential value/)
  assert.equal(fetchCalls.length, 0, 'no /v1/models request without a key')
  assert.deepEqual(settings.mutations, [], 'no settings write without a key')
}, { apiKey: '' }))

await checkAsync('disabled by default: no request, no settings write (zero behavior change)', () => withHarness(async ({ invoke, settings, fetchCalls }) => {
  const result = await invoke('go')
  assert.match(result.text, /disabled — set opencode\.go\.enabled=true/)
  assert.equal(fetchCalls.length, 0)
  assert.deepEqual(settings.mutations, [])
}, { configOverrides: { enabled: false } }))

await checkAsync('adopt go: claims pre-existing models into this key\'s ledger', () => withHarness(async ({ invoke, storeFile }) => {
  const readDoc = async () => {
    try {
      return JSON.parse(await readFile(storeFile, 'utf8'))
    } catch {
      return {}
    }
  }
  assert.equal((await readDoc())[`opencode-go#${FP}`], undefined, 'no ledger yet')
  const result = await invoke('adopt go')
  assert.equal(result.kind, 'success', result.text)
  const after = await readDoc()
  assert.ok(after[`opencode-go#${FP}`].managed['qwen4-max'] !== undefined, `adopt claimed the legacy id; doc=${JSON.stringify(after)}`)
}, {
  initialRoutes: { 'opencode-go': { models: [{ id: 'qwen4-max', name: 'legacy' }] } },
  payload: { object: 'list', data: [officialPayload.data[0]] },
}))

await checkAsync('eject go: retired command is rejected with zero writes and no sync round', () => withHarness(async ({ invoke, settings, fetchCalls }) => {
  const result = await invoke('eject go')
  assert.equal(result.kind, 'error', result.text)
  assert.match(result.text, /retired/)
  assert.match(result.text, /migrate rollback/)
  assert.deepEqual(settings.mutations, [], 'retired eject never writes settings')
  assert.deepEqual(fetchCalls, [], 'retired eject never triggers a sync round')
  assert.deepEqual(settings.state.size, 0, 'no routes created by the retired command')
}))

// ---------------------------------------------------------------------------
// B4 (31): fetch-window settings edits must never be silently overwritten.
// Direct runGoSyncRound calls give structured assertions on reason/write;
// the harness case checks the user-visible command surface.
// ---------------------------------------------------------------------------

function memoryOwnershipStore() {
  const map = new Map()
  return {
    map,
    async read(key) { return map.get(key) },
    async write(key, entry) { map.set(key, entry) },
    async delete(key) { map.delete(key) },
  }
}

function directGoRound(settings, { ownershipStore = memoryOwnershipStore(), onFetch, onOwnWrite } = {}) {
  return runGoSyncRound({
    settings,
    ownershipStore,
    logger: { info() {}, warn() {}, debug() {} },
    config: {
      enabled: true,
      ref: 'OPENCODE_GO_API_KEY',
      modelsUrl: 'https://opencode.ai/inference/go/v1/models',
      routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp' },
      pinnedModels: [],
      confirmRemovals: 2,
      adoptExisting: false,
    },
    apiKey: KEY,
    observedAt: 0,
    fetchImpl: async () => {
      if (onFetch !== undefined) await onFetch()
      return { status: 200, json: async () => structuredClone(officialPayload) }
    },
    onOwnWrite,
  })
}

await checkAsync('B4: settings edit during fetch → zero writes, reason settings-changed-during-sync, user edit kept', async () => {
  const settings = mockSettings()
  const store = memoryOwnershipStore()
  let owned = 0
  const userModel = { id: 'user-saved-model', name: 'user' }
  const result = await directGoRound(settings, {
    ownershipStore: store,
    onOwnWrite: () => { owned += 1 },
    onFetch: () => { settings.userEdit('opencode-go', [userModel]) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'settings-changed-during-sync')
  assert.deepEqual(result.settingsChanged, { beforeRevision: 1, afterRevision: 2 })
  assert.equal(result.write, undefined, 'writer was never reached — no half-written round')
  assert.deepEqual(settings.mutations, [], 'zero settings mutations')
  assert.deepEqual(settings.state.get('opencode-go').models, [userModel], 'the user edit is preserved verbatim')
  assert.deepEqual([...store.map.keys()], [], 'no ownership ledger change')
  assert.equal(owned, 0, 'no appliedFingerprint update')
  assert.match(result.text, /settings changed during the \/v1\/models fetch/)
  assert.match(result.text, /no settings write, no ownership ledger change, no fingerprint update/)
})

await checkAsync('B4: unchanged settings → normal write, then a second idempotent round', async () => {
  const settings = mockSettings()
  const store = memoryOwnershipStore()
  let owned = 0
  const onOwnWrite = () => { owned += 1 }
  const first = await directGoRound(settings, { ownershipStore: store, onOwnWrite })
  assert.equal(first.reason, 'completed')
  assert.equal(first.ok, true)
  assert.deepEqual(first.write.writtenRoutes.sort(), ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
  assert.deepEqual(first.write.failedRoutes, [])
  assert.equal(settings.mutations.length, 3)
  assert.equal(owned, 3)

  const second = await directGoRound(settings, { ownershipStore: store, onOwnWrite })
  assert.equal(second.reason, 'completed')
  assert.deepEqual(second.write.writtenRoutes, [], 'second round is a no-change round')
  assert.equal(settings.mutations.length, 3, 'no extra mutation on the second round')
  assert.equal(owned, 3, 'no fingerprint update on a no-change round')
  assert.equal(second.settingsChanged, undefined)
})

await checkAsync('B4: store lock timeout and fetch-window edit are distinct failures, both with zero writes', async () => {
  // A) the cross-process store lock is held → the per-route ledger read fails
  // closed; the writer reports store-lock-timeout and never mutates settings.
  const lockedSettings = mockSettings()
  const lockError = Object.assign(new Error('store lock timeout'), {
    code: 'DSH_STORE_LOCK_TIMEOUT',
    name: 'StoreLockTimeoutError',
  })
  const lockedStore = {
    async read() { throw lockError },
    async write() { throw lockError },
    async delete() { throw lockError },
  }
  const locked = await directGoRound(lockedSettings, { ownershipStore: lockedStore })
  assert.deepEqual(locked.write.failedRoutes.map((f) => f.reason), [
    'store-lock-timeout', 'store-lock-timeout', 'store-lock-timeout',
  ])
  assert.deepEqual(locked.write.writtenRoutes, [])
  assert.deepEqual(lockedSettings.mutations, [], 'lock timeout produces zero settings writes')

  // B) no lock problem, but the user edits settings inside the fetch window →
  // the whole round is abandoned before the writer, with a different reason.
  const changedSettings = mockSettings()
  const changed = await directGoRound(changedSettings, {
    onFetch: () => { changedSettings.userEdit('opencode-go', [{ id: 'user-2', name: 'u2' }]) },
  })
  assert.equal(changed.reason, 'settings-changed-during-sync')
  assert.equal(changed.write, undefined)
  assert.deepEqual(changedSettings.mutations, [])

  assert.notEqual(locked.write.failedRoutes[0].reason, changed.reason, 'the two failure causes are distinguishable')
})

await checkAsync('B4 command surface: fetch-window edit returns kind=error with the user-visible reason', () => withHarness(async ({ invoke, settings, fetchCalls }) => {
  const result = await invoke('go')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /settings changed during the \/v1\/models fetch/)
  assert.equal(fetchCalls.length, 1, 'the request itself still happened')
  assert.deepEqual(settings.mutations, [], 'no settings write')
  assert.deepEqual(settings.state.get('opencode-go').models, [{ id: 'user-saved-model', name: 'user' }])
}, { onFetch: (settings) => settings.userEdit('opencode-go', [{ id: 'user-saved-model', name: 'user' }]) }))

// ---------------------------------------------------------------------------
// N1 (51 §5): a settings edit in the two gaps AFTER the fetch-window guard
// must never let the writer apply its stale plan. Both windows are built with
// an injection seam that bumps the revision at a precise point, and both must
// end in a zero-write `settings-changed-during-sync` round with the user's new
// model preserved byte-for-byte.
// ---------------------------------------------------------------------------

await checkAsync('N1 window ①: edit after the writer reads its descriptor → zero writes, stale plan never applied', async () => {
  const settings = mockSettings()
  const store = memoryOwnershipStore()
  const userModel = { id: 'user-saved-model', name: 'user' }
  let owned = 0
  let describeCalls = 0
  let writerEntered = false
  // Seam: the 3rd describe() is the writer's entry descriptor read (the first
  // two belong to runGoSyncRound's initial + post-fetch reads).
  const originalDescribe = settings.describe
  settings.describe = () => {
    describeCalls += 1
    if (describeCalls === 3) writerEntered = true
    return originalDescribe()
  }
  let bumped = false
  const wrappedStore = {
    ...store,
    async read(key) {
      // The writer's first ledger read happens after its entry descriptor read
      // but before its first mutate — exactly reproduction path A from 51 §5.
      if (writerEntered && !bumped) {
        bumped = true
        settings.userEdit('opencode-go', [userModel])
      }
      return store.read(key)
    },
  }
  const result = await directGoRound(settings, {
    ownershipStore: wrappedStore,
    onOwnWrite: () => { owned += 1 },
  })
  assert.equal(bumped, true, 'the seam actually fired')
  assert.equal(result.reason, 'settings-changed-during-sync', `report=${result.text}`)
  assert.equal(result.ok, false)
  assert.equal(result.write, undefined, 'no half-written round is exposed')
  assert.deepEqual(result.settingsChanged, { beforeRevision: 1, afterRevision: 2 })
  assert.deepEqual(settings.mutations, [], 'zero settings mutations')
  assert.deepEqual(settings.state.get('opencode-go').models, [userModel], 'the just-saved user model survived')
  assert.deepEqual([...store.map.keys()], [], 'no ownership ledger change')
  assert.equal(owned, 0, 'no appliedFingerprint update')
  assert.doesNotMatch(result.text, /reason:'completed'/)
  assert.match(result.text, /settings changed during this sync round/)
  assert.match(result.text, /discarding the stale plan/)
})

await checkAsync('N1 window ②: edit after fetch validation but before the writer reads its descriptor → zero writes', async () => {
  const settings = mockSettings()
  const store = memoryOwnershipStore()
  const userModel = { id: 'user-saved-model', name: 'user' }
  let owned = 0
  let bumped = false
  const wrappedStore = {
    ...store,
    async read(key) {
      // runGoSyncRound reads the ledger AFTER its post-fetch revision check but
      // BEFORE writeGoPlan — reproduction path B from 51 §5.
      if (!bumped) {
        bumped = true
        settings.userEdit('opencode-go', [userModel])
      }
      return store.read(key)
    },
  }
  const result = await directGoRound(settings, {
    ownershipStore: wrappedStore,
    onOwnWrite: () => { owned += 1 },
  })
  assert.equal(bumped, true, 'the seam actually fired')
  assert.equal(result.reason, 'settings-changed-during-sync', `report=${result.text}`)
  assert.equal(result.ok, false)
  assert.equal(result.write, undefined, 'writer never produced a completed round')
  assert.deepEqual(result.settingsChanged, { beforeRevision: 1, afterRevision: 2 })
  assert.deepEqual(settings.mutations, [], 'zero settings mutations')
  assert.deepEqual(settings.state.get('opencode-go').models, [userModel], 'the user edit is preserved verbatim')
  assert.deepEqual([...store.map.keys()], [], 'no ownership ledger change')
  assert.equal(owned, 0, 'no appliedFingerprint update')
})

await checkAsync('N1: a normal unchanged-revision round still writes all three routes, then a second idempotent round', async () => {
  const settings = mockSettings()
  const store = memoryOwnershipStore()
  let owned = 0
  const first = await directGoRound(settings, { ownershipStore: store, onOwnWrite: () => { owned += 1 } })
  assert.equal(first.reason, 'completed')
  assert.equal(first.write.failedRoutes.length, 0, 'own writes advance the rolling revision baseline without false conflicts')
  assert.deepEqual(first.write.writtenRoutes.sort(), ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
  assert.equal(settings.mutations.length, 3)
  assert.equal(owned, 3)
  const second = await directGoRound(settings, { ownershipStore: store, onOwnWrite: () => { owned += 1 } })
  assert.equal(second.reason, 'completed')
  assert.deepEqual(second.write.writtenRoutes, [])
  assert.equal(settings.mutations.length, 3, 'second round is a no-change round')
  assert.equal(owned, 3)
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

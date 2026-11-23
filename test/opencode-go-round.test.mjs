// P1c wiring: one complete opencode-go round through the REAL command surface.
// source → planner → writer runs with an injected fetch, an injected ledger in
// a temp dir, and an in-memory settings seam. No network, no real ~/.dsh, no
// timers. All three go subcommands' write paths are exercised.

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
} from '../lib/opencode-go-sync.js'
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

async function withHarness(fn, { initialRoutes = {}, configOverrides = {}, payload = officialPayload, apiKey = KEY } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-go-round-'))
  const storeFile = join(dir, 'models-store.json')
  const settings = mockSettings(initialRoutes)
  const fetchCalls = []
  const credentialWrites = []
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, headers: init.headers })
    return { status: 200, json: async () => structuredClone(payload) }
  }
  const tempAccessor = loadModelsStore(storeFile)
  const services = {
    [GO_OWNERSHIP_STORE_SERVICE]: createFileOwnershipStore(tempAccessor),
    [GO_OVERRIDE_STORER_SERVICE]: tempAccessor,
    [GO_FETCH_SERVICE]: fetchImpl,
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

await checkAsync('eject go: only managed routes are removed, missing ledger is refused', () => withHarness(async ({ invoke, settings, storeFile }) => {
  await invoke('go')
  assert.equal(settings.state.size, 3)
  const result = await invoke('eject go')
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /opencode-go: ejected/)
  assert.equal(settings.state.size, 0, 'plugin-created routes were unset wholesale')
  const after = JSON.parse(await readFile(storeFile, 'utf8'))
  assert.equal(after[`opencode-go#${FP}`], undefined)
  assert.match(result.text, /opencode-go-google: refused — no ownership ledger/)
}))

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

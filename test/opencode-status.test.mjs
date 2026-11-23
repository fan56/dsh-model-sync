// P0 /opencode-status command: registered alongside /model-sync, read-only
// (no settings.mutate, no credential writes, no profile edits). The no-key
// path is exercised end-to-end so no test ever reaches the network.

import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

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

const defaultConfig = {
  writeMode: 'overlay',
  intervalMinutes: 0,
  startupDelaySeconds: 0,
  refreshTimeoutMs: 120000,
  managedRoutes: [],
  keepBuiltinOnly: true,
  dropUnserviceable: true,
  syncNotify: false,
  forceMaxReasoningEffort: false,
  providerNativeFetch: true,
  keepDeprecatedBuiltin: false,
}
const asVolatileConfig = (values = {}) => Object.fromEntries(
  Object.entries({ ...defaultConfig, ...values }).map(([key, value]) => [key, { get: () => value }]),
)

function createFakeContext({ services = {}, settings } = {}) {
  const state = { definitions: [], effectDisposers: [] }
  const settingsStub = settings ?? {
    describe: () => [],
    mutate: async () => { throw new Error('P0 must never call settings.mutate') },
  }
  const ctx = {
    settings: settingsStub,
    get(name) {
      if (name === 'settings') return settingsStub
      return services[name]
    },
    logger: { info() {}, warn() {}, debug() {} },
    on() { return () => {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.effectDisposers.push(disposer)
      return disposer
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
  return { ctx, state, config: asVolatileConfig() }
}

const fakeInvocation = (rawInput = '') => ({
  commandId: 'test-status-1',
  agent: { id: 'agent-1' },
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

function disposeAll(state) {
  for (const disposer of state.effectDisposers) disposer()
}

check('apply registers /opencode-status next to /model-sync', () => {
  const { ctx, state, config } = createFakeContext()
  apply(ctx, config)
  const names = state.definitions.map((d) => d.name)
  assert.deepEqual(names.sort(), ['model-sync', 'opencode-status'])
  const status = state.definitions.find((d) => d.name === 'opencode-status')
  assert.ok(status.description.length > 0)
  assert.ok(state.effectDisposers.length >= 2)
  disposeAll(state)
})

await checkAsync('handler with no key: no request, no mutate, no credential write', async () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('no network in P0 tests') }
  const writes = []
  const descriptor = {
    ns: 'llm-pi-ai',
    revision: 1,
    user: { providers: { 'opencode-go': { models: [{ id: 'old-model' }] } } },
  }
  const services = {
    credentials: {
      describe: async () => ({ configured: false }),
      resolve: async () => undefined,
      set: async () => { writes.push('set') },
      unset: async () => { writes.push('unset') },
    },
    launchEnvironment: { get: () => undefined },
  }
  const { ctx, state, config } = createFakeContext({
    services,
    settings: {
      describe: () => [descriptor],
      mutate: async () => { throw new Error('P0 must never call settings.mutate') },
    },
  })
  try {
    apply(ctx, config)
    const status = state.definitions.find((d) => d.name === 'opencode-status')
    const result = await status.handler(fakeInvocation())
    assert.equal(fetchCalls, 0, 'no key → no /v1/models request')
    assert.deepEqual(writes, [], 'no credential writes')
    assert.equal(result.kind, 'success')
    assert.match(result.text, /read-only; no settings written/)
    assert.match(result.text, /authStatus: unknown/)
    assert.match(result.text, /no-key/)
    assert.match(result.text, /configured 1/, 'current profile config is still reported')
  } finally {
    globalThis.fetch = originalFetch
    disposeAll(state)
  }
})

await checkAsync('handler ignores a non-go argument with a visible note', async () => {
  const { ctx, state, config } = createFakeContext({
    services: {
      credentials: { resolve: async () => undefined },
      launchEnvironment: { get: () => undefined },
    },
  })
  apply(ctx, config)
  const status = state.definitions.find((d) => d.name === 'opencode-status')
  const result = await status.handler(fakeInvocation('zen'))
  assert.equal(result.kind, 'success')
  assert.match(result.text, /P0 diagnoses opencode-go only/)
  assert.match(result.text, /authStatus: unknown/)
  disposeAll(state)
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

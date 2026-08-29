// /model-sync command registration: the plugin registers its own slash
// command through the (optional) @deepseek-ai/dsh-commands registry.

/**
 * Tests for the command registration in index.ts:
 * - apply() registers exactly one 'model-sync' definition via ctx.commands
 * - the handler returns the syncNow report (and notes ignored arguments)
 * - syncNow rejections settle as { kind: 'error' }, never escaping
 * - hosts without a commands service skip registration and keep working
 */

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

/** Config shaped like the resolved model-sync namespace (fast timers). */
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
}

/**
 * Fake cordis context stubbing everything apply() touches: settings.register,
 * scope.watch, ctx.get/logger/provide, ctx.effect (runs the body eagerly and
 * collects the returned disposer, like cordis), ctx.inject (runs the sub-fiber
 * body immediately when every injected service exists, never when one is
 * missing — real cordis would also fire it if a missing service appears
 * later), and the optional commands registry.
 */
function createFakeContext({ config = defaultConfig, services = {}, get } = {}) {
  const state = {
    definitions: [], // command definitions passed to commands.register
    unregisterCalls: 0, // how often the registry disposer ran
    effectDisposers: [], // disposers returned by ctx.effect bodies
    effectLabels: [],
    provided: [],
  }
  const scope = {
    get: () => config,
    watch: () => {},
  }
  const ctx = {
    settings: { register: () => scope },
    get: get ?? ((name) => services[name]),
    logger: { info() {}, warn() {}, debug() {} },
    effect(fn, label) {
      state.effectLabels.push(label)
      const disposer = fn()
      if (typeof disposer === 'function') state.effectDisposers.push(disposer)
      return disposer
    },
    provide(name, service) {
      state.provided.push({ name, service })
    },
    inject(names, callback) {
      for (const name of names) if (ctx[name] === undefined) return
      callback(Object.create(ctx))
    },
    commands: {
      register(definition) {
        state.definitions.push(definition)
        return () => {
          state.unregisterCalls += 1
        }
      },
    },
  }
  return { ctx, state }
}

/** Tear down everything apply() armed (timers, command registration). */
function disposeAll(state) {
  for (const disposer of state.effectDisposers) disposer()
}

function fakeInvocation(rawInput = '') {
  return {
    commandId: 'test-command-1',
    agent: { id: 'agent-1' },
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
check('apply registers exactly one model-sync command definition', () => {
  const { ctx, state } = createFakeContext()
  apply(ctx)
  assert.equal(state.definitions.length, 1, 'exactly one command definition')
  const definition = state.definitions[0]
  assert.equal(definition.name, 'model-sync')
  assert.ok(typeof definition.description === 'string' && definition.description.length > 0,
    'description is a non-empty string')
  assert.equal(typeof definition.handler, 'function')
  assert.ok(state.effectLabels.includes('dsh-model-sync: /model-sync'), 'effect is labeled')
  disposeAll(state)
})

check('the effect disposer unregisters the command', () => {
  const { ctx, state } = createFakeContext()
  apply(ctx)
  assert.equal(state.unregisterCalls, 0, 'not unregistered while plugin is live')
  disposeAll(state)
  assert.equal(state.unregisterCalls, 1, 'unregistered exactly once on dispose')
})

// ---------------------------------------------------------------------------
// Handler behavior
// ---------------------------------------------------------------------------
await checkAsync('handler returns the syncNow report on success (empty rawInput)', async () => {
  // overlay mode with a patched catalog stub → one full round, deterministic report
  const { ctx, state } = createFakeContext({
    services: {
      llm: {
        listProviders: () => [{ id: 'route-a' }],
        listModels: async () => [{ id: 'model-a' }],
      },
      piAiCatalog: { refresh: async () => new Map() },
    },
  })
  apply(ctx)
  const result = await state.definitions[0].handler(fakeInvocation(''))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('route-a'), `report mentions the provider, got: ${result.text}`)
  assert.ok(result.text.includes('up to date'), `report is a syncNow round report, got: ${result.text}`)
  assert.ok(!result.text.includes('ignored'), 'no ignore note for empty input')
  disposeAll(state)
})

await checkAsync('handler notes the ignored argument when rawInput is non-empty', async () => {
  const { ctx, state } = createFakeContext({
    services: {
      llm: {
        listProviders: () => [{ id: 'route-a' }],
        listModels: async () => [{ id: 'model-a' }],
      },
      piAiCatalog: { refresh: async () => new Map() },
    },
  })
  apply(ctx)
  const result = await state.definitions[0].handler(fakeInvocation(' route-a '))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('managedRoutes'), 'note names managedRoutes')
  assert.ok(result.text.includes('ignored'), 'note says the argument is ignored')
  assert.ok(result.text.includes('route-a'), 'the syncNow report still follows the note')
  disposeAll(state)
})

await checkAsync('handler settles syncNow rejections as kind:error', async () => {
  const { ctx, state } = createFakeContext({
    get(name) {
      if (name === 'llm') throw new Error('llm service exploded')
      return undefined
    },
  })
  apply(ctx)
  const result = await state.definitions[0].handler(fakeInvocation())
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('llm service exploded'), `error text carries the message, got: ${result.text}`)
  disposeAll(state)
})

// ---------------------------------------------------------------------------
// Degraded host: no commands service
// ---------------------------------------------------------------------------
await checkAsync('apply without a commands service skips registration and keeps the modelSync service', async () => {
  const { ctx, state } = createFakeContext()
  delete ctx.commands
  apply(ctx) // must not throw
  assert.equal(state.definitions.length, 0, 'nothing registered')
  const provided = state.provided.find((entry) => entry.name === 'modelSync')
  assert.ok(provided, 'modelSync service still provided')
  const report = await provided.service.syncNow()
  assert.ok(typeof report === 'string' && report.length > 0, `syncNow still reports, got: ${report}`)
  disposeAll(state)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

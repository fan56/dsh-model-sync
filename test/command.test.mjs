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

/** Config shaped like the resolved Config schema (fast timers). */
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

/**
 * Wrap plain values in the volatile-reference shape the dsh 0.1.7 host
 * delivers to apply(): every volatile Config field is a stable `{ get() }`
 * reference the host swaps in place on edits.
 */
function asVolatileConfig(values) {
  return Object.fromEntries(
    Object.entries({ ...defaultConfig, ...values }).map(([key, value]) => [key, { get: () => value }]),
  )
}

/**
 * Fake cordis context stubbing everything apply() touches: the settings
 * service stub (inject gating only — the plugin no longer calls register),
 * the settings/document-updated subscription via ctx.on, ctx.get/logger/
 * provide, ctx.effect (runs the body eagerly and collects the returned
 * disposer, like cordis), ctx.inject (runs the sub-fiber body immediately
 * when every injected service exists, never when one is missing — real
 * cordis would also fire it if a missing service appears later), and the
 * optional commands registry.
 */
function createFakeContext({ config = defaultConfig, services = {}, get, settings: settingsOverride } = {}) {
  const state = {
    definitions: [], // command definitions passed to commands.register
    unregisterCalls: 0, // how often the registry disposer ran
    effectDisposers: [], // disposers returned from ctx.effect bodies
    effectLabels: [],
    provided: [],
    eventListeners: [], // { event, listener } registered via ctx.on
  }
  const ctx = {
    settings: settingsOverride ?? { describe: () => [], mutate: async () => {} },
    get: get ?? ((name) => services[name]),
    logger: { info() {}, warn() {}, debug() {} },
    on(event, listener) {
      state.eventListeners.push({ event, listener })
      return () => {
        const index = state.eventListeners.findIndex((entry) => entry.event === event && entry.listener === listener)
        if (index >= 0) state.eventListeners.splice(index, 1)
      }
    },
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
  return { ctx, state, config: asVolatileConfig(config) }
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
  const { ctx, state, config } = createFakeContext()
  apply(ctx, config)
  assert.equal(state.definitions.length, 1, 'exactly one command definition')
  const definition = state.definitions[0]
  assert.equal(definition.name, 'model-sync')
  assert.ok(typeof definition.description === 'string' && definition.description.length > 0,
    'description is a non-empty string')
  assert.equal(typeof definition.handler, 'function')
  assert.ok(state.effectLabels.includes('dsh-model-sync: /model-sync'), 'effect is labeled')
  assert.ok(
    state.eventListeners.some((entry) => entry.event === 'settings/document-updated'),
    'the hot-reload event subscription is registered',
  )
  disposeAll(state)
  assert.equal(state.eventListeners.length, 0, 'the event subscription disposes with the effect')
})

check('the settings/document-updated listener re-arms without throwing', () => {
  const { ctx, state, config } = createFakeContext()
  apply(ctx, config)
  const entry = state.eventListeners.find((e) => e.event === 'settings/document-updated')
  assert.ok(entry, 'listener registered')
  assert.doesNotThrow(() => entry.listener('llm-pi-ai', 1), 'a foreign ns is ignored')
  assert.doesNotThrow(() => entry.listener('dsh-model-sync', 2), 'the own ns re-arms the timers')
  disposeAll(state)
})

check('the effect disposer unregisters the command', () => {
  const { ctx, state, config } = createFakeContext()
  apply(ctx, config)
  assert.equal(state.unregisterCalls, 0, 'not unregistered while plugin is live')
  disposeAll(state)
  assert.equal(state.unregisterCalls, 1, 'unregistered exactly once on dispose')
})

// ---------------------------------------------------------------------------
// Handler behavior
// ---------------------------------------------------------------------------
await checkAsync('handler returns the syncNow report on success (empty rawInput)', async () => {
  // overlay mode with a patched catalog stub → one full round, deterministic report
  const { ctx, state, config } = createFakeContext({
    services: {
      llm: {
        listProviders: () => [{ id: 'route-a' }],
        listModels: async () => [{ id: 'model-a' }],
      },
      piAiCatalog: { refresh: async () => new Map() },
    },
  })
  apply(ctx, config)
  const result = await state.definitions[0].handler(fakeInvocation(''))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('route-a'), `report mentions the provider, got: ${result.text}`)
  assert.ok(result.text.includes('up to date'), `report is a syncNow round report, got: ${result.text}`)
  assert.ok(!result.text.includes('ignored'), 'no ignore note for empty input')
  disposeAll(state)
})

await checkAsync('handler notes the ignored argument when rawInput is non-empty', async () => {
  const { ctx, state, config } = createFakeContext({
    services: {
      llm: {
        listProviders: () => [{ id: 'route-a' }],
        listModels: async () => [{ id: 'model-a' }],
      },
      piAiCatalog: { refresh: async () => new Map() },
    },
  })
  apply(ctx, config)
  const result = await state.definitions[0].handler(fakeInvocation(' route-a '))
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('managedRoutes'), 'note names managedRoutes')
  assert.ok(result.text.includes('ignored'), 'note says the argument is ignored')
  assert.ok(result.text.includes('route-a'), 'the syncNow report still follows the note')
  disposeAll(state)
})

await checkAsync('handler settles syncNow rejections as kind:error', async () => {
  const { ctx, state, config } = createFakeContext({
    get(name) {
      if (name === 'llm') throw new Error('llm service exploded')
      return undefined
    },
  })
  apply(ctx, config)
  const result = await state.definitions[0].handler(fakeInvocation())
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('llm service exploded'), `error text carries the message, got: ${result.text}`)
  disposeAll(state)
})

// ---------------------------------------------------------------------------
// Degraded host: no commands service
// ---------------------------------------------------------------------------
await checkAsync('apply without a commands service skips registration and keeps the modelSync service', async () => {
  const { ctx, state, config } = createFakeContext()
  delete ctx.commands
  apply(ctx, config) // must not throw
  assert.equal(state.definitions.length, 0, 'nothing registered')
  const provided = state.provided.find((entry) => entry.name === 'modelSync')
  assert.ok(provided, 'modelSync service still provided')
  const report = await provided.service.syncNow()
  assert.ok(typeof report === 'string' && report.length > 0, `syncNow still reports, got: ${report}`)
  disposeAll(state)
})

// ---------------------------------------------------------------------------
// Legacy settings import wiring
// ---------------------------------------------------------------------------
// Regression gate for the 2026-09-24 incident (siblings): apply() used to
// read `ctx.settings` directly at its tail — undefined on a real boot whose
// settings service mounts after apply, so the import silently no-settings'd
// every boot. apply must wire the import through ctx.inject(['settings'], …).
await checkAsync('legacy import wiring: apply rides ctx.inject(settings), marker lands in $DSH_HOME', async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { legacyMarkerPath } = await import('../lib/legacy-import.js')
  const home = mkdtempSync(join(tmpdir(), 'model-sync-wiring-'))
  const prevDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const updateCalls = []
  const seam = {
    describe: () => [],
    async mutate() {},
    async update(ns, patch) {
      updateCalls.push({ ns, patch })
    },
  }
  const { ctx, state, config } = createFakeContext({ settings: seam })
  try {
    writeFileSync(join(home, 'settings.yaml.imported'), 'model-sync:\n  writeMode: overlay\n  intervalMinutes: 99\n')
    apply(ctx, config)
    // Fire-and-forget: let the floating import promise settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
    // writeMode 'overlay' equals the mount config; intervalMinutes differs.
    assert.deepEqual(updateCalls, [{ ns: 'dsh-model-sync', patch: { intervalMinutes: 99 } }])
    const marker = JSON.parse(readFileSync(legacyMarkerPath(home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.source, 'settings.yaml.imported')
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDshHome
    rmSync(home, { recursive: true, force: true })
    disposeAll(state)
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

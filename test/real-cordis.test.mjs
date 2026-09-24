// real-cordis integration: run apply() under the REAL @deepseek-ai/cordis and
// the REAL @deepseek-ai/dsh-commands registry, not the fake context of
// command.test.mjs.
//
// Regression gate for the 0.1.3 boot crash. That crash had two ingredients the
// fake-context tests cannot reproduce:
//   1. cordis 4 throws "cannot get property \"commands\" without inject" when
//      apply() reads a foreign service property before the owning plugin has
//      provided it — and plugin load errors only surface when you AWAIT the
//      fiber returned by ctx.plugin() (cordis otherwise logs them into the
//      fiber; dsh's loader is what surfaces them as "plugin tree failed to
//      load").
//   2. Host ordering: in a dsh profile the `commands` service (a cordis
//      Service created by dsh-commands) may come up AFTER user plugins, so an
//      eager `ctx.commands` read inside apply() crashes the boot.
// These tests mount the real packages and use the deferred ordering, plus a
// tripwire that fails if cordis ever stops enforcing the gate.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import commandsPlugin from '@deepseek-ai/dsh-commands'
import * as plugin from '../lib/index.js'
import { DEFAULT_ROUTES_LIST } from '../lib/index.js'
import { resetModelsStoreCache } from '../lib/remote-catalog.js'

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

/** Idle mount config: no interval, one immediate (harmless) startup round.
 *  Partial on purpose — the plugin's Config schema resolves defaults for the
 *  rest, exactly like the 0.1.7 loader does. */
const mountConfig = (overrides = {}) => ({
  writeMode: 'overlay',
  intervalMinutes: 0,
  startupDelaySeconds: 0,
  ...overrides,
})

/** A real cordis root with the `settings` seam provided, like dsh-base does.
 *  The 0.1.7 settings service no longer exposes register() — the plugin's
 *  Config schema IS its registration, so the double only needs describe. */
function makeRoot() {
  const root = new Context()
  root.provide('settings', {
    describe: () => [],
    async mutate() {},
  })
  return root
}

/**
 * Settings seam spy: counts `mutate` calls so a test can prove the gate
 * short-circuited the whole pipeline (no fetch, no translate, no mutate).
 * Plug this in BEFORE mounting the plugin.
 *
 * Config values no longer ride the settings seam (the 0.1.7 Config schema
 * replaced register()); tests pass them as the mount config instead.
 */
function makeSpySettingsService() {
  const spy = {
    mutations: 0,
    describeCalls: 0,
    describe() {
      this.describeCalls += 1
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        value: {},
        revision: 1,
        user: undefined,
        applies: 'live',
      }]
    },
    async mutate() {
      this.mutations += 1
    },
  }
  return spy
}

// ---------------------------------------------------------------------------
// Plugin shape loads as a cordis plugin object
// ---------------------------------------------------------------------------
checkAsync('plugin module exposes name/inject/apply/Config', async () => {
  assert.equal(plugin.name, 'dsh-model-sync')
  assert.deepEqual([...plugin.inject].sort(), ['settings'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function', 'the Config schema is exported (settings-form registration)')
  assert.ok(plugin.Config['~standard'], 'Config validates through the standard-schema protocol (cordis resolveConfig)')
})

// ---------------------------------------------------------------------------
// Tripwire: the exact 0.1.3 bug shape must still be rejected by cordis.
// If this stops throwing, the gate below this test is vacuous — stop and
// re-derive the real-host failure mode before trusting this file.
// ---------------------------------------------------------------------------
await checkAsync('tripwire: bare ctx.commands read with deferred registry throws "without inject"', async () => {
  const root = makeRoot()
  await assert.rejects(
    async () => {
      await root.plugin({
        name: 'buggy-0.1.3-style',
        inject: ['settings'],
        apply(ctx) {
          const commands = ctx.commands // the bug itself — an undeclared foreign-service read
        },
      })
    },
    /without inject/,
  )
})

// ---------------------------------------------------------------------------
// The real plugin, real registry, deferred ordering (the 0.1.3 crash shape):
// mount first, registry comes up later — must not crash, and the dormant
// ctx.inject(['commands']) sub-fiber must register /model-sync once the
// service appears.
// ---------------------------------------------------------------------------
await checkAsync('boots without the registry, registers /model-sync when it appears', async () => {
  const root = makeRoot()
  await root.plugin(plugin, mountConfig()) // must not reject — 0.1.3 did, exactly here
  root.plugin(commandsPlugin)
  await new Promise((resolve) => setImmediate(resolve))
  const registered = root.get('commands').list().map((entry) => entry?.name ?? entry)
  assert.ok(
    registered.includes('model-sync'),
    `/model-sync expected in the real registry, got: ${JSON.stringify(registered)}`,
  )
  assert.equal(typeof root.get('modelSync')?.syncNow, 'function', 'modelSync service provided')
})

// ---------------------------------------------------------------------------
// Eager ordering: registry already up when the plugin mounts — registration
// is immediate.
// ---------------------------------------------------------------------------
await checkAsync('registers /model-sync immediately when the registry is already up', async () => {
  const root = makeRoot()
  root.plugin(commandsPlugin)
  await root.plugin(plugin, mountConfig())
  const registered = root.get('commands').list().map((entry) => entry?.name ?? entry)
  assert.ok(registered.includes('model-sync'), `/model-sync expected, got: ${JSON.stringify(registered)}`)
})

// ---------------------------------------------------------------------------
// Degraded host: no registry at all — plugin boots, keeps every other feature.
// ---------------------------------------------------------------------------
await checkAsync('boots with no registry ever appearing (optional peer stays dormant)', async () => {
  const root = makeRoot()
  await root.plugin(plugin, mountConfig())
  assert.equal(typeof root.get('modelSync')?.syncNow, 'function', 'modelSync service provided')
})

// ---------------------------------------------------------------------------
// Overlay degradation (dsh 0.1.2-alpha.3): no piAiCatalog service, a working
// llm seam — syncNow must return the patch-not-applied notice instead of
// throwing. Load-bearing since alpha.3: the hand patch cannot apply anymore
// (it shims settingsNamespace/installSettingsSection, both removed from
// dsh-settings), so every unpatched host takes exactly this path.
// ---------------------------------------------------------------------------
await checkAsync('overlay mode degrades with the patch-not-applied notice when piAiCatalog is absent', async () => {
  const root = makeRoot()
  root.provide('llm', {
    listProviders: () => [{ id: 'opencode-go' }],
    listModels: async () => [{ id: 'x' }],
  })
  await root.plugin(plugin, mountConfig())
  const report = await root.get('modelSync').syncNow()
  assert.ok(
    report.includes('remote-catalog patch is not applied'),
    `expected the degradation notice, got: ${JSON.stringify(report)}`,
  )
})

// ---------------------------------------------------------------------------
// Login-gate (credential seam absence / configured=false). The gate must:
//   - tolerate the seam being absent (seam is an optional peer)
//   - report `skipped — credential <REF> not configured` for every managed
//     route when the seam says `configured=false`, AND call settings.mutate
//     zero times (no fetch, no translate, no mutate)
//   - still pass the boot — the plugin itself does not register `credentials`
//     in `inject`, so its absence must not break plugin loading
// ---------------------------------------------------------------------------
//
// The settings-mode flow runs in `syncSettings` which reads the configured
// `managedRoutes`. The default config has `managedRoutes: []` → DEFAULT_ROUTES
// (all pi.dev routes). Keep the normal 120000ms timeout: the gate must skip
// fetch entirely, rather than depend on a short network timeout.

await checkAsync('seams absent → settings mode skips every route with zero mutations', async () => {
  const root = new Context()
  const settingsSpy = makeSpySettingsService()
  root.provide('settings', settingsSpy)
  // With both services absent, the gate reads process.env. Isolate the
  // managed references and restore them after disposing the startup timer.
  const refs = DEFAULT_ROUTES_LIST.map((route) => `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)
  const previous = refs.map((ref) => process.env[ref])
  const fiber = root.plugin(plugin, mountConfig({ writeMode: 'settings', startupDelaySeconds: 3600 }))
  try {
    for (const ref of refs) delete process.env[ref]
    await fiber
    assert.deepEqual([...plugin.inject].sort(), ['settings'])
    assert.equal(root.get('credentials'), undefined)
    assert.equal(root.get('launchEnvironment'), undefined)
    const report = await root.get('modelSync').syncNow()
    assert.deepEqual(report.split('\n'), DEFAULT_ROUTES_LIST.map((route, i) =>
      `${route}: skipped — credential ${refs[i]} not configured`))
    assert.equal(settingsSpy.mutations, 0)
    assert.equal(settingsSpy.describeCalls, 1, 'read the gate descriptor once per round')
  } finally {
    await fiber.dispose()
    refs.forEach((ref, i) => {
      if (previous[i] === undefined) delete process.env[ref]
      else process.env[ref] = previous[i]
    })
  }
})

await checkAsync('seam says configured=false → skipped report for every route, settings.mutate was NOT called', async () => {
  // Build the root with the settings SPY already in place — cordis services
  // are resolved at plugin mount, and `provide('settings', spy)` after mount
  // would not affect the plugin's captured reference.
  const root = new Context()
  const settingsSpy = makeSpySettingsService()
  root.provide('settings', settingsSpy)
  // Plant a credentials seam that says EVERY reference is unconfigured.
  // Mirrors llm-pi-ai's surface exactly (just the `describe` half the gate
  // reads); no other seam methods are touched.
  root.provide('credentials', {
    async describe() {
      return { configured: false }
    },
  })
  // An explicit empty snapshot isolates this test from shell exports.
  root.provide('launchEnvironment', { get: () => undefined })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('unexpected fetch in a skipped round')
  }
  const fiber = root.plugin(plugin, mountConfig({ writeMode: 'settings', startupDelaySeconds: 3600 }))
  try {
    await fiber
    const report = await root.get('modelSync').syncNow()
    assert.deepEqual(report.split('\n'), DEFAULT_ROUTES_LIST.map((route) =>
      `${route}: skipped — credential ${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY not configured`))
    assert.equal(fetchCalls, 0, 'gate short-circuit → zero fetch calls')
    assert.equal(settingsSpy.mutations, 0, 'gate short-circuit → zero settings.mutate calls')
    assert.equal(settingsSpy.describeCalls, 1, 'read the gate descriptor once per round')
  } finally {
    await fiber.dispose()
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// Settings mode, provider-native union: a mapped route with a resolvable
// credential folds its first-party /models listing into the write — additions
// only, and the native endpoint sees the resolved key. The models store is
// isolated under a throwaway HOME (fetchRemoteCatalog persists through the
// default-path singleton; a real HOME would be polluted).
// ---------------------------------------------------------------------------

/** The round's fetch double: pi.dev serves 2 glm entries, the first-party
 *  listing 3 ids (one pi.dev does not know). */
function makeUnionRoundFetch(log) {
  return async (url, init) => {
    const u = String(url)
    log.push({ url: u, headers: init?.headers ?? {} })
    if (u === 'https://pi.dev/api/models/providers/zai-coding-cn') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => [
          { id: 'glm-5.3', name: 'GLM 5.3', api: 'openai-completions', provider: 'zai-coding-cn', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', reasoning: true, input: ['text'] },
          { id: 'glm-5.2', name: 'GLM 5.2', api: 'openai-completions', provider: 'zai-coding-cn', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', reasoning: true, input: ['text'] },
        ],
      }
    }
    if (u === 'https://open.bigmodel.cn/api/coding/paas/v4/models') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }, { id: 'glm-5.3-flashx' }] }),
      }
    }
    throw new Error(`unexpected fetch ${u}`)
  }
}

await checkAsync('settings mode: provider-native union adds the first-party listing (default on)', async () => {
  const root = new Context()
  const settingsSpy = makeSpySettingsService()
  settingsSpy.mutate = async function (ns, ops) {
    this.mutations += 1
    this.lastOps = ops
  }
  root.provide('settings', settingsSpy)
  root.provide('credentials', {
    async describe() {
      return { configured: true }
    },
    async resolve(ref) {
      return ref === 'ZAI_CODING_CN_API_KEY' ? { value: 'native-key' } : undefined
    },
  })
  root.provide('launchEnvironment', { get: () => undefined })

  const originalFetch = globalThis.fetch
  const fetchLog = []
  globalThis.fetch = makeUnionRoundFetch(fetchLog)
  const realHome = process.env.HOME
  const scratchHome = mkdtempSync(join(tmpdir(), 'model-sync-native-'))
  process.env.HOME = scratchHome
  resetModelsStoreCache()
  const fiber = root.plugin(plugin, mountConfig({
    writeMode: 'settings',
    startupDelaySeconds: 3600,
    managedRoutes: ['zai-coding-cn'],
    keepBuiltinOnly: false,
    providerNativeFetch: true,
  }))
  try {
    await fiber
    const report = await root.get('modelSync').syncNow()
    assert.match(report, /provider-native added glm-5\.3-flashx/, `report: ${report}`)
    assert.equal(settingsSpy.mutations, 1, 'one write for the round')
    const ops = JSON.stringify(settingsSpy.lastOps)
    assert.match(ops, /glm-5\.3-flashx/, 'the native-only id reaches the write')
    assert.match(ops, /glm-5\.2/, 'the pi.dev id survives the union')
    const nativeCall = fetchLog.find((c) => c.url.includes('open.bigmodel.cn/api/coding/paas/v4/models'))
    assert.ok(nativeCall !== undefined, 'the first-party endpoint was hit')
    assert.equal(nativeCall.headers.authorization, 'Bearer native-key', 'resolved key on the native request')
  } finally {
    await fiber.dispose()
    globalThis.fetch = originalFetch
    process.env.HOME = realHome
    resetModelsStoreCache()
    rmSync(scratchHome, { recursive: true, force: true })
  }
})

await checkAsync('settings mode: providerNativeFetch=false keeps the old pi.dev-only round', async () => {
  const root = new Context()
  const settingsSpy = makeSpySettingsService()
  settingsSpy.mutate = async function (ns, ops) {
    this.mutations += 1
    this.lastOps = ops
  }
  root.provide('settings', settingsSpy)
  root.provide('credentials', {
    async describe() {
      return { configured: true }
    },
    async resolve() {
      return { value: 'native-key' }
    },
  })
  root.provide('launchEnvironment', { get: () => undefined })

  const originalFetch = globalThis.fetch
  const fetchLog = []
  globalThis.fetch = makeUnionRoundFetch(fetchLog)
  const realHome = process.env.HOME
  const scratchHome = mkdtempSync(join(tmpdir(), 'model-sync-native-'))
  process.env.HOME = scratchHome
  resetModelsStoreCache()
  const fiber = root.plugin(plugin, mountConfig({
    writeMode: 'settings',
    startupDelaySeconds: 3600,
    managedRoutes: ['zai-coding-cn'],
    keepBuiltinOnly: false,
    providerNativeFetch: false,
  }))
  try {
    await fiber
    const report = await root.get('modelSync').syncNow()
    assert.doesNotMatch(report, /provider-native/, `report: ${report}`)
    assert.equal(settingsSpy.mutations, 1)
    const ops = JSON.stringify(settingsSpy.lastOps)
    assert.doesNotMatch(ops, /flashx/, 'native-only id must not appear')
    assert.match(ops, /glm-5\.3/, 'pi.dev ids still written')
    assert.ok(fetchLog.every((c) => c.url.startsWith('https://pi.dev/')), 'only pi.dev was fetched')
  } finally {
    await fiber.dispose()
    globalThis.fetch = originalFetch
    process.env.HOME = realHome
    resetModelsStoreCache()
    rmSync(scratchHome, { recursive: true, force: true })
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

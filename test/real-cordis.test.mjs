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
import { Context } from '@deepseek-ai/cordis'
import commandsPlugin from '@deepseek-ai/dsh-commands'
import * as plugin from '../lib/index.js'
import { DEFAULT_ROUTES_LIST } from '../lib/index.js'

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

/** Idle config: no interval, one immediate (harmless) startup round. */
const config = {
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

/** A real cordis root with the `settings` seam provided, like dsh-base does. */
function makeRoot() {
  const root = new Context()
  root.provide('settings', {
    register: (namespace, schema) => ({ get: () => config, watch: () => {} }),
  })
  return root
}

/**
 * Settings seam spy: counts `mutate` calls so a test can prove the gate
 * short-circuited the whole pipeline (no fetch, no translate, no mutate).
 * Plug this in BEFORE mounting the plugin.
 *
 * `scopeValue` lets a test advertise a different `model-sync` config value
 * than the file-level `config` const (which is in `overlay` mode for the
 * legacy tests above). Default: `config`. Mutated before `root.plugin(...)`
 * so the closure built during register() already captures the override.
 */
function makeSpySettingsService(overrides = undefined) {
  const scopeValue = overrides !== undefined ? { ...config, ...overrides } : config
  const spy = {
    mutations: 0,
    describeCalls: 0,
    scopeValue,
    register() {
      const v = this.scopeValue
      return { get: () => v, watch: () => {} }
    },
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
checkAsync('plugin module exposes name/inject/apply', async () => {
  assert.equal(plugin.name, 'dsh-model-sync')
  assert.deepEqual([...plugin.inject].sort(), ['settings'])
  assert.equal(typeof plugin.apply, 'function')
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
  await root.plugin(plugin) // must not reject — 0.1.3 did, exactly here
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
  await root.plugin(plugin)
  const registered = root.get('commands').list().map((entry) => entry?.name ?? entry)
  assert.ok(registered.includes('model-sync'), `/model-sync expected, got: ${JSON.stringify(registered)}`)
})

// ---------------------------------------------------------------------------
// Degraded host: no registry at all — plugin boots, keeps every other feature.
// ---------------------------------------------------------------------------
await checkAsync('boots with no registry ever appearing (optional peer stays dormant)', async () => {
  const root = makeRoot()
  await root.plugin(plugin)
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
  await root.plugin(plugin)
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
//     route when the seam says `configured=false`, AND call settings.mustestate
//     zero times (no fetch, no translate, no mutate)
//   - still pass the boot — the plugin itself does not register `credentials`
//     in `inject`, so its absence must not break plugin loading
// ---------------------------------------------------------------------------
//
// The settings-mode flow runs in `syncSettings` which reads the configured
// `managedRoutes`. The default config has `managedRoutes: []` → DEFAULT_ROUTES
// (all pi.dev routes). The settings-mode pipeline then immediately calls
// `fetchRemoteCatalog` which would hit the network, so we cap the timeout to
// 1ms and rely on the gate short-circuiting first: the gate runs BEFORE the
// fetch, so on a "configured=false" host the fetch never fires.

await checkAsync('seam absent → plugin still loads, inject still == ["settings"], syncNow runs without crashing', async () => {
  const root = makeRoot()
  await root.plugin(plugin)
  // Sanity: inject must NOT be widened by adding `credentials` to it (the
  // handoff requires this assertion to keep working).
  assert.deepEqual([...plugin.inject].sort(), ['settings'])
  // Provide no `credentials` and no `launchEnvironment` — the gate must fall
  // through to the launch-env path; the helper there has no way to find the
  // ref, so every DEFAULT_ROUTES entry emits a skipped line. No crash.
  const report = await root.get('modelSync').syncNow()
  assert.equal(typeof report, 'string', 'syncNow returned a string report')
})

await checkAsync('seam says configured=false → skipped report for every route, settings.mutate was NOT called', async () => {
  // Build the root with the settings SPY already in place — cordis services
  // are resolved at plugin mount, and `provide('settings', spy)` after mount
  // would not affect the plugin's captured reference.
  const root = new Context()
  const settingsSpy = makeSpySettingsService({ writeMode: 'settings' })
  root.provide('settings', settingsSpy)
  // Plant a credentials seam that says EVERY reference is unconfigured.
  // Mirrors llm-pi-ai's surface exactly (just the `describe` half the gate
  // reads); no other seam methods are touched.
  root.provide('credentials', {
    async describe() {
      return { configured: false }
    },
  })
  await root.plugin(plugin)
  const report = await root.get('modelSync').syncNow()
  // Every DEFAULT_ROUTES entry should appear in the report, marked skipped.
  for (const route of DEFAULT_ROUTES_LIST) {
    assert.ok(
      report.includes(`${route}: skipped — credential`),
      `expected skipped line for ${route}, got: ${JSON.stringify(report)}`,
    )
  }
  assert.equal(settingsSpy.mutations, 0, 'gate short-circuit → zero settings.mutate calls')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

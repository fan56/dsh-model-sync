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
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

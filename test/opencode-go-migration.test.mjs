// P1d-1 pure gate tests (design §14.6 / §14.7, V18/V24): migration-state
// detection from section fingerprints + the full routeWriter priority matrix.
// No settings service, no network, no timers — every input is a plain object.

import assert from 'node:assert/strict'
import {
  appliedFingerprintOf,
  fingerprintGoIdentity,
  fingerprintSection,
  readGoProviderSections,
  fingerprintGoRoutes,
  migrationStateOf,
  migrationStatusOf,
  routeWriter,
  isGoRoute,
  MIGRATION_GATE_HINT,
} from '../lib/opencode-go-migration.js'

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

const desc = (providers) => ({ ns: 'llm-pi-ai', revision: 1, user: { providers } })
const abs = (appliedFingerprint, extra = {}) => ({ state: 'applied', fingerprint: appliedFingerprint, appliedFingerprint, applying: false, ...extra })
const status = (state, extra = {}) => ({ state, fingerprint: 'fp', applying: false, ...extra })

// ---------------------------------------------------------------------------
// Fingerprint + state detection
// ---------------------------------------------------------------------------

check('fingerprintSection is canonical (key order independent) and stable', () => {
  const a = { b: 1, a: [2, { d: 4, c: 3 }] }
  const b = { a: [2, { c: 3, d: 4 }], b: 1 }
  assert.equal(fingerprintSection(a), fingerprintSection(b))
  assert.equal(fingerprintSection(a), fingerprintSection(structuredClone(a)))
  assert.notEqual(fingerprintSection(a), fingerprintSection({ ...a, b: 2 }))
  assert.match(fingerprintSection(a), /^[0-9a-f]{64}$/)
})

check('readGoProviderSections picks only opencode-go* sections that exist', () => {
  const sections = readGoProviderSections(desc({
    'opencode-go': { models: [{ id: 'x' }] },
    'opencode-go-msg': { api: 'anthropic-messages' },
    'other-route': { models: [] },
  }))
  assert.deepEqual(Object.keys(sections).sort(), ['opencode-go', 'opencode-go-msg'])
  assert.equal(fingerprintGoRoutes(desc({ 'other-route': {} })), fingerprintSection({}), 'no go routes → empty fingerprint')
})

check('state detection: absent / legacy-inherit / legacy-inline / applied / drifted', () => {
  assert.equal(migrationStateOf(undefined, undefined), 'absent')
  assert.equal(migrationStateOf({}, undefined), 'absent')
  assert.equal(migrationStateOf({ 'opencode-go': { apiKeyEnv: 'K' } }, undefined), 'legacy-inherit')
  assert.equal(migrationStateOf({ 'opencode-go': { models: [{ id: 'custom' }] } }, undefined), 'legacy-inline')

  const section = { 'opencode-go': { models: [{ id: 'custom' }] } }
  const appliedFingerprint = fingerprintSection(section)
  assert.equal(migrationStateOf(section, { appliedFingerprint }), 'applied')
  assert.equal(migrationStateOf(section, { legacyFingerprint: appliedFingerprint }), 'legacy-inline')
  assert.equal(
    migrationStateOf(section, { appliedFingerprint: 'old', legacyFingerprint: 'older' }),
    'drifted',
    'fingerprint matching neither applied nor legacy → drifted',
  )

  const full = migrationStatusOf(desc(section), { appliedFingerprint, applying: true })
  assert.equal(full.state, 'applied')
  assert.equal(full.fingerprint, appliedFingerprint)
  assert.equal(full.applying, true)
})

// ---------------------------------------------------------------------------
// routeWriter matrix: state × enabled × caller (§14.7.1 / V24)
// ---------------------------------------------------------------------------

const ROUTE = 'opencode-go'
const appliedFp = 'applied-fp'

check('go.enabled + applied + matching fingerprint → go writer may write (all callers)', () => {
  const m = abs(appliedFp)
  const cfg = { caller: 'go', goEnabled: true }
  const d = routeWriter(ROUTE, cfg, m)
  assert.equal(d.decision, 'write')
  assert.equal(d.owner, 'go')
  assert.match(d.reason, /fingerprint matched/)

  for (const route of ['opencode-go-msg', 'opencode-go-resp', 'opencode-go-google']) {
    assert.equal(routeWriter(route, cfg, m).decision, 'write', `${route} also go-owned`)
  }
})

check('go.enabled + applied but fingerprint MISMATCH → skip (gate not released)', () => {
  const m = { state: 'applied', fingerprint: 'different', appliedFingerprint: appliedFp, applying: false }
  const d = routeWriter(ROUTE, { caller: 'go', goEnabled: true }, m)
  assert.equal(d.decision, 'skip')
  assert.equal(d.owner, 'none')
  assert.match(d.reason, /migration gate|fingerprint/)
})

check('go.enabled + absent → go writer may write (no pre-existing section)', () => {
  const d = routeWriter(ROUTE, { caller: 'go', goEnabled: true }, status('absent'))
  assert.equal(d.decision, 'write')
  assert.equal(d.owner, 'go')
})

check('go.enabled + legacy-inherit / legacy-inline / drifted → skip for the go writer', () => {
  for (const state of ['legacy-inherit', 'legacy-inline', 'drifted']) {
    const d = routeWriter(ROUTE, { caller: 'go', goEnabled: true }, status(state))
    assert.equal(d.decision, 'skip', state)
    assert.equal(d.owner, 'none', state)
    assert.ok(d.reason.includes(MIGRATION_GATE_HINT), `${state} report carries the fixed migration hint`)
  }
})

check('go.enabled + ANY state + legacy pi.dev caller → skip go routes (single writer, never take over)', () => {
  for (const state of ['absent', 'applied', 'legacy-inherit', 'legacy-inline', 'drifted']) {
    const m = state === 'applied' ? abs(appliedFp) : status(state)
    for (const caller of ['pi.dev', 'zen']) {
      const d = routeWriter(ROUTE, { caller, goEnabled: true }, m)
      assert.equal(d.decision, 'skip', `${state}/${caller}`)
      assert.equal(d.owner, 'go', `${state}/${caller} — report names the go owner`)
      assert.match(d.reason, /skipped-route-owner/)
    }
  }
})

check('go.enabled + applying → skip even for the go writer (M-5)', () => {
  const d = routeWriter(ROUTE, { caller: 'go', goEnabled: true }, { ...abs(appliedFp), applying: true })
  assert.equal(d.decision, 'skip')
  assert.equal(d.owner, 'none')
  assert.match(d.reason, /applying/)
})

check('go.enabled=false restores v0.9.0: legacy pi.dev owns go routes', () => {
  for (const state of ['absent', 'legacy-inherit', 'legacy-inline', 'drifted']) {
    const d = routeWriter(ROUTE, { caller: 'pi.dev', goEnabled: false }, status(state))
    assert.equal(d.decision, 'write', state)
    assert.equal(d.owner, 'pi.dev', state)
  }
})

check('non-go routes are unaffected by the migration gate or go.enabled', () => {
  for (const goEnabled of [true, false]) {
    for (const state of ['legacy-inherit', 'legacy-inline', 'drifted']) {
      const d = routeWriter('zai-coding-cn', { caller: 'pi.dev', goEnabled }, status(state))
      assert.equal(d.decision, 'write')
      assert.equal(d.owner, 'pi.dev')
    }
  }
})

check('zen routes mode: only the zen writer owns zen routes; migration gate does not leak to them', () => {
  const cfg = { caller: 'pi.dev', goEnabled: true, zenMode: 'routes' }
  const d = routeWriter('opencode-zen', cfg, status('drifted'))
  assert.equal(d.decision, 'skip')
  assert.equal(d.owner, 'zen')
  const own = routeWriter('opencode-zen', { ...cfg, caller: 'zen' }, status('drifted'))
  assert.equal(own.decision, 'write')
  assert.equal(own.owner, 'zen')
})

check('isGoRoute recognises default and custom route ids', () => {
  assert.equal(isGoRoute('opencode-go'), true)
  assert.equal(isGoRoute('opencode-go-custom'), true)
  assert.equal(isGoRoute('opencode-zen'), false)
  assert.equal(isGoRoute('opencode-zen', ['opencode-zen']), true)
})

// ---------------------------------------------------------------------------
// §14.7.4 two-level fingerprint: identity-only drift + self-heal
// ---------------------------------------------------------------------------

check('identity fingerprint covers only api/baseURL/displayName/apiKeyEnv, not models', () => {
  const base = { 'opencode-go': { api: 'openai', baseURL: 'u', displayName: 'd', apiKeyEnv: 'K' } }
  const withModels = {
    'opencode-go': {
      api: 'openai', baseURL: 'u', displayName: 'd', apiKeyEnv: 'K',
      models: [{ id: 'a', name: 'A', contextWindow: 8192, maxTokens: 100, input: ['text'], reasoningEfforts: ['low'], compat: {} }],
      modelOverrides: { a: { displayName: 'user' } },
    },
  }
  const reordered = { 'opencode-go': { apiKeyEnv: 'K', displayName: 'd', baseURL: 'u', api: 'openai' } }
  assert.equal(fingerprintGoIdentity(base), fingerprintGoIdentity(withModels), 'models edits never change identity')
  assert.equal(fingerprintGoIdentity(base), fingerprintGoIdentity(reordered), 'key order irrelevant')
  assert.notEqual(fingerprintGoIdentity(base), fingerprintGoIdentity({ 'opencode-go': { ...base['opencode-go'], api: 'anthropic' } }), 'api edit changes identity')
  const newFp = appliedFingerprintOf(fingerprintGoIdentity(base), { 'opencode-go': ['b', 'a'] })
  assert.notEqual(newFp, appliedFingerprintOf(fingerprintGoIdentity(base), { 'opencode-go': ['a', 'b'] }), 'managed ids are canonical-sorted')
})

check('applied record with identity match stays applied after models edit; identity edit → drifted', () => {
  const identity = fingerprintGoIdentity({ 'opencode-go': { api: 'openai', apiKeyEnv: 'K' } })
  const record = {
    appliedIdentity: identity,
    appliedManagedIds: { 'opencode-go': ['a'] },
    appliedFingerprint: appliedFingerprintOf(identity, { 'opencode-go': ['a'] }),
  }
  const sameIdentityNewModels = { 'opencode-go': { api: 'openai', apiKeyEnv: 'K', models: [{ id: 'z', name: 'Z' }] } }
  assert.equal(migrationStateOf(sameIdentityNewModels, record), 'applied', 'models edit does not close the gate')
  const changedIdentity = { 'opencode-go': { api: 'anthropic', apiKeyEnv: 'K', models: [{ id: 'z' }] } }
  assert.equal(migrationStateOf(changedIdentity, record), 'drifted', 'identity edit closes the gate')

  const cfg = { caller: 'go', goEnabled: true }
  assert.equal(routeWriter('opencode-go', cfg, migrationStatusOf(desc(sameIdentityNewModels), record)).decision, 'write')
  assert.equal(routeWriter('opencode-go', cfg, migrationStatusOf(desc(changedIdentity), record)).decision, 'skip')
})

check('self-heal: identity match with stale appliedFingerprint marks fingerprintHealed and computes the repair value', () => {
  const sections = { 'opencode-go': { api: 'openai', apiKeyEnv: 'K' } }
  const identity = fingerprintGoIdentity(sections)
  const managed = { 'opencode-go': ['a', 'b'] }
  const expected = appliedFingerprintOf(identity, managed)
  const record = { appliedIdentity: identity, appliedManagedIds: managed, appliedFingerprint: 'stale' }
  const live = migrationStatusOf(desc(sections), record, undefined, managed)
  assert.equal(live.state, 'applied')
  assert.equal(live.fingerprintHealed, true)
  assert.equal(live.expectedFingerprint, expected)
  const consistent = migrationStatusOf(desc(sections), { ...record, appliedFingerprint: expected }, undefined, managed)
  assert.equal(consistent.fingerprintHealed, false)
  const editedIdentity = migrationStatusOf(
    desc({ 'opencode-go': { api: 'anthropic', apiKeyEnv: 'K' } }), record, undefined, managed,
  )
  assert.equal(editedIdentity.fingerprintHealed, false, 'identity drift is not a heal case')
  assert.equal(editedIdentity.state, 'drifted')
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

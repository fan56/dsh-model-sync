// P0 diagnostic: read-only profile extraction, structured diff report and
// end-to-end orchestration with an injected fetch (no network, no writes).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  readGoRoutesFromDescriptor,
  buildGoDiagnosticReport,
  formatGoDiagnosticReport,
  runGoDiagnostic,
} from '../lib/opencode-go-diagnose.js'
import { parseGoModelsPayload, computeGoPayloadHash } from '../lib/opencode-go-source.js'
import { groupGoModelsByProtocol } from '../lib/opencode-go-grouping.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))
const entries = parseGoModelsPayload(fixture)

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

const descriptor = (providers) => ({ user: { providers } })
const okSource = { ok: true, entries, authStatus: 'ok', keyFingerprint: 'abc123', payloadHash: computeGoPayloadHash(entries), observedAt: 1 }

// ---------------------------------------------------------------------------
// Read-only profile extraction
// ---------------------------------------------------------------------------
check('readGoRoutesFromDescriptor: four default slots, empty when unconfigured', () => {
  const routes = readGoRoutesFromDescriptor(undefined)
  assert.deepEqual(routes.map((r) => r.route), [
    'opencode-go', 'opencode-go-msg', 'opencode-go-resp', 'opencode-go-google',
  ])
  assert.deepEqual(routes.map((r) => r.slot), ['chat', 'msg', 'resp', 'google'])
  for (const route of routes) assert.deepEqual(route.configuredIds, [])
})

check('readGoRoutesFromDescriptor: reads model ids, tolerates malformed entries', () => {
  const routes = readGoRoutesFromDescriptor(descriptor({
    'opencode-go': { models: [{ id: 'keep' }, { name: 'no id' }, 42] },
    'opencode-go-msg': { models: [{ id: 'qwen4-max' }] },
    'opencode-go-google': { models: [{ id: 'gemini-4-argon' }] },
  }))
  assert.deepEqual(routes[0].configuredIds, ['keep'])
  assert.deepEqual(routes[1].configuredIds, ['qwen4-max'])
  assert.deepEqual(routes[2].configuredIds, [])
  assert.deepEqual(routes[3].configuredIds, ['gemini-4-argon'])
})

check('readGoRoutesFromDescriptor: includes extra opencode-go* routes only for known suffixes', () => {
  const routes = readGoRoutesFromDescriptor(descriptor({
    'opencode-go-experimental': { models: [{ id: 'x' }] },
    'opencode-go-resp': { models: [] },
    unrelated: { models: [{ id: 'y' }] },
  }))
  assert.equal(routes.some((r) => r.route === 'opencode-go-experimental'), false)
  assert.equal(routes.some((r) => r.route === 'unrelated'), false)
})

// ---------------------------------------------------------------------------
// Structured diff report
// ---------------------------------------------------------------------------
check('report: added/missing per slot, protocol ownership, entitlement status', () => {
  const grouping = groupGoModelsByProtocol(entries)
  const report = buildGoDiagnosticReport({
    source: okSource,
    grouping,
    routes: readGoRoutesFromDescriptor(descriptor({
      'opencode-go': { models: [{ id: 'deepseek-v4.1-flash' }, { id: 'retired-id' }] },
      'opencode-go-msg': { models: [{ id: 'qwen4-max' }] },
    })),
    generatedAt: 42,
  })
  assert.equal(report.source, 'opencode-go-official')
  assert.equal(report.generatedAt, 42)
  assert.equal(report.authStatus, 'ok')
  assert.equal(report.keyFingerprint, 'abc123')
  assert.equal(report.payloadHash, okSource.payloadHash)

  const chat = report.routes.find((r) => r.slot === 'chat')
  assert.deepEqual(chat.official, ['deepseek-v4.1-flash'])
  assert.deepEqual(chat.configured, ['deepseek-v4.1-flash', 'retired-id'])
  assert.deepEqual(chat.added, [])
  assert.deepEqual(chat.missing, ['retired-id'])
  const msg = report.routes.find((r) => r.slot === 'msg')
  assert.deepEqual(msg.official, ['qwen4-max'])
  const resp = report.routes.find((r) => r.slot === 'resp')
  assert.deepEqual(resp.official, ['grok-4.7'])
  assert.deepEqual(resp.added, ['grok-4.7'])
  const google = report.routes.find((r) => r.slot === 'google')
  assert.deepEqual(google.official, ['gemini-4-argon'])
  assert.deepEqual(google.added, ['gemini-4-argon'])
})

check('report: failed source suppresses the misleading missing list', () => {
  const failedSource = {
    ok: false, entries: [], authStatus: 'invalid', keyFingerprint: 'fingerprint',
    observedAt: 5, error: { kind: 'auth', status: 401, message: 'expired' },
  }
  const report = buildGoDiagnosticReport({
    source: failedSource,
    grouping: groupGoModelsByProtocol([]),
    routes: readGoRoutesFromDescriptor(descriptor({
      'opencode-go': { models: [{ id: 'old-1' }, { id: 'old-2' }] },
    })),
  })
  assert.equal(report.authStatus, 'invalid')
  assert.deepEqual(report.error, failedSource.error)
  const chat = report.routes.find((r) => r.slot === 'chat')
  assert.deepEqual(chat.configured, ['old-1', 'old-2'])
  assert.deepEqual(chat.official, [])
  assert.deepEqual(chat.added, [])
  assert.deepEqual(chat.missing, [], 'do not call configured models "missing" after a failed read')
})

check('format: readable lines carry status, route diffs and unassigned ids', () => {
  const report = buildGoDiagnosticReport({
    source: okSource,
    grouping: {
      slots: { chat: ['a'], msg: [], resp: [], google: [] },
      unassigned: [{ id: 'weird', protocols: ['x'], reason: 'unknown-protocol' }],
    },
    routes: readGoRoutesFromDescriptor(descriptor({ 'opencode-go': { models: [{ id: 'a' }, { id: 'b' }] } })),
  })
  const text = formatGoDiagnosticReport(report)
  assert.match(text, /read-only; no settings written/)
  assert.match(text, /authStatus: ok/)
  assert.match(text, /keyFingerprint: abc123/)
  assert.match(text, /opencode-go \[chat\].*\+none.*-b/)
  assert.match(text, /unassigned: weird \(unknown-protocol\)/)
})

// ---------------------------------------------------------------------------
// Orchestration (injected fetch, zero writes)
// ---------------------------------------------------------------------------
await checkAsync('runGoDiagnostic: fixtures in, structured report out, no settings object given', async () => {
  let calls = 0
  const report = await runGoDiagnostic({
    apiKey: 'sk-fixture',
    descriptor: descriptor({
      'opencode-go': { models: [{ id: 'deepseek-v4.1-flash' }, { id: 'legacy-only' }] },
      'opencode-go-resp': { models: [{ id: 'grok-4.7' }] },
    }),
    generatedAt: 99,
    fetchImpl: async () => { calls += 1; return { status: 200, json: async () => fixture } },
  })
  assert.equal(calls, 1)
  assert.equal(report.authStatus, 'ok')
  assert.equal(report.generatedAt, 99)
  const chat = report.routes.find((r) => r.slot === 'chat')
  assert.deepEqual(chat.added, [])
  assert.deepEqual(chat.missing, ['legacy-only'])
  const resp = report.routes.find((r) => r.slot === 'resp')
  assert.deepEqual(resp.added, [])
  assert.deepEqual(resp.configured, ['grok-4.7'])
})

await checkAsync('runGoDiagnostic with no key: no fetch, no-key status in report', async () => {
  let calls = 0
  const report = await runGoDiagnostic({
    descriptor: descriptor({ 'opencode-go': { models: [{ id: 'old' }] } }),
    fetchImpl: async () => { calls += 1; throw new Error('unexpected') },
  })
  assert.equal(calls, 0)
  assert.equal(report.authStatus, 'unknown')
  assert.equal(report.error.kind, 'no-key')
  assert.deepEqual(report.routes.find((r) => r.slot === 'chat').missing, [])
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

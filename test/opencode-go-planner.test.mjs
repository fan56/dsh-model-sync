// P1a offline tests: config schema defaults + pure route planner.
// All fixtures are in-memory; no network, settings, credentials or timers.

import assert from 'node:assert/strict'
import { Config } from '../lib/index.js'
import {
  OPENCODE_GO_MODELS_URL,
  OPENCODE_GO_DEFAULT_INTERVAL_MINUTES,
  computeGoPayloadHash,
  parseGoModelsPayload,
} from '../lib/opencode-go-source.js'
import { deriveKeyRef } from '../lib/route-credential.js'
import {
  GO_BASE_URL_BY_SLOT,
  goOwnershipKey,
  normalizeGoBaseUrl,
  planGoRouteFields,
  planGoRoutes,
  profileHash,
} from '../lib/opencode-go-planner.js'

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_BASE = 'https://opencode.ai/inference/go/openai/v1'
const MSG_BASE_OFFICIAL = 'https://opencode.ai/inference/go/anthropic/v1'
const RESP_BASE = 'https://opencode.ai/inference/go/openai/v1'
const GOOGLE_BASE = 'https://opencode.ai/inference/go/google/v1beta'

const record = (id, protocols, options = {}) => ({
  id,
  name: options.name ?? id,
  protocols,
  baseUrls: options.baseUrls ?? {},
  inputModalities: options.inputModalities ?? ['text'],
  provenance: 'go-official',
  ...(options.recommendedProtocol !== undefined ? { recommendedProtocol: options.recommendedProtocol } : {}),
  ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
})

const chatEntry = (id) => record(id, ['chat-completions'], { baseUrls: { 'chat-completions': CHAT_BASE } })
const msgEntry = (id) => record(id, ['messages'], { baseUrls: { messages: MSG_BASE_OFFICIAL } })
const respEntry = (id) => record(id, ['responses'], { baseUrls: { responses: RESP_BASE } })
const googleEntry = (id) => record(id, ['interactions'], { baseUrls: { interactions: GOOGLE_BASE } })

const profile = (id) => ({ id, name: id })
const routeState = (models = [], extra = {}) => ({ exists: true, models, ...extra })
const plan = (entries, overrides = {}) => planGoRoutes({
  keyFingerprint: 'keyfp',
  entries,
  currentRoutes: {},
  ownership: {},
  ...overrides,
})
const codes = (result) => result.report.map((entry) => entry.code)

// ---------------------------------------------------------------------------
// Config schema (design §6.2.6, P0 constants)
// ---------------------------------------------------------------------------

check('schema: go defaults are byte-for-byte the P0 constants', () => {
  const config = Config({})
  assert.equal(config.opencode.go.enabled.get(), false)
  assert.equal(config.opencode.go.ref.get(), deriveKeyRef('opencode-go'))
  assert.equal(config.opencode.go.ref.get(), 'OPENCODE_GO_API_KEY')
  assert.equal(config.opencode.go.modelsUrl.get(), OPENCODE_GO_MODELS_URL)
  assert.equal(config.opencode.go.modelsUrl.get(), 'https://opencode.ai/inference/go/v1/models')
  assert.equal(config.opencode.go.intervalMinutes.get(), 60)
  assert.equal(config.opencode.go.intervalMinutes.get(), OPENCODE_GO_DEFAULT_INTERVAL_MINUTES)
})

check('schema: go write-side defaults and route ids', () => {
  const config = Config({})
  assert.equal(config.opencode.go.adoptExisting.get(), false)
  assert.deepEqual(config.opencode.go.pinnedModels.get(), [])
  assert.equal(config.opencode.go.routes.chat.get(), 'opencode-go')
  assert.equal(config.opencode.go.routes.msg.get(), 'opencode-go-msg')
  assert.equal(config.opencode.go.routes.resp.get(), 'opencode-go-resp')
  assert.equal(config.opencode.go.routes.google.get(), 'opencode-go-google')
  assert.equal(config.opencode.go.confirmRemovals.get(), 2)
  assert.equal(config.opencode.go.compatEnrichment.get(), true)
})

check('schema: zen defaults to login-only with no modelsUrl', () => {
  const config = Config({})
  assert.equal(config.opencode.zen.enabled.get(), true)
  assert.equal(config.opencode.zen.ref.get(), 'OPENCODE_API_KEY')
  assert.equal(config.opencode.zen.mode.get(), 'login-only')
  assert.equal(config.opencode.zen.modelsUrl.get(), undefined)
  assert.equal(config.opencode.zen.seedFromBuiltin.get(), false)
  assert.equal(config.opencode.zen.routes.chat.get(), 'opencode-zen')
  assert.equal(config.opencode.zen.routes.msg.get(), 'opencode-zen-msg')
  assert.equal(config.opencode.zen.routes.resp.get(), 'opencode-zen-resp')
})

check('schema: user overrides win, unspecified leaves keep defaults', () => {
  const config = Config({ opencode: { go: { enabled: true, ref: 'CUSTOM_GO_KEY' } } })
  assert.equal(config.opencode.go.enabled.get(), true)
  assert.equal(config.opencode.go.ref.get(), 'CUSTOM_GO_KEY')
  assert.equal(config.opencode.go.modelsUrl.get(), OPENCODE_GO_MODELS_URL)
})

// ---------------------------------------------------------------------------
// Grouping branches (§6.2.3)
// ---------------------------------------------------------------------------

check('grouping: chat-completions wins over another protocol', () => {
  const result = plan([record('multi', ['messages', 'chat-completions'], { recommendedProtocol: 'messages' })])
  const chat = result.routes.find((route) => route.slot === 'chat')
  assert.deepEqual(chat.models.map((model) => model.id), ['multi'])
  assert.equal(result.routes.some((route) => route.slot === 'msg'), false)
})

check('grouping: messages-only → opencode-go-msg, responses-only → opencode-go-resp', () => {
  const result = plan([msgEntry('qwen4-max'), respEntry('grok-4.7')])
  const msg = result.routes.find((route) => route.slot === 'msg')
  const resp = result.routes.find((route) => route.slot === 'resp')
  assert.equal(msg.route, 'opencode-go-msg')
  assert.deepEqual(msg.models.map((model) => model.id), ['qwen4-max'])
  assert.equal(resp.route, 'opencode-go-resp')
  assert.deepEqual(resp.models.map((model) => model.id), ['grok-4.7'])
})

check('grouping: google slot is conditional and default-off', () => {
  const withoutGoogle = plan([chatEntry('hy4')])
  assert.equal(withoutGoogle.routes.some((route) => route.slot === 'google'), false)

  const withGoogle = plan([chatEntry('hy4'), googleEntry('gemini-x')])
  const google = withGoogle.routes.find((route) => route.slot === 'google')
  assert.equal(google.route, 'opencode-go-google')
  assert.deepEqual(google.models.map((model) => model.id), ['gemini-x'])
  assert.equal(google.fields.api, 'google-generative-ai')
  assert.equal(google.fields.baseURL, GOOGLE_BASE)
})

check('grouping: unknown protocol is fail-closed and reported', () => {
  const result = plan([chatEntry('hy4'), record('mystery', ['telepathy'])])
  assert.deepEqual(codes(result), ['unknown-protocol', 'added'])
  assert.equal(result.routes.every((route) => !route.models.some((model) => model.id === 'mystery')), true)
})

check('grouping: unsupported multi-protocol without recommendation is reported', () => {
  const result = plan([record('mixed', ['messages', 'responses'])])
  assert.deepEqual(codes(result), ['unsupported-protocol'])
  assert.deepEqual(result.routes, [])
})

// ---------------------------------------------------------------------------
// Route fields (§2.1 / §6.2.2 / report 19)
// ---------------------------------------------------------------------------

check('route fields: chat/msg/resp api, baseURL and displayName match report 19', () => {
  const result = plan([chatEntry('hy4'), msgEntry('qwen4-max'), respEntry('grok-4.7')])
  const chat = result.routes.find((route) => route.slot === 'chat')
  const msg = result.routes.find((route) => route.slot === 'msg')
  const resp = result.routes.find((route) => route.slot === 'resp')
  assert.deepEqual(
    [chat.fields.api, chat.fields.baseURL, chat.fields.displayName],
    ['openai-completions', CHAT_BASE, 'OpenCode Go'],
  )
  assert.deepEqual(
    [msg.fields.api, msg.fields.baseURL, msg.fields.displayName],
    ['anthropic-messages', 'https://opencode.ai/inference/go/anthropic', 'OpenCode Go · msg'],
  )
  assert.deepEqual(
    [resp.fields.api, resp.fields.baseURL, resp.fields.displayName],
    ['openai-responses', RESP_BASE, 'OpenCode Go · resp'],
  )
  for (const route of result.routes) {
    assert.equal(route.fields.apiKeyEnv, 'OPENCODE_GO_API_KEY')
  }
})

check('route fields: msg baseURL normalization strips exactly the trailing /v1', () => {
  assert.equal(normalizeGoBaseUrl(MSG_BASE_OFFICIAL, 'msg'), 'https://opencode.ai/inference/go/anthropic')
  assert.equal(normalizeGoBaseUrl('https://opencode.ai/inference/go/anthropic', 'msg'), 'https://opencode.ai/inference/go/anthropic')
  assert.equal(normalizeGoBaseUrl(CHAT_BASE, 'chat'), CHAT_BASE)
})

check('route fields: configured ref overrides apiKeyEnv on every route', () => {
  const result = plan([chatEntry('hy4')], { ref: 'CUSTOM_GO_KEY' })
  assert.equal(result.routes[0].fields.apiKeyEnv, 'CUSTOM_GO_KEY')
})

check('route fields: fallback baseURL is used when payload has none', () => {
  const fields = planGoRouteFields('msg', [])
  assert.equal(fields.baseURL, GO_BASE_URL_BY_SLOT.msg)
})

// ---------------------------------------------------------------------------
// Conflicts and keep-the-name (§9.2 / §9.3)
// ---------------------------------------------------------------------------

check('conflict: incompatible existing route is skipped, not renamed or overwritten', () => {
  const result = plan([chatEntry('hy4'), msgEntry('qwen4-max')], {
    currentRoutes: {
      'opencode-go': routeState([profile('old')], { api: 'anthropic-messages' }),
    },
  })
  assert.equal(result.conflicts.length, 1)
  assert.deepEqual(
    [result.conflicts[0].route, result.conflicts[0].field, result.conflicts[0].actual],
    ['opencode-go', 'api', 'anthropic-messages'],
  )
  assert.equal(result.routes.some((route) => route.route === 'opencode-go'), false)
  assert.equal(result.routes.some((route) => route.route === 'opencode-go-msg'), true)
  assert.equal(codes(result).includes('route-conflict'), true)
})

check('conflict: a route that only lacks fields is compatible (no conflict)', () => {
  const result = plan([chatEntry('hy4')], {
    currentRoutes: { 'opencode-go': routeState([profile('old')], { exists: true }) },
  })
  assert.equal(result.conflicts.length, 0)
  assert.equal(result.routes[0].route, 'opencode-go')
})

check('keep-the-name: default route ids are used without rename', () => {
  const result = plan([chatEntry('a'), msgEntry('b'), respEntry('c')])
  assert.deepEqual(result.routes.map((route) => route.route), ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
})

// ---------------------------------------------------------------------------
// Empty routes (§9.4)
// ---------------------------------------------------------------------------

check('empty route: fully managed empty slot → unset, never models: []', () => {
  const current = [profile('qwen4-max')]
  const fields = planGoRouteFields('msg', [])
  const result = plan([chatEntry('hy4')], {
    currentRoutes: { 'opencode-go-msg': routeState(current) },
    ownership: {
      [goOwnershipKey('opencode-go-msg', 'keyfp')]: {
        routeFields: fields,
        managed: { 'qwen4-max': { hash: profileHash(current[0]) } },
      },
    },
  })
  const msg = result.routes.find((route) => route.slot === 'msg')
  assert.equal(msg.unset, true)
  assert.equal(msg.skip, false)
  assert.deepEqual(result.unsetRoutes, ['opencode-go-msg'])
  assert.equal(result.routes.every((route) => !(route.skip === false && !route.unset && route.models.length === 0)), true)
})

check('empty route: user content → keep, report, no empty write', () => {
  const result = plan([chatEntry('hy4')], {
    currentRoutes: { 'opencode-go-msg': routeState([profile('user-model')]) },
  })
  const msg = result.routes.find((route) => route.slot === 'msg')
  assert.equal(msg.unset, false)
  assert.equal(msg.skip, true)
  assert.deepEqual(msg.models, [profile('user-model')])
  assert.equal(codes(result).includes('route-empty-has-user-content'), true)
})

check('empty route: empty main route after 200 keeps last-good', () => {
  const result = plan([msgEntry('qwen4-max')], {
    currentRoutes: { 'opencode-go': routeState([profile('deepseek-v4.1-flash'), profile('hy4')]) },
  })
  const chat = result.routes.find((route) => route.slot === 'chat')
  assert.equal(chat.skip, true)
  assert.equal(chat.unset, false)
  assert.equal(codes(result).includes('upstream-empty'), true)
})

// ---------------------------------------------------------------------------
// Deletion gates (three gates, tested one at a time)
// ---------------------------------------------------------------------------

const deletionScenario = (extra = {}) => {
  const keep = profile('keep-a')
  const drop = profile('drop-b')
  const current = [keep, drop]
  const managed = {
    'keep-a': { hash: profileHash(keep) },
    'drop-b': { hash: profileHash(drop) },
  }
  if (extra.dropManaged === false) delete managed['drop-b']
  if (extra.dropHash !== undefined) managed['drop-b'] = { hash: extra.dropHash }
  const result = plan([chatEntry('keep-a')], {
    currentRoutes: {
      'opencode-go': routeState(current, {
        ...(extra.overrideIds !== undefined ? { overrideIds: extra.overrideIds } : {}),
      }),
    },
    ownership: { [goOwnershipKey('opencode-go', 'keyfp')]: { managed } },
    ...(extra.pinnedModels !== undefined ? { pinnedModels: extra.pinnedModels } : {}),
  })
  return { result, ids: result.routes[0].models.map((model) => model.id) }
}

check('deletion gate 1/3: not in ledger → kept and reported', () => {
  const { result, ids } = deletionScenario({ dropManaged: false })
  assert.deepEqual(ids, ['drop-b', 'keep-a'])
  assert.equal(codes(result).includes('kept-user-owned'), true)
  assert.equal(codes(result).includes('deletion-candidate'), false)
})

check('deletion gate 2/3: hash mismatch → kept and reported', () => {
  const { result, ids } = deletionScenario({ dropHash: 'deadbeef' })
  assert.deepEqual(ids, ['drop-b', 'keep-a'])
  assert.equal(codes(result).includes('kept-modified'), true)
})

check('deletion gate 3/3a: model override → kept and reported', () => {
  const { result, ids } = deletionScenario({ overrideIds: ['drop-b'] })
  assert.deepEqual(ids, ['drop-b', 'keep-a'])
  assert.equal(codes(result).includes('kept-override'), true)
})

check('deletion gate 3/3b: pinned model → kept and reported', () => {
  const { result, ids } = deletionScenario({ pinnedModels: ['drop-b'] })
  assert.deepEqual(ids, ['drop-b', 'keep-a'])
  assert.equal(codes(result).includes('kept-pinned'), true)
})

check('deletion gates all pass → removed from merged array and ledger', () => {
  const { result, ids } = deletionScenario()
  assert.deepEqual(ids, ['keep-a'])
  assert.equal(codes(result).includes('deletion-candidate'), true)
  const next = result.nextOwnership[goOwnershipKey('opencode-go', 'keyfp')]
  assert.deepEqual(Object.keys(next.managed), ['keep-a'])
})

// ---------------------------------------------------------------------------
// Ledger keyed by keyFingerprint
// ---------------------------------------------------------------------------

check('ledger: route managed under key A is invisible under key B', () => {
  const drop = profile('drop-b')
  const owned = { managed: { 'drop-b': { hash: profileHash(drop) } } }
  const base = {
    entries: [chatEntry('keep-a')],
    currentRoutes: { 'opencode-go': routeState([profile('keep-a'), drop]) },
  }
  const underA = planGoRoutes({ ...base, keyFingerprint: 'A', ownership: { [goOwnershipKey('opencode-go', 'A')]: owned } })
  const underB = planGoRoutes({ ...base, keyFingerprint: 'B', ownership: { [goOwnershipKey('opencode-go', 'A')]: owned } })
  assert.deepEqual(underA.routes[0].models.map((model) => model.id), ['keep-a'])
  assert.deepEqual(underB.routes[0].models.map((model) => model.id), ['drop-b', 'keep-a'])
})

// ---------------------------------------------------------------------------
// Payload hash excludes created (P0 helper reused)
// ---------------------------------------------------------------------------

check('payloadHash: created does not affect the hash', () => {
  const payload = (created) => ({
    object: 'list',
    data: [{
      id: 'hy4',
      name: 'HY4',
      created,
      api: { 'chat-completions': { base_url: CHAT_BASE } },
      limit: { context: 1000, output: 100 },
      modalities: { input: ['text'] },
      capabilities: {},
    }],
  })
  const first = parseGoModelsPayload(payload(1000))
  const second = parseGoModelsPayload(payload(9999))
  assert.equal('created' in first[0], false)
  assert.equal(computeGoPayloadHash(first), computeGoPayloadHash(second))
})

check('planner: inputs are never mutated', () => {
  const entries = [chatEntry('hy4'), msgEntry('qwen4-max')]
  const currentRoutes = { 'opencode-go': routeState([profile('old')], { api: undefined }) }
  const ownership = {}
  const before = JSON.stringify({ entries, currentRoutes, ownership })
  planGoRoutes({ keyFingerprint: 'keyfp', entries, currentRoutes, ownership })
  assert.equal(JSON.stringify({ entries, currentRoutes, ownership }), before)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

// P0 source: official opencode-go /v1/models parsing, normalization, hashing,
// auth/entitlement classification and the no-key branch. All network calls are
// injected — no test touches the real endpoint.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  parseGoModelsPayload,
  computeGoPayloadHash,
  fingerprintKey,
  classifyGoHttpStatus,
  fetchGoOfficialModels,
  GO_USER_AGENT,
  OPENCODE_GO_MODELS_URL,
} from '../lib/opencode-go-source.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))

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

// ---------------------------------------------------------------------------
// Payload parsing / normalization
// ---------------------------------------------------------------------------
check('parse fixture: four records with mapped fields, no created key', () => {
  const records = parseGoModelsPayload(fixture)
  assert.equal(records.length, 4)
  assert.deepEqual(records.map((r) => r.id), [
    'deepseek-v4.1-flash', 'qwen4-max', 'grok-4.7', 'gemini-4-argon',
  ])
  const first = records[0]
  assert.equal(first.name, 'DeepSeek V4.1 Flash 1017')
  assert.equal(first.canonicalId, 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(first.releaseDate, '2026-10-17')
  assert.equal(first.lastUpdated, '2026-10-17')
  assert.equal(first.contextWindow, 1000000)
  assert.equal(first.maxOutput, 384000)
  assert.deepEqual(first.protocols, ['chat-completions'])
  assert.equal(first.recommendedProtocol, 'chat-completions')
  assert.equal(first.baseUrls['chat-completions'], 'https://opencode.ai/inference/go/openai/v1')
  assert.equal(first.provenance, 'go-official')
  assert.equal('created' in first, false, 'created never enters a normalized record')
  assert.equal('cost' in first, false, 'unrelated upstream fields are dropped')
  assert.equal('monthly_usage' in first, false)
})

check('parse fixture: image modalities folded, audio/video ignored', () => {
  const records = parseGoModelsPayload(fixture)
  assert.deepEqual(records[0].inputModalities, ['text', 'image'])
  assert.deepEqual(records[3].inputModalities, ['text', 'image'])
})

check('parse fixture: maxOutput stripped when it is not below context', () => {
  const records = parseGoModelsPayload(fixture)
  const grok = records.find((r) => r.id === 'grok-4.7')
  assert.equal(grok.contextWindow, 500000)
  assert.equal(grok.maxOutput, undefined)
  const gemini = records.find((r) => r.id === 'gemini-4-argon')
  assert.deepEqual(gemini.protocols, ['generate-content', 'interactions'])
})

check('parse rejects a non-list body and a list with no usable ids', () => {
  assert.throws(() => parseGoModelsPayload({ data: 'nope' }), /not a model list/)
  assert.throws(() => parseGoModelsPayload({ data: [{ id: '' }] }), /no usable model ids/)
})

// ---------------------------------------------------------------------------
// Hashing (created must never enter it) + key fingerprint
// ---------------------------------------------------------------------------
check('payloadHash excludes created but reacts to protocol changes', () => {
  const recordsA = parseGoModelsPayload(fixture)
  const shifted = structuredClone(fixture)
  for (const item of shifted.data) item.created += 1
  assert.equal(computeGoPayloadHash(parseGoModelsPayload(shifted)), computeGoPayloadHash(recordsA))

  const changed = structuredClone(fixture)
  changed.data[1].api = { messages: changed.data[1].api.messages, 'chat-completions': { base_url: 'x' } }
  assert.notEqual(computeGoPayloadHash(parseGoModelsPayload(changed)), computeGoPayloadHash(recordsA))
})

check('fingerprintKey is a 16-hex sha256 prefix', () => {
  const expected = createHash('sha256').update('sk-test').digest('hex').slice(0, 16)
  assert.equal(fingerprintKey('sk-test'), expected)
  assert.match(fingerprintKey('sk-test'), /^[0-9a-f]{16}$/)
})

// ---------------------------------------------------------------------------
// Auth / entitlement classification
// ---------------------------------------------------------------------------
check('classify: 200 ok; 401 invalid; 403 entitlement vs CF1010; 5xx transport', () => {
  assert.equal(classifyGoHttpStatus(200, fixture).authStatus, 'ok')
  const invalid = classifyGoHttpStatus(401, { error: { type: 'authentication_error', code: 'api_key_expired', message: 'expired' } })
  assert.equal(invalid.authStatus, 'invalid')
  assert.equal(invalid.failureKind, 'auth')
  const notEntitled = classifyGoHttpStatus(403, { type: 'error', error: { type: 'EntitlementError', message: 'Go subscription required.' } })
  assert.equal(notEntitled.authStatus, 'not-entitled')
  assert.equal(notEntitled.failureKind, 'entitlement')
  const cf = classifyGoHttpStatus(403, { error_code: 1010, message: 'browser_signature_banned' })
  assert.equal(cf.authStatus, 'unreachable')
  assert.equal(cf.failureKind, 'transport')
  const server = classifyGoHttpStatus(503, { message: 'down' })
  assert.equal(server.authStatus, 'unreachable')
  assert.equal(server.failureKind, 'transport')
})

// ---------------------------------------------------------------------------
// Fetch orchestration: no-key branch, Bearer + UA, error mapping
// ---------------------------------------------------------------------------
await checkAsync('no key: no request sent, unknown status, no-key error', async () => {
  let calls = 0
  const result = await fetchGoOfficialModels({
    fetchImpl: async () => {
      calls += 1
      throw new Error('must not fetch without a key')
    },
  })
  assert.equal(calls, 0, 'no network call when no key is configured')
  assert.equal(result.ok, false)
  assert.equal(result.authStatus, 'unknown')
  assert.equal(result.keyFingerprint, '-')
  assert.equal(result.error.kind, 'no-key')
  assert.deepEqual(result.entries, [])
})

await checkAsync('no key: whitespace-only key also takes the no-request path', async () => {
  let calls = 0
  const result = await fetchGoOfficialModels({
    apiKey: '   ',
    fetchImpl: async () => { calls += 1; throw new Error('unexpected') },
  })
  assert.equal(calls, 0)
  assert.equal(result.error.kind, 'no-key')
})

await checkAsync('with key: Bearer + explicit UA, normalized entries and hash', async () => {
  let seen
  const result = await fetchGoOfficialModels({
    apiKey: 'sk-test-key',
    url: OPENCODE_GO_MODELS_URL,
    observedAt: 1234,
    fetchImpl: async (url, init) => {
      seen = { url, headers: { ...init.headers } }
      return { status: 200, json: async () => fixture }
    },
  })
  assert.equal(seen.url, OPENCODE_GO_MODELS_URL)
  assert.equal(seen.headers.authorization, 'Bearer sk-test-key')
  assert.equal(seen.headers['user-agent'], GO_USER_AGENT)
  assert.match(seen.headers['user-agent'], /^dsh-model-sync\//)
  assert.equal(result.ok, true)
  assert.equal(result.authStatus, 'ok')
  assert.equal(result.entries.length, 4)
  assert.equal(result.observedAt, 1234)
  assert.equal(result.keyFingerprint, fingerprintKey('sk-test-key'))
  assert.ok(typeof result.payloadHash === 'string' && result.payloadHash.length === 64)
  assert.equal(JSON.stringify(result).includes('sk-test-key'), false, 'key value never appears in the result')
})

await checkAsync('with key: 401 maps to invalid/auth, 403 entitlement maps to not-entitled', async () => {
  const invalid = await fetchGoOfficialModels({
    apiKey: 'k',
    fetchImpl: async () => ({ status: 401, json: async () => ({ error: { type: 'authentication_error', code: 'api_key_expired', message: 'expired' } }) }),
  })
  assert.equal(invalid.authStatus, 'invalid')
  assert.equal(invalid.error.kind, 'auth')
  assert.equal(invalid.error.status, 401)
  const denied = await fetchGoOfficialModels({
    apiKey: 'k',
    fetchImpl: async () => ({ status: 403, json: async () => ({ error: { type: 'EntitlementError', message: 'no Go subscription' } }) }),
  })
  assert.equal(denied.authStatus, 'not-entitled')
  assert.equal(denied.error.kind, 'entitlement')
})

await checkAsync('with key: malformed 200 body maps to parse, network throw to transport', async () => {
  const bad = await fetchGoOfficialModels({
    apiKey: 'k',
    fetchImpl: async () => ({ status: 200, json: async () => ({ nope: true }) }),
  })
  assert.equal(bad.error.kind, 'parse')
  assert.equal(bad.authStatus, 'unknown')
  const offline = await fetchGoOfficialModels({
    apiKey: 'k',
    fetchImpl: async () => { throw new Error('ECONNRESET') },
  })
  assert.equal(offline.authStatus, 'unreachable')
  assert.equal(offline.error.kind, 'transport')
})

// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

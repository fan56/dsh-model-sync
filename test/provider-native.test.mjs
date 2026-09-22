// Provider-native fetch unit tests: endpoint table sanity, body parsing,
// credential-value resolution, fetch auth/timeout behavior, and the
// additions-only union merge. End-to-end wiring (config gate → round report)
// lives in real-cordis.test.mjs.

import assert from 'node:assert/strict'
import {
  PROVIDER_NATIVE_ENDPOINTS,
  parseProviderNativeBody,
  fetchProviderNativeModels,
  resolveRouteCredentialValue,
  mergeProviderNativeEntries,
} from '../lib/provider-native.js'

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
// Endpoint table
// ---------------------------------------------------------------------------

check('endpoint table: every url is https and carries a known auth style', () => {
  for (const [route, endpoint] of Object.entries(PROVIDER_NATIVE_ENDPOINTS)) {
    assert.ok(endpoint.url.startsWith('https://'), `${route} url not https: ${endpoint.url}`)
    assert.ok(new URL(endpoint.url).pathname.length > 1, `${route} url has no path`)
    assert.ok(endpoint.auth === 'bearer' || endpoint.auth === 'api-key-header', `${route} bad auth`)
  }
})

check('endpoint table: covers the four families the design verified', () => {
  for (const route of [
    'deepseek',
    'moonshotai-cn',
    'moonshotai',
    'kimi-coding',
    'zai',
    'zai-coding-cn',
    'xiaomi',
    'xiaomi-token-plan-cn',
    'xiaomi-token-plan-ams',
    'xiaomi-token-plan-sgp',
  ]) {
    assert.ok(PROVIDER_NATIVE_ENDPOINTS[route] !== undefined, `missing ${route}`)
  }
  // Gateways and unverified providers must NOT be mapped.
  assert.equal(PROVIDER_NATIVE_ENDPOINTS['opencode-go'], undefined)
  assert.equal(PROVIDER_NATIVE_ENDPOINTS['minimax-cn'], undefined)
})

// ---------------------------------------------------------------------------
// parseProviderNativeBody
// ---------------------------------------------------------------------------

check('parse: OpenAI list shape yields ids and no contexts', () => {
  const parsed = parseProviderNativeBody({
    object: 'list',
    data: [
      { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
      { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
    ],
  })
  assert.deepEqual(parsed.ids, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(parsed.contextById.size, 0)
})

check('parse: moonshot context_length kept only when a positive integer', () => {
  const parsed = parseProviderNativeBody({
    object: 'list',
    data: [
      { id: 'kimi-k3', context_length: 1_048_576 },
      { id: 'kimi-k2.6', context_length: 262144 },
      { id: 'bad-float', context_length: 256.5 },
      { id: 'bad-zero', context_length: 0 },
      { id: 'bad-string', context_length: '131072' },
      { id: 'no-field' },
      { notAnId: true },
    ],
  })
  assert.deepEqual(parsed.ids, ['kimi-k3', 'kimi-k2.6', 'bad-float', 'bad-zero', 'bad-string', 'no-field'])
  assert.equal(parsed.contextById.size, 2)
  assert.equal(parsed.contextById.get('kimi-k3'), 1_048_576)
  assert.equal(parsed.contextById.get('kimi-k2.6'), 262144)
})

check('parse: rejects non-object / data-less / id-less bodies', () => {
  assert.throws(() => parseProviderNativeBody(null))
  assert.throws(() => parseProviderNativeBody('list'))
  assert.throws(() => parseProviderNativeBody({ object: 'list' }))
  assert.throws(() => parseProviderNativeBody({ data: [] }))
  assert.throws(() => parseProviderNativeBody({ data: [{ object: 'model' }] }))
})

// ---------------------------------------------------------------------------
// fetchProviderNativeModels
// ---------------------------------------------------------------------------

/** A fetch stub: records requests, answers from a route→response map. */
function makeFetchStub(responses) {
  const requests = []
  const impl = async (url, init) => {
    requests.push({ url, headers: { ...init.headers } })
    const answer = responses[url]
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`)
    if (answer.throw !== undefined) throw answer.throw
    return {
      ok: answer.status === 200,
      status: answer.status,
      json: async () => answer.body,
    }
  }
  return { impl, requests }
}

checkAsync('fetch: bearer route sends Authorization header, parses body', async () => {
  const stub = makeFetchStub({
    'https://api.deepseek.com/models': {
      status: 200,
      body: { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
    },
  })
  const result = await fetchProviderNativeModels('deepseek', 'sk-test', 5000, stub.impl)
  assert.equal(result.ok, true)
  assert.deepEqual(result.ids, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(stub.requests.length, 1)
  assert.equal(stub.requests[0].headers.authorization, 'Bearer sk-test')
  assert.equal(stub.requests[0].headers['api-key'], undefined)
})

checkAsync('fetch: xiaomi route sends api-key header, not Bearer', async () => {
  const stub = makeFetchStub({
    'https://api.xiaomimimo.com/v1/models': {
      status: 200,
      body: { object: 'list', data: [{ id: 'mimo-v2.6' }, { id: 'mimo-v2.6-pro' }] },
    },
  })
  const result = await fetchProviderNativeModels('xiaomi', 'mk-test', 5000, stub.impl)
  assert.equal(result.ok, true)
  assert.equal(stub.requests[0].headers['api-key'], 'mk-test')
  assert.equal(stub.requests[0].headers.authorization, undefined)
})

checkAsync('fetch: non-200 degrades to ok:false with host named', async () => {
  const stub = makeFetchStub({
    'https://api.moonshot.cn/v1/models': { status: 401, body: { error: {} } },
  })
  const result = await fetchProviderNativeModels('moonshotai-cn', 'bad', 5000, stub.impl)
  assert.equal(result.ok, false)
  assert.match(result.error, /HTTP 401 .*api\.moonshot\.cn/)
})

checkAsync('fetch: network error and unparseable body degrade, never throw', async () => {
  const network = makeFetchStub({
    'https://open.bigmodel.cn/api/coding/paas/v4/models': { throw: new Error('ECONNRESET') },
  })
  const r1 = await fetchProviderNativeModels('zai-coding-cn', 'k', 5000, network.impl)
  assert.equal(r1.ok, false)
  assert.match(r1.error, /ECONNRESET/)

  const garbage = makeFetchStub({
    'https://api.z.ai/api/paas/v4/models': { status: 200, body: { hello: 'world' } },
  })
  const r2 = await fetchProviderNativeModels('zai', 'k', 5000, garbage.impl)
  assert.equal(r2.ok, false)
  assert.match(r2.error, /no data array/)
})

checkAsync('fetch: unmapped route reports instead of calling out', async () => {
  const stub = makeFetchStub({})
  const result = await fetchProviderNativeModels('opencode-go', 'k', 5000, stub.impl)
  assert.equal(result.ok, false)
  assert.match(result.error, /no native endpoint mapped/)
  assert.equal(stub.requests.length, 0)
})

// ---------------------------------------------------------------------------
// resolveRouteCredentialValue
// ---------------------------------------------------------------------------

function makeCtx(services) {
  return {
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
      return undefined
    },
  }
}

checkAsync('credential value: seam resolve wins', async () => {
  const calls = []
  const ctx = makeCtx({
    credentials: {
      async resolve(ref) {
        calls.push(ref)
        return { value: 'seam-value' }
      },
    },
  })
  const value = await resolveRouteCredentialValue(ctx, undefined, 'zai-coding-cn')
  assert.equal(value, 'seam-value')
  assert.deepEqual(calls, ['ZAI_CODING_CN_API_KEY'])
})

checkAsync('credential value: declared apiKeyEnv names the ref consulted', async () => {
  const calls = []
  const ctx = makeCtx({
    credentials: {
      async resolve(ref) {
        calls.push(ref)
        return undefined
      },
    },
  })
  const desc = {
    user: { providers: { 'my-route': { apiKeyEnv: 'CUSTOM_KEY' } } },
  }
  const value = await resolveRouteCredentialValue(ctx, desc, 'my-route')
  assert.equal(value, undefined)
  assert.deepEqual(calls, ['CUSTOM_KEY'])
})

checkAsync('credential value: seam throw falls through to launch environment', async () => {
  const ctx = makeCtx({
    credentials: { async resolve() { throw new Error('seam broken') } },
    launchEnvironment: { get: (name) => (name === 'DEEPSEEK_API_KEY' ? { value: 'env-value' } : undefined) },
  })
  const value = await resolveRouteCredentialValue(ctx, undefined, 'deepseek')
  assert.equal(value, 'env-value')
})

checkAsync('credential value: process.env fallback when both services absent', async () => {
  process.env.MODEL_SYNC_TEST_KEY = 'from-process'
  try {
    const desc = {
      user: { providers: { 'some-route': { apiKeyEnv: 'MODEL_SYNC_TEST_KEY' } } },
    }
    const value = await resolveRouteCredentialValue(makeCtx({}), desc, 'some-route')
    assert.equal(value, 'from-process')
  } finally {
    delete process.env.MODEL_SYNC_TEST_KEY
  }
})

checkAsync('credential value: empty values read as absent', async () => {
  const ctx = makeCtx({
    credentials: { async resolve() { return { value: '' } } },
    launchEnvironment: { get: () => ({ value: '' }) },
  })
  assert.equal(await resolveRouteCredentialValue(ctx, undefined, 'zai'), undefined)
})

// ---------------------------------------------------------------------------
// mergeProviderNativeEntries
// ---------------------------------------------------------------------------

/** A pi.dev-shaped entry with metadata a synthesized one must not invent. */
function piDevEntry(id, extra = {}) {
  return {
    id,
    name: `Pi.dev ${id}`,
    api: 'openai-completions',
    provider: 'zai-coding-cn',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    reasoning: true,
    input: ['text', 'image'],
    ...extra,
  }
}

check('merge: additions only — native-only id appended, known id keeps pi.dev metadata', () => {
  const piDev = [piDevEntry('glm-5.3', { contextWindow: 131072 })]
  const merged = mergeProviderNativeEntries(
    piDev,
    { ids: ['glm-5.3', 'glm-5.3-flashx'], contextById: new Map() },
    'zai-coding-cn',
    'openai-completions',
  )
  assert.equal(merged.entries.length, 2)
  assert.deepEqual(merged.addedIds, ['glm-5.3-flashx'])
  // The known entry is untouched — same object, metadata intact.
  assert.equal(merged.entries[0], piDev[0])
  assert.equal(merged.entries[0].name, 'Pi.dev glm-5.3')
  assert.equal(merged.entries[0].contextWindow, 131072)
  // The synthesized entry carries no capacities it does not know.
  const added = merged.entries[1]
  assert.equal(added.id, 'glm-5.3-flashx')
  assert.equal(added.contextWindow, undefined)
  assert.equal(added.maxTokens, undefined)
  assert.equal(added.api, 'openai-completions')
  assert.equal(merged.skippedReason, undefined)
})

check('merge: stated context flows through, unstated stays absent', () => {
  const merged = mergeProviderNativeEntries(
    [],
    {
      ids: ['kimi-k3', 'kimi-k2.6'],
      contextById: new Map([['kimi-k3', 1_048_576]]),
    },
    'moonshotai-cn',
    'openai-completions',
  )
  const k3 = merged.entries.find((e) => e.id === 'kimi-k3')
  const k26 = merged.entries.find((e) => e.id === 'kimi-k2.6')
  assert.equal(k3.contextWindow, 1_048_576)
  assert.equal(k26.contextWindow, undefined)
  // maxTokens is never synthesized — the route default applies downstream.
  for (const entry of merged.entries) assert.equal(entry.maxTokens, undefined)
})

check('merge: no route api → skip synthesis with a reason', () => {
  const piDev = [piDevEntry('glm-5.2')]
  const merged = mergeProviderNativeEntries(
    piDev,
    { ids: ['glm-5.3'], contextById: new Map() },
    'zai-coding-cn',
    undefined,
  )
  assert.equal(merged.entries.length, 1)
  assert.deepEqual(merged.addedIds, [])
  assert.match(merged.skippedReason, /no single builtin api/)
})

check('merge: fully known listing is a no-op', () => {
  const piDev = [piDevEntry('a'), piDevEntry('b')]
  const merged = mergeProviderNativeEntries(
    piDev,
    { ids: ['a', 'b'], contextById: new Map([['a', 999]]) },
    'zai-coding-cn',
    'openai-completions',
  )
  assert.equal(merged.entries.length, 2)
  assert.deepEqual(merged.addedIds, [])
  // A context for an already-known id never overwrites pi.dev metadata.
  assert.equal(merged.entries[0].contextWindow, undefined)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} tests passed`)

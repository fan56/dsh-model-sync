// Per-route gate decision matrix with hand-built credential/environment seams.
// Layer 1 follows llm-pi-ai's resolveApiKey (seam first); layer 2 follows
// authContextFrom(ctx).env() (launch snapshot or process.env).
// Real plugin wiring and fetch/mutate spies live in real-cordis.test.mjs.

import assert from 'node:assert/strict'
import {
  deriveKeyRef,
  getRawUserApiKeyEnv,
  checkRouteCredential,
} from '../lib/route-credential.js'

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
// Mocks: a minimal cordis-Context double (`ctx.get(name)`), and minimal
// seams. The shape we mock is exactly the surface route-credential.ts
// declares, no more — anything outside the gate's view (commands, plugins,
// lifecycle) is left to test/real-cordis.test.mjs.
// ---------------------------------------------------------------------------

/** A `ctx.get(name)` double that returns whatever the caller pre-registered. */
function makeCtx(services) {
  return {
    get(name) {
      if (Object.prototype.hasOwnProperty.call(services, name)) {
        return services[name]
      }
      return undefined
    },
  }
}

/** A credentials-seam spy: counts invocations and returns the configured result. */
function makeCredentialsSpy({ configuredMap = {}, throwOn = undefined } = {}) {
  const calls = []
  return {
    calls,
    async describe(ref) {
      calls.push(ref)
      if (throwOn !== undefined && throwOn.has(ref)) {
        throw new Error(`boom on ${ref}`)
      }
      return { configured: configuredMap[ref] === true }
    },
  }
}

/** A launch-environment snapshot spy: returns preconfigured entries. */
function makeLaunchEnv(values = {}) {
  return {
    get(name) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        return { value: values[name], source: 'process' }
      }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// deriveKeyRef: byte-for-byte replica of the dsh web UI's helper
// (packages/client/ui-settings-models/src/client/store.ts:111-113).
// uppercase + collapse non-alphanumerics to `_` + `_API_KEY` suffix.
// ---------------------------------------------------------------------------

check('deriveKeyRef: opencode-go → OPENCODE_GO_API_KEY', () => {
  assert.equal(deriveKeyRef('opencode-go'), 'OPENCODE_GO_API_KEY')
})

check('deriveKeyRef: zai-coding-cn → ZAI_CODING_CN_API_KEY', () => {
  assert.equal(deriveKeyRef('zai-coding-cn'), 'ZAI_CODING_CN_API_KEY')
})

check('deriveKeyRef: hyphenated route collapses to single underscore', () => {
  assert.equal(deriveKeyRef('minimax-cn'), 'MINIMAX_CN_API_KEY')
})

check('deriveKeyRef: dotted route collapses to single underscore', () => {
  // The UI helper accepts arbitrary provider names; "deep.seek" must fold to
  // the same single-`_` form (not `DEEP__SEEK_API_KEY`).
  assert.equal(deriveKeyRef('deep.seek'), 'DEEP_SEEK_API_KEY')
})

check('deriveKeyRef: mixed punct collapses to single underscore', () => {
  // `a-b.c` has two distinct separators → exactly one `_`, not two.
  assert.equal(deriveKeyRef('a-b.c'), 'A_B_C_API_KEY')
})

check('deriveKeyRef: idempotent on already-uppercase names', () => {
  assert.equal(deriveKeyRef('XIAOMI'), 'XIAOMI_API_KEY')
})

check('deriveKeyRef: digits survive unchanged', () => {
  assert.equal(deriveKeyRef('route42'), 'ROUTE42_API_KEY')
})

// ---------------------------------------------------------------------------
// getRawUserApiKeyEnv: read the user-declared `apiKeyEnv` for one route.
// ---------------------------------------------------------------------------

check('getRawUserApiKeyEnv: returns the trimmed string when declared', () => {
  const desc = {
    user: { providers: { 'opencode-go': { apiKeyEnv: '  MY_REF  ' } } },
  }
  assert.equal(getRawUserApiKeyEnv(desc, 'opencode-go'), 'MY_REF')
})

check('getRawUserApiKeyEnv: undefined when desc is missing', () => {
  assert.equal(getRawUserApiKeyEnv(undefined, 'opencode-go'), undefined)
})

check('getRawUserApiKeyEnv: undefined when user is missing', () => {
  assert.equal(getRawUserApiKeyEnv({}, 'opencode-go'), undefined)
})

check('getRawUserApiKeyEnv: undefined when providers is missing', () => {
  assert.equal(getRawUserApiKeyEnv({ user: {} }, 'opencode-go'), undefined)
})

check('getRawUserApiKeyEnv: undefined when the route entry is missing', () => {
  const desc = { user: { providers: { 'other-route': { apiKeyEnv: 'X' } } } }
  assert.equal(getRawUserApiKeyEnv(desc, 'opencode-go'), undefined)
})

check('getRawUserApiKeyEnv: undefined when apiKeyEnv is not a string', () => {
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: 42 } } } }
  assert.equal(getRawUserApiKeyEnv(desc, 'opencode-go'), undefined)
})

check('getRawUserApiKeyEnv: empty / whitespace string returns undefined', () => {
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: '   ' } } } }
  assert.equal(getRawUserApiKeyEnv(desc, 'opencode-go'), undefined)
})

// ---------------------------------------------------------------------------
// Decision matrix: checkRouteCredential
// ---------------------------------------------------------------------------
//
// The full matrix from the handoff:
//
//  profile missing → deriveKeyRef fallback → env hit → pass
//  apiKeyEnv declared + seam configured → ok via credentials
//  apiKeyEnv declared + seam NOT configured + env hit → ok via env
//  apiKeyEnv declared + seam NOT configured + env miss → ok=false
//  seam absent + env hit → ok via env
//  seam absent + env miss → ok=false
//
// Plus the "seam throws" branch (must NOT crash the round — falls through).

await checkAsync('checkRouteCredential: profile missing → deriveKeyRef fallback → credentials hit → pass', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: { OPENCODE_GO_API_KEY: true } })
  const launchEnv = makeLaunchEnv()
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'opencode-go')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'OPENCODE_GO_API_KEY')
  assert.equal(result.via, 'credentials')
})

await checkAsync('checkRouteCredential: apiKeyEnv declared + seam configured → ok via credentials', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: { CUSTOM_OPENCODE_KEY: true } })
  const ctx = makeCtx({ credentials, launchEnvironment: makeLaunchEnv() })
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: 'CUSTOM_OPENCODE_KEY' } } } }
  const result = await checkRouteCredential(ctx, desc, 'opencode-go')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'CUSTOM_OPENCODE_KEY', 'declared ref wins over derived ref')
  assert.equal(result.via, 'credentials')
})

await checkAsync('checkRouteCredential: apiKeyEnv declared + seam NOT configured + env hit → ok via env', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: {} }) // seam says no
  const launchEnv = makeLaunchEnv({ CUSTOM_OPENCODE_KEY: 'sk-test' })
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: 'CUSTOM_OPENCODE_KEY' } } } }
  const result = await checkRouteCredential(ctx, desc, 'opencode-go')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'CUSTOM_OPENCODE_KEY')
  assert.equal(result.via, 'env')
})

await checkAsync('checkRouteCredential: apiKeyEnv declared + seam NOT configured + env miss → ok=false', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: {} })
  const launchEnv = makeLaunchEnv() // env miss
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: 'CUSTOM_OPENCODE_KEY' } } } }
  const result = await checkRouteCredential(ctx, desc, 'opencode-go')
  assert.equal(result.ok, false)
  assert.equal(result.ref, 'CUSTOM_OPENCODE_KEY', 'ref is still the declared name, even when the gate fails')
  assert.equal(result.via, undefined)
})

await checkAsync('checkRouteCredential: seam absent + env hit → ok via env', async () => {
  const launchEnv = makeLaunchEnv({ ZAI_CODING_CN_API_KEY: 'sk-zai' })
  // No 'credentials' key in the services map — `ctx.get('credentials')` returns undefined.
  const ctx = makeCtx({ launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'zai-coding-cn')
  assert.equal(result.ok, true)
  assert.equal(result.ref, 'ZAI_CODING_CN_API_KEY')
  assert.equal(result.via, 'env')
})

await checkAsync('checkRouteCredential: seam absent + env miss → ok=false', async () => {
  const launchEnv = makeLaunchEnv() // empty
  const ctx = makeCtx({ launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'zai-coding-cn')
  assert.equal(result.ok, false)
  assert.equal(result.ref, 'ZAI_CODING_CN_API_KEY')
  assert.equal(result.via, undefined)
})

await checkAsync('checkRouteCredential: env entry with empty value does NOT count as configured', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: {} })
  const launchEnv = makeLaunchEnv({ OPENCODE_GO_API_KEY: '' })
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'opencode-go')
  assert.equal(result.ok, false, 'empty env value is the seam-wide absent signal')
})

await checkAsync('checkRouteCredential: seam throws → falls through to env (does NOT crash the round)', async () => {
  const credentials = makeCredentialsSpy({ throwOn: new Set(['OPENCODE_GO_API_KEY']) })
  const launchEnv = makeLaunchEnv({ OPENCODE_GO_API_KEY: 'sk-from-env' })
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'opencode-go')
  assert.equal(result.ok, true)
  assert.equal(result.via, 'env')
  assert.equal(credentials.calls.length, 1, 'seam was probed before the throw')
})

await checkAsync('checkRouteCredential: malformed ref (not POSIX) skips it, only env is consulted', async () => {
  // A user might (against docs) put `foo bar` into apiKeyEnv — non-POSIX,
  // would crash the seam. The gate must NOT call describe for it, and must
  // still report the ref in its failure.
  const credentials = makeCredentialsSpy()
  const launchEnv = makeLaunchEnv()
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: 'foo bar' } } } }
  const result = await checkRouteCredential(ctx, desc, 'opencode-go')
  assert.equal(result.ok, false)
  assert.equal(result.ref, 'foo bar', 'still echoes the bad ref so the report names it')
  assert.equal(credentials.calls.length, 0, 'malformed ref is NOT passed to the seam')
})

await checkAsync('checkRouteCredential: absent services → process.env fallback (non-empty / empty / unset)', async () => {
  const ref = 'DSH_MODEL_SYNC_TEST_API_KEY'
  const previous = process.env[ref]
  const ctx = makeCtx({})
  const desc = { user: { providers: { test: { apiKeyEnv: ref } } } }
  try {
    process.env[ref] = 'test-only'
    assert.deepEqual(await checkRouteCredential(ctx, desc, 'test'), { ok: true, ref, via: 'env' })
    process.env[ref] = ''
    assert.deepEqual(await checkRouteCredential(ctx, desc, 'test'), { ok: false, ref })
    delete process.env[ref]
    assert.deepEqual(await checkRouteCredential(ctx, desc, 'test'), { ok: false, ref })
  } finally {
    if (previous === undefined) delete process.env[ref]
    else process.env[ref] = previous
  }
})

await checkAsync('checkRouteCredential: provided launch snapshot overrides process.env even on a miss', async () => {
  const ref = 'DSH_MODEL_SYNC_TEST_API_KEY'
  const previous = process.env[ref]
  try {
    process.env[ref] = 'test-only'
    const ctx = makeCtx({ launchEnvironment: makeLaunchEnv() })
    const desc = { user: { providers: { test: { apiKeyEnv: ref } } } }
    assert.deepEqual(await checkRouteCredential(ctx, desc, 'test'), { ok: false, ref })
  } finally {
    if (previous === undefined) delete process.env[ref]
    else process.env[ref] = previous
  }
})

await checkAsync('checkRouteCredential: apiKeyEnv empty string → deriveKeyRef → env hit', async () => {
  const credentials = makeCredentialsSpy()
  const ctx = makeCtx({ credentials, launchEnvironment: makeLaunchEnv({ OPENCODE_GO_API_KEY: 'test-only' }) })
  const desc = { user: { providers: { 'opencode-go': { apiKeyEnv: '' } } } }
  assert.deepEqual(await checkRouteCredential(ctx, desc, 'opencode-go'), {
    ok: true, ref: 'OPENCODE_GO_API_KEY', via: 'env',
  })
  assert.deepEqual(credentials.calls, ['OPENCODE_GO_API_KEY'])
})

// ---------------------------------------------------------------------------
// Gate result contract; real-cordis.test.mjs verifies the actual sync report
// and the absence of fetch/mutate calls through the real plugin.
// ---------------------------------------------------------------------------

await checkAsync('gate result: skip names the missing ref for report formatting', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: {} }) // always unconfigured
  const launchEnv = makeLaunchEnv()
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'opencode-go')
  assert.equal(result.ok, false)
  assert.equal(result.ref, 'OPENCODE_GO_API_KEY')
  // The gate produced the same `{ok:false, ref}` shape syncSettings appends
  // to its report line — verify the line shape:
  const reportLine = `opencode-go: skipped — credential ${result.ref} not configured`
  assert.equal(reportLine, 'opencode-go: skipped — credential OPENCODE_GO_API_KEY not configured')
})

await checkAsync('gate result: pass → seam consulted, via=credentials', async () => {
  const credentials = makeCredentialsSpy({ configuredMap: { MINIMAX_CN_API_KEY: true } })
  const launchEnv = makeLaunchEnv() // env empty
  const ctx = makeCtx({ credentials, launchEnvironment: launchEnv })
  const result = await checkRouteCredential(ctx, undefined, 'minimax-cn')
  assert.equal(result.ok, true)
  assert.equal(result.via, 'credentials')
  assert.equal(credentials.calls.length, 1)
  assert.equal(credentials.calls[0], 'MINIMAX_CN_API_KEY')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)
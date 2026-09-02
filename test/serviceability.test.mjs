// Plan C (settings-seam): tests for serviceability — schema validation and
// settings-writable entry shape assertions.

/**
 * Tests for serviceability: verify that translated entries conform to the
 * settings schema shape (assertServiceable would accept them).
 *
 * Since we can't import dsh's internal assertServiceable directly, we validate
 * the structural contract that the settings schema enforces:
 * - reasoningEfforts must be a dict (not array) with string|null values
 * - compat only has thinkingFormat + supportsReasoningEffort
 * - required fields (id) are always present
 * - no unknown keys that would cause schema rejection
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { translateEntries } from '../lib/translate.js'
import { BUILTIN_CATALOG_SNAPSHOT } from '../lib/builtin-catalog-snapshot.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesDir = join(__dirname, 'fixtures')

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

// Load all fixtures
const fixtures = {
  'opencode-go': JSON.parse(await readFile(join(fixturesDir, 'store-opencode-go.json'), 'utf8')),
  'zai-coding-cn': JSON.parse(await readFile(join(fixturesDir, 'store-zai-coding-cn.json'), 'utf8')),
  'minimax-cn': JSON.parse(await readFile(join(fixturesDir, 'store-minimax-cn.json'), 'utf8')),
  'xiaomi-token-plan-cn': JSON.parse(await readFile(join(fixturesDir, 'store-xiaomi-token-plan-cn.json'), 'utf8')),
}

// Builtin catalog data — imported from shared snapshot (B3)
const builtinCatalogs = BUILTIN_CATALOG_SNAPSHOT

const defaultOpts = {
  keepBuiltinOnly: false,
  dropUnserviceable: true,
  dropWarnings: [],
  forceMaxReasoningEffort: false,
}

// ---------------------------------------------------------------------------
// Schema contract validators
// ---------------------------------------------------------------------------

/** Validate that a value is a valid reasoningEfforts dict. */
function assertValidReasoningEfforts(value, entryId) {
  assert.ok(typeof value === 'object', `${entryId}: reasoningEfforts should be object`)
  assert.ok(!Array.isArray(value), `${entryId}: reasoningEfforts must not be array (B1 guard)`)
  for (const [k, v] of Object.entries(value)) {
    assert.ok(typeof k === 'string', `${entryId}: reasoningEfforts key should be string`)
    assert.ok(
      typeof v === 'string' || v === null,
      `${entryId}: reasoningEfforts.${k} should be string or null, got ${typeof v}`,
    )
  }
}

/** Validate that compat only contains allowed keys (S5 guard). */
function assertValidCompat(compat, entryId) {
  assert.ok(typeof compat === 'object', `${entryId}: compat should be object`)
  const allowedKeys = new Set(['thinkingFormat', 'supportsReasoningEffort'])
  for (const key of Object.keys(compat)) {
    assert.ok(allowedKeys.has(key), `${entryId}: compat.${key} is not in allowed set [${[...allowedKeys]}]`)
  }
}

/** Validate that an entry has no compat keys for non-openai-completions (H2 guard). */
function assertNoCompatForNonOpenAI(entry, route, builtinData) {
  const builtin = builtinData.find(b => b.id === entry.id)
  const resolvedApi = builtin ? builtin.api : undefined
  if (resolvedApi !== undefined && resolvedApi !== 'openai-completions') {
    assert.equal(
      entry.compat, undefined,
      `${route}/${entry.id}: non-openai-completions entry should NOT have compat (H2 guard)`,
    )
  }
}

// ---------------------------------------------------------------------------
// All 4 routes: translate and validate
// ---------------------------------------------------------------------------
for (const [route, storeEntry] of Object.entries(fixtures)) {
  const builtinData = builtinCatalogs[route] ?? []
  const builtinIds = new Set(builtinData.map(b => b.id))

  const result = translateEntries(
    storeEntry.models,
    builtinIds,
    builtinData,
    route,
    defaultOpts,
  )

  // Every entry must have an id
  check(`${route}: every entry has id`, () => {
    for (const entry of result.entries) {
      assert.ok(typeof entry.id === 'string' && entry.id.length > 0, `entry missing id`)
    }
  })

  // reasoningEfforts, if present, must be a valid dict (B1 guard)
  check(`${route}: reasoningEfforts are valid dicts (B1 guard)`, () => {
    for (const entry of result.entries) {
      if (entry.reasoningEfforts !== undefined) {
        assertValidReasoningEfforts(entry.reasoningEfforts, `${route}/${entry.id}`)
      }
    }
  })

  // compat, if present, only has thinkingFormat + supportsReasoningEffort (S5 guard)
  check(`${route}: compat has only allowed keys (S5 guard)`, () => {
    for (const entry of result.entries) {
      if (entry.compat !== undefined) {
        assertValidCompat(entry.compat, `${route}/${entry.id}`)
      }
    }
  })

  // Non-openai-completions entries should not have compat (H2 guard)
  check(`${route}: non-openai-completions entries have no compat (H2 guard)`, () => {
    for (const entry of result.entries) {
      assertNoCompatForNonOpenAI(entry, route, builtinData)
    }
  })

  // No entry has the `reasoning` boolean (rule 6)
  check(`${route}: no entry has reasoning boolean (rule 6)`, () => {
    for (const entry of result.entries) {
      assert.equal(
        (entry).reasoning, undefined,
        `${route}/${entry.id}: should not have reasoning boolean`,
      )
    }
  })

  // No entry has api/baseUrl/provider per entry (rule 11)
  check(`${route}: no entry has api/baseUrl/provider (rule 11)`, () => {
    for (const entry of result.entries) {
      assert.equal((entry).api, undefined, `${route}/${entry.id}: should not have api`)
      assert.equal((entry).baseUrl, undefined, `${route}/${entry.id}: should not have baseUrl`)
      assert.equal((entry).provider, undefined, `${route}/${entry.id}: should not have provider`)
    }
  })
}

// ---------------------------------------------------------------------------
// opencode-go specific: dropped entries validation
// ---------------------------------------------------------------------------
check('opencode-go: base-less entries on mixed-protocol route are dropped', () => {
  const builtinData = builtinCatalogs['opencode-go']
  const builtinIds = new Set(builtinData.map(b => b.id))
  const result = translateEntries(
    fixtures['opencode-go'].models,
    builtinIds,
    builtinData,
    'opencode-go',
    defaultOpts,
  )

  // Mixed-protocol route: base-less entries (the three test-ghost-* fixture
  // ids, which exist in no pi-ai catalog) are dropped. Ghost ids keep this
  // test immune to builtin-catalog drift — real ids (glm-5.3, gpt-5.6-luna,
  // qwen3.8-max) were all catalog-absent once and are base-matching now.
  assert.equal(result.dropped.length, 3, '3 base-less entries should be dropped on mixed-protocol route')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-a'), 'test-ghost-a should be dropped')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-b'), 'test-ghost-b should be dropped')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-c'), 'test-ghost-c should be dropped')
  assert.ok(result.dropped.every(d => d.reason.includes('mixed-protocol')), 'all drops should be mixed-protocol')
})

// ---------------------------------------------------------------------------
// Array-shaped reasoningEfforts would be rejected (B1 guard test)
// ---------------------------------------------------------------------------
check('B1 guard: array-shaped reasoningEfforts would fail dict validation', () => {
  // Simulate what would happen if reasoningEfforts were an array
  const arrayEfforts = ['low', 'high']
  assert.ok(Array.isArray(arrayEfforts), 'this is an array')
  // Our validator would reject this
  assert.throws(() => assertValidReasoningEfforts(arrayEfforts, 'test'), /must not be array/)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

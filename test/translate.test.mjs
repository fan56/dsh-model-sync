// Plan C (settings-seam): tests for the translate module.

/**
 * Tests for translate.ts — covers S2 gate, S5 gate, maxTokens classification,
 * drop logic, keepBuiltinOnly, reasoningEfforts dict format.
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

// Load fixtures
const opencodeGo = JSON.parse(await readFile(join(fixturesDir, 'store-opencode-go.json'), 'utf8'))
const zaiCn = JSON.parse(await readFile(join(fixturesDir, 'store-zai-coding-cn.json'), 'utf8'))
const minimaxCn = JSON.parse(await readFile(join(fixturesDir, 'store-minimax-cn.json'), 'utf8'))
const xiaomiCn = JSON.parse(await readFile(join(fixturesDir, 'store-xiaomi-token-plan-cn.json'), 'utf8'))

// Builtin catalog data — imported from shared snapshot (B3)
const opencodeGoBuiltin = BUILTIN_CATALOG_SNAPSHOT['opencode-go']
const zaiBuiltin = BUILTIN_CATALOG_SNAPSHOT['zai-coding-cn']
const minimaxBuiltin = BUILTIN_CATALOG_SNAPSHOT['minimax-cn']
const xiaomiBuiltin = BUILTIN_CATALOG_SNAPSHOT['xiaomi-token-plan-cn']

const defaultOpts = {
  keepBuiltinOnly: false,
  dropUnserviceable: true,
  dropWarnings: [],
  forceMaxReasoningEffort: false,
}

// ---------------------------------------------------------------------------
// S2 gate: reasoningEfforts only when thinkingFormat non-empty AND SRE !== false
// ---------------------------------------------------------------------------
check('S2 gate: entries with thinkingFormat and SRE=true get reasoningEfforts', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // deepseek-v4-flash has thinkingFormat=deepseek, SRE not set (undefined, not false)
  const dsFlash = result.entries.find(e => e.id === 'deepseek-v4-flash')
  assert.ok(dsFlash, 'deepseek-v4-flash should be in result')
  assert.ok(dsFlash.reasoningEfforts, 'deepseek-v4-flash should have reasoningEfforts')
  assert.equal(typeof dsFlash.reasoningEfforts, 'object')
  // Should be a dict, not an array
  assert.ok(!Array.isArray(dsFlash.reasoningEfforts), 'reasoningEfforts should be a dict, not array')
})

check('S2 gate: kimi-k2.6 (SRE=false) does NOT get reasoningEfforts', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // kimi-k2.6 has thinkingFormat=deepseek but supportsReasoningEffort=false
  const kimi = result.entries.find(e => e.id === 'kimi-k2.6')
  assert.ok(kimi, 'kimi-k2.6 should be in result')
  assert.equal(kimi.reasoningEfforts, undefined, 'kimi-k2.6 (SRE=false) should NOT have reasoningEfforts')
})

check('S2 gate: zai entries with SRE=false do NOT get reasoningEfforts', () => {
  const builtinIds = new Set(zaiBuiltin.map(b => b.id))
  const result = translateEntries(
    zaiCn.models,
    builtinIds,
    zaiBuiltin,
    'zai-coding-cn',
    defaultOpts,
  )

  // All zai entries with thinkingFormat=zai have SRE=false except glm-5.2
  const glm46v = result.entries.find(e => e.id === 'glm-4.6v')
  assert.ok(glm46v, 'glm-4.6v should be in result')
  assert.equal(glm46v.reasoningEfforts, undefined, 'glm-4.6v (SRE=false) should NOT have reasoningEfforts')

  // glm-5.2 has SRE=true, so it should get reasoningEfforts
  const glm52 = result.entries.find(e => e.id === 'glm-5.2')
  assert.ok(glm52, 'glm-5.2 should be in result')
  assert.ok(glm52.reasoningEfforts, 'glm-5.2 (SRE=true) should have reasoningEfforts')
})

check('S2 gate: entries without thinkingFormat do NOT get reasoningEfforts', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // hy3 has no thinkingFormat
  const hy3 = result.entries.find(e => e.id === 'hy3')
  assert.ok(hy3, 'hy3 should be in result')
  assert.equal(hy3.reasoningEfforts, undefined, 'hy3 (no thinkingFormat) should NOT have reasoningEfforts')
})

// ---------------------------------------------------------------------------
// S5 gate: compat.thinkingFormat / supportsReasoningEffort only for openai-completions
// ---------------------------------------------------------------------------
check('S5 gate: openai-completions entries keep compat', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // qwen3.6-plus is openai-completions, has thinkingFormat=qwen
  const qwen = result.entries.find(e => e.id === 'qwen3.6-plus')
  assert.ok(qwen, 'qwen3.6-plus should be in result')
  assert.ok(qwen.compat, 'qwen3.6-plus should have compat')
  assert.equal(qwen.compat.thinkingFormat, 'qwen')
})

check('S5 gate: non-openai-completions entries have compat stripped', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // minimax-m3 is anthropic-messages (base-matching with builtin api=anthropic-messages)
  const m3 = result.entries.find(e => e.id === 'minimax-m3')
  assert.ok(m3, 'minimax-m3 should be in result')
  assert.equal(m3.compat, undefined, 'minimax-m3 (anthropic-messages) should NOT have compat')
})

// ---------------------------------------------------------------------------
// maxTokens classification: base-matching stripped, base-less kept
// ---------------------------------------------------------------------------
check('maxTokens: base-matching entries have maxTokens stripped', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // deepseek-v4-flash is base-matching (in builtin catalog)
  const dsFlash = result.entries.find(e => e.id === 'deepseek-v4-flash')
  assert.ok(dsFlash, 'deepseek-v4-flash should be in result')
  assert.equal(dsFlash.maxTokens, undefined, 'base-matching deepseek-v4-flash should NOT have maxTokens')
})

check('maxTokens: base-less entries keep maxTokens', () => {
  // glm-5.2-highspeed was base-less when this test was written; the live
  // catalog may or may not know it today. Force the base-less condition by
  // handing translateEntries a builtin list without it — the behavior under
  // test is "a base-less entry keeps its own maxTokens", independent of
  // catalog drift.
  const effectiveBuiltin = zaiBuiltin.filter(b => b.id !== 'glm-5.2-highspeed')
  const builtinIds = new Set(effectiveBuiltin.map(b => b.id))
  const result = translateEntries(
    zaiCn.models,
    builtinIds,
    effectiveBuiltin,
    'zai-coding-cn',
    defaultOpts,
  )

  const highspeed = result.entries.find(e => e.id === 'glm-5.2-highspeed')
  assert.ok(highspeed, 'glm-5.2-highspeed should be in result')
  assert.equal(highspeed.maxTokens, 131072, 'base-less glm-5.2-highspeed should keep maxTokens=131072')
})

// ---------------------------------------------------------------------------
// Drop logic: opencode-go mixed-protocol entries
// ---------------------------------------------------------------------------
// The three test-ghost-* fixture ids exist in no pi-ai catalog, which makes
// them permanently base-less on this mixed-protocol route. (Real ids —
// glm-5.3, gpt-5.6-luna, qwen3.8-max — were catalog-absent once and are
// base-matching now, so tests must not anchor on them.)
check('base-less: opencode-go test-ghost-a is dropped (mixed-protocol route)', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  const ghost = result.entries.find(e => e.id === 'test-ghost-a')
  assert.equal(ghost, undefined, 'test-ghost-a should NOT be in result (dropped)')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-a'), 'test-ghost-a should be in dropped list')
  const drop = result.dropped.find(d => d.id === 'test-ghost-a')
  assert.ok(drop.reason.includes('mixed-protocol'), 'drop reason should mention mixed-protocol')
})

check('base-less: opencode-go test-ghost-b is dropped (mixed-protocol route)', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  const ghost = result.entries.find(e => e.id === 'test-ghost-b')
  assert.equal(ghost, undefined, 'test-ghost-b should NOT be in result (dropped)')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-b'), 'test-ghost-b should be in dropped list')
  const drop = result.dropped.find(d => d.id === 'test-ghost-b')
  assert.ok(drop.reason.includes('mixed-protocol'), 'drop reason should mention mixed-protocol')
})

check('base-less: opencode-go test-ghost-c is dropped (mixed-protocol route)', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  const ghost = result.entries.find(e => e.id === 'test-ghost-c')
  assert.equal(ghost, undefined, 'test-ghost-c should NOT be in result (dropped)')
  assert.ok(result.dropped.some(d => d.id === 'test-ghost-c'), 'test-ghost-c should be in dropped list')
  const drop = result.dropped.find(d => d.id === 'test-ghost-c')
  assert.ok(drop.reason.includes('mixed-protocol'), 'drop reason should mention mixed-protocol')
})

check('base-less: single-protocol route with api → still written (no false drop)', () => {
  // minimax-cn is single-protocol (all anthropic-messages).
  // Add a mock base-less entry with api — it should NOT be dropped.
  const builtinIds = new Set(minimaxBuiltin.map(b => b.id))
  const mockEntries = [
    ...minimaxCn.models,
    {
      id: 'extra-model',
      name: 'Extra Model',
      api: 'anthropic-messages',
      provider: 'minimax-cn',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      maxTokens: 64000,
    },
  ]
  const result = translateEntries(
    mockEntries,
    builtinIds,
    minimaxBuiltin,
    'minimax-cn',
    defaultOpts,
  )

  const extra = result.entries.find(e => e.id === 'extra-model')
  assert.ok(extra, 'extra-model should be in result (not dropped)')
  assert.ok(!result.dropped.some(d => d.id === 'extra-model'), 'extra-model should NOT be dropped on single-protocol route')
  // base-less: maxTokens kept
  assert.equal(extra.maxTokens, 64000, 'extra-model should keep maxTokens')
})

check('drop: dropUnserviceable=false with api-less entry returns empty entries with aborted=true', () => {
  // Mock entries: one valid, one base-less with no api (should be dropped)
  const mockEntries = [
    {
      id: 'good-model',
      name: 'Good Model',
      api: 'openai-completions',
      provider: 'test-route',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
    },
    {
      id: 'bad-model',
      name: 'Bad Model',
      api: '',
      provider: 'test-route',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
    },
  ]
  const result = translateEntries(
    mockEntries,
    new Set(),
    [],
    'test-route',
    { ...defaultOpts, dropUnserviceable: false },
  )

  assert.equal(result.entries.length, 0, 'should return empty entries when dropUnserviceable=false and drops exist')
  assert.ok(result.dropped.length > 0, 'should still report drops')
  assert.ok(result.dropped.some(d => d.id === 'bad-model'), 'bad-model should be in dropped list')
  assert.equal(result.aborted, true, 'aborted should be true when drops exist and dropUnserviceable=false')
})

check('drop: dropUnserviceable=true returns non-empty entries with aborted=false', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, dropUnserviceable: true },
  )

  assert.ok(result.entries.length > 0, 'should return entries when dropUnserviceable=true')
  assert.equal(result.aborted, false, 'aborted should be false when dropUnserviceable=true')
  // 3 base-less entries on mixed-protocol route are dropped
  assert.equal(result.dropped.length, 3, '3 drops expected — base-less entries on mixed-protocol route')
  assert.ok(result.dropped.every(d => d.reason.includes('mixed-protocol')), 'all drops should be mixed-protocol')
})

// ---------------------------------------------------------------------------
// keepBuiltinOnly
// ---------------------------------------------------------------------------
check('keepBuiltinOnly=true: builtin-only models are preserved', () => {
  // mimo-v2-pro was xiaomi builtin-only when this test was written; pi-ai
  // 0.84.4 later dropped it from the catalog. Force the builtin-only
  // condition via a synthetic builtin list — the behavior under test is
  // keepBuiltinOnly's preservation, not the catalog's current membership.
  const xiaomiBuiltinWithMimo = xiaomiBuiltin.some(b => b.id === 'mimo-v2-pro')
    ? xiaomiBuiltin
    : [...xiaomiBuiltin, { id: 'mimo-v2-pro', api: 'anthropic-messages' }]
  const builtinIds = new Set(xiaomiBuiltinWithMimo.map(b => b.id))
  const builtinOnlyEntries = xiaomiBuiltinWithMimo
    .filter(b => !xiaomiCn.models.some(e => e.id === b.id))
    .map(b => ({
      id: b.id,
      name: b.id,
      api: b.api,
      provider: 'xiaomi-token-plan-cn',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      maxTokens: b.maxTokens,
    }))

  const result = translateEntries(
    xiaomiCn.models,
    builtinIds,
    xiaomiBuiltinWithMimo,
    'xiaomi-token-plan-cn',
    { ...defaultOpts, keepBuiltinOnly: true },
    builtinOnlyEntries,
  )

  assert.ok(result.entries.some(e => e.id === 'mimo-v2-pro'), 'mimo-v2-pro should be preserved with keepBuiltinOnly=true')
  assert.ok(result.entries.some(e => e.id === 'mimo-v2.5'), 'mimo-v2.5 should still be present')
  assert.ok(result.entries.some(e => e.id === 'mimo-v2.5-pro'), 'mimo-v2.5-pro should still be present')
})

check('keepBuiltinOnly=false: builtin-only models are NOT included', () => {
  const builtinIds = new Set(xiaomiBuiltin.map(b => b.id))
  const result = translateEntries(
    xiaomiCn.models,
    builtinIds,
    xiaomiBuiltin,
    'xiaomi-token-plan-cn',
    { ...defaultOpts, keepBuiltinOnly: false },
  )

  assert.ok(!result.entries.some(e => e.id === 'mimo-v2-pro'), 'mimo-v2-pro should NOT be present with keepBuiltinOnly=false')
})

// ---------------------------------------------------------------------------
// reasoningEfforts format: dict not array
// ---------------------------------------------------------------------------
check('reasoningEfforts: output is dict format, not array', () => {
  const builtinIds = new Set(zaiBuiltin.map(b => b.id))
  const result = translateEntries(
    zaiCn.models,
    builtinIds,
    zaiBuiltin,
    'zai-coding-cn',
    defaultOpts,
  )

  // glm-5.2 has thinkingLevelMap, should be used as reasoningEfforts
  const glm52 = result.entries.find(e => e.id === 'glm-5.2')
  assert.ok(glm52, 'glm-5.2 should be in result')
  assert.ok(glm52.reasoningEfforts, 'glm-5.2 should have reasoningEfforts')
  assert.ok(!Array.isArray(glm52.reasoningEfforts), 'reasoningEfforts should be a dict, not an array')
  // Check it has at least low/high keys
  const keys = Object.keys(glm52.reasoningEfforts)
  assert.ok(keys.length >= 2, 'reasoningEfforts should have at least 2 keys')
  // Values should be string or null
  for (const [k, v] of Object.entries(glm52.reasoningEfforts)) {
    assert.ok(typeof v === 'string' || v === null, `reasoningEfforts.${k} should be string or null, got ${typeof v}`)
  }
})

check('reasoningEfforts: entries with thinkingLevelMap use it directly', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // deepseek-v4-flash has thinkingLevelMap
  const dsFlash = result.entries.find(e => e.id === 'deepseek-v4-flash')
  assert.ok(dsFlash, 'deepseek-v4-flash should be in result')
  assert.ok(dsFlash.reasoningEfforts, 'deepseek-v4-flash should have reasoningEfforts')
  // It should have keys from thinkingLevelMap (minimal, low, medium, high, max)
  assert.ok(Object.keys(dsFlash.reasoningEfforts).length >= 2, 'should have multiple effort levels')
})

check('reasoningEfforts: entries without thinkingLevelMap get default low/high', () => {
  const builtinIds = new Set(zaiBuiltin.map(b => b.id))
  const result = translateEntries(
    zaiCn.models,
    builtinIds,
    zaiBuiltin,
    'zai-coding-cn',
    defaultOpts,
  )

  // glm-5.2 has thinkingLevelMap, so it uses that
  // But entries with SRE=true and no thinkingLevelMap would get default
  // For this test, check that the result is valid dict format
  for (const entry of result.entries) {
    if (entry.reasoningEfforts !== undefined) {
      assert.ok(typeof entry.reasoningEfforts === 'object', 'should be an object')
      assert.ok(!Array.isArray(entry.reasoningEfforts), 'should not be an array')
    }
  }
})

// ---------------------------------------------------------------------------
// B2: reasoningEfforts whitelist filtering
// ---------------------------------------------------------------------------
check('B2: thinkingLevelMap with non-whitelist keys is filtered', () => {
  // Create a mock entry with off:null and a custom key
  const mockEntries = [{
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'test-route',
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    compat: { thinkingFormat: 'test', supportsReasoningEffort: true },
    thinkingLevelMap: { off: null, custom: 'val', low: 'low', high: 'high' },
  }]
  const result = translateEntries(
    mockEntries,
    new Set(),
    [],
    'test-route',
    defaultOpts,
  )

  const entry = result.entries.find(e => e.id === 'test-model')
  assert.ok(entry, 'test-model should be in result')
  assert.ok(entry.reasoningEfforts, 'should have reasoningEfforts')
  // 'off' (null value) and 'custom' (not in whitelist) should be filtered
  assert.ok(!('off' in entry.reasoningEfforts), '"off" with null should be filtered')
  assert.ok(!('custom' in entry.reasoningEfforts), '"custom" not in whitelist should be filtered')
  assert.ok('low' in entry.reasoningEfforts, '"low" should remain')
  assert.ok('high' in entry.reasoningEfforts, '"high" should remain')
})

check('B2: thinkingLevelMap with only off:null falls back to low/high default', () => {
  const mockEntries = [{
    id: 'test-model-2',
    name: 'Test Model 2',
    api: 'openai-completions',
    provider: 'test-route',
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    compat: { thinkingFormat: 'test', supportsReasoningEffort: true },
    thinkingLevelMap: { off: null },
  }]
  const result = translateEntries(
    mockEntries,
    new Set(),
    [],
    'test-route',
    defaultOpts,
  )

  const entry = result.entries.find(e => e.id === 'test-model-2')
  assert.ok(entry, 'test-model-2 should be in result')
  assert.ok(entry.reasoningEfforts, 'should have reasoningEfforts')
  assert.deepEqual(entry.reasoningEfforts, { low: 'low', high: 'high' }, 'should fall back to low/high default')
})

check('B2: thinkingLevelMap with all null values falls back to low/high default', () => {
  const mockEntries = [{
    id: 'test-model-3',
    name: 'Test Model 3',
    api: 'openai-completions',
    provider: 'test-route',
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    compat: { thinkingFormat: 'test', supportsReasoningEffort: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: null },
  }]
  const result = translateEntries(
    mockEntries,
    new Set(),
    [],
    'test-route',
    defaultOpts,
  )

  const entry = result.entries.find(e => e.id === 'test-model-3')
  assert.ok(entry, 'test-model-3 should be in result')
  assert.ok(entry.reasoningEfforts, 'should have reasoningEfforts')
  assert.deepEqual(entry.reasoningEfforts, { low: 'low', high: 'high' }, 'all-null should fall back to low/high')
})

// ---------------------------------------------------------------------------
// Output is sorted by id
// ---------------------------------------------------------------------------
check('output is sorted by id', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    defaultOpts,
  )

  for (let i = 1; i < result.entries.length; i++) {
    assert.ok(
      result.entries[i - 1].id.localeCompare(result.entries[i].id) <= 0,
      `entries should be sorted by id: ${result.entries[i - 1].id} should come before ${result.entries[i].id}`,
    )
  }
})

// ---------------------------------------------------------------------------
// api-divergent entries are written with degrade warning
// ---------------------------------------------------------------------------
check('api-divergent entries are written with degrade warning', () => {
  // qwen3.7-max/plus: pi.dev says openai-completions; the builtin catalog
  // used to say anthropic-messages (pi-ai 0.84.4 aligned them). Force the
  // divergence via a synthetic builtin — the behavior under test is the
  // degrade warning on api mismatch, not the catalog's current opinion.
  const divergentBuiltin = opencodeGoBuiltin.map(b =>
    b.id === 'qwen3.7-max' || b.id === 'qwen3.7-plus' ? { ...b, api: 'anthropic-messages' } : b,
  )
  const builtinIds = new Set(divergentBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    divergentBuiltin,
    'opencode-go',
    defaultOpts,
  )

  // pi.dev api=openai-completions, forced builtin api=anthropic-messages
  const qwen37max = result.entries.find(e => e.id === 'qwen3.7-max')
  const qwen37plus = result.entries.find(e => e.id === 'qwen3.7-plus')
  assert.ok(qwen37max, 'qwen3.7-max should be in result (not dropped)')
  assert.ok(qwen37plus, 'qwen3.7-plus should be in result (not dropped)')

  // Should have degrade warnings
  assert.ok(result.warnings.some(w => w.id === 'qwen3.7-max'), 'qwen3.7-max should have degrade warning')
  assert.ok(result.warnings.some(w => w.id === 'qwen3.7-plus'), 'qwen3.7-plus should have degrade warning')
})

// ---------------------------------------------------------------------------
// forceMaxReasoningEffort
// ---------------------------------------------------------------------------
check('forceMax: SRE=false model gets reasoningEfforts when force=true', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  // kimi-k2.6 has thinkingFormat=deepseek but supportsReasoningEffort=false
  // With force=true, it should now get reasoningEfforts
  const kimi = result.entries.find(e => e.id === 'kimi-k2.6')
  assert.ok(kimi, 'kimi-k2.6 should be in result')
  assert.ok(kimi.reasoningEfforts, 'kimi-k2.6 should have reasoningEfforts with force=true')
  assert.ok(!Array.isArray(kimi.reasoningEfforts), 'reasoningEfforts should be a dict')
})

check('forceMax: thinkingLevelMap with max=null is filled to max when force=true', () => {
  // Mock entry with thinkingLevelMap where max is null (filtered out normally)
  const mockEntries = [{
    id: 'test-force-max',
    name: 'Test Force Max',
    api: 'openai-completions',
    provider: 'test-route',
    baseUrl: '',
    reasoning: true,
    input: ['text'],
    compat: { thinkingFormat: 'test', supportsReasoningEffort: false },
    thinkingLevelMap: { low: 'low', high: 'high', max: null },
  }]
  const result = translateEntries(
    mockEntries,
    new Set(),
    [],
    'test-route',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  const entry = result.entries.find(e => e.id === 'test-force-max')
  assert.ok(entry, 'test-force-max should be in result')
  assert.ok(entry.reasoningEfforts, 'should have reasoningEfforts')
  assert.ok('low' in entry.reasoningEfforts, 'should have low')
  assert.ok('high' in entry.reasoningEfforts, 'should have high')
  assert.ok('max' in entry.reasoningEfforts, 'should have max (filled by force)')
  assert.equal(entry.reasoningEfforts.max, 'max', 'max should be filled as "max"')
})

check('forceMax: thinkingFormat empty → no reasoningEfforts even with force=true', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  // hy3 has no thinkingFormat — force should not help
  const hy3 = result.entries.find(e => e.id === 'hy3')
  assert.ok(hy3, 'hy3 should be in result')
  assert.equal(hy3.reasoningEfforts, undefined, 'hy3 (no thinkingFormat) should NOT have reasoningEfforts even with force=true')
})

check('forceMax: openai-completions → compat.supportsReasoningEffort=true when force=true', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  // kimi-k2.6 is openai-completions, had SRE=false → with force, compat.SRE should be true
  const kimi = result.entries.find(e => e.id === 'kimi-k2.6')
  assert.ok(kimi, 'kimi-k2.6 should be in result')
  assert.ok(kimi.compat, 'kimi-k2.6 should have compat')
  assert.equal(kimi.compat.supportsReasoningEffort, true, 'kimi-k2.6 compat.supportsReasoningEffort should be true with force=true')

  // deepseek-v4-flash is also openai-completions
  const dsFlash = result.entries.find(e => e.id === 'deepseek-v4-flash')
  assert.ok(dsFlash, 'deepseek-v4-flash should be in result')
  assert.ok(dsFlash.compat, 'deepseek-v4-flash should have compat')
  assert.equal(dsFlash.compat.supportsReasoningEffort, true, 'deepseek-v4-flash compat.supportsReasoningEffort should be true with force=true')
})

check('forceMax: openai-completions + thinkingFormat empty → no compat.SRE even with force=true', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  // hy3 is openai-completions but has NO thinkingFormat → force should NOT write compat.supportsReasoningEffort
  const hy3 = result.entries.find(e => e.id === 'hy3')
  assert.ok(hy3, 'hy3 should be in result')
  // compat should either be absent or not contain supportsReasoningEffort
  const sre = hy3.compat?.supportsReasoningEffort
  assert.equal(sre, undefined, 'hy3 (openai-completions, no thinkingFormat) should NOT get compat.supportsReasoningEffort even with force=true')
})

check('forceMax: non-openai-completions → no compat written even with force=true', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: true },
  )

  // minimax-m3 is anthropic-messages (base-matching) — should still NOT get compat
  const m3 = result.entries.find(e => e.id === 'minimax-m3')
  assert.ok(m3, 'minimax-m3 should be in result')
  assert.equal(m3.compat, undefined, 'minimax-m3 (anthropic-messages) should NOT have compat even with force=true')
})

check('forceMax: force=false → behavior unchanged (regression)', () => {
  const builtinIds = new Set(opencodeGoBuiltin.map(b => b.id))
  const result = translateEntries(
    opencodeGo.models,
    builtinIds,
    opencodeGoBuiltin,
    'opencode-go',
    { ...defaultOpts, forceMaxReasoningEffort: false },
  )

  // kimi-k2.6 should still NOT have reasoningEfforts (SRE=false, force=false)
  const kimi = result.entries.find(e => e.id === 'kimi-k2.6')
  assert.ok(kimi, 'kimi-k2.6 should be in result')
  assert.equal(kimi.reasoningEfforts, undefined, 'kimi-k2.6 should NOT have reasoningEfforts with force=false')

  // deepseek-v4-flash should still have reasoningEfforts (SRE not false)
  const dsFlash = result.entries.find(e => e.id === 'deepseek-v4-flash')
  assert.ok(dsFlash, 'deepseek-v4-flash should be in result')
  assert.ok(dsFlash.reasoningEfforts, 'deepseek-v4-flash should still have reasoningEfforts')
})

// ---------------------------------------------------------------------------
// Capacity sanity guards (deviation from design doc §3.3 rules 3/5)
// ---------------------------------------------------------------------------
const builtinSynthetic = [{ id: 'known-a', api: 'openai-completions', maxTokens: 8192 }]
const builtinSyntheticIds = new Set(['known-a'])

const baseEntry = {
  name: 'Echo Model',
  api: 'openai-completions',
  provider: 'opencode-go',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
}

check('capacity guard: base-less maxTokens ≥ contextWindow (listing echo) is stripped with degrade warning', () => {
  const entries = [{
    ...baseEntry,
    id: 'echo-model',
    contextWindow: 500000,
    maxTokens: 500000,
  }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'echo-model')
  assert.ok(entry, 'entry is still written')
  assert.equal(entry.maxTokens, undefined, 'echoed maxTokens must not be written')
  assert.equal(entry.contextWindow, 500000)
  const warn = result.warnings.find(w => w.id === 'echo-model')
  assert.ok(warn, 'a degrade warning explains the strip')
  assert.equal(warn.severity, 'degrade')
  assert.ok(warn.reason.includes('echo'), `warning mentions the echo: ${warn.reason}`)
})

check('capacity guard: base-less maxTokens < contextWindow is kept', () => {
  const entries = [{ ...baseEntry, id: 'sane-model', contextWindow: 200000, maxTokens: 32768 }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'sane-model')
  assert.equal(entry.maxTokens, 32768, 'plausible maxTokens survives')
  assert.equal(result.warnings.length, 0)
})

check('capacity guard: base-less maxTokens with no contextWindow is kept (nothing to compare)', () => {
  const entries = [{ ...baseEntry, id: 'ctx-less-model', maxTokens: 16384 }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'ctx-less-model')
  assert.equal(entry.maxTokens, 16384)
  assert.equal(result.warnings.length, 0)
})

check('capacity guard: non-integer maxTokens is stripped with degrade warning', () => {
  const entries = [{ ...baseEntry, id: 'odd-model', contextWindow: 100000, maxTokens: 1.5 }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'odd-model')
  assert.equal(entry.maxTokens, undefined)
  assert.ok(result.warnings.some(w => w.id === 'odd-model' && w.reason.includes('positive integer')))
})

check('capacity guard: garbage contextWindow is skipped with degrade warning, entry kept', () => {
  const entries = [{ ...baseEntry, id: 'bad-ctx-model', contextWindow: -1, maxTokens: 4096 }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'bad-ctx-model')
  assert.ok(entry, 'entry itself is serviceable and stays')
  assert.equal(entry.contextWindow, undefined, 'garbage contextWindow is not written')
  // maxTokens: contextWindow unknown after the skip → nothing to compare, keep
  assert.equal(entry.maxTokens, 4096)
  assert.ok(result.warnings.some(w => w.id === 'bad-ctx-model' && w.reason.includes('contextWindow')))
})

check('capacity guard: base-matching entry keeps contextWindow sync, still strips maxTokens', () => {
  const entries = [{
    ...baseEntry,
    id: 'known-a', // base-matching
    contextWindow: 300000,
    maxTokens: 9999,
  }]
  const result = translateEntries(entries, builtinSyntheticIds, builtinSynthetic, 'opencode-go', defaultOpts)
  const entry = result.entries.find(e => e.id === 'known-a')
  assert.equal(entry.contextWindow, 300000, 'fresh contextWindow from the listing is the sync value-prop')
  assert.equal(entry.maxTokens, undefined, 'base-matching maxTokens still falls back to the installed catalog')
  assert.equal(result.warnings.length, 0)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

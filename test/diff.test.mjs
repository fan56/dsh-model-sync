// Plan C (settings-seam): tests for diff utilities.

/**
 * Tests for diff.ts — covers diffModelIds (existing) and diffEntries (new).
 */

import assert from 'node:assert/strict'
import { diffModelIds, diffEntries } from '../lib/diff.js'

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
// Existing: diffModelIds
// ---------------------------------------------------------------------------
check('diff reports added and removed ids in stable order', () => {
  const { added, removed } = diffModelIds(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])
  assert.deepEqual(added, ['d', 'e'])
  assert.deepEqual(removed, ['a'])
})

check('diff is empty when nothing changed', () => {
  const { added, removed } = diffModelIds(['a', 'b'], ['b', 'a'])
  assert.deepEqual(added, [])
  assert.deepEqual(removed, [])
})

check('diff handles the empty side', () => {
  assert.deepEqual(diffModelIds([], ['x']), { added: ['x'], removed: [] })
  assert.deepEqual(diffModelIds(['x'], []), { added: [], removed: ['x'] })
})

// ---------------------------------------------------------------------------
// New: diffEntries
// ---------------------------------------------------------------------------
check('diffEntries: identical lists have no changes', () => {
  const entries = [
    { id: 'a', name: 'A', contextWindow: 1000 },
    { id: 'b', name: 'B' },
  ]
  const result = diffEntries(entries, [...entries])
  assert.equal(result.hasChanges, false)
  assert.equal(result.added.length, 0)
  assert.equal(result.removed.length, 0)
  assert.equal(result.changed.length, 0)
})

check('diffEntries: detects added entries', () => {
  const current = [{ id: 'a' }]
  const target = [{ id: 'a' }, { id: 'b' }]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, true)
  assert.deepEqual(result.added, ['b'])
  assert.equal(result.removed.length, 0)
})

check('diffEntries: detects removed entries', () => {
  const current = [{ id: 'a' }, { id: 'b' }]
  const target = [{ id: 'a' }]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, true)
  assert.equal(result.added.length, 0)
  assert.deepEqual(result.removed, ['b'])
})

check('diffEntries: detects field-level changes', () => {
  const current = [{ id: 'a', name: 'Old Name', contextWindow: 1000 }]
  const target = [{ id: 'a', name: 'New Name', contextWindow: 1000 }]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, true)
  assert.equal(result.changed.length, 1)
  assert.equal(result.changed[0].id, 'a')
  assert.equal(result.changed[0].field, 'name')
  assert.equal(result.changed[0].current, 'Old Name')
  assert.equal(result.changed[0].target, 'New Name')
})

check('diffEntries: detects maxTokens change (field present → absent)', () => {
  const current = [{ id: 'a', maxTokens: 131072 }]
  const target = [{ id: 'a' }]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, true)
  assert.equal(result.changed.length, 1)
  assert.equal(result.changed[0].field, 'maxTokens')
})

check('diffEntries: no change when content is identical', () => {
  const current = [
    { id: 'a', name: 'A', contextWindow: 1000, input: ['text', 'image'] },
    { id: 'b', reasoningEfforts: { low: 'low', high: 'high' } },
  ]
  const target = [
    { id: 'a', name: 'A', contextWindow: 1000, input: ['text', 'image'] },
    { id: 'b', reasoningEfforts: { low: 'low', high: 'high' } },
  ]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, false)
})

check('diffEntries: empty lists', () => {
  const result = diffEntries([], [])
  assert.equal(result.hasChanges, false)
})

check('diffEntries: both add and remove', () => {
  const current = [{ id: 'a' }, { id: 'b' }]
  const target = [{ id: 'b' }, { id: 'c' }]
  const result = diffEntries(current, target)
  assert.equal(result.hasChanges, true)
  assert.deepEqual(result.added, ['c'])
  assert.deepEqual(result.removed, ['a'])
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

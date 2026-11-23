// P0 protocol grouping: pure §6.2.3 algorithm tests.

import assert from 'node:assert/strict'
import { groupGoModelsByProtocol, slotForProtocol } from '../lib/opencode-go-grouping.js'

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

const record = (id, protocols, recommendedProtocol) => ({
  id,
  name: id,
  protocols,
  ...(recommendedProtocol !== undefined ? { recommendedProtocol } : {}),
  baseUrls: {},
  inputModalities: ['text'],
  provenance: 'go-official',
})

check('chat-completions wins when present alongside other protocols', () => {
  const result = groupGoModelsByProtocol([
    record('a', ['messages', 'chat-completions'], 'messages'),
  ])
  assert.deepEqual(result.slots.chat, ['a'])
  assert.deepEqual(result.slots.msg, [])
  assert.equal(result.unassigned.length, 0)
})

check('single messages → msg, single responses → resp', () => {
  const result = groupGoModelsByProtocol([
    record('m', ['messages']),
    record('r', ['responses']),
  ])
  assert.deepEqual(result.slots.msg, ['m'])
  assert.deepEqual(result.slots.resp, ['r'])
})

check('google subset (interactions / generate-content) → google', () => {
  const result = groupGoModelsByProtocol([
    record('g1', ['interactions']),
    record('g2', ['generate-content']),
    record('g3', ['interactions', 'generate-content']),
  ])
  assert.deepEqual(result.slots.google, ['g1', 'g2', 'g3'])
})

check('multiple non-chat protocols use recommended_api as tie-break', () => {
  const result = groupGoModelsByProtocol([
    record('t1', ['messages', 'interactions'], 'messages'),
    record('t2', ['responses', 'generate-content'], 'responses'),
    record('t3', ['messages', 'responses'], 'generate-content'),
  ])
  assert.deepEqual(result.slots.msg, ['t1'])
  assert.deepEqual(result.slots.resp, ['t2'])
  assert.deepEqual(result.slots.google, ['t3'])
})

check('unsupported and unknown protocols are reported, never placed', () => {
  const result = groupGoModelsByProtocol([
    record('empty', []),
    record('weird', ['mystery-protocol']),
    record('tie', ['messages', 'responses']),
  ])
  assert.deepEqual(result.unassigned, [
    { id: 'empty', protocols: [], reason: 'unsupported-protocol' },
    { id: 'weird', protocols: ['mystery-protocol'], reason: 'unknown-protocol' },
    { id: 'tie', protocols: ['messages', 'responses'], reason: 'unsupported-protocol' },
  ])
  for (const slot of Object.values(result.slots)) assert.deepEqual(slot, [])
})

check('slotForProtocol maps only the five known protocol names', () => {
  assert.equal(slotForProtocol('chat-completions'), 'chat')
  assert.equal(slotForProtocol('messages'), 'msg')
  assert.equal(slotForProtocol('responses'), 'resp')
  assert.equal(slotForProtocol('interactions'), 'google')
  assert.equal(slotForProtocol('generate-content'), 'google')
  assert.equal(slotForProtocol('bogus'), undefined)
})

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

// P1c file ledger adapter. Every write goes to a per-test temp directory —
// the real ~/.dsh is never touched. Covers atomic temp+rename, corrupt-file
// recovery, cross-keyFingerprint isolation, and queue sharing with the fetch
// cache (verification 21 §9 concern ②: no parallel RMW queue allowed).

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModelsStore, resetModelsStoreCache } from '../lib/remote-catalog.js'
import { createFileOwnershipStore } from '../lib/opencode-go-store.js'
import { goOwnershipKey } from '../lib/opencode-go-planner.js'
import { createFileMigrationStateStore, GO_MIGRATION_STORE_KEY } from '../lib/opencode-go-migration.js'

let failed = 0
let passed = 0
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

const entry = (id) => ({
  routeFields: { api: 'openai-completions', baseURL: 'https://opencode.ai/inference/go/openai/v1' },
  managed: { [id]: { hash: `hash-${id}` } },
  preManagedSnapshot: [{ id }],
})

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-go-store-'))
  const file = join(dir, 'models-store.json')
  try {
    await fn({ dir, file })
  } finally {
    // Only the temp dir this test created; never a real dsh home.
    await rm(dir, { recursive: true, force: true })
    resetModelsStoreCache()
  }
}

await checkAsync('atomic write: key is <route>#<keyFingerprint>; no temp leftovers', () => withTemp(async ({ dir, file }) => {
  const accessor = loadModelsStore(file)
  const store = createFileOwnershipStore(accessor)
  const key = goOwnershipKey('opencode-go', 'fp-one')
  assert.equal(key, 'opencode-go#fp-one')
  await store.write(key, entry('hy4'))
  assert.deepEqual(await store.read(key), entry('hy4'))
  const names = await readdir(dir)
  assert.deepEqual(names, ['models-store.json'], 'temp file renamed away, not left behind')
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc[key], entry('hy4'))
  assert.equal(doc['opencode-go'], undefined, 'ledger slot is not a fetch-cache route entry')
}))

await checkAsync('concurrent writes share the queue and keep both slots', () => withTemp(async ({ file }) => {
  const accessor = loadModelsStore(file)
  const store = createFileOwnershipStore(accessor)
  const k1 = goOwnershipKey('opencode-go', 'fp-a')
  const k2 = goOwnershipKey('opencode-go-msg', 'fp-a')
  await Promise.all([
    store.write(k1, entry('chat-model')),
    store.write(k2, entry('msg-model')),
    accessor.update('opencode-go', { models: [{ id: 'from-fetch' }], checkedAt: 123 }),
  ])
  assert.deepEqual(await store.read(k1), entry('chat-model'))
  assert.deepEqual(await store.read(k2), entry('msg-model'))
  const cached = await accessor.read('opencode-go')
  assert.deepEqual(cached.models, [{ id: 'from-fetch' }], 'fetch cache survived concurrent ledger writes')
}))

await checkAsync('corrupt file: read degrades to no ledger, next write heals it', () => withTemp(async ({ file }) => {
  await writeFile(file, '{ this is not json', 'utf8')
  const store = createFileOwnershipStore(loadModelsStore(file))
  const key = goOwnershipKey('opencode-go', 'fp-x')
  assert.equal(await store.read(key), undefined, 'no ledger → writer never deletes')
  await store.write(key, entry('restored'))
  assert.deepEqual(await store.read(key), entry('restored'))
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8'))[key], entry('restored'))
}))

await checkAsync('keyFingerprint isolation: another key cannot read or delete this ledger', () => withTemp(async ({ file }) => {
  const store = createFileOwnershipStore(loadModelsStore(file))
  const k1 = goOwnershipKey('opencode-go', 'key-one')
  const k2 = goOwnershipKey('opencode-go', 'key-two')
  await store.write(k1, entry('under-key-one'))
  await store.write(k2, entry('under-key-two'))
  assert.deepEqual(await store.read(k1), entry('under-key-one'))
  assert.deepEqual(await store.read(k2), entry('under-key-two'))
  await store.delete(k1)
  assert.equal(await store.read(k1), undefined)
  assert.deepEqual(await store.read(k2), entry('under-key-two'), 'deleting one key leaves the other intact')
}))

await checkAsync('migration record write shares the atomic queue with the ledger', () => withTemp(async ({ dir, file }) => {
  const accessor = loadModelsStore(file)
  const migration = createFileMigrationStateStore(accessor)
  const ledger = createFileOwnershipStore(accessor)
  const record = {
    appliedIdentity: 'identity-hash',
    appliedIdentityRoutes: ['opencode-go'],
    appliedManagedIds: { 'opencode-go': ['a'] },
    appliedFingerprint: 'fingerprint-hash',
  }
  const key = goOwnershipKey('opencode-go', 'fp-one')
  await Promise.all([migration.write(record), ledger.write(key, entry('hy4'))])
  assert.deepEqual(await migration.read(), record)
  assert.deepEqual(await ledger.read(key), entry('hy4'))
  const doc = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(doc[GO_MIGRATION_STORE_KEY], record, 'fingerprint slot persisted atomically')
  assert.deepEqual(await readdir(dir), ['models-store.json'], 'no temp files left behind')
}))

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

// One-shot migrate-go: `/model-sync migrate-go` — flags, backups/retention,
// the YAML-subset patch editor, the fail-closed confirmation, the apply loop,
// and the byte-restore failure path. Everything runs against temp dirs; no
// test touches the real ~/.dsh.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  GO_MIGRATION_ENTRIES_SERVICE,
  GO_MIGRATION_MUTEX_SERVICE,
  GO_ONESHOT_PATHS_SERVICE,
} from '../lib/index.js'
import { GO_MIGRATION_STORE_SERVICE } from '../lib/opencode-go-migration.js'
import { GO_OWNERSHIP_STORE_SERVICE } from '../lib/opencode-go-sync.js'
import {
  formatStamp,
  legacyStubsOf,
  MIGRATE_GO_USAGE,
  nextBackupPath,
  parseMigrateGoFlags,
  pruneBackups,
} from '../lib/opencode-go-one-shot.js'
import {
  applyPatchOps,
  createFilePatchSettingsService,
  parsePatchDocument,
  patchLlmPiAiProviders,
  renderYamlScalar,
} from '../lib/opencode-go-patch-file.js'
import { parseGoModelsPayload, fingerprintKey } from '../lib/opencode-go-source.js'

let failed = 0
let passed = 0
const checkAsync = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.stack ?? error.message}`)
  }
}

const check = (name, fn) => checkAsync(name, async () => fn())

const KEY = 'test-go-key'
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-models.json', import.meta.url), 'utf8'))
// Three-route topology (chat/msg/resp): the google slot stays conditional-off.
const OFFICIAL = parseGoModelsPayload(FIXTURE).filter((entry) => entry.id !== 'gemini-4-argon')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A realistic profile patch: handwritten opencode-go stub + untouched providers. */
const CURR_PATCH = [
  '# test profile patch — handwritten opencode-go stub + unrelated providers.',
  '# Comments and formatting everywhere must survive any rewrite byte-for-byte.',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      minimax-cn:',
  '        apiKeyEnv: MINIMAX_CN_API_KEY',
  '        models:',
  '          - id: MiniMax-M2.7',
  '            name: MiniMax-M2.7',
  '            contextWindow: 204800',
  '            input:',
  '              - text',
  '      opencode-go:',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '        models:',
  '          - id: custom-test-model',
  '            name: Custom Test Model',
  '            contextWindow: 1000000',
  '            input:',
  '              - text',
  '      opencode-go-free:',
  '        api: openai-completions',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '        baseURL: https://opencode.ai/inference/go/openai/v1',
  '        models:',
  '          - id: hungerg-free',
  '            name: HungerG Free',
  '            contextWindow: 1000000',
  '            input:',
  '              - text',
  '              - image',
  '# trailing comment must survive any rewrite.',
  '',
].join('\n')

const OTHER_PATCH = CURR_PATCH
  .replace('test profile patch', 'other profile patch')
  .replace('custom-test-model', 'custom-other-model')

function mockSettings(initialRoutes = {}) {
  const state = new Map(Object.entries(initialRoutes).map(([r, d]) => [r, structuredClone(d)]))
  const mutations = []
  const updates = []
  let revision = 1
  return {
    state,
    mutations,
    updates,
    describe() {
      return [
        { ns: 'llm-pi-ai', revision, user: { providers: Object.fromEntries([...state].map(([r, d]) => [r, structuredClone(d)])) } },
        { ns: 'dsh-model-sync', revision: 1, user: {} },
      ]
    },
    async mutate(ns, ops, expectedRevision) {
      if (ns !== 'llm-pi-ai') throw Object.assign(new Error(`unexpected namespace ${ns}`), { code: 'UNSUPPORTED_NS' })
      if (expectedRevision !== revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
      mutations.push(structuredClone(ops))
      for (const op of ops) {
        const route = op.path[1]
        if (op.op === 'unset' && op.path.length === 2) { state.delete(route); continue }
        let data = state.get(route)
        if (data === undefined) { data = {}; state.set(route, data) }
        if (op.op === 'unset') delete data[op.path[2]]
        else data[op.path[2]] = structuredClone(op.value)
      }
      revision += 1
    },
    async update(ns, patch) {
      updates.push({ ns, patch })
    },
  }
}

/** ask-user seam recorder: script decides what the "user" does. */
function makeAsk(script = { mode: 'approve' }) {
  const recorder = { questions: [], calls: 0, ...script }
  recorder.service = {
    async ask(request) {
      recorder.calls += 1
      recorder.questions.push(request)
      if (recorder.mode === 'throw') throw Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' })
      const label = recorder.mode === 'cancel' ? '取消' : '执行迁移'
      return { answers: [{ id: request.questions[0].id, selected: recorder.mode === 'blank' ? [] : [label] }] }
    },
  }
  return recorder
}

/**
 * Offline harness over a temp dsh home. Real fs for patches/backups/stores
 * (path overrides keep everything inside the temp dir); in-memory settings
 * seam for the current profile; the official listing is injected, so there
 * are zero outbound calls.
 */
function createHarness({
  patchText = CURR_PATCH,
  extraProfiles = {},
  ask,
  storeSeed,
  ownershipFaultOnKeyPrefix,
  credentialFault = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-migrate-go-'))
  const home = join(root, 'dsh')
  const profilesDir = join(home, 'profiles')
  mkdirSync(profilesDir, { recursive: true })
  const currDir = join(profilesDir, 'curr')
  mkdirSync(currDir, { recursive: true })
  const storePath = join(home, 'models-store.json')
  if (storeSeed !== undefined) writeFileSync(storePath, JSON.stringify(storeSeed))
  writeFileSync(join(currDir, 'cordis.patch.yml'), patchText)
  for (const [name, text] of Object.entries(extraProfiles)) {
    const dir = join(profilesDir, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cordis.patch.yml'), text)
  }

  const settings = mockSettings({
    'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 204800, input: ['text'] }] },
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY', models: [{ id: 'custom-test-model', name: 'Custom Test Model', contextWindow: 1000000, input: ['text'] }] },
    'opencode-go-free': {
      api: 'openai-completions', apiKeyEnv: 'OPENCODE_GO_API_KEY',
      baseURL: 'https://opencode.ai/inference/go/openai/v1',
      models: [{ id: 'hungerg-free', name: 'HungerG Free', contextWindow: 1000000, input: ['text', 'image'] }],
    },
  })
  const logs = []
  const listeners = []
  const timers = []
  const state = { definitions: [], disposers: [], provided: {} }

  const migrationStoreData = new Map()
  const ownership = {
    async read(key) {
      if (ownershipFaultOnKeyPrefix !== undefined && key.startsWith(ownershipFaultOnKeyPrefix)) {
        throw new Error(`fault-injected ledger read failure for ${key}`)
      }
      const value = migrationStoreData.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },
    async write(key, entry) {
      if (ownershipFaultOnKeyPrefix !== undefined && key.startsWith(ownershipFaultOnKeyPrefix)) {
        throw new Error(`fault-injected ledger write failure for ${key}`)
      }
      migrationStoreData.set(key, structuredClone(entry))
    },
    async delete(key) { migrationStoreData.delete(key) },
    get data() { return migrationStoreData },
  }
  // Boot-time seams only (loadMigrationStatus / scheduler / migrate commands).
  // The one-shot builds its own per-profile file-backed stores over the
  // overridden models-store path, so these fakes never serve the migration.
  const bootMigrationStore = {
    async read() { return undefined },
    async write() {},
  }

  const askHarness = ask ?? makeAsk()
  const services = {
    settings,
    profileContext: { name: 'curr', dir: currDir },
    launchEnvironment: { get: () => undefined },
    credentials: {
      describe: async () => ({ configured: true }),
      resolve: async () => (credentialFault ? undefined : { value: KEY }),
    },
    [GO_MIGRATION_ENTRIES_SERVICE]: OFFICIAL,
    [GO_MIGRATION_STORE_SERVICE]: bootMigrationStore,
    [GO_OWNERSHIP_STORE_SERVICE]: ownership,
    [GO_ONESHOT_PATHS_SERVICE]: {
      home,
      modelsStorePath: storePath,
      profilesDir,
      ...(ownershipFaultOnKeyPrefix !== undefined ? { testOnlyOwnershipWriteFaultPrefix: ownershipFaultOnKeyPrefix } : {}),
    },
    userQuestions: askHarness.service,
    [GO_MIGRATION_MUTEX_SERVICE]: () => false,
  }

  const config = (() => {
    const base = {
      writeMode: 'settings',
      intervalMinutes: 0,
      startupDelaySeconds: 0,
      refreshTimeoutMs: 120000,
      managedRoutes: ['opencode-go'],
      keepBuiltinOnly: false,
      dropUnserviceable: true,
      syncNotify: false,
      forceMaxReasoningEffort: false,
      providerNativeFetch: false,
      keepDeprecatedBuiltin: false,
    }
    const wrapped = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { get: () => v }]))
    wrapped.opencode = {
      go: {
        enabled: true,
        ref: 'OPENCODE_GO_API_KEY',
        modelsUrl: 'https://opencode.ai/inference/go/v1/models',
        pinnedModels: [],
        confirmRemovals: 2,
        adoptExisting: false,
        routes: { chat: 'opencode-go', msg: 'opencode-go-msg', resp: 'opencode-go-resp', google: 'opencode-go-google' },
      },
    }
    return wrapped
  })()

  const ctx = {
    settings,
    get: (name) => services[name],
    logger: {
      info(...args) { logs.push(args.map(String).join(' ')) },
      warn(...args) { logs.push(args.map(String).join(' ')) },
      debug() {},
    },
    on(event, listener) { listeners.push({ event, listener }); return () => {} },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposers.push(d); return d },
    provide(name, service) { state.provided[name] = service },
    inject(names, callback) { for (const name of names) if (ctx[name] === undefined) return; callback(Object.create(ctx)) },
    commands: { register(definition) { state.definitions.push(definition); return () => {} } },
  }
  apply(ctx, config)
  const invoke = (text) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text, agent: { id: 'agent-1' }, signal: new AbortController().signal })
  }
  return {
    root, home, profilesDir, currDir, storePath, settings, logs, state, invoke,
    ask: askHarness, ownership, services,
    patchPath: join(currDir, 'cordis.patch.yml'),
    dispose: () => { for (const d of state.disposers) d(); rmSync(root, { recursive: true, force: true }) },
  }
}

const idsOf = (settings, route) => settings.state.get(route)?.models?.map((m) => m.id) ?? []
const backupsIn = (dir, pattern) => readdirSync(dir).filter((name) => pattern.test(name))

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

await check('flags: defaults are all off and rewrite-refs none', () => {
  const parsed = parseMigrateGoFlags([])
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.flags, { allProfiles: false, adopt: false, pruneUserExtra: false, rewriteRefs: 'none' })
})

await check('flags: space form and inline form both parse for --rewrite-refs', () => {
  const spaced = parseMigrateGoFlags(['--rewrite-refs', 'default-model'])
  assert.equal(spaced.ok, true)
  assert.equal(spaced.flags.rewriteRefs, 'default-model')
  const inline = parseMigrateGoFlags(['--rewrite-refs=config'])
  assert.equal(inline.ok, true)
  assert.equal(inline.flags.rewriteRefs, 'config')
  const combo = parseMigrateGoFlags(['--all-profiles', '--adopt', '--prune-user-extra'])
  assert.deepEqual(combo.flags, { allProfiles: true, adopt: true, pruneUserExtra: true, rewriteRefs: 'none' })
})

await check('flags: unknown flags (incl. --yes/--auto) are errors carrying usage', () => {
  for (const token of ['--yes', '--auto', '--bogus', '--adopt=1']) {
    const parsed = parseMigrateGoFlags([token])
    assert.equal(parsed.ok, false, token)
    assert.match(parsed.error, /unknown flag/)
    assert.ok(parsed.error.includes(MIGRATE_GO_USAGE), 'usage is included')
  }
})

await check('flags: positional words and bad --rewrite-refs values are errors', () => {
  assert.equal(parseMigrateGoFlags(['plan']).ok, false)
  const none = parseMigrateGoFlags(['--rewrite-refs', 'none'])
  assert.equal(none.ok, false)
  assert.match(none.error, /unsupported --rewrite-refs value 'none'/)
  const missing = parseMigrateGoFlags(['--rewrite-refs'])
  assert.equal(missing.ok, false)
  assert.match(missing.error, /needs a value/)
})

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

await check('formatStamp yields YYYYMMDD-HHMMSS', () => {
  assert.match(formatStamp(new Date(2026, 10, 24, 7, 8, 9)), /^20261124-070809$/)
})

await check('nextBackupPath adds a sequence suffix inside one second', () => {
  const taken = new Set(['/x/f.bak.20261124-070809'])
  const exists = (p) => taken.has(p)
  assert.equal(nextBackupPath(exists, '/x/f.bak.20261124-070809'), '/x/f.bak.20261124-070809.2')
  taken.add('/x/f.bak.20261124-070809.2')
  assert.equal(nextBackupPath(exists, '/x/f.bak.20261124-070809'), '/x/f.bak.20261124-070809.3')
  assert.equal(nextBackupPath(() => false, '/x/f.bak.20261124-070809'), '/x/f.bak.20261124-070809')
})

await check('pruneBackups keeps the 3 newest matching files and only those', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-prune-'))
  try {
    for (const name of [
      'cordis.patch.yml.bak.20260101-000001',
      'cordis.patch.yml.bak.20260101-000002.2',
      'cordis.patch.yml.bak.20260102-000001',
      'cordis.patch.yml.bak.20260103-000001',
      'cordis.patch.yml.bak.20260104-000001',
      'unrelated.txt',
      'cordis.patch.yml.bak-20260105-000001', // different convention — untouched
    ]) writeFileSync(join(root, name), 'x')
    const fs = { readdir: async (p) => readdirSync(p), unlink: async (p) => rmSync(p) }
    const removed = await pruneBackups(fs, root, /^cordis\.patch\.yml\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/)
    assert.deepEqual(removed.sort(), ['cordis.patch.yml.bak.20260101-000001', 'cordis.patch.yml.bak.20260101-000002.2'])
    const left = readdirSync(root).sort()
    assert.ok(left.includes('cordis.patch.yml.bak.20260102-000001'))
    assert.ok(left.includes('cordis.patch.yml.bak.20260103-000001'))
    assert.ok(left.includes('cordis.patch.yml.bak.20260104-000001'))
    assert.ok(left.includes('unrelated.txt'))
    assert.ok(left.includes('cordis.patch.yml.bak-20260105-000001'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('legacyStubsOf flags models-only sections of configured go routes only', () => {
  const providers = {
    'opencode-go': { apiKeyEnv: 'K', models: [{ id: 'a' }] },
    'opencode-go-msg': { api: 'x', models: [{ id: 'b' }] }, // already migrated → not a stub
    'opencode-go-free': { models: [{ id: 'c' }] }, // not a configured go route
    'minimax-cn': { models: [{ id: 'd' }] },
  }
  const stubs = legacyStubsOf(providers, ['opencode-go', 'opencode-go-msg', 'opencode-go-resp'])
  assert.deepEqual(stubs, [{ route: 'opencode-go', ids: ['a'] }])
})

// ---------------------------------------------------------------------------
// YAML patch editor
// ---------------------------------------------------------------------------

await check('patch editor: parses the stub fixture and exposes the providers tree', () => {
  const parsed = parsePatchDocument(CURR_PATCH)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
  const providers = patchLlmPiAiProviders(parsed.root)
  assert.equal(providers.ok, true)
  const stub = providers.providers['opencode-go']
  assert.deepEqual(stub.apiKeyEnv, 'OPENCODE_GO_API_KEY')
  assert.equal(stub.api, undefined)
  assert.equal(stub.baseURL, undefined)
  assert.equal(stub.models.length, 1)
  assert.equal(stub.models[0].contextWindow, 1000000)
})

await check('patch editor: set on a stub inserts before models, keeps every other line', () => {
  const applied = applyPatchOps(CURR_PATCH, [
    { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
  ])
  assert.equal(applied.ok, true, applied.ok ? '' : applied.reason)
  const before = CURR_PATCH.split('\n')
  const after = applied.next.split('\n')
  // Index-based diff: exactly one inserted line, everything else unchanged.
  let head = 0
  while (head < before.length && before[head] === after[head]) head += 1
  let tail = 0
  while (tail < before.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1
  assert.deepEqual(after.slice(head, after.length - tail), ['        api: openai-completions'])
  assert.equal(after.length, before.length + 1)
  const reparsed = parsePatchDocument(applied.next)
  assert.equal(reparsed.ok, true)
  const providers = patchLlmPiAiProviders(reparsed.root)
  assert.equal(providers.providers['opencode-go'].api, 'openai-completions')
  assert.ok(applied.next.includes('# trailing comment must survive any rewrite.'))
})

await check('patch editor: full migration op sequence creates msg/resp and preserves comments', () => {
  const newRouteModels = [
    { id: 'qwen4-max', name: 'Qwen4 Max', contextWindow: 200000, input: ['text'], reasoningEfforts: { low: 'low', high: 'high', max: 'max' } },
  ]
  const ops = [
    { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
    { op: 'set', path: ['providers', 'opencode-go', 'baseURL'], value: 'https://opencode.ai/inference/go/openai/v1' },
    { op: 'set', path: ['providers', 'opencode-go', 'displayName'], value: 'OpenCode Go' },
    { op: 'set', path: ['providers', 'opencode-go', 'apiKeyEnv'], value: 'OPENCODE_GO_API_KEY' },
    { op: 'set', path: ['providers', 'opencode-go', 'models'], value: newRouteModels },
    { op: 'set', path: ['providers', 'opencode-go-msg', 'api'], value: 'anthropic-messages' },
    { op: 'set', path: ['providers', 'opencode-go-msg', 'baseURL'], value: 'https://opencode.ai/inference/go/anthropic' },
    { op: 'set', path: ['providers', 'opencode-go-msg', 'displayName'], value: 'OpenCode Go · msg' },
    { op: 'set', path: ['providers', 'opencode-go-msg', 'apiKeyEnv'], value: 'OPENCODE_GO_API_KEY' },
    { op: 'set', path: ['providers', 'opencode-go-msg', 'models'], value: newRouteModels },
    { op: 'set', path: ['providers', 'opencode-go-resp', 'api'], value: 'openai-responses' },
    { op: 'set', path: ['providers', 'opencode-go-resp', 'models'], value: [] },
  ]
  const applied = applyPatchOps(CURR_PATCH, ops)
  assert.equal(applied.ok, true, applied.ok ? '' : applied.reason)
  const reparsed = parsePatchDocument(applied.next)
  assert.equal(reparsed.ok, true)
  const providers = patchLlmPiAiProviders(reparsed.root)
  const p = providers.providers
  assert.equal(p['opencode-go'].api, 'openai-completions')
  assert.equal(p['opencode-go-msg'].api, 'anthropic-messages')
  assert.equal(p['opencode-go-msg'].displayName, 'OpenCode Go · msg')
  assert.deepEqual(p['opencode-go-msg'].models, newRouteModels)
  assert.deepEqual(p['opencode-go-resp'].models, [])
  // Untouched providers are byte-identical (their line ranges never moved).
  for (const marker of [
    '        apiKeyEnv: MINIMAX_CN_API_KEY',
    '            contextWindow: 204800',
    '      opencode-go-free:',
    '# trailing comment must survive any rewrite.',
  ]) assert.ok(applied.next.includes(marker), `missing untouched line: ${marker}`)
})

await check('patch editor: unset removes a route section', () => {
  const applied = applyPatchOps(CURR_PATCH, [{ op: 'unset', path: ['providers', 'opencode-go'] }])
  assert.equal(applied.ok, true)
  const providers = patchLlmPiAiProviders(parsePatchDocument(applied.next).root)
  assert.equal(providers.providers['opencode-go'], undefined)
  assert.ok(providers.providers['minimax-cn'])
})

await check('patch editor: no-op unset of an absent route is a clean no-change', () => {
  const applied = applyPatchOps(CURR_PATCH, [{ op: 'unset', path: ['providers', 'opencode-go-google'] }])
  assert.equal(applied.ok, true)
  assert.equal(applied.next, CURR_PATCH)
})

await check('patch editor: refuses unsupported shapes instead of guessing', () => {
  assert.equal(parsePatchDocument('- a:\n\tb: 1\n').ok, false, 'tab indent')
  assert.equal(parsePatchDocument('- a: 1\r\n').ok, false, 'CRLF')
  const opaqueInProviders = CURR_PATCH.replace('        apiKeyEnv: OPENCODE_GO_API_KEY', '        apiKeyEnv: !!js process.env.X')
  const parsed = parsePatchDocument(opaqueInProviders)
  assert.equal(parsed.ok, true, 'the opaque value parses (kept as opaque)')
  assert.equal(applyPatchOps(opaqueInProviders, [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'x' }]).ok, false,
    'ops refuse when the target tree holds opaque values')
  assert.equal(applyPatchOps(CURR_PATCH, [{ op: 'set', path: ['other', 'key'], value: 1 }]).ok, false, 'foreign path')
  assert.equal(applyPatchOps(CURR_PATCH, [{ op: 'set', path: ['providers', 'opencode-go'], value: {} }]).ok, false, 'whole-section set')
})

await check('patch file adapter: describe is sync, mutate writes atomically, revision conflicts detected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-adapter-'))
  const path = join(root, 'cordis.patch.yml')
  try {
    writeFileSync(path, CURR_PATCH)
    const io = {
      readText: () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
      writeAtomic: async (text) => {
        const tmp = `${path}.tmp`
        writeFileSync(tmp, text)
        const { renameSync } = await import('node:fs')
        renameSync(tmp, path)
      },
    }
    const service = createFilePatchSettingsService(io)
    const desc = service.describe().find((d) => d.ns === 'llm-pi-ai')
    assert.ok(desc, 'llm-pi-ai descriptor is available synchronously')
    assert.equal(desc.user.providers['opencode-go'].models.length, 1)
    await service.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' }], desc.revision)
    const after = service.describe().find((d) => d.ns === 'llm-pi-ai')
    assert.equal(after.user.providers['opencode-go'].api, 'openai-completions')
    assert.notEqual(after.revision, desc.revision)
    assert.equal(existsSync(`${path}.tmp`), false, 'temp file is renamed away')
    await assert.rejects(
      () => service.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'x' }], desc.revision),
      (err) => err.code === 'SETTINGS_CONFLICT',
      'stale revision is a conflict',
    )
    const before = readFileSync(path, 'utf8')
    await service.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'absent-route'] }], after.revision)
    assert.equal(readFileSync(path, 'utf8'), before, 'a no-op op never writes')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('renderYamlScalar quotes only when required', () => {
  assert.equal(renderYamlScalar('openai-completions'), 'openai-completions')
  assert.equal(renderYamlScalar('https://opencode.ai/inference/go/openai/v1'), 'https://opencode.ai/inference/go/openai/v1')
  assert.equal(renderYamlScalar('OpenCode Go · msg'), '"OpenCode Go · msg"')
  assert.equal(renderYamlScalar(''), '""')
  assert.equal(renderYamlScalar(42), '42')
  assert.equal(renderYamlScalar(null), 'null')
})

// ---------------------------------------------------------------------------
// E2E: single current profile, approved
// ---------------------------------------------------------------------------

await check('e2e: approve migrates the current profile end to end', async () => {
  const h = createHarness({ storeSeed: { 'existing-route': { models: [] } } })
  try {
    const patchBefore = readFileSync(h.patchPath, 'utf8')
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    // One confirmation, carrying the mandated content.
    assert.equal(h.ask.calls, 1, 'exactly one confirmation')
    const question = h.ask.questions[0].questions[0]
    assert.equal(question.options[0].label, '执行迁移')
    assert.ok(question.options[0].label === question.options[0].label && question.options[1].label === '取消')
    for (const needle of ['custom-test-model', 'opencode-go-msg', 'opencode-go-resp', '[curr]', h.patchPath, 'planHash']) {
      assert.ok(question.question.includes(needle), `question mentions ${needle}`)
    }
    // Settings: stub upgraded in place, msg/resp created, others untouched.
    const chat = h.settings.state.get('opencode-go')
    assert.equal(chat.api, 'openai-completions')
    assert.equal(chat.baseURL, 'https://opencode.ai/inference/go/openai/v1')
    assert.equal(chat.displayName, 'OpenCode Go')
    assert.equal(chat.apiKeyEnv, 'OPENCODE_GO_API_KEY')
    assert.ok(chat.models.some((m) => m.id === 'custom-test-model'), 'legacy id kept (conservative)')
    assert.ok(chat.models.some((m) => m.id === 'deepseek-v4.1-flash'), 'desired id added')
    assert.ok(h.settings.state.get('opencode-go-msg'), 'msg slot created')
    assert.ok(h.settings.state.get('opencode-go-resp'), 'resp slot created')
    assert.equal(h.settings.state.get('opencode-go-google'), undefined, 'no google slot')
    assert.deepEqual(
      h.settings.state.get('minimax-cn'),
      { apiKeyEnv: 'MINIMAX_CN_API_KEY', models: [{ id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 204800, input: ['text'] }] },
      'minimax-cn untouched',
    )
    assert.deepEqual(
      h.settings.state.get('opencode-go-free'),
      {
        api: 'openai-completions', apiKeyEnv: 'OPENCODE_GO_API_KEY',
        baseURL: 'https://opencode.ai/inference/go/openai/v1',
        models: [{ id: 'hungerg-free', name: 'HungerG Free', contextWindow: 1000000, input: ['text', 'image'] }],
      },
      'opencode-go-free untouched',
    )
    // Backups: patch + models-store, both byte-accurate.
    const stampBackups = backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/)
    assert.equal(stampBackups.length, 1, 'one patch backup')
    assert.equal(readFileSync(join(h.currDir, stampBackups[0]), 'utf8'), patchBefore, 'patch backup is byte-accurate')
    const storeBackups = backupsIn(h.home, /^models-store\.json\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/)
    assert.equal(storeBackups.length, 1, 'one models-store backup')
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, storeBackups[0]), 'utf8')), { 'existing-route': { models: [] } })
    // Ledger + migration record landed in the shared store (profile-scoped).
    const store = JSON.parse(readFileSync(h.storePath, 'utf8'))
    const fingerprint = fingerprintKey(KEY)
    assert.ok(store[`curr#opencode-go#${fingerprint}`], 'chat ledger entry')
    assert.ok(store[`curr#opencode-go-msg#${fingerprint}`], 'msg ledger entry')
    assert.ok(store['curr#migration:opencode-go'].appliedFingerprint, 'migration record with fingerprint')
    // Enabled flip through the host settings seam.
    assert.deepEqual(h.settings.updates, [{ ns: 'dsh-model-sync', patch: { opencode: { go: { enabled: true } } } }])
    // Report + log.
    assert.match(result.text, /rollback: \/model-sync migrate rollback --plan [0-9a-f]{64}/)
    assert.match(result.text, /state after: applied/)
    assert.match(result.text, /log: /)
    const logPath = /log: (.+)$/.exec(result.text)?.[1]?.trim()
    assert.ok(logPath !== undefined && existsSync(logPath), 'log file exists')
    const log = readFileSync(logPath, 'utf8')
    assert.ok(log.includes('[curr] apply:'), 'log carries the apply detail')
    assert.ok(!log.includes(KEY), 'log never contains the credential value')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: cancel / fail-closed confirmation
// ---------------------------------------------------------------------------

await check('e2e: cancel means zero writes (backups stay)', async () => {
  const h = createHarness({ ask: makeAsk({ mode: 'cancel' }) })
  try {
    const before = JSON.parse(JSON.stringify({
      settings: [...h.settings.state.entries()],
      patch: readFileSync(h.patchPath, 'utf8'),
    }))
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /已取消/)
    assert.deepEqual([...h.settings.state.entries()], before.settings, 'settings untouched')
    assert.equal(readFileSync(h.patchPath, 'utf8'), before.patch, 'patch untouched')
    assert.equal(backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\./).length, 1, 'backup exists (by-design order)')
    assert.ok(!existsSync(h.storePath), 'models-store never created')
  } finally {
    h.dispose()
  }
})

await check('e2e: missing userQuestions channel → fail closed with the manual path, zero writes', async () => {
  const h = createHarness()
  h.services.userQuestions = undefined // channel absent at invocation time
  try {
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /确认通道不可用/)
    assert.match(result.text, /migrate apply --plan/)
    assert.match(result.text, /planHash: [0-9a-f]{64}/)
    assert.deepEqual(h.settings.mutations, [], 'zero settings writes')
    assert.equal(backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\./).length, 1, 'backups exist (created before the ask)')
    assert.ok(!existsSync(h.storePath), 'models-store never created')
  } finally {
    h.dispose()
  }
})

await check('e2e: ask throwing NO_PROVIDER → fail closed, zero writes', async () => {
  const h = createHarness({ ask: makeAsk({ mode: 'throw' }) })
  try {
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /NO_PROVIDER/)
    assert.deepEqual(h.settings.mutations, [])
    assert.ok(!existsSync(h.storePath))
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: credential fail-closed
// ---------------------------------------------------------------------------

await check('e2e: missing credential → zero outbound calls, zero writes, no backups', async () => {
  const h = createHarness({ credentialFault: true })
  try {
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /OPENCODE_GO_API_KEY/)
    assert.match(result.text, /零外呼、零写入/)
    assert.equal(backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\./).length, 0, 'no backups before the credential gate')
    assert.ok(!existsSync(h.storePath))
    assert.equal(h.ask.calls, 0, 'the confirmation is never reached without a credential')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: nothing to migrate / unknown flag at the command surface
// ---------------------------------------------------------------------------

await check('e2e: a current profile without a stub reports nothing to apply', async () => {
  const h = createHarness({ patchText: '# no providers here\n- id: ui-chat\n  config:\n    x: 1\n' })
  h.settings.state.clear()
  try {
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /nothing to apply|nothing to migrate/)
    assert.equal(h.ask.calls, 0, 'no confirmation without a migratable target')
    assert.deepEqual(h.settings.mutations, [])
  } finally {
    h.dispose()
  }
})

await check('e2e: --yes is an unknown flag at the command surface', async () => {
  const h = createHarness()
  try {
    const result = await h.invoke('migrate-go --yes')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /unknown flag '--yes'/)
    assert.match(result.text, /usage:/)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: --all-profiles
// ---------------------------------------------------------------------------

await check('e2e: --all-profiles migrates every stub profile with ONE confirmation', async () => {
  const h = createHarness({
    extraProfiles: { other: OTHER_PATCH, empty: '# no llm-pi-ai\n- id: ui-chat\n  config:\n    x: 1\n' },
    storeSeed: { seed: { models: [] } },
  })
  try {
    const otherBefore = readFileSync(join(h.profilesDir, 'other', 'cordis.patch.yml'), 'utf8')
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(h.ask.calls, 1, 'exactly one confirmation for the whole batch')
    assert.ok(h.ask.questions[0].questions[0].question.includes('[other]'), 'the question covers the second profile')
    // Second profile rewritten on disk through the file adapter.
    const otherAfter = readFileSync(join(h.profilesDir, 'other', 'cordis.patch.yml'), 'utf8')
    const parsed = parsePatchDocument(otherAfter)
    assert.equal(parsed.ok, true)
    const providers = patchLlmPiAiProviders(parsed.root)
    assert.equal(providers.providers['opencode-go'].api, 'openai-completions')
    assert.ok(otherAfter.includes('# trailing comment must survive any rewrite.'), 'comments survive the file rewrite')
    assert.ok(otherAfter.includes('custom-other-model'), 'legacy ids kept')
    // Untouched profile stays byte-identical.
    const emptyText = readFileSync(join(h.profilesDir, 'empty', 'cordis.patch.yml'), 'utf8')
    assert.equal(emptyText, '# no llm-pi-ai\n- id: ui-chat\n  config:\n    x: 1\n')
    // Both profile keys carry ledger + record in the shared store.
    const store = JSON.parse(readFileSync(h.storePath, 'utf8'))
    const fingerprint = fingerprintKey(KEY)
    assert.ok(store[`curr#opencode-go#${fingerprint}`])
    assert.ok(store[`other#opencode-go#${fingerprint}`])
    assert.ok(store['other#migration:opencode-go'])
    assert.match(result.text, /\[other\]/)
    // models-store backed up exactly once for the whole run.
    assert.equal(backupsIn(h.home, /^models-store\.json\.bak\./).length, 1)
    void otherBefore
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: failure → byte restore of every changed file
// ---------------------------------------------------------------------------

await check('e2e: first-profile failure restores all changed files byte-for-byte', async () => {
  const h = createHarness({
    // 'alpha' sorts before 'curr', so the fault fires before any other write.
    extraProfiles: { alpha: OTHER_PATCH },
    storeSeed: { seed: { models: [] } },
    ownershipFaultOnKeyPrefix: 'alpha#',
  })
  try {
    const currBefore = readFileSync(h.patchPath, 'utf8')
    const alphaBefore = readFileSync(join(h.profilesDir, 'alpha', 'cordis.patch.yml'), 'utf8')
    const storeBefore = readFileSync(h.storePath, 'utf8')
    const settingsBefore = JSON.stringify([...h.settings.state.entries()])
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /FAILED at apply for \[alpha\]/)
    assert.match(result.text, /失败步骤: apply/)
    assert.match(result.text, /恢复结果:/)
    assert.match(result.text, /restored .*alpha\/cordis\.patch\.yml/)
    assert.match(result.text, /restored .*models-store\.json/)
    assert.equal(readFileSync(join(h.profilesDir, 'alpha', 'cordis.patch.yml'), 'utf8'), alphaBefore, 'alpha patch byte-restored')
    assert.equal(readFileSync(h.storePath, 'utf8'), storeBefore, 'models-store byte-restored')
    assert.equal(readFileSync(h.patchPath, 'utf8'), currBefore, 'current patch byte-restored')
    const store = JSON.parse(readFileSync(h.storePath, 'utf8'))
    assert.deepEqual(Object.keys(store), Object.keys(JSON.parse(storeBefore)), 'no ledger/record residue')
    assert.equal(JSON.stringify([...h.settings.state.entries()]), settingsBefore, 'host-seam settings untouched (failure hit first)')
    assert.equal(h.settings.state.get('opencode-go-msg'), undefined, 'no slot was created')
  } finally {
    h.dispose()
  }
})

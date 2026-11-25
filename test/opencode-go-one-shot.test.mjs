// One-shot migrate-go: `/model-sync migrate-go` — flags, backups/retention,
// the YAML-subset patch editor, the fail-closed confirmation, the apply loop,
// and the byte-restore failure path. Everything runs against temp dirs; no
// test touches the real ~/.dsh.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  GO_MIGRATION_ENTRIES_SERVICE,
  GO_MIGRATION_MUTEX_SERVICE,
  GO_MIGRATION_REF_WRITER_SERVICE,
  GO_ONESHOT_PATHS_SERVICE,
} from '../lib/index.js'
import { GO_MIGRATION_STORE_SERVICE } from '../lib/opencode-go-migration.js'
import { GO_OWNERSHIP_STORE_SERVICE } from '../lib/opencode-go-sync.js'
import {
  dropStaleTargets,
  formatStamp,
  legacyStubsOf,
  MIGRATE_GO_USAGE,
  parseMigrateGoFlags,
  pruneBackups,
  removeStoreIfUnchanged,
  restoreModelsStoreIfUnchanged,
  restorePatchIfUnchanged,
  sha256Of,
  verifyStoreFreshness,
  writeExclusiveBackup,
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

/**
 * A handwritten model whose `input` is the common single-line FLOW idiom.
 * Before the review-M1 fix the subset parser decoded `["text"]` as the literal
 * string '"text"', the conservative keep wrote that corrupted value back, and
 * the host yaml then read `['"text"']` — silent data corruption with a
 * SUCCESS report.
 */
const FLOW_PATCH = [
  '# flow-input patch: handwritten model with input: ["text"] (flow idiom).',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      opencode-go:',
  '        apiKeyEnv: OPENCODE_GO_API_KEY',
  '        models:',
  '          - id: custom-flow-model',
  '            name: Custom Flow Model',
  '            contextWindow: 64000',
  '            input: ["text"]',
].join('\n')

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
      const selected = recorder.mode === 'cancel'
        ? ['取消']
        : recorder.mode === 'blank'
          ? []
          : recorder.mode === 'both'
            ? ['执行迁移', '取消']
            : ['执行迁移']
      return { answers: [{ id: request.questions[0].id, selected }] }
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
  /**
   * Injected GO_MIGRATION_REF_WRITER_SERVICE (the host ctx seam the one-shot
   * calls for `--rewrite-refs`). Receives `(rewrite, patchPath)` — patchPath
   * is the current profile's patch file, so a test can simulate the host
   * rewriting that document.
   */
  refWriter,
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
  const currPatchPath = join(currDir, 'cordis.patch.yml')
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
    ...(refWriter === undefined ? {} : { [GO_MIGRATION_REF_WRITER_SERVICE]: (rewrite) => refWriter(rewrite, currPatchPath) }),
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
  const invoke = (text, signal) => {
    const command = state.definitions.find((d) => d.name === 'model-sync')
    return command.handler({ rawInput: text, agent: { id: 'agent-1' }, signal: signal ?? new AbortController().signal })
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

await check('writeExclusiveBackup retries the sequence suffix when the exclusive claim misses', async () => {
  // A fake fs whose O_EXCL semantics say the same-second base name is taken.
  const claimed = new Set(['/h/models-store.json.bak.20261124-070809'])
  const written = []
  const fs = {
    writeFileExclusive: async (path) => {
      if (claimed.has(path)) return false
      claimed.add(path)
      written.push(path)
      return true
    },
  }
  const first = await writeExclusiveBackup(fs, '/h/models-store.json.bak.20261124-070809', '{}')
  assert.equal(first, '/h/models-store.json.bak.20261124-070809.2', 'taken base name → .2, never an overwrite')
  const second = await writeExclusiveBackup(fs, '/h/models-store.json.bak.20261124-070809', '{}')
  assert.equal(second, '/h/models-store.json.bak.20261124-070809.3')
  const free = await writeExclusiveBackup(fs, '/h/models-store.json.bak.20261124-070810', 'x')
  assert.equal(free, '/h/models-store.json.bak.20261124-070810', 'free name claims the base directly')
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

// ---------------------------------------------------------------------------
// Patch editor: host-incompatible YAML is refused at parse time (Blocker A).
// Every shape below used to parse + self-validate + get written while the
// host yaml@2.8 rejected or re-interpreted the result — now the PARSE fails,
// so every consumer (discovery, describe, mutate) fails closed pre-write.
// ---------------------------------------------------------------------------

/** Build a patch whose llm-pi-ai providers tree contains the given raw lines. */
const patchWithProviders = (providerLines) => [
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  ...providerLines.map((line) => `      ${line}`),
].join('\n')

await check('patch editor: quoted keys are refused (bare plain keys only)', () => {
  const quoted = patchWithProviders(['"opencode-go":', '  apiKeyEnv: K'])
  const parsed = parsePatchDocument(quoted)
  assert.equal(parsed.ok, false, 'quoted key must not parse')
  assert.match(parsed.reason, /quoted key/)
  assert.equal(applyPatchOps(quoted, [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'x' }]).ok, false)
})

await check('patch editor: whitespace in a key (or before the colon) is refused', () => {
  for (const [name, lines] of [
    ['trailing space before colon', ['opencode-go :', '  apiKeyEnv: K']],
    ['inner space', ['open code-go:', '  apiKeyEnv: K']],
  ]) {
    const parsed = parsePatchDocument(patchWithProviders(lines))
    assert.equal(parsed.ok, false, `${name} must not parse`)
    assert.match(parsed.reason, /whitespace/)
  }
})

await check('patch editor: YAML indicator characters in a key are refused', () => {
  for (const key of ['a#b', 'a*b', 'a&b', 'a{b', 'a[b']) {
    const parsed = parsePatchDocument(patchWithProviders([`${key}: 1`]))
    assert.equal(parsed.ok, false, `key ${key} must not parse`)
    assert.match(parsed.reason, /indicator character/)
  }
})

await check('patch editor: duplicate keys in the same mapping are refused', () => {
  const duplicated = patchWithProviders([
    'opencode-go:',
    '  apiKeyEnv: K',
    'opencode-go:',
    '  api: openai-completions',
  ])
  const parsed = parsePatchDocument(duplicated)
  assert.equal(parsed.ok, false, 'same-level duplicate key must not parse (host yaml rejects it; no last-wins folding)')
  assert.match(parsed.reason, /duplicate key/)
  // Also at other mapping levels (config level here).
  const configDup = ['- id: llm-pi-ai', '  config:', '    a: 1', '    a: 2'].join('\n')
  assert.equal(parsePatchDocument(configDup).ok, false)
})

await check('patch editor: aliases, anchors and merge keys are refused', () => {
  const alias = parsePatchDocument(patchWithProviders(['opencode-go:', '  models: *m']))
  assert.equal(alias.ok, false, 'alias must not parse')
  assert.match(alias.reason, /anchors\/aliases/)
  const anchored = parsePatchDocument(patchWithProviders(['opencode-go:', '  api: &a openai-completions']))
  assert.equal(anchored.ok, false, 'inline anchor must not parse')
  assert.match(anchored.reason, /anchors\/aliases/)
  const mergeKey = parsePatchDocument(patchWithProviders(['<<: *base', 'opencode-go:', '  apiKeyEnv: K']))
  assert.equal(mergeKey.ok, false, 'merge key must not parse')
  assert.match(mergeKey.reason, /merge key/)
  const flowAlias = parsePatchDocument('- id: llm-pi-ai\n  config:\n    x: [a, *m]\n')
  assert.equal(flowAlias.ok, false, 'alias inside a flow collection must not parse')
})

// ---------------------------------------------------------------------------
// Patch editor: flow collections decode like the host yaml or refuse (M1)
// ---------------------------------------------------------------------------

await check('patch editor: flow scalars decode through the same unquote path as block position (review M1)', () => {
  const doc = patchWithProviders([
    'x:',
    '  fields: {a: "b"}',
    '  input: ["text"]',
    "  sq: ['it''s']",
    '  dq: ["a\\"b\\\\c"]',
    '  note: ["a # b"]',
    '  mixed: [true, null, 1, 2.5]',
    '  trail: [a, ]',
  ])
  const parsed = parsePatchDocument(doc)
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
  const x = patchLlmPiAiProviders(parsed.root).providers.x
  // Before the fix each quoted flow scalar kept its quotes as literal text
  // ({a:'"b"'} / ['"text"']) and diverged from the host yaml.
  assert.deepEqual(x.fields, { a: 'b' })
  assert.deepEqual(x.input, ['text'])
  assert.deepEqual(x.sq, ["it's"])
  assert.deepEqual(x.dq, ['a"b\\c'])
  assert.deepEqual(x.note, ['a # b'], 'a quoted # is content, not a comment (never stripped inside quotes)')
  assert.deepEqual(x.mixed, [true, null, 1, 2.5])
  assert.deepEqual(x.trail, ['a'], 'a trailing comma is not an empty entry')
})

await check('patch editor: flow tags / single-pair items / merge keys / anchors are refused (review M1)', () => {
  const setOp = { op: 'set', path: ['providers', 'x', 'api'], value: 'openai-completions' }
  for (const [name, lines, pattern] of [
    ['flow tag value', ['x:', '  a: {b: !!js x}'], /YAML tags/],
    ['flow tag item', ['x:', '  a: [!!str x]'], /YAML tags/],
    ['flow single-pair item', ['x:', '  models: [a: b]'], /single-pair/],
    ['flow trailing-colon item', ['x:', '  models: [a:, b]'], /single-pair/],
    ['flow merge key', ['x:', '  m: {<<: *base}'], /merge key/],
    ['flow anchor', ['x:', '  m: [&a x]'], /anchors\/aliases/],
    ['flow alias', ['x:', '  m: [*a]'], /anchors\/aliases/],
    ['flow empty entry', ['x:', '  m: [a, , b]'], /empty flow entry/],
    ['flow comment inside brackets', ['x:', '  m: [a # c, b]'], /comment inside a flow/],
  ]) {
    const doc = patchWithProviders(lines)
    const parsed = parsePatchDocument(doc)
    assert.equal(parsed.ok, false, `${name} must not parse`)
    assert.match(parsed.reason, pattern, name)
    // The refusal is total: no op batch can run against the document either.
    assert.equal(applyPatchOps(doc, [setOp]).ok, false, `${name}: ops refuse with zero writes`)
  }
})

await check('patch editor: colon-space in a value position is refused (review M2)', () => {
  for (const [name, lines] of [
    ['nested compact mapping', ['y: a: b']],
    ['trailing colon', ['y: a:']],
    ['mapping indicator on a continuation line', ['y: a', '    b: c']],
  ]) {
    const parsed = parsePatchDocument(patchWithProviders(lines))
    assert.equal(parsed.ok, false, `${name} must not parse (the host yaml rejects the whole file)`)
    assert.match(parsed.reason, /nested mapping/, name)
  }
  // A colon NOT followed by space is plain content: URLs keep parsing.
  const url = parsePatchDocument(patchWithProviders(['y: http://h:8080/p']))
  assert.equal(url.ok, true, url.ok ? '' : url.reason)
  assert.equal(patchLlmPiAiProviders(url.root).providers.y, 'http://h:8080/p')
})

await check('patch editor: keys resolving to null/boolean/number are refused (review M3)', () => {
  for (const [name, lines] of [
    ['true/True collide in the host', ['true: 1', 'True: 2']],
    ['null/~ collide in the host', ['null: 1', '~: 2']],
    ['1/+1 collide in the host', ['1: a', '+1: b']],
    ['single boolean key', ['true: 1']],
    ['single null key', ['~: 1']],
    ['single numeric key', ['007: 1']],
  ]) {
    const parsed = parsePatchDocument(patchWithProviders(lines))
    assert.equal(parsed.ok, false, `${name} must not parse`)
    assert.match(parsed.reason, /resolves to a non-string/, name)
  }
  // Flow mapping keys go through the same rule.
  const flow = parsePatchDocument(patchWithProviders(['m: {true: a, True: b}']))
  assert.equal(flow.ok, false, 'flow boolean keys must not parse')
  assert.match(flow.reason, /resolves to a non-string/)
})

await check('patch editor: !!js opaque leaves outside the edited providers tree stay passthrough', () => {
  const outside = [
    '- id: ui-chat',
    '  config:',
    '    flag: !!js true',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      opencode-go:',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '        models:',
    '          - id: custom-test-model',
    '            name: Custom',
  ].join('\n')
  const parsed = parsePatchDocument(outside)
  assert.equal(parsed.ok, true, 'opaque leaf OUTSIDE the edit scope still parses (existing behavior)')
  const applied = applyPatchOps(outside, [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' }])
  assert.equal(applied.ok, true, 'ops apply while the opaque leaf stays outside the edited tree')
  assert.ok(applied.next.includes('flag: !!js true'), 'the opaque leaf survives verbatim')
})

await check('patch editor: a mid-batch refusal means the whole target refuses with zero writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-no-partial-'))
  const path = join(root, 'cordis.patch.yml')
  try {
    writeFileSync(path, CURR_PATCH)
    const before = readFileSync(path, 'utf8')
    const io = {
      readText: () => readFileSync(path, 'utf8'),
      writeAtomic: async (text) => {
        const tmp = `${path}.tmp`
        writeFileSync(tmp, text)
        renameSync(tmp, path)
      },
    }
    const service = createFilePatchSettingsService(io)
    const desc = service.describe().find((d) => d.ns === 'llm-pi-ai')
    // Op 1 would succeed; op 2 hits a refused mutation path. The adapter must
    // throw BEFORE any write — the file stays byte-identical.
    await assert.rejects(
      () => service.mutate('llm-pi-ai', [
        { op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'openai-completions' },
        { op: 'set', path: ['providers', 'opencode-go', 'api', 'extra'], value: 'x' },
      ], desc.revision),
      /unsupported mutation path/,
    )
    assert.equal(readFileSync(path, 'utf8'), before, 'a refusing batch never partially writes')
    assert.equal(existsSync(`${path}.tmp`), false, 'no temp file left behind')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('patch editor: regression — the old accept-broken behavior no longer exists', async () => {
  // Old behavior: a quoted key parsed into a distinct literal key, passed
  // op-by-op self-validation, and was written back — the host yaml then
  // failed to load the profile settings while the batch reported SUCCESS.
  const brokenKey = patchWithProviders(['"opencode-go":', '  apiKeyEnv: OPENCODE_GO_API_KEY'])
  const parsed = parsePatchDocument(brokenKey)
  assert.equal(parsed.ok, false, 'the broken document is now refused at parse')
  assert.equal(applyPatchOps(brokenKey, [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'x' }]).ok, false)
  // The adapter fails closed: an unparseable file yields NO descriptor and
  // mutate refuses, so nothing can be written through it.
  const root = mkdtempSync(join(tmpdir(), 'model-sync-regression-'))
  const path = join(root, 'cordis.patch.yml')
  try {
    writeFileSync(path, brokenKey)
    const service = createFilePatchSettingsService({
      readText: () => readFileSync(path, 'utf8'),
      writeAtomic: async () => { throw new Error('must never be reached') },
    })
    assert.deepEqual(service.describe(), [], 'unparseable patch ⇒ no descriptor (fail closed)')
    await assert.rejects(
      () => service.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'opencode-go', 'api'], value: 'x' }]),
      /parse failed/,
    )
    assert.equal(readFileSync(path, 'utf8'), brokenKey, 'the broken file is never rewritten')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('e2e: a target with an uneditable patch is skipped at discovery; other targets migrate', async () => {
  const quotedKeyPatch = [
    '# quoted-key patch: the host yaml would load it, the subset editor refuses it',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      "opencode-go":',
    '        apiKeyEnv: OPENCODE_GO_API_KEY',
    '        models:',
    '          - id: custom-bad-model',
    '            name: Custom Bad',
  ].join('\n')
  const h = createHarness({ extraProfiles: { bad: quotedKeyPatch, other: OTHER_PATCH } })
  try {
    const badBefore = readFileSync(join(h.profilesDir, 'bad', 'cordis.patch.yml'), 'utf8')
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'success', result.text)
    // Strategy: an uneditable target is SKIPPED at discovery (fail closed,
    // zero writes for it), the rest of the batch proceeds normally.
    assert.match(result.text, /skipped: bad: .*quoted key/)
    assert.equal(readFileSync(join(h.profilesDir, 'bad', 'cordis.patch.yml'), 'utf8'), badBefore, 'bad patch untouched')
    assert.equal(readdirSync(join(h.profilesDir, 'bad')).filter((name) => name.includes('.bak.')).length, 0, 'no backup taken for a skipped target')
    const fingerprint = fingerprintKey(KEY)
    const store = JSON.parse(readFileSync(h.storePath, 'utf8'))
    assert.ok(store[`other#opencode-go#${fingerprint}`], 'the healthy sibling target still migrated')
    assert.ok(store[`curr#opencode-go#${fingerprint}`], 'the current profile still migrated')
    assert.equal(store[`bad#opencode-go#${fingerprint}`], undefined, 'the refused target wrote nothing')
  } finally {
    h.dispose()
  }
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
    assert.equal(question.options[1].label, '取消')
    for (const needle of ['custom-test-model', 'opencode-go-msg', 'opencode-go-resp', '[curr]', h.patchPath, 'planHash']) {
      assert.ok(question.question.includes(needle), `question mentions ${needle}`)
    }
    // Managed-after notice is quoted VERBATIM in the question (informed
    // consent: ackManaged must reflect text the user actually saw).
    assert.ok(question.question.includes('[managed-after-migration] 以下模型将交由插件管理：'), 'managed-after header present')
    assert.ok(question.question.includes('官方下架时，这些模型会在满足「归属账本 + 现值哈希 + 无 override/pin」三闸门且连续 2 轮确认后自动从列表移除。'),
      'managed-after auto-removal notice present verbatim')
    // Per-id action rows (not just +n/-n counts).
    assert.ok(question.question.includes('+ 新增 → opencode-go-msg: qwen4-max'), 'per-id add row for msg')
    assert.ok(question.question.includes('+ 新增 → opencode-go-resp: grok-4.7'), 'per-id add row for resp')
    assert.ok(question.question.includes('+ 新增 → opencode-go: deepseek-v4.1-flash'), 'per-id add row for chat')
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
    const patchBackupText = readFileSync(join(h.currDir, stampBackups[0]), 'utf8')
    assert.equal(patchBackupText, patchBefore, 'patch backup is byte-accurate')
    assert.ok(!patchBackupText.includes('crash residue, NOT a backup'),
      'the completed backup carries no claim placeholder (rename replaced it — review M7)')
    const storeBackups = backupsIn(h.home, /^models-store\.json\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/)
    assert.equal(storeBackups.length, 1, 'one models-store backup')
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, storeBackups[0]), 'utf8')), { 'existing-route': { models: [] } })
    // M7: a clean run leaves no tmp residue next to the written files.
    for (const dir of [h.currDir, h.home]) {
      assert.equal(readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0, `no .tmp- residue in ${dir}`)
    }
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
    // The second profile's backup is byte-accurate (true byte comparison of
    // the pre-run file against the backup the run wrote for it).
    const otherBackups = readdirSync(join(h.profilesDir, 'other')).filter((name) => /^cordis\.patch\.yml\.bak\./.test(name))
    assert.equal(otherBackups.length, 1, 'one backup for the other profile')
    assert.equal(readFileSync(join(h.profilesDir, 'other', otherBackups[0]), 'utf8'), otherBefore,
      'other profile backup is byte-identical to its pre-run content')
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

// ---------------------------------------------------------------------------
// E2E: M1 regression — a conservatively kept handwritten model with the flow
// `input: ["text"]` idiom must still decode/rewrite as ["text"], never the
// corrupted ['"text"'].
// ---------------------------------------------------------------------------

await check('e2e: flow input ["text"] survives a conservative keep of a handwritten model (review M1)', async () => {
  const h = createHarness({
    extraProfiles: { flow: FLOW_PATCH },
    storeSeed: { seed: { models: [] } },
  })
  try {
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'success', result.text)
    assert.ok(result.text.includes('[flow]'), 'the flow profile migrated')
    // Read the file back through the SAME parser the engine uses: the kept
    // model's input must be the decoded array, not ['"text"'].
    const after = readFileSync(join(h.profilesDir, 'flow', 'cordis.patch.yml'), 'utf8')
    const parsed = parsePatchDocument(after)
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.reason)
    const models = patchLlmPiAiProviders(parsed.root).providers['opencode-go'].models
    const kept = models.find((model) => model.id === 'custom-flow-model')
    assert.ok(kept, 'the handwritten model was kept (conservative)')
    assert.deepEqual(kept.input, ['text'], 'input decodes as ["text"] — the M1 corruption shape would be [\'"text"\']')
    // The rewritten section is host-loadable YAML: input is a plain scalar
    // item (block form), never a quoted-twice literal.
    const dataLines = after.split('\n').filter((line) => !line.trim().startsWith('#'))
    assert.ok(!dataLines.some((line) => line.includes('"text"')),
      'no doubled quoting leaked into the written data lines')
    // And a follow-up describe() (what the next sync round compares against)
    // sees the same value.
    const service = createFilePatchSettingsService({
      readText: () => readFileSync(join(h.profilesDir, 'flow', 'cordis.patch.yml'), 'utf8'),
      writeAtomic: async () => { throw new Error('not expected') },
    })
    const desc = service.describe().find((d) => d.ns === 'llm-pi-ai')
    assert.deepEqual(
      desc.user.providers['opencode-go'].models.find((model) => model.id === 'custom-flow-model').input,
      ['text'],
    )
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// E2E: M4 — --rewrite-refs writes ride the change tracker
// ---------------------------------------------------------------------------

await check('e2e: ref rewrite is tracked and restored on a later failure (no false concurrent-modification, review M4)', async () => {
  const rewrites = []
  const h = createHarness({
    // 'zeta' sorts after 'curr': curr applies (and its ref rewrite lands),
    // then zeta fails — everything curr changed must still restore.
    extraProfiles: { zeta: OTHER_PATCH },
    storeSeed: { seed: { models: [] } },
    ownershipFaultOnKeyPrefix: 'zeta#',
    refWriter: async (rewrite, patchPath) => {
      rewrites.push({ ...rewrite })
      // Simulate the host seam rewriting the current profile's patch document
      // AFTER the settings writes (this is the write that used to bypass the
      // tracker and drift the post-write sha).
      const text = readFileSync(patchPath, 'utf8')
      writeFileSync(patchPath, text.replace(
        '# trailing comment must survive any rewrite.',
        `# ref rewrite: ${rewrite.before} → ${rewrite.after}\n# trailing comment must survive any rewrite.`,
      ))
    },
  })
  try {
    const currBefore = readFileSync(h.patchPath, 'utf8')
    const zetaBefore = readFileSync(join(h.profilesDir, 'zeta', 'cordis.patch.yml'), 'utf8')
    const storeBefore = readFileSync(h.storePath, 'utf8')
    const result = await h.invoke('migrate-go --all-profiles --rewrite-refs=default-model')
    assert.equal(result.kind, 'error', 'zeta still fails the run')
    assert.equal(rewrites.length, 1, 'the ref writer ran exactly once (current profile, verified+rewritable candidate)')
    assert.match(result.text, /restored .*curr\/cordis\.patch\.yml/,
      'the ref-rewritten patch is restored (tracked as a change)')
    assert.ok(!result.text.includes('concurrent modification detected'),
      'no false concurrent-modification report for the file this run wrote last')
    assert.equal(readFileSync(h.patchPath, 'utf8'), currBefore, 'the ref rewrite is rolled back byte-for-byte too')
    assert.equal(readFileSync(join(h.profilesDir, 'zeta', 'cordis.patch.yml'), 'utf8'), zetaBefore)
    assert.equal(readFileSync(h.storePath, 'utf8'), storeBefore, 'models-store byte-restored')
  } finally {
    h.dispose()
  }
})

await check('e2e: ref rewrite without a later failure lands and the report succeeds', async () => {
  const rewrites = []
  const h = createHarness({
    storeSeed: { seed: { models: [] } },
    refWriter: async (rewrite, patchPath) => {
      rewrites.push({ ...rewrite })
      const text = readFileSync(patchPath, 'utf8')
      writeFileSync(patchPath, `${text}# ref rewritten\n`)
    },
  })
  try {
    const result = await h.invoke('migrate-go --rewrite-refs=config')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(rewrites.length, 2, 'config mode rewrites both verified config-surface candidates')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Confirmation content (review Major 3 + M8): per-id rows incl. deleted user
// ids, update rows with before→after, per-row reasons, route fields and the
// rewrite-refs before→after preview.
// ---------------------------------------------------------------------------

await check('e2e: --adopt --prune-user-extra lists deleted user-written ids one by one', async () => {
  const h = createHarness({ storeSeed: { seed: { models: [] } } })
  try {
    const result = await h.invoke('migrate-go --adopt --prune-user-extra')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(h.ask.calls, 1, 'still exactly one confirmation')
    const question = h.ask.questions[0].questions[0]
    assert.equal(question.options.length, 2, 'still exactly two options')
    // The B6 managed-after notice is present verbatim (informed consent).
    assert.ok(question.question.includes('[managed-after-migration] 以下模型将交由插件管理：'))
    assert.ok(question.question.includes('官方下架时，这些模型会在满足「归属账本 + 现值哈希 + 无 override/pin」三闸门且连续 2 轮确认后自动从列表移除。'))
    // Per-id rows: every add and the deleted user-written id, individually.
    assert.ok(question.question.includes('+ 新增 → opencode-go: deepseek-v4.1-flash'))
    assert.ok(question.question.includes('+ 新增 → opencode-go-msg: qwen4-max'))
    assert.ok(question.question.includes('+ 新增 → opencode-go-resp: grok-4.7'))
    assert.ok(question.question.includes('删除 → opencode-go: custom-test-model（用户手写）'),
      'the pruned user-written id is listed individually with its kind')
    // And the migration really did delete it (the dialog matched the outcome).
    const chat = h.settings.state.get('opencode-go')
    assert.equal(chat.models.some((m) => m.id === 'custom-test-model'), false, 'custom-test-model deleted as promised')
  } finally {
    h.dispose()
  }
})

await check('e2e: confirmation shows update rows (before→after), per-row reasons, route fields (review M8)', async () => {
  const h = createHarness({ storeSeed: { seed: { models: [] } } })
  try {
    // A user-modified OFFICIAL model on its official route → an `update` row
    // (report-only drift; apply never overwrites it).
    const chat = h.settings.state.get('opencode-go')
    chat.models.push({ id: 'deepseek-v4.1-flash', name: 'My Custom Flash', contextWindow: 123456, input: ['text'] })
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(h.ask.calls, 1, 'exactly one confirmation')
    const question = h.ask.questions[0].questions[0]
    assert.equal(question.options.length, 2, 'still exactly two options')
    // The update row with the plan's own reason and the before→after diff.
    assert.ok(question.question.includes('~ 更新 → opencode-go: deepseek-v4.1-flash'), 'update row present')
    assert.ok(question.question.includes('user-modified desired value'), 'the plan reason is quoted on the row')
    assert.ok(question.question.includes('contextWindow: 123456 → 1000000'), 'the diff shows what actually differs')
    assert.ok(question.question.includes('"My Custom Flash" → "DeepSeek V4.1 Flash 1017"'), 'name before→after shown')
    // The summary line counts updates as 更新（不改写）.
    assert.ok(question.question.includes('更新（不改写）'), 'update counted separately from add/move')
    // Add rows carry their plan reason.
    assert.ok(question.question.includes('+ 新增 → opencode-go-msg: qwen4-max（desired id missing from its official route）'))
    // Slot lines carry the route field values (api/baseURL, compact).
    assert.ok(question.question.includes('chat→opencode-go (openai-completions, https://opencode.ai/inference/go/openai/v1)'))
    // WITHOUT --rewrite-refs there is no rewrite preview section at all.
    assert.ok(!question.question.includes('【引用改写'), 'no rewrite section when refs are report-only')
    // And the update row did NOT overwrite the user value.
    const chatAfter = h.settings.state.get('opencode-go')
    assert.equal(chatAfter.models.find((m) => m.id === 'deepseek-v4.1-flash').name, 'My Custom Flash',
      'update rows are report-only: apply leaves the user value untouched')
  } finally {
    h.dispose()
  }
})

await check('e2e: confirmation previews rewrite-refs before→after when the flag is in effect (review M8)', async () => {
  const h = createHarness({ storeSeed: { seed: { models: [] } } })
  try {
    const result = await h.invoke('migrate-go --rewrite-refs=default-model')
    assert.equal(result.kind, 'success', result.text)
    const question = h.ask.questions[0].questions[0]
    assert.equal(question.options.length, 2, 'still exactly two options')
    assert.ok(question.question.includes('【引用改写（--rewrite-refs=default-model 生效；apply 成功后执行）】'), 'the rewrite section exists')
    // The verified+rewritable candidate is shown with its before → after.
    assert.ok(question.question.includes('agent-default-model (profile patch): '), 'surface named')
    assert.ok(question.question.includes('→ see pinnedModels / new route'), 'before→after values shown')
    assert.ok(!question.question.includes('session/conversation {provider,model}: '), 'sessions are never shown as rewrite rows')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Abort / ambiguous answers (review Minor 5)
// ---------------------------------------------------------------------------

await check('e2e: signal already aborted when ask returns → cancel, zero writes', async () => {
  const h = createHarness({ ask: makeAsk({ mode: 'approve' }) })
  try {
    const patchBefore = readFileSync(h.patchPath, 'utf8')
    const controller = new AbortController()
    controller.abort()
    const result = await h.invoke('migrate-go', controller.signal)
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /已中止.*零写入/s)
    assert.equal(h.ask.calls, 1, 'the ask itself still ran (abort is re-checked AFTER it returns)')
    assert.deepEqual(h.settings.mutations, [], 'zero settings writes')
    assert.equal(readFileSync(h.patchPath, 'utf8'), patchBefore, 'patch untouched')
    assert.ok(!existsSync(h.storePath), 'models-store never created')
  } finally {
    h.dispose()
  }
})

await check('e2e: both labels selected is an ambiguous answer → cancel + rerun hint, zero writes', async () => {
  const h = createHarness({ ask: makeAsk({ mode: 'both' }) })
  try {
    const patchBefore = readFileSync(h.patchPath, 'utf8')
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /歧义.*取消.*零写入/s)
    assert.match(result.text, /重跑/)
    assert.deepEqual(h.settings.mutations, [], 'zero settings writes — proceed never wins a contested answer')
    assert.equal(readFileSync(h.patchPath, 'utf8'), patchBefore)
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Blank answers, idempotency, restore guards (review Major 2 + Minor 9)
// ---------------------------------------------------------------------------

await check('e2e: blank answer (skip) is a cancel with zero writes', async () => {
  const h = createHarness({ ask: makeAsk({ mode: 'blank' }) })
  try {
    const patchBefore = readFileSync(h.patchPath, 'utf8')
    const result = await h.invoke('migrate-go')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /已取消.*零写入/s)
    assert.deepEqual(h.settings.mutations, [], 'zero settings writes')
    assert.equal(readFileSync(h.patchPath, 'utf8'), patchBefore, 'patch untouched')
    assert.ok(!existsSync(h.storePath), 'models-store never created')
  } finally {
    h.dispose()
  }
})

await check('e2e: second run is idempotent — nothing to apply, no new backups, no new confirmation', async () => {
  const h = createHarness({ storeSeed: { seed: { models: [] } } })
  try {
    const first = await h.invoke('migrate-go')
    assert.equal(first.kind, 'success', first.text)
    const patchBackupsAfterFirst = backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\./).length
    const storeBackupsAfterFirst = backupsIn(h.home, /^models-store\.json\.bak\./).length
    assert.equal(patchBackupsAfterFirst, 1)
    assert.equal(storeBackupsAfterFirst, 1)
    const second = await h.invoke('migrate-go')
    assert.equal(second.kind, 'success', second.text)
    assert.match(second.text, /nothing to apply/)
    assert.equal(backupsIn(h.currDir, /^cordis\.patch\.yml\.bak\./).length, patchBackupsAfterFirst, 'no new patch backup')
    assert.equal(backupsIn(h.home, /^models-store\.json\.bak\./).length, storeBackupsAfterFirst, 'no new store backup')
    assert.equal(h.ask.calls, 1, 'the second run never reaches the confirmation')
    assert.equal(h.settings.updates.length, 1, 'enabled flip happens once')
  } finally {
    h.dispose()
  }
})

await check('e2e: second-target failure restores the first target byte-for-byte', async () => {
  const h = createHarness({
    // 'zeta' sorts after 'curr', so curr applies FIRST and zeta fails after.
    extraProfiles: { zeta: OTHER_PATCH },
    storeSeed: { seed: { models: [] } },
    ownershipFaultOnKeyPrefix: 'zeta#',
  })
  try {
    const currBefore = readFileSync(h.patchPath, 'utf8')
    const zetaBefore = readFileSync(join(h.profilesDir, 'zeta', 'cordis.patch.yml'), 'utf8')
    const storeBefore = readFileSync(h.storePath, 'utf8')
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /FAILED at apply for \[zeta\]/)
    assert.match(result.text, /restored .*curr\/cordis\.patch\.yml/, 'the first target is restored too')
    // First target: byte-for-byte back to its pre-run content.
    assert.equal(readFileSync(h.patchPath, 'utf8'), currBefore, 'first target patch byte-restored')
    assert.equal(readFileSync(join(h.profilesDir, 'zeta', 'cordis.patch.yml'), 'utf8'), zetaBefore, 'second target patch byte-restored')
    assert.equal(readFileSync(h.storePath, 'utf8'), storeBefore, 'models-store byte-restored through the lock accessor')
    const store = JSON.parse(readFileSync(h.storePath, 'utf8'))
    assert.deepEqual(Object.keys(store), ['seed'], 'no ledger/record residue from the first target either')
    // The first target's host-seam writes live in the host's memory, not in
    // the restored files — the report must say so instead of claiming a full
    // in-memory rollback.
    assert.match(result.text, /宿主内存态可能与磁盘文件短暂不一致/)
  } finally {
    h.dispose()
  }
})

await check('e2e: a models-store created by this run is removed again on failure', async () => {
  const h = createHarness({
    // No storeSeed: the store does not exist before the run; curr's ledger
    // writes create it, then zeta fails — the created store must be removed.
    extraProfiles: { zeta: OTHER_PATCH },
    ownershipFaultOnKeyPrefix: 'zeta#',
  })
  try {
    assert.ok(!existsSync(h.storePath), 'no store before the run')
    assert.equal(backupsIn(h.home, /^models-store\.json\.bak\./).length, 0, 'no store backup when the store did not pre-date the run')
    const result = await h.invoke('migrate-go --all-profiles')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /FAILED at apply for \[zeta\]/)
    assert.match(result.text, /removed .*models-store\.json.*created by this run/)
    assert.ok(!existsSync(h.storePath), 'the run-created store is gone after the rollback')
    // The first target's patch is still byte-restored by the same failure path.
    assert.equal(readFileSync(h.patchPath, 'utf8'), CURR_PATCH, 'first target patch byte-restored')
  } finally {
    h.dispose()
  }
})

// ---------------------------------------------------------------------------
// Restore guards (review Major 2): concurrent modifications are never clobbered
// ---------------------------------------------------------------------------

/** Minimal real-fs OneShotDeps subset for the restore/staleness helpers. */
function makeRestoreDeps(root, extra = {}) {
  return {
    home: root,
    modelsStorePath: join(root, 'models-store.json'),
    fs: {
      readFile: async (path) => readFileSync(path, 'utf8'),
      writeFile: async (path, data) => { writeFileSync(path, data) },
      rename: async (from, to) => { renameSync(from, to) },
      unlink: async (path) => { rmSync(path) },
      mkdir: async () => {},
      stat: async (path) => (existsSync(path) ? { mode: 0o644 } : undefined),
      readdir: async (path) => readdirSync(path),
      writeFileExclusive: async (path, data) => {
        try {
          writeFileSync(path, data, { flag: 'wx' })
          return true
        } catch (err) {
          if (err.code === 'EEXIST') return false
          throw err
        }
      },
    },
    patchIoFor: (path) => ({
      readText: () => readFileSync(path, 'utf8'),
      writeAtomic: async (text) => {
        const tmp = `${path}.tmp`
        writeFileSync(tmp, text)
        renameSync(tmp, path)
      },
    }),
    ...extra,
  }
}

await check('restore: patch is restored atomically only while content matches the post-write hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-restore-'))
  try {
    const source = join(root, 'cordis.patch.yml')
    const backup = join(root, 'cordis.patch.yml.bak.20261124-070809')
    writeFileSync(backup, 'PRE-RUN CONTENT')
    writeFileSync(source, 'POST-WRITE CONTENT')
    const deps = makeRestoreDeps(root)
    const postWriteSha = sha256Of('POST-WRITE CONTENT')
    const outcome = await restorePatchIfUnchanged(deps, { source, backup }, postWriteSha)
    assert.equal(outcome.restored, true)
    assert.match(outcome.line, /restored .*cordis\.patch\.yml/)
    assert.equal(readFileSync(source, 'utf8'), 'PRE-RUN CONTENT', 'bytes back to the backup')
    assert.equal(existsSync(`${source}.tmp`), false, 'atomic write cleaned its temp file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('restore: a concurrently modified patch is NOT restored (report + backup path)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-restore-'))
  try {
    const source = join(root, 'cordis.patch.yml')
    const backup = join(root, 'cordis.patch.yml.bak.20261124-070809')
    writeFileSync(backup, 'PRE-RUN CONTENT')
    writeFileSync(source, 'CONCURRENT EDIT BY ANOTHER PROCESS')
    const deps = makeRestoreDeps(root)
    const outcome = await restorePatchIfUnchanged(deps, { source, backup }, sha256Of('POST-WRITE CONTENT'))
    assert.equal(outcome.restored, false)
    assert.ok(outcome.line.includes('concurrent modification detected, not restored'), 'the mandated report line')
    assert.ok(outcome.line.includes(backup), 'the backup path is printed for manual handling')
    assert.equal(readFileSync(source, 'utf8'), 'CONCURRENT EDIT BY ANOTHER PROCESS', 'the foreign edit is never clobbered')
    // A missing post-write baseline (unreadable after our write) refuses too.
    const noBaseline = await restorePatchIfUnchanged(deps, { source, backup }, undefined)
    assert.equal(noBaseline.restored, false, 'no baseline ⇒ no restore (fail closed)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('restore: models-store is byte-exact (key order + formatting) via the lock accessor (review M5)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-store-restore-'))
  try {
    const storePath = join(root, 'models-store.json')
    const backup = join(root, 'models-store.json.bak.20261124-070809')
    // Deliberate non-alphabetical key order + spacing: a per-key rebuild would
    // reorder/re-serialize; the byte restore must preserve everything.
    const backupText = '{"seed":{"models":[]},"zlast":{"models":[]},"akey":{"models":[]}}'
    writeFileSync(backup, backupText)
    // The run added a ledger slot next to the seeded ones.
    const afterRun = { seed: { models: [] }, 'curr#opencode-go#fp': { managed: {} }, akey: { models: [] }, zlast: { models: [] } }
    writeFileSync(storePath, JSON.stringify(afterRun))
    const deps = makeRestoreDeps(root)
    const outcome = await restoreModelsStoreIfUnchanged(deps, backup, sha256Of(JSON.stringify(afterRun)))
    assert.equal(outcome.restored, true)
    assert.match(outcome.line, /restored .*models-store\.json/)
    assert.match(outcome.line, /byte-exact/, 'the report says the restore is byte-exact')
    assert.equal(readFileSync(storePath, 'utf8'), backupText, 'run-added slot gone AND original key order/bytes preserved')
    // Concurrent modification: never restored.
    const concurrent = { seed: { models: [] }, foreign: { models: [1] } }
    writeFileSync(storePath, JSON.stringify(concurrent))
    const blocked = await restoreModelsStoreIfUnchanged(deps, backup, sha256Of(JSON.stringify(afterRun)))
    assert.equal(blocked.restored, false)
    assert.ok(blocked.line.includes('concurrent modification detected, not restored'))
    assert.deepEqual(JSON.parse(readFileSync(storePath, 'utf8')), concurrent, 'foreign slots survive untouched')
    // A corrupt backup refuses loudly instead of wiping the store.
    writeFileSync(storePath, JSON.stringify(afterRun))
    writeFileSync(backup, '{not json')
    await assert.rejects(() => restoreModelsStoreIfUnchanged(deps, backup, sha256Of(JSON.stringify(afterRun))), /not valid JSON/)
    assert.equal(readFileSync(storePath, 'utf8'), JSON.stringify(afterRun), 'store untouched when the backup is unreadable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('restore: a run-created store is removed only while its content still matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-store-created-'))
  try {
    const storePath = join(root, 'models-store.json')
    const deps = makeRestoreDeps(root)
    writeFileSync(storePath, '{"created":"by this run"}')
    const outcome = await removeStoreIfUnchanged(deps, sha256Of('{"created":"by this run"}'))
    assert.equal(outcome.restored, true)
    assert.match(outcome.line, /removed .*models-store\.json/)
    assert.ok(!existsSync(storePath))
    // Concurrent touch after creation: leave it in place.
    writeFileSync(storePath, '{"someone":"else touched"}')
    const blocked = await removeStoreIfUnchanged(deps, sha256Of('{"created":"by this run"}'))
    assert.equal(blocked.restored, false)
    assert.ok(blocked.line.includes('concurrent modification detected, not restored'))
    assert.ok(existsSync(storePath), 'the store is left for manual handling')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('staleness: targets changed after their backup are dropped, fresh ones stay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-stale-'))
  try {
    const freshPath = join(root, 'fresh.patch.yml')
    const stalePath = join(root, 'stale.patch.yml')
    writeFileSync(freshPath, 'FRESH')
    writeFileSync(stalePath, 'CHANGED SINCE BACKUP')
    const deps = makeRestoreDeps(root)
    const prepared = [
      { target: { key: 'fresh', patchPath: freshPath }, patchBackup: { source: freshPath, backup: '', sourceSha: sha256Of('FRESH') } },
      { target: { key: 'stale', patchPath: stalePath }, patchBackup: { source: stalePath, backup: '', sourceSha: sha256Of('AT BACKUP TIME') } },
    ]
    const { ready, stale } = await dropStaleTargets(deps, prepared)
    assert.deepEqual(ready.map((item) => item.target.key), ['fresh'])
    assert.deepEqual(stale.map((item) => item.key), ['stale'])
    // A vanished file is stale too (its sha is undefined ≠ the recorded one).
    rmSync(stalePath)
    rmSync(freshPath)
    const vanished = await dropStaleTargets(deps, prepared)
    assert.deepEqual(vanished.ready.map((item) => item.target.key), [], 'a vanished file never counts as fresh')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await check('staleness: a drifted or newly created models-store aborts with zero writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-sync-stale-store-'))
  try {
    const storePath = join(root, 'models-store.json')
    const backup = join(root, 'models-store.json.bak.20261124-070809')
    const deps = makeRestoreDeps(root)
    // Backed up, then changed by another process before apply.
    writeFileSync(backup, '{"at":"backup"}')
    writeFileSync(storePath, '{"changed":"since backup"}')
    const drifted = await verifyStoreFreshness(deps, backup, sha256Of('{"at":"backup"}'), true)
    assert.equal(drifted.ok, false)
    assert.match(drifted.reason, /changed after its backup was taken/)
    assert.match(drifted.reason, /zero writes/)
    // Still matching → fine.
    writeFileSync(storePath, '{"at":"backup"}')
    assert.deepEqual(await verifyStoreFreshness(deps, backup, sha256Of('{"at":"backup"}'), true), { ok: true })
    // Store vanished before apply → abort.
    rmSync(storePath)
    const vanished = await verifyStoreFreshness(deps, backup, sha256Of('{"at":"backup"}'), true)
    assert.equal(vanished.ok, false)
    // No backup (store absent at backup time) but it exists NOW → abort, so
    // the rollback path can never delete another process's file.
    writeFileSync(storePath, '{"created":"by another process"}')
    const appeared = await verifyStoreFreshness(deps, undefined, undefined, false)
    assert.equal(appeared.ok, false)
    assert.match(appeared.reason, /created by another process/)
    // Still absent → fine.
    rmSync(storePath)
    assert.deepEqual(await verifyStoreFreshness(deps, undefined, undefined, false), { ok: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

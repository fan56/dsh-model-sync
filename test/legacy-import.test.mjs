// One-time legacy settings import (0.1.5 → 0.1.7): the 0.1.7 host renames the
// old settings.yaml to settings.yaml.imported and imports sections by
// "section name = entry id"; installs where that never carried the
// `model-sync:` section over get it recovered here once.
//
// Parser tests are pure string-in/string-out; import-logic tests run against
// a tmp dsh home with a fake settings seam — the marker file
// (<home>/storages/dsh-model-sync/legacy-import.json) is the observable
// contract.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_ID,
  LEGACY_KEYS,
  LEGACY_SECTION,
  inferScalar,
  legacyMarkerPath,
  legacySettingsCandidates,
  parseFlatSection,
  resolveDshHome,
  runLegacySettingsImport,
} from '../lib/legacy-import.js'

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
const check = (name, fn) => checkAsync(name, async () => fn())

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const tmpHome = () => mkdtempSync(join(tmpdir(), 'model-sync-legacy-'))
const writeLegacyDoc = (home, name, body) => writeFileSync(join(home, name), body)

/** Fake settings seam recording update() calls; `fail` makes update reject. */
function fakeSettings({ fail = false } = {}) {
  const calls = []
  return {
    seam: {
      async update(ns, patch) {
        if (fail) throw new Error('settings service exploded')
        calls.push({ ns, patch })
      },
    },
    calls,
  }
}

function fakeLogger() {
  const lines = []
  return {
    logger: {
      info: (m) => lines.push({ level: 'info', message: m }),
      warn: (m) => lines.push({ level: 'warn', message: m }),
    },
    lines,
  }
}

const LEGACY_DOC = [
  'model-sync:',
  '  writeMode: settings',
  '  intervalMinutes: 240',
  '',
].join('\n')

/** Defaults mirroring the live schema so "equal" is deterministic per key. */
const CURRENT = { writeMode: 'settings', intervalMinutes: 240 }

function boot(input = {}) {
  const home = input.home ?? tmpHome()
  const settings = 'settings' in input ? input.settings : fakeSettings()
  const logger = input.logger ?? fakeLogger()
  return {
    home,
    settings,
    logger,
    getCurrent: input.getCurrent ?? ((key) => CURRENT[key]),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

// ---------------------------------------------------------------------------
// Parser (pure)
// ---------------------------------------------------------------------------
await check('parse: flat section collects scalars with number/boolean/string inference', () => {
  const doc = [
    'llm-pi-ai:',
    '  providers:',
    '    minimax-cn:',
    '      apiKeyEnv: MINIMAX_CN_API_KEY',
    'model-sync:',
    '  writeMode: settings',
    '  intervalMinutes: 30',
    'dsh-tui:',
    '  preference: dark',
  ].join('\n')
  assert.deepEqual(parseFlatSection(doc, LEGACY_SECTION), { writeMode: 'settings', intervalMinutes: 30 })
})

await check('parse: quoted values are unquoted (single and double)', () => {
  const doc = [
    'model-sync:',
    `  writeMode: 'settings'`,
    `  intervalMinutes: "30"`,
  ].join('\n')
  // Quoted scalars stay strings (YAML semantics) — only unquoted values get
  // number/boolean inference.
  assert.deepEqual(parseFlatSection(doc, 'model-sync'), { writeMode: 'settings', intervalMinutes: '30' })
})

await check('parse: single-line quoted flow JSON is JSON-parsed after unquoting', () => {
  const doc = [
    'model-sync:',
    `  managedRoutes: '["a","b"]'`,
    `  nested: '{"k": 1}'`,
    `  broken: '[not json'`,
  ].join('\n')
  const parsed = parseFlatSection(doc, 'model-sync')
  assert.deepEqual(parsed.managedRoutes, ['a', 'b'])
  assert.deepEqual(parsed.nested, { k: 1 })
  assert.equal(parsed.broken, '[not json', 'malformed JSON stays a string')
})

await check('parse: nested blocks and folded values are skipped conservatively', () => {
  const doc = [
    'model-sync:',
    '  writeMode: settings',
    '  nested:',
    '    inner: 1',
    '    deeper:',
    '      leaf: 2',
    '  intervalMinutes: 60',
    'other:',
    '  key: value',
  ].join('\n')
  // `nested` opens a block (skipped), its children sit at a deeper indent
  // (skipped), and scalars before/after the block at the child indent survive.
  assert.deepEqual(parseFlatSection(doc, 'model-sync'), { writeMode: 'settings', intervalMinutes: 60 })
})

await check('parse: absent section and inline-value section both yield an empty map', () => {
  assert.deepEqual(parseFlatSection('other:\n  key: 1\n', 'model-sync'), {})
  assert.deepEqual(parseFlatSection('model-sync: []\n', 'model-sync'), {}, 'inline value = not a flat block map')
})

await check('parse: section ends at the next top-level key — no leakage', () => {
  const doc = 'model-sync:\n  writeMode: overlay\nafter:\n  intervalMinutes: 999\n'
  assert.deepEqual(parseFlatSection(doc, 'model-sync'), { writeMode: 'overlay' })
})

await check('parse: inferScalar covers the scalar vocabulary directly', () => {
  assert.equal(inferScalar('plain'), 'plain')
  assert.equal(inferScalar('4'), 4)
  assert.equal(inferScalar('0.3'), 0.3)
  assert.equal(inferScalar('true'), true)
  assert.equal(inferScalar('false'), false)
  assert.equal(inferScalar("'quoted: value'"), 'quoted: value')
  assert.deepEqual(inferScalar(`'["x"]'`), ['x'])
})

// ---------------------------------------------------------------------------
// Import logic (tmp home + fake seam)
// ---------------------------------------------------------------------------
await checkAsync('import: differing keys are written through settings.update and the audit marker lands', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'model-sync:',
      '  writeMode: overlay',
      '  intervalMinutes: 30',
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'imported')
    // Only keys whose legacy value differs from the current effective value.
    assert.deepEqual(t.settings.calls, [{ ns: 'dsh-model-sync', patch: { writeMode: 'overlay', intervalMinutes: 30 } }])
    assert.deepEqual(result.skipped, {})
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'imported')
    assert.equal(marker.source, 'settings.yaml.imported')
    assert.deepEqual(marker.imported, { writeMode: 'overlay', intervalMinutes: 30 })
    assert.deepEqual(marker.skipped, {})
    assert.equal(typeof marker.at, 'string')
    const summary = t.logger.lines.find((l) => l.message.includes('legacy settings import'))
    assert.ok(summary, 'a summary line is logged')
    assert.ok(summary.message.includes('writeMode, intervalMinutes'))
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: existing marker short-circuits everything (idempotent, no resurrection)', async () => {
  const t = boot()
  try {
    mkdirSync(join(t.home, 'storages', 'dsh-model-sync'), { recursive: true })
    writeFileSync(legacyMarkerPath(t.home), '{"at":"2026-09-25T00:00:00.000Z","outcome":"imported"}\n')
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: () => undefined })
    assert.equal(result.outcome, 'marker-exists')
    assert.equal(t.settings.calls.length, 0, 'settings.update never called')
    assert.equal(readFileSync(legacyMarkerPath(t.home), 'utf8').includes('2026-09-25T00:00:00.000Z'), true, 'marker untouched')
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: every legacy value equal → no update, marker no-op with equal reasons', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'no-op')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-op')
    assert.deepEqual(marker.imported, {})
    assert.deepEqual(marker.skipped, { writeMode: 'equal', intervalMinutes: 'equal' })
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: unknown keys are recorded and left out of the update', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', [
      'model-sync:',
      '  oldRenamedKey: 42',
      '  intervalMinutes: 90',
    ].join('\n'))
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'imported')
    assert.deepEqual(t.settings.calls[0].patch, { intervalMinutes: 90 })
    assert.deepEqual(result.skipped, { oldRenamedKey: 'unknown-key' })
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: settings.update rejects → warn, NO marker (next boot retries)', async () => {
  const t = boot({ settings: fakeSettings({ fail: true }) })
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, logger: t.logger.logger, getCurrent: () => undefined })
    assert.equal(result.outcome, 'update-failed')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false, 'no marker on a failed update')
    assert.ok(t.logger.lines.some((l) => l.level === 'warn' && l.message.includes('retry next boot')))
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: no settings seam → no marker, nothing read or written', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    const result = await runLegacySettingsImport({ home: t.home, settings: undefined, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'no-settings')
    assert.equal(existsSync(legacyMarkerPath(t.home)), false)
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: no legacy document at all → marker no-legacy', async () => {
  const t = boot()
  try {
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'no-legacy')
    assert.equal(t.settings.calls.length, 0)
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-legacy')
    assert.deepEqual(marker.imported, {})
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: legacy document without our section → marker no-section', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', 'ui-theme:\n  preference: light\n')
    const result = await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: t.getCurrent })
    assert.equal(result.outcome, 'no-section')
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.outcome, 'no-section')
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: settings.yaml.imported wins over settings.yaml', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml.imported', LEGACY_DOC)
    writeLegacyDoc(t.home, 'settings.yaml', 'model-sync:\n  intervalMinutes: 1\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: () => undefined })
    assert.deepEqual(t.settings.calls[0].patch, { writeMode: 'settings', intervalMinutes: 240 })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source, 'settings.yaml.imported')
  } finally {
    t.cleanup()
  }
})

await checkAsync('import: settings.yaml is the fallback when nothing was renamed', async () => {
  const t = boot()
  try {
    writeLegacyDoc(t.home, 'settings.yaml', 'model-sync:\n  intervalMinutes: 120\n')
    await runLegacySettingsImport({ home: t.home, settings: t.settings.seam, getCurrent: () => undefined })
    assert.deepEqual(t.settings.calls[0].patch, { intervalMinutes: 120 })
    const marker = JSON.parse(readFileSync(legacyMarkerPath(t.home), 'utf8'))
    assert.equal(marker.source, 'settings.yaml')
  } finally {
    t.cleanup()
  }
})

await check('contract: entry id, section name, marker dir and key mapping are stable', () => {
  assert.equal(ENTRY_ID, 'dsh-model-sync')
  assert.equal(LEGACY_SECTION, 'model-sync')
  assert.equal(legacyMarkerPath('/home/x/.dsh'), join('/home/x/.dsh', 'storages', 'dsh-model-sync', 'legacy-import.json'))
  assert.deepEqual(legacySettingsCandidates('/d'), [join('/d', 'settings.yaml.imported'), join('/d', 'settings.yaml')])
  assert.deepEqual([...LEGACY_KEYS], ['writeMode', 'intervalMinutes'], 'identity key mapping: legacy name = Config key name')
})

// $DSH_HOME override → ~/.dsh fallback (env saved/restored — a leak would
// redirect the whole suite).
await check('resolveDshHome honors $DSH_HOME and falls back to ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/custom/dsh-home'
    assert.equal(resolveDshHome(), '/custom/dsh-home')
    delete process.env.DSH_HOME
    assert.equal(resolveDshHome(), join(homedir(), '.dsh'))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\nAll ${passed} assertions passed.`)

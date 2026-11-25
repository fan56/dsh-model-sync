// One-shot migrate-go: `/model-sync migrate-go` — one command that runs the
// FULL opencode-go migration flow (plan → backup → confirm → apply) for one
// or every profile, reusing the existing plan builder and apply engine
// unchanged (design §14.2 consent gate stays authoritative; this module only
// COMPUTES planHash/confirmCode on the caller side and passes them in, never
// touching verifyConsent).
//
// Fixed pipeline (per user-approved behavior):
//   a. targets: the current profile, or --all-profiles = every profile whose
//      patch still carries a legacy opencode-go stub (models-only, no
//      api/baseURL). Profile keys reuse the repo's resolveProfileKey source.
//   b. credential: resolveRouteCredentialValue over go.ref; missing →
//      fail-closed (zero outbound calls, zero writes) with guidance.
//   c. plan per target: buildMigrationPlanFromDeps — never re-implemented.
//   d. backups BEFORE any write: `<profileDir>/cordis.patch.yml` and the
//      shared models-store.json (once per run), named `.bak.<stamp>` with a
//      sequence suffix inside one second; 3 newest kept per category.
//   e. ONE user-questions confirmation for the whole run; no channel or any
//      ask error → fail closed with the manual migrate plan/apply path.
//      Cancel → zero writes.
//   f. apply via applyMigration with the computed consent triple and
//      ackManaged: true. --yes/--auto do not exist on this command.
//   g. slots come from the resolved opencode.go.routes config (the top-level
//      patch's dsh-model-sync section as resolved by the host); apply writes
//      exactly the plan's routes — no google slot unless configured, and no
//      other provider is ever touched.
//   h. on success, opencode.go.enabled flips to true in the CURRENT profile
//      through the host settings seam; if that key cannot be written, the
//      report says so with the manual step instead of failing the migration.
//
// Atomicity: any apply failure stops the loop and byte-restores every file
// this run changed (per-profile patches + models-store.json) from the backups
// created in step d, then reports the failed step, the original error and the
// restore outcome. All external effects (fs, settings, userQuestions, fetch,
// clock, homedir) arrive through OneShotDeps.

import { join } from 'node:path'
import { fingerprintKey, type GoModelRecord } from './opencode-go-source.ts'
import { GO_SLOT_ROUTES, type GoRouteSlot } from './opencode-go-grouping.ts'
import type { GoOwnershipStore } from './opencode-go-writer.ts'
import type { GoJournalStore } from './opencode-go-journal.ts'
import { PROFILE_IDENTITY_REQUIRED_MESSAGE } from './opencode-go-profile.ts'
import {
  applyMigration,
  buildMigrationPlanFromDeps,
  type MigrateDeps,
  type MigrationPlan,
  type ReferenceRewrite,
  type RewriteRefMode,
} from './opencode-go-migrate.ts'
import type { MigrationStateStore } from './opencode-go-migration.ts'
import {
  createFilePatchSettingsService,
  parsePatchDocument,
  patchLlmPiAiProviders,
  type PatchFileIo,
  type PatchFs,
} from './opencode-go-patch-file.ts'
import type { Logger, SettingsService } from './writer.ts'

// ---------------------------------------------------------------------------
// ask-user seam — local structural view of ctx.userQuestions (same wire shape
// dsh-topics-memory consumes). Zero new dependencies: hosts without the
// service fail closed to the manual migrate plan/apply path.
// ---------------------------------------------------------------------------

export interface AskOptionShape {
  label: string
  description?: string
}

export interface AskItemShape {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskOptionShape[]
}

export interface AskAnswerItemShape {
  id: string
  selected?: string[]
  custom?: string
}

export interface AskServiceShape {
  ask(request: { questions: AskItemShape[]; agent?: unknown; signal?: AbortSignal }): Promise<{ answers?: AskAnswerItemShape[] }>
}

// ---------------------------------------------------------------------------
// Injectable fs (backups / discovery / log) — extends the patch-file subset.
// ---------------------------------------------------------------------------

export interface OneShotFs extends PatchFs {
  readdir(path: string): Promise<string[]>
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface MigrateGoFlags {
  allProfiles: boolean
  adopt: boolean
  pruneUserExtra: boolean
  rewriteRefs: RewriteRefMode
}

export const MIGRATE_GO_USAGE = [
  'usage: /model-sync migrate-go [--all-profiles] [--adopt] [--prune-user-extra] [--rewrite-refs=default-model|config]',
  '  one command = plan + file backups + ONE confirmation + apply, then opencode.go.enabled=true in the current profile',
  '  --all-profiles                         process every profile whose patch still has a legacy opencode-go stub',
  '  --adopt                                adopt existing copies (plan may move ids / delete unknown-retired ids)',
  '  --prune-user-extra                     allow deleting plan-listed user-extra ids',
  '  --rewrite-refs=default-model|config    opt into verified reference rewrites (default: report-only)',
  '  defaults: current profile only, conservative plan (no adopt, no prune, report-only refs)',
  '  rollback: /model-sync migrate rollback --plan <planHash>',
].join('\n')

const REWRITE_REF_VALUES: readonly RewriteRefMode[] = ['default-model', 'config']

/**
 * Strict flag parsing: unknown flags (including --yes/--auto — there is no
 * bypass semantics on this command) and stray positional words are errors
 * carrying the usage text.
 */
export function parseMigrateGoFlags(args: readonly string[]): { ok: true; flags: MigrateGoFlags } | { ok: false; error: string } {
  const flags: MigrateGoFlags = { allProfiles: false, adopt: false, pruneUserExtra: false, rewriteRefs: 'none' }
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (token === '--all-profiles') { flags.allProfiles = true; continue }
    if (token === '--adopt') { flags.adopt = true; continue }
    if (token === '--prune-user-extra') { flags.pruneUserExtra = true; continue }
    if (token === '--rewrite-refs') {
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, error: `migrate-go: --rewrite-refs needs a value (${REWRITE_REF_VALUES.join('|')})\n${MIGRATE_GO_USAGE}` }
      }
      if (!REWRITE_REF_VALUES.includes(value as RewriteRefMode)) {
        return { ok: false, error: `migrate-go: unsupported --rewrite-refs value '${value}' (${REWRITE_REF_VALUES.join('|')})\n${MIGRATE_GO_USAGE}` }
      }
      flags.rewriteRefs = value as RewriteRefMode
      i += 1
      continue
    }
    if (token.startsWith('--rewrite-refs=')) {
      const value = token.slice('--rewrite-refs='.length)
      if (!REWRITE_REF_VALUES.includes(value as RewriteRefMode)) {
        return { ok: false, error: `migrate-go: unsupported --rewrite-refs value '${value}' (${REWRITE_REF_VALUES.join('|')})\n${MIGRATE_GO_USAGE}` }
      }
      flags.rewriteRefs = value as RewriteRefMode
      continue
    }
    if (token.startsWith('--')) {
      return { ok: false, error: `migrate-go: unknown flag '${token}' (note: --yes/--auto do not exist here; consent comes from the interactive confirmation)\n${MIGRATE_GO_USAGE}` }
    }
    return { ok: false, error: `migrate-go: unexpected argument '${token}'\n${MIGRATE_GO_USAGE}` }
  }
  return { ok: true, flags }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface OneShotDeps {
  /** dsh home (resolveDshHome()); anchors the storages dir + profiles dir. */
  home: string
  /** Absolute path of the shared models-store.json (MODELS_STORE_PATH). */
  modelsStorePath: string
  /** Profiles directory; default `<home>/profiles`. */
  profilesDir?: string
  /** Filesystem subset for discovery / backups / restore / log. */
  fs: OneShotFs
  /**
   * Sync-read + atomic-write io for one profile patch file — the sync read is
   * what lets the file-backed settings adapter satisfy the SYNC describe()
   * contract the migration engine builds plans through.
   */
  patchIoFor(patchPath: string): PatchFileIo
  /** Current profile identity (resolveProfileKey + dir derivation at wiring). */
  currentProfile?: { key?: string; dir?: string }
  /** Host settings seam serving the CURRENT profile's settings document. */
  currentSettings?: SettingsService
  /**
   * Host settings seam for the enabled flip (prefers settings.update patch
   * merge, falls back to mutate; undefined → manual guidance in the report).
   */
  hostSettings?: (SettingsService & { update?(ns: string, patch: object): Promise<void> }) | undefined
  /** Resolved go config projection (readGoRuntimeConfig at the wiring site). */
  goConfig: {
    routes: Partial<Record<GoRouteSlot, string>>
    ref: string
    pinnedModels: readonly string[]
    adoptDisabled: boolean
  }
  /** Credential value resolution (resolveRouteCredentialValue at the wiring). */
  resolveCredential(): Promise<{ value: string | undefined; ref: string }>
  /** Official listing (credential-gated; test seams win before any fetch). */
  resolveEntries(apiKey: string): Promise<readonly GoModelRecord[]>
  /** Public catalog ids for id classification; undefined = fail-closed. */
  resolvePublicCatalogIds(apiKey: string, entries: readonly GoModelRecord[]): Promise<readonly string[] | undefined>
  /** ask-user seam, resolved lazily at invocation time. */
  resolveAsk(): AskServiceShape | undefined
  /**
   * Per-profile store pair. The injected test seams win at the wiring and are
   * returned verbatim; the production fallback scopes both file-backed stores
   * with the given profile key in the shared models-store.json.
   */
  storesFor(profileKey: string): { ownership: GoOwnershipStore; migration: MigrationStateStore }
  /** Write-ahead journal store for post-apply cleanup; optional. */
  journalStore?: GoJournalStore
  /** M-5 single-flight check (go scheduler lock). */
  isSyncInFlight(): boolean
  /** Reference rewriter seam — CURRENT profile only. */
  applyReferenceRewrite?: ((rewrite: ReferenceRewrite) => Promise<void>) | undefined
  /**
   * TEST FAULT INJECTION ONLY (mirrors MigrateDeps.faultInjectOp). When set,
   * ownership-ledger writes whose key starts with this prefix throw, which is
   * how the mid-apply failure + byte-restore path is exercised. Production
   * callers never set it.
   */
  faultOwnershipWriteOnKeyPrefix?: string | undefined
  logger: Logger
  /** Clock (never reads Date.now() directly). */
  now(): number
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Local-time `YYYYMMDD-HHMMSS` stamp — the backup/log naming convention. */
export function formatStamp(date: Date): string {
  const p = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

const PATCH_BACKUP_PATTERN = /^cordis\.patch\.yml\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/
const STORE_BACKUP_PATTERN = /^models-store\.json\.bak\.(\d{8}-\d{6})(?:\.(\d+))?$/

/** First free `<base>` / `<base>.<seq>` path inside one second (no overwrite). */
export function nextBackupPath(exists: (path: string) => boolean, base: string): string {
  if (!exists(base)) return base
  for (let seq = 2; ; seq += 1) {
    const candidate = `${base}.${seq}`
    if (!exists(candidate)) return candidate
  }
}

function backupSortKey(name: string, pattern: RegExp): { ts: string; seq: number } | undefined {
  const match = pattern.exec(name)
  if (match === null) return undefined
  return { ts: match[1]!, seq: Number(match[2] ?? 0) }
}

/**
 * Retention: keep the `keep` newest backups matching `pattern` in `dirPath`
 * (sorted by filename timestamp, then sequence) and unlink the rest. Returns
 * the removed names. Best-effort per file: unlink errors are reported, not
 * thrown — retention must never fail a migration that already backed up.
 */
export async function pruneBackups(
  fs: OneShotFs,
  dirPath: string,
  pattern: RegExp,
  keep = 3,
): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dirPath)
  } catch {
    return [] // no directory yet → nothing to prune
  }
  const backups = names
    .map((name) => ({ name, key: backupSortKey(name, pattern) }))
    .filter((item): item is { name: string; key: { ts: string; seq: number } } => item.key !== undefined)
    .sort((a, b) => a.key.ts.localeCompare(b.key.ts) || a.key.seq - b.key.seq)
  const excess = backups.slice(0, Math.max(0, backups.length - keep))
  const removed: string[] = []
  for (const item of excess) {
    try {
      await fs.unlink(join(dirPath, item.name))
      removed.push(item.name)
    } catch {
      // Advisory: a stuck file only means 4 backups instead of 3.
    }
  }
  return removed
}

interface LegacyStub {
  route: string
  ids: string[]
}

/**
 * The legacy stub definition from the approved behavior: an `opencode-go*`
 * section that carries a models array but NO api/baseURL — the handwritten
 * pre-migration entry. Any other provider section is ignored here.
 */
export function legacyStubsOf(providers: unknown, goRouteIds: readonly string[]): LegacyStub[] {
  const stubs: LegacyStub[] = []
  if (typeof providers !== 'object' || providers === null) return stubs
  const record = providers as Record<string, unknown>
  for (const route of [...new Set(goRouteIds)]) {
    const section = record[route]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) continue
    const data = section as Record<string, unknown>
    if (data.api !== undefined || data.baseURL !== undefined) continue
    if (!Array.isArray(data.models)) continue
    const ids = data.models
      .map((model) => (model !== null && typeof model === 'object' ? (model as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    stubs.push({ route, ids })
  }
  return stubs
}

/** Read + parse a patch file and return its llm-pi-ai providers plain tree. */
async function readPatchProviders(fs: OneShotFs, patchPath: string): Promise<{ ok: true; providers: unknown } | { ok: false; reason: string }> {
  let text: string
  try {
    text = await fs.readFile(patchPath)
  } catch (err) {
    return { ok: false, reason: `cannot read ${patchPath}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const parsed = parsePatchDocument(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const providers = patchLlmPiAiProviders(parsed.root)
  if (!providers.ok) return { ok: false, reason: providers.reason }
  return { ok: true, providers: providers.providers }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface Target {
  /** Profile key (store scoping + report label). */
  key: string
  /** Profile directory (backup anchors). */
  dir: string
  patchPath: string
  /** True when this target is served by the host settings seam. */
  isCurrent: boolean
  stubs: LegacyStub[]
}

function resolveProfileDir(deps: OneShotDeps): string | undefined {
  const dir = deps.currentProfile?.dir
  if (dir !== undefined && dir.trim() !== '') return dir
  const key = deps.currentProfile?.key
  if (key === undefined || key.trim() === '') return undefined
  // The host derives name = basename(dir), so a NAME key maps back into the
  // standard profiles layout; a dir-shaped key already is the directory.
  if (key.includes('/')) return key
  return join(deps.profilesDir ?? join(deps.home, 'profiles'), key)
}

async function discoverTargets(deps: OneShotDeps, flags: MigrateGoFlags): Promise<{ targets: Target[]; skipped: string[] }> {
  const goRouteIds = [...new Set(Object.values({ ...GO_SLOT_ROUTES, ...deps.goConfig.routes }))]
  const currentKey = deps.currentProfile?.key
  if (currentKey === undefined || currentKey.trim() === '') {
    throw new Error(PROFILE_IDENTITY_REQUIRED_MESSAGE)
  }
  const skipped: string[] = []
  if (!flags.allProfiles) {
    const dir = resolveProfileDir(deps)
    if (dir === undefined) {
      throw new Error(`${PROFILE_IDENTITY_REQUIRED_MESSAGE} (also: no profile directory available to back up)`)
    }
    const patchPath = join(dir, 'cordis.patch.yml')
    let stubs: LegacyStub[] = []
    if (deps.currentSettings !== undefined) {
      const desc = deps.currentSettings.describe().find((item) => item.ns === 'llm-pi-ai')
      stubs = legacyStubsOf(desc?.user?.providers, goRouteIds)
    } else {
      const providers = await readPatchProviders(deps.fs, patchPath)
      if (!providers.ok) skipped.push(`current profile: ${providers.reason}`)
      else stubs = legacyStubsOf(providers.providers, goRouteIds)
    }
    return { targets: [{ key: currentKey, dir, patchPath, isCurrent: true, stubs }], skipped }
  }
  const profilesDir = deps.profilesDir ?? join(deps.home, 'profiles')
  let names: string[]
  try {
    names = await deps.fs.readdir(profilesDir)
  } catch (err) {
    throw new Error(`cannot list ${profilesDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const targets: Target[] = []
  for (const name of names.sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const dir = join(profilesDir, name)
    const patchPath = join(dir, 'cordis.patch.yml')
    const providers = await readPatchProviders(deps.fs, patchPath)
    if (!providers.ok) {
      // Files the reader cannot handle (missing patch, unsupported YAML) are
      // reported and skipped — fail closed, never edited.
      skipped.push(`${name}: ${providers.reason}`)
      continue
    }
    const stubs = legacyStubsOf(providers.providers, goRouteIds)
    if (stubs.length === 0) continue
    const isCurrent = name === currentKey || currentKey === dir
    targets.push({ key: name, dir, patchPath, isCurrent, stubs })
  }
  return { targets, skipped }
}

// ---------------------------------------------------------------------------
// Stores wrapping (changed-file tracking for the restore path)
// ---------------------------------------------------------------------------

interface ChangeTracker {
  patchChanged: boolean
  storeChanged: boolean
}

function wrapOwnershipStore(
  store: GoOwnershipStore,
  tracker: ChangeTracker,
  faultPrefix: string | undefined,
  profileKey: string | undefined,
): GoOwnershipStore {
  return {
    read: (key) => store.read(key),
    write: async (key, entry) => {
      // The underlying store scopes keys as `<profileKey>#<key>`; the fault
      // prefix targets the SCOPED form (per profile), mirroring the raw form
      // for unscoped callers.
      const scopedKey = profileKey === undefined ? key : `${profileKey}#${key}`
      if (faultPrefix !== undefined && (scopedKey.startsWith(faultPrefix) || key.startsWith(faultPrefix))) {
        throw new Error(`fault-injected ledger write failure for ${scopedKey}`)
      }
      tracker.storeChanged = true
      await store.write(key, entry)
    },
    delete: (key) => store.delete(key),
  }
}

function wrapMigrationStore(store: MigrationStateStore, tracker: ChangeTracker): MigrationStateStore {
  const write = store.write
  const legacyKeys = store.legacyKeys
  const unclaimedRecords = store.unclaimedRecords
  return {
    read: () => store.read(),
    ...(write === undefined ? {} : {
      write: async (record: Parameters<NonNullable<MigrationStateStore['write']>>[0]) => {
        tracker.storeChanged = true
        await write(record)
      },
    }),
    ...(legacyKeys === undefined ? {} : { legacyKeys: () => legacyKeys() }),
    ...(unclaimedRecords === undefined ? {} : { unclaimedRecords: () => unclaimedRecords() }),
  }
}

function wrapSettings(settings: SettingsService, tracker: ChangeTracker): SettingsService {
  return {
    describe: () => settings.describe(),
    mutate: async (ns, ops, expectedRevision) => {
      await settings.mutate(ns, ops, expectedRevision)
      tracker.patchChanged = true
    },
  }
}

// ---------------------------------------------------------------------------
// Migration deps per target (the ONLY place MigrateDeps is assembled here)
// ---------------------------------------------------------------------------

interface SharedPlanInputs {
  entries: readonly GoModelRecord[]
  publicCatalogIds: readonly string[] | undefined
  keyFingerprint: string
}

function buildTargetDeps(
  deps: OneShotDeps,
  target: Target,
  shared: SharedPlanInputs,
  flags: MigrateGoFlags,
): { migrateDeps: MigrateDeps; tracker: ChangeTracker } {
  const tracker: ChangeTracker = { patchChanged: false, storeChanged: false }
  const rawSettings = target.isCurrent && deps.currentSettings !== undefined
    ? deps.currentSettings
    : createFilePatchSettingsService(deps.patchIoFor(target.patchPath))
  const stores = deps.storesFor(target.key)
  const migrateDeps: MigrateDeps = {
    settings: wrapSettings(rawSettings, tracker),
    ownershipStore: wrapOwnershipStore(stores.ownership, tracker, deps.faultOwnershipWriteOnKeyPrefix, target.key),
    migrationStore: wrapMigrationStore(stores.migration, tracker),
    logger: deps.logger,
    entries: shared.entries,
    publicCatalogIds: shared.publicCatalogIds,
    routes: deps.goConfig.routes,
    ref: deps.goConfig.ref,
    keyFingerprint: shared.keyFingerprint,
    adopt: flags.adopt,
    adoptDisabled: deps.goConfig.adoptDisabled,
    rewriteRefs: flags.rewriteRefs,
    pinnedModels: deps.goConfig.pinnedModels,
    pruneUserExtra: flags.pruneUserExtra,
    now: deps.now(),
    isSyncInFlight: deps.isSyncInFlight,
    // Reference rewrites ride the host ctx seam and only ever touch the
    // current profile's own document — never a sibling profile's files.
    applyReferenceRewrite: target.isCurrent ? deps.applyReferenceRewrite : undefined,
    journalStore: deps.journalStore,
    profileKey: target.key,
  }
  return { migrateDeps, tracker }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

interface BackupRecord {
  source: string
  backup: string
}

async function backupFile(
  deps: OneShotDeps,
  source: string,
  stamp: string,
  dirPath: string,
  pattern: RegExp,
): Promise<BackupRecord> {
  let text: string
  try {
    text = await deps.fs.readFile(source)
  } catch (err) {
    throw new Error(`backup failed for ${source}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const base = `${source}.bak.${stamp}`
  const names = await deps.fs.readdir(dirPath).catch(() => [] as string[])
  const backupPath = nextBackupPath((candidate) => names.includes(candidate.slice(dirPath.length + 1)), base)
  await deps.fs.writeFile(backupPath, text)
  await pruneBackups(deps.fs, dirPath, pattern)
  return { source, backup: backupPath }
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

const CONFIRM_QUESTION_ID = 'migrate-go-confirm'
const CONFIRM_PROCEED = '执行迁移'
const CONFIRM_CANCEL = '取消'

function slotSummary(plan: MigrationPlan): string {
  const slots = (['chat', 'msg', 'resp', 'google'] as GoRouteSlot[])
    .map((slot) => ({ slot, route: plan.routes.find((candidate) => candidate.slot === slot) }))
    .filter((item): item is { slot: GoRouteSlot; route: MigrationPlan['routes'][number] } => item.route !== undefined)
    .map((item) => `${item.slot}→${item.route.route}`)
  return slots.length > 0 ? slots.join('、') : '(no route changes)'
}

function buildConfirmQuestion(stamp: string, prepared: PreparedTarget[], modelsStoreBackup: string | undefined): AskItemShape {
  const lines: string[] = []
  lines.push('即将执行 opencode-go 一键迁移（写入前最后确认）。')
  lines.push('将要删除/重写的旧条目（legacy 残桩 → 托管槽位）:')
  for (const item of prepared) {
    for (const stub of item.stubs) {
      lines.push(`  - [${item.target.key}] ${stub.route}（手写模型 ${stub.ids.length} 个: ${stub.ids.join(', ') || '无'}）`)
    }
  }
  lines.push(`将新建/写入的槽位: ${slotSummary(prepared[0]!.plan)}（按 opencode.go.routes 配置；未配置的槽不创建，google 缺省不建）`)
  lines.push('每个 profile 一行摘要:')
  for (const item of prepared) {
    const add = item.plan.idActions.filter((action) => action.op === 'add' || action.op === 'move').length
    const del = item.plan.idActions.filter((action) => action.op === 'delete').length
    const keep = item.plan.idActions.filter((action) => action.op === 'keep').length
    lines.push(`  - [${item.target.key}] +${add} 新增 / ${del} 删除 / ${keep} 保留；planHash ${item.plan.planHash.slice(0, 12)}…`)
  }
  lines.push('备份文件（失败即字节恢复）:')
  for (const item of prepared) lines.push(`  - ${item.patchBackup.backup}`)
  if (modelsStoreBackup !== undefined) lines.push(`  - ${modelsStoreBackup}`)
  lines.push(`迁移成功后: 当前 profile 的 opencode.go.enabled → true（时间戳 ${stamp}）。`)
  return {
    id: CONFIRM_QUESTION_ID,
    header: 'model-sync migrate-go',
    question: lines.join('\n'),
    detail: lines.join('\n'),
    options: [
      { label: CONFIRM_PROCEED, description: '按以上计划执行迁移；任一步失败会用本轮备份自动恢复' },
      { label: CONFIRM_CANCEL, description: '不做任何写入（本轮备份保留，可手动删除）' },
    ],
  }
}

function failClosedConfirmMessage(reason: string, prepared: PreparedTarget[]): string {
  const lines = [
    `migrate-go: 确认通道不可用（${reason}）——零写入。`,
    '按要求不跳过确认：请改用手动流程逐个 profile 执行：',
    '  1. /model-sync migrate plan [--adopt] [--prune-user-extra]',
    '  2. /model-sync migrate apply --plan <planHash> --confirm <confirmCode> --ack-managed',
  ]
  for (const item of prepared) {
    lines.push(`  [${item.target.key}] planHash: ${item.plan.planHash}`)
    lines.push(`  [${item.target.key}] confirmCode: ${item.plan.confirmCode}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

interface PreparedTarget {
  target: Target
  plan: MigrationPlan
  migrateDeps: MigrateDeps
  tracker: ChangeTracker
  stubs: LegacyStub[]
  patchBackup: BackupRecord
}

export interface OneShotOutcome {
  kind: 'success' | 'error'
  text: string
}

export async function runMigrateGoOneShot(
  deps: OneShotDeps,
  flags: MigrateGoFlags,
  invocation: { agent?: unknown; signal?: AbortSignal },
): Promise<OneShotOutcome> {
  const log: string[] = []
  const stamp = formatStamp(new Date(deps.now()))
  const note = (line: string): void => { log.push(line) }

  try {
    // ---- a. targets -------------------------------------------------------
    const { targets, skipped } = await discoverTargets(deps, flags)
    for (const line of skipped) note(`skipped: ${line}`)
    if (targets.length === 0) {
      const text = ['migrate-go: nothing to migrate (no target profile).', ...skipped.map((line) => `  skipped: ${line}`)].join('\n')
      return { kind: 'success', text }
    }

    // ---- b. credential (fail closed before any fetch or write) ------------
    const credential = await deps.resolveCredential()
    if (credential.value === undefined || credential.value.trim() === '') {
      return {
        kind: 'error',
        text: [
          `migrate-go: credential '${credential.ref}' 未配置——零外呼、零写入。`,
          `请先配置该凭证（dsh credentials 或环境变量 ${credential.ref}），再运行 /model-sync migrate-go；`,
          '或走手动流程：/model-sync migrate plan → apply。',
        ].join('\n'),
      }
    }
    const apiKey = credential.value

    // ---- c. plans (shared listing, per-target plan via the existing builder)
    let entries: readonly GoModelRecord[]
    try {
      entries = await deps.resolveEntries(apiKey)
    } catch (err) {
      return { kind: 'error', text: `migrate-go: official listing unavailable (${err instanceof Error ? err.message : String(err)}); zero writes` }
    }
    const publicCatalogIds = await deps.resolvePublicCatalogIds(apiKey, entries)
    const shared: SharedPlanInputs = { entries, publicCatalogIds, keyFingerprint: fingerprintKey(apiKey.trim()) }

    const prepared: PreparedTarget[] = []
    const notMigratable: string[] = []
    for (const target of targets) {
      const { migrateDeps, tracker } = buildTargetDeps(deps, target, shared, flags)
      const record = await migrateDeps.migrationStore.read().catch(() => undefined)
      const plan = buildMigrationPlanFromDeps(migrateDeps, record)
      if (plan.state !== 'legacy-inherit' && plan.state !== 'legacy-inline' && plan.state !== 'drifted') {
        notMigratable.push(`${target.key}: state=${plan.state} (nothing to migrate)`)
        continue
      }
      prepared.push({ target, plan, migrateDeps, tracker, stubs: target.stubs, patchBackup: { source: '', backup: '' } })
    }
    for (const line of notMigratable) note(`not migratable: ${line}`)
    if (prepared.length === 0) {
      const text = [
        'migrate-go: nothing to apply — no target profile is in a migratable state.',
        ...notMigratable.map((line) => `  ${line}`),
        ...skipped.map((line) => `  skipped: ${line}`),
      ].join('\n')
      return { kind: 'success', text }
    }

    // ---- d. backups BEFORE any write --------------------------------------
    const patchBackups: BackupRecord[] = []
    let modelsStoreBackup: string | undefined
    try {
      for (const item of prepared) {
        const record = await backupFile(deps, item.target.patchPath, stamp, item.target.dir, PATCH_BACKUP_PATTERN)
        patchBackups.push(record)
        item.patchBackup = record
        note(`backup: ${record.source} → ${record.backup}`)
      }
      let storeText: string | undefined
      try {
        storeText = await deps.fs.readFile(deps.modelsStorePath)
      } catch (err) {
        if (!isEnoent(err)) throw err
      }
      if (storeText !== undefined) {
        const base = `${deps.modelsStorePath}.bak.${stamp}`
        const homeDir = deps.home
        const names = await deps.fs.readdir(homeDir).catch(() => [] as string[])
        const backupPath = nextBackupPath((candidate) => names.includes(candidate.slice(homeDir.length + 1)), base)
        await deps.fs.writeFile(backupPath, storeText)
        modelsStoreBackup = backupPath
        note(`backup: ${deps.modelsStorePath} → ${backupPath}`)
        await pruneBackups(deps.fs, homeDir, STORE_BACKUP_PATTERN)
      }
    } catch (err) {
      return { kind: 'error', text: `migrate-go: ${err instanceof Error ? err.message : String(err)}; zero writes` }
    }

    // ---- e. ONE confirmation (fail closed without the channel) ------------
    const ask = deps.resolveAsk()
    if (ask === undefined || typeof ask.ask !== 'function') {
      return { kind: 'error', text: failClosedConfirmMessage('userQuestions 服务缺失（NO_PROVIDER / 未注册）', prepared) }
    }
    let answers: { answers?: AskAnswerItemShape[] }
    try {
      answers = await ask.ask({
        questions: [buildConfirmQuestion(stamp, prepared, modelsStoreBackup)],
        ...(invocation.agent === undefined ? {} : { agent: invocation.agent }),
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      })
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code?: unknown }).code as string : undefined
      const reason = err instanceof Error ? `${err.message}${code !== undefined ? ` [${code}]` : ''}` : String(err)
      note(`confirm failed: ${reason}`)
      return { kind: 'error', text: failClosedConfirmMessage(reason, prepared) }
    }
    const answer = (answers.answers ?? []).find((item) => item.id === CONFIRM_QUESTION_ID)
    const selected = answer?.selected ?? []
    if (!selected.includes(CONFIRM_PROCEED)) {
      note('confirm: cancelled / blank')
      return {
        kind: 'success',
        text: [
          'migrate-go: 已取消——零写入。',
          '本轮备份已生成（保留，可手动删除）:',
          ...[...patchBackups.map((item) => item.backup), ...(modelsStoreBackup !== undefined ? [modelsStoreBackup] : [])].map((path) => `  ${path}`),
        ].join('\n'),
      }
    }
    note('confirm: approved')

    // ---- f. apply (existing engine; consent triple computed HERE) ---------
    const applied: PreparedTarget[] = []
    const changedPatches: { backup: BackupRecord; isCurrent: boolean }[] = []
    let modelsStoreChanged = false
    let modelsStoreCreated = false
    let failure: { target: Target; detail: string } | undefined
    for (const item of prepared) {
      let resultText: string | undefined
      let resultOk = false
      try {
        const result = await applyMigration(
          { planHash: item.plan.planHash, confirmCode: item.plan.confirmCode, ackManaged: true },
          item.migrateDeps,
        )
        resultText = result.text
        resultOk = result.ok
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err)
      }
      // Track changes BEFORE judging the outcome: applyMigration may have
      // mutated settings/stores and then failed (its internal logical restore
      // mutates too) — those files must be byte-restored regardless.
      if (item.tracker.patchChanged === true) changedPatches.push({ backup: item.patchBackup, isCurrent: item.target.isCurrent })
      if (item.tracker.storeChanged === true) {
        modelsStoreChanged = true
        // The store backup only exists when the file pre-dated the run; a
        // store created by this run is restored by removing it again.
        modelsStoreCreated ||= modelsStoreBackup === undefined
      }
      for (const line of (resultText ?? '').split('\n')) note(`[${item.target.key}] apply: ${line}`)
      if (!resultOk) {
        failure = { target: item.target, detail: resultText ?? 'unknown apply failure' }
        break
      }
      applied.push(item)
    }

    // ---- atomicity: byte-restore everything this run changed --------------
    if (failure !== undefined) {
      const restore: string[] = []
      let restoredHostSeamProfile = false
      for (const changed of [...changedPatches].reverse()) {
        try {
          const text = await deps.fs.readFile(changed.backup.backup)
          await deps.fs.writeFile(changed.backup.source, text)
          restore.push(`restored ${changed.backup.source} ← ${changed.backup.backup}`)
          restoredHostSeamProfile ||= changed.isCurrent
        } catch (err) {
          restore.push(`RESTORE FAILED for ${changed.backup.source}: ${err instanceof Error ? err.message : String(err)} (backup: ${changed.backup.backup})`)
        }
      }
      if (modelsStoreCreated) {
        try {
          await deps.fs.unlink(deps.modelsStorePath)
          restore.push(`removed ${deps.modelsStorePath} (created by this run)`)
        } catch (err) {
          restore.push(`RESTORE FAILED for ${deps.modelsStorePath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (modelsStoreChanged && modelsStoreBackup !== undefined) {
        try {
          const text = await deps.fs.readFile(modelsStoreBackup)
          await deps.fs.writeFile(deps.modelsStorePath, text)
          restore.push(`restored ${deps.modelsStorePath} ← ${modelsStoreBackup}`)
        } catch (err) {
          restore.push(`RESTORE FAILED for ${deps.modelsStorePath}: ${err instanceof Error ? err.message : String(err)} (backup: ${modelsStoreBackup})`)
        }
      }
      const text = [
        `migrate-go: FAILED at apply for [${failure.target.key}] — 已回滚本轮全部改动文件。`,
        `失败步骤: apply；原始错误: ${failure.detail}`,
        '恢复结果:',
        ...(restore.length > 0 ? restore.map((line) => `  ${line}`) : ['  (no file had been written)']),
        ...(restoredHostSeamProfile
          ? ['注意: 当前 profile 的写入经宿主 settings 服务落地，恢复后宿主内存态可能与磁盘文件短暂不一致；如需核对请重启该 profile 或运行 /model-sync migrate status。']
          : []),
        `日志: ${logPathOf(deps, stamp)}`,
      ].join('\n')
      await writeRunLog(deps, stamp, log, text)
      return { kind: 'error', text }
    }

    // ---- h. flip opencode.go.enabled in the CURRENT profile ---------------
    let enabledLine: string
    if (deps.hostSettings === undefined) {
      enabledLine = 'opencode.go.enabled 未写入（宿主 settings 服务不可用）— 请手动在该 profile 的 dsh-model-sync 配置里设 opencode.go.enabled: true'
    } else {
      enabledLine = await flipGoEnabled(deps)
    }

    // ---- report + log ------------------------------------------------------
    const lines: string[] = []
    lines.push(`migrate-go: ${applied.length} profile(s) migrated.`)
    for (const item of applied) {
      const postPlan = buildMigrationPlanFromDeps(item.migrateDeps, await item.migrateDeps.migrationStore.read().catch(() => undefined))
      const desiredCount = postPlan.routes.reduce((sum, route) => sum + route.desired.length, 0)
      const add = item.plan.idActions.filter((action) => action.op === 'add' || action.op === 'move').length
      const del = item.plan.idActions.filter((action) => action.op === 'delete').length
      lines.push(`  [${item.target.key}] slots: ${slotSummary(item.plan)}; +${add}/-${del}; ${desiredCount} managed models; state after: ${postPlan.state}`)
      lines.push(`    backup: ${item.patchBackup.backup}`)
      lines.push(`    rollback: /model-sync migrate rollback --plan ${item.plan.planHash}`)
    }
    if (modelsStoreBackup !== undefined) lines.push(`  models-store backup: ${modelsStoreBackup}`)
    lines.push(`  ${enabledLine}`)
    for (const line of skipped) lines.push(`  skipped: ${line}`)
    const logPath = await writeRunLog(deps, stamp, log, undefined)
    if (logPath !== undefined) lines.push(`  log: ${logPath}`)
    return { kind: 'success', text: lines.join('\n') }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeRunLog(deps, stamp, [...log, `unhandled error: ${message}`], undefined)
    return { kind: 'error', text: `migrate-go failed: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Enabled flip + log
// ---------------------------------------------------------------------------

async function flipGoEnabled(deps: OneShotDeps): Promise<string> {
  const settings = deps.hostSettings!
  try {
    if (typeof settings.update === 'function') {
      await settings.update('dsh-model-sync', { opencode: { go: { enabled: true } } })
      return 'opencode.go.enabled → true (written through settings.update).'
    }
    await settings.mutate('dsh-model-sync', [{ op: 'set', path: ['opencode', 'go', 'enabled'], value: true }])
    return 'opencode.go.enabled → true (written through settings.mutate).'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `opencode.go.enabled 不可写（${message}）— 请手动在该 profile 的 dsh-model-sync 配置里设 opencode.go.enabled: true`
  }
}

function logPathOf(deps: OneShotDeps, stamp: string): string {
  return join(deps.home, 'storages', 'dsh-model-sync', `migrate-go-${stamp}.log`)
}

/** Full-detail run log. A failed log write only warns — never fails the run. */
async function writeRunLog(deps: OneShotDeps, stamp: string, log: string[], extra?: string): Promise<string | undefined> {
  const path = logPathOf(deps, stamp)
  try {
    await deps.fs.mkdir(join(path, '..'), { recursive: true })
    const body = [...log, ...(extra !== undefined ? ['', ...extra.split('\n')] : [])].join('\n')
    await deps.fs.writeFile(path, `${body}\n`)
    return path
  } catch (err) {
    deps.logger.warn('migrate-go: log write failed (%s): %s', path, err instanceof Error ? err.message : String(err))
    return undefined
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}

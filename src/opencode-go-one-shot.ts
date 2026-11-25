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
//      Cancel → zero writes. After the ask returns, invocation.signal.aborted
//      is re-checked (abort ⇒ cancel) and an answer carrying BOTH option
//      labels is an ambiguous cancel + rerun — proceed never wins a contested
//      answer.
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
// this run changed (per-profile patches + models-store.json) — patches through
// the same atomic tmp+rename io the apply writes with, the models-store as a
// whole-document byte replacement through the remote-catalog lock accessor
// (exact backup bytes, tmp+rename under the lock — never a raw overwrite and
// never a key-order-changing per-key rebuild). Every restore first re-hashes
// the on-disk content and refuses to touch a file a concurrent process has
// modified since this run's last write. Backups are created under an O_EXCL
// exclusive claim (same-second collisions retry the next sequence suffix; no
// readdir snapshot can hand out one name twice), and each target's staleness
// is re-verified (sha256) right before apply, so a file edited between backup
// and apply aborts that target with zero writes. `--rewrite-refs` writes ride
// the same change tracker as settings writes (registered + sha-baselined, so
// a later failure restores them too). All external effects (fs, settings,
// userQuestions, fetch, clock, homedir) arrive through OneShotDeps.

import { createHash } from 'node:crypto'
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
  type MigrationIdPlan,
  type MigrationPlan,
  type ReferenceRewrite,
  type RewriteRefMode,
} from './opencode-go-migrate.ts'
import { loadModelsStore, STORE_RESTORE_SHA_MISMATCH } from './remote-catalog.ts'
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
  /**
   * Exclusive-claim + atomic write in one step: creates `path` with O_EXCL
   * semantics (returns `false` when the name is already taken — the caller
   * retries the next sequence suffix), then replaces its content through a
   * sibling temp file + rename so a crash never leaves a torn backup. This is
   * how backups are born: the FILESYSTEM decides "name taken", never a
   * readdir snapshot two racers can read identically.
   */
  writeFileExclusive(path: string, data: string, mode?: number): Promise<boolean>
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

/** sha256 hex digest of a text — the staleness / concurrent-modification detector. */
export function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Create `<base>` / `<base>.<seq>` exclusively: `writeFileExclusive` returns
 * false when the name is taken (O_EXCL), and only then does the loop advance
 * the sequence suffix. No readdir snapshot is consulted, so two processes
 * racing inside the same second can never both "win" the same backup name —
 * the loser retries onto `.<seq+1>` and both files survive.
 */
export async function writeExclusiveBackup(fs: OneShotFs, base: string, text: string, mode?: number): Promise<string> {
  let candidate = base
  for (let seq = 2; ; seq += 1) {
    if (await fs.writeFileExclusive(candidate, text, mode)) return candidate
    candidate = `${base}.${seq}`
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
  /**
   * sha256 of the patch file's content recorded IMMEDIATELY after this
   * target's last settings write (the post-write baseline). Restore only
   * replaces the file while its current content still hashes to this value;
   * `undefined` (file unreadable after the write) makes restore refuse —
   * fail closed instead of clobbering an unbaselined file.
   */
  patchPostWriteSha?: string | undefined
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

function wrapSettings(
  settings: SettingsService,
  tracker: ChangeTracker,
  recordPostWrite: () => Promise<void>,
): SettingsService {
  return {
    describe: () => settings.describe(),
    mutate: async (ns, ops, expectedRevision) => {
      await settings.mutate(ns, ops, expectedRevision)
      tracker.patchChanged = true
      // Baseline the post-write bytes while nothing else has had a chance to
      // touch the file — this hash is what the restore path verifies against.
      await recordPostWrite()
    },
  }
}

/**
 * Review M4: `--rewrite-refs` writes land in the SAME document the settings
 * seam writes, but they used to bypass the change tracker entirely — a later
 * target's failure then left the rewritten references unrestored, and the
 * stale post-write sha made the restore guard misreport the very file this
 * run had just written as "concurrent modification detected". The wrapped
 * seam registers the write on the tracker (restorable) and refreshes the sha
 * baseline immediately after the rewrite lands.
 */
function wrapReferenceRewrite(
  rewrite: (rewrite: ReferenceRewrite) => Promise<void>,
  tracker: ChangeTracker,
  recordPostWrite: () => Promise<void>,
): (rewrite: ReferenceRewrite) => Promise<void> {
  return async (request: ReferenceRewrite) => {
    await rewrite(request)
    tracker.patchChanged = true
    await recordPostWrite()
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
  const tracker: ChangeTracker = { patchChanged: false, storeChanged: false, patchPostWriteSha: undefined }
  // Baseline the patch file's bytes right after every settings write so the
  // restore path can prove the file was not touched by anyone else in between
  // (review Major 2: restore only ever replaces content this run wrote).
  const recordPatchPostWrite = async (): Promise<void> => {
    try {
      tracker.patchPostWriteSha = sha256Of(await deps.fs.readFile(target.patchPath))
    } catch {
      tracker.patchPostWriteSha = undefined // unreadable ⇒ restore must refuse
    }
  }
  const rawSettings = target.isCurrent && deps.currentSettings !== undefined
    ? deps.currentSettings
    : createFilePatchSettingsService(deps.patchIoFor(target.patchPath))
  const stores = deps.storesFor(target.key)
  const migrateDeps: MigrateDeps = {
    settings: wrapSettings(rawSettings, tracker, recordPatchPostWrite),
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
    // current profile's own document — never a sibling profile's files. They
    // go through the change tracker (review M4) so a later failure restores
    // them and the post-write sha stays truthful.
    applyReferenceRewrite: target.isCurrent && deps.applyReferenceRewrite !== undefined
      ? wrapReferenceRewrite(deps.applyReferenceRewrite, tracker, recordPatchPostWrite)
      : undefined,
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
  /** sha256 of the source content captured at backup time — the pre-apply
   *  staleness check re-verifies the source against this before any write. */
  sourceSha: string
}

/**
 * Snapshot `source` into `<source>.bak.<stamp>[.<seq>]`. The write is an
 * exclusive O_EXCL claim followed by an atomic tmp+rename (mode preserved from
 * the source), so a crash leaves either no backup or a complete one, and two
 * same-second racers get distinct sequence suffixes instead of one clobbering
 * the other. Returns the record with the source hash for the staleness check.
 */
async function backupFile(
  deps: OneShotDeps,
  source: string,
  stamp: string,
  dirPath: string,
  pattern: RegExp,
): Promise<BackupRecord> {
  let text: string
  let mode: number | undefined
  try {
    text = await deps.fs.readFile(source)
    mode = (await deps.fs.stat(source))?.mode
  } catch (err) {
    throw new Error(`backup failed for ${source}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const base = `${source}.bak.${stamp}`
  const backupPath = await writeExclusiveBackup(deps.fs, base, text, mode)
  await pruneBackups(deps.fs, dirPath, pattern)
  return { source, backup: backupPath, sourceSha: sha256Of(text) }
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

const CONFIRM_QUESTION_ID = 'migrate-go-confirm'
const CONFIRM_PROCEED = '执行迁移'
const CONFIRM_CANCEL = '取消'

/**
 * Slot summary INCLUDING the route field values (api/baseURL, review M8) —
 * the user approves the exact endpoints, not just route names.
 */
function slotSummary(plan: MigrationPlan): string {
  const slots = (['chat', 'msg', 'resp', 'google'] as GoRouteSlot[])
    .map((slot) => ({ slot, route: plan.routes.find((candidate) => candidate.slot === slot) }))
    .filter((item): item is { slot: GoRouteSlot; route: MigrationPlan['routes'][number] } => item.route !== undefined)
    .map((item) => `${item.slot}→${item.route.route} (${item.route.fields.api}, ${item.route.fields.baseURL})`)
  return slots.length > 0 ? slots.join('、') : '(no route changes)'
}

/**
 * Compact before→after for one `update` row (review M8): only the fields
 * that actually differ, JSON-encoded values, capped so the dialog stays
 * readable. Empty string when the profiles cannot be compared.
 */
function compactProfileDiff(before: unknown, after: unknown): string {
  if (before === null || typeof before !== 'object' || after === null || typeof after !== 'object') return ''
  const b = before as Record<string, unknown>
  const a = after as Record<string, unknown>
  const parts: string[] = []
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort((x, y) => x.localeCompare(y))) {
    const bv = JSON.stringify(b[key] ?? null)
    const av = JSON.stringify(a[key] ?? null)
    if (bv !== av) parts.push(`${key}: ${bv} → ${av}`)
  }
  const joined = parts.join('; ')
  return joined.length > 240 ? `${joined.slice(0, 240)}…` : joined
}

/**
 * The per-id action rows for the confirmation question (review Major 3: the
 * dialog must not stop at +n/-n counts — every add/move/update/delete id is
 * listed, and ids deleted as user-written or unknown/retired carry their kind
 * so the user sees exactly which handwritten models `--adopt`/
 * `--prune-user-extra` will remove). Review M8: every row carries its plan
 * reason and `update` rows show the before→after diff. Compact: adds and
 * deletes group onto one line per route (distinct reasons joined); moves and
 * updates are one line each.
 */
function perIdActionLines(plan: MigrationPlan): string[] {
  const groupByRoute = (op: MigrationIdPlan['op']): Map<string, { labels: string[]; reasons: string[] }> => {
    const grouped = new Map<string, { labels: string[]; reasons: string[] }>()
    for (const action of plan.idActions) {
      if (action.op !== op) continue
      const label = op === 'delete' && (action.kind === 'user-extra' || action.kind === 'unknown-retired')
        ? `${action.id}（${action.kind === 'user-extra' ? '用户手写' : '未知/已下架'}）`
        : action.id
      const bucket = grouped.get(action.route) ?? { labels: [], reasons: [] }
      bucket.labels.push(label)
      if (!bucket.reasons.includes(action.reason)) bucket.reasons.push(action.reason)
      grouped.set(action.route, bucket)
    }
    return grouped
  }
  const lines: string[] = []
  for (const [route, group] of groupByRoute('add')) {
    lines.push(`    + 新增 → ${route}: ${group.labels.join(', ')}（${group.reasons.join(' / ')}）`)
  }
  for (const action of plan.idActions) {
    if (action.op === 'move') {
      lines.push(`    ~ 移动 ${action.id}: ${action.route} → ${action.to ?? action.route}（${action.reason}）`)
    }
  }
  for (const action of plan.idActions) {
    if (action.op !== 'update') continue
    // `update` rows are report-only drift (apply never overwrites a
    // user-modified profile) — the dialog shows the drift it promises to show.
    const diff = compactProfileDiff(action.before, action.profile)
    lines.push(`    ~ 更新 → ${action.route}: ${action.id}${diff !== '' ? ` ${diff}` : ''}（${action.reason}）`)
  }
  for (const [route, group] of groupByRoute('delete')) {
    lines.push(`    - 删除 → ${route}: ${group.labels.join(', ')}（${group.reasons.join(' / ')}）`)
  }
  return lines
}

function buildConfirmQuestion(stamp: string, prepared: PreparedTarget[], modelsStoreBackup: string | undefined, rewriteRefs: RewriteRefMode): AskItemShape {
  const lines: string[] = []
  lines.push('即将执行 opencode-go 一键迁移（写入前最后确认）。')
  lines.push('')
  lines.push('【旧条目删除/重写（legacy 残桩 → 托管槽位）】')
  for (const item of prepared) {
    for (const stub of item.stubs) {
      lines.push(`  - [${item.target.key}] ${stub.route}（手写模型 ${stub.ids.length} 个: ${stub.ids.join(', ') || '无'}）`)
    }
  }
  lines.push('')
  lines.push('【逐 id 动作（保留项从略；每行附 plan 原因）】')
  for (const item of prepared) {
    const add = item.plan.idActions.filter((action) => action.op === 'add' || action.op === 'move').length
    const del = item.plan.idActions.filter((action) => action.op === 'delete').length
    const upd = item.plan.idActions.filter((action) => action.op === 'update').length
    const keep = item.plan.idActions.filter((action) => action.op === 'keep').length
    lines.push(`  [${item.target.key}] +${add} 新增/移动、${upd} 更新（不改写）、${del} 删除、${keep} 保留；planHash ${item.plan.planHash.slice(0, 12)}…`)
    const rows = perIdActionLines(item.plan)
    lines.push(...(rows.length > 0 ? rows : ['    （无新增/移动/更新/删除）']))
  }
  lines.push('')
  // The B6 managed-after notice, VERBATIM from the plan it belongs to (it is
  // hashed into planHash, so this text and the applied plan cannot drift
  // apart): `ackManaged: true` is the user's own informed answer to exactly
  // this text, never a code-signed claim.
  lines.push('【托管后告知（逐 profile，取自该 profile 的迁移计划）】')
  for (const item of prepared) {
    lines.push(`  [${item.target.key}]`)
    for (const line of item.plan.managedAfterMigration.split('\n')) lines.push(`    ${line}`)
  }
  lines.push('')
  lines.push(`【槽位】${slotSummary(prepared[0]!.plan)}（按 opencode.go.routes 配置；未配置的槽不创建，google 缺省不建）`)
  lines.push('')
  // Review M8 (the most important item): with --rewrite-refs in effect, the
  // user must SEE the exact references apply is about to rewrite, before →
  // after. Sessions are always report-only and never appear as rewrite rows.
  if (rewriteRefs !== 'none') {
    lines.push(`【引用改写（--rewrite-refs=${rewriteRefs} 生效；apply 成功后执行）】`)
    const seen = new Set<string>()
    let shown = 0
    for (const item of prepared) {
      for (const ref of item.plan.references) {
        if (!ref.verified || !ref.rewritable || ref.reportOnly) continue
        const dedupe = `${ref.surface}|${ref.before}|${ref.after}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        lines.push(`  - ${ref.surface}: ${ref.before} → ${ref.after}`)
        shown += 1
      }
    }
    if (shown === 0) lines.push('  （没有已验证、可改写的引用）')
    lines.push('  会话内历史引用只报告，永不改写。')
    lines.push('')
  }
  lines.push('【备份文件（失败即字节恢复）】')
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
// Restore helpers — guarded: never clobber a concurrent modification
// ---------------------------------------------------------------------------

interface RestoreOutcome {
  line: string
  /** True only when the file was actually replaced/removed. */
  restored: boolean
}

/**
 * Restore one changed patch file from its backup, but ONLY while the on-disk
 * content still hashes to the post-write baseline this run recorded right
 * after its last write. Anything else means another process touched the file
 * after us: never overwrite it — report "concurrent modification detected,
 * not restored" with the backup path so a human can decide. The write itself
 * goes through the SAME atomic io (tmp + rename, mode preserved) the apply
 * used — never a raw writeFile.
 */
export async function restorePatchIfUnchanged(
  deps: OneShotDeps,
  record: BackupRecord,
  postWriteSha: string | undefined,
): Promise<RestoreOutcome> {
  let currentSha: string | undefined
  try {
    currentSha = sha256Of(await deps.fs.readFile(record.source))
  } catch {
    currentSha = undefined
  }
  if (postWriteSha === undefined || currentSha === undefined || currentSha !== postWriteSha) {
    return {
      restored: false,
      line: `concurrent modification detected, not restored: ${record.source} (backup: ${record.backup}) — 人工核对后处理`,
    }
  }
  const backupText = await deps.fs.readFile(record.backup)
  await deps.patchIoFor(record.source).writeAtomic(backupText)
  return { restored: true, line: `restored ${record.source} ← ${record.backup}` }
}

/**
 * Remove a models-store this run CREATED, but only while its content still
 * matches this run's post-write baseline; a store another process has touched
 * since is left in place and reported for manual handling.
 */
export async function removeStoreIfUnchanged(deps: OneShotDeps, postWriteSha: string | undefined): Promise<RestoreOutcome> {
  let currentSha: string | undefined
  try {
    currentSha = sha256Of(await deps.fs.readFile(deps.modelsStorePath))
  } catch {
    currentSha = undefined
  }
  if (postWriteSha === undefined || currentSha === undefined || currentSha !== postWriteSha) {
    return {
      restored: false,
      line: `concurrent modification detected, not restored: ${deps.modelsStorePath} (created by this run, changed since) — 人工核对后处理`,
    }
  }
  await deps.fs.unlink(deps.modelsStorePath)
  return { restored: true, line: `removed ${deps.modelsStorePath} (created by this run)` }
}

/**
 * Restore the models-store from its backup through the remote-catalog store
 * accessor — the SAME promise queue + cross-process lock every other
 * models-store writer uses — instead of overwriting the file behind its back.
 * Review M5: the restore is a whole-document BYTE replacement
 * (`restoreRawDocument`: exact backup bytes staged via tmp + rename under the
 * lock), not a per-key rebuild — the backup's key order survives verbatim and
 * the restore is transactional. The same post-write-baseline check as the
 * patch restore applies first, and a backup that is not valid JSON refuses
 * loudly before anything is touched. Round 3: the baseline is ALSO
 * re-verified INSIDE the store's queue + cross-process lock (the accessor's
 * `expectedCurrentSha`), so a writer that landed between the pre-lock check
 * and the restore is refused at the write site and reported as concurrent
 * modification instead of clobbering the foreign bytes.
 */
export async function restoreModelsStoreIfUnchanged(
  deps: OneShotDeps,
  backupPath: string,
  postWriteSha: string | undefined,
): Promise<RestoreOutcome> {
  let currentSha: string | undefined
  try {
    currentSha = sha256Of(await deps.fs.readFile(deps.modelsStorePath))
  } catch {
    currentSha = undefined
  }
  if (postWriteSha === undefined || currentSha === undefined || currentSha !== postWriteSha) {
    return {
      restored: false,
      line: `concurrent modification detected, not restored: ${deps.modelsStorePath} (backup: ${backupPath}) — 人工核对后处理`,
    }
  }
  const backupText = await deps.fs.readFile(backupPath)
  try {
    JSON.parse(backupText) as Record<string, unknown>
  } catch (err) {
    throw new Error(`backup is not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  const accessor = loadModelsStore(deps.modelsStorePath)
  try {
    // The pre-lock check above is advisory (it can only narrow the window);
    // the authoritative re-verify runs inside the lock via expectedCurrentSha.
    await accessor.restoreRawDocument(backupText, postWriteSha)
  } catch (err) {
    if ((err as { code?: unknown }).code === STORE_RESTORE_SHA_MISMATCH) {
      return {
        restored: false,
        line: `concurrent modification detected, not restored: ${deps.modelsStorePath} (backup: ${backupPath}) — 人工核对后处理`,
      }
    }
    throw err
  }
  return { restored: true, line: `restored ${deps.modelsStorePath} ← ${backupPath} (byte-exact via models-store lock accessor)` }
}

/**
 * Re-hash every target's patch file and drop the ones whose content changed
 * after their backup was taken (the backup → apply window, review Major 2
 * item 3): a plan computed from stale bytes is never applied, and a dropped
 * target writes nothing.
 */
export async function dropStaleTargets(
  deps: OneShotDeps,
  prepared: readonly PreparedTarget[],
): Promise<{ ready: PreparedTarget[]; stale: { key: string; patchPath: string }[] }> {
  const ready: PreparedTarget[] = []
  const stale: { key: string; patchPath: string }[] = []
  for (const item of prepared) {
    let currentSha: string | undefined
    try {
      currentSha = sha256Of(await deps.fs.readFile(item.target.patchPath))
    } catch {
      currentSha = undefined
    }
    if (currentSha !== item.patchBackup.sourceSha) stale.push({ key: item.target.key, patchPath: item.target.patchPath })
    else ready.push(item)
  }
  return { ready, stale }
}

export type StoreFreshness = { ok: true } | { ok: false; reason: string }

/**
 * Verify the shared models-store has not drifted inside the backup → apply
 * window: with a backup, its content must still hash to the backup-time
 * value; without one (the file did not exist at backup time), it must still
 * not exist — a store another process created meanwhile must never end up
 * deleted by this run's rollback path.
 */
export async function verifyStoreFreshness(
  deps: OneShotDeps,
  modelsStoreBackup: string | undefined,
  storeSourceSha: string | undefined,
  storeExistedBefore: boolean,
): Promise<StoreFreshness> {
  const rerunHint = '请重跑 /model-sync migrate-go 以基于最新内容重新规划。'
  if (modelsStoreBackup !== undefined) {
    let shaNow: string | undefined
    try {
      shaNow = sha256Of(await deps.fs.readFile(deps.modelsStorePath))
    } catch {
      shaNow = undefined
    }
    if (shaNow !== storeSourceSha) {
      return {
        ok: false,
        reason: `${deps.modelsStorePath} changed after its backup was taken; aborted with zero writes.\n备份仍在（人工核对可用）: ${modelsStoreBackup}\n${rerunHint}`,
      }
    }
    return { ok: true }
  }
  if (!storeExistedBefore) {
    let existsNow = false
    try {
      await deps.fs.readFile(deps.modelsStorePath)
      existsNow = true
    } catch {
      existsNow = false
    }
    if (existsNow) {
      return { ok: false, reason: `${deps.modelsStorePath} was created by another process after this run started; aborted with zero writes.\n${rerunHint}` }
    }
  }
  return { ok: true }
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
      prepared.push({ target, plan, migrateDeps, tracker, stubs: target.stubs, patchBackup: { source: '', backup: '', sourceSha: '' } })
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
    let storeSourceSha: string | undefined
    let storeExistedBefore = false
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
      storeExistedBefore = storeText !== undefined
      if (storeText !== undefined) {
        const base = `${deps.modelsStorePath}.bak.${stamp}`
        const homeDir = deps.home
        const storeMode = (await deps.fs.stat(deps.modelsStorePath))?.mode
        const backupPath = await writeExclusiveBackup(deps.fs, base, storeText, storeMode)
        modelsStoreBackup = backupPath
        storeSourceSha = sha256Of(storeText)
        note(`backup: ${deps.modelsStorePath} → ${backupPath}`)
        await pruneBackups(deps.fs, homeDir, STORE_BACKUP_PATTERN)
      }
    } catch (err) {
      return { kind: 'error', text: `migrate-go: ${err instanceof Error ? err.message : String(err)}; zero writes` }
    }

    // ---- d2. staleness re-verify (the backup → apply window) --------------
    const { ready, stale } = await dropStaleTargets(deps, prepared)
    for (const item of stale) {
      note(`stale: [${item.key}] ${item.patchPath} changed after its backup was taken; target aborted (zero writes)`)
    }
    if (ready.length === 0) {
      return {
        kind: 'success',
        text: [
          'migrate-go: nothing to apply — every target changed after its backup was taken; zero writes.',
          '请重跑 /model-sync migrate-go 以基于最新内容重新规划。',
          ...patchBackups.map((record) => `  backup kept: ${record.backup}`),
        ].join('\n'),
      }
    }
    const storeFresh = await verifyStoreFreshness(deps, modelsStoreBackup, storeSourceSha, storeExistedBefore)
    if (!storeFresh.ok) {
      note(`stale: ${storeFresh.reason.split('\n')[0]}`)
      return { kind: 'error', text: `migrate-go: ${storeFresh.reason}` }
    }

    // ---- e. ONE confirmation (fail closed without the channel) ------------
    const ask = deps.resolveAsk()
    if (ask === undefined || typeof ask.ask !== 'function') {
      return { kind: 'error', text: failClosedConfirmMessage('userQuestions 服务缺失（NO_PROVIDER / 未注册）', ready) }
    }
    let answers: { answers?: AskAnswerItemShape[] }
    try {
      answers = await ask.ask({
        questions: [buildConfirmQuestion(stamp, ready, modelsStoreBackup, flags.rewriteRefs)],
        ...(invocation.agent === undefined ? {} : { agent: invocation.agent }),
        ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
      })
    } catch (err) {
      const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code?: unknown }).code as string : undefined
      const reason = err instanceof Error ? `${err.message}${code !== undefined ? ` [${code}]` : ''}` : String(err)
      note(`confirm failed: ${reason}`)
      return { kind: 'error', text: failClosedConfirmMessage(reason, ready) }
    }
    const backupListLines = (): string[] =>
      [...patchBackups.map((record) => record.backup), ...(modelsStoreBackup !== undefined ? [modelsStoreBackup] : [])]
        .map((path) => `  ${path}`)
    const answer = (answers.answers ?? []).find((item) => item.id === CONFIRM_QUESTION_ID)
    const selected = answer?.selected ?? []
    // Abort defense in depth (review Minor 5): the ask seam can return after
    // the invocation was already aborted — re-check here and treat it as a
    // cancel, zero writes.
    if (invocation.signal?.aborted === true) {
      note('confirm: aborted (signal aborted when ask returned)')
      return {
        kind: 'success',
        text: ['migrate-go: 确认请求已中止（signal aborted）——按取消处理，零写入。', '本轮备份已生成（保留，可手动删除）:', ...backupListLines()].join('\n'),
      }
    }
    const choseProceed = selected.includes(CONFIRM_PROCEED)
    const choseCancel = selected.includes(CONFIRM_CANCEL)
    if (!choseProceed || choseCancel) {
      // Blank/skip and an answer carrying BOTH labels are ambiguous: cancel
      // and ask the user to rerun — proceed never wins a contested answer.
      const ambiguous = choseProceed && choseCancel
      note(ambiguous ? 'confirm: ambiguous (both labels selected)' : 'confirm: cancelled / blank')
      return {
        kind: 'success',
        text: [
          ambiguous
            ? 'migrate-go: 两个选项同时被选中，答案有歧义——按取消处理，零写入。请重跑后再确认。'
            : 'migrate-go: 已取消——零写入。',
          '本轮备份已生成（保留，可手动删除）:',
          ...backupListLines(),
        ].join('\n'),
      }
    }
    note('confirm: approved')

    // ---- f. apply (existing engine; consent triple computed HERE) ---------
    const applied: PreparedTarget[] = []
    const changedPatches: { backup: BackupRecord; isCurrent: boolean; tracker: ChangeTracker }[] = []
    let modelsStoreChanged = false
    let modelsStoreCreated = false
    let storePostWriteSha: string | undefined
    let failure: { target: Target; detail: string } | undefined
    for (const item of ready) {
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
      if (item.tracker.patchChanged === true) {
        changedPatches.push({ backup: item.patchBackup, isCurrent: item.target.isCurrent, tracker: item.tracker })
      }
      if (item.tracker.storeChanged === true) {
        modelsStoreChanged = true
        // The store backup only exists when the file pre-dated the run; a
        // store created by this run is restored by removing it again.
        modelsStoreCreated ||= modelsStoreBackup === undefined
        // Baseline the store's post-write bytes (read right after the write
        // through the lock accessor) for the restore path's content check.
        try {
          storePostWriteSha = sha256Of(await deps.fs.readFile(deps.modelsStorePath))
        } catch {
          storePostWriteSha = undefined
        }
      }
      for (const line of (resultText ?? '').split('\n')) note(`[${item.target.key}] apply: ${line}`)
      if (!resultOk) {
        failure = { target: item.target, detail: resultText ?? 'unknown apply failure' }
        break
      }
      applied.push(item)
    }

    // ---- atomicity: restore everything this run changed -------------------
    if (failure !== undefined) {
      const restore: string[] = []
      let restoredHostSeamProfile = false
      for (const changed of [...changedPatches].reverse()) {
        try {
          const outcome = await restorePatchIfUnchanged(deps, changed.backup, changed.tracker.patchPostWriteSha)
          restore.push(outcome.line)
          restoredHostSeamProfile ||= outcome.restored && changed.isCurrent
        } catch (err) {
          restore.push(`RESTORE FAILED for ${changed.backup.source}: ${err instanceof Error ? err.message : String(err)} (backup: ${changed.backup.backup})`)
        }
      }
      if (modelsStoreCreated) {
        try {
          const outcome = await removeStoreIfUnchanged(deps, storePostWriteSha)
          restore.push(outcome.line)
        } catch (err) {
          restore.push(`RESTORE FAILED for ${deps.modelsStorePath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (modelsStoreChanged && modelsStoreBackup !== undefined) {
        try {
          const outcome = await restoreModelsStoreIfUnchanged(deps, modelsStoreBackup, storePostWriteSha)
          restore.push(outcome.line)
        } catch (err) {
          restore.push(`RESTORE FAILED for ${deps.modelsStorePath}: ${err instanceof Error ? err.message : String(err)} (backup: ${modelsStoreBackup})`)
        }
      }
      const text = [
        `migrate-go: FAILED at apply for [${failure.target.key}] — 已停止，改动文件按本轮备份恢复（逐文件核对结果见下）。`,
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

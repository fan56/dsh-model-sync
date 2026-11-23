// P1b writer: the one layer that turns an opencode-go route plan into real
// settings writes for the user's profile.
//
// Hard boundary: this module owns the ONLY settings write path for the three
// go routes. It never schedules timers, never fetches, never touches
// credentials, and never edits a patch/doc file directly — every settings
// change goes through `settings.mutate('llm-pi-ai', ops, revision)` (design C6).
// The ownership ledger is persisted through an injected store seam so tests
// can run entirely in memory (no real ~/.dsh). The concrete store-v2 adapter
// (design §6.1) is supplied by the caller when this layer is wired up; wiring
// into the plugin commands/scheduler is deliberately a separate step.
//
// Design refs: §6.1 (ledger key + preManagedSnapshot), §6.2.4 (ownership-aware
// merge, double confirmation), §6.2.5 (route-field ownership), §9.1 (one
// mutate per route), §9.4 (empty route → unset, never `models: []`),
// ADR-004, V5/V9/V13. Rollback lives in opencode-go-migrate.ts.

import type { SettingsModelProfile } from './translate.ts'
import type { GoRouteSlot } from './opencode-go-grouping.ts'
import {
  goOwnershipKey,
  profileHash,
  type GoManagedModel,
  type GoOwnershipEntry,
  type GoPlanReportEntry,
  type GoPlanResult,
  type GoPlannedRoute,
} from './opencode-go-planner.ts'
import {
  profilesEqual,
  type Logger,
  type SettingsDescriptor,
  type SettingsMutationOp,
  type SettingsService,
} from './writer.ts'
import {
  goJournalKey,
  journalContentHash,
  type GoJournalStore,
  type GoWriteJournal,
} from './opencode-go-journal.ts'
import { fingerprintSection } from './opencode-go-migration.ts'

const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'
// O1-minimal: `displayName` is a display field, NOT an identity/ownership field.
// It is deliberately kept out of this set so it matches the planner's
// OWNERSHIP_FIELDS (detectConflict), which never checks it. A display-name-only
// upstream change must not make the writer rewrite the route's identity fields.
const OWNED_FIELDS = ['api', 'baseURL', 'apiKeyEnv'] as const

// O1-minimal: a settings.mutate can land while the ledger/record write after it
// fails. That route is NOT a clean success (no ledger => next round keeps it as
// user-owned) and NOT a lock-only failure either (retrying does nothing). Report
// it truthfully with its own code + reason + actionable advice.
const UNACCOUNTED_CODE = 'settings-written-unaccounted'
// O1 residual: once settings landed, "the store was NOT modified / retry the
// operation" is a lie — the store that failed is the ledger, not settings, and
// a retry cannot re-claim the route. State the real consequence and recovery.
const UNACCOUNTED_ADVICE = 'settings were written but the ownership ledger was not updated; retrying cannot re-claim the route; the next round reconciles the write-ahead journal (otherwise keeps this route as user-owned: no refresh, no deletion); re-claim it with `/model-sync adopt go`'
// Settings + ledger landed, but the migration record persist failed (S1).
// This is not a failed route (fingerprint-healed next round), but it must not
// be silent: the next round may see the route as un-migrated and close the gate.
const RECORD_ADVICE = 'settings and the ownership ledger landed but the migration record could not be persisted; the next round reconciles the write-ahead journal or self-heals via fingerprint-healed, do not simply retry; re-claim it with `/model-sync adopt go`'

// ---------------------------------------------------------------------------
// Injected seams
// ---------------------------------------------------------------------------

/**
 * Ownership ledger store (store v2 in design §6.1). Entries are keyed by
 * `<route>#<keyFingerprint>`, so one route's ledger is invisible under a
 * different key. All methods are async so a file-backed adapter can be used
 * in production while tests stay in memory.
 */
export interface GoOwnershipStore {
  read(key: string): Promise<GoOwnershipEntry | undefined>
  write(key: string, entry: GoOwnershipEntry): Promise<void>
  delete(key: string): Promise<void>
}

/** Minimal models-store seam for store-first `modelOverrides` staging (§6.2.4). */
export interface GoOverrideStorer {
  read?(route: string): Promise<{ overrides?: Record<string, Record<string, unknown>> } | undefined>
  updateOverrides(route: string, overrides: Record<string, Record<string, unknown>>): Promise<void>
}

export interface GoWriterDeps {
  settings: SettingsService | undefined
  ownershipStore: GoOwnershipStore
  logger: Logger
  /** sha256(key) prefix from the source result; `-` when no key. */
  keyFingerprint: string
  /** go.confirmRemovals; default 2 (schema min 2, design §6.2.6). */
  confirmRemovals?: number
  /**
   * go.adoptExisting / `/model-sync adopt go` (design §14.1). With no prior
   * ledger the writer claims only desired∩current by default; adopt also
   * claims the route's pre-existing models so they become deletion candidates
   * on later rounds (still subject to the two-round confirmation + 3 gates).
   */
  adoptExisting?: boolean
  /** Optional models-store seam for override fold + unset (store-first). */
  overrideStorer?: GoOverrideStorer
  /**
   * B4/N1 fail-closed guard: the llm-pi-ai revision the plan was built against
   * (the fetch-time / post-validation revision). The writer re-reads the
   * descriptor before ANY settings mutate or ledger commit; if the revision
   * moved since the round was validated, the plan is stale and the WHOLE round
   * is abandoned (zero writes, no ledger/fingerprint). Omitted only by pure
   * unit writers that do not have a round-level revision to validate.
   */
  expectedRevision?: number
  /**
   * §14.7.5 second gate: called immediately before EACH mutate (and again on a
   * SETTINGS_CONFLICT retry). Must re-read the persisted migration status —
   * never reuse the round-level snapshot. A false result leaves the route
   * untouched (including the ledger); `reason: 'canWrite-unavailable'` is
   * reported when the status re-read itself failed (fail closed). Absent means
   * no second gate (pure unit writers). A plain boolean is accepted for tests.
   */
  canWrite?: (route: string) =>
    | boolean
    | GoCanWriteDecision
    | Promise<boolean>
    | Promise<GoCanWriteDecision>
  /**
   * §14.7.4: called ONLY after a route's settings.mutate AND its ledger commit
   * both succeeded, with the ledger-managed ids just committed. The callback
   * re-persists `appliedFingerprint` through the same store queue. Never called
   * for a failed write, a no-change round, or another writer's no-op success.
   */
  onOwnWrite?: (route: string, managedIds: string[]) => Promise<void> | void
  /**
   * O1/C2: write-ahead journal store. When present together with `profileKey`,
   * each settings mutate is preceded by a journal slot recording the intended
   * ledger entry + the post-write content hash; it is removed only after the
   * ledger AND migration record both landed. The next round reconciles any
   * surviving journal before the migration gate. Omitted by pure unit writers
   * (no file-backed store) — those keep the pre-C2 behavior.
   */
  journalStore?: GoJournalStore
  /** O1/C2: stable profile key for the journal slot (must match reconciliation). */
  profileKey?: string
  /** O1/C2: injectable clock for the journal timestamp; defaults to Date.now. */
  now?: () => number
}

export interface GoCanWriteDecision {
  allow: boolean
  /** `canWrite-unavailable` when the live status re-read failed. */
  reason?: string
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GoRouteStatus = 'wrote' | 'no-change' | 'unset' | 'skipped' | 'conflict' | 'failed'

export interface GoRouteWriteStatus {
  route: string
  slot?: GoRouteSlot
  status: GoRouteStatus
  reason?: string
}

export interface GoWriteResult {
  /** One entry per planned route, plus one per conflicted route. */
  routes: GoRouteWriteStatus[]
  /** Routes whose settings.mutate resolved (wrote or unset). */
  writtenRoutes: string[]
  /** Routes whose mutate failed, with an honest reason. */
  failedRoutes: { route: string; reason: string }[]
  /**
   * O1-minimal: routes whose settings.mutate landed this round, whether or not
   * the ledger commit after it succeeded. Used for an honest N1-abandon report
   * (a route may have been written before the round was abandoned).
   */
  settingsLandedRoutes: string[]
  /**
   * B4/N1: set when the round was abandoned because the host settings revision
   * moved mid-round. The caller must report this as
   * `settings-changed-during-sync` and treat the round as a zero-write no-op.
   */
  settingsChanged?: { expectedRevision: number | undefined; actualRevision: number }
  /** Planner report adjusted by writer decisions + `moved` association. */
  report: GoPlanReportEntry[]
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function findLlmDescriptor(settings: SettingsService): SettingsDescriptor | undefined {
  return settings.describe().find((desc) => desc.ns === 'llm-pi-ai')
}

function rawRoute(desc: SettingsDescriptor | undefined, route: string): Record<string, unknown> | undefined {
  if (desc === undefined) return undefined
  const providers = desc.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const data = providers[route]
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  return data as Record<string, unknown>
}

function rawModels(desc: SettingsDescriptor | undefined, route: string): SettingsModelProfile[] {
  const models = rawRoute(desc, route)?.models
  return Array.isArray(models) ? (models as SettingsModelProfile[]) : []
}

function sortedModels(models: readonly SettingsModelProfile[]): SettingsModelProfile[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id))
}

function rawOverrides(
  desc: SettingsDescriptor | undefined,
  route: string,
): Record<string, Record<string, unknown>> | undefined {
  const value = rawRoute(desc, route)?.modelOverrides
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const overrides = value as Record<string, Record<string, unknown>>
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

/** Fold user `modelOverrides` into the target, override wins per field. */
function mergeOverrides(
  target: readonly SettingsModelProfile[],
  overrides: Record<string, Record<string, unknown>> | undefined,
): SettingsModelProfile[] {
  if (overrides === undefined) return [...target]
  return target.map((entry) => {
    const override = overrides[entry.id]
    if (override === undefined) return entry
    return { ...entry, ...override, id: entry.id } as SettingsModelProfile
  })
}

/** Error code on a revision mismatch (matches writer.ts's contract). */
function isConflictError(err: unknown): boolean {
  return (err as Record<string, unknown> | undefined)?.code === SETTINGS_CONFLICT
}

function errorText(err: unknown): string {
  // Prefer a structured `message` so re-wrapped plain-object errors still carry
  // the actionable text (lock path / retry advice) instead of "[object Object]".
  // Error instances already expose `message`; everything else falls back to
  // String(err) exactly as before.
  const message = (err as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(err)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Clone a JSON-ish settings value without relying on host-specific prototypes. */
function cloneSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSettingsValue)
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) out[key] = cloneSettingsValue(nested)
    return out
  }
  return value
}

/**
 * The exact `user` object this writer's ops would leave behind. Used only to
 * hash the expected post-mutate content in the N1 residual-window check; it
 * never writes settings. General `providers.*` path handling keeps a future op
 * from silently escaping the check.
 */
function expectedUserAfterOps(
  user: Record<string, unknown> | undefined,
  ops: readonly SettingsMutationOp[],
): Record<string, unknown> {
  const out = isPlainRecord(user) ? cloneSettingsValue(user) as Record<string, unknown> : {}
  for (const op of ops) {
    const [section, route, field, ...rest] = op.path
    if (section !== 'providers' || route === undefined || rest.length > 0) continue
    const providers = isPlainRecord(out.providers) ? out.providers as Record<string, unknown> : {}
    out.providers = providers
    if (field === undefined) {
      if (op.op === 'unset') delete providers[route]
      else providers[route] = cloneSettingsValue(op.value)
      continue
    }
    const base = isPlainRecord(providers[route]) ? providers[route] as Record<string, unknown> : {}
    providers[route] = base
    if (op.op === 'unset') delete base[field]
    else base[field] = cloneSettingsValue(op.value)
  }
  return out
}

/**
 * O1 residual: a settings-landed ledger timeout must not repeat the stock
 * "store NOT modified / retry" claim. Keep the lock diagnostics (path, wait,
 * stale-lock note) but drop those two false sentences. A final guard covers
 * re-wrapped errors whose wording differs from the stock seam.
 */
function truthfulLockDetail(detail: string): string {
  const cleaned = detail
    .replace(/The store was NOT modified\.?\s*/gi, '')
    .replace(/Retry the operation\s*[;,.]\s*/gi, '')
    .replace(/if it keeps failing, check other running dsh processes(?: for a stalled sync round holding the lock)?\.?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return /not modified|retry the operation/i.test(cleaned)
    ? 'lock error detail contained misleading retry advice (the ownership ledger store was not written; see the actionable note below)'
    : cleaned
}

/** Structural check for a store lock timeout (survives re-wrapping / module boundaries). */
function isStoreLockTimeout(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const value = err as { code?: unknown; name?: unknown }
  return value.code === 'DSH_STORE_LOCK_TIMEOUT' || value.name === 'StoreLockTimeoutError'
}

/**
 * Record a route whose write hit a store lock timeout. The original error
 * message carries the lock path and the retry / check-other-processes advice:
 * keep it verbatim in the report and in the failed-route reason so the user
 * sees an actionable cause instead of a generic failure. The route is marked
 * `failed` and deliberately NOT added to `writtenRoutes`.
 *
 * O1-minimal: when `settingsLanded` is true the timeout happened on the ledger
 * AFTER settings were written. The stock "The store was NOT modified. Retry the
 * operation" text is then misleading (retry will not re-claim the route), so
 * the report uses the truthful `settings-written-unaccounted` code, strips those
 * two false sentences from the detail, and carries the real advice. The zero-
 * write path keeps the original detail verbatim for diagnosis.
 */
function recordLockTimeout(
  result: GoWriteResult,
  report: GoPlanReportEntry[],
  planned: GoPlannedRoute,
  err: unknown,
  phase: string,
  settingsLanded = false,
): void {
  const reason = settingsLanded ? UNACCOUNTED_CODE : 'store-lock-timeout'
  const detail = settingsLanded ? truthfulLockDetail(errorText(err)) : errorText(err)
  result.routes.push({ route: planned.route, slot: planned.slot, status: 'failed', reason })
  result.failedRoutes.push({ route: planned.route, reason })
  report.push({
    level: 'error',
    code: reason,
    route: planned.route,
    slot: planned.slot,
    message: settingsLanded
      ? `route ${planned.route} ${phase} hit a store lock timeout after settings were written: ${detail}. ${UNACCOUNTED_ADVICE}`
      : `route ${planned.route} ${phase} hit a store lock timeout: ${detail}`,
  })
}

/** Outcome of a ledger commit: `lockTimeout` is the original error when it was a lock wait timeout. */
interface LedgerCommitResult {
  committed: boolean
  lockTimeout?: unknown
}

/** Normalize the second-gate seam (boolean shorthand or structured decision). */
async function canWriteDecision(deps: GoWriterDeps, route: string): Promise<GoCanWriteDecision | undefined> {
  if (deps.canWrite === undefined) return undefined
  const raw = await deps.canWrite(route)
  return typeof raw === 'boolean' ? { allow: raw } : raw
}

/** Non-silent skip for a route whose authority was revoked before its mutate. */
function skipByCanWrite(
  result: GoWriteResult,
  report: GoPlanReportEntry[],
  planned: GoPlannedRoute,
  decision: GoCanWriteDecision,
): void {
  const reason = decision.reason ?? 'route-authority'
  result.routes.push({ route: planned.route, slot: planned.slot, status: 'skipped', reason })
  report.push({
    level: decision.reason === 'canWrite-unavailable' ? 'warn' : 'info',
    code: decision.reason === 'canWrite-unavailable' ? 'canWrite-unavailable' : 'skipped-route-owner',
    route: planned.route,
    slot: planned.slot,
    message: `route ${planned.route} skipped by routeWriter (${reason}); no settings write`,
  })
}

/**
 * §14.7.4: persist the new applied fingerprint only after settings+ledger
 * success. Returns true only when the record is actually persisted (or there
 * is nothing to persist) — C2 keeps the journal open on false so the next
 * round can re-persist it instead of silently closing the migration gate.
 */
async function recordOwnWrite(
  deps: GoWriterDeps,
  route: string,
  managedIds: string[],
  report: GoPlanReportEntry[],
): Promise<boolean> {
  if (deps.onOwnWrite === undefined) return true
  try {
    await deps.onOwnWrite(route, managedIds)
    return true
  } catch (err) {
    if (isStoreLockTimeout(err)) {
      // Settings + ledger already landed, so this is not a failed route, but a
      // lock timeout here must still be visible with its actionable message.
      deps.logger.warn('appliedFingerprint lock timeout for %s: %s', route, errorText(err))
      report.push({
        level: 'warn',
        code: UNACCOUNTED_CODE,
        route,
        message: `route ${route} appliedFingerprint re-persist hit a store lock timeout: ${truthfulLockDetail(errorText(err))}. ${RECORD_ADVICE}`,
      })
      return false
    }
    // Settings + ledger already landed; a failed fingerprint write is healed at
    // the next round (§14.7.4 fingerprint-healed), never a failed route. O1:
    // still report it truthfully instead of leaving the record gap silent.
    deps.logger.warn('appliedFingerprint update failed for %s: %s', route, errorText(err))
    report.push({
      level: 'warn',
      code: UNACCOUNTED_CODE,
      route,
      message: `route ${route} ${RECORD_ADVICE} (record error: ${truthfulLockDetail(errorText(err))})`,
    })
    return false
  }
}

/** O1/C2: write the intent BEFORE settings.mutate so a later crash is recoverable. */
async function writeJournal(
  deps: GoWriterDeps,
  key: string,
  input: {
    route: string
    models: readonly SettingsModelProfile[]
    entry: GoOwnershipEntry | undefined
    unset: boolean
    expectedRevision?: number
  },
): Promise<boolean> {
  if (deps.journalStore === undefined || deps.profileKey === undefined) return false
  const journal: GoWriteJournal = {
    version: 1,
    profileKey: deps.profileKey,
    route: input.route,
    keyFingerprint: deps.keyFingerprint,
    modelIds: Object.keys(input.entry?.managed ?? {}).sort(),
    contentHash: journalContentHash(input.models),
    unset: input.unset,
    at: deps.now?.() ?? Date.now(),
  }
  if (input.expectedRevision !== undefined) journal.expectedRevision = input.expectedRevision
  if (input.entry !== undefined) journal.entry = input.entry
  try {
    await deps.journalStore.write(key, journal)
    return true
  } catch (err) {
    // Journal persistence failure degrades to the pre-C2 path: do NOT block the
    // settings write (that would change lock-timeout / gate semantics). The
    // honest `settings-written-unaccounted` report still covers this rare
    // residual window; the next round simply has no journal to reconcile.
    deps.logger.warn('write-ahead journal write failed for %s: %s', input.route, errorText(err))
    return false
  }
}

/** O1/C2: remove a journal only after a fully accounted write (or an abandoned one). */
async function deleteJournal(deps: GoWriterDeps, key: string | undefined): Promise<void> {
  if (key === undefined || deps.journalStore === undefined) return
  try {
    await deps.journalStore.delete(key)
  } catch (err) {
    deps.logger.warn('write-ahead journal cleanup failed for %s: %s', key, errorText(err))
  }
}

/**
 * B4/N1: abandon the WHOLE round the moment the host settings revision moved
 * underneath a validated plan. Nothing is written — no settings mutate, no
 * ledger commit, no fingerprint — so a user edit that landed mid-round is kept
 * byte-for-byte. `plan.routes` that were never touched are reported as skipped
 * for observability; routes that already wrote (a mid-loop race) are left as-is
 * and the report stays honest.
 */
function abandonForSettingsChange(
  result: GoWriteResult,
  report: GoPlanReportEntry[],
  plan: GoPlanResult,
  expectedRevision: number | undefined,
  actualRevision: number,
): GoWriteResult {
  result.settingsChanged = { expectedRevision, actualRevision }
  const touched = new Set([
    ...result.routes.map((status) => status.route),
    ...result.failedRoutes.map((failed) => failed.route),
    ...result.writtenRoutes,
    // O1-minimal (S7): a mutate may have landed even if its ledger commit then
    // failed. Count it as touched and report it as already written.
    ...result.settingsLandedRoutes,
  ])
  for (const planned of plan.routes) {
    if (planned.skip || touched.has(planned.route)) continue
    result.routes.push({
      route: planned.route,
      slot: planned.slot,
      status: 'skipped',
      reason: 'settings-changed-during-sync',
    })
  }
  // O1-minimal (S7): never claim "zero settings writes" when a mutate already
  // landed earlier in this round. List written vs discarded routes explicitly;
  // keep the original zero-write wording byte-identical when nothing landed.
  const landed = result.settingsLandedRoutes
  const discarded = plan.routes
    .filter((p) => !p.skip && !touched.has(p.route))
    .map((p) => p.route)
  const writeState = landed.length === 0
    ? 'zero settings writes, no ledger/fingerprint update'
    : `already written: [${landed.join(', ')}]; discarded (no settings write): [${discarded.length === 0 ? 'none' : discarded.join(', ')}]; no ledger/fingerprint update for discarded routes`
  report.push({
    level: 'warn',
    code: 'settings-changed-during-sync',
    message: `llm-pi-ai revision ${String(expectedRevision)} -> ${actualRevision} during this round; stale plan discarded (${writeState}); the next round re-reads current settings`,
  })
  result.report = associateGoMoves(report)
  return result
}

// ---------------------------------------------------------------------------
// Per-route mutation building
// ---------------------------------------------------------------------------

interface RouteOps {
  ops: SettingsMutationOp[]
  /** A non-empty settings overrides key was present (must be staged + unset). */
  settingsOverrides: Record<string, Record<string, unknown>> | undefined
  /** The exact models array settings will hold after this mutate (C2 hash input). */
  models: SettingsModelProfile[]
}

/**
 * Build one route's ops. `set api/baseURL/displayName/apiKeyEnv/models` (or a
 * whole-route `unset`) all go into ONE mutate, so a route never ends up with
 * fields from one round and models from another (§6.2.4 atomicity).
 * Returns `undefined` when nothing would change (`profilesEqual` gate).
 */
async function buildRouteOps(
  planned: GoPlannedRoute,
  desc: SettingsDescriptor,
  finalModels: readonly SettingsModelProfile[],
  overrideStorer: GoOverrideStorer | undefined,
): Promise<RouteOps | undefined> {
  const data = rawRoute(desc, planned.route)
  const settingsOverrides = rawOverrides(desc, planned.route)

  // Settings key wins; store replay is the fallback (§6.2.4 store-first).
  let overrides = settingsOverrides
  if (overrides === undefined && overrideStorer?.read !== undefined) {
    const stored = await overrideStorer.read(planned.route)
    if (stored?.overrides !== undefined && Object.keys(stored.overrides).length > 0) {
      overrides = stored.overrides
    }
  }
  const mergedModels = mergeOverrides(finalModels, overrides)

  const ops: SettingsMutationOp[] = []
  // C2: the post-write models array (empty for an unset). We hash THIS on the
  // journal; reconciliation hashes the models read back from settings and
  // compares, so a user edit after our write is detected without ever writing
  // settings from the reconciler.
  let postWriteModels: SettingsModelProfile[] = []
  if (planned.unset) {
    // §9.4: an empty fully-managed route is removed wholesale — never `models: []`.
    ops.push({ op: 'unset', path: ['providers', planned.route] })
  } else {
    for (const field of OWNED_FIELDS) {
      if (data?.[field] !== planned.fields[field]) {
        ops.push({ op: 'set', path: ['providers', planned.route, field], value: planned.fields[field] })
      }
    }
    const currentRaw = sortedModels(rawModels(desc, planned.route))
    const mergedSorted = sortedModels(mergedModels)
    postWriteModels = mergedSorted
    const modelsEqual = overrides === undefined
      && currentRaw.length === mergedSorted.length
      && profilesEqual(currentRaw, mergedSorted)
    // `profilesEqual` (ADR-007's final gate): a hash-only upstream change must
    // not cause a revision bump when the written array would be identical.
    if (!modelsEqual) {
      ops.push({ op: 'set', path: ['providers', planned.route, 'models'], value: mergedSorted })
    }
    if (settingsOverrides !== undefined) {
      ops.push({ op: 'unset', path: ['providers', planned.route, 'modelOverrides'] })
    }
  }
  return ops.length === 0 ? undefined : { ops, settingsOverrides, models: postWriteModels }
}

async function stageOverrides(
  storer: GoOverrideStorer | undefined,
  route: string,
  overrides: Record<string, Record<string, unknown>> | undefined,
): Promise<void> {
  if (storer === undefined || overrides === undefined) return
  await storer.updateOverrides(route, overrides)
}

// ---------------------------------------------------------------------------
// writeGoPlan: the settings write path
// ---------------------------------------------------------------------------

/**
 * Apply a planner result to the injected settings service and persist the
 * updated ownership ledger. Multi-route writes are isolated per route: one
 * route's failure never poisons the others, and the result names both the
 * routes written and the routes failed (§19 single-point-failure guidance).
 */
export async function writeGoPlan(plan: GoPlanResult, deps: GoWriterDeps): Promise<GoWriteResult> {
  const { settings, ownershipStore, logger, keyFingerprint } = deps
  const confirmRemovals = Math.max(2, deps.confirmRemovals ?? 2)
  const result: GoWriteResult = { routes: [], writtenRoutes: [], failedRoutes: [], settingsLandedRoutes: [], report: [] }
  const report = plan.report.map((entry) => ({ ...entry }))
  // O1-minimal: routes whose settings landed but whose ledger did not commit.
  // Their planner `added` lines must be suppressed (they were not claimed).
  const unaccounted = new Set<string>()

  for (const conflict of plan.conflicts) {
    result.routes.push({
      route: conflict.route,
      slot: conflict.slot,
      status: 'conflict',
      reason: `${conflict.field}: ${conflict.actual} != ${conflict.expected}`,
    })
  }

  const desc = settings === undefined ? undefined : findLlmDescriptor(settings)
  if (settings === undefined || desc === undefined) {
    for (const planned of plan.routes) {
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'skipped', reason: 'settings-unavailable' })
    }
    result.report = associateGoMoves(report)
    return result
  }

  // B4/N1 window ②: the user changed settings after the round validated the
  // revision but before the writer first read the descriptor. The plan was
  // built from the OLD settings, so even a fresh-revision mutate would silently
  // delete the just-saved model. Abandon before touching anything.
  const expectedRevision = deps.expectedRevision
  let currentExpectedRevision = expectedRevision
  if (expectedRevision !== undefined && desc.revision !== expectedRevision) {
    return abandonForSettingsChange(result, report, plan, expectedRevision, desc.revision)
  }

  for (const planned of plan.routes) {
    if (planned.skip) {
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'skipped', reason: 'planner-skip' })
      continue
    }

    // Single-writer second gate (§14.7.5): re-read the persisted status here,
    // never reuse the round-level snapshot. A route whose authority was revoked
    // between the round gate and this point is skipped with a report line —
    // never silently, never touched (not even the ledger).
    const gate = await canWriteDecision(deps, planned.route)
    if (gate !== undefined && !gate.allow) {
      skipByCanWrite(result, report, planned, gate)
      continue
    }

    const key = goOwnershipKey(planned.route, keyFingerprint)
    let prior: GoOwnershipEntry | undefined
    try {
      prior = await ownershipStore.read(key)
    } catch (err) {
      if (isStoreLockTimeout(err)) {
        logger.warn('ownership store read lock timeout for %s: %s', key, errorText(err))
        recordLockTimeout(result, report, planned, err, 'ledger read')
        continue
      }
      // Fail closed: with no ledger we cannot verify hashes, so do not write.
      logger.warn('ownership store read failed for %s: %s', key, errorText(err))
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'failed', reason: 'store-unavailable' })
      result.failedRoutes.push({ route: planned.route, reason: 'store-unavailable' })
      continue
    }

    const current = rawModels(desc, planned.route)
    const currentById = new Map(current.map((model) => [model.id, model]))
    // Use the planner's mapped desired set, not the merged output (which also
    // contains kept user-owned entries).
    const desiredProfiles = plan.desiredByRoute[planned.route] ?? []
    const desiredById = new Map(desiredProfiles.map((model) => [model.id, model]))
    const candidates = report.filter((entry) =>
      entry.code === 'deletion-candidate'
      && entry.route === planned.route
      && entry.slot === planned.slot
      && entry.id !== undefined)

    // --- Double-round deletion confirmation (V5) ---------------------------
    // The planner flags a candidate after its three gates pass; only the
    // writer knows how many consecutive successful rounds have flagged it.
    const missing: Record<string, number> = { ...(prior?.missing ?? {}) }
    const finalModels = [...planned.models]
    for (const candidate of candidates) {
      const id = candidate.id!
      const seen = missing[id] ?? 0
      if (seen + 1 < confirmRemovals) {
        // Round 1 of 2 (or earlier for a larger threshold): keep the model.
        const currentModel = currentById.get(id)
        // A deletion candidate is by definition NOT in the desired set — never
        // add it to `desiredById`, or the counter-reset loop below would erase
        // the very counter we are setting here.
        if (currentModel !== undefined) finalModels.push(currentModel)
        missing[id] = seen + 1
        candidate.code = 'deletion-pending'
        candidate.message = `model ${id} absent (${seen + 1}/${confirmRemovals}); kept until confirmed`
      } else {
        // Confirmed: let the planner's exclusion stand — actually delete.
        delete missing[id]
        candidate.code = 'deleted'
        candidate.message = `model ${id} removed after ${confirmRemovals} consecutive absent rounds`
      }
    }
    // A model that came back into the DESIRED set resets its absence counter.
    // Must not iterate `finalModels`: a pending candidate was just re-added
    // there for this round and its counter must survive.
    for (const id of desiredById.keys()) {
      if (missing[id] !== undefined) delete missing[id]
    }
    const sortedFinal = sortedModels(finalModels)

    // --- Ledger to persist if this route's write succeeds ------------------
    const nextManaged: Record<string, GoManagedModel> = { ...(plan.nextOwnership[key]?.managed ?? {}) }
    // A pending candidate is still plugin-managed: keep it in the ledger so a
    // later round can finish the deletion (the planner dropped it already).
    for (const candidate of candidates) {
      if (candidate.code === 'deletion-pending' && candidate.id !== undefined) {
        const model = currentById.get(candidate.id)
        if (model !== undefined) nextManaged[candidate.id] = { hash: profileHash(model) }
      }
    }
    // First-round conservative claim (§6.2.4 / A3): with no prior ledger claim
    // the desired∩current id set, recording the hash of the value we write —
    // never claim ids outside the official desired set (qwen4-max / grok-4.7
    // stay user-owned until adopt). `adoptExisting` (design §14.1) explicitly
    // opts those pre-existing ids into the ledger; they still leave via the
    // two-round confirmation and the three deletion gates, never immediately.
    if (prior === undefined || deps.adoptExisting === true) {
      for (const desired of desiredProfiles) {
        if (currentById.has(desired.id)) {
          nextManaged[desired.id] = { hash: profileHash(desired) }
        }
      }
      if (deps.adoptExisting === true) {
        for (const model of current) {
          if (nextManaged[model.id] === undefined) {
            nextManaged[model.id] = { hash: profileHash(model) }
          }
        }
      }
    }
    const preManagedSnapshot = prior?.preManagedSnapshot !== undefined
      ? prior.preManagedSnapshot
      : current.map((model) => ({ ...model }))
    // §14.3 ownership: `preManagedSection`, `appliedAddedIds` (and any future
    // migration-period fields) are written ONLY by the migrate module. The go
    // writer may only read/inherit them — never generate, recompute, or clear
    // them. Spreading `prior` first carries every field the writer does NOT own
    // forward verbatim on EVERY round (including no-change and
    // deletion-candidate rounds), so the authoritative rollback snapshot keeps
    // its exact bytes until rollback removes it. Only the fields the writer
    // actually owns (routeFields / managed / preManagedSnapshot / missing) are
    // overridden below. This is a merge, never a replace.
    const nextEntry: GoOwnershipEntry = {
      ...prior,
      routeFields: plan.nextOwnership[key]?.routeFields ?? planned.fields,
      managed: nextManaged,
      preManagedSnapshot,
    }
    // `missing` is writer-owned: reflect this round exactly (drop the key once
    // the counter drains to empty, matching the previous behaviour).
    if (Object.keys(missing).length > 0) nextEntry.missing = missing
    else delete nextEntry.missing

    // --- Build + run the mutate (with one revision-conflict retry) ---------
    let built: RouteOps | undefined
    try {
      built = await buildRouteOps(planned, desc, sortedFinal, deps.overrideStorer)
    } catch (err) {
      if (isStoreLockTimeout(err)) {
        logger.warn('override resolve lock timeout for %s: %s', planned.route, errorText(err))
        recordLockTimeout(result, report, planned, err, 'override resolve')
        continue
      }
      const reason = 'store-unavailable'
      logger.warn('override resolve failed for %s: %s', planned.route, errorText(err))
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'failed', reason })
      result.failedRoutes.push({ route: planned.route, reason })
      continue
    }

    // B4/N1 window ①: re-read the descriptor IMMEDIATELY before any settings
    // mutate (or the no-change ledger commit) for this route. A revision moved
    // since our last validated write means settings changed underneath us —
    // the plan is stale, so abandon the whole round with zero writes. Our own
    // earlier mutate advances the document revision, so compare against the
    // rolling baseline (updated after each successful write), not the round's
    // original revision.
    let live: SettingsDescriptor | undefined
    if (expectedRevision !== undefined) {
      live = findLlmDescriptor(settings)
      if (live === undefined || live.revision !== currentExpectedRevision) {
        return abandonForSettingsChange(result, report, plan, currentExpectedRevision, live?.revision ?? -1)
      }
    }

    if (built === undefined) {
      const commit = await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route)
      if (commit.lockTimeout !== undefined) {
        recordLockTimeout(result, report, planned, commit.lockTimeout, 'ledger commit')
        continue
      }
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'no-change' })
      continue
    }

    let failedReason: string | undefined
    // Settings mutate landing is tracked separately: it is added to
    // `writtenRoutes` only once the ledger commit also succeeds. A lock
    // timeout on the ledger must not leave the route counted as a success.
    let settingsLanded = false
    if (built.settingsOverrides !== undefined && deps.overrideStorer === undefined) {
      // Unsetting a settings key with no store copy is the v0.1.5 data-loss
      // shape — fail closed rather than drop the user's folded values.
      failedReason = 'store-unavailable'
      logger.warn('modelOverrides present but no models-store seam for %s', planned.route)
    } else {
      try {
        await stageOverrides(deps.overrideStorer, planned.route, built.settingsOverrides)
      } catch (err) {
        if (isStoreLockTimeout(err)) {
          logger.warn('override stage lock timeout for %s: %s', planned.route, errorText(err))
          recordLockTimeout(result, report, planned, err, 'override stage')
          continue
        }
        failedReason = 'store-unavailable'
        logger.warn('override stage failed for %s: %s', planned.route, errorText(err))
      }
    }

    // O1/C2: journal the intent BEFORE the only settings mutate. A journal is
    // kept on ANY failure after this point (mutate, ledger, record) so the next
    // round can reconcile it. It is deleted only on a fully accounted success.
    const jkey = deps.journalStore !== undefined && deps.profileKey !== undefined
      ? goJournalKey(deps.profileKey, planned.route, keyFingerprint)
      : undefined
    let journalWritten = false
    if (failedReason === undefined && jkey !== undefined) {
      journalWritten = await writeJournal(deps, jkey, {
        route: planned.route,
        models: built.models,
        entry: nextEntry,
        unset: planned.unset,
        expectedRevision: currentExpectedRevision,
      })
    }

    // O1/C2: re-run the freshness check AFTER the journal store write, so the
    // extra store I/O never widens the window between validation and mutate.
    // If a user edit landed while we journaled, discard the journal (no mutate
    // has run) and abandon the whole round with zero writes.
    if (journalWritten && expectedRevision !== undefined) {
      const afterJournal = findLlmDescriptor(settings)
      if (afterJournal === undefined || afterJournal.revision !== currentExpectedRevision) {
        await deleteJournal(deps, jkey)
        return abandonForSettingsChange(result, report, plan, currentExpectedRevision, afterJournal?.revision ?? -1)
      }
    }

    if (failedReason === undefined) {
      try {
        await settings.mutate('llm-pi-ai', built.ops, live?.revision ?? desc.revision)
        settingsLanded = true
        result.settingsLandedRoutes.push(planned.route)
        // N1 residual window: the revision alone is not enough to establish the
        // new baseline. A user edit landing between mutate() returning and this
        // re-read bumps the revision too, so adopting it would make later routes
        // treat a stale plan as fresh. Hash the content we EXPECT our ops to
        // leave and compare it with what is actually present; only a match
        // advances the rolling baseline. The write-ahead journal is deliberately
        // kept on mismatch so the next round can still re-account our write.
        if (expectedRevision !== undefined) {
          const after = findLlmDescriptor(settings)
          const expectedContent = fingerprintSection(expectedUserAfterOps(live?.user, built.ops))
          if (after === undefined || fingerprintSection(after.user ?? {}) !== expectedContent) {
            logger.warn('settings changed after our mutate for %s; abandoning round', planned.route)
            return abandonForSettingsChange(result, report, plan, currentExpectedRevision, after?.revision ?? -1)
          }
          currentExpectedRevision = after.revision
        }
      } catch (err) {
        if (!isConflictError(err)) {
          failedReason = 'mutate-rejected'
          logger.warn('mutate failed for %s: %s', planned.route, errorText(err))
        } else if (expectedRevision !== undefined) {
          // B4/N1: a conflict AFTER our freshness check can only be an external
          // edit that landed in the narrow gap before the mutate. Retrying with
          // the stale plan would delete the just-saved model — abandon the
          // whole round instead (no ledger/fingerprint, next round re-plans).
          // No mutate landed for this route; drop the journal so reconciliation
          // does not re-account an abandoned plan on the next round.
          await deleteJournal(deps, jkey)
          const fresh = findLlmDescriptor(settings)
          return abandonForSettingsChange(result, report, plan, currentExpectedRevision, fresh?.revision ?? -1)
        } else {
          // Legacy retry for direct unit writers that did not supply a
          // round-level expectedRevision (production always supplies one).
          // §14.7.5: re-run the second gate BEFORE the retry mutate. The live
          // migration status may have flipped during the first attempt; the
          // round-level decision and the first gate result are both stale now.
          const retryGate = await canWriteDecision(deps, planned.route)
          if (retryGate !== undefined && !retryGate.allow) {
            skipByCanWrite(result, report, planned, retryGate)
            continue
          }
          // SETTINGS_CONFLICT: re-read the revision, rebuild the ops against the
          // fresh descriptor, and retry exactly once (existing writer style).
          logger.info('SETTINGS_CONFLICT for %s; retrying once', planned.route)
          failedReason = 'conflict-retry-failed'
          try {
            const fresh = findLlmDescriptor(settings)
            if (fresh === undefined) throw new Error('llm-pi-ai namespace disappeared on retry')
            const retryBuilt = await buildRouteOps(planned, fresh, sortedFinal, deps.overrideStorer)
            if (retryBuilt === undefined) {
              // Another writer already landed the exact target: no-op success.
              failedReason = undefined
              const retryCommit = await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route)
              if (retryCommit.lockTimeout !== undefined) {
                recordLockTimeout(result, report, planned, retryCommit.lockTimeout, 'ledger commit (conflict retry)')
                continue
              }
              result.routes.push({ route: planned.route, slot: planned.slot, status: 'no-change' })
              continue
            }
            // O1/C2: the retry may write a different models array; refresh the
            // journal so reconciliation hashes the value actually written.
            if (jkey !== undefined && journalWritten) {
              await writeJournal(deps, jkey, {
                route: planned.route,
                models: retryBuilt.models,
                entry: nextEntry,
                unset: planned.unset,
                expectedRevision: currentExpectedRevision,
              })
            }
            await stageOverrides(deps.overrideStorer, planned.route, retryBuilt.settingsOverrides)
            await settings.mutate('llm-pi-ai', retryBuilt.ops, fresh.revision)
            settingsLanded = true
            result.settingsLandedRoutes.push(planned.route)
            failedReason = undefined
          } catch (retryErr) {
            if (isStoreLockTimeout(retryErr)) {
              recordLockTimeout(result, report, planned, retryErr, 'write (conflict retry)')
              continue
            }
            logger.warn('conflict retry failed for %s: %s', planned.route, errorText(retryErr))
          }
        }
      }
    }

    if (failedReason !== undefined) {
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'failed', reason: failedReason })
      result.failedRoutes.push({ route: planned.route, reason: failedReason })
      report.push({
        level: 'error',
        code: 'write-failed',
        route: planned.route,
        slot: planned.slot,
        message: `route ${planned.route} not written (${failedReason})`,
      })
      continue
    }

    // §14.7.4: settings mutate + ledger commit both succeeded — only now
    // re-persist the applied fingerprint (same store queue as the ledger), with
    // the managed id set we just committed. Failed/no-change routes never get
    // here, so a partial failure leaves their fingerprint untouched.
    const commit = await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route, settingsLanded)
    if (commit.lockTimeout !== undefined) {
      // Settings may have landed, but without a committed ledger this round is
      // NOT a success: report the actionable lock error and exclude the route
      // from writtenRoutes (and from the fingerprint update).
      recordLockTimeout(result, report, planned, commit.lockTimeout, 'ledger commit', settingsLanded)
      if (settingsLanded) unaccounted.add(planned.route)
      continue
    }
    if (!commit.committed) {
      // O1-minimal: settings landed but the ledger did not. This is a real
      // (non-lock) failure — surface it in failedRoutes so the command result
      // is `kind:'error'` and the route is not advertised as a clean success.
      result.failedRoutes.push({
        route: planned.route,
        reason: settingsLanded ? UNACCOUNTED_CODE : 'ledger-write-failed',
      })
      if (settingsLanded) unaccounted.add(planned.route)
    }
    if (commit.committed) {
      const recordPersisted = await recordOwnWrite(
        deps, planned.route, planned.unset ? [] : Object.keys(nextEntry.managed).sort(), report,
      )
      // C2: only a fully accounted write (settings + ledger + record) closes the
      // journal. A failed record persist (S1b) keeps it so the next round's
      // reconciliation re-persists the migration record and reopens the gate.
      if (recordPersisted) await deleteJournal(deps, jkey)
    }
    if (settingsLanded) result.writtenRoutes.push(planned.route)
    result.routes.push({
      route: planned.route,
      slot: planned.slot,
      status: planned.unset ? 'unset' : 'wrote',
    })
  }

  // O1-minimal: never advertise an `added` model on a route that was skipped,
  // failed, or written-but-unaccounted. The model was not claimed in the ledger,
  // so the next round will treat it as user-owned (S1/S2 report-text trap).
  const notClaimed = new Set([
    ...result.routes.filter((r) => r.status === 'skipped' || r.status === 'failed').map((r) => r.route),
    ...unaccounted,
  ])
  const honestReport = report.filter((entry) =>
    !(entry.code === 'added' && entry.route !== undefined && notClaimed.has(entry.route)))
  result.report = associateGoMoves(honestReport)
  return result
}

/** Commits the ledger; a lock timeout is returned with its original error (not degraded). */
async function persistLedger(
  store: GoOwnershipStore,
  key: string,
  unset: boolean,
  entry: GoOwnershipEntry,
  logger: Logger,
  report: GoPlanReportEntry[],
  route: string,
  settingsLanded = false,
): Promise<LedgerCommitResult> {
  try {
    if (unset) await store.delete(key)
    else await store.write(key, entry)
    return { committed: true }
  } catch (err) {
    if (isStoreLockTimeout(err)) {
      // Keep the original error (code / lockPath / actionable message) for the
      // caller to surface verbatim — do NOT collapse it into a generic warning.
      logger.warn('ownership store lock timeout for %s: %s', key, errorText(err))
      return { committed: false, lockTimeout: err }
    }
    // A failed ledger write degrades to "no ledger" next round, which is the
    // safe direction (never delete without a hash). But when settings already
    // landed this is NOT a clean success: say so truthfully (O1-minimal).
    logger.warn('ownership store write failed for %s: %s', key, errorText(err))
    if (settingsLanded) {
      report.push({
        level: 'error',
        code: UNACCOUNTED_CODE,
        route,
        message: `route ${route} ${UNACCOUNTED_ADVICE} (ledger write error: ${errorText(err)})`,
      })
    } else {
      report.push({
        level: 'warn',
        code: 'ledger-write-failed',
        route,
        message: `route ${route} written but ownership ledger could not be persisted`,
      })
    }
    return { committed: false }
  }
}

// ---------------------------------------------------------------------------
// moved association (P1a verification concern ③)
// ---------------------------------------------------------------------------

/**
 * Pair a removal on route A with an add of the same id on route B into one
 * human-readable `moved` entry, so a consumer never reads a cross-slot move as
 * an unrelated delete + add. A still-pending source removal is labelled as
 * such (double confirmation), so the report stays honest.
 */
export function associateGoMoves(report: readonly GoPlanReportEntry[]): GoPlanReportEntry[] {
  const out = report.map((entry) => ({ ...entry }))
  const removals: number[] = []
  const adds: number[] = []
  for (let i = 0; i < out.length; i++) {
    const entry = out[i]
    if (entry.id === undefined || entry.route === undefined) continue
    if (entry.code === 'added') adds.push(i)
    else if (entry.code === 'deletion-candidate' || entry.code === 'deletion-pending' || entry.code === 'deleted') removals.push(i)
  }
  const used = new Set<number>()
  const moves: GoPlanReportEntry[] = []
  for (const ri of removals) {
    const removal = out[ri]
    const addIndex = adds.find((ai) => !used.has(ai)
      && out[ai].id === removal.id
      && out[ai].route !== removal.route)
    if (addIndex === undefined) continue
    used.add(ri)
    used.add(addIndex)
    const added = out[addIndex]
    const pending = removal.code === 'deletion-pending' || removal.code === 'deletion-candidate'
    moves.push({
      level: 'info',
      code: 'moved',
      id: removal.id,
      route: removal.route,
      slot: removal.slot,
      message: `model ${removal.id} moved from ${removal.route} to ${added.route}${pending ? ' (source removal pending confirmation)' : ''}`,
    })
  }
  return [...out.filter((_, i) => !used.has(i)), ...moves]
}

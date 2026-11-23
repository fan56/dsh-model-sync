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
// §14.4 (eject only managed entries + plugin fields), ADR-004, V5/V9/V13.

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

const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'
const OWNED_FIELDS = ['api', 'baseURL', 'displayName', 'apiKeyEnv'] as const

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
  /** Planner report adjusted by writer decisions + `moved` association. */
  report: GoPlanReportEntry[]
}

export interface GoEjectOptions {
  routes: readonly string[]
  keyFingerprint: string
  settings: SettingsService | undefined
  ownershipStore: GoOwnershipStore
  logger: Logger
}

export interface GoEjectResult {
  ejected: string[]
  refused: { route: string; reason: string }[]
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
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Per-route mutation building
// ---------------------------------------------------------------------------

interface RouteOps {
  ops: SettingsMutationOp[]
  /** A non-empty settings overrides key was present (must be staged + unset). */
  settingsOverrides: Record<string, Record<string, unknown>> | undefined
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
  return ops.length === 0 ? undefined : { ops, settingsOverrides }
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
  const result: GoWriteResult = { routes: [], writtenRoutes: [], failedRoutes: [], report: [] }
  const report = plan.report.map((entry) => ({ ...entry }))

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

  for (const planned of plan.routes) {
    if (planned.skip) {
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'skipped', reason: 'planner-skip' })
      continue
    }

    const key = goOwnershipKey(planned.route, keyFingerprint)
    let prior: GoOwnershipEntry | undefined
    try {
      prior = await ownershipStore.read(key)
    } catch (err) {
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
    const nextEntry: GoOwnershipEntry = {
      routeFields: plan.nextOwnership[key]?.routeFields ?? planned.fields,
      managed: nextManaged,
      preManagedSnapshot,
      ...(Object.keys(missing).length > 0 ? { missing } : {}),
    }

    // --- Build + run the mutate (with one revision-conflict retry) ---------
    let built: RouteOps | undefined
    try {
      built = await buildRouteOps(planned, desc, sortedFinal, deps.overrideStorer)
    } catch (err) {
      const reason = 'store-unavailable'
      logger.warn('override resolve failed for %s: %s', planned.route, errorText(err))
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'failed', reason })
      result.failedRoutes.push({ route: planned.route, reason })
      continue
    }

    if (built === undefined) {
      await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route)
      result.routes.push({ route: planned.route, slot: planned.slot, status: 'no-change' })
      continue
    }

    let failedReason: string | undefined
    if (built.settingsOverrides !== undefined && deps.overrideStorer === undefined) {
      // Unsetting a settings key with no store copy is the v0.1.5 data-loss
      // shape — fail closed rather than drop the user's folded values.
      failedReason = 'store-unavailable'
      logger.warn('modelOverrides present but no models-store seam for %s', planned.route)
    } else {
      try {
        await stageOverrides(deps.overrideStorer, planned.route, built.settingsOverrides)
      } catch (err) {
        failedReason = 'store-unavailable'
        logger.warn('override stage failed for %s: %s', planned.route, errorText(err))
      }
    }

    if (failedReason === undefined) {
      try {
        await settings.mutate('llm-pi-ai', built.ops, desc.revision)
        result.writtenRoutes.push(planned.route)
      } catch (err) {
        if (!isConflictError(err)) {
          failedReason = 'mutate-rejected'
          logger.warn('mutate failed for %s: %s', planned.route, errorText(err))
        } else {
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
              await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route)
              result.routes.push({ route: planned.route, slot: planned.slot, status: 'no-change' })
              continue
            }
            await stageOverrides(deps.overrideStorer, planned.route, retryBuilt.settingsOverrides)
            await settings.mutate('llm-pi-ai', retryBuilt.ops, fresh.revision)
            result.writtenRoutes.push(planned.route)
            failedReason = undefined
          } catch (retryErr) {
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

    await persistLedger(ownershipStore, key, planned.unset, nextEntry, logger, report, planned.route)
    result.routes.push({
      route: planned.route,
      slot: planned.slot,
      status: planned.unset ? 'unset' : 'wrote',
    })
  }

  result.report = associateGoMoves(report)
  return result
}

async function persistLedger(
  store: GoOwnershipStore,
  key: string,
  unset: boolean,
  entry: GoOwnershipEntry,
  logger: Logger,
  report: GoPlanReportEntry[],
  route: string,
): Promise<void> {
  try {
    if (unset) await store.delete(key)
    else await store.write(key, entry)
  } catch (err) {
    // Settings already landed; a failed ledger write degrades to "no ledger"
    // next round, which is the safe direction (never delete without a hash).
    logger.warn('ownership store write failed for %s: %s', key, errorText(err))
    report.push({
      level: 'warn',
      code: 'ledger-write-failed',
      route,
      message: `route ${route} written but ownership ledger could not be persisted`,
    })
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

// ---------------------------------------------------------------------------
// eject: restore only managed entries + plugin fields (§14.4 / V13)
// ---------------------------------------------------------------------------

/**
 * Undo the plugin's ownership for the given routes. Restores the pre-managed
 * snapshot for plugin-managed ids, keeps every user-owned / post-takeover
 * value untouched, and unsets only route fields whose current value still
 * equals the value the plugin last wrote. Refuses (with a reason) when the
 * snapshot is missing or any managed model changed under the plugin.
 */
export async function ejectGoRoutes(options: GoEjectOptions): Promise<GoEjectResult> {
  const { routes, keyFingerprint, settings, ownershipStore, logger } = options
  const result: GoEjectResult = { ejected: [], refused: [], report: [] }
  const desc = settings === undefined ? undefined : findLlmDescriptor(settings)

  for (const route of routes) {
    const refuse = (reason: string): void => {
      result.refused.push({ route, reason })
      result.report.push({ level: 'error', code: 'eject-refused', route, message: `${route}: ${reason}` })
    }
    if (settings === undefined || desc === undefined) {
      refuse('settings service / llm-pi-ai namespace unavailable')
      continue
    }

    const key = goOwnershipKey(route, keyFingerprint)
    let prior: GoOwnershipEntry | undefined
    try {
      prior = await ownershipStore.read(key)
    } catch (err) {
      refuse(`ownership store unreadable: ${errorText(err)}`)
      continue
    }
    if (prior === undefined) {
      refuse('no ownership ledger for this route/key')
      continue
    }
    if (prior.preManagedSnapshot === undefined) {
      refuse('pre-managed snapshot missing; refusing to guess a restore target')
      continue
    }

    const current = rawModels(desc, route)
    const currentById = new Map(current.map((model) => [model.id, model]))
    let hashMismatch = false
    for (const [id, record] of Object.entries(prior.managed)) {
      const model = currentById.get(id)
      // An id already gone from settings needs no verification; an id still
      // present must match the hash we last wrote or it is a post-takeover edit.
      if (model !== undefined && profileHash(model) !== record.hash) {
        hashMismatch = true
        break
      }
    }
    if (hashMismatch) {
      refuse('managed model hash mismatch (user edited after takeover); refusing eject')
      continue
    }

    const managedIds = new Set(Object.keys(prior.managed))
    const userKept = current.filter((model) => !managedIds.has(model.id))
    const userKeptIds = new Set(userKept.map((model) => model.id))
    const restored = prior.preManagedSnapshot.filter((model) => !userKeptIds.has(model.id))
    const ejectModels = sortedModels([...userKept, ...restored])

    const data = rawRoute(desc, route)
    const ownedFields = prior.routeFields ?? {}
    const foreignFields = OWNED_FIELDS.filter((field) =>
      data?.[field] !== undefined && ownedFields[field] === undefined)
    const ops: SettingsMutationOp[] = []
    if (ejectModels.length === 0) {
      // Whole route is plugin-created and now empty; never leave `models: []`.
      if (foreignFields.length > 0) {
        refuse('route would be empty but has user-owned fields; refusing whole-route unset')
        continue
      }
      ops.push({ op: 'unset', path: ['providers', route] })
    } else {
      ops.push({ op: 'set', path: ['providers', route, 'models'], value: ejectModels })
      for (const field of OWNED_FIELDS) {
        if (ownedFields[field] !== undefined && data?.[field] === ownedFields[field]) {
          ops.push({ op: 'unset', path: ['providers', route, field] })
        }
      }
    }

    let done = false
    try {
      await settings.mutate('llm-pi-ai', ops, desc.revision)
      done = true
    } catch (err) {
      if (isConflictError(err)) {
        try {
          const fresh = findLlmDescriptor(settings)
          if (fresh === undefined) throw new Error('llm-pi-ai namespace disappeared on retry')
          await settings.mutate('llm-pi-ai', ops, fresh.revision)
          done = true
        } catch (retryErr) {
          logger.warn('eject conflict retry failed for %s: %s', route, errorText(retryErr))
        }
      } else {
        logger.warn('eject mutate failed for %s: %s', route, errorText(err))
      }
    }
    if (!done) {
      refuse('settings mutate failed; ledger kept for retry')
      continue
    }

    try {
      await ownershipStore.delete(key)
    } catch (err) {
      // Settings restored; a stale ledger entry is safe (next round treats it
      // as a fresh key with no managed ids rather than deleting user data).
      logger.warn('eject ledger cleanup failed for %s: %s', key, errorText(err))
    }
    result.ejected.push(route)
    result.report.push({
      level: 'info',
      code: 'ejected',
      route,
      message: `restored managed entries of ${route} and removed plugin-owned fields`,
    })
  }
  return result
}

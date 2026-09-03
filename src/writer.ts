// Plan C (settings-seam): write translated model profiles to settings via mutate API.

/**
 * Write translated model profiles to dsh settings via the settings.mutate API.
 *
 * Key behaviors (design doc §4, revised for the modelOverrides mutual
 * exclusion, 2026-09-03):
 * - Change-only writes: compare the merged target (target ⊕ modelOverrides)
 *   against the raw user segment (desc.user), not resolved values (which have
 *   schema defaults applied)
 * - modelOverrides are the user's own per-model channel (think levels,
 *   narrowed context windows). The dsh llm-pi-ai validation refuses a route
 *   whose settings carry a models list beside non-empty modelOverrides, so a
 *   models write must clear the key in the same mutate: the overrides are
 *   folded into the written models, an `unset` op removes the key (set+unset
 *   apply atomically), and the raw overrides are staged in the models-store
 *   BEFORE the mutate (store-first). Store-first is the data-safety
 *   invariant: settings is the authoritative, lossless source in every
 *   failure window — a failed/rejected mutate leaves the key in place and
 *   the settings-wins rule (see Replay below) suppresses the staged copy,
 *   while a failed store write skips the mutate entirely ('store-unavailable',
 *   settings untouched), so the key is never unset without a stored copy.
 *   Earlier behaviors both failed:
 *   v0.1.5 unset without persisting (the next round clobbered the folded
 *   fields), v0.1.6 preserved the key forever (every mutate was rejected by
 *   the mutual-exclusion validation and nothing landed).
 * - Replay: when settings carries no overrides but the models-store does, the
 *   stored values fold into the target with no unset op — the merged view is
 *   re-derived identically every round, so change-only detection stays
 *   stable and the customizations survive. Settings overrides win over
 *   stored ones (a re-added key is the user's latest intent).
 * - Revision conflict retry: catch SETTINGS_CONFLICT, re-read, re-translate,
 *   re-write once
 * - Never touches ~/.dsh/settings.yaml directly — only through settings.mutate
 * - Store read failure: when the models-store read fails (corrupt JSON,
 *   EACCES, …) AND settings carries no overrides key, skip the round with
 *   reason 'store-unavailable' and leave settings.models untouched — the
 *   already-landed folded values are the authoritative fallback. A write
 *   triggered from a settings-side key is unaffected: settings-wins, and the
 *   atomic writeDoc replaces it on disk (heals the corruption as a side
 *   effect).
 *
 * @module dsh-model-sync/writer
 */

import type { SettingsModelProfile } from './translate.ts'
import type { ModelsStoreAccessor, ModelsStoreEntry } from './remote-catalog.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The settings seam this module needs — injected via parameter, not imported
 * from dsh internals (design doc §4.1: "writer.ts 不能直接 import dsh 的
 * Context").
 */
export interface SettingsDescriptor {
  ns: string
  revision: number
  user?: Record<string, unknown>
  value?: Record<string, unknown>
}

export interface SettingsMutationOp {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}

export interface SettingsService {
  describe(): SettingsDescriptor[]
  mutate(ns: string, ops: SettingsMutationOp[], expectedRevision?: number): Promise<void>
}

/** Logger interface (matches ctx.logger shape). */
export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  debug(format: string, ...args: unknown[]): void
}

export interface SyncResult {
  wrote: boolean
  reason:
    | 'no-change'
    | 'wrote'
    | 'conflict-retry-ok'
    | 'conflict-retry-failed'
    | 'mutate-rejected'
    | 'store-unavailable'
    | 'skipped'
  /**
   * Where the folded overrides came from: 'settings' = the key was present
   * (folded + unset in the same mutate, staged in the models-store before
   * the mutate — store-first); 'store' = replayed from the models-store (no
   * unset). Absent when no overrides were involved at all.
   */
  overridesSource?: 'settings' | 'store'
  /**
   * Override ids with no matching entry in the written target. 'settings'
   * source: they were dropped from settings by the unset but are kept in the
   * models-store verbatim (and apply again if the id shows up in a later
   * target). 'store' source: they simply stay stored. Undefined when no
   * overrides were involved.
   */
  droppedOverrideIds?: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Error code for revision mismatch in settings.mutate. */
const SETTINGS_CONFLICT = 'SETTINGS_CONFLICT'

// ---------------------------------------------------------------------------
// Content-level comparison (§4.4)
// ---------------------------------------------------------------------------

/**
 * Deep equality check for two settings model profile arrays.
 * Both arrays must be sorted by id for deterministic comparison.
 */
export function profilesEqual(
  current: SettingsModelProfile[],
  target: SettingsModelProfile[],
): boolean {
  if (current.length !== target.length) return false
  for (let i = 0; i < current.length; i++) {
    if (!deepEqual(current[i], target[i])) return false
  }
  return true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false

  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).sort()
  const keysB = Object.keys(objB).sort()

  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false
    if (!deepEqual(objA[keysA[i]], objB[keysB[i]])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Extract raw user segment (§4.4)
// ---------------------------------------------------------------------------

/**
 * Extract the raw user-segment models for a route from a settings descriptor.
 * Returns the raw models array (unresolved, no schema defaults applied).
 */
function getRawUserModels(
  desc: SettingsDescriptor | undefined,
  route: string,
): SettingsModelProfile[] | undefined {
  if (desc === undefined) return undefined
  const providers = desc.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const routeData = providers[route] as Record<string, unknown> | undefined
  if (routeData === undefined) return undefined
  const models = routeData.models
  if (!Array.isArray(models)) return undefined
  return models as SettingsModelProfile[]
}

/**
 * Extract raw user-segment modelOverrides for a route from a settings descriptor.
 * Returns a map of model id → override fields, or undefined if absent.
 */
function getRawUserModelOverrides(
  desc: SettingsDescriptor | undefined,
  route: string,
): Record<string, Record<string, unknown>> | undefined {
  if (desc === undefined) return undefined
  const providers = desc.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const routeData = providers[route] as Record<string, unknown> | undefined
  if (routeData === undefined) return undefined
  const overrides = routeData.modelOverrides
  if (overrides === undefined || overrides === null || typeof overrides !== 'object') return undefined
  return overrides as Record<string, Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Override merge
// ---------------------------------------------------------------------------

/**
 * Fold the user's modelOverrides into the synced target; the override wins
 * per field. Overrides whose id is not in the target are user data for other
 * models — they stay in the overrides key untouched, never folded, never
 * dropped.
 */
function mergeOverrides(
  target: SettingsModelProfile[],
  overrides: Record<string, Record<string, unknown>> | undefined,
): SettingsModelProfile[] {
  if (overrides === undefined) return target
  return target.map((entry) => {
    const override = overrides[entry.id]
    if (override === undefined) return entry
    // Force the entry's own id back on: an override object that happens to
    // carry an `id` field must not silently re-key the entry in the written
    // models list.
    return { ...entry, ...override, id: entry.id } as SettingsModelProfile
  })
}

/**
 * Override ids that cannot fold into the target (no entry carries the id).
 * Sorted so the report line is deterministic.
 */
function droppedOverrideIds(
  overrides: Record<string, Record<string, unknown>> | undefined,
  mergedTarget: SettingsModelProfile[],
): string[] | undefined {
  if (overrides === undefined) return undefined
  const targetIds = new Set(mergedTarget.map((entry) => entry.id))
  return Object.keys(overrides).filter((id) => !targetIds.has(id)).sort()
}

/**
 * Resolve the overrides to fold for one route: a non-empty settings key wins
 * (a re-added key is the user's latest intent); otherwise the models-store
 * replay applies. An empty `{}` key counts as absent — the dsh validation
 * only refuses non-empty overrides beside a models list, and there is nothing
 * in it to preserve.
 */
async function resolveOverrides(
  desc: SettingsDescriptor,
  route: string,
  store: ModelsStoreAccessor | undefined,
): Promise<{
  overrides: Record<string, Record<string, unknown>> | undefined
  source: 'settings' | 'store' | undefined
}> {
  const raw = getRawUserModelOverrides(desc, route)
  if (raw !== undefined && Object.keys(raw).length > 0) {
    return { overrides: raw, source: 'settings' }
  }
  if (store !== undefined) {
    // The store read may now throw on corruption / permission failures
    // (remote-catalog readDoc propagates anything other than ENOENT). We
    // bubble it up: with no settings overrides to fall back on, the caller
    // must skip the round rather than fold an unreplayed target into
    // settings and clobber the folded values. With a settings key in play
    // (the earlier branch above) this code path is never reached, so a
    // settings-side write always proceeds and the atomic writeDoc heals the
    // corruption on its next write.
    const stored = await store.read(route)
    if (stored?.overrides !== undefined && Object.keys(stored.overrides).length > 0) {
      return { overrides: stored.overrides, source: 'store' }
    }
  }
  return { overrides: undefined, source: undefined }
}

/**
 * Stage overrides in the models-store BEFORE the mutate that unsets them
 * from settings (store-first). The read runs outside the store's serialized
 * write queue — only the merged entry write goes through the queue — so the
 * route's models/checkedAt/etag, written by the fetch earlier in this round,
 * stay intact. While the settings key is present it always wins over the
 * store (resolveOverrides order); the stored copy is only ever replayed
 * once the key is gone. Callers must treat a throw from here as "skip the
 * mutate": unsetting without a staged copy is the v0.1.5 data loss.
 *
 * The store read may now fail on corruption / permission errors (readDoc
 * propagates everything except ENOENT). Swallowing it here is intentional:
 * the settings key carries the only authoritative copy of the overrides, the
 * atomic writeDoc below replaces the (possibly corrupt) file with a fresh
 * entry that carries the overrides — which is what heals the store. The
 * fetch side will re-populate models/checkedAt/etag on its next round.
 * (A storeless call — store undefined — cannot stage anything and keeps the
 * legacy unset-without-copy behavior; production wiring in index.ts always
 * passes a store.)
 */
async function persistOverridesToStore(
  store: ModelsStoreAccessor | undefined,
  route: string,
  overrides: Record<string, Record<string, unknown>>,
): Promise<void> {
  if (store === undefined) return
  let stored: ModelsStoreEntry | undefined
  try {
    stored = await store.read(route)
  } catch (readErr: unknown) {
    // Cache lost — fall through with no cached metadata. The atomic
    // writeDoc below replaces the bad file with a fresh entry carrying
    // only the overrides. The fetch side re-populates the rest on its
    // next round. The settings key remains the authoritative source of
    // truth in the meantime.
    void readErr
  }
  await store.write(route, {
    models: stored?.models ?? [],
    checkedAt: stored?.checkedAt ?? Date.now(),
    lastModified: stored?.lastModified ?? 0,
    etag: stored?.etag,
    overrides,
  })
}

// ---------------------------------------------------------------------------
// syncToSettings (§4)
// ---------------------------------------------------------------------------

/**
 * Write translated model profiles to settings for a given route.
 *
 * Implements the full §4 protocol (revised for the modelOverrides mutual
 * exclusion):
 * 1. Get revision from describe()
 * 2. Resolve the overrides to fold: the settings key when non-empty, the
 *    models-store replay otherwise; merge into the target (override wins per
 *    field)
 * 3. Change-only write: skip when the raw user-segment models already equal
 *    the merged target — except when the settings key is present, because the
 *    models+overrides combo is refused by the llm-pi-ai validation (the
 *    set+unset must run to move the document out of the refused shape)
 * 4. Store-first: when the settings key is present, stage the raw overrides
 *    in the models-store BEFORE the mutate; a store write failure skips the
 *    mutate entirely and reports 'store-unavailable' (settings untouched —
 *    the key is never unset without a stored copy). Then call mutate with
 *    expectedRevision: one `set` on the models path, plus an `unset` on the
 *    modelOverrides path (atomic in a single mutate).
 * 5. On SETTINGS_CONFLICT: re-read, re-translate (caller's job), re-resolve
 *    the overrides from the fresh descriptor, stage again (store-first),
 *    re-write once
 *
 * @param settings  The settings service (injected, not imported)
 * @param route     The provider route id
 * @param target    Translated settings-writable entries (sorted by id)
 * @param logger    Logger for warnings/errors
 * @param retranslate  Callback to re-translate on conflict (receives new revision)
 * @param store  The models-store accessor for the overrides replay/persist
 */
export async function syncToSettings(
  settings: SettingsService | undefined,
  route: string,
  target: SettingsModelProfile[],
  logger: Logger,
  retranslate?: (newRevision: number) => Promise<SettingsModelProfile[]>,
  store?: ModelsStoreAccessor,
): Promise<SyncResult> {
  if (settings === undefined) {
    logger.debug('settings service unavailable; skip write for route %s', route)
    return { wrote: false, reason: 'skipped' }
  }

  const descriptors = settings.describe()
  const desc = descriptors.find((d) => d.ns === 'llm-pi-ai')
  if (desc === undefined) {
    logger.debug('llm-pi-ai namespace not registered; skip write for route %s', route)
    return { wrote: false, reason: 'skipped' }
  }

  const rawModels = getRawUserModels(desc, route)
  let effectiveOverrides: Record<string, Record<string, unknown>> | undefined
  let overridesSource: 'settings' | 'store' | undefined
  try {
    ({ overrides: effectiveOverrides, source: overridesSource } =
      await resolveOverrides(desc, route, store))
  } catch (readErr: unknown) {
    // The store is unreadable (corrupted JSON, EACCES, …) and settings
    // carries no overrides key — there is no authoritative source for the
    // user's folded values other than the existing settings.models. Skip
    // the round with reason 'store-unavailable': writing the raw pi.dev
    // target now would overwrite settings.models with unreplayed values
    // and silently clobber the user's fold (the same data-loss shape
    // v0.1.5 hit, just via a different path). The next refresh attempts
    // the same round again; a manual re-add of the key (or a fresh
    // successful settings-side write that heals the file) unblocks it.
    logger.warn(
      'models-store read failed for route %s: %s',
      route,
      readErr instanceof Error ? readErr.message : String(readErr),
    )
    return { wrote: false, reason: 'store-unavailable' }
  }
  const hasSettingsOverrides = overridesSource === 'settings'

  const mergedTarget = mergeOverrides(target, effectiveOverrides)

  // Change-only write (§4.4): skip when the stored models already reflect
  // target ⊕ overrides. Skipped when the settings key is present — the unset
  // must run in this mutate to clear the refused models+overrides combo, and
  // after it lands the replay keeps later rounds change-only.
  if (!hasSettingsOverrides && rawModels !== undefined && profilesEqual(rawModels, mergedTarget)) {
    logger.debug('no change for route %s; skip write', route)
    return { wrote: false, reason: 'no-change' }
  }

  const dropped = droppedOverrideIds(effectiveOverrides, mergedTarget)

  const ops: SettingsMutationOp[] = [
    { op: 'set', path: ['providers', route, 'models'], value: mergedTarget },
  ]
  if (hasSettingsOverrides) {
    ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] })
  }

  // Store-first: stage the raw overrides in the models-store BEFORE the
  // mutate that unsets them from settings. A store write failure must skip
  // the mutate entirely — unsetting without a staged copy is the v0.1.5
  // data loss — and settings stays untouched, so it remains the
  // authoritative source. Reported honestly as 'store-unavailable': the
  // mutate never ran, so 'mutate-rejected' would be a lie.
  if (hasSettingsOverrides && effectiveOverrides !== undefined) {
    try {
      await persistOverridesToStore(store, route, effectiveOverrides)
    } catch (persistErr: unknown) {
      logger.warn(
        'models-store persist failed for route %s: %s',
        route,
        persistErr instanceof Error ? persistErr.message : String(persistErr),
      )
      return { wrote: false, reason: 'store-unavailable' }
    }
  }

  try {
    await settings.mutate('llm-pi-ai', ops, desc.revision)
    return { wrote: true, reason: 'wrote', overridesSource, droppedOverrideIds: dropped }
  } catch (err: unknown) {
    // Check for SETTINGS_CONFLICT
    const code = (err as Record<string, unknown>)?.code
    if (code !== SETTINGS_CONFLICT) {
      logger.warn('mutate failed for route %s: %s', route, err instanceof Error ? err.message : String(err))
      return { wrote: false, reason: 'mutate-rejected' }
    }

    // Retry once: re-read revision, re-translate, re-write
    logger.info('SETTINGS_CONFLICT for route %s; retrying once', route)

    if (retranslate === undefined) {
      logger.warn('no retranslate callback; giving up for route %s', route)
      return { wrote: false, reason: 'conflict-retry-failed' }
    }

    try {
      const newDescriptors = settings.describe()
      const newDesc = newDescriptors.find((d) => d.ns === 'llm-pi-ai')
      if (newDesc === undefined) {
        logger.warn('llm-pi-ai namespace disappeared on retry for route %s', route)
        return { wrote: false, reason: 'conflict-retry-failed' }
      }

      const newTarget = await retranslate(newDesc.revision)
      let retry: {
        overrides: Record<string, Record<string, unknown>> | undefined
        source: 'settings' | 'store' | undefined
      }
      try {
        retry = await resolveOverrides(newDesc, route, store)
      } catch (readErr: unknown) {
        // Same fail-closed contract as the main path: with the settings key
        // gone between the two attempts, the store replay is the only way
        // to recover the fold; an unreadable store leaves the user values
        // stranded in settings.models. Skip the retry, report honestly.
        logger.warn(
          'models-store read failed for route %s on retry: %s',
          route,
          readErr instanceof Error ? readErr.message : String(readErr),
        )
        return { wrote: false, reason: 'store-unavailable' }
      }
      const retryHasSettingsOverrides = retry.source === 'settings'
      const retryMerged = mergeOverrides(newTarget, retry.overrides)
      const retryDropped = droppedOverrideIds(retry.overrides, retryMerged)

      const retryOps: SettingsMutationOp[] = [
        { op: 'set', path: ['providers', route, 'models'], value: retryMerged },
      ]
      if (retryHasSettingsOverrides) {
        retryOps.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] })
      }

      // Store-first again on the retry: the overrides were re-resolved from
      // the fresh descriptor, so stage them before the retry mutate (the
      // user may have changed or removed the key between the attempts).
      if (retryHasSettingsOverrides && retry.overrides !== undefined) {
        try {
          await persistOverridesToStore(store, route, retry.overrides)
        } catch (persistErr: unknown) {
          logger.warn(
            'models-store persist failed for route %s: %s',
            route,
            persistErr instanceof Error ? persistErr.message : String(persistErr),
          )
          return { wrote: false, reason: 'store-unavailable' }
        }
      }

      await settings.mutate('llm-pi-ai', retryOps, newDesc.revision)
      return {
        wrote: true,
        reason: 'conflict-retry-ok',
        overridesSource: retry.source,
        droppedOverrideIds: retryDropped,
      }
    } catch (retryErr: unknown) {
      logger.warn(
        'conflict retry failed for route %s: %s',
        route,
        retryErr instanceof Error ? retryErr.message : String(retryErr),
      )
      return { wrote: false, reason: 'conflict-retry-failed' }
    }
  }
}

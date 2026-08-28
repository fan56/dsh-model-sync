// Plan C (settings-seam): write translated model profiles to settings via mutate API.

/**
 * Write translated model profiles to dsh settings via the settings.mutate API.
 *
 * Key behaviors (design doc §4):
 * - Change-only writes: compare against raw user segment (desc.user), not
 *   resolved values (which have schema defaults applied)
 * - Revision conflict retry: catch SETTINGS_CONFLICT, re-read, re-translate,
 *   re-write once
 * - Never touches ~/.dsh/settings.yaml directly — only through settings.mutate
 *
 * @module dsh-model-sync/writer
 */

import type { SettingsModelProfile } from './translate.ts'

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
  reason: 'no-change' | 'wrote' | 'conflict-retry-ok' | 'conflict-retry-failed' | 'mutate-rejected' | 'skipped'
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
// syncToSettings (§4)
// ---------------------------------------------------------------------------

/**
 * Write translated model profiles to settings for a given route.
 *
 * Implements the full §4 protocol:
 * 1. Get revision from describe()
 * 2. Compare against raw user segment (change-only write)
 * 3. Merge modelOverrides into target when present
 * 4. Call mutate with expectedRevision (set models + unset overrides when needed)
 * 5. On SETTINGS_CONFLICT: re-read, re-translate (caller's job), re-write once
 *
 * @param settings  The settings service (injected, not imported)
 * @param route     The provider route id
 * @param target    Translated settings-writable entries (sorted by id)
 * @param logger    Logger for warnings/errors
 * @param retranslate  Callback to re-translate on conflict (receives new revision)
 */
export async function syncToSettings(
  settings: SettingsService | undefined,
  route: string,
  target: SettingsModelProfile[],
  logger: Logger,
  retranslate?: (newRevision: number) => Promise<SettingsModelProfile[]>,
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

  const revision = desc.revision
  const rawModels = getRawUserModels(desc, route)
  const rawOverrides = getRawUserModelOverrides(desc, route)

  // Change-only write (§4.4): skip only when models are equal AND no overrides.
  // If modelOverrides exist, we must write (merge overrides + unset the key).
  const modelsEqual = rawModels !== undefined && profilesEqual(rawModels, target)
  if (modelsEqual && rawOverrides === undefined) {
    logger.debug('no change for route %s; skip write', route)
    return { wrote: false, reason: 'no-change' }
  }

  // Merge modelOverrides into target when present.
  // Each override key is a model id; shallow-merge its fields into the matching
  // target entry. Skip overrides for ids not in target (log a warning).
  let mergedTarget = target
  if (rawOverrides !== undefined) {
    mergedTarget = target.map((entry) => {
      const override = rawOverrides[entry.id]
      if (override === undefined) return entry
      return { ...entry, ...override } as SettingsModelProfile
    })
    // Warn about overrides that reference missing target ids
    const targetIds = new Set(target.map((e) => e.id))
    for (const overrideId of Object.keys(rawOverrides)) {
      if (!targetIds.has(overrideId)) {
        logger.warn('modelOverrides contains id "%s" not in target for route %s; skipping', overrideId, route)
      }
    }
  }

  // Build ops: set models + unset overrides when overrides exist
  const ops: SettingsMutationOp[] = [
    { op: 'set', path: ['providers', route, 'models'], value: mergedTarget },
  ]
  if (rawOverrides !== undefined) {
    ops.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] })
  }

  try {
    await settings.mutate('llm-pi-ai', ops, revision)
    return { wrote: true, reason: 'wrote' }
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

      // Rebuild ops for retry (overrides may have changed)
      const newOverrides = getRawUserModelOverrides(newDesc, route)
      let retryTarget = newTarget
      if (newOverrides !== undefined) {
        retryTarget = newTarget.map((entry) => {
          const override = newOverrides[entry.id]
          if (override === undefined) return entry
          return { ...entry, ...override } as SettingsModelProfile
        })
      }
      const retryOps: SettingsMutationOp[] = [
        { op: 'set', path: ['providers', route, 'models'], value: retryTarget },
      ]
      if (newOverrides !== undefined) {
        retryOps.push({ op: 'unset', path: ['providers', route, 'modelOverrides'] })
      }

      await settings.mutate('llm-pi-ai', retryOps, newDesc.revision)
      return { wrote: true, reason: 'conflict-retry-ok' }
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

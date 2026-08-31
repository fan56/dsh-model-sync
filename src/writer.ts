// Plan C (settings-seam): write translated model profiles to settings via mutate API.

/**
 * Write translated model profiles to dsh settings via the settings.mutate API.
 *
 * Key behaviors (design doc §4):
 * - Change-only writes: compare the merged target (target ⊕ modelOverrides)
 *   against the raw user segment (desc.user), not resolved values (which have
 *   schema defaults applied)
 * - modelOverrides are the user's own per-model channel (think levels,
 *   narrowed context windows). They are preserved forever: the synced models
 *   list is written with override fields folded in, and the overrides key is
 *   never unset or edited. (Earlier versions unset the key to "migrate" the
 *   values into models, which silently wiped them on the next round once the
 *   target was regenerated from pi.dev.)
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
    return { ...entry, ...override } as SettingsModelProfile
  })
}

// ---------------------------------------------------------------------------
// syncToSettings (§4)
// ---------------------------------------------------------------------------

/**
 * Write translated model profiles to settings for a given route.
 *
 * Implements the full §4 protocol:
 * 1. Get revision from describe()
 * 2. Merge modelOverrides into the target (override wins per field); the
 *    overrides key itself is never written or deleted
 * 3. Change-only write: skip when the raw user-segment models already equal
 *    the merged target
 * 4. Call mutate with expectedRevision (single set op on the models path)
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

  const rawModels = getRawUserModels(desc, route)
  const rawOverrides = getRawUserModelOverrides(desc, route)

  const mergedTarget = mergeOverrides(target, rawOverrides)

  // Change-only write (§4.4): skip when the stored models already reflect
  // target ⊕ overrides. Because the overrides key is preserved, this stays
  // stable across rounds: once written, the merged view is re-derived
  // identically every round until pi.dev actually changes.
  if (rawModels !== undefined && profilesEqual(rawModels, mergedTarget)) {
    logger.debug('no change for route %s; skip write', route)
    return { wrote: false, reason: 'no-change' }
  }

  const ops: SettingsMutationOp[] = [
    { op: 'set', path: ['providers', route, 'models'], value: mergedTarget },
  ]

  try {
    await settings.mutate('llm-pi-ai', ops, desc.revision)
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
      const retryOps: SettingsMutationOp[] = [
        {
          op: 'set',
          path: ['providers', route, 'models'],
          value: mergeOverrides(newTarget, getRawUserModelOverrides(newDesc, route)),
        },
      ]

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

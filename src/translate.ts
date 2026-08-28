// Plan C (settings-seam): translate pi.dev entries into settings-writable profiles.

/**
 * Translate pi.dev remote catalog entries into settings-writable model profiles.
 *
 * Implements the 14 translation rules from the design doc §3.3, including:
 * - base-matching vs base-less classification (§3.4)
 * - reasoningEfforts derivation with S2 gate (§3.5)
 * - compat api gate for S5 (§3.3 rules 8/9)
 * - maxTokens classification (§3.3 rule 5)
 * - drop logic for mixed-protocol routes (§3.3 rule 13)
 * - keepBuiltinOnly behavior (§5.2)
 *
 * @module dsh-model-sync/translate
 */

import type { RemoteCatalogEntry } from './remote-catalog.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A model profile as written to settings.models (the narrow writable shape). */
export interface SettingsModelProfile {
  id: string
  name?: string
  contextWindow?: number
  input?: string[]
  maxTokens?: number
  reasoningEfforts?: Record<string, string | null>
  compat?: {
    thinkingFormat?: string
    supportsReasoningEffort?: boolean
  }
  [key: string]: unknown
}

/** Options for the translation pass. */
export interface TranslateOptions {
  /**
   * true = target list = pi.dev ∪ builtin-only ids (smooth migration, don't
   * delete existing models). false = strict mirror of pi.dev only.
   */
  keepBuiltinOnly: boolean
  /**
   * true = drop unserviceable entries and continue; false = if any entry is
   * dropped, abort the entire route (don't write).
   */
  dropUnserviceable: boolean
  /** Specific drop warnings to filter (currently unused, reserved). */
  dropWarnings: DropWarning[]
  /**
   * true = force all models with non-empty thinkingFormat to have max
   * reasoning effort. Skips S2 gate SRE check, ensures reasoningEfforts
   * contains low/high/max, and forces compat.supportsReasoningEffort=true
   * (S5 gate, openai-completions only). 400 risk is on the user.
   */
  forceMaxReasoningEffort: boolean
}

/** A warning about a dropped or degraded entry. */
export interface DropWarning {
  id: string
  route: string
  reason: string
  severity: 'drop' | 'degrade'
}

/** Result of the translation pass for one route. */
export interface TranslateResult {
  /** Settings-writable entries, sorted by id. Empty when aborted. */
  entries: SettingsModelProfile[]
  /** Ids that were dropped (with reason). */
  dropped: DropWarning[]
  /** Ids that are degraded but still written (with reason). */
  warnings: DropWarning[]
  /** true when dropUnserviceable=false and drops exist — entries must not be written. */
  aborted: boolean
}

// ---------------------------------------------------------------------------
// THINKING_LEVELS whitelist (§3.5)
// ---------------------------------------------------------------------------

/** Allowed thinking level keys and their valid wire-spelling constraints. */
const THINKING_LEVELS = new Set([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/**
 * Builtin catalog data per route: needed for base-matching classification,
 * maxTokens stripping, and api-gate resolution.
 */
export interface BuiltinModelData {
  id: string
  api: string
  maxTokens?: number
}

// ---------------------------------------------------------------------------
// Core translation
// ---------------------------------------------------------------------------

/**
 * Translate a route's pi.dev entries into settings-writable profiles.
 *
 * @param entries   Raw entries from pi.dev for this route
 * @param builtinIds  Set of model ids present in the installed builtin catalog for this route
 * @param builtinData  Array of builtin catalog data (id, api, maxTokens) for this route
 * @param route     The route id (e.g. 'opencode-go')
 * @param options   Translation options
 * @param builtinOnlyEntries  Entries from builtin catalog that are not in pi.dev (for keepBuiltinOnly)
 */
export function translateEntries(
  entries: RemoteCatalogEntry[],
  builtinIds: Set<string>,
  builtinData: BuiltinModelData[],
  route: string,
  options: TranslateOptions,
  builtinOnlyEntries?: RemoteCatalogEntry[],
): TranslateResult {
  const dropped: DropWarning[] = []
  const warnings: DropWarning[] = []
  const result: SettingsModelProfile[] = []

  // Compute the set of distinct apis in the builtin snapshot for this route.
  // Used to detect mixed-protocol routes (§3.3 rule 13): base-less entries on
  // a route where builtin models use >1 api cannot be addressed.
  const builtinApis = new Set(builtinData.map((b) => b.api))

  for (const entry of entries) {
    const isBaseMatching = builtinIds.has(entry.id)
    const builtin = builtinData.find((b) => b.id === entry.id)

    // Determine resolved api for compat gate (rules 8/9):
    // Use builtin api if base-matching, otherwise the entry's own api
    const resolvedApi = isBaseMatching && builtin ? builtin.api : entry.api

    // Rule 13: drop base-less entries when they truly have no api
    if (!isBaseMatching && (!entry.api || entry.api === '')) {
      dropped.push({
        id: entry.id,
        route,
        reason: `base-less entry "${entry.id}" has no api — cannot resolve`,
        severity: 'drop',
      })
      continue
    }

    // Rule 13 (extended): drop base-less entries on mixed-protocol routes.
    // When builtin models use >1 api, a base-less entry has no addressable api
    // because the route is ambiguous — the runtime can't pick the right adapter.
    if (!isBaseMatching && builtinApis.size > 1) {
      dropped.push({
        id: entry.id,
        route,
        reason: `base-less entry "${entry.id}" on a mixed-protocol route has no addressable api`,
        severity: 'drop',
      })
      continue
    }

    // Rule 1: id (always written)
    const profile: SettingsModelProfile = { id: entry.id }

    // Rule 2: name
    if (entry.name !== undefined) profile.name = entry.name

    // Rule 3: contextWindow
    if (entry.contextWindow !== undefined) profile.contextWindow = entry.contextWindow

    // Rule 4: input (modalities)
    if (entry.input !== undefined && entry.input.length > 0) {
      profile.input = [...entry.input]
    }

    // Rule 5: maxTokens — base-matching: strip; base-less: keep
    if (!isBaseMatching && entry.maxTokens !== undefined) {
      profile.maxTokens = entry.maxTokens
    }
    // base-matching: don't write maxTokens (pi-ai falls back to catalog value)

    // Rule 6: reasoning (boolean) — never write
    // Rule 7: reasoningEfforts — derive with S2 gate
    const thinkingFormat = entry.compat?.thinkingFormat
    const supportsRE = entry.compat?.supportsReasoningEffort
    // S2 gate: thinkingFormat non-empty AND (forceMaxReasoningEffort OR supportsReasoningEffort !== false)
    if (thinkingFormat !== undefined && thinkingFormat !== '' && (options.forceMaxReasoningEffort || supportsRE !== false)) {
      // Derive reasoningEfforts as dict (§3.5)
      profile.reasoningEfforts = deriveReasoningEfforts(entry, options.forceMaxReasoningEffort)
    }

    // Rules 8/9: compat.thinkingFormat / compat.supportsReasoningEffort
    // S5 gate: only write when resolved api === 'openai-completions'
    if (resolvedApi === 'openai-completions') {
      const compat: Record<string, unknown> = {}
      if (entry.compat?.thinkingFormat !== undefined) {
        compat.thinkingFormat = entry.compat.thinkingFormat
      }
      if (entry.compat?.supportsReasoningEffort !== undefined) {
        compat.supportsReasoningEffort = entry.compat.supportsReasoningEffort
      }
      // force mode: override supportsReasoningEffort to true (only when thinkingFormat is present)
      if (options.forceMaxReasoningEffort && entry.compat?.thinkingFormat) {
        compat.supportsReasoningEffort = true
      }
      if (Object.keys(compat).length > 0) {
        profile.compat = compat as SettingsModelProfile['compat']
      }
    }
    // else: drop the compat keys (don't drop the entry itself)

    // Rules 10-12: other compat keys, api/baseUrl/provider per entry, cost/etc — never write

    // Rule 14: api-divergent entries must be written (accept protocol override)
    if (isBaseMatching && builtin && entry.api !== builtin.api) {
      warnings.push({
        id: entry.id,
        route,
        reason: `api divergence: pi.dev=${entry.api} vs installed=${builtin.api} — written, protocol will use installed`,
        severity: 'degrade',
      })
    }

    result.push(profile)
  }

  // keepBuiltinOnly: merge in builtin-only entries (§5.2)
  // Emit minimal {id} only — the adapter's ...base spread restores all fields.
  if (options.keepBuiltinOnly && builtinOnlyEntries !== undefined) {
    for (const entry of builtinOnlyEntries) {
      // Already present in pi.dev list? Skip (shouldn't happen, but guard)
      if (result.some((r) => r.id === entry.id)) continue

      // Minimal profile: only id. All other fields come from ...base at runtime.
      result.push({ id: entry.id })
    }
  }

  // Sort by id for stable output (§4.4)
  result.sort((a, b) => a.id.localeCompare(b.id))

  // If dropUnserviceable is false and there are drops, return empty (don't write)
  if (!options.dropUnserviceable && dropped.length > 0) {
    return { entries: [], dropped, warnings, aborted: true }
  }

  return { entries: result, dropped, warnings, aborted: false }
}

// ---------------------------------------------------------------------------
// Derive reasoningEfforts (§3.5)
// ---------------------------------------------------------------------------

/**
 * Derive reasoningEfforts dict from a pi.dev entry.
 *
 * Schema requires dict: z.dict(z.union([z.string(), z.null()]), z.union(THINKING_LEVELS)).
 * Key = effort level, value = wire spelling (string|null).
 *
 * We derive from thinkingLevelMap when available, otherwise produce a minimal
 * two-level dict with low/high using the effort name as wire spelling.
 *
 * Design doc §3.5: "dict { low: '<wire>', high: '<wire>' } — value is wire
 * spelling, not level name; may include off: null"
 *
 * @param entry  The pi.dev entry
 * @param force  When true, ensure low/high/max are all present in the result
 */
function deriveReasoningEfforts(entry: RemoteCatalogEntry, force: boolean): Record<string, string | null> {
  const tlm = entry.thinkingLevelMap
  if (tlm !== undefined && Object.keys(tlm).length > 0) {
    // Filter: only keep keys in THINKING_LEVELS whitelist with non-empty string values
    const filtered: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(tlm)) {
      if (!THINKING_LEVELS.has(k)) continue
      if (typeof v === 'string' && v.length > 0) {
        filtered[k] = v
      }
    }
    // If filtering left only 'off' (or empty), supplement with low/high defaults
    const nonOffKeys = Object.keys(filtered).filter((k) => k !== 'off')
    if (nonOffKeys.length === 0) {
      const base: Record<string, string | null> = { low: 'low', high: 'high' }
      if (force) base.max = 'max'
      return base
    }
    // force mode: ensure low/high/max are present
    if (force) {
      if (!filtered.low) filtered.low = 'low'
      if (!filtered.high) filtered.high = 'high'
      if (!filtered.max) filtered.max = 'max'
    }
    return filtered
  }
  // Fallback: minimal two-level dict (low/high)
  const base: Record<string, string | null> = { low: 'low', high: 'high' }
  if (force) base.max = 'max'
  return base
}

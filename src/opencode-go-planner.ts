// P1a pure planner: official opencode-go records + current route state +
// ownership ledger → a settings-independent write plan.
//
// Hard boundary (design 07 §6.2.1): this module does no I/O, never calls
// settings.mutate, never touches credentials, and never schedules timers. The
// caller in P1b turns the returned plan into settings operations. Everything
// here is a pure function of its inputs so it can be exercised with offline
// fixtures only.
//
// Design refs: §2.1/§6.2.2 (route fields + msg baseURL normalization),
// §6.2.3 (grouping), §6.2.4 (ownership-aware merge), §6.2.5 (route fields),
// §9.2-9.4 (keep the name, conflicts, empty routes), ADR-004 (ledger keyed
// by keyFingerprint), ADR-005 (deletion gates). F25 is intentionally absent:
// report 19 proved the host injects x-opencode-session, so no special header
// handling belongs in the plan.

import { createHash } from 'node:crypto'
import type { SettingsModelProfile } from './translate.ts'
import type { GoModelRecord } from './opencode-go-source.ts'
import { deriveKeyRef } from './route-credential.ts'
import {
  GO_SLOT_ROUTES,
  groupGoModelsByProtocol,
  type GoRouteSlot,
} from './opencode-go-grouping.ts'

// ---------------------------------------------------------------------------
// Static route-field plan (design §2.1 / §6.2.2, confirmed by report 19)
// ---------------------------------------------------------------------------

/** Host `api` value per slot (llm-pi-ai PROTOCOLS, report 19 §1). */
export const GO_API_BY_SLOT: Readonly<Record<GoRouteSlot, string>> = {
  chat: 'openai-completions',
  msg: 'anthropic-messages',
  resp: 'openai-responses',
  google: 'google-generative-ai',
}

/** The only display field the host uses to group providers (F22/13). */
export const GO_DISPLAY_NAME_BY_SLOT: Readonly<Record<GoRouteSlot, string>> = {
  chat: 'OpenCode Go',
  msg: 'OpenCode Go · msg',
  resp: 'OpenCode Go · resp',
  google: 'OpenCode Go · google',
}

/**
 * Fallback host baseURLs — the values report 19 confirmed end-to-end. Normally
 * the baseURL comes from the official payload (§6.2.2); these are used only
 * when a record carries no per-protocol `base_url`.
 */
export const GO_BASE_URL_BY_SLOT: Readonly<Record<GoRouteSlot, string>> = {
  chat: 'https://opencode.ai/inference/go/openai/v1',
  msg: 'https://opencode.ai/inference/go/anthropic',
  resp: 'https://opencode.ai/inference/go/openai/v1',
  google: 'https://opencode.ai/inference/go/google/v1beta',
}

/** Official protocol keys that back each slot (§6.2.2 table). */
export const GO_PROTOCOLS_BY_SLOT: Readonly<Record<GoRouteSlot, readonly string[]>> = {
  chat: ['chat-completions'],
  msg: ['messages'],
  resp: ['responses'],
  google: ['interactions', 'generate-content'],
}

/**
 * Normalize an official `base_url` for host use. Only `msg` changes: pi-ai
 * calls `beta.messages.create` and appends `/v1/messages?beta=true`, so the
 * trailing `/v1` must be stripped (ADR-003 / report 19 negative control).
 */
export function normalizeGoBaseUrl(raw: string, slot: GoRouteSlot): string {
  const trimmed = raw.replace(/\/+$/, '')
  if (slot === 'msg' && trimmed.endsWith('/v1')) return trimmed.slice(0, -3)
  return trimmed
}

export interface GoPlannedRouteFields {
  api: string
  baseURL: string
  displayName: string
  apiKeyEnv: string
}

/**
 * Build the route fields for a slot from the payload's per-protocol base_url.
 * `ref` defaults to the P0-derived `OPENCODE_GO_API_KEY`.
 */
export function planGoRouteFields(
  slot: GoRouteSlot,
  entries: readonly GoModelRecord[],
  ref: string = deriveKeyRef('opencode-go'),
): GoPlannedRouteFields {
  const protocols = GO_PROTOCOLS_BY_SLOT[slot]
  let raw: string | undefined
  for (const entry of entries) {
    for (const protocol of protocols) {
      const base = entry.baseUrls[protocol]
      if (base !== undefined && base.length > 0) {
        raw = base
        break
      }
    }
    if (raw !== undefined) break
  }
  return {
    api: GO_API_BY_SLOT[slot],
    baseURL: raw !== undefined ? normalizeGoBaseUrl(raw, slot) : GO_BASE_URL_BY_SLOT[slot],
    displayName: GO_DISPLAY_NAME_BY_SLOT[slot],
    apiKeyEnv: ref,
  }
}

// ---------------------------------------------------------------------------
// Model mapping (design §6.1 field mapping)
// ---------------------------------------------------------------------------

/** Effort keys the host schema accepts (mirrors translate.ts THINKING_LEVELS). */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Official GoModelRecord → host SettingsModelProfile. `created` never enters. */
export function mapGoModelToProfile(entry: GoModelRecord): SettingsModelProfile {
  const profile: SettingsModelProfile = { id: entry.id }
  if (entry.name.length > 0) profile.name = entry.name
  if (entry.contextWindow !== undefined) profile.contextWindow = entry.contextWindow
  if (entry.maxOutput !== undefined) profile.maxTokens = entry.maxOutput
  if (entry.inputModalities.length > 0) profile.input = [...entry.inputModalities]
  if (entry.reasoning !== undefined && entry.reasoning.efforts.length > 0) {
    const efforts: Record<string, string | null> = {}
    for (const effort of entry.reasoning.efforts) {
      if (THINKING_LEVELS.has(effort)) efforts[effort] = effort
    }
    if (Object.keys(efforts).length > 0) profile.reasoningEfforts = efforts
  }
  return profile
}

// ---------------------------------------------------------------------------
// Ownership ledger (ADR-004: keyed by <route>#<keyFingerprint>)
// ---------------------------------------------------------------------------

export interface GoManagedModel {
  /** Hash of the profile the plugin last wrote for this id. */
  hash: string
}

export interface GoOwnershipEntry {
  /** Route fields the plugin last wrote (used to recognize a fully-owned route). */
  routeFields?: Partial<GoPlannedRouteFields>
  /** Plugin-managed model ids and the hash of their last written profile. */
  managed: Record<string, GoManagedModel>
}

export type GoOwnershipLedger = Readonly<Record<string, GoOwnershipEntry>>

/** Ledger key: one route's ownership is invisible under a different key. */
export function goOwnershipKey(route: string, keyFingerprint: string): string {
  return `${route}#${keyFingerprint}`
}

/** The raw current state of one provider route in settings. */
export interface GoRouteState {
  exists: boolean
  api?: string
  baseURL?: string
  displayName?: string
  apiKeyEnv?: string
  /** Raw models array (no schema defaults applied). */
  models: readonly SettingsModelProfile[]
  /** Ids covered by a non-empty modelOverrides key on this route. */
  overrideIds?: readonly string[]
}

// ---------------------------------------------------------------------------
// Plan output
// ---------------------------------------------------------------------------

export interface GoRouteConflict {
  slot: GoRouteSlot
  route: string
  field: 'api' | 'baseURL' | 'apiKeyEnv'
  expected: string
  actual: string
  reason: string
}

export type GoPlanReportLevel = 'info' | 'warn' | 'error'

export interface GoPlanReportEntry {
  level: GoPlanReportLevel
  /** Stable machine code (e.g. route-conflict, kept-user-owned, unknown-protocol). */
  code: string
  route?: string
  slot?: GoRouteSlot
  id?: string
  message: string
}

export interface GoPlannedRoute {
  slot: GoRouteSlot
  route: string
  fields: GoPlannedRouteFields
  /** Complete merged models array, sorted by id (never an empty write — see unset/skip). */
  models: SettingsModelProfile[]
  /** Empty and fully plugin-managed: caller should unset providers.<route>. */
  unset: boolean
  /** Conflict, empty main route, or empty route with user content: write nothing. */
  skip: boolean
}

export interface GoPlanResult {
  routes: GoPlannedRoute[]
  /** Routes the caller should unset (never paired with `models: []`). */
  unsetRoutes: string[]
  conflicts: GoRouteConflict[]
  report: GoPlanReportEntry[]
  /** Shallow copy of the ledger updated only for this key's routes. */
  nextOwnership: Record<string, GoOwnershipEntry>
}

export interface GoPlannerOptions {
  /** sha256(key) first 16 hex from the source result; '-' when no key. */
  keyFingerprint: string
  entries: readonly GoModelRecord[]
  /** Current state of the go routes, keyed by route id. */
  currentRoutes: Readonly<Record<string, GoRouteState>>
  ownership: GoOwnershipLedger
  /** go.ref; defaults to P0's deriveKeyRef('opencode-go'). */
  ref?: string
  /** go.routes overrides (default GO_SLOT_ROUTES). */
  routes?: Partial<Record<GoRouteSlot, string>>
  /** go.pinnedModels — protected from deletion (design A4). */
  pinnedModels?: readonly string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return out
}

/** Stable hash of a settings profile — the "现值哈希" of the deletion gates. */
export function profileHash(profile: SettingsModelProfile): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(profile))).digest('hex')
}

const OWNERSHIP_FIELDS = ['api', 'baseURL', 'apiKeyEnv'] as const

/** A current route conflicts only when a field is explicitly set to a different value. */
function detectConflict(
  slot: GoRouteSlot,
  route: string,
  fields: GoPlannedRouteFields,
  current: GoRouteState | undefined,
): GoRouteConflict | undefined {
  if (current === undefined || !current.exists) return undefined
  for (const field of OWNERSHIP_FIELDS) {
    const actual = current[field]
    if (actual !== undefined && actual !== '' && actual !== fields[field]) {
      return {
        slot,
        route,
        field,
        expected: fields[field],
        actual,
        reason: 'existing route field differs from plan; keep name, skip write (design §9.3)',
      }
    }
  }
  return undefined
}

function ownedFieldsMatch(
  owned: GoOwnershipEntry | undefined,
  fields: GoPlannedRouteFields,
): boolean {
  if (owned === undefined || owned.routeFields === undefined) return false
  return OWNERSHIP_FIELDS.every((field) => owned.routeFields![field] === fields[field])
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

/**
 * Build the write plan. Pure: identical inputs always produce an identical
 * plan (report/order included). No mutation of `options` or its nested values.
 */
export function planGoRoutes(options: GoPlannerOptions): GoPlanResult {
  const ref = options.ref ?? deriveKeyRef('opencode-go')
  const routes: Record<GoRouteSlot, string> = { ...GO_SLOT_ROUTES, ...(options.routes ?? {}) }
  const pinned = new Set(options.pinnedModels ?? [])
  const grouping = groupGoModelsByProtocol(options.entries)
  const report: GoPlanReportEntry[] = []
  const conflicts: GoRouteConflict[] = []
  const plannedRoutes: GoPlannedRoute[] = []
  const unsetRoutes: string[] = []
  const nextOwnership: Record<string, GoOwnershipEntry> = { ...options.ownership }

  // Unknown / otherwise unsupported protocols are fail-closed: reported, never
  // written (design §6.2.3, V1).
  for (const unassigned of grouping.unassigned) {
    report.push({
      level: 'warn',
      code: unassigned.reason,
      id: unassigned.id,
      message: `model ${unassigned.id} not assigned (${unassigned.protocols.join(',') || 'no protocols'})`,
    })
  }

  const entryById = new Map(options.entries.map((entry) => [entry.id, entry]))

  for (const slot of ['chat', 'msg', 'resp', 'google'] as const) {
    const desiredIds = grouping.slots[slot] ?? []
    const route = routes[slot]
    const current = options.currentRoutes[route]
    const ledgerKey = goOwnershipKey(route, options.keyFingerprint)
    const owned = options.ownership[ledgerKey]

    // Google slot is conditional and default-off (design §2.1): materialize it
    // only when it has members, or when there is a previous ledger to clean up.
    if (slot === 'google' && desiredIds.length === 0 && owned === undefined) continue

    const slotEntries = desiredIds
      .map((id) => entryById.get(id))
      .filter((entry): entry is GoModelRecord => entry !== undefined)
    const fields = planGoRouteFields(slot, slotEntries, ref)

    // Empty group: never produce a `models: []` write (§9.4 / A9). Unset a
    // fully plugin-managed route, otherwise skip (keeping the route as-is) and
    // report. A slot with no route at all is not planned at all.
    if (desiredIds.length === 0) {
      const currentModels = current?.models ?? []
      if (current === undefined || !current.exists) continue
      if (slot === 'chat') {
        // §9.4: an empty main route after a 200 is an upstream anomaly — keep
        // last-good, write nothing.
        plannedRoutes.push({ slot, route, fields, models: [...currentModels], unset: false, skip: true })
        report.push({ level: 'warn', code: 'upstream-empty', route, slot, message: 'main route has no members; kept last-good, no write' })
        continue
      }
      const managed = owned?.managed ?? {}
      const fullyManaged = owned !== undefined
        && currentModels.length > 0
        && currentModels.every((model) => {
          const record = managed[model.id]
          return record !== undefined && record.hash === profileHash(model)
        })
        && ownedFieldsMatch(owned, fields)
      if (fullyManaged) {
        plannedRoutes.push({ slot, route, fields, models: [], unset: true, skip: false })
        unsetRoutes.push(route)
        report.push({ level: 'info', code: 'unset-route', route, slot, message: `route ${route} is empty and fully plugin-managed; unset` })
        delete nextOwnership[ledgerKey]
      } else {
        plannedRoutes.push({ slot, route, fields, models: [...currentModels], unset: false, skip: true })
        if (currentModels.length > 0) {
          report.push({ level: 'warn', code: 'route-empty-has-user-content', route, slot, message: `route ${route} is empty but has user content; kept, no empty write` })
        }
      }
      continue
    }

    const conflict = detectConflict(slot, route, fields, current)
    if (conflict !== undefined) {
      conflicts.push(conflict)
      report.push({
        level: 'error',
        code: 'route-conflict',
        route,
        slot,
        message: `${route}.${conflict.field} is ${conflict.actual}, expected ${conflict.expected}`,
      })
      continue
    }

    const desiredById = new Map<string, SettingsModelProfile>()
    for (const id of desiredIds) {
      const entry = entryById.get(id)
      if (entry !== undefined) desiredById.set(id, mapGoModelToProfile(entry))
    }

    const currentModels = current?.models ?? []
    const managed = owned?.managed ?? {}
    const nextManaged: Record<string, GoManagedModel> = {}
    const kept: SettingsModelProfile[] = []

    for (const model of currentModels) {
      const id = model.id
      const desired = desiredById.get(id)
      const record = managed[id]
      const hashMatches = record !== undefined && record.hash === profileHash(model)
      const hasOverride = (current?.overrideIds ?? []).includes(id)
      const isPinned = pinned.has(id)

      if (desired !== undefined) {
        if (record !== undefined && hashMatches) {
          // Plugin-owned and untouched: overwrite with the freshly mapped value.
          const next = desired
          nextManaged[id] = { hash: profileHash(next) }
          kept.push(next)
          report.push({ level: 'info', code: 'overwrote-managed', route, slot, id, message: `refreshed plugin-managed model ${id}` })
        } else {
          // Not in ledger, or hash differs (user edited): keep as-is, never claim.
          kept.push(model)
          if (record !== undefined) nextManaged[id] = record
          report.push({
            level: 'info',
            code: 'kept-user-owned',
            route,
            slot,
            id,
            message: record !== undefined ? `model ${id} was modified; kept user value` : `model ${id} is user-owned; kept`,
          })
        }
        continue
      }

      // Not desired: the three deletion gates (ADR-005 / §6.2.4).
      if (record !== undefined && hashMatches && !hasOverride && !isPinned) {
        report.push({ level: 'info', code: 'deletion-candidate', route, slot, id, message: `model ${id} passed all three deletion gates` })
        continue
      }
      kept.push(model)
      if (record !== undefined) nextManaged[id] = record
      const code = record === undefined
        ? 'kept-user-owned'
        : !hashMatches
          ? 'kept-modified'
          : hasOverride
            ? 'kept-override'
            : 'kept-pinned'
      report.push({ level: 'info', code, route, slot, id, message: `model ${id} kept (${code}); not removed` })
    }

    // New desired ids (absent from settings) are added and claimed.
    const currentIds = new Set(currentModels.map((model) => model.id))
    for (const id of desiredIds) {
      if (currentIds.has(id)) continue
      const profile = desiredById.get(id)
      if (profile === undefined) continue
      nextManaged[id] = { hash: profileHash(profile) }
      kept.push(profile)
      report.push({ level: 'info', code: 'added', route, slot, id, message: `added model ${id}` })
    }

    // `desiredIds` is non-empty here, so the merged array is never empty.
    const merged = [...kept].sort((a, b) => a.id.localeCompare(b.id))
    plannedRoutes.push({ slot, route, fields, models: merged, unset: false, skip: false })
    nextOwnership[ledgerKey] = { routeFields: fields, managed: nextManaged }
  }

  return { routes: plannedRoutes, unsetRoutes, conflicts, report, nextOwnership }
}

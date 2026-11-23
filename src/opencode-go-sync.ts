// P1c orchestration: one opencode-go sync round = source → planner → writer.
//
// The three layers stay separate (design §6.2.1): the source owns the network
// read, the planner is pure, the writer owns the only settings write path.
// This module adds only glue + report formatting. Every I/O dependency
// (settings, ledger store, override store, fetch, logger) is injected, so the
// whole round can be exercised offline with mocks and a temp-dir store.
//
// No timer lives here (P1c-2 owns scheduling). No command registration lives
// here either (index.ts owns the cordis/command surface). No credentials are
// read here — the caller resolves the key value through the existing cordis
// credential seam and passes it in.

import { GO_SLOT_ROUTES, type GoRouteSlot } from './opencode-go-grouping.ts'
import { goOwnershipKey, planGoRoutes, type GoOwnershipEntry, type GoOwnershipLedger, type GoRouteState } from './opencode-go-planner.ts'
import { fetchGoOfficialModels, type GoFetchLike, type GoSourceResult } from './opencode-go-source.ts'
import {
  writeGoPlan,
  type GoCanWriteDecision,
  type GoOverrideStorer,
  type GoOwnershipStore,
  type GoWriteResult,
} from './opencode-go-writer.ts'
import type { SettingsModelProfile } from './translate.ts'
import type { Logger, SettingsDescriptor, SettingsService } from './writer.ts'
import { routeWriter, type MigrationStatus } from './opencode-go-migration.ts'

/**
 * Cordis service names used only as injection seams. Both are optional:
 * production falls back to the real file store and the global fetch; tests
 * register a temp-dir store / stub fetch under these names to run a full round
 * with zero filesystem writes outside a temp dir and zero network.
 */
export const GO_OWNERSHIP_STORE_SERVICE = 'goOwnershipStore'
export const GO_OVERRIDE_STORER_SERVICE = 'goOverrideStorer'
export const GO_FETCH_SERVICE = 'goFetchImpl'

/** The go subset of the published Config contract (design §6.2.6). */
export interface GoSyncRuntimeConfig {
  /** Master switch (design §6.2.6: false = zero behavior change). */
  enabled: boolean
  ref: string
  modelsUrl: string
  routes: Partial<Record<GoRouteSlot, string>>
  pinnedModels: readonly string[]
  confirmRemovals: number
  adoptExisting: boolean
}

export interface GoRoundDeps {
  settings: SettingsService | undefined
  ownershipStore: GoOwnershipStore
  overrideStorer?: GoOverrideStorer
  logger: Logger
  config: GoSyncRuntimeConfig
  /** Resolved credential VALUE; undefined/empty means no request and no write (V4). */
  apiKey?: string
  /** Injectable network; production falls back to the global fetch in the source. */
  fetchImpl?: GoFetchLike
  /** Deterministic clock for tests. */
  observedAt?: number
  /** Plugin-lifetime signal; aborted mid-round stops the fetch and blocks the writer. */
  signal?: AbortSignal
  /**
   * Current migration status (§14.1). Defaults to `absent` for direct unit
   * callers that only exercise writer mechanics; the production wiring in
   * index.ts always passes the real status read from the settings + record.
   */
  migration?: MigrationStatus
  /**
   * §14.7.5: re-read the PERSISTED migration status for the second gate, called
   * before every mutate. Production passes `loadMigrationStatus`; without it
   * there is NO second gate (pure writer-mechanics callers) — the round-level
   * snapshot is never reused. A failed re-read is reported as
   * `canWrite-unavailable` and skips the route (fail closed).
   */
  reloadMigration?: () => Promise<MigrationStatus>
  /** §14.7.4: forward the post-own-write managed ids to the record persister. */
  onOwnWrite?: (route: string, managedIds: string[]) => Promise<void>
}

export type GoRoundReason =
  | 'disabled'
  | 'settings-unavailable'
  | 'no-key'
  | 'source-failed'
  | 'aborted'
  | 'migration-gate'
  | 'settings-changed-during-sync'
  | 'completed'

export interface GoSyncRoundResult {
  ok: boolean
  reason: GoRoundReason
  source?: GoSourceResult
  write?: GoWriteResult
  /**
   * B4 (31, design §14.7.5): set only when the host settings document revision
   * moved while the official catalog request was in flight, i.e. the round was
   * abandoned before building a plan/writing anything. Machine-readable
   * companion to the user-visible `text` (no write, no ledger/fingerprint).
   */
  settingsChanged?: { beforeRevision: number; afterRevision: number }
  /** Human-readable lines for `/model-sync` and the auto-round logger. */
  text: string
}

function llmDescriptor(settings: SettingsService | undefined): SettingsDescriptor | undefined {
  return settings?.describe().find((desc) => desc.ns === 'llm-pi-ai')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Raw current state of one route (no schema defaults — hashes must match the writer's). */
function readRouteState(desc: SettingsDescriptor | undefined, route: string): GoRouteState {
  const providers = desc?.user?.providers
  const data = isRecord(providers) ? providers[route] : undefined
  if (!isRecord(data)) return { exists: false, models: [] }
  const models = Array.isArray(data.models) ? data.models as SettingsModelProfile[] : []
  const overrideIds = isRecord(data.modelOverrides) ? Object.keys(data.modelOverrides) : []
  const state: GoRouteState = { exists: true, models, overrideIds }
  for (const field of ['api', 'baseURL', 'displayName', 'apiKeyEnv'] as const) {
    const value = data[field]
    if (typeof value === 'string') state[field] = value
  }
  return state
}

/** Round stopped by a plugin-unload abort: last-good settings are untouched. */
function abortedResult(source: GoSourceResult): GoSyncRoundResult {
  return {
    ok: false,
    reason: 'aborted',
    source,
    text: 'opencode-go: round aborted (plugin unload); kept last-good, no settings write',
  }
}

/**
 * B4: the user edited settings while the /v1/models request was in flight.
 * The pre-fetch descriptor is stale, so the round is discarded in full — no
 * settings mutate, no ledger commit, no fingerprint update — and a later round
 * re-reads current settings and retries. Never reuse the stale plan here.
 */
function settingsChangedResult(source: GoSourceResult, beforeRevision: number, afterRevision: number): GoSyncRoundResult {
  return {
    ok: false,
    reason: 'settings-changed-during-sync',
    source,
    settingsChanged: { beforeRevision, afterRevision },
    text: [
      `opencode-go: settings changed during the /v1/models fetch (llm-pi-ai revision ${beforeRevision} -> ${afterRevision}); discarding this round`,
      '  user edits were kept as-is: no settings write, no ownership ledger change, no fingerprint update',
      '  the next round re-reads the current settings and retries normally',
    ].join('\n'),
  }
}

/**
 * Read only this key's ledger slots. A slot that cannot be read is treated as
 * absent — the writer then refuses to delete (no hash), the safe direction.
 */
async function readOwnership(
  store: GoOwnershipStore,
  fingerprint: string,
  routes: readonly string[],
): Promise<GoOwnershipLedger> {
  const ledger: Record<string, GoOwnershipEntry> = {}
  for (const route of new Set(routes)) {
    const key = goOwnershipKey(route, fingerprint)
    try {
      const entry = await store.read(key)
      if (entry !== undefined) ledger[key] = entry
    } catch {
      // No ledger for this route this round → never delete.
    }
  }
  return ledger
}

/** One complete go round. Never throws for expected source/store failures. */
export async function runGoSyncRound(deps: GoRoundDeps): Promise<GoSyncRoundResult> {
  const { settings, ownershipStore, logger, config } = deps
  const routes = { ...GO_SLOT_ROUTES, ...(config.routes ?? {}) }
  const desc = llmDescriptor(settings)

  if (!config.enabled) {
    return {
      ok: false,
      reason: 'disabled',
      text: 'opencode-go sync is disabled — set opencode.go.enabled=true to write its routes (design §6.2.6: zero behavior change by default)',
    }
  }

  if (settings === undefined || desc === undefined) {
    return {
      ok: false,
      reason: 'settings-unavailable',
      text: 'opencode-go: skipped — settings service / llm-pi-ai namespace unavailable; no request, no write',
    }
  }

  const apiKey = typeof deps.apiKey === 'string' ? deps.apiKey.trim() : ''
  if (apiKey === '') {
    return {
      ok: false,
      reason: 'no-key',
      text: `opencode-go: skipped — no credential value for ${config.ref}; no /v1/models request sent, no settings write (design V4)`,
    }
  }

  // M-4 migration gate + single writer (§14.6 / §14.7, ADR-008). All go routes
  // share one authority decision; when none of them may be written the round
  // short-circuits BEFORE the source fetch (zero side effects, explicit report).
  const migration: MigrationStatus = deps.migration ?? {
    state: 'absent', fingerprint: '', identity: '', applying: false,
    fingerprintHealed: false, expectedFingerprint: '',
  }
  const authority = { caller: 'go' as const, goEnabled: config.enabled, goRoutes: Object.values(routes) }
  const decisions = Object.values(routes).map((route) => ({ route, decision: routeWriter(route, authority, migration) }))
  const blocked = decisions.filter((entry) => entry.decision.decision === 'skip')
  if (blocked.length === decisions.length) {
    return {
      ok: false,
      reason: 'migration-gate',
      text: [
        'opencode-go: migration gate — zero settings writes, no /v1/models request',
        ...blocked.map(({ route, decision }) => `  [info] ${decision.reason}; route=${route}`),
      ].join('\n'),
    }
  }

  // B4 (31, design §14.7.5): snapshot the host settings document revision
  // BEFORE the network wait. This is only a baseline for the post-fetch
  // freshness check below — never a source for the write plan itself.
  const preFetchRevision = desc.revision

  let source: GoSourceResult
  try {
    source = await fetchGoOfficialModels({
      url: config.modelsUrl,
      apiKey,
      fetchImpl: deps.fetchImpl,
      observedAt: deps.observedAt,
      signal: deps.signal,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'source-failed', text: `opencode-go: source error — ${message}; no settings write` }
  }

  if (!source.ok) {
    const error = source.error
    return {
      ok: false,
      reason: 'source-failed',
      source,
      text: `opencode-go: source failed (${error?.kind ?? 'unknown'}${error?.status !== undefined ? ` HTTP ${error.status}` : ''}) — ${error?.message ?? 'unknown error'}; kept last-good, no settings write`,
    }
  }

  // The plugin may be disposed while the source request (or the ownership
  // reads below) is in flight. Never reach the writer after unload (§6.3 卸载).
  if (deps.signal?.aborted) return abortedResult(source)

  // B4: re-read the descriptor AFTER the fetch. The plan must describe the
  // settings we are about to write, not the snapshot used to build the
  // request. If the host revision moved during the request window a user edit
  // landed here; writing the pre-fetch plan would silently drop it (no even
  // SETTINGS_CONFLICT, because the writer's own re-read only sees the new
  // revision, not the stale merged models). Discard the whole round instead.
  const freshDesc = llmDescriptor(settings)
  if (freshDesc === undefined) {
    return {
      ok: false,
      reason: 'settings-unavailable',
      source,
      text: 'opencode-go: llm-pi-ai descriptor disappeared during the fetch; no settings write',
    }
  }
  if (freshDesc.revision !== preFetchRevision) {
    return settingsChangedResult(source, preFetchRevision, freshDesc.revision)
  }

  // Plan from the post-fetch descriptor so the write target and the plan are
  // the same object (design §14.7.5). No revision bump → no user edit in the
  // window → the freshly read state is the correct planning input.
  const currentRoutes = Object.fromEntries(
    Object.values(routes).map((route) => [route, readRouteState(freshDesc, route)]),
  )
  const ownership = await readOwnership(ownershipStore, source.keyFingerprint, Object.values(routes))
  const plan = planGoRoutes({
    keyFingerprint: source.keyFingerprint,
    entries: source.entries,
    currentRoutes,
    ownership,
    ref: config.ref,
    routes: config.routes,
    pinnedModels: config.pinnedModels,
  })

  // Re-check immediately before the only settings mutation: a dispose that
  // lands during readOwnership/planning must still produce a zero-write round.
  if (deps.signal?.aborted) return abortedResult(source)

  // §14.7.5: the second gate ALWAYS re-reads the persisted status on every
  // call — the round-level `migration` snapshot is never reused here. Without
  // a live reader there is no second gate (pure writer-mechanics callers); a
  // failed re-read is fail-closed with a `canWrite-unavailable` report line.
  const reloadMigration = deps.reloadMigration
  const canWrite = reloadMigration === undefined
    ? undefined
    : async (route: string): Promise<GoCanWriteDecision> => {
      try {
        const current = await reloadMigration()
        return { allow: routeWriter(route, authority, current).decision === 'write' }
      } catch {
        return { allow: false, reason: 'canWrite-unavailable' }
      }
    }

  let write: GoWriteResult
  try {
    write = await writeGoPlan(plan, {
      settings,
      ownershipStore,
      overrideStorer: deps.overrideStorer,
      logger,
      keyFingerprint: source.keyFingerprint,
      confirmRemovals: config.confirmRemovals,
      adoptExisting: config.adoptExisting,
      canWrite,
      onOwnWrite: deps.onOwnWrite,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: 'source-failed',
      source,
      text: `opencode-go: writer error — ${message}; settings state is whatever landed before the error`,
    }
  }

  return { ok: write.failedRoutes.length === 0, reason: 'completed', source, write, text: formatGoRoundReport(source, write) }
}

/** Stable, testable report text: source summary, per-route outcome, plan notes. */
export function formatGoRoundReport(source: GoSourceResult, write: GoWriteResult): string {
  const lines: string[] = [
    `opencode-go: source ok (${source.entries.length} models, key=${source.keyFingerprint}, hash=${(source.payloadHash ?? '').slice(0, 12)})`,
  ]
  for (const status of write.routes) {
    lines.push(`  ${status.route}: ${status.status}${status.reason !== undefined ? ` (${status.reason})` : ''}`)
  }
  for (const entry of write.report) {
    lines.push(`  [${entry.level}] ${entry.code}${entry.route !== undefined ? ` ${entry.route}` : ''}${entry.id !== undefined ? `/${entry.id}` : ''}: ${entry.message}`)
  }
  if (write.writtenRoutes.length === 0 && write.failedRoutes.length === 0) {
    lines.push('  no settings changes')
  }
  return lines.join('\n')
}

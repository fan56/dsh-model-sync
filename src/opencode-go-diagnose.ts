// P0 read-only diagnostic: compare the official opencode-go model set with
// the current profile's opencode-go route configuration and produce a
// structured report (added / missing / protocol ownership / entitlement).
//
// Hard boundary: this module only READS a settings descriptor. It never calls
// settings.mutate, never writes credentials, and never touches a profile file.
// Existing sync rounds and /model-sync are untouched by this code.
//
// Design: 07-design.md §6.3 (status), §16 P0, C7, final review §1.7.

import {
  fetchGoOfficialModels,
  type GoFetchLike,
  type GoSourceResult,
  type GoAuthStatus,
  type GoSourceError,
} from './opencode-go-source.ts'
import {
  GO_SLOT_ROUTES,
  groupGoModelsByProtocol,
  type GoGroupingResult,
  type GoRouteSlot,
} from './opencode-go-grouping.ts'

/** Minimal settings-descriptor shape the diagnostic reads (no writer import). */
export interface GoSettingsDescriptor {
  user?: Record<string, unknown>
}

/** One route's currently configured model ids, read from the profile. */
export interface GoRouteConfig {
  slot: GoRouteSlot
  route: string
  configuredIds: string[]
}

/** The per-slot comparison in the report. */
export interface GoSlotDiff {
  slot: GoRouteSlot
  route: string
  /** Ids the official entitled source places in this slot. */
  official: string[]
  /** Ids currently listed under this route in the profile. */
  configured: string[]
  /** Official ids absent from the profile. */
  added: string[]
  /** Profile ids absent from the official entitled set. */
  missing: string[]
}

/** Structured diagnostic report emitted by P0. */
export interface GoDiagnosticReport {
  source: 'opencode-go-official'
  generatedAt: number
  authStatus: GoAuthStatus
  keyFingerprint: string
  payloadHash?: string
  error?: GoSourceError
  routes: GoSlotDiff[]
  unassigned: GoGroupingResult['unassigned']
}

/** Inputs to buildGoDiagnosticReport — all already-resolved (pure). */
export interface BuildGoDiagnosticInput {
  source: GoSourceResult
  grouping: GoGroupingResult
  routes: readonly GoRouteConfig[]
  generatedAt?: number
}

// ---------------------------------------------------------------------------
// Read-only profile extraction
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function slotFromRouteId(route: string): GoRouteSlot | undefined {
  if (route === GO_SLOT_ROUTES.chat) return 'chat'
  if (route === GO_SLOT_ROUTES.msg) return 'msg'
  if (route === GO_SLOT_ROUTES.resp) return 'resp'
  if (route === GO_SLOT_ROUTES.google) return 'google'
  return undefined
}

function toRouteConfig(slot: GoRouteSlot, route: string, providers: Record<string, unknown>): GoRouteConfig {
  const routeData = providers[route]
  const models = isRecord(routeData) ? routeData.models : undefined
  const configuredIds = Array.isArray(models)
    ? models
        .map((entry) => isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined)
        .filter((id): id is string => id !== undefined)
    : []
  return { slot, route, configuredIds }
}

/**
 * Read the profile's opencode-go route model ids from a settings descriptor.
 * The four default slots are always present (possibly empty); any additional
 * `opencode-go*` route carrying a recognizable slot suffix is included too.
 * This is a pure read — the descriptor is never modified.
 */
export function readGoRoutesFromDescriptor(desc: GoSettingsDescriptor | undefined): GoRouteConfig[] {
  const providers = desc?.user?.providers
  const table = isRecord(providers) ? providers : {}
  const configs: GoRouteConfig[] = []
  const seen = new Set<string>()

  for (const slot of ['chat', 'msg', 'resp', 'google'] as const) {
    const route = GO_SLOT_ROUTES[slot]
    configs.push(toRouteConfig(slot, route, table))
    seen.add(route)
  }
  for (const route of Object.keys(table)) {
    if (!route.startsWith('opencode-go') || seen.has(route)) continue
    const slot = slotFromRouteId(route)
    if (slot === undefined) continue
    configs.push(toRouteConfig(slot, route, table))
  }
  return configs
}

// ---------------------------------------------------------------------------
// Pure diff + report
// ---------------------------------------------------------------------------

function missingFrom(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right)
  return left.filter((id) => !rightSet.has(id))
}

/**
 * Build the structured report. When the source read failed (no key, auth,
 entitlement, transport), the official side is empty and the diff is suppressed
 * — reporting every configured model as "missing" from a failed read would be
 * misleading. The failure is carried in authStatus / error instead.
 */
export function buildGoDiagnosticReport(input: BuildGoDiagnosticInput): GoDiagnosticReport {
  const available = input.source.ok
  const routes: GoSlotDiff[] = input.routes.map((config) => {
    const official = available ? (input.grouping.slots[config.slot] ?? []) : []
    const configured = config.configuredIds
    return {
      slot: config.slot,
      route: config.route,
      official,
      configured,
      added: available ? missingFrom(official, configured) : [],
      missing: available ? missingFrom(configured, official) : [],
    }
  })

  const report: GoDiagnosticReport = {
    source: 'opencode-go-official',
    generatedAt: input.generatedAt ?? Date.now(),
    authStatus: input.source.authStatus,
    keyFingerprint: input.source.keyFingerprint,
    routes,
    unassigned: available ? input.grouping.unassigned : [],
  }
  if (input.source.payloadHash !== undefined) report.payloadHash = input.source.payloadHash
  if (input.source.error !== undefined) report.error = input.source.error
  return report
}

/** Human-readable rendering of the structured report (command output). */
export function formatGoDiagnosticReport(report: GoDiagnosticReport): string {
  const lines: string[] = [
    'opencode-go official /v1/models diagnostic (read-only; no settings written)',
    `  authStatus: ${report.authStatus}`,
    `  keyFingerprint: ${report.keyFingerprint}`,
  ]
  if (report.payloadHash !== undefined) lines.push(`  payloadHash: ${report.payloadHash}`)
  if (report.error !== undefined) {
    lines.push(`  status: ${report.error.kind}${report.error.status !== undefined ? ` (HTTP ${report.error.status})` : ''}`)
    lines.push(`  reason: ${report.error.message}`)
  }
  for (const slot of report.routes) {
    lines.push(
      `  ${slot.route} [${slot.slot}]: official ${slot.official.length}, configured ${slot.configured.length}`
      + `; +${slot.added.join(', +') || 'none'}`
      + `; -${slot.missing.join(', -') || 'none'}`,
    )
  }
  if (report.unassigned.length > 0) {
    lines.push(`  unassigned: ${report.unassigned.map((u) => `${u.id} (${u.reason})`).join(', ')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Orchestration (the only async entry; network stays injectable for tests)
// ---------------------------------------------------------------------------

/** Options for one diagnostic run. */
export interface RunGoDiagnosticOptions {
  apiKey?: string
  descriptor?: GoSettingsDescriptor | undefined
  url?: string
  timeoutMs?: number
  fetchImpl?: GoFetchLike
  generatedAt?: number
}

/**
 * Run one read-only diagnostic: fetch official models, group by protocol,
 * read the profile's route config, and return the structured report.
 * Pass `fetchImpl` in tests so no network is ever touched.
 */
export async function runGoDiagnostic(options: RunGoDiagnosticOptions = {}): Promise<GoDiagnosticReport> {
  const source = await fetchGoOfficialModels({
    apiKey: options.apiKey,
    url: options.url,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    observedAt: options.generatedAt,
  })
  const grouping = groupGoModelsByProtocol(source.entries)
  const routes = readGoRoutesFromDescriptor(options.descriptor)
  return buildGoDiagnosticReport({ source, grouping, routes, generatedAt: options.generatedAt })
}

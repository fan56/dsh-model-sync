// P1d-1: migration gate + single-writer route authority (design §14.1 / §14.6 /
// §14.7, M-4 / M-5; ADR-008). Pure state/fingerprint/routeWriter functions plus
// an injected migration-record store seam. No timer, no network, no settings
// write lives here — the migrate *command* itself is P1d-2. Tests inject an
// `appliedFingerprint` record to exercise the applied state without apply().
//
// Priority (§14.7.1): ① migration gate (`none`) > ② single-writer ownership >
// ③ ordinary §6.2.4 write semantics. A skipped route must always produce a
// report line (never silent), which callers build from RouteWriterDecision.

import { createHash } from 'node:crypto'
import { GO_SLOT_ROUTES } from './opencode-go-grouping.ts'
import { loadModelsStore, type ModelsStoreAccessor } from './remote-catalog.ts'
import type { SettingsDescriptor } from './writer.ts'

/** Cordis service seam: tests register a fake record store under this name. */
export const GO_MIGRATION_STORE_SERVICE = 'goMigrationStore'
/** Stable models-store raw slot holding the single go migration record (P1d-1). */
export const GO_MIGRATION_STORE_KEY = 'migration:opencode-go'

export type MigrationState = 'absent' | 'legacy-inherit' | 'legacy-inline' | 'drifted' | 'applied'
/** The writer identity used by the single-writer priority table. */
export type RouteWriterCaller = 'go' | 'zen' | 'pi.dev'
/** Effective owner of a route (`none` = migration gate closed). */
export type GoRouteOwner = 'go' | 'zen' | 'pi.dev' | 'none'

/** Migration record persisted by `/model-sync migrate apply` (P1d-2). P1d-1 only reads it. */
export interface MigrationRecord {
  legacyFingerprint?: string
  appliedFingerprint?: string
  planHash?: string
  appliedAt?: number
  backupPath?: string
  movedIds?: string[]
  /** M-5: apply in progress — every auto round must drop, never queue. */
  applying?: boolean
}

export interface MigrationStatus {
  state: MigrationState
  /** sha256 of the canonical `opencode-go*` provider sections currently in settings. */
  fingerprint: string
  appliedFingerprint?: string
  legacyFingerprint?: string
  applying: boolean
}

/** Read-only seam; the migrate command (P1d-2) will add a write method. */
export interface MigrationStateStore {
  read(): Promise<MigrationRecord | undefined>
}

export interface RouteWriterConfig {
  /** Which write path is asking for authority. */
  caller: RouteWriterCaller
  /** opencode.go.enabled — the switch that hands go routes to the go writer. */
  goEnabled: boolean
  /** zen routes mode (default 'login-only' = zen never writes routes). */
  zenMode?: 'login-only' | 'routes'
  /** Custom zen route ids (defaults to the `opencode-zen*` prefix rule). */
  zenRoutes?: readonly string[]
  /** Custom go route ids (defaults to GO_SLOT_ROUTES values + `opencode-go*` prefix). */
  goRoutes?: readonly string[]
}

export interface RouteWriterDecision {
  decision: 'write' | 'skip'
  /** Machine-readable reason; skip reasons carry the report code (`skipped-route-owner`, …). */
  reason: string
  /** Effective owner — surfaced as `skipped-route-owner: <owner>` in reports. */
  owner: GoRouteOwner
}

/** Fixed report line required by §14.6 for every migration-gate skip. */
export const MIGRATION_GATE_HINT = '检测到未迁移配置，已跳过写入；运行 /model-sync migrate plan'

// ---------------------------------------------------------------------------
// Fingerprint + state detection (pure)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Canonical JSON (recursive key sort) — the ownership-entry hash algorithm (§14.1). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
  return out
}

/** sha256 of canonical JSON — section fingerprint (§14.1). */
export function fingerprintSection(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

/** Extract only the `opencode-go*` provider sections that currently exist. */
export function readGoProviderSections(
  source: SettingsDescriptor | Record<string, unknown> | undefined,
  routes: readonly string[] = Object.values(GO_SLOT_ROUTES),
): Record<string, unknown> | undefined {
  // A SettingsDescriptor carries `user.providers`; a raw providers object is
  // itself the route→section map. Discriminate on `user` rather than `ns` so a
  // partial descriptor fixture (no `ns`) still resolves correctly.
  const providers = isRecord(source) && isRecord(source.user)
    ? source.user.providers
    : isRecord(source) ? source.providers : undefined
  if (!isRecord(providers)) return undefined
  const sections: Record<string, unknown> = {}
  for (const route of routes) {
    const data = providers[route]
    if (isRecord(data)) sections[route] = data
  }
  return sections
}

/** Fingerprint of the current `opencode-go*` sections (empty object when absent). */
export function fingerprintGoRoutes(
  source: SettingsDescriptor | Record<string, unknown> | undefined,
  routes?: readonly string[],
): string {
  return fingerprintSection(readGoProviderSections(source, routes) ?? {})
}

function hasInlineModels(sections: Record<string, unknown>, chatRoute: string): boolean {
  const chat = sections[chatRoute]
  return isRecord(chat) && Array.isArray(chat.models)
}

/**
 * Determine migration state from the current section fingerprint + record.
 * Order matters: absent → applied (fingerprint match) → recorded legacy/drifted →
 * unrecorded legacy form (§14.1). `drifted` means a record exists but the
 * current fingerprint matches neither applied nor legacy.
 */
export function migrationStateOf(
  sections: Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  chatRoute: string = GO_SLOT_ROUTES.chat,
): MigrationState {
  if (sections === undefined || Object.keys(sections).length === 0) return 'absent'
  const fingerprint = fingerprintSection(sections)
  if (record?.appliedFingerprint !== undefined && fingerprint === record.appliedFingerprint) return 'applied'
  if (record !== undefined && (record.appliedFingerprint !== undefined || record.legacyFingerprint !== undefined)) {
    if (record.legacyFingerprint !== undefined && fingerprint === record.legacyFingerprint) {
      return hasInlineModels(sections, chatRoute) ? 'legacy-inline' : 'legacy-inherit'
    }
    return 'drifted'
  }
  return hasInlineModels(sections, chatRoute) ? 'legacy-inline' : 'legacy-inherit'
}

/** Full status from a settings descriptor (or a raw providers object) + record. */
export function migrationStatusOf(
  source: SettingsDescriptor | Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  routes?: readonly string[],
): MigrationStatus {
  const sections = readGoProviderSections(source, routes)
  return {
    state: migrationStateOf(sections, record, routes?.[0] ?? GO_SLOT_ROUTES.chat),
    fingerprint: fingerprintSection(sections ?? {}),
    appliedFingerprint: record?.appliedFingerprint,
    legacyFingerprint: record?.legacyFingerprint,
    applying: record?.applying === true,
  }
}

// ---------------------------------------------------------------------------
// Single-writer route authority (pure)
// ---------------------------------------------------------------------------

/** True for any configured go route id or the `opencode-go*` prefix. */
export function isGoRoute(route: string, customRoutes?: readonly string[]): boolean {
  if (customRoutes?.includes(route) === true) return true
  return Object.values(GO_SLOT_ROUTES).includes(route) || route.startsWith('opencode-go')
}

function isZenRoute(route: string, cfg: RouteWriterConfig): boolean {
  if (cfg.zenRoutes?.includes(route) === true) return true
  return route.startsWith('opencode-zen')
}

/**
 * The single decision point every write path must call before settings.mutate.
 *
 * Rules (§14.7.1, task P1d-1):
 * - go.enabled=true + caller≠'go' on an `opencode-go*` route → always skip;
 *   the legacy pi.dev path may never take over, even if the gate returned none.
 * - go.enabled=true + caller='go' + state=applied with a matching fingerprint,
 *   or state=absent → write. legacy-inherit / legacy-inline / drifted → skip
 *   (migration gate) and report MIGRATION_GATE_HINT.
 * - `applying` → skip (M-5: auto rounds drop while apply is in progress).
 * - go.enabled=false → v0.9.0 behavior restored for go routes (pi.dev owner).
 * - zen routes mode: only the zen writer owns zen routes; other routes are
 *   unaffected (pi.dev owner) and keep their original behavior.
 */
export function routeWriter(
  route: string,
  cfg: RouteWriterConfig,
  migration: MigrationStatus,
): RouteWriterDecision {
  const goRoute = isGoRoute(route, cfg.goRoutes)

  if (goRoute && cfg.goEnabled) {
    if (cfg.caller !== 'go') {
      return {
        decision: 'skip',
        owner: 'go',
        reason: 'skipped-route-owner: go (single-writer: opencode.go.enabled=true; legacy pi.dev path must never write opencode-go* routes)',
      }
    }
    if (migration.applying) {
      return {
        decision: 'skip',
        owner: 'none',
        reason: `skipped-route-owner: none (migration applying; ${MIGRATION_GATE_HINT})`,
      }
    }
    if (migration.state === 'applied'
      && migration.appliedFingerprint !== undefined
      && migration.fingerprint === migration.appliedFingerprint) {
      return { decision: 'write', owner: 'go', reason: 'owner=go (migration applied; fingerprint matched)' }
    }
    if (migration.state === 'absent') {
      return { decision: 'write', owner: 'go', reason: 'owner=go (absent; no pre-existing section to migrate)' }
    }
    return {
      decision: 'skip',
      owner: 'none',
      reason: `skipped-route-owner: none (migration gate: ${migration.state}; ${MIGRATION_GATE_HINT})`,
    }
  }

  // go.enabled=false (or non-go route): zen routes still have a single owner.
  if (cfg.zenMode === 'routes' && isZenRoute(route, cfg)) {
    if (cfg.caller !== 'zen') {
      return { decision: 'skip', owner: 'zen', reason: 'skipped-route-owner: zen (zen routes mode: only the zen writer owns zen routes)' }
    }
    return { decision: 'write', owner: 'zen', reason: 'owner=zen' }
  }

  // Everything else keeps the original pi.dev behavior. A go caller writing a
  // non-go route is a no-op in practice; allow it so callers can pass a uniform
  // decision function without changing other routes' semantics.
  return { decision: 'write', owner: 'pi.dev', reason: 'owner=pi.dev' }
}

// ---------------------------------------------------------------------------
// Injected store (production adapter reads the same models-store JSON)
// ---------------------------------------------------------------------------

/** Build a read-only migration store over the models-store raw-slot accessor. */
export function createFileMigrationStateStore(accessor: ModelsStoreAccessor): MigrationStateStore {
  return {
    async read(): Promise<MigrationRecord | undefined> {
      let raw: Record<string, unknown> | undefined
      try {
        raw = await accessor.readRaw(GO_MIGRATION_STORE_KEY)
      } catch {
        return undefined // unreadable ⇒ no record ⇒ conservative legacy detection
      }
      if (!isRecord(raw)) return undefined
      return raw as unknown as MigrationRecord
    },
  }
}

/** Production factory; tests pass a temp-file accessor or inject a fake store. */
export function createModelsStoreMigrationStateStore(storePath?: string): MigrationStateStore {
  return createFileMigrationStateStore(loadModelsStore(storePath))
}

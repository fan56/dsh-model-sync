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

/** Original settings/ledger state captured before apply (P1d-2, M-3/M-5). */
export interface MigrationBackup {
  planHash: string
  capturedAt: number
  /** Per-route pre-apply snapshot; `section` absent means the route did not exist. */
  routes: Record<string, {
    section?: Record<string, unknown>
    ledger?: Record<string, unknown>
  }>
}

/** Migration record persisted by `/model-sync migrate apply` (P1d-2). */
export interface MigrationRecord {
  /** Audit backup written with `applying:true` BEFORE the first settings mutate. */
  backup?: MigrationBackup
  legacyFingerprint?: string
  /** sha256(canonical({ identity, appliedManagedIds })) — §14.7.4 two-level fingerprint. */
  appliedFingerprint?: string
  /** sha256 of the stable identity fields of the go sections at apply/last own write. */
  appliedIdentity?: string
  /** Route set `appliedIdentity` was computed over — later-added routes must not drift. */
  appliedIdentityRoutes?: string[]
  /** Per-route sorted ledger-managed ids captured with `appliedFingerprint`. */
  appliedManagedIds?: Record<string, string[]>
  planHash?: string
  appliedAt?: number
  backupPath?: string
  movedIds?: string[]
  /** M-5: apply in progress — every auto round must drop, never queue. */
  applying?: boolean
}

export interface MigrationStatus {
  state: MigrationState
  /** sha256 of the canonical FULL `opencode-go*` sections (legacy-shape compat only). */
  fingerprint: string
  /** sha256 of the current stable identity fields of the go sections. */
  identity: string
  appliedFingerprint?: string
  appliedIdentity?: string
  appliedManagedIds?: Record<string, string[]>
  legacyFingerprint?: string
  applying: boolean
  /** Identity matches but the stored full fingerprint is stale → self-heal (§14.7.4). */
  fingerprintHealed: boolean
  /** Fingerprint the healed record should carry. */
  expectedFingerprint: string
}

/** Migration record seam. `write` is optional so read-only test stores keep working. */
export interface MigrationStateStore {
  read(): Promise<MigrationRecord | undefined>
  /** Queue-serialized atomic slot replacement (same models-store queue as the ledger). */
  write?(record: MigrationRecord): Promise<void>
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

// --- Two-level applied fingerprint (§14.7.4) --------------------------------
//
// Only STABLE fields take part in drift detection:
//   appliedIdentity   = sha256(canonical({ <route>: {api, baseURL, displayName,
//                                          apiKeyEnv} }))     — from settings
//   appliedManagedIds = { <route>: sorted ids in the ownership ledger }  — from ledger
//   appliedFingerprint = sha256(canonical({ appliedIdentity, appliedManagedIds }))
//
// Excluded on purpose: models[] capacity/capability fields (name,
// contextWindow, maxTokens, input, reasoningEfforts, compat — all rewritten
// every sync round), user-owned ids, model order, modelOverrides, and any
// time/usage field. Those are handled by the managed-vs-user-owned repair
// rules, never by closing the gate. Identity fields are never rewritten by a
// sync round, and the ledger ids change only through our own successful
// writes (which immediately re-persist the fingerprint), so a normal sync
// cannot create an identity-level mismatch. An external identity edit →
// `drifted`; an external models edit → still `applied`.
const IDENTITY_FIELDS = ['api', 'baseURL', 'displayName', 'apiKeyEnv'] as const

/** Identity map: only the four stable fields of each present go section. */
export function goIdentityOf(sections: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [route, section] of Object.entries(sections ?? {})) {
    if (!isRecord(section)) continue
    const entry: Record<string, unknown> = {}
    for (const field of IDENTITY_FIELDS) {
      if (section[field] !== undefined) entry[field] = section[field]
    }
    out[route] = entry
  }
  return out
}

/**
 * Hash of the current route identities — stable across ordinary sync rounds.
 * `routes` restricts the compared set: a record keeps the route set it was
 * written with, so routes created later by a sync round never look like drift.
 */
export function fingerprintGoIdentity(
  sections: Record<string, unknown> | undefined,
  routes?: readonly string[],
): string {
  const all = goIdentityOf(sections)
  if (routes === undefined) return fingerprintSection(all)
  return fingerprintSection(Object.fromEntries(routes.map((route) => [route, all[route] ?? {}])))
}

/** Full applied fingerprint = sha256(canonical({ identity, managedIds })). */
export function appliedFingerprintOf(
  identity: string,
  managedIds: Record<string, string[]> | undefined,
): string {
  return fingerprintSection({ identity, managedIds: managedIds ?? {} })
}

function hasInlineModels(sections: Record<string, unknown>, chatRoute: string): boolean {
  const chat = sections[chatRoute]
  return isRecord(chat) && Array.isArray(chat.models)
}

/**
 * Determine migration state (§14.1 / §14.7.4). Order matters: absent →
 * identity-based applied/drifted (new records) → full-fingerprint match
 * (legacy records written before the two-level split) → recorded legacy/drifted
 * → unrecorded legacy form. Only an IDENTITY mismatch is `drifted`: a models
 * edit (capacity fields, user-owned ids, order) leaves identity intact and is
 * repaired by the writer instead of closing the gate.
 */
export function migrationStateOf(
  sections: Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  chatRoute: string = GO_SLOT_ROUTES.chat,
): MigrationState {
  if (sections === undefined || Object.keys(sections).length === 0) return 'absent'
  const fingerprint = fingerprintSection(sections)
  if (record?.appliedIdentity !== undefined) {
    return fingerprintGoIdentity(sections, record.appliedIdentityRoutes) === record.appliedIdentity
      ? 'applied' : 'drifted'
  }
  // Backward compatibility with the pre-§14.7.4 full-section fingerprint.
  if (record?.appliedFingerprint !== undefined && fingerprint === record.appliedFingerprint) return 'applied'
  if (record !== undefined && (record.appliedFingerprint !== undefined || record.legacyFingerprint !== undefined)) {
    if (record.legacyFingerprint !== undefined && fingerprint === record.legacyFingerprint) {
      return hasInlineModels(sections, chatRoute) ? 'legacy-inline' : 'legacy-inherit'
    }
    return 'drifted'
  }
  return hasInlineModels(sections, chatRoute) ? 'legacy-inline' : 'legacy-inherit'
}

/**
 * Full status from a settings descriptor (or raw providers object) + record.
 * `currentManagedIds`, when supplied, comes from the live ownership ledger and
 * drives the §14.7.4 self-heal check (identity matches but the stored full
 * fingerprint is stale because the fingerprint write failed after a commit).
 */
export function migrationStatusOf(
  source: SettingsDescriptor | Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  routes?: readonly string[],
  currentManagedIds?: Record<string, string[]>,
): MigrationStatus {
  const sections = readGoProviderSections(source, routes)
  // Compare only the route set the record was written with — routes added by a
  // later sync round must not invalidate an otherwise unchanged identity.
  const identity = fingerprintGoIdentity(sections, record?.appliedIdentityRoutes)
  const managedIds = currentManagedIds ?? record?.appliedManagedIds ?? {}
  const expectedFingerprint = appliedFingerprintOf(identity, managedIds)
  return {
    state: migrationStateOf(sections, record, routes?.[0] ?? GO_SLOT_ROUTES.chat),
    fingerprint: fingerprintSection(sections ?? {}),
    identity,
    appliedIdentity: record?.appliedIdentity,
    appliedManagedIds: record?.appliedManagedIds,
    appliedFingerprint: record?.appliedFingerprint,
    legacyFingerprint: record?.legacyFingerprint,
    applying: record?.applying === true,
    fingerprintHealed: record?.appliedIdentity !== undefined
      && identity === record.appliedIdentity
      && record.appliedFingerprint !== expectedFingerprint,
    expectedFingerprint,
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
    // §14.7.4: a record with `appliedIdentity` is judged applied by IDENTITY
    // match alone — models edits must not close the gate. Legacy records fall
    // back to the full-section fingerprint equality they were written with.
    if (migration.state === 'applied'
      && ((migration.appliedIdentity !== undefined && migration.identity === migration.appliedIdentity)
        || (migration.appliedFingerprint !== undefined && migration.fingerprint === migration.appliedFingerprint))) {
      return { decision: 'write', owner: 'go', reason: 'owner=go (migration applied; identity/fingerprint matched)' }
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

/** Build a migration store over the models-store raw-slot accessor. */
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
    async write(record: MigrationRecord): Promise<void> {
      // writeRaw is queue-serialized atomic temp+rename, i.e. the SAME queue
      // that persists the ownership ledger (§14.7.4: settings → ledger → fingerprint).
      await accessor.writeRaw(GO_MIGRATION_STORE_KEY, record as unknown as Record<string, unknown>)
    },
  }
}

/** Production factory; tests pass a temp-file accessor or inject a fake store. */
export function createModelsStoreMigrationStateStore(storePath?: string): MigrationStateStore {
  return createFileMigrationStateStore(loadModelsStore(storePath))
}

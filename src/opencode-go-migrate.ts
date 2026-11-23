// P1d-2: the two-stage `/model-sync migrate plan|apply|rollback|status` surface.
//
// This is the ONLY entry point that is allowed to touch the go routes' config
// after explicit user consent (design §14.0 M-1/M-2/M-3). Hard rules baked into
// this module:
//   - `buildMigrationPlan` is PURE: no settings write, no store write, no fetch.
//     Its inputs are injected, so a plan can be produced entirely offline.
//   - `applyMigration` refuses unless BOTH the planHash AND the 6-digit confirm
//     code match a freshly rebuilt plan of the CURRENT settings. There is no
//     `--yes` / `--auto` / env bypass anywhere in this file.
//   - write order is settings → ledger → appliedFingerprint (§14.7.4), and the
//     applied flag is persisted BEFORE the first mutate so the go scheduler
//     drops any round that races the apply (M-5 single writer).
//   - `rollbackMigration` refuses on a missing backup or a post-apply hash edit,
//     and never overwrites ids the user added after apply.
//
// Design refs: §14.1 (states), §14.2 (three input shapes), §14.4 (references),
// §14.5 (commands), §14.6 (order + single flight), §14.7 (write authority),
// V16/V17/V19/V20/V22. No timer, no network, no real ~/.dsh lives here.

import { createHash } from 'node:crypto'
import {
  GO_SLOT_ROUTES,
  groupGoModelsByProtocol,
  type GoRouteSlot,
} from './opencode-go-grouping.ts'
import {
  goOwnershipKey,
  mapGoModelToProfile,
  planGoRouteFields,
  profileHash,
  type GoManagedModel,
  type GoOwnershipEntry,
  type GoPlannedRouteFields,
} from './opencode-go-planner.ts'
import type { GoModelRecord } from './opencode-go-source.ts'
import type { SettingsModelProfile } from './translate.ts'
import {
  appliedFingerprintOf,
  fingerprintGoIdentity,
  fingerprintSection,
  readGoProviderSections,
  routeWriter,
  type MigrationBackup,
  type MigrationRecord,
  type MigrationState,
  type MigrationStateStore,
  type RouteWriterConfig,
} from './opencode-go-migration.ts'
import type { GoOwnershipStore } from './opencode-go-writer.ts'
import type { Logger, SettingsDescriptor, SettingsMutationOp, SettingsService } from './writer.ts'

const OWNED_FIELDS = ['api', 'baseURL', 'displayName', 'apiKeyEnv'] as const
const PLAN_VERSION = 1

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** What apply will do with one route. */
export type MigrationAction = 'create' | 'update' | 'keep' | 'unset'

/** Classification of one id that exists in the current route (design §14.2). */
export type MigrationIdKind =
  | 'desired-chat'
  | 'desired-msg'
  | 'desired-resp'
  | 'desired-google'
  | 'legacy-other-protocol'
  | 'unknown-retired'
  | 'user-extra'

export interface MigrationIdClass {
  id: string
  kind: MigrationIdKind
  /** Conservative (adopt=false) keeps every existing id; adopt may move/delete. */
  action: 'keep' | 'move' | 'delete' | 'adopt'
  reason: string
}

export interface MigrationDeletion {
  route: string
  id: string
  kind: MigrationIdKind
  /** The three deletion gates (§6.2.4 / ADR-005), reported with the reason. */
  gates: {
    managedHash: string
    override: string
    pinned: string
  }
  /** Only an explicitly confirmed id in adopt mode is actually deleted. */
  willDelete: boolean
  reason: string
}

export type RewriteRefMode = 'none' | 'default-model' | 'config'

/** A reference candidate reported by plan. Only verified config keys may be rewritten. */
export interface ReferenceCandidate {
  surface: string
  location: string
  before: string
  after: string
  verified: boolean
  rewritable: boolean
  /** Session storage / external config: always report-only (never rewritten). */
  reportOnly: boolean
}

/** A rewrite request that an injected patch accessor can execute (opt-in only). */
export interface ReferenceRewrite {
  surface: string
  location: string
  before: string
  after: string
}

/** The hashed body of the plan. `planHash`/`confirmCode` are derived, not hashed. */
export interface MigrationPlanBody {
  version: 1
  keyFingerprint: string
  adopt: boolean
  rewriteRefs: RewriteRefMode
  /** Fingerprint of the pre-apply go sections — apply refuses if it changed. */
  preFingerprint: string
  state: MigrationState
  stateByRoute: Record<string, MigrationState>
  routes: MigrationPlannedRoute[]
  deletions: MigrationDeletion[]
  references: ReferenceCandidate[]
  pinnedSuggestions: string[]
  backupPath: string
  rollbackCommand: string
  unverified: string[]
}

export interface MigrationPlan extends MigrationPlanBody {
  planHash: string
  confirmCode: string
}

export interface MigrationPlannedRoute {
  slot: GoRouteSlot
  route: string
  state: MigrationState
  action: MigrationAction
  fields: GoPlannedRouteFields
  desired: SettingsModelProfile[]
  existing: MigrationIdClass[]
}

export interface BuildPlanInput {
  descriptor: SettingsDescriptor | undefined
  entries: readonly GoModelRecord[]
  routes: Partial<Record<GoRouteSlot, string>>
  ref: string
  keyFingerprint: string
  adopt?: boolean
  rewriteRefs?: RewriteRefMode
  record?: MigrationRecord
  /** Reference candidates from the (offline) reference-surface scan. Report-only by default. */
  references?: ReferenceCandidate[]
  now: number
}

// ---------------------------------------------------------------------------
// Pure helpers: canonical hash + confirmation code (V16 / V17)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
  return out
}

/** sha256 of canonical JSON — the planHash algorithm (V17: changes with the plan). */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

/** Deterministic 6-digit confirmation code derived from a planHash. */
export function confirmCodeOf(planHash: string): string {
  return String(Number.parseInt(planHash.slice(0, 12), 16) % 1_000_000).padStart(6, '0')
}

export function planHashOf(body: MigrationPlanBody): string {
  return hashCanonical(body)
}

export type ConsentResult =
  | { ok: true }
  | { ok: false; reason: 'consent-required' | 'plan-hash-mismatch' | 'confirm-code-mismatch' }

/**
 * The consent gate (V17). Both values are mandatory and must match a freshly
 * rebuilt plan; a missing/incorrect value never reaches a write. Deliberately
 * there is no accept-anything branch — `--yes`/`--auto` cannot be expressed.
 */
export function verifyConsent(
  plan: MigrationPlan,
  planHash: string | undefined,
  confirmCode: string | undefined,
): ConsentResult {
  if (typeof planHash !== 'string' || planHash === ''
    || typeof confirmCode !== 'string' || confirmCode === '') {
    return { ok: false, reason: 'consent-required' }
  }
  if (planHash !== plan.planHash) return { ok: false, reason: 'plan-hash-mismatch' }
  if (confirmCode !== plan.confirmCode) return { ok: false, reason: 'confirm-code-mismatch' }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Pure plan builder (V16: zero writes / zero external calls)
// ---------------------------------------------------------------------------

/** Per-route state, refined from the full-set state (§14.1). */
function detectRouteStates(
  sections: Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  routeIds: readonly string[],
  overall: MigrationState,
): Record<string, MigrationState> {
  const identityRoutes = record?.appliedIdentityRoutes ?? Object.keys(sections ?? {})
  const out: Record<string, MigrationState> = {}
  for (const route of routeIds) {
    const present = sections?.[route]
    if (!isRecord(present)) {
      out[route] = 'absent'
    } else if (overall === 'drifted') {
      // A drift anywhere closes the gate for the whole route set; report it per route too.
      out[route] = identityRoutes.includes(route) ? 'drifted' : 'legacy-inline'
    } else if (overall === 'applied' || (record?.appliedIdentity !== undefined && identityRoutes.includes(route))) {
      out[route] = 'applied'
    } else {
      out[route] = Array.isArray(present.models) ? 'legacy-inline' : 'legacy-inherit'
    }
  }
  return out
}

/** Default reference report when the caller has no offline scan result to inject. */
function defaultReferences(targets: readonly string[], rewriteRefs: RewriteRefMode): ReferenceCandidate[] {
  const refs = targets.length > 0 ? targets.join(' / ') : 'qwen4-max / grok-4.7'
  const candidates: ReferenceCandidate[] = [
    {
      surface: 'agent-default-model (profile patch)',
      location: '~/.dsh/profiles/<profile>/cordis.patch.yml',
      before: `opencode-go/${refs}`,
      after: 'see pinnedModels / new route',
      verified: true,
      rewritable: rewriteRefs === 'default-model' || rewriteRefs === 'config',
      reportOnly: rewriteRefs === 'none',
    },
    {
      surface: 'favoriteModels / hiddenModels (profile patch)',
      location: '~/.dsh/profiles/<profile>/cordis.patch.yml',
      before: `opencode-go/${refs}`,
      after: 'see pinnedModels / new route',
      verified: true,
      rewritable: rewriteRefs === 'config',
      reportOnly: rewriteRefs === 'none',
    },
    {
      surface: 'session/conversation {provider,model}',
      location: '~/.dsh/sessions/**/session.v4.jsonl.zstd',
      before: `opencode-go/${refs}`,
      after: 'manual / new session',
      verified: false,
      rewritable: false,
      reportOnly: true,
    },
  ]
  return candidates
}

/** Build the full change plan. Pure: identical inputs → identical plan/hash. */
export function buildMigrationPlan(input: BuildPlanInput): MigrationPlan {
  const routes = { ...GO_SLOT_ROUTES, ...input.routes }
  const routeIds = Object.values(routes)
  const sections = readGoProviderSections(input.descriptor, routeIds)
  const prior = input.record
  const state = migrationStateForPlan(sections, prior, routes.chat)
  const stateByRoute = detectRouteStates(sections, prior, routeIds, state)
  const adopt = input.adopt === true
  const rewriteRefs = input.rewriteRefs ?? 'none'

  const grouping = groupGoModelsByProtocol(input.entries)
  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]))

  const desiredBySlot = new Map<GoRouteSlot, SettingsModelProfile[]>()
  for (const slot of ['chat', 'msg', 'resp', 'google'] as const) {
    desiredBySlot.set(slot, grouping.slots[slot]
      .map((id) => entryById.get(id))
      .filter((entry): entry is GoModelRecord => entry !== undefined)
      .map(mapGoModelToProfile)
      .sort((a, b) => a.id.localeCompare(b.id)))
  }
  const desiredIds = new Set([...desiredBySlot.values()].flat().map((profile) => profile.id))

  // The two ids that move out of chat into dedicated protocol routes (§14.4).
  const targets = grouping.slots.msg.concat(grouping.slots.resp)
  const references = input.references ?? defaultReferences(targets, rewriteRefs)

  const plannedRoutes: MigrationPlannedRoute[] = []
  const deletions: MigrationDeletion[] = []
  const pinned = new Set<string>()

  for (const slot of ['chat', 'msg', 'resp', 'google'] as const) {
    // Skip an unused conditional slot with no pre-existing section (§9.4).
    if (slot === 'google' && desiredBySlot.get(slot)!.length === 0 && sections?.[routes[slot]] === undefined) continue
    const route = routes[slot]
    const section = sections?.[route]
    const routeState = stateByRoute[route] ?? 'absent'
    const fields = planGoRouteFields(slot, input.entries.filter((entry) => grouping.slots[slot].includes(entry.id)), input.ref)
    const desired = desiredBySlot.get(slot) ?? []
    const currentModels: SettingsModelProfile[] = isRecord(section) && Array.isArray(section.models)
      ? section.models as SettingsModelProfile[]
      : []
    const currentById = new Map(currentModels.map((profile) => [profile.id, profile]))

    const existing: MigrationIdClass[] = []
    for (const profile of currentModels) {
      const id = profile.id
      const inSlot = desiredBySlot.get(slot)!.some((candidate) => candidate.id === id)
      let kind: MigrationIdKind
      let action: MigrationIdClass['action']
      if (inSlot) {
        kind = `desired-${slot}` as MigrationIdKind
        action = adopt ? 'adopt' : 'keep'
      } else if (desiredIds.has(id)) {
        // Present on a different slot's desired list → candidate to move.
        kind = 'legacy-other-protocol'
        action = 'keep'
      } else {
        // Not in the official set at all: could be a retired id or user-written.
        kind = 'unknown-retired'
        action = 'keep'
      }
      existing.push({ id, kind, action, reason: describeId(kind, adopt) })
    }

    let action: MigrationAction
    if (routeState === 'absent') action = 'create'
    else if (routeState === 'applied') action = 'keep'
    else action = 'update'

    plannedRoutes.push({ slot, route, state: routeState, action, fields, desired, existing })

    // Deletions are reported for every legacy id on the CHAT route (the route
    // that shrinks), with the three-gate explanation. Only adopt mode with an
    // explicitly confirmed id sets willDelete=true; conservative mode never deletes.
    if (slot === 'chat') {
      for (const entry of existing) {
        if (entry.action === 'keep' && entry.kind !== 'desired-chat') {
          const hashMatches = currentById.has(entry.id) // no pre-migration ledger for legacy ids
          const isPinned = input.entries.some((e) => e.id === entry.id && grouping.slots.resp.includes(e.id))
            || grouping.slots.msg.includes(entry.id)
          const willDelete = adopt && entry.kind === 'unknown-retired' && !isPinned
          deletions.push({
            route,
            id: entry.id,
            kind: entry.kind,
            gates: {
              managedHash: hashMatches ? 'legacy id: user-confirmed via plan (no prior ledger)' : 'no hash — never delete',
              override: 'no modelOverrides on legacy section',
              pinned: isPinned ? 'pinned target id — kept' : 'not pinned',
            },
            willDelete,
            reason: willDelete
              ? 'adopt mode: unknown/retired id explicitly listed in this plan'
              : 'conservative mode: kept as user-owned',
          })
        }
      }
    }
  }

  const reversibleTargets = targets.filter((id) => !grouping.slots.chat.includes(id))
  for (const id of reversibleTargets) pinned.add(id)

  const preFingerprint = fingerprintSection(sections ?? {})
  const body: MigrationPlanBody = {
    version: PLAN_VERSION,
    keyFingerprint: input.keyFingerprint,
    adopt,
    rewriteRefs,
    preFingerprint,
    state,
    stateByRoute,
    routes: plannedRoutes,
    deletions,
    references,
    pinnedSuggestions: [...pinned].sort(),
    backupPath: `models-store:migration:backup:${input.keyFingerprint}`,
    rollbackCommand: `/model-sync migrate rollback --plan <planHash>`,
    unverified: [
      'session/conversation storage: report-only (checksummed zstd, append-only, revision drift, FTS invalidation)',
      'external scripts / third-party config: report-only',
    ],
  }
  const planHash = planHashOf(body)
  return { ...body, planHash, confirmCode: confirmCodeOf(planHash) }
}

function describeId(kind: MigrationIdKind, adopt: boolean): string {
  switch (kind) {
    case 'desired-chat': return 'official chat-completions target'
    case 'desired-msg': return 'official messages target (dedicated -msg route)'
    case 'desired-resp': return 'official responses target (dedicated -resp route)'
    case 'desired-google': return 'official google target'
    case 'legacy-other-protocol': return adopt ? 'legacy id on the wrong protocol route' : 'legacy id kept in conservative mode'
    case 'unknown-retired': return adopt ? 'unknown/retired id, delete only if confirmed in plan' : 'unknown/retired id kept as user-owned'
    case 'user-extra': return 'user-written id, never auto-deleted'
  }
}

/** Local state detection mirroring `migrationStateOf` (kept here to stay import-light). */
function migrationStateForPlan(
  sections: Record<string, unknown> | undefined,
  record: MigrationRecord | undefined,
  chatRoute: string,
): MigrationState {
  if (sections === undefined || Object.keys(sections).length === 0) return 'absent'
  const fingerprint = fingerprintSection(sections)
  if (record?.appliedIdentity !== undefined) {
    return fingerprintGoIdentity(sections, record.appliedIdentityRoutes) === record.appliedIdentity ? 'applied' : 'drifted'
  }
  if (record?.appliedFingerprint !== undefined && fingerprint === record.appliedFingerprint) return 'applied'
  if (record !== undefined && (record.appliedFingerprint !== undefined || record.legacyFingerprint !== undefined)) {
    if (record.legacyFingerprint !== undefined && fingerprint === record.legacyFingerprint) {
      const chat = sections[chatRoute]
      return isRecord(chat) && Array.isArray(chat.models) ? 'legacy-inline' : 'legacy-inherit'
    }
    return 'drifted'
  }
  const chat = sections[chatRoute]
  return isRecord(chat) && Array.isArray(chat.models) ? 'legacy-inline' : 'legacy-inherit'
}

// ---------------------------------------------------------------------------
// Human-readable reports (V16 / V19)
// ---------------------------------------------------------------------------

export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [
    `model-sync migrate plan (v${plan.version}) — ${plan.state} (read-only, nothing written)`,
    `  mode: ${plan.adopt ? 'adopt' : 'conservative'}  rewrite-refs: ${plan.rewriteRefs}`,
    `  sections fingerprint: ${plan.preFingerprint.slice(0, 16)}…`,
    '',
    'Routes:',
  ]
  for (const route of plan.routes) {
    const fields = route.fields
    lines.push(`  ${route.route} [${route.slot}/${route.state}] ${route.action.toUpperCase()}`)
    lines.push(`    api=${fields.api} baseURL=${fields.baseURL} displayName=${fields.displayName} apiKeyEnv=${fields.apiKeyEnv}`)
    lines.push(`    desired (${route.desired.length}): ${route.desired.map((profile) => profile.id).join(', ') || '(none)'}`)
    if (route.existing.length > 0) {
      lines.push(`    existing: ${route.existing.map((entry) => `${entry.id}=${entry.kind}/${entry.action}`).join(', ')}`)
    }
  }
  lines.push('', 'Deletions (three-gate explanation):')
  if (plan.deletions.length === 0) lines.push('  (none)')
  for (const del of plan.deletions) {
    lines.push(`  ${del.route}/${del.id} [${del.kind}] willDelete=${del.willDelete}`)
    lines.push(`    gates: managedHash=${del.gates.managedHash}; override=${del.gates.override}; pinned=${del.gates.pinned}`)
    lines.push(`    why: ${del.reason}`)
  }
  lines.push('', 'Reference rewrites (report-only by default; sessions are NEVER rewritten):')
  for (const ref of plan.references) {
    lines.push(`  ${ref.verified ? 'verified' : 'unverified'}/${ref.reportOnly ? 'report-only' : 'rewritable'} ${ref.surface} @ ${ref.location}`)
    lines.push(`    ${ref.before}  →  ${ref.after}`)
  }
  if (plan.pinnedSuggestions.length > 0) {
    lines.push('', `pinnedModels suggestion: ${plan.pinnedSuggestions.join(', ')}`)
  }
  lines.push('', `Backup: ${plan.backupPath}`)
  lines.push(`Rollback: ${plan.rollbackCommand}`)
  if (plan.unverified.length > 0) {
    lines.push('', 'Unverified (report-only):')
    for (const item of plan.unverified) lines.push(`  - ${item}`)
  }
  lines.push('', `planHash: ${plan.planHash}`)
  lines.push(`confirmCode: ${plan.confirmCode}`)
  lines.push('apply: /model-sync migrate apply  --plan <planHash>  --confirm <confirmCode>')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Orchestration deps + result types
// ---------------------------------------------------------------------------

export interface MigrateDeps {
  settings: SettingsService | undefined
  ownershipStore: GoOwnershipStore
  migrationStore: MigrationStateStore
  logger: Logger
  /** Frozen official listing captured for plan/apply/rollback (no live network here). */
  entries: readonly GoModelRecord[]
  routes: Partial<Record<GoRouteSlot, string>>
  ref: string
  keyFingerprint: string
  adopt?: boolean
  rewriteRefs?: RewriteRefMode
  references?: ReferenceCandidate[]
  now: number
  /** M-5: true when a go sync round currently holds the single-flight lock. */
  isSyncInFlight?: () => boolean
  /** Optional: execute an opt-in rewrite of a verified reference key. Default: none. */
  applyReferenceRewrite?: (rewrite: ReferenceRewrite) => Promise<void>
}

function buildFromDeps(deps: MigrateDeps, record: MigrationRecord | undefined): MigrationPlan {
  return buildMigrationPlan({
    descriptor: deps.settings?.describe().find((desc) => desc.ns === 'llm-pi-ai'),
    entries: deps.entries,
    routes: deps.routes,
    ref: deps.ref,
    keyFingerprint: deps.keyFingerprint,
    adopt: deps.adopt,
    rewriteRefs: deps.rewriteRefs,
    record,
    references: deps.references,
    now: deps.now,
  })
}

async function readRecord(deps: { migrationStore: MigrationStateStore }): Promise<MigrationRecord | undefined> {
  try {
    return await deps.migrationStore.read()
  } catch {
    return undefined
  }
}

function llmDescriptor(settings: SettingsService | undefined): SettingsDescriptor | undefined {
  return settings?.describe().find((desc) => desc.ns === 'llm-pi-ai')
}

function rawRoute(desc: SettingsDescriptor | undefined, route: string): Record<string, unknown> | undefined {
  const providers = desc?.user?.providers
  if (!isRecord(providers)) return undefined
  const data = providers[route]
  return isRecord(data) ? data : undefined
}

function rawModels(desc: SettingsDescriptor | undefined, route: string): SettingsModelProfile[] {
  const models = rawRoute(desc, route)?.models
  return Array.isArray(models) ? models as SettingsModelProfile[] : []
}

function isConflictError(err: unknown): boolean {
  return (err as Record<string, unknown> | undefined)?.code === 'SETTINGS_CONFLICT'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Set ops that write exactly the target fields + models for one route. */
function routeOps(
  desc: SettingsDescriptor | undefined,
  route: string,
  fields: GoPlannedRouteFields,
  models: SettingsModelProfile[],
): SettingsMutationOp[] {
  const data = rawRoute(desc, route)
  const ops: SettingsMutationOp[] = []
  for (const field of OWNED_FIELDS) {
    if (data?.[field] !== fields[field]) {
      ops.push({ op: 'set', path: ['providers', route, field], value: fields[field] })
    }
  }
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id))
  const current = [...rawModels(desc, route)].sort((a, b) => a.id.localeCompare(b.id))
  if (current.length !== sorted.length || current.some((profile, index) => profileHash(profile) !== profileHash(sorted[index]))) {
    ops.push({ op: 'set', path: ['providers', route, 'models'], value: sorted })
  }
  return ops
}

async function mutateWithRetry(
  deps: MigrateDeps,
  ops: SettingsMutationOp[],
): Promise<void> {
  const settings = deps.settings
  if (settings === undefined) throw new Error('settings service unavailable')
  const desc = llmDescriptor(settings)
  if (desc === undefined) throw new Error('llm-pi-ai namespace unavailable')
  try {
    await settings.mutate('llm-pi-ai', ops, desc.revision)
  } catch (err) {
    if (!isConflictError(err)) throw err
    const fresh = llmDescriptor(settings)
    if (fresh === undefined) throw new Error('llm-pi-ai namespace disappeared on retry')
    await settings.mutate('llm-pi-ai', ops, fresh.revision)
  }
}

// ---------------------------------------------------------------------------
// apply (V17 / V19 / V22): consent gate → backup → settings → ledger → fingerprint
// ---------------------------------------------------------------------------

export type MigrateApplyReason =
  | 'applied'
  | 'consent-required'
  | 'plan-hash-mismatch'
  | 'confirm-code-mismatch'
  | 'nothing-to-apply'
  | 'sync-in-flight'
  | 'write-failed'

export interface MigrateApplyResult {
  ok: boolean
  reason: MigrateApplyReason
  planHash: string
  confirmCode: string
  routes: { route: string; status: 'wrote' | 'failed' | 'skipped'; reason?: string }[]
  backupPath?: string
  text: string
}

function applyFailure(reason: MigrateApplyReason, planHash: string, confirmCode: string, detail: string): MigrateApplyResult {
  return { ok: false, reason, planHash, confirmCode, routes: [], text: `migrate apply refused (${reason}): ${detail}; zero writes` }
}

export async function applyMigration(
  args: { planHash?: string; confirmCode?: string },
  deps: MigrateDeps,
): Promise<MigrateApplyResult> {
  const prior = await readRecord(deps)
  const plan = buildFromDeps(deps, prior)

  // 1. Consent — every rejection below is ZERO writes.
  const consent = verifyConsent(plan, args.planHash, args.confirmCode)
  if (!consent.ok) return applyFailure(consent.reason, plan.planHash, plan.confirmCode, `${consent.reason}`)

  if (plan.state !== 'legacy-inherit' && plan.state !== 'legacy-inline' && plan.state !== 'drifted') {
    return applyFailure('nothing-to-apply', plan.planHash, plan.confirmCode, `state=${plan.state} (nothing needs migration)`)
  }

  // 2. Single flight against the go sync round (V22). The scheduler drops its
  // own rounds once `applying` is persisted (step 3); this check rejects apply
  // while a round already holds the lock.
  if (deps.isSyncInFlight?.() === true) {
    return applyFailure('sync-in-flight', plan.planHash, plan.confirmCode, 'a go sync round is in flight; retry when it finishes')
  }
  if (typeof deps.migrationStore.write !== 'function') {
    return applyFailure('write-failed', plan.planHash, plan.confirmCode, 'migration store is read-only')
  }

  const desc = llmDescriptor(deps.settings)
  if (desc === undefined || deps.settings === undefined) {
    return applyFailure('write-failed', plan.planHash, plan.confirmCode, 'settings/llm-pi-ai unavailable')
  }

  // 3. Capture the audit backup and persist `applying` BEFORE the first mutate.
  //    If we crash mid-apply, the record still carries the restore snapshot.
  const backup = captureBackup(plan, desc, deps.now)
  const applyingRecord: MigrationRecord = {
    ...(prior ?? {}),
    applying: true,
    backup,
    planHash: plan.planHash,
    legacyFingerprint: plan.preFingerprint,
  }
  try {
    await deps.migrationStore.write!(applyingRecord)
  } catch (err) {
    return applyFailure('write-failed', plan.planHash, plan.confirmCode, `could not persist applying flag: ${errorText(err)}`)
  }

  const routesResult: MigrateApplyResult['routes'] = []
  const committedLedgerKeys: string[] = []
  const writtenRoutes: string[] = []
  let failure: string | undefined

  try {
    for (const planned of plan.routes) {
      if (planned.action === 'keep') {
        routesResult.push({ route: planned.route, status: 'skipped', reason: 'already-applied' })
        continue
      }
      const current = rawModels(desc, planned.route)
      const currentIds = new Set(current.map((model) => model.id))
      // Conservative: keep every existing id and add only missing desired ones.
      // Adopt: the plan's desired set (+ already-present pinned targets) is canonical.
      const merged = deps.adopt === true
        ? [...planned.desired]
        : [...current, ...planned.desired.filter((profile) => !currentIds.has(profile.id))]

      const ops = routeOps(desc, planned.route, planned.fields, merged)
      if (ops.length > 0) {
        try {
          await mutateWithRetry(deps, ops)
          writtenRoutes.push(planned.route)
        } catch (err) {
          failure = `${planned.route}: settings mutate failed (${errorText(err)})`
          routesResult.push({ route: planned.route, status: 'failed', reason: errorText(err) })
          break
        }
      }

      // Ledger: conservative mode keeps user ids unclaimed; adopt claims desired.
      const managed: Record<string, GoManagedModel> = {}
      if (deps.adopt === true) {
        for (const profile of planned.desired) managed[profile.id] = { hash: profileHash(profile) }
      }
      const ledgerKey = goOwnershipKey(planned.route, deps.keyFingerprint)
      const preManagedSection = backup.routes[planned.route]?.section
      const entry: GoOwnershipEntry = {
        routeFields: planned.fields,
        managed,
        // Legacy audit fields, still used by the P1b eject path.
        preManagedSnapshot: current.map((profile) => ({ ...profile })),
        // §14.3 whole-section snapshot: the exact pre-apply section (null when
        // the route did not exist) plus the ids this apply introduced. Both ride
        // the ledger's models-store queue and survive a successful apply.
        preManagedSection: preManagedSection === undefined ? null : structuredClone(preManagedSection),
        appliedAddedIds: merged.map((profile) => profile.id).filter((id) => !currentIds.has(id)).sort(),
      }
      try {
        await deps.ownershipStore.write(ledgerKey, entry)
        committedLedgerKeys.push(ledgerKey)
      } catch (err) {
        failure = `${planned.route}: ledger write failed (${errorText(err)})`
        routesResult.push({ route: planned.route, status: 'failed', reason: errorText(err) })
        break
      }
      routesResult.push({ route: planned.route, status: 'wrote' })
    }
  } catch (err) {
    failure = errorText(err)
  }

  if (failure === undefined) {
    // 4. Fingerprint LAST (§14.7.4): only after settings + ledger both landed.
    const identityRoutes = Object.keys(readGoProviderSections(llmDescriptor(deps.settings), Object.values(routesOf(deps))) ?? {})
    const liveSections = readGoProviderSections(llmDescriptor(deps.settings), Object.values(routesOf(deps)))
    const identity = fingerprintGoIdentity(liveSections, identityRoutes)
    const managedIds = Object.fromEntries(Object.values(routesOf(deps)).map((route) => [route, plannedManagedIds(plan, route, deps)]))
    const applied: MigrationRecord = {
      ...(prior ?? {}),
      applying: false,
      // Keep the captured whole-section backup: it is the audit copy and the
      // crash-window fallback for rollback. The authoritative copy also lives
      // on each ledger entry (preManagedSection), so neither is discarded.
      backup,
      planHash: plan.planHash,
      backupPath: plan.backupPath,
      appliedAt: deps.now,
      appliedIdentity: identity,
      appliedIdentityRoutes: identityRoutes,
      appliedManagedIds: managedIds,
      appliedFingerprint: appliedFingerprintOf(identity, managedIds),
      movedIds: plan.deletions.filter((del) => del.willDelete).map((del) => del.id),
      legacyFingerprint: undefined,
    }
    try {
      await deps.migrationStore.write!(applied)
    } catch (err) {
      failure = `appliedFingerprint persist failed (${errorText(err)})`
    }

    // 5. Opt-in reference rewrite — only verified config keys, never sessions.
    if (failure === undefined && plan.rewriteRefs !== 'none' && deps.applyReferenceRewrite !== undefined) {
      for (const ref of plan.references) {
        if (!ref.verified || !ref.rewritable || ref.reportOnly) continue
        try {
          await deps.applyReferenceRewrite({ surface: ref.surface, location: ref.location, before: ref.before, after: ref.after })
        } catch (err) {
          deps.logger.warn('reference rewrite failed for %s: %s', ref.surface, errorText(err))
        }
      }
    }
  }

  if (failure !== undefined) {
    // Best-effort restore from the captured snapshot; re-lock and keep no fingerprint.
    await restoreOnApplyFailure(deps, backup, writtenRoutes, committedLedgerKeys, prior)
    deps.logger.warn('migrate apply rolled back after failure: %s', failure)
    return applyFailure('write-failed', plan.planHash, plan.confirmCode, failure)
  }

  const text = [
    `migrate apply: ${routesResult.filter((r) => r.status === 'wrote').length} routes written, fingerprint persisted`,
    ...routesResult.map((r) => `  ${r.route}: ${r.status}${r.reason !== undefined ? ` (${r.reason})` : ''}`),
    `  backup: ${plan.backupPath}`,
    `  rollback: /model-sync migrate rollback --plan ${plan.planHash}`,
  ].join('\n')
  return {
    ok: true,
    reason: 'applied',
    planHash: plan.planHash,
    confirmCode: plan.confirmCode,
    routes: routesResult,
    backupPath: plan.backupPath,
    text,
  }
}

function routesOf(deps: MigrateDeps): Partial<Record<GoRouteSlot, string>> {
  return { ...GO_SLOT_ROUTES, ...deps.routes }
}

function plannedManagedIds(plan: MigrationPlan, route: string, deps: MigrateDeps): string[] {
  if (deps.adopt !== true) return []
  const planned = plan.routes.find((entry) => entry.route === route)
  return (planned?.desired ?? []).map((profile) => profile.id).sort()
}

function captureBackup(plan: MigrationPlan, desc: SettingsDescriptor, now: number): MigrationBackup {
  const backup: MigrationBackup = { planHash: plan.planHash, capturedAt: now, routes: {} }
  for (const planned of plan.routes) {
    const section = rawRoute(desc, planned.route)
    backup.routes[planned.route] = {
      ...(section === undefined ? {} : { section: structuredClone(section) as Record<string, unknown> }),
    }
  }
  return backup
}

/** Best-effort undo of a partial apply: restore route sections, drop new ledger entries, clear applying. */
async function restoreOnApplyFailure(
  deps: MigrateDeps,
  backup: MigrationBackup,
  writtenRoutes: string[],
  ledgerKeys: string[],
  prior: MigrationRecord | undefined,
): Promise<void> {
  const desc = llmDescriptor(deps.settings)
  for (const route of writtenRoutes) {
    if (desc === undefined) continue
    const original = backup.routes[route]?.section
    const ops: SettingsMutationOp[] = []
    if (original === undefined) {
      ops.push({ op: 'unset', path: ['providers', route] })
    } else {
      // Restore via field-level ops (never replace the whole section): unset the
      // route first so plugin-created sections disappear, then reapply the
      // original fields/models. This keeps the operation compatible with the
      // writer's path-based mutate contract (§14.3: no whole-section write-back).
      ops.push({ op: 'unset', path: ['providers', route] })
      for (const [field, value] of Object.entries(original)) {
        if (field === 'models' && !Array.isArray(value)) continue
        ops.push({ op: 'set', path: ['providers', route, field], value: structuredClone(value) })
      }
    }
    try {
      await mutateWithRetry(deps, ops)
    } catch (err) {
      deps.logger.warn('apply-failure restore failed for %s: %s', route, errorText(err))
    }
  }
  for (const key of ledgerKeys) {
    try {
      const original = backup.routes[key.split('#')[0]]?.ledger
      if (original === undefined) await deps.ownershipStore.delete(key)
      else await deps.ownershipStore.write(key, original as unknown as GoOwnershipEntry)
    } catch (err) {
      deps.logger.warn('apply-failure ledger restore failed for %s: %s', key, errorText(err))
    }
  }
  if (typeof deps.migrationStore.write === 'function') {
    try {
      await deps.migrationStore.write({ ...(prior ?? {}), applying: false })
    } catch (err) {
      deps.logger.warn('apply-failure applying flag clear failed: %s', errorText(err))
    }
  }
}

// ---------------------------------------------------------------------------
// rollback (V20): restore snapshot, clear ledger+fingerprint, re-lock
// ---------------------------------------------------------------------------

export type MigrateRollbackReason =
  | 'rolled-back'
  | 'consent-required'
  | 'plan-hash-mismatch'
  | 'no-record'
  | 'snapshot-missing'
  | 'hash-mismatch'

export interface MigrateRollbackResult {
  ok: boolean
  reason: MigrateRollbackReason
  routes: string[]
  text: string
}

export async function rollbackMigration(
  args: { planHash?: string },
  deps: MigrateDeps,
): Promise<MigrateRollbackResult> {
  const refuse = (reason: MigrateRollbackReason, detail: string): MigrateRollbackResult => ({
    ok: false, reason, routes: [], text: `migrate rollback refused (${reason}): ${detail}; zero writes`,
  })

  const record = await readRecord(deps)
  if (record === undefined) return refuse('no-record', 'no migration record to roll back')
  if (typeof args.planHash !== 'string' || args.planHash === '') return refuse('consent-required', 'a --plan <hash> is required')
  if (record.planHash !== args.planHash) return refuse('plan-hash-mismatch', `record hash != ${args.planHash}`)
  // A crashed apply leaves `applying:true` + the captured backup but no
  // fingerprint; rollback must still be able to restore from that backup.
  if (record.appliedFingerprint === undefined && record.backup === undefined) {
    return refuse('no-record', 'record has neither appliedFingerprint nor a captured backup')
  }

  const desc = llmDescriptor(deps.settings)
  if (desc === undefined || deps.settings === undefined) return refuse('snapshot-missing', 'settings/llm-pi-ai unavailable')

  const routeIds = Object.values(routesOf(deps))
  // Hash check: every plugin-managed id still present in settings must match the
  // hash we wrote. An external edit → refuse (never clobber user changes).
  for (const route of routeIds) {
    const entry = await deps.ownershipStore.read(goOwnershipKey(route, deps.keyFingerprint)).catch(() => undefined)
    if (entry === undefined) continue
    const currentById = new Map(rawModels(desc, route).map((profile) => [profile.id, profile]))
    for (const [id, managed] of Object.entries(entry.managed ?? {})) {
      const model = currentById.get(id)
      if (model !== undefined && profileHash(model) !== managed.hash) {
        return refuse('hash-mismatch', `${route}/${id} changed after apply (managed hash mismatch)`)
      }
    }
  }

  // Reconstruct each route from the WHOLE pre-apply section (§14.3), not from a
  // models-only list. Restore its exact fields/values/order, remove ids this
  // migration introduced, and keep ids the user added after apply.
  const rollbackOps: { route: string; ops: SettingsMutationOp[] }[] = []
  for (const route of routeIds) {
    const entry = await deps.ownershipStore.read(goOwnershipKey(route, deps.keyFingerprint)).catch(() => undefined)
    const backupRoute = record.backup?.routes[route]
    if (entry === undefined && backupRoute === undefined) continue
    // Authoritative snapshot: the ledger copy written by apply, or the captured
    // backup for a crash before the ledger commit. `null`/`undefined` section
    // means the route did not exist before the migration; a written-but-missing
    // field is the snapshot-missing refusal below.
    const hasSectionSnapshot = entry !== undefined
      ? entry.preManagedSection !== undefined
      : backupRoute !== undefined
    if (!hasSectionSnapshot) return refuse('snapshot-missing', `${route} has no preManagedSection`)
    const originalSection = entry !== undefined ? entry.preManagedSection : backupRoute?.section

    const originalModels: SettingsModelProfile[] = Array.isArray(originalSection?.models)
      ? originalSection.models as SettingsModelProfile[]
      : []
    const originalIds = new Set(originalModels.map((profile) => profile.id))
    const current = rawModels(desc, route)
    // Ids introduced by the migration itself: recorded at apply time when a
    // ledger exists. For a crash-window rollback every current id absent from
    // the captured snapshot was written by the half-finished apply.
    const addedIds = entry !== undefined
      ? new Set(entry.appliedAddedIds ?? [])
      : new Set(current.filter((profile) => !originalIds.has(profile.id)).map((profile) => profile.id))
    // A post-apply id is neither in the original section nor one of ours — keep
    // it (never clobber user edits, even if it sits on a plugin-created route).
    const userAdded = current.filter((profile) => !originalIds.has(profile.id) && !addedIds.has(profile.id))
    const finalModels = [...originalModels, ...userAdded]

    const ops: SettingsMutationOp[] = []
    if (originalSection === null || originalSection === undefined) {
      // Route did not exist before apply: drop everything the plugin created,
      // keeping only models the user added afterwards.
      ops.push({ op: 'unset', path: ['providers', route] })
      if (finalModels.length > 0) ops.push({ op: 'set', path: ['providers', route, 'models'], value: finalModels })
    } else {
      // Rebuild field-by-field in the ORIGINAL key order with the ORIGINAL values
      // so the restored bytes match the pre-apply section exactly: fields that
      // existed before are restored (never unset), fields apply wrote that were
      // absent before disappear with the whole-section reset, and the models
      // array keeps its original order with user-added ids appended.
      ops.push({ op: 'unset', path: ['providers', route] })
      const hasModelsKey = Object.prototype.hasOwnProperty.call(originalSection, 'models')
      for (const [field, value] of Object.entries(originalSection)) {
        if (field === 'models') {
          if (hasModelsKey) ops.push({ op: 'set', path: ['providers', route, 'models'], value: finalModels })
        } else {
          ops.push({ op: 'set', path: ['providers', route, field], value: structuredClone(value) })
        }
      }
      if (!hasModelsKey && finalModels.length > 0) {
        ops.push({ op: 'set', path: ['providers', route, 'models'], value: finalModels })
      }
    }
    if (ops.length > 0) rollbackOps.push({ route, ops })
  }

  for (const item of rollbackOps) {
    try {
      await mutateWithRetry(deps, item.ops)
    } catch (err) {
      return refuse('hash-mismatch', `${item.route}: settings mutate failed (${errorText(err)})`)
    }
  }
  for (const route of routeIds) {
    try {
      await deps.ownershipStore.delete(goOwnershipKey(route, deps.keyFingerprint))
    } catch (err) {
      deps.logger.warn('rollback ledger cleanup failed for %s: %s', route, errorText(err))
    }
  }
  if (typeof deps.migrationStore.write === 'function') {
    // Clear the applied marker + fingerprint; the state falls back to legacy-*
    // from the restored sections, so go sync write authority is re-locked.
    await deps.migrationStore.write({
      ...(record.legacyFingerprint !== undefined ? { legacyFingerprint: record.legacyFingerprint } : {}),
      applying: false,
    })
  }

  return {
    ok: true,
    reason: 'rolled-back',
    routes: rollbackOps.map((item) => item.route),
    text: `migrate rollback: restored ${rollbackOps.length} routes, cleared ledger + fingerprint, write authority re-locked`,
  }
}

// ---------------------------------------------------------------------------
// status (read-only): per-route state + write authority (V16)
// ---------------------------------------------------------------------------

export interface MigrationRouteStatus {
  route: string
  state: MigrationState
  owner: string
  decision: 'write' | 'skip'
  reason: string
}

export interface MigrateStatusResult {
  overall: MigrationState
  applying: boolean
  routes: MigrationRouteStatus[]
  text: string
}

export async function migrationStatusReport(
  deps: Pick<MigrateDeps, 'settings' | 'migrationStore' | 'keyFingerprint' | 'routes' | 'now'>,
  config?: Partial<RouteWriterConfig>,
): Promise<MigrateStatusResult> {
  const details = deps.settings?.describe().find((desc) => desc.ns === 'llm-pi-ai')
  const record = await readRecord(deps)
  const routeIds = Object.values({ ...GO_SLOT_ROUTES, ...deps.routes })
  const sections = readGoProviderSections(details, routeIds)
  const overall = migrationStateForPlan(sections, record, routeIds[0])
  const states = detectRouteStates(sections, record, routeIds, overall)
  const authority: RouteWriterConfig = {
    caller: config?.caller ?? 'go',
    goEnabled: config?.goEnabled ?? true,
    goRoutes: routeIds,
    zenMode: config?.zenMode,
    zenRoutes: config?.zenRoutes,
  }
  const stub = {
    state: overall,
    fingerprint: fingerprintSection(sections ?? {}),
    identity: fingerprintGoIdentity(sections, record?.appliedIdentityRoutes),
    appliedIdentity: record?.appliedIdentity,
    appliedFingerprint: record?.appliedFingerprint,
    applying: record?.applying === true,
    fingerprintHealed: false,
    expectedFingerprint: '',
  }
  const routes = routeIds.map((route) => {
    const decision = routeWriter(route, authority, stub)
    return { route, state: states[route] ?? 'absent', owner: decision.owner, decision: decision.decision, reason: decision.reason }
  })
  const lines = [
    `model-sync migrate status: ${overall}${stub.applying ? ' (applying)' : ''}`,
    ...routes.map((r) => `  ${r.route}: state=${r.state} owner=${r.owner} ${r.decision}${r.reason !== undefined ? ` (${r.reason})` : ''}`),
  ]
  // B1 compatibility: unscoped legacy keys are reported but NEVER claimed.
  // A pre-fix record has no profile stamp, so its owner is unknown; adopting
  // it could open the gate for a profile that never consented. Tell the user
  // to re-migrate in the owning profile instead of silently using the record.
  let legacy: string[] = []
  try {
    legacy = await deps.migrationStore.legacyKeys?.() ?? []
  } catch {
    // Detection is advisory — an unreadable store never changes status.
  }
  if (legacy.length > 0) {
    lines.push(`  警告: 检测到 ${legacy.length} 个无 profile 前缀的旧键（归属未知，未认领）: ${legacy.join(', ')}；请在归属 profile 重新运行 /model-sync migrate plan/apply`)
  }
  return { overall, applying: stub.applying, routes, text: lines.join('\n') }
}

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
  /** Public catalog unavailable (offline/401/403) — fail-closed, never deleted (§14.2). */
  | 'unclassified'

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

/**
 * One row of the plan's per-id action table (design §14.2 / 31 B2). This is the
 * SINGLE source of truth consumed by apply: it is hashed into planHash, so a
 * plan and its apply can never disagree. `keep` rows are never destructive.
 */
export type MigrationIdActionOp = 'keep' | 'add' | 'update' | 'move' | 'delete'

export interface MigrationIdPlan {
  id: string
  op: MigrationIdActionOp
  /** Route the op operates on (source route for `move`/`delete`). */
  route: string
  /** Destination route for `move` (the id is removed from `route`). */
  to?: string
  kind: MigrationIdKind
  /** True when the id is in pinnedModels — forced `keep`, never moved/deleted. */
  pinned: boolean
  /** Exact profile to write for add/move. Set on `update` rows as the official
   *  target only for the plan's before/after report — apply never writes it. */
  profile?: SettingsModelProfile
  /** Current profile on an `update` row (user-modified) — for before/after output. */
  before?: SettingsModelProfile
  /** True iff applying this row puts the id under plugin ownership (managed ledger).
   *  `update` and user-owned `keep` rows are false by construction (B6 + user ruling). */
  managed?: boolean
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
  /** The complete per-id action table apply executes verbatim (31 B2). */
  idActions: MigrationIdPlan[]
  /** Fixed B6 informed-consent text; hashed into planHash so edits invalidate it. */
  managedAfterMigration: string
  /** True when the official public catalog was unavailable at plan time. Every
   *  non-desired id is then `unclassified` and never deleted (fail-closed). */
  publicCatalogAvailable: boolean
  /** True when apply cannot guarantee verbatim action-table execution: plan mode
   *  is `adopt-disabled` and `--adopt` is rejected at the command layer (§14.2). */
  adoptDisabled: boolean
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
  /** go.pinnedModels: ids forced to `keep` (never moved or deleted, 31 B2). */
  pinnedModels?: readonly string[]
  /** Only with this flag may user-extra ids be deleted — and only if plan-listed. */
  pruneUserExtra?: boolean
  /** Official *public* catalog ids (may include ids the current key cannot use).
   *  Ids present here but absent from `entries` are `unknown-retired`; ids in
   *  neither set are `user-extra` (user-written, never auto-deleted). `undefined`
   *  means the catalog was unavailable → fail-closed `unclassified`. */
  publicCatalogIds?: readonly string[]
  /** Apply cannot execute the per-id table → plan mode `adopt-disabled` and
   *  `--adopt` rejected at the command layer (design §14.2 fallback). */
  adoptDisabled?: boolean
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

/** The action-table subset both plan-time simulation and apply consume. */
export interface MigrationActionTable {
  routes: readonly MigrationPlannedRoute[]
  idActions: readonly MigrationIdPlan[]
}

/**
 * THE single source of truth for the per-route "managed after apply" id set.
 *
 * It simulates the action table against the SAME settings descriptor apply
 * will use, so the ids the plan advertises are exactly the ids apply actually
 * writes or adopts into the ownership ledger. An id already sitting on its
 * target with a user-edited value (an `update` row, or a `move` onto a
 * different-valued target) is NEVER claimed: it is not written, so it must not
 * be advertised as managed anywhere (B6 + user ruling: update never overwrites
 * and never manages).
 *
 * `buildMigrationPlan` derives the informed-consent text from this function,
 * and `applyMigration` derives the ledger `managed` / `appliedManagedIds` from
 * the very same `buildRouteWriteStates` computation, so the four surfaces
 * cannot disagree.
 */
export function managedIdsAfterApply(
  table: MigrationActionTable,
  desc: SettingsDescriptor | undefined,
): Record<string, string[]> {
  const { byRoute } = buildRouteWriteStates(table, desc)
  return Object.fromEntries(
    [...byRoute].map(([route, state]) => [
      route,
      Object.keys(state.managed).sort((a, b) => a.localeCompare(b)),
    ]),
  )
}

const KNOWN_ACTION_OPS: ReadonlySet<string> = new Set<string>(['keep', 'add', 'update', 'move', 'delete'])

/**
 * Fail-closed guard: any op outside the closed `MigrationIdActionOp` union is
 * rejected before a single write. Returns the first offending row, if any.
 */
export function findUnknownAction(actions: readonly MigrationIdPlan[]): { id: string; op: string } | undefined {
  for (const action of actions) {
    if (!KNOWN_ACTION_OPS.has(String(action.op))) return { id: action.id, op: String(action.op) }
  }
  return undefined
}

export type ConsentResult =
  | { ok: true }
  | { ok: false; reason: 'consent-required' | 'plan-hash-mismatch' | 'confirm-code-mismatch' | 'ack-required' }

/**
 * The consent gate (V17 + 31 B6). THREE values are mandatory: the matching
 * planHash, the 6-digit confirmCode and `--ack-managed` (acknowledgement of the
 * `[managed-after-migration]` notice). A missing/incorrect value never reaches
 * a write. Deliberately there is no accept-anything branch — `--yes`/`--auto`
 * cannot be expressed.
 */
export function verifyConsent(
  plan: MigrationPlan,
  planHash: string | undefined,
  confirmCode: string | undefined,
  ackManaged?: boolean,
): ConsentResult {
  if (typeof planHash !== 'string' || planHash === ''
    || typeof confirmCode !== 'string' || confirmCode === '') {
    return { ok: false, reason: 'consent-required' }
  }
  if (planHash !== plan.planHash) return { ok: false, reason: 'plan-hash-mismatch' }
  if (confirmCode !== plan.confirmCode) return { ok: false, reason: 'confirm-code-mismatch' }
  if (ackManaged !== true) return { ok: false, reason: 'ack-required' }
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
  // Fail-closed capability gate (§14.2): when the executor cannot guarantee the
  // action table, adopt is reported as disabled and plan rows stay conservative.
  const adoptDisabled = input.adoptDisabled === true
  const adopt = input.adopt === true && !adoptDisabled
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

  // Routes actually in scope for this plan (a conditional, empty google slot
  // with no pre-existing section is skipped — §9.4).
  const scopedRoutes: {
    slot: GoRouteSlot
    route: string
    state: MigrationState
    fields: GoPlannedRouteFields
    desired: SettingsModelProfile[]
    currentModels: SettingsModelProfile[]
  }[] = []
  for (const slot of ['chat', 'msg', 'resp', 'google'] as const) {
    if (slot === 'google' && desiredBySlot.get(slot)!.length === 0 && sections?.[routes[slot]] === undefined) continue
    const route = routes[slot]
    const section = sections?.[route]
    const routeState = stateByRoute[route] ?? 'absent'
    const fields = planGoRouteFields(slot, input.entries.filter((entry) => grouping.slots[slot].includes(entry.id)), input.ref)
    const desired = desiredBySlot.get(slot) ?? []
    const currentModels: SettingsModelProfile[] = isRecord(section) && Array.isArray(section.models)
      ? section.models as SettingsModelProfile[]
      : []
    scopedRoutes.push({ slot, route, state: routeState, fields, desired, currentModels })
  }

  // desired id → its official target route + exact profile.
  const desiredTarget = new Map<string, { slot: GoRouteSlot; route: string; profile: SettingsModelProfile }>()
  for (const scope of scopedRoutes) {
    for (const profile of scope.desired) {
      desiredTarget.set(profile.id, { slot: scope.slot, route: scope.route, profile })
    }
  }

  // Every id currently in settings, with all the routes it occupies.
  const currentLocations = new Map<string, { route: string; profile: SettingsModelProfile }[]>()
  for (const scope of scopedRoutes) {
    for (const profile of scope.currentModels) {
      const list = currentLocations.get(profile.id) ?? []
      list.push({ route: scope.route, profile })
      currentLocations.set(profile.id, list)
    }
  }

  const pinnedIds = new Set(input.pinnedModels ?? [])
  // `undefined` is materially different from an empty list: empty means the
  // catalog was fetched and truly has no such id (→ user-extra); undefined means
  // it could not be fetched at all (→ unclassified, never deleted).
  const publicCatalogAvailable = input.publicCatalogIds !== undefined
  const publicIds = new Set(input.publicCatalogIds ?? [])
  const pruneUserExtra = input.pruneUserExtra === true

  const kindOf = (id: string): MigrationIdKind => {
    const target = desiredTarget.get(id)
    if (target !== undefined) return `desired-${target.slot}` as MigrationIdKind
    // Fail-closed (§14.2): no public catalog → never guess "user-written".
    if (!publicCatalogAvailable) return 'unclassified'
    // Ids in the official public catalog but not in the current key's authorized
    // list are unknown-retired; ids in neither set are user-written extras.
    return publicIds.has(id) ? 'unknown-retired' : 'user-extra'
  }

  // ---- The per-id action table: the SINGLE source of truth for apply (31 B2) ----
  const idActions: MigrationIdPlan[] = []
  const idsInScope = new Set<string>([...currentLocations.keys(), ...desiredTarget.keys()])
  for (const id of [...idsInScope].sort((a, b) => a.localeCompare(b))) {
    const kind = kindOf(id)
    const target = desiredTarget.get(id)
    const locations = currentLocations.get(id) ?? []
    const isPinned = pinnedIds.has(id)

    if (isPinned) {
      // User ruling "pinned = 两边都放": every existing copy is kept in place AND
      // a copy is added to the official target route (duplicate display allowed).
      // A pinned desired id is never moved/deleted, even in adopt mode.
      if (locations.length === 0) {
        if (target !== undefined) idActions.push({
          id, op: 'add', route: target.route, kind, pinned: true, profile: target.profile, managed: true,
          reason: 'pinnedModels: added to its official route (never moved/deleted)',
        })
      } else {
        for (const loc of locations) idActions.push({
          id, op: 'keep', route: loc.route, kind, pinned: true, profile: loc.profile,
          reason: 'pinnedModels: forced keep (not moved, not deleted)',
        })
        if (target !== undefined && !locations.some((loc) => loc.route === target.route)) {
          idActions.push({
            id, op: 'add', route: target.route, kind, pinned: true, profile: target.profile, managed: true,
            reason: 'pinnedModels: old copy kept; also added to its official route (duplicate display allowed)',
          })
        }
      }
      continue
    }

    if (target !== undefined) {
      // Official desired id: make sure it ends up on its target route.
      const targetLoc = locations.find((loc) => loc.route === target.route)
      if (targetLoc === undefined) {
        if (locations.length === 0) {
          idActions.push({ id, op: 'add', route: target.route, kind, pinned: false, profile: target.profile, managed: true,
            reason: 'desired id missing from its official route' })
        } else if (adopt) {
          for (const loc of locations) idActions.push({
            id, op: 'move', route: loc.route, to: target.route, kind, pinned: false, profile: target.profile, managed: true,
            reason: 'adopt: move desired id from its legacy route (old copy removed)',
          })
        } else {
          idActions.push({ id, op: 'add', route: target.route, kind, pinned: false, profile: target.profile, managed: true,
            reason: 'conservative: keep existing copy, add desired id to its official route' })
          for (const loc of locations) idActions.push({
            id, op: 'keep', route: loc.route, kind, pinned: false, profile: loc.profile,
            reason: 'conservative: existing copy kept as user-owned',
          })
        }
      } else {
        // Already on the target route. A user-edited profile is reported as an
        // UPDATE/drift row with before→after, but apply NEVER overwrites it and
        // NEVER claims it as managed (user ruling).
        if (profileHash(targetLoc.profile) !== profileHash(target.profile)) {
          idActions.push({ id, op: 'update', route: target.route, kind, pinned: false,
            profile: target.profile, before: targetLoc.profile,
            reason: 'user-modified desired value: plan shows before→after; apply leaves it untouched and unmanaged' })
        } else {
          idActions.push({ id, op: 'keep', route: target.route, kind, pinned: false, profile: target.profile, managed: true,
            reason: 'desired id already matches the official value (adopted into ledger)' })
        }
        if (adopt) {
          for (const loc of locations) {
            if (loc.route === target.route) continue
            idActions.push({ id, op: 'move', route: loc.route, to: target.route, kind, pinned: false, profile: target.profile, managed: true,
              reason: 'adopt: remove duplicate desired id from the wrong route' })
          }
        }
      }
      continue
    }

    // Non-desired id: user-extra / unknown-retired / unclassified. Default keep.
    // Delete only when the classification's own flag is set AND the row is in
    // this plan. `unclassified` (no public catalog) is never deletable.
    const mayDelete = kind === 'user-extra' ? pruneUserExtra : kind === 'unknown-retired' ? adopt : false
    for (const loc of locations) {
      if (mayDelete) {
        idActions.push({ id, op: 'delete', route: loc.route, kind, pinned: false, profile: loc.profile,
          reason: kind === 'user-extra'
            ? '--prune-user-extra: explicitly listed for deletion in this plan'
            : 'adopt: unknown-retired id explicitly listed for deletion in this plan' })
      } else {
        idActions.push({ id, op: 'keep', route: loc.route, kind, pinned: false, profile: loc.profile,
          reason: kind === 'unclassified'
            ? 'public catalog unavailable (unclassified): never deleted (fail-closed)'
            : describeId(kind, adopt) })
      }
    }
  }

  // Deletions are reported with the three-gate explanation, driven from the
  // SAME action table (so the report cannot disagree with apply). `move` rows
  // are NOT deletions — they are listed in the per-id table with a destination.
  const deletions: MigrationDeletion[] = idActions
    .filter((action) => action.op === 'delete')
    .map((action) => ({
      route: action.route,
      id: action.id,
      kind: action.kind,
      gates: {
        managedHash: 'plan-confirmed: id removed by this migration',
        override: 'no modelOverrides on legacy section',
        pinned: action.pinned ? 'pinned — never removed' : 'not pinned',
      },
      willDelete: true,
      reason: action.reason,
    }))

  const plannedRoutes: MigrationPlannedRoute[] = scopedRoutes.map((scope) => {
    const seen = new Set<string>()
    const existing: MigrationIdClass[] = []
    for (const profile of scope.currentModels) {
      if (seen.has(profile.id)) continue
      seen.add(profile.id)
      const row = idActions.find((action) => action.route === scope.route && action.id === profile.id)
      const legacyAction: MigrationIdClass['action'] = row?.op === 'move' ? 'move'
        : row?.op === 'delete' ? 'delete'
          : row?.op === 'keep' ? 'keep' : 'adopt'
      existing.push({
        id: profile.id,
        kind: row?.kind ?? 'user-extra',
        action: legacyAction,
        reason: row?.reason ?? describeId('user-extra', adopt),
      })
    }
    let action: MigrationAction
    if (scope.state === 'absent') action = 'create'
    else if (scope.state === 'applied') action = 'keep'
    else action = 'update'
    return { slot: scope.slot, route: scope.route, state: scope.state, action, fields: scope.fields, desired: scope.desired, existing }
  })

  const pinnedSuggestions = new Set<string>()
  const reversibleTargets = targets.filter((id) => !grouping.slots.chat.includes(id))
  for (const id of reversibleTargets) pinnedSuggestions.add(id)
  for (const id of pinnedIds) pinnedSuggestions.add(id)

  // B6 informed-consent text — part of the hashed body: any edit to this notice
  // changes planHash and invalidates the old confirmCode/ack. The id list comes
  // from `managedIdsAfterApply`, the SAME simulation apply uses for the ledger,
  // so a user-modified `update` row or a move onto a different-valued target is
  // never advertised as managed.
  const managedByRoute = managedIdsAfterApply({ routes: plannedRoutes, idActions }, input.descriptor)
  // N2: no row may claim management on paper if the simulation shows apply
  // will not actually write/adopt that id. Normalise the per-id `managed`
  // flags to the simulated set so even the printed `[managed]` marker cannot
  // disagree with the ledger. (Turning a flag OFF cannot change the simulation
  // that produced `managedByRoute`, so plan ↔ apply stay deterministic.)
  for (const action of idActions) {
    if (action.managed !== true) continue
    const targetRoute = action.op === 'move' ? action.to : action.route
    if (targetRoute === undefined || !(managedByRoute[targetRoute] ?? []).includes(action.id)) {
      action.managed = false
    }
  }
  const managedAfterMigration = [
    '[managed-after-migration] 以下模型将交由插件管理：',
    `  ${scopedRoutes.map((s) => `${s.route}: ${managedByRoute[s.route]?.join(', ') || '(none)'}`).join('；')}`,
    '官方下架时，这些模型会在满足「归属账本 + 现值哈希 + 无 override/pin」三闸门且连续 2 轮确认后自动从列表移除。',
  ].join('\n')

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
    idActions,
    managedAfterMigration,
    publicCatalogAvailable,
    adoptDisabled,
    references,
    pinnedSuggestions: [...pinnedSuggestions].sort(),
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
    case 'unclassified': return 'public catalog unavailable (unclassified): never deleted'
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

function profileLabel(profile: SettingsModelProfile | undefined): string {
  if (profile === undefined) return '(none)'
  return `${profile.name ?? profile.id} [${profileHash(profile).slice(0, 8)}]`
}

export function formatMigrationPlan(plan: MigrationPlan): string {
  const mode = plan.adoptDisabled
    ? 'adopt-disabled (--adopt rejected: apply cannot guarantee the action table)'
    : plan.adopt ? 'adopt' : 'conservative'
  const lines: string[] = [
    `model-sync migrate plan (v${plan.version}) — ${plan.state} (read-only, nothing written)`,
    `  mode: ${mode}  rewrite-refs: ${plan.rewriteRefs}`,
    `  sections fingerprint: ${plan.preFingerprint.slice(0, 16)}…`,
    `  public catalog: ${plan.publicCatalogAvailable ? 'available (ids classified)' : 'UNAVAILABLE — unclassified ids are never deleted (fail-closed)'}`,
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
  lines.push('', 'Per-id actions (apply consumes this table verbatim; keep/update/pin are non-destructive):')
  if (plan.idActions.length === 0) lines.push('  (none)')
  for (const action of plan.idActions) {
    const dest = action.to !== undefined ? ` → ${action.to}` : ''
    const beforeAfter = action.op === 'update'
      ? ` before=${profileLabel(action.before)} → official=${profileLabel(action.profile)} (apply keeps current value, not managed)`
      : ''
    lines.push(`  ${action.op.toUpperCase().padEnd(6)} ${action.route}/${action.id}${dest} [${action.kind}]${action.pinned ? ' [pinned]' : ''}${action.managed === true ? ' [managed]' : ''}${beforeAfter}`)
    lines.push(`      why: ${action.reason}`)
  }
  lines.push('', plan.managedAfterMigration)
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
  lines.push('apply: /model-sync migrate apply  --plan <planHash>  --confirm <confirmCode>  --ack-managed')
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
  /** go.pinnedModels: forced `keep` (31 B2). */
  pinnedModels?: readonly string[]
  /** Only with this flag may user-extra ids be deleted — and only if plan-listed. */
  pruneUserExtra?: boolean
  /** Official public catalog ids, used to distinguish unknown-retired from user-extra.
   *  `undefined` → fail-closed `unclassified` (never deleted). */
  publicCatalogIds?: readonly string[]
  /** Capability flag: `--adopt` is refused at the command layer when the per-id
   *  action table cannot be executed verbatim (design §14.2 fallback). */
  adoptDisabled?: boolean
  /** TEST FAULT INJECTION ONLY. When set, `applyMigration` appends one bogus
   *  action with this op to the rebuilt table so the fail-closed gate can be
   *  exercised. Production callers never set it. */
  faultInjectOp?: string
  now: number
  /** M-5: true when a go sync round currently holds the single-flight lock. */
  isSyncInFlight?: () => boolean
  /** Optional: execute an opt-in rewrite of a verified reference key. Default: none. */
  applyReferenceRewrite?: (rewrite: ReferenceRewrite) => Promise<void>
}

/**
 * The ONE plan-construction path used by both `/migrate plan` and `apply`.
 * Sharing it is what makes the printed plan and the plan apply re-builds
 * byte-identical — a prerequisite for the consent gate (V17) and V19.
 */
export function buildMigrationPlanFromDeps(deps: MigrateDeps, record: MigrationRecord | undefined): MigrationPlan {
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
    pinnedModels: deps.pinnedModels,
    pruneUserExtra: deps.pruneUserExtra,
    publicCatalogIds: deps.publicCatalogIds,
    adoptDisabled: deps.adoptDisabled,
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
  // Prefer a structured `message` so re-wrapped plain-object errors still carry
  // the actionable text (lock path / retry advice) instead of "[object Object]".
  // Error instances already expose `message`; everything else falls back to
  // String(err) exactly as before.
  const message = (err as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(err)
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

interface RouteWriteState {
  /** Desired end state of this route's models, seeded from the live section. */
  models: Map<string, SettingsModelProfile>
  /** ids under plugin ownership after this apply (B6 ledger `managed`). */
  managed: Record<string, GoManagedModel>
  /** ids this apply actually created on this route (ledger `appliedAddedIds`). */
  addedIds: Set<string>
}

/**
 * Translate the plan's per-id action table into per-route desired states. This
 * is the ONLY place that decides what apply writes: there is no
 * `merged = [...desired]` re-derivation anywhere (31 B2). Every row yields
 * exactly one result, in table order, so plan ↔ apply is checkable row by row.
 *
 * This same function powers plan-time simulation (`managedIdsAfterApply`) and
 * apply-time execution, so "will be managed" and "was managed" use ONE source.
 *
 * Semantics (user rulings + §14.2/§14.3):
 *   keep   → untouched; adopted only when the row is flagged `managed` AND the
 *            id is actually present on the route.
 *   add    → write the official profile unless the id is already present; an
 *            already-present id is only adopted (managed) if its value matches.
 *   update → NOTHING written, never managed (user-edited value is preserved).
 *   move   → remove from source route; on the destination, write/adopt the
 *            official profile ONLY if the target is empty or already holds the
 *            same value. A different-valued target is a user edit: never
 *            overwritten, never claimed, and reported as `skipped`.
 *   delete → remove from the route (only rows explicitly listed in the plan).
 *   pinned → expressed by keep (+ add on the target) rows; never moved/deleted.
 *   default → FAIL-CLOSED: an unknown op throws, it is never silently skipped.
 */
export function buildRouteWriteStates(
  table: MigrationActionTable,
  desc: SettingsDescriptor | undefined,
): { byRoute: Map<string, RouteWriteState>; results: MigrateApplyActionResult[] } {
  const byRoute = new Map<string, RouteWriteState>()
  for (const planned of table.routes) {
    byRoute.set(planned.route, {
      models: new Map(rawModels(desc, planned.route).map((profile) => [profile.id, structuredClone(profile)])),
      managed: {},
      addedIds: new Set(),
    })
  }
  const results: MigrateApplyActionResult[] = []

  const claim = (state: RouteWriteState | undefined, action: MigrationIdPlan): void => {
    if (action.managed !== true || state === undefined || action.profile === undefined) return
    // Never claim an id that is not actually on the route after this action.
    if (!state.models.has(action.id)) return
    state.managed[action.id] = { hash: profileHash(action.profile) }
  }

  for (const action of table.idActions) {
    const source = byRoute.get(action.route)
    const result = (status: MigrateApplyActionResult['status'], reason: string): void => {
      results.push({ id: action.id, op: action.op, route: action.route, ...(action.to !== undefined ? { to: action.to } : {}), status, reason })
    }
    switch (action.op) {
      case 'keep':
        claim(source, action)
        result('kept', action.reason)
        break
      case 'add': {
        if (source === undefined || action.profile === undefined) {
          result('skipped', 'route or profile unavailable; nothing written')
          break
        }
        if (source.models.has(action.id)) {
          // Idempotent: never overwrite an existing value (C4 / update ruling).
          const existing = source.models.get(action.id)!
          if (action.managed === true && profileHash(existing) === profileHash(action.profile)) claim(source, action)
          result('kept', `already present on ${action.route}; not overwritten`)
        } else {
          source.models.set(action.id, structuredClone(action.profile))
          source.addedIds.add(action.id)
          claim(source, action)
          result('applied', action.reason)
        }
        break
      }
      case 'update':
        // User ruling: report before→after, but write nothing and claim nothing.
        result('skipped', `${action.reason} (before=${profileLabel(action.before)}; official=${profileLabel(action.profile)})`)
        break
      case 'move': {
        source?.models.delete(action.id)
        const dest = action.to !== undefined ? byRoute.get(action.to) : undefined
        const suffix = action.to !== undefined ? ` → ${action.to}` : ''
        if (dest === undefined || action.profile === undefined) {
          result('skipped', `${action.reason}${suffix}: destination/profile unavailable; source copy removed, nothing written to target`)
          break
        }
        if (dest.models.has(action.id)) {
          const existing = dest.models.get(action.id)!
          if (action.managed === true && profileHash(existing) === profileHash(action.profile)) {
            claim(dest, action)
            result('kept', `${action.reason}${suffix}: target already holds the official value; adopted into ledger`)
          } else {
            // Different value = user edit on the target. Do not overwrite and
            // do NOT claim as managed — truthful result + ledger + notice.
            result('skipped', `${action.reason}${suffix}: target holds a user-modified value; not overwritten, not managed`)
          }
        } else {
          dest.models.set(action.id, structuredClone(action.profile))
          dest.addedIds.add(action.id)
          claim(dest, action)
          result('applied', `${action.reason}${suffix}`)
        }
        break
      }
      case 'delete':
        source?.models.delete(action.id)
        result('applied', action.reason)
        break
      default: {
        // Fail-closed (N4): an unknown op must never silently disappear. Throwing
        // here means neither plan simulation nor apply can report success on a
        // table it did not fully execute. `applyMigration` rejects earlier with a
        // typed reason; this is the last line of defence.
        const bad = action as MigrationIdPlan
        throw new Error(`unknown migration action op '${String(bad.op)}' on id ${bad.id}; refusing (adopt-disabled: action table not executable)`)
      }
    }
  }
  return { byRoute, results }
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
  | 'ack-required'
  | 'adopt-disabled'
  | 'unknown-action'
  | 'nothing-to-apply'
  | 'sync-in-flight'
  | 'write-failed'

/** Result of ONE row of the plan's action table — mirrors it one-to-one (V19). */
export interface MigrateApplyActionResult {
  id: string
  op: MigrationIdActionOp
  route: string
  to?: string
  status: 'applied' | 'kept' | 'skipped' | 'failed'
  reason: string
}

export interface MigrateApplyResult {
  ok: boolean
  reason: MigrateApplyReason
  planHash: string
  confirmCode: string
  routes: { route: string; status: 'wrote' | 'failed' | 'skipped'; reason?: string }[]
  /** One entry per `plan.idActions` row, in the same order. */
  actions: MigrateApplyActionResult[]
  backupPath?: string
  text: string
}

function applyFailure(reason: MigrateApplyReason, planHash: string, confirmCode: string, detail: string): MigrateApplyResult {
  return { ok: false, reason, planHash, confirmCode, routes: [], actions: [], text: `migrate apply refused (${reason}): ${detail}; zero writes` }
}

export async function applyMigration(
  args: { planHash?: string; confirmCode?: string; ackManaged?: boolean },
  deps: MigrateDeps,
): Promise<MigrateApplyResult> {
  const prior = await readRecord(deps)
  const plan = buildMigrationPlanFromDeps(deps, prior)

  // 1. Consent — every rejection below is ZERO writes. `--ack-managed` is a
  //    mandatory third token (B6); no bypass flag exists.
  const consent = verifyConsent(plan, args.planHash, args.confirmCode, args.ackManaged)
  if (!consent.ok) return applyFailure(consent.reason, plan.planHash, plan.confirmCode, `${consent.reason}`)

  // N4 fail-closed: an op outside the closed union can never be executed
  // verbatim. Reject BEFORE the applying flag, any settings write, or any
  // ledger write. `faultInjectOp` is a test-only seam; production uses only
  // plan.idActions (which the builder always keeps inside the union).
  const actionsToRun: MigrationIdPlan[] = deps.faultInjectOp === undefined
    ? [...plan.idActions]
    : [...plan.idActions, {
      id: '__fault-injected__', op: deps.faultInjectOp as MigrationIdPlan['op'],
      route: plan.routes[0]?.route ?? 'opencode-go', kind: 'user-extra', pinned: false,
      reason: 'fault-injected unknown action op',
    }]
  const unknown = findUnknownAction(actionsToRun)
  if (unknown !== undefined) {
    return applyFailure('unknown-action', plan.planHash, plan.confirmCode,
      `unknown action op '${unknown.op}' on id '${unknown.id}'; refusing (adopt-disabled: action table not executable)`)
  }

  // Fail-closed fallback (§14.2): if the executor cannot guarantee verbatim
  // table execution, adopt is refused here as well as at the command layer.
  if (deps.adopt === true && (deps.adoptDisabled === true || plan.adoptDisabled)) {
    return applyFailure('adopt-disabled', plan.planHash, plan.confirmCode,
      '--adopt disabled: apply cannot execute the per-id action table; use conservative mode')
  }

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

  // Simulate the action table BEFORE any write. It is pure, and its fail-closed
  // default throws on an unknown op — doing it here guarantees such a throw
  // cannot leave a persisted `applying` flag with no restore snapshot.
  const { byRoute, results: actionResults } = buildRouteWriteStates(
    { routes: plan.routes, idActions: actionsToRun }, desc,
  )

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
  const managedByRoute: Record<string, string[]> = {}
  let failure: string | undefined

  // The action table is the ONLY write source (31 B2): apply writes exactly the
  // simulated states above, never re-deriving from `planned.desired`. The SAME
  // simulation drives the plan's informed text (`managedIdsAfterApply`), so
  // "will manage" and "did manage" are one computation.
  try {
    for (const planned of plan.routes) {
      const state = byRoute.get(planned.route)
      if (state === undefined) {
        routesResult.push({ route: planned.route, status: 'skipped', reason: 'no write state' })
        continue
      }
      const touched = actionsToRun.some((action) => action.route === planned.route || action.to === planned.route)
      if (planned.action === 'keep' && !touched) {
        // No row touches this route: do not write settings, do not write a
        // ledger entry, and do not list it in appliedManagedIds. Listing it
        // here used to fabricate a "+route: []" entry never backed by a ledger.
        routesResult.push({ route: planned.route, status: 'skipped', reason: 'already-applied (no rows touched this route)' })
        continue
      }
      const current = rawModels(desc, planned.route)
      // Write only ops that actually change fields/models. keep/update/delete-no
      // rows leave the section byte-identical, so no mutate happens for them.
      const ops = routeOps(desc, planned.route, planned.fields, [...state.models.values()])
      let wroteThisRoute = false
      if (ops.length > 0) {
        try {
          await mutateWithRetry(deps, ops)
          writtenRoutes.push(planned.route)
          wroteThisRoute = true
        } catch (err) {
          failure = `${planned.route}: settings mutate failed (${errorText(err)})`
          routesResult.push({ route: planned.route, status: 'failed', reason: errorText(err) })
          break
        }
      }

      // B6: ledger `managed` is EXACTLY the set of ids this simulation claimed
      // on this route — the same set the plan advertised. Ids not written or
      // adopted (user-edited `update`, different-valued `move` target) are
      // absent. `managedByRoute` is the sole source for `appliedManagedIds`.
      const managed = state.managed
      managedByRoute[planned.route] = Object.keys(managed).sort((a, b) => a.localeCompare(b))
      const ledgerKey = goOwnershipKey(planned.route, deps.keyFingerprint)
      const preManagedSection = backup.routes[planned.route]?.section
      const entry: GoOwnershipEntry = {
        routeFields: planned.fields,
        managed,
        // Legacy audit fields, still used by the P1b eject path.
        preManagedSnapshot: current.map((profile) => ({ ...profile })),
        // §14.3 whole-section snapshot: the exact pre-apply section (null when
        // the route did not exist) plus the ids this apply introduced.
        preManagedSection: preManagedSection === undefined ? null : structuredClone(preManagedSection),
        appliedAddedIds: [...state.addedIds].sort((a, b) => a.localeCompare(b)),
      }
      try {
        await deps.ownershipStore.write(ledgerKey, entry)
        committedLedgerKeys.push(ledgerKey)
      } catch (err) {
        failure = `${planned.route}: ledger write failed (${errorText(err)})`
        routesResult.push({ route: planned.route, status: 'failed', reason: errorText(err) })
        break
      }
      // N1: a route is "wrote" only when settings actually changed. A pure
      // ledger adoption (keep row, zero ops) is a no-op on settings and must
      // not inflate the success count.
      routesResult.push({
        route: planned.route,
        status: wroteThisRoute ? 'wrote' : 'skipped',
        ...(wroteThisRoute ? {} : { reason: 'no-op: route already matches the plan (no settings write)' }),
      })
    }
  } catch (err) {
    failure = errorText(err)
  }

  if (failure === undefined) {
    // 4. Fingerprint LAST (§14.7.4): only after settings + ledger both landed.
    const identityRoutes = Object.keys(readGoProviderSections(llmDescriptor(deps.settings), Object.values(routesOf(deps))) ?? {})
    const liveSections = readGoProviderSections(llmDescriptor(deps.settings), Object.values(routesOf(deps)))
    const identity = fingerprintGoIdentity(liveSections, identityRoutes)
    // N3: `appliedManagedIds` mirrors ONLY the ledger entries actually written
    // above. No fallback to `managedIdsForRoute` for routes skipped by the plan
    // (e.g. an empty google slot): that used to fabricate a route -> [] entry
    // with no backing ledger record.
    const managedIds: Record<string, string[]> = { ...managedByRoute }
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
      // Moves are relocations, not deletions: report them separately from the
      // delete rows so rollback/audit can tell the two apart (V19).
      movedIds: [...new Set(plan.idActions.filter((action) => action.op === 'move').map((action) => action.id))],
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

  // N1: count the settings writes that actually happened (`writtenRoutes`),
  // not the per-route result rows (which now include truthful no-op `skipped`
  // routes). Zero writes must say so explicitly instead of "N routes written".
  const writtenCount = writtenRoutes.length
  const headline = writtenCount === 0
    ? 'migrate apply: 0 routes written (no settings writes; all routes already match / ledger-only adoptions), fingerprint persisted'
    : `migrate apply: ${writtenCount} routes written, fingerprint persisted`
  const text = [
    headline,
    ...routesResult.map((r) => `  ${r.route}: ${r.status}${r.reason !== undefined ? ` (${r.reason})` : ''}`),
    'Per-id results (one per plan action row):',
    ...actionResults.map((a) => `  ${a.status.toUpperCase().padEnd(7)} ${a.op.toUpperCase().padEnd(6)} ${a.route}/${a.id}${a.to !== undefined ? ` → ${a.to}` : ''} — ${a.reason}`),
    `  backup: ${plan.backupPath}`,
    `  rollback: /model-sync migrate rollback --plan ${plan.planHash}`,
  ].join('\n')
  return {
    ok: true,
    reason: 'applied',
    planHash: plan.planHash,
    confirmCode: plan.confirmCode,
    routes: routesResult,
    actions: actionResults,
    backupPath: plan.backupPath,
    text,
  }
}

function routesOf(deps: MigrateDeps): Partial<Record<GoRouteSlot, string>> {
  return { ...GO_SLOT_ROUTES, ...deps.routes }
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

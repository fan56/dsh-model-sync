// O1/C2: write-ahead journal + next-round reconciliation. The go writer's real
// order is `settings.mutate` → ownership ledger → migration record. A crash (or
// a store write failure) between those steps leaves settings AHEAD of the two
// store records: on the next round the route looks user-owned, the migration
// gate can close forever (S1), a new model is never claimed (S2), and rollback
// refuses with hash-mismatch (S3). No settings rollback is attempted (the
// cross-process lock does not cover settings.mutate); instead this module
// records the intended write BEFORE the mutate and reconciles it on the next
// round, converging on the hash of the value actually present in settings.
//
// Wire format: one opaque slot per route in the SAME ~/.dsh/models-store.json
// (same queue / atomic temp+rename as the ledger and migration record):
//   `<profileKey>#<route>#<keyFingerprint>#journal`  -> GoWriteJournal
// Four '#'-separated parts. `isUnscopedStoreKey` only classifies TWO-part keys
// as unscoped legacy slots, so a journal key is never reported/claimed as a
// foreign legacy record. The profile and fingerprint are BOTH stamped inside
// the payload and validated on read, so a rotated key or another profile's
// journal is discarded instead of being replayed onto the wrong ledger slot.
//
// Reconciliation is store/record-only: it NEVER calls settings.mutate. If the
// present value's content hash equals the recorded post-write hash, our write
// is intact and the ledger + migration record are re-committed; otherwise the
// user changed the value and the journal is dropped (their value is kept).

import { createHash } from 'node:crypto'
import { goOwnershipKey, type GoOwnershipEntry } from './opencode-go-planner.ts'
import type { GoOwnershipStore } from './opencode-go-writer.ts'
import { loadModelsStore, type ModelsStoreAccessor } from './remote-catalog.ts'
import type { SettingsModelProfile } from './translate.ts'
import type { Logger, SettingsDescriptor, SettingsService } from './writer.ts'

const JOURNAL_TAIL = 'journal'
const JOURNAL_VERSION = 1

export interface GoWriteJournal {
  version: typeof JOURNAL_VERSION
  /** Profile scope stamped at write time; must match the reconciling profile. */
  profileKey: string
  route: string
  /** Credential fingerprint stamped at write time; must match the current key. */
  keyFingerprint: string
  /** Ledger-managed ids this write was about to commit (sorted). */
  modelIds: string[]
  /** sha256 of the sorted models array we were about to write. */
  contentHash: string
  /** Host settings revision the mutate was issued against (diagnostic only). */
  expectedRevision?: number
  /** True for a whole-route unset (reconciliation deletes the ledger slot). */
  unset: boolean
  /** Exact ledger entry to re-commit when not unset. */
  entry?: GoOwnershipEntry
  /** Write timestamp (injected clock in tests). */
  at: number
}

export interface JournalReadResult {
  journal?: GoWriteJournal
  /** Slot existed but could not be parsed — treat as "no journal" + warn. */
  parseError?: string
  /**
   * The slot held a primitive/null (not an object at all). Such a value can
   * never carry a journal; reconciliation warns AND cleans it (after the
   * key-shape/profile check), unlike a plain parse error on an object slot.
   */
  rawTypeCorrupt?: boolean
}

export interface GoJournalStore {
  read(key: string): Promise<JournalReadResult>
  write(key: string, journal: GoWriteJournal): Promise<void>
  delete(key: string): Promise<void>
  /** All journal slots belonging to this profile (any key fingerprint). */
  list(profileKey: string): Promise<string[]>
  /** Delete every journal slot of this profile; returns the number removed. */
  clearProfile(profileKey: string): Promise<number>
}

/** Four-part journal slot: `<profile>#<route>#<keyFingerprint>#journal`. */
export function goJournalKey(profileKey: string, route: string, keyFingerprint: string): string {
  return `${profileKey}#${goOwnershipKey(route, keyFingerprint)}#${JOURNAL_TAIL}`
}

/**
 * True for a syntactically journal-shaped slot of the given profile. We match
 * the profile PREFIX and the `#journal` TAIL rather than a fixed part count: a
 * profile name may itself contain '#', and the payload's profile/fingerprint
 * stamps are validated independently on read.
 */
export function isJournalKey(key: string, profileKey: string): boolean {
  const prefix = `${profileKey}#`
  const tail = `#${JOURNAL_TAIL}`
  if (!key.startsWith(prefix) || !key.endsWith(tail)) return false
  const middle = key.slice(prefix.length, -tail.length)
  return middle.length > 0 && middle.includes('#')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

/**
 * Stable content hash of a route's models array. The writer calls this on the
 * exact array it hands to settings.mutate; reconciliation calls it on the raw
 * models read back from settings. Sorting by id + recursively canonical field
 * order makes the two agree regardless of key insertion or array order.
 */
export function journalContentHash(models: readonly SettingsModelProfile[]): string {
  // oldfox #5: localeCompare is host/locale-dependent, so the same models array
  // could hash differently on two machines sharing a store → `journal-stale`
  // false positives. JS string `<` compares UTF-16 code units (deterministic
  // byte/codepoint order for these ASCII ids), making the hash locale-proof.
  const stable = [...models]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((model) => canonicalize(model))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function errorText(err: unknown): string {
  const message = (err as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(err)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Defensive bound against a corrupt/hostile journal carrying an oversized
 * entry. Legitimate ledgers are far smaller; this only rejects absurd arrays
 * before they are copied into an in-memory ledger.
 */
const MAX_LEDGER_ENTRIES = 100_000

/**
 * oldfox #4: `entry` is the exact object reconciliation re-commits to the
 * ownership ledger, so a malformed one must never enter it. parseJournal used
 * to accept any object here; validate the real GoOwnershipEntry shape instead:
 * the required `managed` id→{hash} map plus every optional field's type. On
 * failure the whole slot is treated as an unparseable journal (warn + clean),
 * never reconciled.
 */
function isValidOwnershipEntry(value: unknown): value is GoOwnershipEntry {
  if (!isRecord(value)) return false
  const managed = value.managed
  if (!isRecord(managed)) return false
  const ids = Object.keys(managed)
  if (ids.length > MAX_LEDGER_ENTRIES) return false
  for (const id of ids) {
    if (id.length === 0) return false
    const owner = managed[id]
    if (!isRecord(owner) || typeof owner.hash !== 'string' || owner.hash.length === 0) return false
  }
  if (value.routeFields !== undefined && !isRecord(value.routeFields)) return false
  if (value.preManagedSnapshot !== undefined) {
    if (!Array.isArray(value.preManagedSnapshot) || value.preManagedSnapshot.length > MAX_LEDGER_ENTRIES) return false
    if (value.preManagedSnapshot.some((m) => !isRecord(m) || typeof m.id !== 'string')) return false
  }
  if (value.preManagedSection !== undefined
    && value.preManagedSection !== null && !isRecord(value.preManagedSection)) return false
  if (value.appliedAddedIds !== undefined) {
    if (!Array.isArray(value.appliedAddedIds) || value.appliedAddedIds.length > MAX_LEDGER_ENTRIES) return false
    if (value.appliedAddedIds.some((id) => typeof id !== 'string')) return false
  }
  if (value.missing !== undefined) {
    if (!isRecord(value.missing)) return false
    const missingIds = Object.keys(value.missing)
    if (missingIds.length > MAX_LEDGER_ENTRIES) return false
    for (const id of missingIds) {
      const count = value.missing[id]
      if (typeof count !== 'number' || !Number.isFinite(count)) return false
    }
  }
  return true
}

/** Strict parse: any missing/mistyped field is a parse failure, never a journal. */
export function parseJournal(raw: unknown): { journal?: GoWriteJournal; error?: string } {
  if (!isRecord(raw)) return { error: 'journal slot is not an object' }
  if (raw.version !== JOURNAL_VERSION) return { error: `unsupported journal version ${String(raw.version)}` }
  if (typeof raw.profileKey !== 'string' || raw.profileKey.length === 0) return { error: 'journal has no profileKey' }
  if (typeof raw.route !== 'string' || raw.route.length === 0) return { error: 'journal has no route' }
  if (typeof raw.keyFingerprint !== 'string' || raw.keyFingerprint.length === 0) return { error: 'journal has no keyFingerprint' }
  if (!Array.isArray(raw.modelIds) || raw.modelIds.some((id) => typeof id !== 'string')) {
    return { error: 'journal has invalid modelIds' }
  }
  if (typeof raw.contentHash !== 'string' || raw.contentHash.length === 0) return { error: 'journal has no contentHash' }
  if (typeof raw.unset !== 'boolean') return { error: 'journal has no unset flag' }
  if (!raw.unset && raw.entry === undefined) return { error: 'journal has no ledger entry' }
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return { error: 'journal has invalid timestamp' }
  const journal: GoWriteJournal = {
    version: JOURNAL_VERSION,
    profileKey: raw.profileKey,
    route: raw.route,
    keyFingerprint: raw.keyFingerprint,
    modelIds: [...raw.modelIds] as string[],
    contentHash: raw.contentHash,
    unset: raw.unset,
    at: raw.at,
  }
  if (typeof raw.expectedRevision === 'number') journal.expectedRevision = raw.expectedRevision
  // Validate whenever an entry is present (also on unset journals, where a
  // stale malformed entry must not survive into a later re-commit).
  if (raw.entry !== undefined) {
    if (!isValidOwnershipEntry(raw.entry)) return { error: 'journal has invalid ledger entry' }
    journal.entry = raw.entry
  }
  return { journal }
}

/** File-backed journal store built on the same atomic queue as the ledger. */
export function createFileJournalStore(accessor: ModelsStoreAccessor): GoJournalStore {
  return {
    async read(key) {
      let raw: unknown
      try {
        raw = await accessor.readRaw(key)
      } catch (err) {
        return { parseError: `journal read failed: ${errorText(err)}` }
      }
      if (raw === undefined) return {}
      if (!isRecord(raw)) {
        // A primitive/null slot is not "no journal" — it is corruption that
        // can never carry a valid journal. Flag it so reconciliation warns and
        // cleans it under the key-shape/profile safety check.
        return {
          parseError: `journal slot held a non-object value (${raw === null ? 'null' : typeof raw})`,
          rawTypeCorrupt: true,
        }
      }
      const parsed = parseJournal(raw)
      return parsed.journal !== undefined
        ? { journal: parsed.journal }
        : { parseError: parsed.error ?? 'unknown journal parse failure' }
    },
    async write(key, journal) {
      await accessor.writeRaw(key, journal as unknown as Record<string, unknown>)
    },
    async delete(key) {
      await accessor.deleteRaw(key)
    },
    async list(profileKey) {
      // Do NOT swallow enumeration failures. An unreadable store must reach
      // reconcileJournals' try/catch and surface `journal-list-failed`, not be
      // mistaken for "no journals this round".
      return (await accessor.listRawKeys()).filter((key) => isJournalKey(key, profileKey))
    },
    async clearProfile(profileKey) {
      const keys = await this.list(profileKey)
      let deleted = 0
      for (const key of keys) {
        try {
          await accessor.deleteRaw(key)
          deleted += 1
        } catch {
          // Best effort: a surviving slot is re-validated (and discarded) by
          // the next reconciliation, never replayed blindly.
        }
      }
      return deleted
    },
  }
}

export function createModelsStoreJournalStore(storePath?: string): GoJournalStore {
  return createFileJournalStore(loadModelsStore(storePath))
}

// ---------------------------------------------------------------------------
// Reconciliation (called once per round, BEFORE the migration gate)
// ---------------------------------------------------------------------------

export interface JournalNotice {
  code: 'journal-reconciled' | 'journal-stale' | 'journal-orphan'
    | 'journal-unparseable' | 'journal-reconcile-failed' | 'journal-list-failed'
    // oldfox #2: the descriptor-unavailable branch is a distinct condition from
    // a store enumeration failure. Sharing `journal-list-failed` misled
    // machine consumers into reporting a list error when nothing was listed.
    | 'journal-descriptor-unavailable'
  level: 'info' | 'warn' | 'error'
  key: string
  message: string
  /** True for a primitive/null slot (vs an object that merely failed parsing). */
  rawTypeCorrupt?: boolean
}

export interface ReconcileResult {
  reconciled: string[]
  discarded: string[]
  notices: JournalNotice[]
  lines: string[]
}

export interface ReconcileDeps {
  journalStore: GoJournalStore
  ownershipStore: GoOwnershipStore
  settings: SettingsService | undefined
  profileKey: string
  keyFingerprint: string
  logger: Logger
  /** Same callback the writer uses after a healthy own-write: re-persist the
   * migration record. Store/record only — never touches settings. */
  onRecord?: (route: string, managedIds: string[]) => Promise<void> | void
}

function rawModels(desc: SettingsDescriptor | undefined, route: string): SettingsModelProfile[] {
  const providers = desc?.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return []
  const data = providers[route]
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return []
  const models = (data as Record<string, unknown>).models
  return Array.isArray(models) ? models as SettingsModelProfile[] : []
}

/**
 * Reconcile every journal of this profile against the value actually present
 * in settings. Outcomes:
 *   hash equal   → re-commit ledger + migration record, delete journal;
 *   hash differs → the user edited the value: discard journal, keep their value;
 *   wrong scope  → orphan (profile/key rotation): discard journal;
 *   parse fail   → treat as no journal, warn, discard;
 *   raw-type slot → warn (journal-unparseable + rawTypeCorrupt flag) and clean
 *                  it after a journal-key / profile safety check;
 *   store fail   → keep journal for the next round, never block the round.
 */
export async function reconcileJournals(deps: ReconcileDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = { reconciled: [], discarded: [], notices: [], lines: [] }
  const notice = (entry: JournalNotice): void => {
    result.notices.push(entry)
    result.lines.push(`  [${entry.level}] ${entry.code} ${entry.key}: ${entry.message}`)
  }

  let keys: string[]
  try {
    keys = await deps.journalStore.list(deps.profileKey)
  } catch (err) {
    const key = `profile:${deps.profileKey}`
    deps.logger.warn('journal list failed for %s: %s', deps.profileKey, errorText(err))
    notice({
      code: 'journal-list-failed', level: 'warn', key,
      message: `could not list write-ahead journals (${errorText(err)}); reconciliation skipped this round`,
    })
    return result
  }
  if (keys.length === 0) return result

  const desc = deps.settings?.describe().find((entry) => entry.ns === 'llm-pi-ai')
  if (desc === undefined) {
    // Cannot verify the present hash — keep every journal, never guess.
    // This is NOT a list failure: enumeration succeeded. Use a dedicated code
    // so automation can tell the two apart (oldfox #2). Text stays accurate:
    // journals are kept, not discarded.
    notice({
      code: 'journal-descriptor-unavailable', level: 'warn', key: `profile:${deps.profileKey}`,
      message: 'llm-pi-ai descriptor unavailable; journals kept for a later round (reconciliation deferred, no list error)',
    })
    return result
  }

  for (const key of keys) {
    let read: JournalReadResult
    try {
      read = await deps.journalStore.read(key)
    } catch (err) {
      deps.logger.warn('journal read failed for %s: %s', key, errorText(err))
      notice({ code: 'journal-unparseable', level: 'warn', key, message: `read failed (${errorText(err)}); journal kept` })
      continue
    }
    if (read.parseError !== undefined) {
      deps.logger.warn('unparseable journal %s: %s', key, read.parseError)
      if (read.rawTypeCorrupt === true) {
        // A primitive/null slot can never carry a valid journal. Same warn code
        // as an object-shape parse failure, but flagged and explicitly worded so
        // the raw-type case is recognizable. Clean it ONLY after re-confirming
        // the slot is a journal-shaped key of THIS profile — never touch a
        // foreign or non-journal key that happens to hold a primitive.
        notice({
          code: 'journal-unparseable', level: 'warn', key, rawTypeCorrupt: true,
          message: `${read.parseError}; raw-type corruption (cannot carry a journal) — slot discarded and cleaned`,
        })
        if (isJournalKey(key, deps.profileKey)) {
          try { await deps.journalStore.delete(key) } catch { /* best effort */ }
        }
      } else {
        notice({ code: 'journal-unparseable', level: 'warn', key, message: `${read.parseError}; journal discarded (treated as no journal)` })
        try { await deps.journalStore.delete(key) } catch { /* best effort */ }
      }
      result.discarded.push(key)
      continue
    }
    const journal = read.journal
    if (journal === undefined) continue

    const expectedKey = goJournalKey(deps.profileKey, journal.route, journal.keyFingerprint)
    if (journal.profileKey !== deps.profileKey || journal.keyFingerprint !== deps.keyFingerprint
      || key !== expectedKey) {
      deps.logger.warn('orphan journal %s (profile=%s key=%s)', key, journal.profileKey, journal.keyFingerprint)
      notice({
        code: 'journal-orphan', level: 'warn', key,
        message: `profile/key fingerprint mismatch (profile=${journal.profileKey}, key=${journal.keyFingerprint}); discarded, never replayed`,
      })
      try { await deps.journalStore.delete(key) } catch { /* best effort */ }
      result.discarded.push(key)
      continue
    }

    const currentHash = journalContentHash(rawModels(desc, journal.route))
    if (currentHash !== journal.contentHash) {
      deps.logger.warn('stale journal %s: current settings hash differs', key)
      notice({
        code: 'journal-stale', level: 'warn', key,
        message: `current settings differ from the recorded write hash; journal discarded and the user's value kept`,
      })
      try { await deps.journalStore.delete(key) } catch { /* best effort */ }
      result.discarded.push(key)
      continue
    }

    try {
      const ledgerKey = goOwnershipKey(journal.route, deps.keyFingerprint)
      if (journal.unset || journal.entry === undefined) {
        await deps.ownershipStore.delete(ledgerKey)
      } else {
        await deps.ownershipStore.write(ledgerKey, journal.entry)
      }
      if (deps.onRecord !== undefined) {
        await deps.onRecord(journal.route, [...journal.modelIds].sort())
      }
      await deps.journalStore.delete(key)
      result.reconciled.push(journal.route)
      notice({
        code: 'journal-reconciled', level: 'info', key,
        message: `present value matches the recorded write; ownership ledger + migration record re-committed`,
      })
    } catch (err) {
      // Keep the journal so a later round retries. Never block the round: the
      // user's settings are untouched by reconciliation by construction.
      deps.logger.warn('journal reconciliation failed for %s: %s', key, errorText(err))
      notice({
        code: 'journal-reconcile-failed', level: 'warn', key,
        message: `ledger/record re-commit failed (${errorText(err)}); journal kept for the next round`,
      })
    }
  }

  return result
}

/** One-line summary prepended to the round report when anything reconciled. */
export function formatReconcileSummary(result: ReconcileResult): string {
  if (result.reconciled.length === 0 && result.discarded.length === 0 && result.notices.length === 0) return ''
  return `opencode-go: journal reconciliation: ${result.reconciled.length} re-committed, ${result.discarded.length} discarded`
}

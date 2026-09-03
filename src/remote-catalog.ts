// Plan C (settings-seam): pi.dev remote-catalog fetch and persistent cache.

/**
 * pi.dev remote-catalog fetch and persistent cache.
 *
 * Ported from the dsh-llm-pi-ai patch (hunk 1: withRemoteCatalog / modelsStore /
 * parseRemoteCatalog / remoteModels). The original patch overlays pi.dev's model
 * listing on top of the static catalog in memory; Plan C instead fetches and
 * caches so translate.ts can produce the settings write target.
 *
 * @module dsh-model-sync/remote-catalog
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

// ---------------------------------------------------------------------------
// Constants (ported from docs-dsh-llm-pi-ai.patch:35-36)
// ---------------------------------------------------------------------------

/** Base URL for pi.dev model catalog API. */
export const REMOTE_CATALOG_BASE_URL = 'https://pi.dev'

/** Minimum interval between revalidation requests per provider. */
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Path to the persistent per-provider cache. */
export const MODELS_STORE_PATH = join(homedir(), '.dsh', 'models-store.json')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a single model entry from pi.dev's /api/models/providers/<route>. */
export interface RemoteCatalogEntry {
  id: string
  name: string
  api: string
  provider: string
  baseUrl: string
  reasoning: boolean
  input: string[]
  cost?: Record<string, number>
  contextWindow?: number
  maxTokens?: number
  compat?: {
    supportsStore?: boolean
    supportsDeveloperRole?: boolean
    maxTokensField?: string
    thinkingFormat?: string
    supportsReasoningEffort?: boolean
    zaiToolStream?: boolean
    requiresReasoningContentOnAssistantMessages?: boolean
    sessionAffinityFormat?: string
    supportsLongCacheRetention?: boolean
  }
  thinkingLevelMap?: Record<string, string | null>
  [key: string]: unknown
}

/** Per-provider cache entry persisted to ~/.dsh/models-store.json. */
export interface ModelsStoreEntry {
  models: RemoteCatalogEntry[]
  checkedAt: number
  lastModified: number
  etag?: string
  /**
   * User `modelOverrides` folded out of settings and unset there (the dsh
   * llm-pi-ai validation refuses a models list beside non-empty
   * modelOverrides). Replayed into the translated target on every later
   * round so the user's values survive. The catalog refresh must NOT carry
   * this field forward from its own snapshot — the queue-internal seed
   * merge keeps whatever overrides the route currently holds, so a
   * concurrent round's stage cannot be clobbered by a fetch write (C1 fix).
   */
  overrides?: Record<string, Record<string, unknown>>
}

/**
 * Patch surface for `update()`. The fetch side typically only names
 * fetch-owned fields (`models` / `checkedAt` / `lastModified` / `etag`),
 * but `overrides` is part of the type so the same seed formula works for
 * callers that need to patch out-of-band fields too (and so TS doesn't
 * reject `patch.overrides` in the seed). The merge is a field-level seed
 * inside the accessor's write queue: concurrent stages (the writer's
 * `persistOverridesToStore`, a sibling route's fetch, etc.) see a
 * consistent read-modify-write and never overwrite each other's
 * out-of-band fields. The seed also guarantees the entry shape invariant
 * — every persisted entry carries models (default []), checkedAt (default
 * Date.now()), lastModified (default 0), etag, and overrides — so a
 * subsequent read never sees an incomplete shape (B1 fix).
 */
export type ModelsStoreEntryPatch = Partial<
  Pick<ModelsStoreEntry, 'models' | 'checkedAt' | 'lastModified' | 'etag' | 'overrides'>
>

/** Top-level shape of ~/.dsh/models-store.json. */
export interface ModelsStore {
  [route: string]: ModelsStoreEntry
}

// ---------------------------------------------------------------------------
// Fetch result
// ---------------------------------------------------------------------------

export interface FetchRemoteCatalogResult {
  /** Filtered entries from pi.dev (only entries whose api is in the route). */
  entries: RemoteCatalogEntry[]
  /** Whether the ETag/304 path was used (body unchanged). */
  fromCache: boolean
  /** Error message if the fetch failed; entries will be from last-good cache. */
  error?: string
}

// ---------------------------------------------------------------------------
// parseRemoteCatalog (ported from docs-dsh-llm-pi-ai.patch:48-59)
// ---------------------------------------------------------------------------

/**
 * Normalize pi.dev's response shape into a flat entry array.
 * pi.dev may return: a plain array, `{ models: [...] }`, or an object of arrays.
 */
export function parseRemoteCatalog(
  providerId: string,
  value: unknown,
): RemoteCatalogEntry[] {
  const entries: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && 'models' in value && Array.isArray((value as Record<string, unknown>).models)
      ? ((value as Record<string, unknown>).models as unknown[])
      : typeof value === 'object' && value !== null
        ? Object.values(value as Record<string, unknown>)
        : []
  if (entries.length === 0) {
    throw new Error(`Invalid model catalog for provider "${providerId}"`)
  }
  return entries
    .filter((entry): entry is Record<string, unknown> => {
      if (typeof entry !== 'object' || entry === null || !('id' in entry)) return false
      // I-11: validate typeof id and api are strings (not just present)
      if (typeof (entry as Record<string, unknown>).id !== 'string') return false
      if (!('api' in entry) || typeof (entry as Record<string, unknown>).api !== 'string') return false
      return true
    })
    .map((model) => ({ ...model, provider: providerId }) as unknown as RemoteCatalogEntry)
}

// ---------------------------------------------------------------------------
// Models store persistence (ported from docs-dsh-llm-pi-ai.patch:67-96)
// ---------------------------------------------------------------------------

let modelsStoreCache: ModelsStoreAccessor | undefined

/**
 * Serialized read/write accessor for ~/.dsh/models-store.json.
 *
 * Every mutation method funnels through the same promise queue so
 * concurrent updates serialize cleanly. `update` / `updateOverrides` use
 * a queue-internal field-level seed (B1 fix) that gives every persisted
 * entry the unconditional shape { models, checkedAt, lastModified, etag,
 * overrides } — patch missing → fall through to current → fall back to a
 * per-field default. The `write` method is the legacy whole-entry
 * replacement path (kept for tests / seeders); production callers prefer
 * the targeted merge so concurrent stages (the writer's
 * `persistOverridesToStore`, a sibling route's fetch, etc.) never
 * overwrite each other's out-of-band fields.
 */
export interface ModelsStoreAccessor {
  read(providerId?: string): Promise<ModelsStoreEntry | undefined>
  /**
   * Whole-entry replacement. Still available for tests / seeders; production
   * code paths prefer the targeted `update` / `updateOverrides` so the queue
   * can preserve out-of-band fields.
   */
  write(providerId: string, entry: ModelsStoreEntry): Promise<void>
  /**
   * Field-level seed merge: the route's current entry is re-read inside
   * the write queue (so it sees every prior queue task's committed
   * state), the patch's fields override the current's where present, and
   * missing fields fall back to per-field defaults (models: [],
   * checkedAt: Date.now(), lastModified: 0, etag: undefined, overrides:
   * undefined). The result is an unconditional entry shape — a
   * subsequent read never sees an incomplete `{overrides}-only` entry.
   * Used by `fetchRemoteCatalog` for every status path.
   */
  update(providerId: string, patch: ModelsStoreEntryPatch): Promise<void>
  /**
   * Replace the route's `overrides` field only; the same field-level
   * seed as `update` guarantees the rest of the entry (models /
   * checkedAt / lastModified / etag) lands with sensible defaults when
   * the route is new / the doc is corrupt, or is preserved verbatim
   * from the current entry otherwise. Used by `persistOverridesToStore`
   * so its stage survives a concurrent fetch write.
   */
  updateOverrides(
    providerId: string,
    overrides: Record<string, Record<string, unknown>>,
  ): Promise<void>
  delete(providerId: string): Promise<void>
}

/**
 * Get (or create) the singleton models-store accessor.
 * Each read parses the file fresh; writes are serialized through a promise queue
 * to avoid clobbering concurrent writes.
 *
 * @param storePath  Optional override for the store file path (defaults to ~/.dsh/models-store.json).
 */
export function loadModelsStore(storePath?: string): ModelsStoreAccessor {
  const effectivePath = storePath ?? MODELS_STORE_PATH

  // Only cache when using the default path (singleton); custom paths always create fresh accessors
  if (storePath === undefined && modelsStoreCache !== undefined) return modelsStoreCache

  const readDoc = async (): Promise<ModelsStore> => {
    try {
      return JSON.parse(await readFile(effectivePath, 'utf8')) as ModelsStore
    } catch (err: unknown) {
      // ENOENT is a normal first run — the store has never been written.
      // Anything else (SyntaxError on a corrupted file, EACCES on a
      // permission-denied read, EIO on storage failure) bubbles up so the
      // writer fails closed: treating an unreadable store as empty would
      // let a later replay write the raw pi.dev target into settings and
      // clobber user-folded values (the v0.1.5 data-loss shape). The
      // failure propagates to the writer which skips the round and keeps
      // settings.models — the authoritative, already-landed source —
      // untouched.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw err
    }
  }

  const writeDoc = async (doc: ModelsStore): Promise<void> => {
    await mkdir(dirname(effectivePath), { recursive: true })
    // Atomic write: stage to a sibling temp file then rename(2) into place.
    // rename(2) is atomic on POSIX, so a concurrent reader either sees the
    // pre-rename doc or the post-rename doc — never a half-written file.
    // JSON.stringify without spaces keeps the existing wire format (the
    // reader is strict on the parse side; legacy stores carry no
    // whitespace). A fresh write also *heals* a previously-corrupt store:
    // the first successful write after corruption replaces the bad file
    // atomically with a well-formed doc, so subsequent reads see the
    // expected shape.
    const tmpPath = `${effectivePath}.${process.pid}.tmp`
    await writeFile(tmpPath, JSON.stringify(doc))
    await rename(tmpPath, effectivePath)
  }

  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(task, task)
    queue = next.catch(() => {})
    return next
  }

  const accessor: ModelsStoreAccessor = {
    read: async (providerId?: string): Promise<ModelsStoreEntry | undefined> => {
      const doc = await readDoc()
      return providerId === undefined ? undefined : doc[providerId]
    },
    write: (providerId: string, entry: ModelsStoreEntry): Promise<void> =>
      enqueue(async () => {
        // The read-modify-write pattern preserves concurrent routes'
        // entries; if the file is corrupt or unreadable, treat the doc as
        // empty and overwrite — the atomic writeDoc below replaces the
        // bad file with a fresh, well-formed doc carrying this route's
        // entry (and any other routes the caller writes later will
        // re-stamp theirs). The store reads path stays strict (readDoc
        // still throws) so the writer's fail-closed logic can react to
        // the actual error instead of seeing a fake empty doc.
        let doc: ModelsStore
        try {
          doc = await readDoc()
        } catch {
          doc = {}
        }
        doc[providerId] = entry
        await writeDoc(doc)
      }),
    update: (providerId: string, patch: ModelsStoreEntryPatch): Promise<void> =>
      enqueue(async () => {
        // Queue-internal read-modify-write: the read sees every prior
        // queue task's committed state. The merge is field-level seeded —
        // a field is taken from the patch when present, otherwise from
        // the current entry, otherwise from a per-field default. This
        // makes the entry shape unconditional: every persisted entry
        // carries models/checkedAt/lastModified/etag/overrides (the
        // last three may be undefined, but the first two always have
        // values). Field-level seed closes the C1 bug: a stage via
        // `updateOverrides` on an ENOENT/corrupt doc now lands an entry
        // shape the next round's fetch can consume (`stored.models` is
        // `[]`, never undefined) — the previous `{...current, ...patch}`
        // spread left the entry incomplete and crashed `fetchRemoteCatalog`
        // on the stale read.
        //
        // Fields outside the patch (notably `overrides`) survive any
        // concurrent stage of out-of-band data: patch field is undefined
        // → fall through to current → preserved. A stale pre-fetch
        // snapshot can no longer clobber an out-of-band stage because
        // the patch only names fields the call site intends to write.
        //
        // Read failure → treat the doc as empty and let the atomic
        // writeDoc heal the file (same self-heal contract as `write`).
        let doc: ModelsStore
        try {
          doc = await readDoc()
        } catch {
          doc = {}
        }
        const current = doc[providerId] ?? {}
        doc[providerId] = {
          models: patch.models ?? current.models ?? [],
          checkedAt: patch.checkedAt ?? current.checkedAt ?? Date.now(),
          lastModified: patch.lastModified ?? current.lastModified ?? 0,
          etag: patch.etag ?? current.etag,
          overrides: patch.overrides ?? current.overrides,
        }
        await writeDoc(doc)
      }),
    updateOverrides: (
      providerId: string,
      overrides: Record<string, Record<string, unknown>>,
    ): Promise<void> =>
      enqueue(async () => {
        // Queue-internal RMW: same field-level seed as `update`. The
        // patch is `{ overrides }`; the seed fills every other field
        // with a sensible default (models: [], checkedAt: Date.now(),
        // lastModified: 0, etag: undefined) when current is missing, and
        // preserves current's value when present. The result: an
        // overrides-only stage on an ENOENT / corrupt doc still produces
        // a well-formed entry the fetch side can consume, and an
        // overrides-only stage on a populated entry keeps the fetch's
        // models / etag / checkedAt intact. This is what the writer's
        // `persistOverridesToStore` calls — its previous read-then-write
        // raced the fetch side because the read ran outside the queue.
        let doc: ModelsStore
        try {
          doc = await readDoc()
        } catch {
          doc = {}
        }
        const current = doc[providerId] ?? {}
        doc[providerId] = {
          models: current.models ?? [],
          checkedAt: current.checkedAt ?? Date.now(),
          lastModified: current.lastModified ?? 0,
          etag: current.etag,
          overrides,
        }
        await writeDoc(doc)
      }),
    delete: (providerId: string): Promise<void> =>
      enqueue(async () => {
        let doc: ModelsStore
        try {
          doc = await readDoc()
        } catch {
          doc = {}
        }
        delete doc[providerId]
        await writeDoc(doc)
      }),
  }

  // Only cache the default-path accessor (singleton)
  if (storePath === undefined) {
    modelsStoreCache = accessor
  }
  return accessor
}

/**
 * Reset the singleton accessor (for testing).
 */
export function resetModelsStoreCache(): void {
  modelsStoreCache = undefined
}

// ---------------------------------------------------------------------------
// fetchRemoteCatalog (adapted from docs-dsh-llm-pi-ai.patch:104-151)
// ---------------------------------------------------------------------------

/**
 * Fetch one route's model list from pi.dev with ETag/304 revalidation.
 *
 * Behavior mirrors the original withRemoteCatalog.refreshModels:
 * - 304 → refresh checkedAt only (everything else falls through to current via the seed)
 * - 404/501 → empty overlay, return empty
 * - transient failure → keep cached entries, return error message
 * - success → parse + store + return entries
 *
 * C1 fix (2026-09-04): the four write paths used to spread the route's
 * pre-fetch snapshot into the written entry — most notably re-attaching
 * `overrides: stored?.overrides` — which clobbered any out-of-band field
 * staged by a concurrent round (e.g. an overlapping auto-refresh whose
 * `persistOverridesToStore` ran between this round's `store.read(route)`
 * and `store.write(...)`). Every status path now calls
 * `effectiveStore.update(route, patch)` with a fetch-owned patch — the
 * queue-internal field-level seed re-reads the route's current entry
 * inside the queue and only overrides the fields the patch names
 * (`models` / `checkedAt` / `lastModified` / `etag`; the 304 path
 * narrows this to just `checkedAt`). Out-of-band fields — notably
 * `overrides`, plus anything a future caller stages — are preserved
 * verbatim because the seed only writes fields the patch actually
 * supplies. The pre-fetch `stored` snapshot stays in scope only for
 * conditional checks (304 ETag match, 4h throttle) and to seed the
 * fall-back models/lastModified/etag values on error paths — it never
 * participates in the write payload.
 *
 * B1 fix: the seed gives every persisted entry an unconditional shape
 * — models / checkedAt / lastModified / etag / overrides (the last
 * three may be undefined, but models is always an array and checkedAt
 * is always a number). A `updateOverrides` stage on an ENOENT / corrupt
 * doc now lands an entry the next round can consume; the previous
 * `{...current, ...patch}` spread left the entry incomplete
 * (`{overrides}-only`) and crashed `fetchRemoteCatalog` on the stale
 * read because `stored.models` was undefined.
 *
 * @param route  The provider route id (e.g. 'opencode-go')
 * @param timeout  Abort budget in ms (default 30s)
 * @param store  Optional override for the models-store accessor (testing)
 * @param options  Additional options (storePath, force)
 */
export async function fetchRemoteCatalog(
  route: string,
  timeout?: number,
  store?: ModelsStoreAccessor,
  options?: { storePath?: string; force?: boolean },
): Promise<FetchRemoteCatalogResult> {
  const effectiveStore = store ?? loadModelsStore(options?.storePath)
  const stored = await effectiveStore.read(route)

  // I-5: throttle — return cached entries if checkedAt is within revalidation interval.
  // Optional chaining on `models` is defensive: the field-level seed (B1) always seeds
  // `models: []` at minimum, so a missing field here means a legacy entry written
  // before the seed landed — treat it as "no cached entries" rather than crashing.
  if (!options?.force && stored !== undefined && (stored.models?.length ?? 0) > 0) {
    const elapsed = Date.now() - stored.checkedAt
    if (elapsed >= 0 && elapsed < REMOTE_CATALOG_REFRESH_INTERVAL_MS) {
      return { entries: stored.models, fromCache: true }
    }
  }

  const url = new URL(`/api/models/providers/${encodeURIComponent(route)}`, REMOTE_CATALOG_BASE_URL)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (stored?.models?.length && stored.etag) {
    headers['if-none-match'] = stored.etag
  }

  const controller = new AbortController()
  const timer = timeout !== undefined
    ? setTimeout(() => controller.abort(), timeout)
    : undefined

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    })

    const checkedAt = Date.now()

    // 304: body unchanged, just refresh checkedAt. The patch is narrowed to
    // { checkedAt }: the seed merge preserves models / lastModified / etag /
    // overrides from the route's current entry, so re-naming them on a 304
    // is unnecessary (and previously risked a clobber if a concurrent round
    // had staged one of those fields between the snapshot read and the
    // write — N1).
    if (response.status === 304 && stored) {
      await effectiveStore.update(route, { checkedAt })
      return { entries: stored.models, fromCache: true }
    }

    // 404/501: provider not found on pi.dev; store empty overlay. The
    // patch omits `etag` (and `overrides`) so the seed preserves both
    // from the route's current entry — the next round's conditional
    // request still uses the cached etag, harmless if the resource is
    // truly gone (server replies 404/501 again) and useful if it comes
    // back (server replies 304). lastModified is zeroed so the catalog
    // metadata reflects "no known server-side last-mod time".
    if (response.status === 404 || response.status === 501) {
      await effectiveStore.update(route, {
        models: stored?.models ?? [],
        checkedAt,
        lastModified: 0,
      })
      return { entries: [], fromCache: false }
    }

    // Transient failure: keep cached entries, report error
    if (!response.ok) {
      await effectiveStore.update(route, {
        models: stored?.models ?? [],
        checkedAt,
        lastModified: stored?.lastModified ?? 0,
        etag: stored?.etag,
      })
      return {
        entries: stored?.models ?? [],
        fromCache: false,
        error: `Model catalog request failed for ${route}: ${response.status}`,
      }
    }

    // Success: parse and store
    const refreshed = parseRemoteCatalog(route, await response.json())
    const lastModified = Date.parse(response.headers.get('last-modified') ?? '')
    const etag = response.headers.get('etag') ?? undefined

    await effectiveStore.update(route, {
      models: refreshed,
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      etag,
    })

    return { entries: refreshed, fromCache: false }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // On abort or network error, return cached entries
    return {
      entries: stored?.models ?? [],
      fromCache: false,
      error: `Fetch failed for ${route}: ${message}`,
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

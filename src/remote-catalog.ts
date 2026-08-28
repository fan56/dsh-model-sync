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
import { mkdir, readFile, writeFile } from 'node:fs/promises'

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
}

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

/** Serialized read/write accessor for ~/.dsh/models-store.json. */
export interface ModelsStoreAccessor {
  read(providerId?: string): Promise<ModelsStoreEntry | undefined>
  write(providerId: string, entry: ModelsStoreEntry): Promise<void>
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
    } catch {
      return {}
    }
  }

  const writeDoc = async (doc: ModelsStore): Promise<void> => {
    await mkdir(dirname(effectivePath), { recursive: true })
    await writeFile(effectivePath, JSON.stringify(doc))
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
        const doc = await readDoc()
        doc[providerId] = entry
        await writeDoc(doc)
      }),
    delete: (providerId: string): Promise<void> =>
      enqueue(async () => {
        const doc = await readDoc()
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
 * - 304 → update checkedAt, return cached entries
 * - 404/501 → store empty overlay, return empty
 * - transient failure → keep cached entries, return error message
 * - success → parse + store + return entries
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

  // I-5: throttle — return cached entries if checkedAt is within revalidation interval
  if (!options?.force && stored !== undefined && stored.models.length > 0) {
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

    // 304: body unchanged, just refresh checkedAt
    if (response.status === 304 && stored) {
      await effectiveStore.write(route, { ...stored, checkedAt })
      return { entries: stored.models, fromCache: true }
    }

    // 404/501: provider not found on pi.dev; store empty overlay
    if (response.status === 404 || response.status === 501) {
      const entry: ModelsStoreEntry = {
        models: stored?.models ?? [],
        checkedAt,
        lastModified: 0,
        etag: undefined,
      }
      await effectiveStore.write(route, entry)
      return { entries: [], fromCache: false }
    }

    // Transient failure: keep cached entries, report error
    if (!response.ok) {
      const entry: ModelsStoreEntry = {
        models: stored?.models ?? [],
        checkedAt,
        lastModified: stored?.lastModified ?? 0,
        etag: stored?.etag,
      }
      await effectiveStore.write(route, entry)
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

    const storeEntry: ModelsStoreEntry = {
      models: refreshed,
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      etag,
    }
    await effectiveStore.write(route, storeEntry)

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

// Provider-native model-list fetch: union the pi.dev catalog with each
// provider's own /models endpoint — the fresher source.
//
// Why this exists: pi.dev (and the pi-ai builtin snapshot behind it) lags
// behind the providers. Measured 2026-09-22 against the native endpoints:
// DeepSeek's listing had already renamed deepseek-v4-flash → deepseek-flash
// while pi-ai still carried the retired id; Zhipu served glm-5.3-flashx that
// pi-ai did not know; Xiaomi's platform announced the V2.6 series while pi-ai
// stopped at v2.5. Every provider above exposes an OpenAI-shaped
// `GET /models` listing that answers "which ids exist" straight from the
// horse's mouth.
//
// Merge policy (user-mandated 2026-09-22): the listing may only ADD ids —
// never remove. A pi.dev entry keeps its richer metadata untouched; a
// native-only id is synthesized as a minimal entry. Capacities follow the
// same "don't guess" rule: contextWindow is written only when the listing
// itself states one (Moonshot's `context_length`), maxTokens never — omitting
// both lets dsh-llm-pi-ai fall back to the route's defaultContextWindow /
// defaultMaxTokens (its resolve chain `entry.x ?? base?.x ?? request.default`
// is exactly this policy made native).
//
// Failure policy: a failed native fetch must never lose models. It degrades
// to the pi.dev result unchanged and surfaces one report line; the round
// proceeds either way.

import type { RemoteCatalogEntry } from './remote-catalog.ts'
import { deriveKeyRef, getRawUserApiKeyEnv, type RouteCredentialSettingsDescriptor } from './route-credential.ts'

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

/** How the /models request authenticates. */
export type ProviderNativeAuth = 'bearer' | 'api-key-header'

/** One provider route's native model-listing endpoint. */
export interface ProviderNativeEndpoint {
  /** Full URL of the OpenAI-shaped `GET` listing. */
  url: string
  /** Authentication style (Xiaomi accepts either; its docs lead with the header). */
  auth: ProviderNativeAuth
}

/**
 * Provider routes with a known first-party model-listing API. Routes absent
 * from this table (gateways like `opencode-go`, unverified providers) simply
 * keep the pi.dev-only behavior.
 *
 * All endpoints verified 2026-09-22: DeepSeek/Zhipu with a live key, the rest
 * probe-confirmed (401 vs 404 — the endpoint exists, the key was not ours to
 * spend) plus official docs for Xiaomi (mimo.mi.com list-models) and
 * Moonshot (platform.kimi.com OpenAPI, whose response uniquely adds
 * `context_length` and capability flags we can lift).
 */
export const PROVIDER_NATIVE_ENDPOINTS: Readonly<Record<string, ProviderNativeEndpoint>> = {
  deepseek: { url: 'https://api.deepseek.com/models', auth: 'bearer' },
  'moonshotai-cn': { url: 'https://api.moonshot.cn/v1/models', auth: 'bearer' },
  moonshotai: { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer' },
  'kimi-coding': { url: 'https://api.kimi.com/coding/v1/models', auth: 'bearer' },
  zai: { url: 'https://api.z.ai/api/paas/v4/models', auth: 'bearer' },
  'zai-coding-cn': { url: 'https://open.bigmodel.cn/api/coding/paas/v4/models', auth: 'bearer' },
  xiaomi: { url: 'https://api.xiaomimimo.com/v1/models', auth: 'api-key-header' },
  'xiaomi-token-plan-cn': { url: 'https://token-plan-cn.xiaomimimo.com/v1/models', auth: 'api-key-header' },
  'xiaomi-token-plan-ams': { url: 'https://token-plan-ams.xiaomimimo.com/v1/models', auth: 'api-key-header' },
  'xiaomi-token-plan-sgp': { url: 'https://token-plan-sgp.xiaomimimo.com/v1/models', auth: 'api-key-header' },
}

// ---------------------------------------------------------------------------
// Credential value resolution
// ---------------------------------------------------------------------------

/**
 * The credentials seam surface this module needs beyond the gate's
 * `describe`: `resolve` returns the value itself (the gate only asks whether
 * it is configured). Optional peer — callers tolerate its absence via the
 * launch-environment fallback.
 */
export interface CredentialsResolveSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** The launch-environment snapshot surface (same as route-credential.ts). */
export interface LaunchEnvironmentSnapshotLike {
  get(name: string): { value: string } | undefined
}

/** The subset of `Context` the credential-value resolver reads. */
export interface NativeCredentialContext {
  get(name: 'credentials'): CredentialsResolveSeam | undefined
  get(name: 'launchEnvironment'): LaunchEnvironmentSnapshotLike | undefined
  get(name: string): unknown
}

/**
 * Resolve one route's credential reference to its current VALUE — the same
 * two layers `checkRouteCredential` gates on, but reading through instead of
 * asking whether:
 * 1. the credentials seam's `resolve(ref)` (the same per-operation read the
 *    harness itself uses before a request);
 * 2. the launch-environment snapshot (process env fallback when the service
 *    is absent).
 *
 * Returns undefined when neither layer has a value; callers skip the native
 * fetch (the pi.dev result stands) rather than fail the round.
 */
export async function resolveRouteCredentialValue(
  ctx: NativeCredentialContext,
  desc: RouteCredentialSettingsDescriptor | undefined,
  route: string,
): Promise<string | undefined> {
  const declared = getRawUserApiKeyEnv(desc, route)
  const ref = declared ?? deriveKeyRef(route)
  const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

  if (REF_PATTERN.test(ref)) {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(ref)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return resolved.value
        }
      } catch {
        // Same tolerance as the gate: a half-broken seam reads as "no value
        // here" and falls through to the environment.
      }
    }
  }

  const snapshot = ctx.get('launchEnvironment') ?? {
    get(name: string) {
      const value = process.env[name]
      return value !== undefined && value !== '' ? { value, source: 'process' } : undefined
    },
  }
  const entry = snapshot.get(ref)
  if (entry !== undefined && typeof entry.value === 'string' && entry.value.length > 0) {
    return entry.value
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

/** One provider's native listing outcome: the fresh truth, or why not. */
export type ProviderNativeResult =
  | {
      ok: true
      /** Model ids exactly as the provider lists them. */
      ids: string[]
      /** contextWindow values the listing itself states (Moonshot `context_length`). */
      contextById: Map<string, number>
    }
  | { ok: false; error: string }

/** A minimal fetch compatible enough for tests to stub. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Parse a native listing body. Accepts the OpenAI list shape
 * `{"object":"list","data":[{"id":...}]}` and tolerates the per-provider
 * extras (Moonshot's `context_length`; Zhipu's `created`/`owned_by`) — only
 * string `id`s count, and only a positive-integer `context_length` is kept.
 */
export function parseProviderNativeBody(value: unknown): { ids: string[]; contextById: Map<string, number> } {
  const ids: string[] = []
  const contextById = new Map<string, number>()
  if (typeof value !== 'object' || value === null) throw new Error('body is not an object')
  const data = (value as Record<string, unknown>).data
  if (!Array.isArray(data)) throw new Error('body has no data array')
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || id.length === 0) continue
    ids.push(id)
    const context = (item as Record<string, unknown>).context_length
    if (isPositiveInt(context)) contextById.set(id, context)
  }
  if (ids.length === 0) throw new Error('data array lists no usable model ids')
  return { ids, contextById }
}

/**
 * Fetch one route's native model listing. Any failure (non-200, network,
 * unparseable body) resolves to `{ ok: false, error }` — never throws, so the
 * caller's pi.dev result is untouchable.
 *
 * @param route     Provider route id; must have an entry in the endpoint table.
 * @param apiKey    The credential value (Bearer token / api-key header value).
 * @param timeoutMs Abort budget.
 * @param fetchImpl Injectable fetch (tests); defaults to the global fetch.
 */
export async function fetchProviderNativeModels(
  route: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ProviderNativeResult> {
  const endpoint = PROVIDER_NATIVE_ENDPOINTS[route]
  if (endpoint === undefined) {
    return { ok: false, error: `no native endpoint mapped for route "${route}"` }
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  if (endpoint.auth === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else headers['api-key'] = apiKey

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint.url, { headers, signal: controller.signal })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} from ${new URL(endpoint.url).host}` }
    }
    const parsed = parseProviderNativeBody(await response.json())
    return { ok: true, ...parsed }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `native listing fetch failed: ${message}` }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Union merge
// ---------------------------------------------------------------------------

/** Outcome of merging a native listing into a route's pi.dev entries. */
export interface MergedNativeResult {
  /** pi.dev entries plus one synthesized entry per native-only id. */
  entries: RemoteCatalogEntry[]
  /** Native ids that were not already present and got synthesized. */
  addedIds: string[]
  /** Why some or all native ids could not be synthesized (routeApi unknown). */
  skippedReason?: string
}

/**
 * Union a native listing into the pi.dev entries — additions only.
 *
 * A native id the pi.dev list already carries is ignored (pi.dev's richer
 * metadata wins). A native-only id becomes a minimal entry: no maxTokens ever
 * (no source states one), contextWindow only when the listing itself did
 * (`contextById`). `routeApi` is the route's single builtin api — required so
 * the entry can survive translate's base-less gate; routes with no resolvable
 * api (unknown route, mixed-protocol gateway) skip synthesis wholesale with a
 * `skippedReason` instead of emitting entries the runtime would reject.
 */
export function mergeProviderNativeEntries(
  piDevEntries: readonly RemoteCatalogEntry[],
  native: { ids: readonly string[]; contextById: ReadonlyMap<string, number> },
  route: string,
  routeApi: string | undefined,
): MergedNativeResult {
  const known = new Set(piDevEntries.map((e) => e.id))
  const addedIds: string[] = []
  const entries: RemoteCatalogEntry[] = [...piDevEntries]

  for (const id of native.ids) {
    if (known.has(id)) continue
    if (routeApi === undefined) {
      return {
        entries,
        addedIds,
        skippedReason: `cannot place ${native.ids.length - addedIds.length} new id(s) — route has no single builtin api to address them`,
      }
    }
    const context = native.contextById.get(id)
    entries.push({
      id,
      name: id,
      api: routeApi,
      provider: route,
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      ...(context !== undefined ? { contextWindow: context } : {}),
    })
    addedIds.push(id)
  }

  return { entries, addedIds }
}

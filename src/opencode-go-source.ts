// P0 (read-only diagnostic): opencode-go official /v1/models source.
//
// Fetches the official listing, normalizes each entry into the shape the
// diagnostic needs, and classifies auth / entitlement failures. This module
// is deliberately side-effect free apart from the injected network call: it
// never touches settings, credentials, or the filesystem. P1 will consume the
// same normalized records for route planning; P0 stops at the report.
//
// Design: 07-design.md §6.1 (ModelRecord), §6.3 (authStatus), ADR-001.
// The no-key branch follows §6.3 / V4: warn, send no request, write nothing —
// the unauthenticated public 30-model list is NOT a servable source (C2).

import { createHash } from 'node:crypto'

/** Official model-listing endpoint (design §6.2.6 default). */
export const OPENCODE_GO_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'

/** Explicit UA — the gateway bans default library UAs with CF 1010 (05 §1). */
export const GO_USER_AGENT = 'dsh-model-sync/0.9.0'

/** Auth states carried by the diagnostic report (design §6.1 SourceSnapshot). */
export type GoAuthStatus = 'unknown' | 'ok' | 'invalid' | 'not-entitled' | 'unreachable'

/** Failure taxonomy (design §6.1 lastError.kind + no-key for the opt-out path). */
export type GoFailureKind = 'auth' | 'entitlement' | 'transport' | 'parse' | 'offline' | 'no-key'

/** One normalized official model entry. `created` is intentionally absent. */
export interface GoModelRecord {
  id: string
  name: string
  canonicalId?: string
  releaseDate?: string
  lastUpdated?: string
  contextWindow?: number
  maxOutput?: number
  inputModalities: string[]
  reasoning?: { supported: boolean; efforts: string[] }
  /** Keys of the official `api` dictionary (the protocol names). */
  protocols: string[]
  recommendedProtocol?: string
  /** Official per-protocol `base_url`, used by P1 route planning only. */
  baseUrls: Record<string, string>
  provenance: 'go-official'
}

/** Failure detail attached to a source result (never contains a key value). */
export interface GoSourceError {
  kind: GoFailureKind
  status?: number
  message: string
}

/** Outcome of one source read. */
export interface GoSourceResult {
  ok: boolean
  entries: GoModelRecord[]
  authStatus: GoAuthStatus
  /** sha256(key) first 16 hex; '-' when no key was available. */
  keyFingerprint: string
  /** sha256 of canonical normalized JSON; excludes `created`. */
  payloadHash?: string
  observedAt: number
  error?: GoSourceError
}

/** Minimal response shape the fetch accepts (injected in tests). */
export interface GoFetchResponse {
  status: number
  json(): Promise<unknown>
}

/** Injectable fetch: a plain function, like provider-native.ts's FetchLike. */
export type GoFetchLike = (url: string, init: {
  headers: Record<string, string>
  signal: AbortSignal
}) => Promise<GoFetchResponse>

/** Options for one source read. */
export interface FetchGoOfficialOptions {
  url?: string
  apiKey?: string
  timeoutMs?: number
  observedAt?: number
  fetchImpl?: GoFetchLike
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Irreversible key fingerprint — the only key-derived value ever retained. */
export function fingerprintKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/** Canonical JSON: object keys sorted recursively so hashing is order-stable. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
  return out
}

/** Hash of the normalized set. `created` never reaches this function. */
export function computeGoPayloadHash(entries: readonly GoModelRecord[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(entries))).digest('hex')
}

// ---------------------------------------------------------------------------
// Payload normalization (pure; fixture-driven tests)
// ---------------------------------------------------------------------------

/**
 * Parse the official `{ object: 'list', data: [...] }` payload into normalized
 * records. Unknown fields (cost, sdk, go.monthly_usage, …) are dropped; every
 * field the diagnostic or P1 planning needs is mapped explicitly. `created`
 * is deliberately not copied, so it can never enter the payload hash.
 */
export function parseGoModelsPayload(value: unknown): GoModelRecord[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('opencode-go payload is not a model list')
  }
  const entries: GoModelRecord[] = []
  for (const item of value.data) {
    if (!isRecord(item)) continue
    const id = item.id
    if (typeof id !== 'string' || id.length === 0) continue

    const api = isRecord(item.api) ? item.api : {}
    const protocols = Object.keys(api).filter((key) => isRecord(api[key]))
    const baseUrls: Record<string, string> = {}
    for (const protocol of protocols) {
      const base = (api[protocol] as Record<string, unknown>).base_url
      if (typeof base === 'string' && base.length > 0) baseUrls[protocol] = base
    }

    const limit = isRecord(item.limit) ? item.limit : {}
    const contextWindow = positiveInt(limit.context)
    const output = positiveInt(limit.output)
    // An output >= context is a bad upstream value — strip it (design §6.1).
    const maxOutput = output !== undefined && (contextWindow === undefined || output < contextWindow)
      ? output
      : undefined

    const modalities = isRecord(item.modalities) ? item.modalities : {}
    // text→text, image/*→image; audio/video/pdf are ignored (design §6.1).
    const inputModalities: string[] = []
    for (const modality of stringList(modalities.input)) {
      const normalized = modality === 'text' ? 'text' : modality.startsWith('image/') ? 'image' : undefined
      if (normalized !== undefined && !inputModalities.includes(normalized)) inputModalities.push(normalized)
    }

    const capabilities = isRecord(item.capabilities) ? item.capabilities : {}
    const reasoningRaw = isRecord(capabilities.reasoning) ? capabilities.reasoning : undefined
    const reasoning = reasoningRaw !== undefined
      ? {
          supported: reasoningRaw.supported === true,
          efforts: stringList(reasoningRaw.effort).map((effort) => effort === 'none' ? 'off' : effort),
        }
      : undefined

    const entry: GoModelRecord = {
      id,
      name: typeof item.name === 'string' ? item.name : id,
      protocols,
      baseUrls,
      inputModalities,
      provenance: 'go-official',
    }
    if (typeof item.canonical_id === 'string') entry.canonicalId = item.canonical_id
    if (typeof item.release_date === 'string') entry.releaseDate = item.release_date
    if (typeof item.last_updated === 'string') entry.lastUpdated = item.last_updated
    if (contextWindow !== undefined) entry.contextWindow = contextWindow
    if (maxOutput !== undefined) entry.maxOutput = maxOutput
    if (reasoning !== undefined) entry.reasoning = reasoning
    if (typeof item.recommended_api === 'string') entry.recommendedProtocol = item.recommended_api
    entries.push(entry)
  }
  if (entries.length === 0) throw new Error('opencode-go payload lists no usable model ids')
  return entries
}

// ---------------------------------------------------------------------------
// Auth / entitlement classification (pure)
// ---------------------------------------------------------------------------

export interface GoHttpClassification {
  authStatus: GoAuthStatus
  failureKind?: GoFailureKind
  /** Human-readable reason; never includes a key value. */
  message: string
}

/** Read a bounded error message from an unknown error body. */
function errorMessage(body: unknown): string {
  if (!isRecord(body)) return ''
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message
  if (typeof body.message === 'string') return body.message
  if (typeof body.detail === 'string') return body.detail
  return ''
}

function errorCode(body: unknown): string {
  if (!isRecord(body)) return ''
  const inner = isRecord(body.error) ? body.error : body
  if (typeof inner.code === 'string') return inner.code
  if (typeof inner.type === 'string') return inner.type
  if (typeof body.error_code === 'number') return String(body.error_code)
  return ''
}

/**
 * Classify an official HTTP response. 401 = invalid key, 403 = either the
 * documented EntitlementError (not-entitled) or the Cloudflare 1010 UA ban
 * (transport), 5xx/429 = transport. Only 200 is a usable source.
 */
export function classifyGoHttpStatus(status: number, body: unknown): GoHttpClassification {
  if (status >= 200 && status < 300) return { authStatus: 'ok', message: '' }
  const code = errorCode(body)
  const message = errorMessage(body)
  const cfBan = code === '1010'
    || /browser_signature_banned|cloudflare/i.test(message)
    || (isRecord(body) && (body.error_code === 1010 || body.error === 1010))

  if (status === 401) {
    return { authStatus: 'invalid', failureKind: 'auth', message: message || `HTTP 401 (${code || 'unauthorized'})` }
  }
  if (status === 403) {
    if (cfBan) {
      return { authStatus: 'unreachable', failureKind: 'transport', message: message || 'HTTP 403 (Cloudflare 1010)' }
    }
    return { authStatus: 'not-entitled', failureKind: 'entitlement', message: message || 'HTTP 403 (Go subscription required)' }
  }
  return {
    authStatus: 'unreachable',
    failureKind: 'transport',
    message: message || `HTTP ${status} from opencode-go models endpoint`,
  }
}

// ---------------------------------------------------------------------------
// Fetch orchestration (the only impure function; network is injected)
// ---------------------------------------------------------------------------

function failedResult(
  authStatus: GoAuthStatus,
  keyFingerprint: string,
  observedAt: number,
  error: GoSourceError,
): GoSourceResult {
  return { ok: false, entries: [], authStatus, keyFingerprint, observedAt, error }
}

/**
 * Read the official listing once. No key → no request (design V4), no entries,
 * status 'unknown'. With a key the request carries Bearer + explicit UA; the
 * key itself is never logged or stored, only its fingerprint.
 */
export async function fetchGoOfficialModels(options: FetchGoOfficialOptions = {}): Promise<GoSourceResult> {
  const url = options.url ?? OPENCODE_GO_MODELS_URL
  const observedAt = options.observedAt ?? Date.now()
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''

  if (apiKey === '') {
    return failedResult('unknown', '-', observedAt, {
      kind: 'no-key',
      message: 'No OpenCode Go API key configured — no /v1/models request sent (design §6.3 / V4)',
    })
  }

  const fingerprint = fingerprintKey(apiKey)
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as GoFetchLike)
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': GO_USER_AGENT,
    authorization: `Bearer ${apiKey}`,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)

  try {
    let response: GoFetchResponse
    try {
      response = await fetchImpl(url, { headers, signal: controller.signal })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failedResult('unreachable', fingerprint, observedAt, {
        kind: 'transport',
        message: `opencode-go models request failed: ${message}`,
      })
    }

    if (response.status < 200 || response.status >= 300) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      const classification = classifyGoHttpStatus(response.status, body)
      return failedResult(classification.authStatus, fingerprint, observedAt, {
        kind: classification.failureKind ?? 'transport',
        status: response.status,
        message: classification.message,
      })
    }

    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failedResult('unknown', fingerprint, observedAt, {
        kind: 'parse',
        message: `opencode-go models body is not JSON: ${message}`,
      })
    }

    let entries: GoModelRecord[]
    try {
      entries = parseGoModelsPayload(body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failedResult('unknown', fingerprint, observedAt, { kind: 'parse', message })
    }

    return {
      ok: true,
      entries,
      authStatus: 'ok',
      keyFingerprint: fingerprint,
      payloadHash: computeGoPayloadHash(entries),
      observedAt,
    }
  } finally {
    clearTimeout(timer)
  }
}

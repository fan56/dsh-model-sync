// Login gate for the settings-mode sync: skip routes whose credential
// reference is not configured, so a logged-out profile never silently gets
// its `models` rewritten by the sync.
//
// Layer 1 follows llm-pi-ai's `resolveApiKey`: prefer the credentials seam.
// Layer 2 follows the same package's `authContextFrom(ctx).env()` semantics:
// consult the launch environment, or process.env when that service is absent.
// A hit on either allows sync; only when BOTH miss do we skip the route.
// Known gap: after credential removal, a same-name shell export still allows
// writes, but requests with the seam present still fail with MISSING_CREDENTIAL.
//
// deriveKeyRef replicates the dsh web UI's same helper at
// packages/client/ui-settings-models/src/client/store.ts:111-113 (uppercase +
// collapse non-alphanumerics to `_` + `_API_KEY` suffix). The web UI uses it
// to mint the reference name a typed key stores under; we use it as the
// fallback when a route has no explicit `apiKeyEnv` (shell-environment users
// who `export OPENCODE_API_KEY=…` without going through the UI). The two
// conversions are byte-for-byte identical, so a value the web UI wrote
// resolves through the same name here.

/**
 * The credentials seam surface this module needs. The seam is an optional
 * peer (`@deepseek-ai/dsh-credentials`), so the gate must tolerate its
 * absence — `checkRouteCredential` falls through to the launch-environment
 * check in that case.
 *
 * The actual `CredentialProvider.describe` takes a branded `CredentialRef`
 * (`Branded<'CredentialRef'>` from `@deepseek-ai/dsh-brand`), but the brand is
 * a structural type only — every branded string is also a plain `string` at
 * runtime. Declaring the parameter as `string` here keeps the local interface
 * dependency-free (we don't import the brand module just to name one
 * parameter) while remaining assignable from any value the seam emits:
 * `credentialRef(value)` returns `value as CredentialRef`, which is the same
 * `value` retyped, so passing it to `describe(ref: string)` works under both
 * the host and any plain-JS seam test double.
 */
export interface CredentialsSeam {
  describe(ref: string): Promise<{ configured: boolean }>
}

/**
 * The launch-environment snapshot surface (`@deepseek-ai/dsh-launch-environment`).
 * Cordis `ctx.get` returns undefined for an unregistered service; it does not
 * synthesize a snapshot. This module supplies the `process.env` fallback.
 */
export interface LaunchEnvironmentSnapshot {
  get(name: string): { value: string } | undefined
}

/**
 * The subset of `Context` this module reads. Both services are optional:
 * `credentials` is an optional peer and may be absent, `launchEnvironment` is
 * provided by the launcher but the helper synthesizes a process-env snapshot
 * when it is not.
 */
export interface RouteCredentialContext {
  get(name: 'credentials'): CredentialsSeam | undefined
  get(name: 'launchEnvironment'): LaunchEnvironmentSnapshot | undefined
  get(name: string): unknown
}

/**
 * The settings descriptor shape this module needs (matches writer.ts's
 * `SettingsDescriptor`). Only `user.providers.<route>.apiKeyEnv` is read —
 * the value the user explicitly declared in the llm-pi-ai provider profile
 * (settings.yaml up to dsh 0.1.6, the profile patch on 0.1.7+).
 */
export interface RouteCredentialSettingsDescriptor {
  user?: Record<string, unknown>
}

/**
 * Outcome of one route's credential check.
 */
export interface RouteCredentialCheck {
  /** True when either source confirms the route is configured. */
  ok: boolean
  /**
   * The credential reference name consulted (e.g. `OPENCODE_API_KEY`,
   * `MINIMAX_CN_API_KEY`). Always present, even when `ok` is false, so the
   * report can name what is missing.
   */
  ref: string
  /**
   * Which source confirmed the route, when `ok` is true:
   * - 'credentials' — the seam's `describe()` returned `configured: true`
   * - 'env' — the launch-environment snapshot (process env / .env) had a
   *   non-empty value, with no seam hit
   */
  via?: 'credentials' | 'env'
}

/**
 * Derive the conventional credential reference for a provider route. This is
 * a byte-for-byte replica of `deriveKeyRef` from the dsh web UI's settings
 * models package (see ~/github/deepseek-harness/packages/client/ui-
 * settings-models/src/client/store.ts:111-113). The web UI uses it as the
 * default name a typed key stores under; we use it as the fallback when the
 * user has not declared an explicit `apiKeyEnv` in their provider profile.
 *
 * @param provider - provider route id (e.g. `opencode-go`, `minimax-cn`).
 * @returns the derived reference name (e.g. `OPENCODE_GO_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Read the explicit `apiKeyEnv` the user declared for a route in the
 * `llm-pi-ai` provider profile. Returns the trimmed string when present and
 * non-empty, otherwise `undefined` (callers fall through to `deriveKeyRef`).
 *
 * @param desc - the settings descriptor (may be undefined when the host has
 *   no `llm-pi-ai` namespace registered yet).
 * @param route - the provider route id.
 */
export function getRawUserApiKeyEnv(
  desc: RouteCredentialSettingsDescriptor | undefined,
  route: string,
): string | undefined {
  if (desc === undefined) return undefined
  const providers = desc.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const routeData = providers[route] as Record<string, unknown> | undefined
  if (routeData === undefined) return undefined
  const raw = routeData.apiKeyEnv
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Run the per-route credential gate. Returns `{ ok, ref, via? }` where `ok`
 * is true iff either source confirms the route is configured.
 *
 * Resolution layers (not an exact request-time credential resolver):
 * 1. `credentials.describe(ref).configured === true` when the seam is
 *    provided AND the ref is a valid `CredentialRef` (POSIX identifier).
 *    The strict pattern check matters: a profile removed during logout leaves
 *    no `apiKeyEnv`, so we always derive; and a stray ref that does not match
 *    the brand grammar (e.g. the seam `resolve` would throw) must read as
 *    "not configured" rather than crash the round.
 * 2. `launchEnvironment.get(ref).value` returns a non-empty string, following
 *    llm-pi-ai's `authContextFrom(ctx).env()` semantics. Like
 *    `launchEnvironmentOf`, we synthesize a `process.env` snapshot when the
 *    launch-environment service is absent, even without a launcher.
 *
 * Both misses → `ok: false`. The gate then skips fetch / translate /
 * `settings.mutate` for the route and emits a report line naming the ref.
 *
 * @param ctx - the plugin's cordis context.
 * @param desc - the resolved `llm-pi-ai` settings descriptor (may be undefined
 *   when the host has not registered the namespace yet — same shape as the
 *   descriptor the writer already reads).
 * @param route - the provider route id being checked.
 */
export async function checkRouteCredential(
  ctx: RouteCredentialContext,
  desc: RouteCredentialSettingsDescriptor | undefined,
  route: string,
): Promise<RouteCredentialCheck> {
  // 1. The user-declared ref (when present) wins over the derived one. A
  //    profile that names its own ref is the authoritative choice; the
  //    derivation is only a fallback for shell-environment users.
  const declared = getRawUserApiKeyEnv(desc, route)
  const ref = declared ?? deriveKeyRef(route)

  // 2. Credentials seam first. The seam is optional: skip the whole branch
  //    when the host did not register it. Inside the branch, only consult the
  //    seam when the ref matches the brand's POSIX-identifier grammar — the
  //    seam's own `describe` throws on an invalid ref, which would crash the
  //    sync round. Mirroring `isCredentialRefName` from
  //    @deepseek-ai/dsh-credentials keeps the gate quiet on malformed input.
  const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
  if (REF_PATTERN.test(ref)) {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const info = await credentials.describe(ref)
        if (info.configured) {
          return { ok: true, ref, via: 'credentials' }
        }
      } catch {
        // Treat any throw from describe (provider missing, seam half-broken)
        // as "not configured here" and fall through to the env check.
      }
    }
  }

  // 3. Cordis `ctx.get` returns undefined for absent services, without throwing
  //    or falling through to process.env. Reproduce `launchEnvironmentOf`'s
  //    fallback locally, without importing the optional peer. A provided
  //    snapshot remains authoritative; empty values do not count as configured.
  const snapshot = ctx.get('launchEnvironment') ?? {
    get(name: string) {
      const value = process.env[name]
      return value !== undefined && value !== '' ? { value, source: 'process' } : undefined
    },
  }
  const entry = snapshot.get(ref)
  if (entry !== undefined && typeof entry.value === 'string' && entry.value.length > 0) {
    return { ok: true, ref, via: 'env' }
  }

  return { ok: false, ref }
}

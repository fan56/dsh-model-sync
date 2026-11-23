// B1: profile identity for the shared ~/.dsh/models-store.json (design §14.1,
// §14.7.4, H9). Every dsh profile on a machine writes the SAME models-store.json;
// without a profile dimension in the ledger/migration-record keys, profile A's
// `applied` record lets never-migrated profile B through the migration gate and
// A's rollback clobbers B's ledger + settings. This module supplies the profile
// dimension and the key primitives used by the file-backed stores.
//
// Identity source (host-provided — never guessed from settings or file names):
//   1. cordis `profileContext.name` (dsh app-boot): the launched profile name.
//   2. launchEnvironment `DSH_PROFILE`: the same value, launcher-provided env.
//   3. cordis `profileContext.dir` / launchEnvironment `DSH_PROFILE_DIR`:
//      absolute profile directory, used ONLY when no name is available.
//   4. NO identity → FAIL CLOSED. `resolveProfileKey` returns undefined and the
//      migration/ownership ledger callers refuse to read or write. There is
//      deliberately NO silent 'default' collapse: two profiles with no resolved
//      identity would share one key and reopen the B1 failure (design H9).
//
// Stability: the primary key is the profile NAME. It is fixed for the lifetime
// of a profile across restarts and processes. The host derives
// `name = basename(dir)`, so MOVING a profile directory while keeping its
// basename leaves the key stable; a move that also RENAMES the basename changes
// the name, hence the key: the old record becomes an orphan in the shared store,
// the renamed profile reads no record (absent/legacy) and fails CLOSED — it must
// re-run `migrate plan/apply`. We never auto-claim a record that carries another
// profile's identity. The directory fallback is less stable (moving/renaming the
// directory changes it) and is used only as a last resort.

/** Structural context seam: both services are optional peers in cordis. */
export interface ProfileIdentityContext {
  get(name: 'profileContext'): { name?: string; dir?: string } | undefined
  get(name: 'launchEnvironment'): { get(key: string): { value: string } | undefined } | undefined
  get(name: string): unknown
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Resolve the stable profile key from the host, or `undefined` when no identity
 * is available. Structural `ctx.get` keeps the optional peers optional (SDK
 * hosts provide neither, tests provide fakes). Callers on a migration/ownership
 * ledger path MUST treat `undefined` as fail-closed — see
 * `PROFILE_IDENTITY_REQUIRED_MESSAGE` for the actionable error to surface.
 */
export function resolveProfileKey(ctx: ProfileIdentityContext): string | undefined {
  const profile = ctx.get('profileContext')
  const env = ctx.get('launchEnvironment')
  return nonEmpty(profile?.name)
    ?? nonEmpty(env?.get('DSH_PROFILE')?.value)
    ?? nonEmpty(profile?.dir)
    ?? nonEmpty(env?.get('DSH_PROFILE_DIR')?.value)
}

/**
 * Actionable error for a ledger path that cannot resolve a profile identity.
 * Names verified against the dsh launcher source: `profileContext` ({ name,
 * dir }) is a cordis service (profile-context.ts), `launchEnvironment` is the
 * launcher snapshot service (`launchEnvironmentOf`), and `DSH_PROFILE` /
 * `DSH_PROFILE_DIR` are the `DSH_` prefixed profile variables defined by the
 * shell-env package (derived from `profileContext` for model-shell subprocesses).
 */
export const PROFILE_IDENTITY_REQUIRED_MESSAGE = [
  'model-sync: cannot resolve the dsh profile identity for the opencode-go migration/ownership ledger.',
  'Refusing to share a single key across profiles: without a stable per-profile key another profile could inherit this migration state.',
  'Fix: launch the plugin inside a dsh profile so ctx.profileContext.name (or ctx.profileContext.dir) is available,',
  'or expose the launcher-provided DSH_PROFILE / DSH_PROFILE_DIR values through ctx.launchEnvironment.',
  'No migration record or ledger key was read or written.',
].join(' ')

/** Prefix one opaque models-store slot with the profile dimension. */
export function scopedStoreKey(profileKey: string, key: string): string {
  return `${profileKey}#${key}`
}

/** Base name of the opencode-go migration record slot (shared with migration.ts). */
export const GO_MIGRATION_STORE_KEY_BASE = 'migration:opencode-go'

/**
 * True only for an UNSCOPED legacy opaque key left in the shared store — one
 * that carries NO profile dimension and whose ownership is therefore unknown.
 *
 * Explicit key shapes (design §6.1 / §14.1):
 *   `<profileKey>#<route>#<keyFingerprint>`  → scoped ownership (3 parts) — NOT legacy.
 *   `<profileKey>#migration:opencode-go`     → scoped migration record (2 parts,
 *                                              tail = base name) — NOT legacy.
 *   `<route>#<keyFingerprint>`               → unscoped legacy ownership (2 parts) — legacy.
 *   `migration:opencode-go`                  → unscoped legacy migration (1 part),
 *                                              reported by the caller explicitly.
 *
 * Such keys are reported, never read or claimed. Scoped keys are NEVER legacy,
 * regardless of how many '#' they contain.
 */
export function isUnscopedStoreKey(key: string): boolean {
  const parts = key.split('#')
  if (parts.length !== 2) return false
  const [prefix, tail] = parts
  if (prefix.length === 0 || tail.length === 0) return false
  // A two-part key whose tail is the migration base name is a profile-scoped
  // migration record, not a legacy key. Only other two-part keys (an unscoped
  // `<route>#<keyFingerprint>` ownership slot) are legacy.
  return tail !== GO_MIGRATION_STORE_KEY_BASE
}

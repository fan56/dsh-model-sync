// B1: profile identity for the shared ~/.dsh/models-store.json (design §14.1,
// §14.7.4). Every dsh profile on a machine writes the SAME models-store.json;
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
//   4. 'default': SDK / bare-cordis compositions with no profile context at all.
//
// Stability: the primary key is the profile NAME. It is fixed for the lifetime
// of a profile across restarts and processes, and is unaffected by MOVING the
// profile directory (a move does not rename the profile). RENAMING a profile
// changes its name, hence its key: the old record becomes an orphan in the
// shared store, the renamed profile reads no record (absent/legacy) and fails
// CLOSED — it must re-run `migrate plan/apply`. We never auto-claim a record
// that carries another profile's identity. The directory fallback is less
// stable (moving the directory changes it) and is used only as a last resort.

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
 * Resolve the stable profile key from the host. Structural `ctx.get` keeps the
 * optional peers optional (SDK hosts provide neither, tests provide fakes).
 */
export function resolveProfileKey(ctx: ProfileIdentityContext): string {
  const profile = ctx.get('profileContext')
  const env = ctx.get('launchEnvironment')
  return nonEmpty(profile?.name)
    ?? nonEmpty(env?.get('DSH_PROFILE')?.value)
    ?? nonEmpty(profile?.dir)
    ?? nonEmpty(env?.get('DSH_PROFILE_DIR')?.value)
    ?? 'default'
}

/** Prefix one opaque models-store slot with the profile dimension. */
export function scopedStoreKey(profileKey: string, key: string): string {
  return `${profileKey}#${key}`
}

/**
 * True for an UNSCOPED legacy opaque key left in the shared store. Scoped keys
 * carry at least two '#' (`<profileKey>#<route>#<keyFingerprint>` or
 * `<profileKey>#migration:opencode-go`); a legacy ownership key has exactly one
 * (`<route>#<keyFingerprint>`). The migration record key is checked by its
 * caller against GO_MIGRATION_STORE_KEY. Such keys are reported, never read or
 * claimed — their ownership is unknown.
 */
export function isUnscopedStoreKey(key: string): boolean {
  const parts = key.split('#')
  return parts.length === 2 && parts[1].length > 0
}

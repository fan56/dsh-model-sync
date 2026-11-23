// P1c file adapter: persist the opencode-go ownership ledger in the SAME file
// and through the SAME serialized queue as the pi.dev fetch cache, so a ledger
// write can never clobber a concurrent fetch/override stage (design §6.1,
// ADR-004; verification 21 §9 concern ②).
//
// Wire format (design §6.1, B1): a top-level slot per ledger key,
//   <profileKey>#<route>#<keyFingerprint> -> GoOwnershipEntry
// in ~/.dsh/models-store.json (unscoped callers still use <route>#<keyFingerprint>).
// Keys containing `#` are never valid provider route ids, so the existing
// `read(route)` / `update(route)` paths cannot see these entries. Atomic
// temp+rename and the write queue come from `loadModelsStore()` — this module
// adds no second persistence mechanism.
//
// Failure direction: a corrupt/unreadable document reads as "no ledger"
// (`undefined`). The writer then does a conservative first-round claim — it
// never deletes without a hash (ADR-004: store loss degrades to no-delete).
// The next write replaces the bad file atomically and heals it.

import type { GoOwnershipEntry } from './opencode-go-planner.ts'
import { scopedStoreKey } from './opencode-go-profile.ts'
import { loadModelsStore, type ModelsStoreAccessor } from './remote-catalog.ts'
import type { GoOwnershipStore } from './opencode-go-writer.ts'

/**
 * Build a `GoOwnershipStore` on top of an existing models-store accessor.
 *
 * `profileKey` prefixes every opaque key, turning `<route>#<keyFingerprint>`
 * into `<profileKey>#<route>#<keyFingerprint>` (B1). Two profiles using the
 * same Go key occupy disjoint slots in the shared document, and a rollback
 * deletes only the calling profile's slots. Omitting `profileKey` keeps the
 * pre-fix unscoped behavior for legacy callers/tests only.
 */
export function createFileOwnershipStore(
  accessor: ModelsStoreAccessor,
  profileKey?: string,
): GoOwnershipStore {
  const slot = (key: string): string => profileKey === undefined ? key : scopedStoreKey(profileKey, key)
  return {
    async read(key: string): Promise<GoOwnershipEntry | undefined> {
      let raw: unknown
      try {
        raw = await accessor.readRaw(slot(key))
      } catch {
        // Corrupt file / EACCES: no ledger. Never infer one, never delete.
        return undefined
      }
      // readRaw now returns the slot verbatim; a present primitive/null slot is
      // NOT a ledger entry (same conservative "no ledger" direction as before).
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
      const record = raw as Record<string, unknown>
      if (typeof record.managed !== 'object' || record.managed === null
        || Array.isArray(record.managed)) {
        return undefined
      }
      return record as unknown as GoOwnershipEntry
    },
    async write(key: string, entry: GoOwnershipEntry): Promise<void> {
      await accessor.writeRaw(slot(key), entry as unknown as Record<string, unknown>)
    },
    async delete(key: string): Promise<void> {
      await accessor.deleteRaw(slot(key))
    },
  }
}

/**
 * Production factory: the ledger lives in ~/.dsh/models-store.json. Tests pass
 * `loadModelsStore(tempPath)` through `createFileOwnershipStore` instead, so no
 * test ever touches the real ~/.dsh.
 */
export function createModelsStoreOwnershipStore(storePath?: string, profileKey?: string): GoOwnershipStore {
  return createFileOwnershipStore(loadModelsStore(storePath), profileKey)
}

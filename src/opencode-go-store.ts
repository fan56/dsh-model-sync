// P1c file adapter: persist the opencode-go ownership ledger in the SAME file
// and through the SAME serialized queue as the pi.dev fetch cache, so a ledger
// write can never clobber a concurrent fetch/override stage (design §6.1,
// ADR-004; verification 21 §9 concern ②).
//
// Wire format (design §6.1): a top-level slot per ledger key,
//   <route>#<keyFingerprint> -> GoOwnershipEntry
// in ~/.dsh/models-store.json. Keys containing `#` are never valid provider
// route ids, so the existing `read(route)` / `update(route)` paths cannot see
// these entries. Atomic temp+rename and the write queue come from
// `loadModelsStore()` — this module adds no second persistence mechanism.
//
// Failure direction: a corrupt/unreadable document reads as "no ledger"
// (`undefined`). The writer then does a conservative first-round claim — it
// never deletes without a hash (ADR-004: store loss degrades to no-delete).
// The next write replaces the bad file atomically and heals it.

import type { GoOwnershipEntry } from './opencode-go-planner.ts'
import { loadModelsStore, type ModelsStoreAccessor } from './remote-catalog.ts'
import type { GoOwnershipStore } from './opencode-go-writer.ts'

/** Build a `GoOwnershipStore` on top of an existing models-store accessor. */
export function createFileOwnershipStore(accessor: ModelsStoreAccessor): GoOwnershipStore {
  return {
    async read(key: string): Promise<GoOwnershipEntry | undefined> {
      let raw: Record<string, unknown> | undefined
      try {
        raw = await accessor.readRaw(key)
      } catch {
        // Corrupt file / EACCES: no ledger. Never infer one, never delete.
        return undefined
      }
      if (raw === undefined || typeof raw.managed !== 'object' || raw.managed === null
        || Array.isArray(raw.managed)) {
        return undefined
      }
      return raw as unknown as GoOwnershipEntry
    },
    async write(key: string, entry: GoOwnershipEntry): Promise<void> {
      await accessor.writeRaw(key, entry as unknown as Record<string, unknown>)
    },
    async delete(key: string): Promise<void> {
      await accessor.deleteRaw(key)
    },
  }
}

/**
 * Production factory: the ledger lives in ~/.dsh/models-store.json. Tests pass
 * `loadModelsStore(tempPath)` through `createFileOwnershipStore` instead, so no
 * test ever touches the real ~/.dsh.
 */
export function createModelsStoreOwnershipStore(storePath?: string): GoOwnershipStore {
  return createFileOwnershipStore(loadModelsStore(storePath))
}

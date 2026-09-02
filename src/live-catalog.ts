// Live builtin-catalog loader — prefer the host's own pi-ai data over the
// frozen build-time snapshot.
//
// Why this exists: the snapshot (builtin-catalog-snapshot.ts) is generated at
// dev time and goes stale the moment the host's bundled pi-ai drops, renames,
// or adds models. A stale snapshot made keepBuiltinOnly emit a grok-4.5 entry
// the host no longer knew (pi-ai 0.84.4 removed it), and the alpha line's
// strict llm-pi-ai registration rejected the whole namespace because of it —
// every provider route vanished from the TUI (2026-09-02). Reading the live
// data keeps emitted ids serviceable by construction. The snapshot remains
// only as a per-route fallback when the host install cannot be located (e.g.
// `npm test` on a machine without dsh).
//
// Discovery order for the host closure's @earendil-works/pi-ai:
//   1. DSH_CLOSURE_DIR — points at the @deepseek-ai closure dir (same
//      convention as scripts/link-dsh-closure.mjs); @earendil-works/pi-ai is
//      a sibling scope of the same node_modules.
//   2. `which dsh` realpath — the installed CLI's own node_modules.
//   3. `npm root -g` — dsh's nested node_modules, then the flat layout.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BuiltinModelData } from './translate.ts'

const DATA_REL = join('dist', 'providers', 'data')

interface CatalogCache {
  dir: string
  byRoute: Map<string, BuiltinModelData[]>
}

let cache: CatalogCache | undefined

function findPiAiPackageDir(): string | undefined {
  const candidates: string[] = []
  const override = process.env.DSH_CLOSURE_DIR
  if (override !== undefined && override !== '') {
    try {
      candidates.push(join(dirname(realpathSync(override)), '@earendil-works', 'pi-ai'))
    } catch { /* bad override path — fall through to auto-discovery */ }
  }
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') {
      const real = realpathSync(bin)
      candidates.push(join(dirname(dirname(real)), 'node_modules', '@earendil-works', 'pi-ai'))
    }
  } catch { /* dsh not on PATH */ }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    if (root !== '') {
      candidates.push(join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'))
      candidates.push(join(root, '@earendil-works', 'pi-ai'))
    }
  } catch { /* npm unavailable */ }
  for (const candidate of candidates) {
    try {
      const dir = realpathSync(candidate)
      if (existsSync(join(dir, DATA_REL))) return dir
    } catch { /* candidate missing — try next */ }
  }
  return undefined
}

/** Flatten one route's pi-ai data file (`{api: {modelId: model}}`) into the snapshot shape. */
function loadRoute(dir: string, route: string): BuiltinModelData[] {
  const raw = JSON.parse(readFileSync(join(dir, DATA_REL, `${route}.json`), 'utf8')) as Record<
    string,
    Record<string, { id?: string; api?: string; maxTokens?: number } | null>
  >
  const models: BuiltinModelData[] = []
  for (const [api, apiModels] of Object.entries(raw)) {
    if (typeof apiModels !== 'object' || apiModels === null) continue
    for (const modelData of Object.values(apiModels)) {
      if (typeof modelData !== 'object' || modelData === null || typeof modelData.id !== 'string') continue
      models.push({ id: modelData.id, api: modelData.api ?? api, maxTokens: modelData.maxTokens })
    }
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Refresh the live-catalog cache from the host's pi-ai install. Call once per
 * sync round, before any translate/builtin matching runs. Routes whose data
 * file is unreadable are simply absent from the cache — callers fall back to
 * the frozen snapshot for those. When no host install is found at all the
 * cache is cleared and every route falls back.
 */
export function refreshLiveCatalog(routes: readonly string[]): void {
  const dir = findPiAiPackageDir()
  if (dir === undefined) {
    cache = undefined
    return
  }
  const byRoute = new Map<string, BuiltinModelData[]>()
  for (const route of routes) {
    try {
      byRoute.set(route, loadRoute(dir, route))
    } catch { /* unreadable route file — fall back to snapshot for this route */ }
  }
  cache = { dir, byRoute }
}

/**
 * The live builtin data for a route, or undefined when the host install could
 * not be located or the route file is unreadable — callers fall back to the
 * frozen snapshot.
 */
export function getLiveBuiltinCatalogForRoute(route: string): BuiltinModelData[] | undefined {
  return cache?.byRoute.get(route)
}

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
//
// The probes run lazily in that order, and asynchronously: the first probe
// with a working candidate wins, so the common `which dsh` hit never pays the
// (much slower) `npm root -g` spawn, and no probe blocks the host's event
// loop. Both properties are load-bearing — this runs on the host's loop 5s
// after every boot and on every interval round, where the old synchronous
// `execFileSync` pair froze every surface for ~0.2s per round (measured
// 2026-09-15; ~0.6s under CPU load).

import { execFile as execFileCb } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BuiltinModelData } from './translate.ts'

const DATA_REL = join('dist', 'providers', 'data')

/**
 * Subprocess budget for one probe: a hung `which`/`npm` (broken PATH, npm
 * self-update stall) degrades to the next candidate instead of pinning the
 * refresh round forever — the probe is async, so that wait stays off the loop.
 */
const PROBE_TIMEOUT_MS = 10_000

interface CatalogCache {
  dir: string
  byRoute: Map<string, BuiltinModelData[]>
}

let cache: CatalogCache | undefined

/** Run one probe command; resolves its stdout, rejects on spawn failure / non-zero exit / timeout. */
function runProbe(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(file, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })
}

/** The real pi-ai install dir when `candidate` holds one (DATA_REL present), else undefined. */
function resolvePiAiDir(candidate: string): string | undefined {
  try {
    const dir = realpathSync(candidate)
    return existsSync(join(dir, DATA_REL)) ? dir : undefined
  } catch {
    return undefined
  }
}

/** Probe 1: DSH_CLOSURE_DIR override — no subprocess. */
function closureOverrideCandidates(): string[] {
  const override = process.env.DSH_CLOSURE_DIR
  if (override === undefined || override === '') return []
  try {
    return [join(dirname(realpathSync(override)), '@earendil-works', 'pi-ai')]
  } catch {
    return [] // bad override path — fall through to auto-discovery
  }
}

/** Probe 2: the installed CLI's own node_modules (`which dsh` realpath). */
async function whichDshCandidates(): Promise<string[]> {
  try {
    const bin = (await runProbe('which', ['dsh'])).trim()
    if (bin === '') return []
    return [join(dirname(dirname(realpathSync(bin))), 'node_modules', '@earendil-works', 'pi-ai')]
  } catch {
    return [] // dsh not on PATH, or the probe failed
  }
}

/** Probe 3: `npm root -g` — dsh's nested node_modules, then the flat layout. */
async function npmRootCandidates(): Promise<string[]> {
  try {
    const root = (await runProbe('npm', ['root', '-g'])).trim()
    if (root === '') return []
    return [
      join(root, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai'),
      join(root, '@earendil-works', 'pi-ai'),
    ]
  } catch {
    return [] // npm unavailable
  }
}

/** Locate the host's @earendil-works/pi-ai install: ordered probes, first working candidate wins. */
async function findPiAiPackageDir(): Promise<string | undefined> {
  const probes: ReadonlyArray<() => string[] | Promise<string[]>> = [
    closureOverrideCandidates,
    whichDshCandidates,
    npmRootCandidates,
  ]
  for (const probe of probes) {
    for (const candidate of await probe()) {
      const dir = resolvePiAiDir(candidate)
      if (dir !== undefined) return dir
    }
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
 *
 * Async on purpose: the host install lookup spawns `which`/`npm`, and this
 * runs on the host's event loop (see the module note). Callers await it.
 */
export async function refreshLiveCatalog(routes: readonly string[]): Promise<void> {
  const dir = await findPiAiPackageDir()
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

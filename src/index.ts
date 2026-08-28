// Plan C (settings-seam): orchestrator with overlay and settings modes.

/**
 * dsh-model-sync — drive the llm adapter's pi.dev catalog refresh and report
 * what changed.
 *
 * Supports two write modes:
 * - 'overlay' (default): uses the patched dsh-llm-pi-ai's piAiCatalog.refresh()
 *   to overlay pi.dev entries in memory (existing behavior, requires patch)
 * - 'settings': self-contained fetch → translate → settings.mutate pipeline
 *   that writes directly to settings.yaml (zero patch required)
 *
 * @module dsh-model-sync
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { diffModelIds, diffEntries } from './diff.ts'
import {
  fetchRemoteCatalog,
  loadModelsStore,
  type RemoteCatalogEntry,
} from './remote-catalog.ts'
import {
  translateEntries,
  type SettingsModelProfile,
  type TranslateOptions,
  type DropWarning,
} from './translate.ts'
import {
  syncToSettings,
  type SettingsService,
  type SettingsDescriptor,
  type Logger,
} from './writer.ts'
import { BUILTIN_CATALOG_SNAPSHOT } from './builtin-catalog-snapshot.ts'

export const name = 'dsh-model-sync'

/** The settings seam this plugin consumes (its own config namespace). */
export const inject = ['settings']

const OWN_NS = settingsNamespace('model-sync')

/** The `model-sync` settings namespace: user-editable in settings.yaml. */
const ModelSyncConfig = z.object({
  /** Write mode: 'overlay' (legacy, requires patch) or 'settings' (Plan C). */
  writeMode: z.union(['overlay', 'settings']).default('overlay'),
  /** Minutes between auto refreshes (default 240 = 4 hours); 0 = startup-only. */
  intervalMinutes: z.number().step(1).min(0).default(240),
  /** Delay before the first auto refresh, so the llm adapter is ready. */
  startupDelaySeconds: z.number().step(1).min(0).default(5),
  /** Abort budget for one forced refresh's network round. */
  refreshTimeoutMs: z.number().step(1).min(1000).default(120000),
  /** Routes to manage (empty = all pi.dev routes). */
  managedRoutes: z.array(z.string()).default([]),
  /** Keep builtin-only models not in pi.dev (smooth migration). */
  keepBuiltinOnly: z.boolean().default(true),
  /** Drop unserviceable entries (true) or abort the entire route (false). */
  dropUnserviceable: z.boolean().default(true),
  /** Notify on changes (logger + /model-sync report). */
  syncNotify: z.boolean().default(false),
  /**
   * Force all models with a non-empty thinkingFormat to have max reasoning
   * effort. Skips S2 gate's SRE check, ensures reasoningEfforts contains
   * max, and forces compat.supportsReasoningEffort=true (S5 gate, openai-
   * completions only). 400 risk is on the user.
   */
  forceMaxReasoningEffort: z.boolean().default(false),
})

/** Typed view of the resolved `model-sync` namespace value. */
interface ModelSyncConfigValue {
  writeMode: 'overlay' | 'settings'
  intervalMinutes: number
  startupDelaySeconds: number
  refreshTimeoutMs: number
  managedRoutes: string[]
  keepBuiltinOnly: boolean
  dropUnserviceable: boolean
  syncNotify: boolean
  forceMaxReasoningEffort: boolean
}

/** The llm seam as this plugin needs it (overlay mode). */
interface LlmSeam {
  listProviders?(): readonly { id: string }[]
  listModels?(provider: string): Promise<readonly { id: string }[]>
}

/** The catalog-refresh seam exposed by the patched dsh-llm-pi-ai adapter. */
interface CatalogSeam {
  refresh?(options: { force?: boolean; signal?: AbortSignal }): Promise<Map<string, unknown>>
}

/** The `modelSync` service surfaced to UIs: run one refresh round and get the report. */
export interface ModelSyncService {
  syncNow(): Promise<string>
}

/**
 * Default routes to manage when managedRoutes is empty.
 *
 * NOTE (intentional deviation from design doc §5.5): the design suggests
 * dynamically enumerating routes from the llm adapter's provider list, but
 * that requires pi.dev to have been fetched first — unavailable during
 * bootstrap. A static list is the pragmatic fallback; update manually when
 * new routes appear on pi.dev.
 */
const DEFAULT_ROUTES = [
  'opencode-go',
  'zai-coding-cn',
  'minimax-cn',
  'xiaomi-token-plan-cn',
]

export function apply(ctx: Context): void {
  const scope = ctx.settings.register(OWN_NS, ModelSyncConfig)

  // -----------------------------------------------------------------------
  // Overlay mode sync (existing behavior)
  // -----------------------------------------------------------------------
  const syncOverlay = async (
    config: ModelSyncConfigValue,
    llm: LlmSeam,
    force: boolean,
  ): Promise<string> => {
    const catalog = ctx.get('piAiCatalog') as CatalogSeam | undefined
    if (catalog?.refresh === undefined) {
      return 'catalog refresh is unavailable — the dsh-llm-pi-ai remote-catalog patch is not applied; the model list is the static catalog only.'
    }
    let providers: readonly { id: string }[]
    try {
      providers = llm.listProviders!()
    } catch {
      return 'llm service is not ready yet; try again shortly.'
    }
    if (providers.length === 0) return 'No providers configured under llm-pi-ai.'

    const list = async (): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>()
      await Promise.all(providers.map(async (provider) => {
        try {
          out.set(provider.id, (await llm.listModels!(provider.id)).map((model) => model.id))
        } catch {
          out.set(provider.id, [])
        }
      }))
      return out
    }
    const before = await list()
    const errors = await catalog.refresh({
      force,
      signal: AbortSignal.timeout(config.refreshTimeoutMs),
    })
    const after = await list()

    const lines: string[] = []
    for (const provider of providers) {
      const error = errors.get(provider.id)
      if (error !== undefined) {
        lines.push(`${provider.id}: refresh failed (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
      const beforeIds = before.get(provider.id) ?? []
      const afterIds = after.get(provider.id) ?? []
      const { added, removed } = diffModelIds(beforeIds, afterIds)
      if (added.length === 0 && removed.length === 0) {
        lines.push(`${provider.id}: up to date (${afterIds.length} models)`)
        continue
      }
      const parts: string[] = []
      if (added.length > 0) parts.push(`+${added.join(', +')}`)
      if (removed.length > 0) parts.push(`-${removed.join(', -')}`)
      lines.push(`${provider.id}: ${parts.join('; ')} (now ${afterIds.length} models)`)
    }
    return lines.join('\n')
  }

  // -----------------------------------------------------------------------
  // Settings mode sync (Plan C: fetch → translate → write)
  // -----------------------------------------------------------------------
  const syncSettings = async (
    config: ModelSyncConfigValue,
    force: boolean,
  ): Promise<string> => {
    const settings = ctx.get('settings') as SettingsService | undefined
    const logger = ctx.logger as unknown as Logger
    const store = loadModelsStore()
    const lines: string[] = []

    // Determine routes to sync
    const routes = config.managedRoutes.length > 0
      ? config.managedRoutes
      : DEFAULT_ROUTES

    for (const route of routes) {
      // Fetch from pi.dev — pass force to bypass revalidation throttle (I-5)
      const result = await fetchRemoteCatalog(route, config.refreshTimeoutMs, store, { force })

      if (result.error !== undefined && result.entries.length === 0) {
        lines.push(`${route}: fetch failed (${result.error}); keeping last-good`)
        continue
      }

      if (result.entries.length === 0) {
        lines.push(`${route}: no models from pi.dev; skipped`)
        continue
      }

      // Translate
      const translateOpts: TranslateOptions = {
        keepBuiltinOnly: config.keepBuiltinOnly,
        dropUnserviceable: config.dropUnserviceable,
        dropWarnings: [],
        forceMaxReasoningEffort: config.forceMaxReasoningEffort,
      }

      // For builtin catalog snapshot: we use a mock for now since we can't
      // import pi-ai at runtime. The builtin catalog data is needed for
      // base-matching classification. In a real deployment, this would come
      // from the built-in snapshot file.
      const builtinData = getBuiltinCatalogForRoute(route)
      const builtinIds = new Set(builtinData.map((b) => b.id))
      const builtinOnlyEntries = config.keepBuiltinOnly
        ? getBuiltinOnlyEntries(route, result.entries, builtinIds)
        : undefined

      const translated = translateEntries(
        result.entries,
        builtinIds,
        builtinData,
        route,
        translateOpts,
        builtinOnlyEntries,
      )

      // Report drops and warnings
      if (translated.dropped.length > 0) {
        for (const w of translated.dropped) {
          lines.push(`${route}: DROPPED ${w.id} — ${w.reason}`)
        }
      }
      if (translated.warnings.length > 0) {
        for (const w of translated.warnings) {
          lines.push(`${route}: DEGRADED ${w.id} — ${w.reason}`)
        }
      }

      // B1: abort detected — skip writer, only warn
      if (translated.aborted) {
        lines.push(`${route}: ABORTED — dropUnserviceable=false and ${translated.dropped.length} entries dropped; settings not written`)
        continue
      }

      // I-6: generate added/removed diff report from current raw models
      if (settings !== undefined) {
        const descs = settings.describe()
        const llmDesc = descs.find((d) => d.ns === 'llm-pi-ai')
        const rawModels = getRawUserModelsFromDesc(llmDesc, route)
        if (rawModels !== undefined) {
          const entryDiff = diffEntries(rawModels, translated.entries)
          if (entryDiff.added.length > 0) lines.push(`${route}: added ${entryDiff.added.join(', ')}`)
          if (entryDiff.removed.length > 0) lines.push(`${route}: removed ${entryDiff.removed.join(', ')}`)
        }
      }

      // Write to settings (change-only, with conflict retry)
      const syncResult = await syncToSettings(
        settings,
        route,
        translated.entries,
        logger,
        // retranslate callback for conflict retry
        async (newRevision: number) => {
          // Re-translate with same data (the remote data hasn't changed;
          // only the settings revision changed)
          void newRevision // revision is used by the caller
          return translated.entries
        },
      )

      if (syncResult.wrote) {
        lines.push(`${route}: wrote ${translated.entries.length} models (${syncResult.reason})`)
      } else if (syncResult.reason === 'no-change') {
        lines.push(`${route}: up to date (${translated.entries.length} models)`)
      } else if (syncResult.reason === 'skipped') {
        lines.push(`${route}: skipped — settings service unavailable or llm-pi-ai namespace not registered`)
      } else if (syncResult.reason === 'mutate-rejected') {
        lines.push(`${route}: rejected by settings validation (see log)`)
      } else {
        lines.push(`${route}: ${syncResult.reason} (${translated.entries.length} models)`)
      }
    }

    return lines.join('\n')
  }

  // -----------------------------------------------------------------------
  // Unified syncNow
  // -----------------------------------------------------------------------
  const syncNow = async (force: boolean): Promise<string> => {
    const config = scope.get() as unknown as ModelSyncConfigValue

    if (config.writeMode === 'settings') {
      return syncSettings(config, force)
    }

    // Overlay mode (existing behavior)
    const llm = ctx.get('llm') as LlmSeam | undefined
    if (llm === undefined || llm.listProviders === undefined || llm.listModels === undefined) {
      return 'llm service is not available yet; try again shortly.'
    }
    return syncOverlay(config, llm, force)
  }

  /** Auto rounds log the same report the /model-sync command shows. */
  const runAuto = (): void => {
    void syncNow(false).then((report) => {
      for (const line of report.split('\n')) ctx.logger.info('model-sync: %s', line)
    })
  }

  /** (Re)arm the auto-refresh interval; 0 disarms. */
  const armInterval = (minutes: number): void => {
    if (stopInterval !== undefined) clearInterval(stopInterval)
    stopInterval = undefined
    if (minutes > 0) stopInterval = setInterval(runAuto, minutes * 60_000)
  }
  let stopInterval: ReturnType<typeof setInterval> | undefined
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  // One effect releases whatever timers are live at dispose.
  ctx.effect(() => () => {
    if (stopInterval !== undefined) clearInterval(stopInterval)
    if (startupTimer !== undefined) clearTimeout(startupTimer)
  })

  const initial = scope.get() as unknown as ModelSyncConfigValue
  startupTimer = setTimeout(runAuto, Math.max(0, initial?.startupDelaySeconds ?? 5) * 1000)
  armInterval(initial?.intervalMinutes ?? 240)
  scope.watch((next) => {
    const value = next as unknown as ModelSyncConfigValue
    armInterval(value?.intervalMinutes ?? 0)
    // Clear any pending startup timer before setting a new one
    if (startupTimer !== undefined) clearTimeout(startupTimer)
    startupTimer = setTimeout(runAuto, 1000)
  })

  // The /model-sync command (registered by dsh-tui-pi) drives this service.
  ctx.provide('modelSync', { syncNow: () => syncNow(true) } satisfies ModelSyncService)
}

// ---------------------------------------------------------------------------
// Builtin catalog helpers (uses shared snapshot)
// ---------------------------------------------------------------------------

/**
 * Get builtin catalog data for a route from the shared snapshot module.
 * Design doc §3.6: "构建期把 installed catalog 快照成常量"
 */
function getBuiltinCatalogForRoute(route: string): Array<{ id: string; api: string; maxTokens?: number }> {
  return BUILTIN_CATALOG_SNAPSHOT[route] ?? []
}

/**
 * Get entries from builtin catalog that are not in pi.dev (for keepBuiltinOnly).
 * Returns minimal RemoteCatalogEntry-shaped objects — translateEntries only
 * reads entry.id from these, emitting {id} profiles (I-3).
 */
function getBuiltinOnlyEntries(
  route: string,
  piDevEntries: RemoteCatalogEntry[],
  builtinIds: Set<string>,
): RemoteCatalogEntry[] {
  const piDevIds = new Set(piDevEntries.map((e) => e.id))
  const builtinData = getBuiltinCatalogForRoute(route)

  return builtinData
    .filter((b) => !piDevIds.has(b.id) && builtinIds.has(b.id))
    .map((b) => ({
      id: b.id,
      name: b.id,
      api: b.api,
      provider: route,
      baseUrl: '',
      reasoning: false,
      input: ['text'] as string[],
    }))
}

/**
 * Extract raw user-segment models for a route from a settings descriptor (I-6).
 */
function getRawUserModelsFromDesc(
  desc: SettingsDescriptor | undefined,
  route: string,
): SettingsModelProfile[] | undefined {
  if (desc === undefined) return undefined
  const providers = desc.user?.providers as Record<string, unknown> | undefined
  if (providers === undefined) return undefined
  const routeData = providers[route] as Record<string, unknown> | undefined
  if (routeData === undefined) return undefined
  const models = routeData.models
  if (!Array.isArray(models)) return undefined
  return models as SettingsModelProfile[]
}

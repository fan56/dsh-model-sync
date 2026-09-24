// Plan C (settings-seam): orchestrator with overlay and settings modes.

/**
 * dsh-model-sync — drive the llm adapter's pi.dev catalog refresh and report
 * what changed.
 *
 * Supports two write modes:
 * - 'settings' (default): self-contained fetch → translate → settings.mutate
 *   pipeline that writes through the host settings service (zero patch
 *   required; settings.yaml up to dsh 0.1.6, the profile patch on 0.1.7+)
 * - 'overlay' (legacy): uses the patched dsh-llm-pi-ai's piAiCatalog.refresh()
 *   to overlay pi.dev entries in memory (requires patch)
 *
 * @module dsh-model-sync
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Type-only side-effect import: loads dsh-settings' `declare module
// '@deepseek-ai/cordis'` augmentation, which is what puts `ctx.settings` on
// the Context type. There is no runtime import — the host provides the
// settings service; alpha.3 removed the settingsNamespace() helper this file
// used to import.
import type {} from '@deepseek-ai/dsh-settings'
// Types only (erased at emit); dsh-commands is an optional peer, so hosts
// without it still load this plugin — see the guarded registration below.
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
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
  type BuiltinModelData,
} from './translate.ts'
import {
  syncToSettings,
  type SettingsService,
  type SettingsDescriptor,
  type Logger,
} from './writer.ts'
import { BUILTIN_CATALOG_SNAPSHOT } from './builtin-catalog-snapshot.ts'
import { refreshLiveCatalog, getLiveBuiltinCatalogForRoute } from './live-catalog.ts'
import { checkRouteCredential, type RouteCredentialContext } from './route-credential.ts'
import {
  PROVIDER_NATIVE_ENDPOINTS,
  fetchProviderNativeModels,
  mergeProviderNativeEntries,
  resolveRouteCredentialValue,
  type NativeCredentialContext,
} from './provider-native.ts'

export const name = 'dsh-model-sync'

/** The settings seam this plugin consumes (its own config namespace). */
export const inject = ['settings']

// dsh-settings 0.1.7 rewrote the seam: the runtime register(ns, schema) call
// is gone, and a plugin's settings form is projected from its exported
// `Config` schema — the namespace IS the profile entry id. The bundle patch
// mounts this plugin under the stable id below, so `dsh-model-sync` is the
// namespace the settings UI (and the legacy settings.yaml import) address.
const OWN_ENTRY_ID = 'dsh-model-sync'

/**
 * The plugin's `Config` schema: the settings form the 0.1.7 host projects from
 * the `dsh-model-sync` entry. Every field is user-adjustable and therefore
 * `.volatile()` — volatile fields are the only ones the settings page can edit
 * (and the only ones the legacy settings.yaml import accepts), and they hot-
 * reload without remounting the plugin. Requires schemastery >= 3.18.4 (the
 * version the dsh 0.1.7 wave ships), which provides `.volatile()`.
 */
export const Config = z.object({
  /**
   * Write mode: 'settings' (default, zero-patch settings.mutate pipeline) or
   * 'overlay' (legacy, delegates to the patched adapter's piAiCatalog.refresh
   * and requires the optional patch).
   */
  writeMode: z.union(['settings', 'overlay']).default('settings').volatile(),
  /** Minutes between auto refreshes (default 240 = 4 hours); 0 = startup-only. */
  intervalMinutes: z.number().step(1).min(0).default(240).volatile(),
  /** Delay before the first auto refresh, so the llm adapter is ready. */
  startupDelaySeconds: z.number().step(1).min(0).default(5).volatile(),
  /** Abort budget for one forced refresh's network round. */
  refreshTimeoutMs: z.number().step(1).min(1000).default(120000).volatile(),
  /** Routes to manage (empty = all pi.dev routes). */
  managedRoutes: z.array(z.string()).default([]).volatile(),
  /** Keep builtin-only models not in pi.dev (smooth migration). */
  keepBuiltinOnly: z.boolean().default(true).volatile(),
  /** Drop unserviceable entries (true) or abort the entire route (false). */
  dropUnserviceable: z.boolean().default(true).volatile(),
  /**
   * Union each mapped route's first-party /models listing into the pi.dev
   * result (additions only — see provider-native.ts). Default on: the native
   * listing is the fresher source; pi.dev lags (measured 2026-09-22).
   */
  providerNativeFetch: z.boolean().default(true).volatile(),
  /** Notify on changes (logger + /model-sync report). */
  syncNotify: z.boolean().default(false).volatile(),
  /**
   * Force all models with a non-empty thinkingFormat to have max reasoning
   * effort. Skips S2 gate's SRE check, ensures reasoningEfforts contains
   * max, and forces compat.supportsReasoningEffort=true (S5 gate, openai-
   * completions only). 400 risk is on the user.
   */
  forceMaxReasoningEffort: z.boolean().default(false).volatile(),
  /**
   * keepBuiltinOnly may re-emit builtin ids the official default model list
   * dropped (dsh 0.1.7 removed deepseek-v4-flash / deepseek-v4-flash-vision-
   * exp). Those stay in the snapshot for historical user configurations but
   * are excluded from the synced list unless this flag opts them back in —
   * a re-emitted retired id is a model the 0.1.7 host no longer resolves.
   */
  keepDeprecatedBuiltin: z.boolean().default(false).volatile(),
})

/**
 * A stable configuration reference — the protocol the 0.1.7 host hands the
 * plugin for every volatile `Config` field (cosmokit's `Volatile<T>`, declared
 * locally as a structural type so this module stays dependency-free). `get()`
 * returns the current immutable snapshot; the host swaps the value in place on
 * volatile-only edits, so reading per round is always fresh.
 */
interface VolatileRef<T> {
  get(): T
}

/** Typed view of the resolved `Config` value as delivered to apply(). */
interface ModelSyncConfigValue {
  writeMode: VolatileRef<'settings' | 'overlay'>
  intervalMinutes: VolatileRef<number>
  startupDelaySeconds: VolatileRef<number>
  refreshTimeoutMs: VolatileRef<number>
  managedRoutes: VolatileRef<readonly string[]>
  keepBuiltinOnly: VolatileRef<boolean>
  dropUnserviceable: VolatileRef<boolean>
  syncNotify: VolatileRef<boolean>
  forceMaxReasoningEffort: VolatileRef<boolean>
  providerNativeFetch: VolatileRef<boolean>
  keepDeprecatedBuiltin: VolatileRef<boolean>
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

/** Default route list — exported for tests that need to iterate the same set
 *  the plugin syncs when `managedRoutes` is empty. Not part of the public
 *  runtime surface; subject to change without notice. */
export const DEFAULT_ROUTES_LIST = DEFAULT_ROUTES

export function apply(ctx: Context, config: ModelSyncConfigValue): void {
  // On dsh 0.1.7 the resolved Config arrives as apply()'s second argument:
  // every volatile field is a stable reference (see VolatileRef), so the
  // reads below are live views — no scope.get() and no scope.watch() (both
  // removed from dsh-settings; the hot-reload notification moved to the
  // settings/document-updated event, subscribed at the bottom of apply()).

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
      // Degradation path (never throws): the overlay needs a hand-patched
      // dsh-llm-pi-ai exposing piAiCatalog.refresh(). Since dsh 0.1.2-alpha.3
      // the patch cannot even apply (it shims settingsNamespace and
      // installSettingsSection, both removed from dsh-settings), so hosts on
      // the alpha line always land here unless they run the settings mode.
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
      signal: AbortSignal.timeout(config.refreshTimeoutMs.get()),
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
    const managedRoutes = config.managedRoutes.get()
    const routes = managedRoutes.length > 0
      ? [...managedRoutes]
      : DEFAULT_ROUTES

    const gateDesc = settings?.describe().find((d) => d.ns === 'llm-pi-ai')
    const gateCtx = ctx as RouteCredentialContext
    for (const route of routes) {
      // Layer 1 follows llm-pi-ai's resolveApiKey: prefer the credentials seam.
      // Layer 2 follows its authContextFrom(ctx).env(): launch environment,
      // or process.env when the service is absent. Both miss → skip fetch,
      // translate and settings.mutate, naming the missing ref in the report.
      // deriveKeyRef replicates the web UI's conventional reference name.
      // Known gap: after credential removal, a same-name shell export allows
      // writes, but requests with the seam present still get MISSING_CREDENTIAL.
      const gate = await checkRouteCredential(gateCtx, gateDesc, route)
      if (!gate.ok) {
        lines.push(`${route}: skipped — credential ${gate.ref} not configured`)
        continue
      }

      // Fetch from pi.dev — pass force to bypass revalidation throttle (I-5)
      const result = await fetchRemoteCatalog(route, config.refreshTimeoutMs.get(), store, { force })

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
        keepBuiltinOnly: config.keepBuiltinOnly.get(),
        dropUnserviceable: config.dropUnserviceable.get(),
        dropWarnings: [],
        forceMaxReasoningEffort: config.forceMaxReasoningEffort.get(),
      }

      // For builtin catalog snapshot: we use a mock for now since we can't
      // import pi-ai at runtime. The builtin catalog data is needed for
      // base-matching classification. In a real deployment, this would come
      // from the built-in snapshot file.
      const builtinData = getBuiltinCatalogForRoute(route)

      // Provider-native union: fold the route's first-party /models listing
      // (the fresher source — pi.dev lags; measured 2026-09-22) into the
      // pi.dev result. Additions only, capacities only where the listing
      // states them; any failure degrades to the pi.dev list unchanged so a
      // native hiccup can never lose models.
      let entries = result.entries
      if (config.providerNativeFetch.get() && PROVIDER_NATIVE_ENDPOINTS[route] !== undefined) {
        const apiKey = await resolveRouteCredentialValue(
          ctx as unknown as NativeCredentialContext,
          gateDesc,
          route,
        )
        if (apiKey === undefined) {
          lines.push(`${route}: provider-native skipped — credential value unavailable`)
        } else {
          const native = await fetchProviderNativeModels(route, apiKey, config.refreshTimeoutMs.get())
          if (native.ok) {
            // Base-less synthesis needs the route's one addressable api;
            // unknown or mixed-protocol routes skip synthesis wholesale.
            const routeApis = [...new Set(builtinData.map((b) => b.api))]
            const merged = mergeProviderNativeEntries(
              entries,
              native,
              route,
              routeApis.length === 1 ? routeApis[0] : undefined,
            )
            entries = merged.entries
            if (merged.addedIds.length > 0) {
              lines.push(
                `${route}: provider-native added ${merged.addedIds.join(', ')} (${native.ids.length} ids from first-party listing)`,
              )
            }
            if (merged.skippedReason !== undefined) {
              lines.push(`${route}: provider-native ${merged.skippedReason}`)
            }
          } else {
            lines.push(`${route}: provider-native ${native.error} — pi.dev list only`)
          }
        }
      }

      const builtinIds = new Set(builtinData.map((b) => b.id))
      const builtinOnlyEntries = translateOpts.keepBuiltinOnly
        ? getBuiltinOnlyEntries(route, entries, builtinData, config.keepDeprecatedBuiltin.get())
        : undefined

      const translated = translateEntries(
        entries,
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

      // Write to settings (change-only, with conflict retry); the store
      // carries the modelOverrides replay/persist (mutual-exclusion fix)
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
        store,
      )

      if (syncResult.wrote) {
        // Detail suffix for the override flows; routes without overrides keep
        // the classic "(wrote)" line byte-for-byte.
        const reason = syncResult.reason === 'wrote' ? '' : `${syncResult.reason}; `
        let detail: string | undefined
        if (syncResult.overridesSource === 'settings') {
          detail = `${reason}folded user modelOverrides, unset the key`
        } else if (syncResult.overridesSource === 'store') {
          detail = `${reason}applied stored modelOverrides`
        }
        if (detail !== undefined && syncResult.droppedOverrideIds !== undefined && syncResult.droppedOverrideIds.length > 0) {
          detail += `; override ids not in target kept in models-store: ${syncResult.droppedOverrideIds.join(', ')}`
        }
        lines.push(detail !== undefined
          ? `${route}: wrote ${translated.entries.length} models (${detail})`
          : `${route}: wrote ${translated.entries.length} models (${syncResult.reason})`)
      } else if (syncResult.reason === 'no-change') {
        lines.push(`${route}: up to date (${translated.entries.length} models)`)
      } else if (syncResult.reason === 'skipped') {
        lines.push(`${route}: skipped — settings service unavailable or llm-pi-ai namespace not registered`)
      } else if (syncResult.reason === 'mutate-rejected') {
        lines.push(`${route}: rejected by settings validation (see log)`)
      } else if (syncResult.reason === 'store-unavailable') {
        // The store failed (corrupt/permission on read, or filesystem on
        // write); settings.models was the authoritative source and stays
        // untouched either way — the user's folded values are preserved.
        lines.push(`${route}: skipped (models-store unavailable; settings untouched)`)
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
    // Read the live refs up front; the volatile snapshots are fresh per call.
    const writeMode = config.writeMode.get()
    const managedRoutes = config.managedRoutes.get()
    const routes = managedRoutes.length > 0 ? [...managedRoutes] : DEFAULT_ROUTES

    // Prefer the host's live pi-ai catalog for this round; the frozen
    // snapshot is only the no-host fallback. Without this, keepBuiltinOnly
    // re-emits ids the host's catalog has already dropped. Awaiting keeps the
    // `which`/`npm` probes off the host's event loop (they used to block every
    // surface for ~0.2s per round).
    await refreshLiveCatalog(routes)

    if (writeMode === 'settings') {
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
    // A rejected round (service lookups mid-dispose, a refused mutate) must
    // settle here: an unhandled rejection from a timer-driven round would
    // terminate the whole host process, and the auto path has no caller to
    // hand the error to.
    void syncNow(false).then(
      (report) => {
        for (const line of report.split('\n')) ctx.logger.info('model-sync: %s', line)
      },
      (error: unknown) => {
        ctx.logger.warn('model-sync: auto refresh failed: %o', error)
      },
    )
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

  // Volatile fields are stable references, so the initial arms read them once
  // and the interval keeps working; the hot-reload notification arrives as a
  // settings/document-updated event (the 0.1.7 replacement for scope.watch).
  startupTimer = setTimeout(runAuto, Math.max(0, config.startupDelaySeconds.get() ?? 5) * 1000)
  armInterval(config.intervalMinutes.get() ?? 240)
  ctx.effect(() => ctx.on('settings/document-updated', (ns) => {
    // Only this plugin's entry (the bundle-patch id) re-arms the timers; the
    // handler is idempotent — the refs already carry the new values, so the
    // next round reads them fresh. Never throws: an interval re-arm is two
    // timer calls, and a throwing settings listener is a host-side incident.
    if (ns !== OWN_ENTRY_ID) return
    armInterval(config.intervalMinutes.get() ?? 0)
    // Clear any pending startup timer before setting a new one
    if (startupTimer !== undefined) clearTimeout(startupTimer)
    startupTimer = setTimeout(runAuto, 1000)
  }), 'dsh-model-sync: settings/document-updated')

  // The modelSync service stays exposed for UIs that want direct access. The
  // /model-sync command itself is registered by this plugin (below) through
  // the shared command registry, which interactive UIs discover on their own.
  ctx.provide('modelSync', { syncNow: () => syncNow(true) } satisfies ModelSyncService)

  // Register the /model-sync slash command from the plugin itself. The
  // registry is @deepseek-ai/dsh-commands' CommandRuntime ("Plugin-owned
  // human-command registry shared by interactive UI adapters") — registration
  // is global, so every interactive UI lists the command without any UI-side
  // wiring. The registry is an optional peer: the `ctx.inject` sub-fiber stays
  // dormant until the host provides the `commands` service, so hosts without
  // the registry keep every other feature working. A bare `ctx.commands` read
  // without a declared inject throws in cordis 4.
  ctx.inject(['commands'], (cmdCtx) => {
    const commands = (cmdCtx as {
      commands?: { register(definition: CommandDefinition): () => void }
    }).commands
    if (commands?.register === undefined) return
    cmdCtx.effect(() => {
      const definition: CommandDefinition = {
        name: 'model-sync',
        description: 'Force one model-list sync round from the pi.dev gateway into settings (dsh-model-sync)',
        handler: async (invocation) => {
          const ignored = invocation.rawInput.trim().length > 0
            ? 'The sync scope is decided by the model-sync managedRoutes config; the argument is ignored.\n'
            : ''
          try {
            const report = await syncNow(true)
            return { kind: 'success', text: `${ignored}${report}` } satisfies CommandResult
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { kind: 'error', text: `${ignored}model-sync failed: ${message}` } satisfies CommandResult
          }
        },
      }
      return commands.register(definition)
    }, 'dsh-model-sync: /model-sync')
  })
}

// ---------------------------------------------------------------------------
// Builtin catalog helpers (uses shared snapshot)
// ---------------------------------------------------------------------------

/**
 * Get builtin catalog data for a route: the host's live pi-ai catalog when it
 * can be located, the frozen build-time snapshot otherwise. Live-first is the
 * point — the snapshot rots when the host's bundled pi-ai drops models
 * (grok-4.5 was removed in pi-ai 0.84.4), and a stale keepBuiltinOnly entry
 * gets the whole llm-pi-ai namespace rejected by the alpha line's strict
 * registration.
 */
function getBuiltinCatalogForRoute(route: string): BuiltinModelData[] {
  return getLiveBuiltinCatalogForRoute(route) ?? BUILTIN_CATALOG_SNAPSHOT[route] ?? []
}

/**
 * Get entries from builtin catalog that are not in pi.dev (for keepBuiltinOnly).
 * Returns minimal RemoteCatalogEntry-shaped objects — translateEntries only
 * reads entry.id from these, emitting {id} profiles (I-3).
 *
 * Deprecated snapshot entries (the official default model list dropped them —
 * dsh 0.1.7 removed deepseek-v4-flash / deepseek-v4-flash-vision-exp) are
 * excluded unless `includeDeprecated` opts them back in: a re-emitted retired
 * id is a model the 0.1.7 host no longer resolves. The data itself stays in
 * the snapshot for historical user configurations.
 *
 * Exported for the test suite; not part of the public runtime surface.
 */
export function getBuiltinOnlyEntries(
  route: string,
  piDevEntries: RemoteCatalogEntry[],
  builtinData: BuiltinModelData[],
  includeDeprecated = false,
): RemoteCatalogEntry[] {
  const piDevIds = new Set(piDevEntries.map((e) => e.id))

  return builtinData
    .filter((b) =>
      !piDevIds.has(b.id)
      && (includeDeprecated || b.deprecated !== true)
    )
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

[简体中文](./README.zh-CN.md) | English

# dsh-model-sync

[![npm version](https://img.shields.io/npm/v/@aiwayds/dsh-model-sync)](https://www.npmjs.com/package/@aiwayds/dsh-model-sync) · [GitHub](https://github.com/fan56/dsh-model-sync)

A dsh (DeepSeek Harness) Cordis plugin that keeps the model catalog of your `llm-pi-ai` provider routes in step with the pi.dev gateway's model listing — written into dsh `settings.yaml` through the official settings seam (`settings.mutate`), with zero patches to dsh internals.

**Requires dsh >= 0.1.2-rc.1** — this plugin targets the dsh RC/stable line only (CI and releases resolve the newest of the `latest`/`next` dist-tags at runtime). **The alpha line is no longer supported.**

https://github.com/user-attachments/assets/c3f9c8b1-ea5e-470c-b8a8-60a81fc5c20a

*A live recording of a dsh session running `/model-sync` (MP4, 1.5× speed) — drop reasons, per-route sync statuses and the change report in action. More demos in the [Demos issue](https://github.com/fan56/dsh-model-sync/issues/1).*

## Why

Model lists drift: providers ship new models, retire old ones, and adjust capabilities (`contextWindow`, `input` modalities, `thinkingFormat`, reasoning efforts). Keeping them in sync by hand is error-prone busywork. dsh-model-sync does it for you:

- **Add-only, change-only writes.** New models from pi.dev are merged in, existing ones updated, and unchanged routes are left completely untouched — the writer compares against the raw user segment and skips a route when nothing changed (`writer.ts`, `profilesEqual`, `reason: 'no-change'`).
- **No hand-maintained model lists.** The pi.dev remote catalog is the source of truth for the managed routes; your `settings.yaml` simply reflects it.
- **Scheduled refresh.** An auto round runs shortly after startup and then on a configurable interval, so the catalog stays current without any interaction.

## Features

- **pi.dev gateway sync.** Fetches each managed route's model list from `https://pi.dev/api/models/providers/<route>` with ETag/304 revalidation and a persistent per-provider cache under `~/.dsh/models-store.json` (`remote-catalog.ts`). Transient failures and aborts keep the last-good cache; a 404/501 treats the route as absent for the round.
- **Default routes.** When `managedRoutes` is empty, these pi.dev routes are synced: `opencode-go`, `zai-coding-cn`, `minimax-cn`, `xiaomi-token-plan-cn` (`DEFAULT_ROUTES` in `src/index.ts`).
- **Two write modes** (`writeMode`):
  - `settings` (default) — the zero-patch pipeline: fetch → translate → `settings.mutate`. Self-contained; never touches `settings.yaml` directly, only via the official settings API.
  - `overlay` (legacy) — delegates to the patched `dsh-llm-pi-ai` adapter's `piAiCatalog.refresh()` and merges pi.dev entries in memory (requires the optional patch).
- **Scheduled refresh.** `intervalMinutes` auto rounds (default 240 / 4h) plus a `startupDelaySeconds` initial delay (default 5); each round logs the same report a manual refresh produces. `0` disarms the interval (startup-only). The interval re-arms live when the config changes (`src/index.ts`).
- **Change reporting / diff.** Every round reports added/removed model ids (`diffModelIds`), and in `settings` mode added/removed/changed entries against the current raw settings (`diffEntries`, `diff.ts`). Dropped and degraded entries are reported with their reasons.
- **`modelSync` service.** Exposes a `modelSync` service (`syncNow()`) that a UI can call to force one refresh round and read the report.
- **`/model-sync` command.** The plugin registers a `/model-sync` slash command itself through the shared dsh command registry (`@deepseek-ai/dsh-commands`), so every interactive UI lists it automatically — no UI-side wiring. Running it forces one sync round on the spot and prints the same report the scheduled rounds log; the sync scope is decided by `managedRoutes` (arguments are ignored). The registry is an optional peer: hosts without a command registry still get the scheduled rounds and the `modelSync` service.
- **Translation rules.** pi.dev entries are translated into settings-writable model profiles (`translate.ts`): base-matching vs base-less classification, `reasoningEfforts` derivation (S2 gate), `compat` gating to `openai-completions` (S5 gate), `maxTokens` handling, and drop logic for mixed-protocol routes. Capacity values get a sanity gate: a `contextWindow` that is not a positive integer, or a `maxTokens` that is not a positive integer strictly below the context window (listings sometimes echo the context window into `maxTokens`), is skipped with a degrade warning instead of written.
- **Your overrides are durable.** `modelOverrides` is your own per-model channel (think levels, narrowed context windows). dsh refuses a models list beside non-empty overrides, so the sync folds your fields into the written models, clears the key in the same write, and re-applies the values from its store (`~/.dsh/models-store.json`) on every round — they keep winning over the synced values for as long as the route is managed.
- **Safe-by-default options:**
  - `keepBuiltinOnly: true` — keep built-in catalog models that are not (yet) on pi.dev, so adopting the sync doesn't delete models you already use.
  - `dropUnserviceable: true` — drop unserviceable entries and continue; set to `false` to abort the whole route instead of writing a partial list.
  - `forceMaxReasoningEffort` — force models with a non-empty `thinkingFormat` to max reasoning effort (ensures `reasoningEfforts` contains `max` and forces `compat.supportsReasoningEffort = true` on `openai-completions`).
- **Conflict-safe writes.** Writes carry the settings revision and retry once on `SETTINGS_CONFLICT` (`writer.ts`).

## Install

Requires Node ≥ 22.19 and a dsh profile. Install as a dsh plugin:

```bash
npm i @aiwayds/dsh-model-sync
dsh plugin add @aiwayds/dsh-model-sync
```

The package ships `cordis.patch.yml` (wired as `dsh.bundle.patch`), which mounts the plugin into the profile's assembly tree under the stable plugin id `dsh-model-sync` and registers the `model-sync` settings namespace.

This plugin ships standalone — install it explicitly with `dsh plugin add @aiwayds/dsh-model-sync` when you want it.

## Usage

Configure the plugin under the `model-sync` namespace in `settings.yaml` — every key is optional:

| Key | Default | Description |
|---|---|---|
| `writeMode` | `'settings'` | Zero-patch pipeline; `'overlay'` for the legacy patched-adapter mode |
| `intervalMinutes` | `240 (4h)` | Auto-refresh interval in minutes; `0` = startup-only |
| `startupDelaySeconds` | `5` | Delay before the first auto refresh, so the llm adapter is ready |
| `refreshTimeoutMs` | `120000` | Abort budget for one refresh round's network request (min `1000`) |
| `managedRoutes` | `[]` | Routes to sync; empty = the default pi.dev routes |
| `keepBuiltinOnly` | `true` | Keep built-in-only models not present on pi.dev (smooth migration) |
| `dropUnserviceable` | `true` | Drop unserviceable entries; `false` aborts the route instead |
| `syncNotify` | `false` | Notify on changes (logger + `/model-sync` report) |
| `forceMaxReasoningEffort` | `false` | Force max reasoning effort on models with a non-empty `thinkingFormat` |

Example:

```yaml
model-sync:
  writeMode: settings
  intervalMinutes: 30
  managedRoutes:
    - opencode-go
    - zai-coding-cn
```

The plugin writes to the `llm-pi-ai` namespace (`providers.<route>.models`) — the same document the adapter consumes — and only for the routes it manages. During migration, `keepBuiltinOnly` preserves models that exist in your installed built-in catalog but aren't on pi.dev yet.

### Capacity values are upper limits, not your runtime settings

Synced `contextWindow` / `maxTokens` describe what the **model** accepts at most, as advertised by the gateway listing — not what your deployment is configured for. dsh resolves the settings-written value over the installed catalog, and a written `maxTokens` becomes the request-level default. Pointing a route at a local or proxied endpoint that serves a smaller context (vLLM / Ollama and friends) while carrying catalog-sized capacities is a known recipe for the "output token limit reached" family of failures.

If you need a model to run under a smaller budget, set it in `modelOverrides` under the same route — the sync folds the fields into the synced list and re-applies them from its store every round:

```yaml
providers:
  zai-coding-cn:
    modelOverrides:
      glm-5.3:
        contextWindow: 32768
```

Note that listing data itself can be noisy: values are sanity-gated (positive integers; `maxTokens` strictly below `contextWindow`), and stripped values show up in the sync report as `DEGRADED` lines with reasons.

### Manual refresh: the `/model-sync` command

Type `/model-sync` in any interactive UI to force one sync round on the spot. The plugin registers the command in the shared command registry (`@deepseek-ai/dsh-commands`), and UIs discover it automatically. It returns the same report the scheduled rounds log. The sync scope is decided by `managedRoutes`; any arguments typed after the command are ignored. Hosts without a command registry degrade gracefully — the scheduled rounds and the `modelSync` service keep working.

## Development

```bash
npm run build   # tsc → lib/
npm run check   # tsc --noEmit typecheck
npm test        # node --test (pretest builds): diff / translate / writer / remote-catalog / serviceability / command
```

Tests use per-route pi.dev fixtures under `test/fixtures/` and temp directories for the models store — they never touch the real `~/.dsh`.

Utility scripts under `scripts/`:

- `generate-builtin-snapshot.mjs` — regenerate `src/builtin-catalog-snapshot.ts` from the installed `@deepseek-ai/dsh-llm-pi-ai` catalog (`--generate` for dev, `--check` for CI).
- `verify-no-patch.mjs` — exits non-zero if any installed `dsh-llm-pi-ai` still carries the overlay patch signatures (`withRemoteCatalog` / `piAiCatalog`).
- `backup/backup-patched.mjs` — back up a patched `dsh-llm-pi-ai/lib/index.js` to `backups/`.
- `backup/restore-official.mjs` — restore the official unpatched `dsh-llm-pi-ai/lib/index.js` from npm, validated against the patch (`--dry-run` supported).

The repo also carries the reference patches that document the legacy overlay behavior: `docs-dsh-llm-pi-ai.patch` (pi.dev remote-catalog overlay for `dsh-llm-pi-ai`) and `docs-dsh-llm-pi-ai-compat.patch` (`supportsDeveloperRole` compat passthrough).

## License

MIT.

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Concurrent sync rounds can no longer wipe folded overrides.** `fetchRemoteCatalog` captured the route's pre-fetch snapshot (`stored = await store.read(route)`) and re-attached `overrides: stored?.overrides` into every write path (200 / 304 / 404 / 501 / 503), so an overlapping round whose `persistOverridesToStore` ran between the snapshot read and the write-back was clobbered on the fetch side — the v0.1.5 data-loss shape returning through a new door. The four write paths now call `effectiveStore.update(route, patch)` instead of `write(route, entry)`: the accessor's queue-internal read-modify-write re-reads the route's current entry inside the queue, so the patch only overrides the fields it names and `overrides` (plus any future out-of-band field) survives by construction. The pre-fetch `stored` snapshot stays in scope only for conditional checks (304 ETag match, 4h throttle) and to seed the fall-back models/lastModified/etag values on error paths — it never participates in the write payload. `persistOverridesToStore` similarly moves its read-modify-write into the queue via `updateOverrides(route, overrides)`, so the writer's stage and the fetch's update serialize cleanly and the merge is always based on the latest on-disk state. The `store.read()` path stays strict (corrupt / permission-denied files still surface as errors so the writer can fail closed); only the queue-internal merges tolerate the failure (and rely on the atomic `writeDoc` to heal the corruption on the next successful write).
- **B1: the models-store accessor now seeds every persisted entry to a well-formed shape (no more `{overrides}-only` survivors).** The earlier queue-internal merges used a `{ ...current, ...patch }` spread; an `updateOverrides` stage on an ENOENT / corrupt doc produced an entry of `{overrides: ...}` only — no `models`, no `checkedAt`. The next round's `fetchRemoteCatalog` (when `force=false`) then crashed with a `TypeError` reading `stored.models.length`, the whole sync went unhandled-rejection, and every route after the bad one stopped syncing. v0.2.2 had a fallback path that swallowed the read failure and never saw this; the regression came from the v0.2.3 surface. `update` and `updateOverrides` now use a field-level seed: `models = patch.models ?? current.models ?? []`, `checkedAt = patch.checkedAt ?? current.checkedAt ?? Date.now()`, `lastModified = patch.lastModified ?? current.lastModified ?? 0`, `etag = patch.etag ?? current.etag`, `overrides = patch.overrides ?? current.overrides`. Every persisted entry has the unconditional shape `{ models: RemoteCatalogEntry[], checkedAt: number, lastModified: number, etag?, overrides? }`, so a subsequent read never sees an incomplete shape and the next round's `fetchRemoteCatalog` cannot crash on `stored.models.length`. The seed also never overwrites a value current already holds — a stale pre-fetch snapshot can no longer clobber an out-of-band stage because the patch only writes fields the call site intends to write. `etag: undefined` is still omitted by `JSON.stringify`; the seed falls through to current when the patch leaves a field unset (so 404 / 501 paths now preserve the cached etag instead of clearing it — the next round's conditional request still uses it, harmless if the resource stays gone, useful if it comes back).
- **N1: 304 path patch is now exactly `{ checkedAt }`.** Re-naming `models` / `lastModified` / `etag` on a 304 was unnecessary (304 means "body unchanged" — those fields didn't change), and re-stating them in the patch opened a window for a clobber if a concurrent round had staged one of those fields between the snapshot read and the write-back. The 304 path now passes just `{ checkedAt }`; the seed preserves everything else from the route's current entry.
- **N2: defensive optional chaining on the throttle check.** `stored.models.length` is now `stored.models?.length ?? 0` — the field-level seed always populates `models: []` at minimum, so a missing field here means a legacy entry written before the seed landed; treat it as "no cached entries" rather than crashing.

- **Managed routes with user `modelOverrides` sync again** (the "rejected by settings validation (see log)" incident). The writer folded overrides into the written models but left the `modelOverrides` key in settings — and the dsh llm-pi-ai validation refuses a models list beside non-empty modelOverrides, so every mutate for such routes (notably minimax-cn / xiaomi-token-plan-cn) was rejected atomically and nothing ever landed. The writer now unsets the key in the same mutate as the models write (set+unset apply atomically, so the validation sees models-present + overrides-absent), and — so the v0.1.5 data-loss bug stays dead — stages the raw overrides in `~/.dsh/models-store.json` before the mutate (store-first, so settings is the authoritative source in every failure window: a failed store write skips the mutate entirely and reports `skipped (models-store write failed; settings untouched)`, while a rejected mutate leaves the key in place, where it always wins over the staged copy) and replays them into the target on every later round. Settings overrides win over stored ones (a re-added key is the user's latest intent); routes without overrides take exactly the old code path. Override ids with no matching model in the target are reported on the sync line and kept in the store (they apply again if the id shows up in a later catalog). The report line names the action: `minimax-cn: wrote 25 models (folded user modelOverrides, unset the key)`. Downgrading below 0.2.2 discards folded override values on the next sync under the older version.

- **The builtin catalog snapshot can no longer rot against the host.** `keepBuiltinOnly` emitted ids from a build-time snapshot frozen at 2026-08-28; when pi-ai 0.84.4 removed grok-4.5 from its opencode-go catalog, the 09-01 host upgrade turned the stored bare entry into a dead id that the alpha line's strict llm-pi-ai registration rejects — taking every provider route down with it (the "all providers vanished" incident). `getBuiltinCatalogForRoute` now prefers the host's live pi-ai catalog (discovered via `DSH_CLOSURE_DIR` → `which dsh` → `npm root -g`, mirroring the linker scripts) and falls back to the snapshot only per-route when the host cannot be located. The snapshot itself was regenerated against 0.1.2-alpha.4 (grok-4.5 out, grok-4.6 and the 08-31 pi.dev additions in).

- **Corrupt `~/.dsh/models-store.json` no longer silently clobbers folded overrides.** The store accessor used to swallow every read error (including `SyntaxError` on a half-written file, `EACCES` on a permission-locked store, and `EIO` on storage failure) and return `{}` as if the file did not exist; the writer would then see no stored overrides, accept the raw pi.dev target as the merged view, and overwrite `settings.models` — losing the user's folded `contextWindow` / `reasoningEfforts` / `think` fields on the very next refresh. The store's read path now distinguishes `ENOENT` (a normal first run) from every other failure (which propagate), and the writer short-circuits to reason `store-unavailable` (skip + log + leave `settings.models` untouched) when the read fails AND settings carries no overrides key — `settings.models` is the authoritative fallback in that window. When settings DOES carry the key, settings-wins still proceeds and the new atomic `writeDoc` (tmp + `rename(2)`) heals the corruption on disk as a side effect.

### Changed

- CI and release workflows gate on `generate-builtin-snapshot.mjs --check`: a snapshot drifted from the live host catalog now fails the build instead of shipping dead entries.
- The generator script's hardcoded `~/github/dsh-model-sync` project root and `/opt/homebrew/...` pi-ai path are replaced with the same discovery trio — it had never actually run on this machine.

### Test

- Behavior tests (base-less drop, maxTokens keep, keepBuiltinOnly preservation, api-divergent warning) no longer anchor on snapshot membership: they force the precondition via inline builtin data, so catalog drift cannot flip them. New `live-catalog.test.mjs` covers override priority, per-route fallback, and bogus-override fall-through.

## [0.1.6] - 2026-08-31

### Fixed

- **User `modelOverrides` are now durable.** The writer used to fold overrides into the models list and then `unset` the overrides key; the next round regenerated the target from pi.dev, found the stored models different, and silently clobbered the folded fields (think levels, narrowed context windows) after exactly one round. The overrides key is now never written or deleted: each write is target ⊕ overrides, change detection compares against that merged view, and overrides for ids outside the target stay untouched user data instead of being dropped with the key.

### Changed

- `writeMode` now defaults to `settings` (the zero-patch pipeline); `overlay` remains available for the legacy patched-adapter flow.
- Capacity sanity gate (deviation from design doc §3.3 rules 3/5): settings-written capacities override the installed catalog at resolution, and a written `maxTokens` becomes the request-level `defaultMaxTokens` — so listing garbage would trip the "output token limit" family (upstream #1166). A non-positive-integer `contextWindow`/`maxTokens`, or a `maxTokens` not strictly below the context window (listing echoes, e.g. grok-4.6 at 500000/500000), is now skipped with a `DEGRADED` report line instead of written.

### Docs

- README (EN + zh): standalone-distribution statement (the bundled-in-dsh-tui-pi claim is stale), config table aligned with the new defaults, new "Capacity values are upper limits" section with the `modelOverrides` escape hatch.

## [0.1.5] - 2026-08-29

### Added

- npm `keywords`: `dsh-plugin` (joins the existing `dsh`) and GitHub repo topics `dsh`, `dsh-plugin`, for dsh / dsh-plugin discovery.

### Docs

- Embed a 1.5×-speed `/model-sync` session recording in the README (Demos issue #1), English + 简体中文.

## [0.1.4] - 2026-08-29

### Fixed

- Register the `/model-sync` command through a `ctx.inject(['commands'], ...)` sub-fiber instead of reading `ctx.commands` inside `apply`. cordis 4 rejects foreign-service property access without a declared inject (`cannot get property "commands" without inject`), so loading the 0.1.3 plugin tree **crashed every dsh boot**. The sub-fiber stays dormant until the host provides the `commands` service, preserving the optional-peer design: hosts without dsh-commands keep auto-sync, and registration fires whenever the registry appears.

## [0.1.3] - 2026-08-28

### Changed

- Default auto-refresh interval `intervalMinutes` 60 → **240 (4h)**. Explicitly configured values are unaffected.
- The `/model-sync` command is registered by the plugin itself through dsh's shared command registry (`@deepseek-ai/dsh-commands`, optional peer) — interactive UIs discover it automatically. (Superseded by the 0.1.4 fix: the original `ctx.commands` read crashed dsh boot.)

### Added

- Standalone Simplified Chinese README (`README.zh-CN.md`).

## [0.1.2] - 2026-08-28

- First tagged release.

[Unreleased]: https://github.com/fan56/dsh-model-sync/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/fan56/dsh-model-sync/releases/tag/v0.1.5
[0.1.4]: https://github.com/fan56/dsh-model-sync/releases/tag/v0.1.4
[0.1.3]: https://github.com/fan56/dsh-model-sync/releases/tag/v0.1.3
[0.1.2]: https://github.com/fan56/dsh-model-sync/releases/tag/v0.1.2

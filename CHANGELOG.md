# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

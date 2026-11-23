# 43 — N1/N2 可观测性修复实现报告

日期：2026-11-23。
分支：`feat/opencode-go-sync`，基线 HEAD `5f23dba`。
范围：仅修复 39 号复核报告 §9 的 N1、N2 两条 P3 可观测性问题。复核另派，本报告只记录实现事实。

## 1. N1 — go 命令无身份时返回 error kind

| 文件:行号 | 改动 |
|---|---|
| `src/index.ts:1349-1362` | `/model-sync go|status|adopt|eject` 命令的 `kind` 判定由 `outcome.reason === 'source-failed' ? 'error' : 'success'` 改为 `reason === 'source-failed' || reason === 'scheduler-error'` → `error`。使用既有 `CommandResult.kind` 枚举（`success`/`error`），未新增枚举值。跳过的 round（disabled / already-in-flight / migration-applying / disposed）仍为 `success`，输出文本不变。 |

成因链：无身份时 `runGoRound` 构造 `ownershipStoreForRound()` 抛 `PROFILE_IDENTITY_REQUIRED_MESSAGE` → `GoScheduler.fire()` 捕获为 `reason:'scheduler-error'` → 命令此前映射为 `success`。身份错误本身一直在 `outcome.text` 中暴露（`"opencode-go scheduler: round error — <身份错误>; kept last-good, no further settings write"`），本次让只看 `kind` 的自动化消费者也能判定失败。

## 2. N2 — 非严格刷新/状态输出可见地暴露身份错误

| 文件:行号 | 改动 |
|---|---|
| `src/opencode-go-profile.ts:71-82` | 新增导出常量 `PROFILE_IDENTITY_STATUS_HINT`：紧凑、可执行的状态提示，含「身份不可用 → 迁移记录与账本已 fail-closed」与修复路径。 |
| `src/opencode-go-migration.ts:89-96` | `MigrationStatus` 新增可选字段 `identityUnavailable?: boolean`。仅标记「文件型 store 因身份缺失被拒建」这一事实；不改既有状态机。 |
| `src/index.ts:94-97` | 导入 `PROFILE_IDENTITY_STATUS_HINT`。 |
| `src/index.ts:513-524, 538-541` | `loadMigrationStatus()` 在 store / ownership 构造的 catch 中，仅当抛出的错误正是 `PROFILE_IDENTITY_REQUIRED_MESSAGE` 时置 `identityUnavailable=true`。**不**用 `profileKey === undefined` 单独判定，避免注入 store 的宿主（无宿主身份但账本可用）误报。 |
| `src/index.ts:554-562` | 非严格读在身份缺失时：`status.identityUnavailable = true`，并 `ctx.logger.warn('model-sync: non-strict status refresh degraded — %s', PROFILE_IDENTITY_REQUIRED_MESSAGE)`。覆盖 boot / `settings/document-updated` 等只有日志、没有报告行的后台刷新点。 |
| `src/index.ts:684-696` | `syncSettings()` 的单写者 gate skip 行：`identityUnavailable===true` 时用 `PROFILE_IDENTITY_STATUS_HINT` 取代通用 `MIGRATION_GATE_HINT`，不再伪装成正常 legacy 状态。 |

fail-closed 行为未改：gate 仍关闭、零 store 读写、零 settings mutate、无新写入；新增的只有日志与返回状态上的标记字段。显式 `migrate status` 路径（`migrateDeps` 抛错 → `runMigrate` catch → `kind:'error'`）完全未动。

## 3. 用户可见文案示例

无身份时 bare `/model-sync` 的状态行（取自真实命令路径）：

```
opencode-go: skipped — skipped-route-owner: go (single-writer: opencode.go.enabled=true; legacy pi.dev path must never write opencode-go* routes); profile 身份不可用 → opencode-go 迁移记录与账本已 fail-closed（未读未写，同步已跳过）; 修复：在 dsh profile 内启动插件，或向 ctx.launchEnvironment 暴露 DSH_PROFILE / DSH_PROFILE_DIR
```

后台刷新（无报告行）新增的 warn：

```
model-sync: non-strict status refresh degraded — model-sync: cannot resolve the dsh profile identity for the opencode-go migration/ownership ledger. Refusing to share a single key across profiles: without a stable per-profile key another profile could inherit this migration state. Fix: launch the plugin inside a dsh profile so ctx.profileContext.name (or ctx.profileContext.dir) is available, or expose the launcher-provided DSH_PROFILE / DSH_PROFILE_DIR values through ctx.launchEnvironment. No migration record or ledger key was read or written.
```

无身份时 `/model-sync go`：`kind:'error'`，文本含 `opencode-go scheduler: round error — model-sync: cannot resolve the dsh profile identity …; kept last-good, no further settings write`。

## 4. 测试

`test/opencode-go-profile-identity.test.mjs`（新增 3 条，均走真实命令 handler + 真实文件型 store，scratch HOME，不写真实 `~/.dsh`）：

- N1（:377）：无身份 `go` → `kind==='error'`；文本含身份错误与修复指引；`fetch=0`、`mutations=0`、store/settings 字节不变。
- N2（:404）：无身份 bare `/model-sync` → 报告含「profile 身份不可用 / fail-closed / DSH_PROFILE」且不含旧 legacy 提示；日志含后台刷新降级告警；显式 `migrate status` 仍 `kind==='error'`；零写、字节不变。
- N2 反误报与回归（:441）：有身份时无身份提示、旧 legacy 提示保留、无降级告警；apply 后 `go` 仍 `kind==='success'` 且 `fetch>0`、`mutations>0`。

测试夹具改动：`:112/:148-151/:164` 的 `makeInstance` 记录 `logs`（此前 logger 为空实现），不改任何断言。未放宽既有断言。

门槛结果：

- `npm run check`：exit 0（`tsc --noEmit`）。
- `npm test`：exit 0，25 个测试文件，**42/42 pass，0 fail**（含 pretest `tsc` 重建 `lib/`）。

## 5. 残余风险

- **R1（行为变化范围）**：N1 把所有 `scheduler-error` 映射为 `error`，不只身份缺失。其它非 source-failed 的 round 抛错（如 fetch 实现异常）也会从 `success` 变为 `error`。这与 39 号报告的建议一致，语义更准确，但仍是可见的 kind 变化；已由回归测试确认有身份的正常 round 不受影响。
- **R2（注入 store 缝）**：注入型 store 宿主即使无宿主身份也不显示身份提示（视为账本可用，属显式 opt-in）。若宿主注入了不可用/失败的 store 却未抛身份错误，则不触发本提示；这是 opt-in 契约的既有边界，本次未扩大。
- **R3（重复日志）**：无身份 `go` 路径会同时产生一条 `non-strict status refresh degraded` warn 与 scheduler report info。不影响行为，仅在排障日志中多一行。
- **R4（未覆盖）**：未做真机 launcher 验证（U1/U2 仍是 39 号报告标注的离线 harness 固有限制）；本次修复只针对离线可复现的两条可观测性问题。
- 不包含任何密钥值。

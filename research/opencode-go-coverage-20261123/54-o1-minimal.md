# 54 — O1 如实报告最小集（P2）

分支 `feat/opencode-go-sync`，基线 HEAD `32b386b`。执行范围严格限于 O1 评审（`53-o1-write-order-review.md`）的「准出前最小集」：
**不改 settings 写序、不做 settings 回滚、不做写前日志（C2）**。结构性修复另派。

本轮只做四件事：如实报告、原因透传、一个身份字段归属修正、固化测试。

---

## 1. 逐条改动（文件:行号）

| # | 要求 | 改动位置 | 内容 |
|---|---|---|---|
| 1 | 新如实报告 code/原因 | `src/opencode-go-writer.ts:48-53`（`UNACCOUNTED_CODE` / `UNACCOUNTED_ADVICE` / `RECORD_ADVICE`）、`:250-270`（`recordLockTimeout` 增 `settingsLanded`）、`:305-337`（`recordOwnWrite`）、`:809`（`failedRoutes.reason`）、`:838-872`（`persistLedger` 增 `settingsLanded`） | 新增 code `settings-written-unaccounted`。settings 已写而账本失败（锁或非锁）时：路由进 `failedRoutes`，报告明确「settings were written but the ownership ledger was not updated; the next round will keep this route as user-owned (no refresh, no deletion); re-claim it with `/model-sync adopt go`」。迁移记录失败时同 code，文案说明「gate may close; re-claim with `/model-sync adopt go`」。原锁错误 detail（锁路径、Retry/检查其他进程）仍逐字保留用于诊断。 |
| 2 | 命令 kind | `src/opencode-go-sync.ts:93`（`GoRoundReason` 增 `'write-failed'`）、`:410-417`（`hasFailedRoutes` → reason/ok）、`src/index.ts:1343-1347` | 含 `failedRoutes` 的轮返回 `reason:'write-failed'`，命令层映射 `kind:'error'`。不触发退避（`isBackoffFailure` 只认 `source-failed`/`failureKind`）。 |
| 3 | 原因透传 | `src/opencode-go-sync.ts:355-364`（`canWrite` 透传 `routeWriter(...).reason`）；`src/opencode-go-writer.ts:256-271`（`skipByCanWrite` 用透传 reason） | 二次闸 skip 不再一律写 `route-authority`，而是带真实 `skipped-route-owner: none (migration gate: legacy-inline; …)` 等决策原因。 |
| 4 | N1 abandon 如实 | `src/opencode-go-writer.ts:151-156`（`settingsLandedRoutes` 字段）、`:362-386`（`abandonForSettingsChange` 逐路由列出已写/丢弃）、`src/opencode-go-sync.ts:172-195`（`writerSettingsChangedResult` 接收 write，输出已写/丢弃清单） | 同轮已有 mutate 落地时，报告改为 `already written: [A]; discarded (no settings write): [B, C]`，不再声称 `zero settings writes`。零写入场景文案保持字节不变。 |
| 5 | planner 文本 | `src/opencode-go-writer.ts:480`（`unaccounted` 集合）、`:827-833`（过滤 `added` 行） | 被 skip/failed 或「已写但未入账」的路由，其 planner `added` 行被抑制，不再误导用户以为模型已被认领。 |
| 6 | displayName 归属 | `src/opencode-go-writer.ts:38-42`（`OWNED_FIELDS` 移除 `displayName`） | writer 写集合现为 `['api','baseURL','apiKeyEnv']`，与 planner `OWNERSHIP_FIELDS`/`detectConflict`（`opencode-go-planner.ts:289`）一致。显示名变化不再触发身份字段改写。 |
| 7 | apply 文案 | `src/opencode-go-migrate.ts:1081-1089`（`applyFailure(..., writesReverted)`）、`:1302` | 写入后字节还原的失败不再说 `zero writes`，改说 `settings writes were rolled back to the pre-apply snapshot (bytes restored; no net change)`。写入前拒绝仍说 `zero writes`。 |

### 设计取舍说明（第 6 条）
评审允许「移出 writer `OWNED_FIELDS`」或「加入 `detectConflict`」二选一，不能两边不一致。选**移出**：
- `detectConflict`（planner `OWNERSHIP_FIELDS = ['api','baseURL','apiKeyEnv']`）从不查 `displayName`，说明显示名不是写权限判定字段；writer 却在 `buildRouteOps` 里写它，正是「两边不一致」。
- `opencode-go-migration.ts:223` 的 `IDENTITY_FIELDS` 含 `displayName`，用于**身份指纹**（显示名变化应关闭迁移门，属安全设计），与「writer 是否可写该字段」是不同语义；本次不动身份指纹，避免放宽门控。

---

## 2. S1/S2/S3 文案前后对比

| 场景 | 修复前（评审实测口径） | 修复后（本轮实测） |
|---|---|---|
| **S1** absent 首轮 + 账本锁失败 | `chat: failed (store-lock-timeout)`；`[error] store-lock-timeout … The store was NOT modified. Retry the operation…`；msg/resp `skipped (route-authority)`；命令 `kind:'error'`（锁路径） | `chat: failed (settings-written-unaccounted)`；`[error] settings-written-unaccounted … hit a store lock timeout after settings were written: …the next round will keep this route as user-owned…; re-claim it with /model-sync adopt go`；命令 `kind:'error'`。记录失败（非锁）同 code 但 kind 仍 `success`（fingerprint-healed，不进 failedRoutes）。下轮 skip 带上真实 `migration gate: legacy-inline` 原因。 |
| **S1b** 首轮 + 迁移记录失败 | 完全静默（仅 logger.warn），报告/code 均无；命令 `kind:'success'` | `[warn] settings-written-unaccounted …migration record could not be persisted; the next round may treat this route as un-migrated and close the gate; re-claim it with /model-sync adopt go`；kind 不变。 |
| **S2** 已迁移 + 新增 + 账本失败 | `[info] added … new-model`（误导：实际未入账）；非锁账本失败只报 `ledger-write-failed`（warn），命令 `kind:'success'` | `added` 行被移除；`[error] settings-written-unaccounted … user-owned … adopt go`；`failedRoutes` 含该路由 → 命令 `kind:'error'`。下一轮仍 `kept-user-owned`（行为不变，结构性修复另派），但现在当轮有如实原因。 |
| **S3** 刷新托管 + 账本失败 | `[warn] ledger-write-failed … written but ownership ledger could not be persisted`；命令 `kind:'success'`；下轮判「用户改过」，rollback `hash-mismatch` 无引导 | `[error] settings-written-unaccounted … adopt go`；命令 `kind:'error'`；rollback 仍拒 `hash-mismatch`（未做回滚/写序修复），但当轮失败已如实可见。 |
| **S7** 已写后 N1 abandon | `user edits were kept as-is: no settings write, no ownership ledger change, no fingerprint update` | `already written this round: [opencode-go]; discarded with no settings write: [opencode-go-msg, opencode-go-resp]; no ownership ledger/fingerprint update for the discarded routes` |
| **S8a** apply 写入后还原 | `migrate apply refused (write-failed): <detail>; zero writes` | `migrate apply refused (write-failed): <detail>; settings writes were rolled back to the pre-apply snapshot (bytes restored; no net change)` |

---

## 3. 测试清单与输出摘要

门槛：`npm run check` exit 0；`npm test` exit 0，`tests 54 / pass 54 / fail 0`（含 pretest tsc）。

固化策略：先记录 4 个历史断言因语义变更转红（`write: 3 routes set all five fields`、`N2 lock timeout on ledger commit`、`N2 non-lock ledger error`、`N4 plain-object lock error`），随后**只更新与语义变更直接相关的断言并保留原意图**（锁路径/诊断文案不丢、`displayName` 由「写入」改为「不写」并有显式注释），未删除任何测试换绿。

| 用例 | 位置 | 覆盖 |
|---|---|---|
| S1 命令面 | `test/opencode-go-round.test.mjs:561` | 账本写失败 → `kind:'error'` + 新 code + settings 确实落地 + adopt 提示 |
| S1b 记录面 | `test/opencode-go-round.test.mjs:574` | 迁移记录写失败 → 新 code 可见、kind 仍 success |
| S1 门 | `test/opencode-go-round.test.mjs:584` | 无记录 → `reason:'migration-gate'`、零写入 |
| K1 | `test/opencode-go-round.test.mjs:592` | **用失败 store seam 模拟 mutate 后账本前中断（未真 SIGKILL）** → 3 条 failedRoutes 新 code；下一轮 `kept-user-owned`、不删 |
| S2 | `test/opencode-go-round.test.mjs:613` | 已迁移 + 新增 + 账本失败 → 无 `added` 行 + 新 code；下架不删 |
| S3 | `test/opencode-go-migrate.test.mjs:789` | 刷新 + 账本失败 → rollback `hash-mismatch`，健康对照成功 |
| S4a/S4b | `test/opencode-go-round.test.mjs:659` | 两轮确认删除自愈；路由不被 unset（无残留误删） |
| S7 | `test/opencode-go-writer.test.mjs:1206`、`test/opencode-go-round.test.mjs:637` | writer report 与命令 text 均列出已写/丢弃，无 `zero settings writes` |
| S8a/S8c | `test/opencode-go-migrate.test.mjs:838`、`:860` | apply 失败后字节级还原 + 如实文案；卡 `applying` 可恢复 |
| 锁超时形态 | `test/opencode-go-writer.test.mjs:1055`（账本写锁超时 → 新 code，保留 detail）、`:1103`（非锁账本写失败 → 新 code，不误报锁）；账本**读**锁超时仍 `store-lock-timeout`（`:1078` 既有测试） |
| 原因透传 | `test/opencode-go-writer.test.mjs:1193`、`test/opencode-go-round.test.mjs:682` | writer 层与 sync 层均断言真实 reason，且 `!== route-authority` |
| displayName | `test/opencode-go-writer.test.mjs:1154`（显示名漂移 → no-change、身份字段不改写）、`:210`（首轮写入不含 displayName） |
| 记录失败可见 | `test/opencode-go-writer.test.mjs:1235` | 迁移记录失败不静默、不进 failedRoutes |

结果：`writer 46/46`、`round 21/21`、`migrate 26/26`，全套 `54/54`。

---

## 4. 发布说明需写的已知限制

1. **账本/记录写失败时，settings 领先账本**：该路由下轮按 user-owned 保留（不刷新、下架不删），迁移门可能关闭为 `legacy-inline`；用户需执行 `/model-sync adopt go` 重新认领。本轮只让这件事**如实可见**，未消除其后果。
2. **S3 场景 rollback 仍可能被 `hash-mismatch` 拒绝**：adopt 后可恢复；这不是本轮修复范围。
3. **「锁超时 = 零写入」不是无条件保证**：跨进程锁不保护 `settings.mutate`；账本**写**争用可出现「settings 已写、账本未写」。新 code 即为此形态设计，不要把它当普通锁失败重试。
4. **`displayName` 不再由 go 同步写入**：用户自定义显示名保留；显示名变化会改变迁移身份指纹并关闭写入门（安全设计），需 `migrate plan/apply` 重新确认。

---

## 5. 残余风险

- **N1 残留窗口（`src/opencode-go-writer.ts:712-720`，原评审 662-665）**：writer 在 mutate 成功后 re-read descriptor 更新 rolling baseline；re-read 与下一路由 freshness check 之间仍存在极窄窗口。本最小集未改写序，窗口保留。
- **fingerprint-healed 噪声**：为如实报告 S1b，`recordOwnWrite` 的非锁失败新增 `warn` 级 `settings-written-unaccounted`（此前仅 logger.warn）。健康轮自愈后该行不会自动回收，报告中会多出一条 warn；这是有意的如实告知，不是失败路由，也不影响 kind。
- **锁 detail 与错误文案并列**：新 message 保留原始 `The store was NOT modified. Retry the operation` 作为诊断 detail，同时给出 truthful advice。用户若只读前半句仍可能误判；code 与后半句是正确的机器/人工信号。
- **结构性修复未做**：写前日志（C2）、settings 回滚、账本领先 settings 的原子化都未实施；S1/S2/S3 的**行为后果**依旧存在，只解决「报告失真」。
- **K1 未真 SIGKILL**：用失败 store seam 模拟中断点，未验证真实子进程被杀后的锁文件/进程语义。

## 6. 边界

未改主树 `/Users/qingguee/repo/dsh-model-sync`、未改其他 worktree、未写真实 `~/.dsh`、未 push、未运行真实 migration apply 到用户 profile。commit 使用显式路径 `git add`。

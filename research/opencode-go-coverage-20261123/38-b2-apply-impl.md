# 38 — B2 apply 执行器 / ack 接线 / B6 入账实现报告

- 分支：`feat/opencode-go-sync`，基线 HEAD `47c0fe8`
- 输入：`b2-wip-uncommitted.patch`（397 行，已先原样 apply，再逐条修复）
- 范围：计划侧动作表 + apply 逐项执行 + ack 接线 + 分类数据源 + B6 账本
- 验证：独立复核 agent 尚未执行；本报告为实现方自述

## 1. 逐条改动（文件:行号）

### 1.1 计划侧

| 改动 | 位置 |
|---|---|
| 新增 `MigrationIdPlan`（逐 id 动作行）：`op/route/to/kind/pinned/profile/before/managed/reason`，整表进入 hashed body | `src/opencode-go-migrate.ts:105-118`、`:159-164` |
| 10 个必填字段编译错误修复：12 处 `idActions.push` 全部带 `pinned`（9 处非 pinned 补 `pinned:false`），`MigrateApplyReason` 增加 `ack-required` | `src/opencode-go-migrate.ts:455-533`、`:964-975` |
| `unclassified` 分类（公开清单拿不到时 fail-closed，永不删除） | `src/opencode-go-migrate.ts:73`、`:431-440`、`:528-535`、`:634` |
| pinned「两边都放」：旧路由 `keep`，目标路由缺则额外 `add`（重复显示允许） | `src/opencode-go-migrate.ts:455-474` |
| update = 不覆盖：`update` 行带 `before`（现值）与官方 `profile` 供 before/after 打印，`managed` 不置位 | `src/opencode-go-migrate.ts:499-505` |
| `user-extra` 仅 `--prune-user-extra` 删；`unknown-retired` 仅 `--adopt` 删；`unclassified` 永不删 | `src/opencode-go-migrate.ts:525-536` |
| `deletions` 只由 `op==='delete'` 生成，`move` 不再当删除上报；`movedIds` 单独从 move 行取 | `src/opencode-go-migrate.ts:543-555`、`:1147-1148` |
| 共享 `managedIdsForRoute`：B6 知情文本与账本 `managed` 同源 | `src/opencode-go-migrate.ts:254-262`、`:591-594` |
| plan 输出：mode 含 `adopt-disabled`、公开清单可用性声明、每行 `why:` 理由与 before→after、标题改为「apply consumes this table verbatim; keep/update/pin are non-destructive」、apply 提示带 `--ack-managed` | `src/opencode-go-migrate.ts:669-676`、`:698-708`、`:719` |
| `buildMigrationPlanFromDeps` 导出为 plan/apply 唯一构造路径 | `src/opencode-go-migrate.ts:768-784`、`src/index.ts:1126` |

### 1.2 数据源与旗标接线

| 改动 | 位置 |
|---|---|
| `fetchGoPublicCatalogIds`：无鉴权公开清单，只用于分类（C2 不作为可服务源），失败返回 `{ok:false}` | `src/opencode-go-source.ts:70-74`、`:291-334` |
| `GO_MIGRATION_PUBLIC_CATALOG_SERVICE` / `GO_MIGRATION_ADOPT_DISABLED_SERVICE` 注入缝 | `src/index.ts:131-134` |
| `resolvePublicCatalogIds`：注入优先；fixture 模式从注入的 entries 派生（保证 plan 零 fetch）；否则无鉴权 fetch；取不到返回 `undefined` → 分类 fail-closed | `src/index.ts:1015-1029` |
| `pinnedModels` 经 `readGoRuntimeConfig` → `migrateDeps` → `buildMigrationPlanFromDeps` 进 plan | `src/index.ts:1069`、`src/opencode-go-migrate.ts:777` |
| `--prune-user-extra`、`--ack-managed` 解析；`--adopt` 能力关闭时命令层拒绝并标 `adopt-disabled`（零写入）；host service 同步透传 | `src/index.ts:1107-1108`、`:1130-1139`、`:1216`、`:1223` |
| `verifyConsent` 第三令牌 `ackManaged`，严格 `=== true` | `src/opencode-go-migrate.ts:275-288` |

### 1.3 apply 执行器与 B6 入账

| 改动 | 位置 |
|---|---|
| `buildRouteWriteStates`：把动作表翻译成每路由终态，逐行产出结果；无 `merged=[...desired]` 重推导 | `src/opencode-go-migrate.ts:824-940`、`:1056-1062` |
| 逐行语义：keep 不动、add 写入（已存在则不覆盖）、update 只提示不写不托管、move 删源加目标、delete 按表删、pinned 由 keep+add 实现 | `src/opencode-go-migrate.ts:884-936` |
| 账本 `managed` / `appliedAddedIds` 只取本 apply 实际写入/采纳的 id；`appliedManagedIds` 同源于账本 | `src/opencode-go-migrate.ts:1091-1100`、`:1128-1145` |
| `MigrateApplyResult.actions` 与 plan.idActions 逐行对应，apply 文本输出逐项结果 | `src/opencode-go-migrate.ts:977-993`、`:1180-1181` |

### 1.4 测试

| 改动 | 位置 |
|---|---|
| 新增 9 个行为断言用例（settings/账本/结果逐项校验，非调用断言） | `test/opencode-go-migrate-action-table.test.mjs:1-445` |
| 纳入 `npm test` 显式清单 | `package.json:37` |
| 既有 apply 用例补 `--ack-managed`；`verifyConsent` 增加 ack 三态断言；V20 用例按新语义改为 `--adopt --prune-user-extra` 才删用户自造 id | `test/opencode-go-migrate.test.mjs:252-269`、`:288-430` 等、`test/opencode-go-profile-isolation.test.mjs:213-270` |

## 2. 与设计/拍板的对应

| 要求 | 落地 |
|---|---|
| §14.2 / 31 B2「逐 id 动作表是 apply 唯一事实源」 | `idActions` 进 planHash；apply 只走 `buildRouteWriteStates`；全仓无 `merged=[...desired]` |
| §14.2 keep 不删、pinned 强制 keep | keep 行不改模型；pinned 行不 move/delete，且目标路由补 add |
| 用户拍板「pinned = 两边都放」 | `src/opencode-go-migrate.ts:455-474`，测试 3 断言两条路由都有该 id |
| 用户拍板「update = 不覆盖、不托管」 | `update` 行带 before/after、apply 返回 `skipped`、账本不 claim，测试 7 断言值未变且不在账本 |
| §14.2 user-extra / unknown-retired 分类与删除开关 | 分类先看公开清单可用性，`user-extra`→prune，`unknown-retired`→adopt，测试 4/5/6 |
| §14.2 清单拿不到 → fail-closed | `unclassified` 永不删，测试 5 |
| §14.2 `--adopt` 无法按表执行时命令层拒绝 | `adoptDisabled` 能力位，plan 标 adopt-disabled、apply 拒绝且零写入，测试 9 |
| §14.5 plan 输出必含项 | mode/指纹/逐路由/逐 id 理由/managed 提示/备份/planHash/confirm/rollback/未验证项；apply 提示带 `--ack-managed` |
| M-2 / V17 / B6 同意门 | planHash + 确认码 + `--ack-managed` 三令牌齐备才写入，测试 1 |
| B6 apply 写入入账本、知情文本一致 | `managedIdsForRoute` 同源驱动文本与账本，测试 7/8 |
| A4 / C4 | pinned 逃生口保留旧引用；update 与已存在值不覆盖，用户显式字段不被改写 |

`move` 语义经协调者确认按设计 §14.2：删源路由副本 + 目标路由写官方 profile；「两边都放」仅用于 pinned。

## 3. 测试清单与输出摘要

```
npm run check          → 0 错误（tsc --noEmit）
npm test               → tests 31 / pass 31 / fail 0（含 pretest tsc）
  test/opencode-go-migrate-action-table.test.mjs   9/9
  test/opencode-go-migrate.test.mjs                22/22
  test/opencode-go-profile-isolation.test.mjs      通过
  test/opencode-go-migration-gate.test.mjs         通过
  其余 27 个既有套件                                 全部通过
```

新增用例逐项：
1. ack 三态（未传/非 true → `ack-required` 零写入；true → applied），命令层与 apply 层都覆盖
2. adopt 下 plan 标 KEEP 的 pinned id 不被删除
3. 经 `opencode.go.pinnedModels` 配置路径 pin，旧路由与目标路由都含该 id
4. user-extra 默认保留，仅 `--prune-user-extra` 删除
5. 公开清单不可用（注入函数返回 undefined）→ `unclassified`，双删除开关下仍不删
6. unknown-retired（公开清单有、授权清单无）默认 keep，仅 `--adopt` 删
7. plan 每行与 settings 实际结果逐项一致；UPDATE 不改值、结果 `skipped`、不入账本；知情文本不列 drifted id
8. 保守 apply 的账本 `managed`/`appliedAddedIds`/迁移记录 `appliedManagedIds` 只含实际写入 id，user-extra 不托管
9. `adoptDisabled` 时 plan 标 adopt-disabled、`--adopt` 被命令层与 apply 层拒绝且零写入

## 4. 行为变化与用户影响

- `migrate apply` 新增强制 `--ack-managed`；旧脚本/文档中的 apply 命令会被 `ack-required` 拒绝（设计 M-2 要求，非回归）。plan 输出已打印完整命令。
- `--adopt` 单独使用不再删除用户自造 id；需要额外 `--prune-user-extra` 才会删除 plan 明确列出的 user-extra。unknown-retired 仍由 `--adopt` 删除。
- 用户改过的 desired id 现在在 plan 里显示 UPDATE/before→after，apply 保留现值且不再认领为托管；这些 id 后续不会随上游自动更新/下架。
- pinned 的 desired id 现在会同时出现在旧路由与目标路由（允许重复显示），旧引用不再断裂。
- 保守 apply 写入/采纳的 desired id 现在入账本：后续可按「加新、删下架」管理；之前这批模型是冻结的（B6 修复）。
- 公开清单拿不到时，非 desired id 一律 `unclassified` 且永不删除；plan 明确标注该状态。
- 新增能力位 `GO_MIGRATION_ADOPT_DISABLED_SERVICE`：置 true 时 `--adopt` 被拒（默认不影响）。

## 5. 残余风险

1. **公开公开清单的真实网络路径未上真机**：`fetchGoPublicCatalogIds` 只在离线注入 fixture 下测过；真实 401/403/超时返回 undefined → fail-closed 已覆盖，但 endpoint 实际响应形状未在本轮真机复核。
2. **`adoptDisabled` 是显式能力位而非法执行探测**：默认 false，因为执行器已实现；测试通过注入 true 验证兜底。若未来引入无法逐表执行的代码路径，必须同步置位，否则会失去 fail-closed。
3. **已应用路由的 `appliedManagedIds` 边界**：`plan.state==='applied'` 的整体 apply 被 `nothing-to-apply` 拒绝；仅当同一路由集里部分路由 applied、部分 drifted 时，未触碰路由的 `appliedManagedIds` 回退为 plan 推导值，可能与该路由既有账本不完全一致（不影响 settings 写入）。
4. **R-11（认领哈希错位）未单独修复**：本改动让更新过的 desired id 保持用户自有，从源头避免「认领后永远判 was modified」；但历史遗留的错误账本条目仍需清理，不在本次范围。
5. **B4（fetch 前计划、fetch 后 revision 写入）与多 profile 真机场景**仍属其他任务；本改动未触及。
6. `migrate apply` 的逐 id 结果文本目前只输出到命令返回文本，未写入账本持久化；审计主要依赖 plan 哈希 + 备份 + 账本快照。

报告不含任何密钥值；测试全部使用 fixture 与内存/临时存储。

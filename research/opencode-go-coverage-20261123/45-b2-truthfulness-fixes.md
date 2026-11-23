# 45 — B2/B6 真实性修复（N1–N4）

- 实现对象：`feat/opencode-go-sync`，基线 HEAD `15f6babd68fd5ccfb5e9d69bb39bc3e47f68ba10`
- 依据：`41-b2-verification.md` §4 N1–N4；设计 `07-design.md` §14.2 / §14.5；用户拍板（update 不覆盖、pinned 两边都放）
- 主工作区 `/Users/qingguee/repo/dsh-model-sync-wt-opencode-go`，仅改源码与测试（另写本报告）
- 未写真实 `~/.dsh`；未 push；未碰其它 worktree
- 本报告不含任何密钥值

## 1. 逐条改动（文件:行号）

### N1 成功计数谎报
- `src/opencode-go-migrate.ts:1186-1232`：每路由 `wroteThisRoute` 仅在 `ops.length>0` 且 `mutateWithRetry` 成功后置真；`routesResult` 因此按真实结果写 `wrote` 或 `skipped(no-op: route already matches the plan...)`，不再无条件 `wrote`。
- `src/opencode-go-migrate.ts:1281-1290`：标题计数改用 `writtenRoutes.length`（真实 settings 写入集合），零写入输出 `0 routes written (no settings writes; ...)`，不再用 `routesResult.filter(wrote).length`。标题数、逐路由状态、真实 mutate 次数三者一致。
- 测试 `test/opencode-go-migrate-action-table.test.mjs:533`（零写入，走命令路径，字节级比对 settings）、`:554`（有写入，计数 == wrote 行数 == mutate 次数）。

### N2 知情文本与账本不同源
- `src/opencode-go-migrate.ts:249-281`：删除旧的 `managedIdsForRoute`（仅按动作表 `managed` 标志推导，是 N2 根因）。新增唯一计算源 `managedIdsAfterApply(table, desc)`：对当前 settings 描述符模拟执行动作表，返回逐路由"实际会被写入/采纳"的托管 id 集合。
- `src/opencode-go-migrate.ts:619-637`：`managedAfterMigration` 知情文本改由上述模拟集合生成；并把每条动作的 `managed` 标志归一到模拟结果——未真正 claim 的 id 其动作行不再标 `[managed]`。
- `src/opencode-go-migrate.ts:906-1014`：`buildRouteWriteStates` 成为 plan 模拟与 apply 执行共用的唯一函数；`claim` 增加"id 必须已实际落在该路由"守卫；`move` 分支按目标现值分三种结果（空目标写入并 claim、同值目标采纳并 claim、异值目标 skipped 且不 claim）。
- `src/opencode-go-migrate.ts:1186-1194`：apply 账本 `managed` 与 `managedByRoute` 直接取同一模拟的 `state.managed`，无二次推导。
- 测试 `test/opencode-go-migrate-action-table.test.mjs:568/584/602/622/661/681`：六场景逐一断言四surface一致。

### N3 跳过路由的脏写入
- `src/opencode-go-migrate.ts:1176-1180`：`already-applied && !touched` 路由不再写 `managedByRoute`（原本用 `managedIdsForRoute` 造出无账本支撑的条目）。
- `src/opencode-go-migrate.ts:1242-1246`：`appliedManagedIds` 仅由 `managedByRoute`（即实际写入账本的路由）构造，删除 `?? managedIdsForRoute(route, plan.idActions)` 回退。被 plan 跳过的 google 路由不再产生 `"opencode-go-google": []`。
- 测试 `test/opencode-go-migrate-action-table.test.mjs:702`：settings 字节级断言无 google 键；`appliedManagedIds` 无该键；无 google 账本条目。

### N4 未知动作静默跳过
- `src/opencode-go-migrate.ts:283-293`：新增 `KNOWN_ACTION_OPS` 与 `findUnknownAction`，闭合联合之外的 op 返回首个违规行。
- `src/opencode-go-migrate.ts:1091-1106`：apply 在 consent 之后、任何写入（含 `applying` 标志）之前做 fail-closed 校验，返回新的可识别 reason `unknown-action`（`src/opencode-go-migrate.ts:1048`）。
- `src/opencode-go-migrate.ts:1006-1011`：`buildRouteWriteStates` 的 `switch` 加 `default` 抛错兜底，未知 op 永不静默 skip。
- `src/opencode-go-migrate.ts:1134-1139`：纯模拟在写 `applying` 之前完成，保证 default 抛错不会留下悬挂 applying 标志。
- `src/opencode-go-migrate.ts:798-805`：`faultInjectOp` 为测试专用故障注入缝（生产调用方不设置），仅用于 N4 夹具。
- 测试 `test/opencode-go-migrate-action-table.test.mjs:724`：注入未知 op → `reason=unknown-action`、settings/账本/迁移存储零写入、settings 字节不变；`findUnknownAction` 直接断言；switch default 直接抛错断言。

## 2. 四surface一致性矩阵（N2）

"托管"指该 id 在目标路由被本轮 apply 写入官方值或采纳同值副本（`claim` 成功）。

| 场景 | plan 知情文本 | plan 逐行 `[managed]` | apply 动作结果 | 账本 `managed` / `appliedManagedIds` | 一致 |
|---|---|---|---|---|---|
| add 到空路由 | 列出 3 个 desired id | add 行 `[managed]` | `applied` | 各路由含对应 id | 是 |
| move 到空目标 | msg: qwen4-max | move 行 `[managed]` | `applied` | msg 含 qwen4-max | 是 |
| move 到已存在同值目标 | msg: qwen4-max | keep + move 均 `[managed]` | `kept` / adopted into ledger | msg 含 qwen4-max | 是 |
| move 到已存在异值目标（N2 原缺陷） | msg: (none)，不含该 id | update 无标记；move **不再** `[managed]` | `skipped` / not managed | msg `managed=[]`、`appliedManagedIds['msg']=[]` | 是（修复前四处不一致） |
| pinned | msg: qwen4-max（旧路由副本不托管） | add 目标行 `[managed]`，keep 旧副本无标记 | target `applied`、old `kept` | msg 含 qwen4-max，chat 不含 | 是 |
| keep（已在官方路由且值一致） | chat: deepseek-v4.1-flash | keep 行 `[managed]` | `kept`（settings 零写入，纯采纳） | chat 含 deepseek-v4.1-flash | 是 |

所有场景均断言 `appliedManagedIds` 键集合 == 账本条目键集合，无额外空路由键。

## 3. 测试结果

- `npm run check`（`tsc --noEmit`）：退出码 0，0 错误。
- `npm test`（含 pretest `tsc` 编译）：退出码 0；node --test 42 文件 / pass 42 / fail 0。
- `test/opencode-go-migrate-action-table.test.mjs`：19 条断言全过（原 9 条保留未削弱 + 新增 N1/N1b/N2a–f/N3/N4 共 10 条）。
- `test/opencode-go-migrate.test.mjs`：22 条断言全过（既有语义未改）。
- 新增/既有断言均未删除或放宽；N1 走命令 handler 真实路径；N2/N3/N4 使用内存 I/O 夹具。

## 4. 残余风险

1. 本轮仅验证内存 harness 与命令 handler 路径，未对真机宿主 settings 服务 / 真实 `~/.dsh` 执行 apply（硬约束禁止）。真机 apply + 后续 go 轮联动仍需单独演练。
2. `managedIdsAfterApply` 在 plan 时读取当前 settings 描述符；plan 与 apply 之间若 settings 被外部改动，planHash 失配使 apply 被 consent 拒绝（安全方向），不会产出不一致的托管声明。
3. `faultInjectOp` 是测试专用 deps 缝；若生产误传一个合法 op，apply 仅会用原计划动作表（该缝只用于制造未知 op），不会引起计划外写入，但应谨慎保持其仅测试使用。
4. 历史遗留的旧账本条目（R-11）不在本轮范围；新逻辑只保证本轮 plan/apply 不虚报托管，不清理既往脏条目。
5. `adoptDisabled` 仍是显式能力位（默认 false），非运行时逐表执行探测；N4 的 `unknown-action` 与 switch default 补齐了"未知 op 不静默通过"的最后一道闸，但未替代能力位。

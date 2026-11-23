# 52 — N1（P1）stale-plan fix：writer 冲突重试覆盖用户新改动

- 实现方：本 worktree `/Users/qingguee/repo/dsh-model-sync-wt-opencode-go`，分支 `feat/opencode-go-sync`，基线 HEAD=`44912fb`（未 push）。
- 目标：复核 51 §5 N1 —— writer 在 fetch 窗口校验之后仍可能用旧计划覆盖用户刚保存的模型；覆盖窗口①（writer 读 descriptor 之后、首次 mutate 之前）与窗口②（fetch 后校验与 writer 读 descriptor 之间）。
- 证据级别：`[离线]` 注入 seam 直接调用生产函数（无网络、无真实 `~/.dsh`）；`[命令面]` 真实 runGoSyncRound + 模拟 settings/store；`[变异]` 临时回退修复后新用例变红。
- 原始输出：`/Users/qingguee/repo/.scratch-n1-fix/reverted-test.log`（红）、`restored-test.log`（绿）。scratch 同时保存两个被改源文件的修复态副本。

## 1. 修复策略选择：整轮放弃（fail-closed），不做就地重算

复核 51 §5 给了两个选项：(a) 注入 source/planner 依赖，按 fresh settings 重算计划；(b) 放弃本轮并报 `settings-changed-during-sync`。选 **(b)**，理由：

1. **重算路径不干净**。writer 只收到 `GoPlanResult`，不含 source entries、config、`currentRoutes`、ownership 快照；要在 `SETTINGS_CONFLICT` 时重算，必须把 source/planner/round 依赖整体注入 writer，并在循环中替换 `plan.routes` / `nextOwnership` / 双轮删除计数。这会在热路径引入大范围改动，且「重算出的计划」仍无法证明与用户刚保存的模型不冲突——重算本身就可能再次删掉用户模型。
2. **放弃是唯一能无条件守住「不改写用户数据」硬底线的选项**。一旦 revision 变化，旧计划的模型集合必然以变更前的 settings 为输入，继续写入就是数据损失；放弃零写入，下一轮自然按当前 settings 重新计划。
3. **与既有 B4 语义一致**。fetch 窗口的检测与整轮放弃已由 `settingsChangedResult()` 实现（`src/opencode-go-sync.ts:147`），writer 侧复用同一 `reason` 与零写入语义，命令层 `src/index.ts:1342` 已把该 reason 映射为 `kind:'error'`，且不触发退避（`src/opencode-go-scheduler.ts:143-147` 只对 `source-failed`/`failureKind` 退避）。

关键实现约束：**不能用「固定 expectedRevision 逐 mutate 比较」的朴素做法**。三路由同轮写入时，本 writer 自己的第一次成功 mutate 会把 revision 从 R 推到 R+1；若后续路由仍与 R 比较，会把自己的写入误判成用户改动而整轮放弃（违反「revision 未变时正常写入」）。因此采用**滚动基线**：每轮成功写入后 re-read descriptor，把基线推进到本次写入后的实际 revision，后续路由与新基线比较。

## 2. 两个窗口的复现与结果

全部用注入 seam 精确控制改动时机（`test/opencode-go-round.test.mjs:432`、`:478`）。注入的用户模型为 `{id:'user-saved-model', name:'user'}`。

| 窗口 | 注入点 | 修复前（回退源码后实测） | 修复后（实测） |
|---|---|---|---|
| ① writer 读 descriptor 之后、首次 mutate 之前 | 包装 `settings.describe`：第 3 次调用（writer 入口读）置位；包装 `ownershipStore.read`：置位后第一次读时 `userEdit` 把 revision 1→2 | `reason:'completed'`，三路由全 `wrote`，`ids(opencode-go)===['hy4-flash-free']`（用户新 id 被删），账本/指纹照写 | `reason:'settings-changed-during-sync'`、`ok:false`、`write:undefined`、`settingsChanged:{1,2}`、mutations `[]`、账本空、`onOwnWrite` 0 次，用户模型原样保留 |
| ② fetch 后校验与 writer 读 descriptor 之间 | 包装 `ownershipStore.read`：sync 侧 `readOwnership`（在 `:283` 校验之后、writer 之前）第一次读时 `userEdit` revision 1→2 | 同上，`completed` + 用户新 id 被删 | 同上，零写入，用户模型原样保留 |

自证（变异）：把两个源文件临时恢复成 HEAD 版本后运行全量，4 条新用例全部变红（`reverted-test.log`）：窗口①/② 的文本均为 `opencode-go: wrote` / `...-msg: wrote` / `...-resp: wrote`（`completed`），断言 `result.reason === 'settings-changed-during-sync'` 失败；writer 级两条 guard 用例的 `settingsChanged` 实际值为 `undefined`。恢复修复后 54/54 全绿。

## 3. 改动（文件:行号）

`src/opencode-go-writer.ts`

- `:79-87` `GoWriterDeps.expectedRevision?`：round 层传入的已校验 revision；仅纯 writer 单测可省略。
- `:136-141` `GoWriteResult.settingsChanged?`：整轮放弃的机器可读信号。
- `:303-341` `abandonForSettingsChange()`：整轮放弃助手——设置 `settingsChanged`、给未触碰路由补 `skipped(settings-changed-during-sync)`、追加 report 行；不写 settings / 账本 / 指纹。
- `:447-456` writer 入口检查（**窗口②**）：入口 descriptor 与 `expectedRevision` 不等 → 立即整轮放弃。
- `:605-619` 每路由 mutate / 无变更账本提交前的 descriptor 复读（**窗口①**）：与滚动基线 `currentExpectedRevision` 不等 → 立即整轮放弃。
- `:656-665` mutate 使用复读得到的 revision；成功写入后推进滚动基线（避免把自身写入误判为 settings 变更）。
- `:670-676` `SETTINGS_CONFLICT` 且处于 guard 模式 → 直接整轮放弃，**不进入旧的重试逻辑**，因此 `sortedFinal` 旧计划永远不会被重新应用。
- `:678+` 未传 `expectedRevision` 的直接单测调用保留原有 retry（生产路径始终传值，故不构成风险面）。

`src/opencode-go-sync.ts`

- `:161-177` `writerSettingsChangedResult()`：把 writer 的放弃信号转成与 fetch 窗口同 reason、零 `write` 字段的轮次结果，文本明确「stale plan discarded」。
- `:357-360` 向 writer 传 `expectedRevision: preFetchRevision`（校验通过后它等于 post-fetch revision）。
- `:374-384` writer 放弃时优先返回零写入结果，不再返回 `reason:'completed'`。

`test/opencode-go-round.test.mjs`

- `:432-476` 窗口①（含 seam 与全部零写入断言）。
- `:478-509` 窗口②（含 seam 与全部零写入断言）。
- `:511-527` 正常轮 + 幂等轮回归：三路由写入无假冲突，第二轮零写入。

`test/opencode-go-writer.test.mjs`

- `:644-662` writer 入口 stale `expectedRevision` → 整轮放弃、零 mutate、零账本。
- `:664-697` 复检后窄缝 `SETTINGS_CONFLICT` → 放弃、只有一次被拒尝试、用户模型保留、零账本。

## 4. 测试输出摘要

- `npm run check`：exit 0（`tsc --noEmit -p tsconfig.json` 无输出）。
- `npm test`：pretest `tsc` 成功后 `ℹ tests 54 / ℹ pass 54 / ℹ fail 0`（29 个测试文件，数量未变；新增断言在既有文件内）。
- 回归覆盖：既有 B4 fetch 窗口零写入、锁超时与 settings 变更原因可区分（`assert.notEqual`）、三路由写入 + 幂等、迁移 apply / rollback 全量 migrate 测试均保持通过。
- 变异自证：回退源码后 4 条新用例全红；恢复后全绿（日志见 §0）。

## 5. 残余风险

1. **迁移 apply 路径不使用本 writer，但存在同类形态**：`src/opencode-go-migrate.ts:1025-1041` 的 `mutateWithRetry` 在 `SETTINGS_CONFLICT` 时仍复用旧 `ops`。它不共用 writer（parenthetical 条件不成立），且被 planHash + confirmCode + ack 的显式同意门保护（`:1085-1098`），计划是用户审阅过并哈希的制品，与后台自动轮的风险模型不同；本次未改其行为。若后续要让迁移 apply 也具备同等防护，应在 consent 门之后、settings 写入之前复检 descriptor revision，不一致则 `write-failed`，而不是在冲突后复用旧 ops。
2. **窄缝 `SETTINGS_CONFLICT` 的代价**：guard 模式下任何冲突都整轮放弃，不再原地重试。代价是一次良性 revision 抖动会让本轮空转，下一轮（正常 20 min 或手动）重做；这是 fail-closed 的有意取舍，不触发退避。
3. **多路由中途变更仍可能半写**：复检在每路由 mutate 前执行；若用户改动恰好落在「路由 A 已写、路由 B 复检之前」，A 的写入无法回滚。这不是复核 51 的两个窗口（两者均在第一路由 mutate 之前），但属于多路由原子性的固有边界。
4. **直接调用 writer 且省略 `expectedRevision`**：保留旧 retry 行为；生产 `runGoSyncRound` 始终传值，故不影响线上，但该 seam 若被新调用方误用会重新暴露旧风险。
5. **revision 语义依赖宿主**：仍依赖宿主在用户编辑时推进 `llm-pi-ai` revision（继承复核 51 残余风险 3）。

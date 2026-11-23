# 50 — B4 关闭：fetch 窗口内 settings 修改导致用户改动被静默丢弃

日期：2026-11-23
分支：`feat/opencode-go-sync`，实现起点 HEAD=`99c9432`
对应条目：`31-p1-gate-review.md` §2 B4 / 风险 R-5；`07-design.md` D-9、§6.2（原子性段）、§14.7.5

## 1. 机制选择理由

需要的是「fetch 前后 settings 文档是否变过」的可比较值。代码里实际可用的是
`SettingsDescriptor.revision`（`src/writer.ts:59-64`，由 `settings.describe()` 返回的宿主
settings 文档 revision；`settings.mutate` 也以它作 `expectedRevision`，冲突即 `SETTINGS_CONFLICT`）。
它是宿主真实维护的值，不是测试里自造的记号，因此选它作 fetch 前基线与 fetch 后重读的比较项。

没有选择「对 descriptor 内容另算 section hash」：评审与设计的因果链就是 revision 变化，
且写入对象的一致性通过「fetch 后重读 descriptor 并据此重新构建 currentRoutes / plan」保证，
不必引入第二套指纹口径。取而代之的残余风险见 §5。

既有机制保持原样：

- 迁移门 / 单写者仍由 `routeWriter` 在 fetch 前判定（`opencode-go-sync.ts:186-198`），未改。
- 二次闸 `canWrite` 仍在每次 mutate 前重读持久化迁移状态（`opencode-go-sync.ts:250-260`）。
- 归属账本、指纹回写仍只在 `writeGoPlan` 成功路径执行；本轮放弃发生在 writer 之前，
  根本不会到达这些路径。
- fetch 仍在跨进程 store 锁之外；锁只包住 store 的读改写临界区（`remote-catalog.ts:334-363`）。
  本次没有新增任何持锁区间，无长持锁或死锁面。

## 2. 改动（文件:行号）

- `src/opencode-go-sync.ts:82-90`：`GoRoundReason` 新增 `'settings-changed-during-sync'`。
- `src/opencode-go-sync.ts:95-103`：`GoSyncRoundResult` 新增结构化字段
  `settingsChanged?: { beforeRevision, afterRevision }`（仅在放弃时填充）。
- `src/opencode-go-sync.ts:139-159`：新增 `settingsChangedResult()`，整轮放弃的结构化结果 +
  用户可见文案。
- `src/opencode-go-sync.ts:233-238`：fetch 前记录 `preFetchRevision = desc.revision`；该快照
  只用于新鲜度比较，从不作为计划输入。
- `src/opencode-go-sync.ts:266-291`：fetch 成功、abort 检查之后重读 `llmDescriptor(settings)`；
  descriptor 消失 → `settings-unavailable`；revision 变化 → `settingsChangedResult()` 整轮放弃；
  一致时用重读的 `freshDesc` 构建 `currentRoutes`，再交给 `planGoRoutes`（计划与写入对象一致）。
- `src/index.ts:1336-1342`：命令层把新原因计入 `kind:'error'`（之前非 source-failed 都报 success），
  但**不**加入退避判定（`GoScheduler.isBackoffFailure` 只认 source-failed / failureKind），
  下一轮按正常间隔重试。
- `test/opencode-go-round.test.mjs:61-70, 137-143`：`mockSettings.userEdit()` 与 `withHarness`
  的 `onFetch` seam——在 fetch 返回前改 document/revision。
- `test/opencode-go-round.test.mjs:294-433`：4 条新行为断言（见 §3）。

写入链路的关键不变量：放弃发生在 `writeGoPlan` 之前，因此 `settings.mutate` 调用数 0、
`writtenRoutes` 不存在、ownership ledger 不写、`onOwnWrite`（appliedFingerprint）不调用；
不落任何半写状态。

## 3. 测试与输出摘要

新增测试（均在 `test/opencode-go-round.test.mjs`）：

1. `B4: settings edit during fetch → zero writes, reason settings-changed-during-sync, user edit kept`
   — fetch 窗口内注入 `userEdit('opencode-go', [user-saved-model])`：reason 正确、
   `settingsChanged = {beforeRevision:1, afterRevision:2}`、`result.write === undefined`、
   `settings.mutations = []`、用户模型原样保留、ledger 键为空、`onOwnWrite` 调用数 0。
2. `B4: unchanged settings → normal write, then a second idempotent round`
   — 首轮三路由全部写入（含冲突重试路径）且 3 次指纹回写；次轮 no-change、零额外 mutate、
   零指纹回写。
3. `B4: store lock timeout and fetch-window edit are distinct failures, both with zero writes`
   — A：注入 `DSH_STORE_LOCK_TIMEOUT`，三条路由均 `store-lock-timeout`，零 settings 写；
   B：fetch 窗口修改，得到 `settings-changed-during-sync`；`assert.notEqual` 证明两种原因可区分。
4. `B4 command surface: fetch-window edit returns kind=error with the user-visible reason`
   — 完整命令面：`kind:'error'`、文案含原因、请求仍发出 1 次、零 settings 写、用户改动保留。

门槛输出（`npm run check` 退出 0）：

```
> tsc --noEmit -p tsconfig.json
```

`npm test`（含 pretest tsc）退出 0：

```
ℹ tests 54
ℹ pass 54
ℹ fail 0
ℹ duration_ms 10443.945417
```

其中 `opencode-go-round.test.mjs` 10/10（6 条既有 + 4 条新增）；既有 round / writer /
scheduler 测试语义未改，全部通过。锁相关测试约 10s 属既有正常耗时。

## 4. 用户可见文案

放弃轮次（`GoSyncRoundResult.text`，经 scheduler 原样上报、`/model-sync` 与自动轮日志可见）：

```
opencode-go: settings changed during the /v1/models fetch (llm-pi-ai revision 1 -> 2); discarding this round
  user edits were kept as-is: no settings write, no ownership ledger change, no fingerprint update
  the next round re-reads the current settings and retries normally
```

命令层 `kind:'error'`；不触发退避，下一轮正常重试。

## 5. 残余风险

1. **revision 机制的局限**：比较依赖宿主在用户编辑 settings 时单调推进 `llm-pi-ai` 文档
   revision。若某类宿主写入改了内容却不推进 revision，本检查会漏报；反之，任何无关的
   settings 变更（其他命名空间/字段）若推进同一 revision，会导致本轮保守放弃（安全方向，
   但延迟一次同步）。需真机确认宿主 revision 语义与跨命名空间粒度。
2. **writer 内部窗口未完全消除**：writer 入口自带的 descriptor 重读与首次 mutate 之间、
   以及 `SETTINGS_CONFLICT` 重试时，仍使用本轮已算好的 `finalModels`（31 B4 第三条：冲突重试
   复用旧合并列表）。本次修复的是评审主路径（fetch 请求窗口），设计 §6.2/§14.7.5 提到的
   「冲突重算计划、不一致即放弃」属于更深的 writer 侧改造（需要把 source/planner 依赖注入
   writer），未在本任务范围。现有 `SETTINGS_CONFLICT` 重试仍能在 revision 真的冲突时阻止
   覆盖，但重试写入的模型集合来自旧计划。
3. **放弃不写任何状态**：本轮放弃不会更新 `appliedFingerprint`、不记 ledger，这是安全方向；
   若用户编辑持续每轮都发生，同步会持续放弃（不会损坏数据，但模型列表不会刷新）。
4. **未上真机**：以上均为离线 seam 模拟（无网络、临时目录 store、内存 settings），真机宿主
   revision 推进时机需在 B5 场景补跑时一并观察。

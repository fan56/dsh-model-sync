# 59 — O1/C2 复核 P3 与边界收口（实现方）

日期：2026-11-23
角色：实现方（复核另派）
基线：`feat/opencode-go-sync`，HEAD `b04c658c7545863df7f874163d824c9f5d41b281`
工作区：`/Users/qingguee/repo/dsh-model-sync-wt-opencode-go`

报告形式说明：57 号报告（`57-o1-c2-verification.md`）位于主工作区，本次按「主树不碰」约束未改动它；按任务给出的第二选项新建本报告记录收口结果。

范围：57 §5 的 N-1、N-2 两个 P3 + journal 写撞锁边界强化 + 协调方追加的 W1（58 §5）。只改实现、测试、本报告；不写真实 `~/.dsh`，不 push。

## 1. N-1：原始类型损坏的 journal 槽不再静默跳过

**改动位置**

- `src/remote-catalog.ts`：`ModelsStoreAccessor.readRaw()` 返回类型由 `Record<string, unknown> | undefined` 改为 `unknown`；实现返回槽的原值，`undefined` 仅表示「键不存在」。字符串/数字/`null`/数组不再被过滤成 `undefined`。
- `src/opencode-go-store.ts` / `src/opencode-go-migration.ts` 的三个 `readRaw` 消费点改为 `raw: unknown` 并自行做对象校验；非对象槽仍按原方向退化为「无账本 / 无记录」，行为不变。
- `src/opencode-go-journal.ts`：`JournalReadResult` 新增 `rawTypeCorrupt?: boolean`；`createFileJournalStore.read()` 检测非对象槽，返回 `parseError` + `rawTypeCorrupt: true`。
- `reconcileJournals()`：对该标志产出可识别的 warn 告警（沿用 `journal-unparseable` 同级 code 与 level，消息含 `raw-type corruption`，notice 上带 `rawTypeCorrupt: true`），**清理前用 `isJournalKey(key, deps.profileKey)` 再确认键形状与本 profile**；对账继续处理其余槽。

**安全策略**：只有经过 `list()` 的 profile 过滤、且再次通过 `isJournalKey` 的槽才会删除。非 journal 键、别的 profile 的键即使存了原始值也不会被删。

**测试**：`test/opencode-go-journal.test.mjs` — 预置 string / number / null 三个 `#journal` 槽 + 一个健康 journal + 一个非 journal 键 + 一个别的 profile 的键。断言 3 条 `journal-unparseable` 且 `rawTypeCorrupt===true`、健康槽同轮对账成功、3 个坏槽被清理、非 journal 键与外来 profile 键字节不变、账本/`onRecord` 只针对健康槽。

## 2. N-2：`journal-list-failed` 对生产 file store 可达

**改动位置**

- `src/remote-catalog.ts`：`listRawKeys()` 移除 `catch { return [] }`；不可读 store 直接抛错（接口注释同步）。迁移记录的两个调用点原本就在 try/catch 内，行为不变。
- `src/opencode-go-journal.ts`：`createFileJournalStore.list()` 移除 `catch { return [] }`，异常向上透出；`reconcileJournals()` 既有的 `try/catch` 因此真正可达，产出 `journal-list-failed` notice 并跳过本轮对账。notice 通过 `ReconcileResult.lines` 进入 `journalPrefix`，在 `/model-sync go` 报表文本中可见。

**非 file store 不变**：注入的内存 journal store 的 `list()` 实现未改；只有 store 列举真的抛错时才产生该告警。

**测试**：`test/opencode-go-journal.test.mjs` 两条：
1. 让 `list()` 抛错 → notice 可见、`lines` 可见、`onRecord` 零调用、journal 保留（不当「无 journal」）；经真实 round 的 `journal.text` 同样可见；恢复后 3 条 journal 同轮收敛。
2. 直接把真实的 `models-store.json` 写成坏 JSON → `createFileJournalStore.list()` 拒绝（不再静默返回 `[]`），`reconcileJournals` 产出 `journal-list-failed`；恢复文件字节后列举正常。

## 3. journal 写撞锁边界：fail-closed

**改动位置**：`src/opencode-go-writer.ts`

- `writeJournal()` 失败仍返回 `false`；调用方在 `jkey !== undefined && !journalWritten` 时设 `failedReason = 'journal-unavailable'`，向 report 追加 `[error] journal-unavailable` 条目，**在 settings.mutate 之前短路本路由**：零 settings 写、零账本写、零 fingerprint/记录写。
- 旧注释「degrades to pre-C2 path / 不阻塞 settings 写」已删除；该降级正是 57 §2.9 无 journal 可对账的根因。
- SETTINGS_CONFLICT 重试分支同样收口：重试刷新 journal 失败时不执行重试 mutate，先 `deleteJournal` 清掉第一次尝试的旧哈希 journal，再以同一 `journal-unavailable` 原因失败；避免「settings 已写但 journal 哈希陈旧 → 下轮 `journal-stale` → 不补账本」的等价窗口。
- 决策：**按路由 fail-closed，不整轮放弃**。跨进程锁确实作用于整个 store 文件，但 journal 写失败也可能是槽级/配额等非锁原因；按路由收口已保证受影响路由零写入，且不会连带阻塞本轮能取得 journal 的健康路由。mutate 以 `journalWritten` 为硬前置，因此不存在新增的「settings 已写但无 journal」窗口。

**测试**：`test/opencode-go-journal.test.mjs` — 注入只在首轮抛错的 `journalStore.write`：首轮 `reason='write-failed'`、`failedRoutes` 全为 `journal-unavailable`、report 含该 code、`settings.mutations=0`、账本 map 空、迁移记录 `undefined`、无残留 journal；恢复写入后次轮三路由正常写入、journal 全清、迁移记录落地。S1/S2/S3、K1、健康路径、锁超时、`settings-changed-during-sync` 的既有断言全部保持通过。

## 4. W1：双 profile 标签统一（协调方追加）

**改动位置**

- `src/opencode-go-migration.ts` 新增 `unclaimedRecordState(unclaimed)`：D6 状态矩阵的**唯一**标签计算源（foreign-profile 优先，其余 unclaimed 为 legacy-store）。
- `src/opencode-go-migrate.ts` 的 `migrationStatusReport()` 改用该 helper。
- `src/index.ts` 的 `loadMigrationStatus()`（`/model-sync go` 报表来源）在本 profile 的 scoped `read()` 无记录时，同样读取 `unclaimedRecords()` 并用该 helper 覆盖 `status.state`。仅标签变化：两态写权都已是 `none`、零写、不认领、不可回滚删除；严格模式下扫描异常仍上抛。
- 仍遵守 B1 隔离：只有本 profile 无记录时才看外来记录，不把共存的其他 profile 记录误标到已 applied 的本 profile 上。

**测试**：`test/opencode-go-profile-identity.test.mjs` 新增 W1 用例：同一 foreign-profile store 状态下 `migrate status` 与 `go` 报表标签一致（均为 `foreign-profile`），`go` 文本不再出现 `migration gate: legacy-inline`，且零 settings 写、零 fetch、store 字节不变。

## 5. 门槛结果

- `npm run check`：exit 0。
- `npm test`（含 pretest tsc）：exit 0，`fail 0`；node:test 聚合 56/56 通过，各自定义 harness 全绿（journal 文件 23 断言 0 失败）。
- 回归：57 §2 的 S1/S1b、S2、S3、K1、N1 残留窗口、文案诚实性、fingerprint 噪声、健康路径、锁超时、`settings-changed-during-sync` 均保持通过。

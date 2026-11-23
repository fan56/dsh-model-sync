# 62 — oldfox 最终准出复审 5 条非阻塞建议收口

日期：2026-11-23
角色：实现方（只实现，复核另派）
对象：worktree `/Users/qingguee/repo/dsh-model-sync-wt-opencode-go`，分支 `feat/opencode-go-sync`，基线 HEAD=`7a2aa90`
方法：逐条读码定位 → 最小改动 → 每条新增行为断言 → 对 1/3/4 临时回退做红绿自证 → 恢复后跑全量 `npm run check` / `npm test`。未碰主树与其他 worktree；未写真实 `~/.dsh`；未 push。

---

## 逐条改动

### 1. no-change 路径账本非锁失败：进入 failedRoutes + 文案如实
文件：`src/opencode-go-writer.ts`（原 :822-829、:1108-1113；改后约 :826-843、:974-985、:1086-1094、:1131-1145、:1085-1091）

- 主 no-change 路径（`built === undefined`）与 conflict-retry 的 no-change 分支：账本提交后先判 `commit.lockTimeout` —— **锁类失败语义不变**，仍走 `recordLockTimeout`（`store-lock-timeout` / 已写设置的 `settings-written-unaccounted`，文案与退避诊断不变）。仅当 `commit.committed === false` 且非锁时，向 `result.failedRoutes.push({ reason: 'ledger-write-failed' })`，并把 `result.routes` 条目标上同样 reason；账本成功时仍是不带 reason 的 `no-change`。
- `persistLedger` 的 `settingsLanded=false` 分支：`level` 从 `warn` 升为 `error`，文案改为如实描述「无设置写入 + 账本未落地 + 下轮自愈」。`settingsLanded=true` 分支（`settings-written-unaccounted`）完全不动。
- `notClaimed` 集合补入 `failedRoutes` 的 route：no-change 账本失败不应再对外广告 `added` 行（其模型未被认领）。

**文案前后**
- 旧：`route X written but ownership ledger could not be persisted`（该路径 settings 实际零写，失实；`level: warn`，不进 failedRoutes，轮仍 `completed`）
- 新：`route X ownership ledger could not be persisted; no settings writes were made in this no-change path (self-heals next round via a fresh ownership read; re-claim with /model-sync adopt go if needed)`（`level: error`，进 failedRoutes，轮 `kind:'error'`）

### 2. descriptor 不可用独立 code
文件：`src/opencode-go-journal.ts`（`JournalNotice['code']` 联合、descriptor 分支）

- 新增 code `journal-descriptor-unavailable`，descriptor 缺失分支不再借用 `journal-list-failed`。保持「全保留、不猜测、零写」语义不变。
- 文案末尾补 `(reconciliation deferred, no list error)`，明确不是列举失败。

**文案前后**
- 旧 code/text：`journal-list-failed` / `llm-pi-ai descriptor unavailable; journals kept for a later round`
- 新 code/text：`journal-descriptor-unavailable` / `llm-pi-ai descriptor unavailable; journals kept for a later round (reconciliation deferred, no list error)`

### 3. writer 意外异常独立 reason
文件：`src/opencode-go-sync.ts`（`GoRoundReason` 联合、writer catch）、`src/index.ts`（命令 surface failed 判定）

- 新增 `GoRoundReason = 'writer-error'`。writeGoPlan 抛出异常时 `ok:false, reason:'writer-error'`，文本保持原样（本就如实写 `writer error`）。机器可读 reason 与文本一致。
- index.ts 命令 surface 把 `writer-error` 计入 `kind:'error'`，避免新 reason 让异常被当作成功。
- **退避语义核实**：`src/opencode-go-scheduler.ts:143-147` `isBackoffFailure` 仅对 `reason === 'source-failed'` 或 `failureKind !== undefined` 退避；`src/index.ts:1042` 只在 `reason === 'source-failed'` 时附 `failureKind`。`writer-error` 两者都不命中 → 不触发长退避，按正常 interval 重试。这与原设计「只有 source 失败退避」一致（sync.ts 原注释亦如此）。

**文案前后**（文本未变，修的是机器字段）
- 旧：`reason:'source-failed'` + `text:` `opencode-go: writer error — ...`（字段与文本矛盾）
- 新：`reason:'writer-error'` + 同文本（一致；命令仍 `kind:'error'`）

### 4. 对账前 entry 形状校验
文件：`src/opencode-go-journal.ts`（`parseJournal` 附近新增 `isValidOwnershipEntry`）

- 说明：任务给出的字段示例（route/ids/hash/profileScope/fingerprint）与本仓库真实 `GoOwnershipEntry`（`src/opencode-go-planner.ts:147`）不一致——真实必需字段只有 `managed: Record<id, {hash:string}>`，journal 层的 route/keyFingerprint/contentHash/modelIds 已在 `parseJournal` 校验。实现按**真实代码形状**做防波堤，不臆造字段。
- 新增 `isValidOwnershipEntry`：校验 `managed` 为 record、每个 id 为非空串、每个 owner 为带非空 string `hash` 的 record；可选字段 `routeFields`（record）、`preManagedSnapshot`（数组且元素带 string id）、`preManagedSection`（object|null）、`appliedAddedIds`（string[]）、`missing`（record of finite number）逐一验型；所有数组/键数上限 `MAX_LEDGER_ENTRIES = 100_000`（防超大数组）。
- `parseJournal` 改为：`!unset` 时缺 entry 报错；entry 只要存在（含 unset 情形）就先验型，不合法返回 `journal has invalid ledger entry` → 走既有 `journal-unparseable` 告警 + 清理路径，**绝不入账**。原 `as unknown as GoOwnershipEntry` 强转移除。
- 已核对所有 entry 生产者（writer / planner / migrate）产出形状均通过校验（含 `preManagedSnapshot` 元素恒带 id）。

**文案前后**
- 旧：畸形 entry 被原样 `as GoOwnershipEntry` 挂在 journal 上，对账时原样 `ownershipStore.write` 入账本
- 新：`journal has invalid ledger entry` → `journal-unparseable` 告警 + 清槽 + discarded，账本与迁移记录零写

### 5. 确定性字节序排序
文件：`src/opencode-go-journal.ts`（`journalContentHash`）

- 排序比较器从 `a.id.localeCompare(b.id)` 改为 UTF-16 code unit 的 `<` / `>`（对 ASCII id 即字节序），消除跨机器/跨 locale 的 hash 漂移 → 不再因 locale 误判 `journal-stale`。
- 补单元断言：以 `'Zed'` / `'alpha'` 证明 locale 与 code unit 顺序相反，并比对独立计算的 SHA-256 参考值；另起 `LC_ALL=tr_TR.UTF-8` 子进程对 `'I'`/`'i'` 计算 hash，断言与父进程一致（跨 locale 环境断言）。

**文案前后**（无文案；算法行为变化）
- 旧：排序依赖宿主 locale，`'I'`/`'i'` 在 en 与 tr 下顺序相反 → hash 不同
- 新：任何 locale 下同一数组 hash 恒定

---

## 测试与自证记录

新增行为断言（每条断言结果而非仅字符串存在）：

| 建议 | 测试文件 | 断言要点 |
|---|---|---|
| 1 | `test/opencode-go-writer.test.mjs` | ① 账本非锁失败 ⇒ `failedRoutes=[ledger-write-failed]`、route reason、level=error、文本不含 written but 且含 no settings writes；② 锁失败仍 `store-lock-timeout`、无 ledger-write-failed、保留 lock path + Retry 文案 |
| 2 | `test/opencode-go-journal.test.mjs` | notices.code 恰为 `journal-descriptor-unavailable`、不含 `journal-list-failed`、journal 仍在 store |
| 3 | `test/opencode-go-round.test.mjs` | 注入 writer 内抛错 ⇒ `reason=writer-error`、`≠source-failed`、文本含 writer error 与错误详情、零 settings mutate |
| 4 | `test/opencode-go-journal.test.mjs` | ① 缺 managed / 数组冒充 / hash 类型错 / 可选字段类型错 / 超大数组 / unset 带坏 entry 全被拒；② 坏 entry journal ⇒ 不 reconcile / discarded / journal-unparseable 告警 / 账本+记录零写 / 槽清理 |
| 5 | `test/opencode-go-journal.test.mjs` | code-unit 参考 hash、数组顺序无关、tr_TR 子进程 hash 一致 |

**红绿自证**（临时回退修复 → 重新 build → 跑新用例 → 恢复 → 复跑）

| 建议 | 回退后（红） | 恢复后（绿） |
|---|---|---|
| 1 | `FAIL oldfox #1 ...: counted as a real failure`（failedRoutes 为空）；锁语义用例仍 PASS（回归护栏） | 2/2 PASS |
| 3 | `FAIL oldfox #3 ...: + 'source-failed' - 'writer-error'` | 1/1 PASS |
| 4 | `FAIL oldfox #4 ...: expected rejection: {"entry":{}}`；`FAIL ... never reconciled` | 2/2 PASS |
| 5（附加） | `FAIL oldfox #5 ...: hash equals the byte-order reference` | 1/1 PASS |

**全量结果**：`npm run check` 退出 0；`npm test` **tests 56 / pass 56 / fail 0**（含 pretest tsc）。全量日志逐条确认回归断言通过：S1 / S1b / S2 / S3、K1、stale / orphan / reconcile store failure、journal write failure fail-closed、B4（含 store lock 与 fetch-window 双失败区分）、N1 窗口①②、迁移 N1/N2 系列、N2/O1 锁与非锁账本失败。这些测试文件本身未改动其既有断言，仅追加新用例。

---

## 残余风险

1. **发布说明需更新两个新机器字段**：`journal-descriptor-unavailable`（建议 2）与 `writer-error`（建议 3）。旧自动化若按「白名单 code/reason」统计，需要纳入；否则这两类会被漏计（不会误判为别的失败）。
2. **no-change 账本失败现在令轮 `kind:'error'`**（建议 1）：数据方向仍安全、下轮自愈，但运维会看到一次真实错误。这是纠正原先「偏乐观」的预期结果；发布说明第 6 节第 12 条可改为已修。
3. **writer 异常与 write-failed 分为两个 reason**（建议 3）：按 reason 聚合时需分别统计；两者都映射命令 `kind:'error'`，都不触发退避。
4. **entry 校验上限 100_000**（建议 4）：极保守的防御阈值，正常账本远小于此；若单路由合法 id 超过该量级会被判脏数据（实际不可能）。校验按真实 `GoOwnershipEntry` 形状设计，未采用任务描述里不存在的字段名。
5. **hash 算法切换的跨版本边界**（建议 5）：若旧版（7a2aa90）在含大小写混排 id 的路由上留下 journal，升级后首轮可能因 hash 规则变化判 `journal-stale` 而丢弃该 journal —— 方向安全（保留用户值、下轮重规划），典型小写 id 不受影响。
6. **崩溃窗口验证边界不变**：K1 等仍为 seam 模拟 + tmp+rename 原子性论证，未做真实 SIGKILL；本次未触及该边界。

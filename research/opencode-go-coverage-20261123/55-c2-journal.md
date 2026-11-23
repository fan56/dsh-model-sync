# 55 — O1/C2 写前日志 + 下轮对账

分支 `feat/opencode-go-sync`，基线 HEAD `1e6d871`（O1 如实报告最小集）。范围：结构性修复 C2，只做实现与测试；复核另派。未改主树/其他 worktree，未写真实 `~/.dsh`，未 push。

## 1. 结论

S1/S1b、K1、S2、S3 的「settings 已写、账本/记录未记」后果在结构上关闭：写前先把意图落到 journal，下一轮在迁移门之前按现值内容哈希对账，补账本与迁移记录，删除 journal；用户改过现值则丢弃 journal、不覆盖。全程不写 settings。

门槛：`npm run check` exit 0；`npm test` exit 0（`tests 55 / pass 55 / fail 0`，含 pretest tsc；基线 54，新增 1 个测试文件、19 条断言）。

## 2. 键格式与判定

| 项 | 内容 |
|---|---|
| 键 | `<profileKey>#<route>#<keyFingerprint>#journal`（4 段），`src/opencode-go-journal.ts:73` `goJournalKey()` |
| 载体 | 与账本/迁移记录同一个 `~/.dsh/models-store.json` 顶层 opaque slot，复用 `ModelsStoreAccessor.writeRaw/deleteRaw` 的队列 + 原子 tmp+rename（`remote-catalog.ts:610-633`） |
| 外来/旧记录判定 | `isUnscopedStoreKey`（profile.ts:105）只对 **2 段**键返回 legacy；4 段 journal 键 `parts.length !== 2` → `false`。迁移 store 的 `legacyKeys()`/`unclaimedRecords()` 也只认 `migration:opencode-go` 结尾的键，journal 以 `#journal` 结尾，不会被报告或认领。**不需要修改 profile.ts**；测试显式断言 `isUnscopedStoreKey(journalKey) === false`。 |
| `isJournalKey` | 按 `<profile>#` 前缀 + `#journal` 尾部匹配，中段须含 `#`；不依赖固定段数，兼容 profile 名含 `#`（journal.ts:80） |
| 载荷校验 | `parseJournal`（journal.ts:112）严格校验 version=1、profileKey、route、keyFingerprint、modelIds、contentHash、unset、entry（非 unset 时必填）、at；任一缺失/错型即解析失败 |
| 双保险 | 键里嵌 profile + fingerprint，**载荷里再盖一次**；对账时两者都比对（journal.ts:299） |

## 3. 写序与每步失败形态

写序（每路由，`src/opencode-go-writer.ts:792-945`）：

```
journal（意图 + 写入后内容哈希 + revision 期望 + 时间戳）
  → settings.mutate
  → 账本 commit
  → 迁移记录（onOwnWrite）
  → 删除 journal
```

| 步骤 | 失败形态 | journal 状态 |
|---|---|---|
| journal 写失败 | 记 warn，继续原写路径（不阻断，保持锁/门语义）；退化为最小集的如实报告 | 无 journal 可留 |
| journal 写后、mutate 前新鲜度复核失败 | 丢弃 journal，整轮 abandon（`settings-changed-during-sync`，零写入） | 删除 |
| mutate 失败（非冲突） | `failedRoutes`，journal 保留 | 保留 |
| mutate 冲突（有 expectedRevision） | 作者写未落地，删除 journal 后 abandon | 删除 |
| 账本锁超时 / 非锁失败 | `settings-written-unaccounted`，journal 保留 | 保留 |
| 迁移记录写失败（S1b） | `recordOwnWrite` 返回 false，journal 保留 | 保留 |
| 全步成功 | 删除 journal | 删除 |

要点：

- journal 写放在窗口①新鲜度检查**之后**、mutate **之前**，并在写后**重做**一次 descriptor revision 检查（writer.ts:810-818），不扩大陈旧计划窗口。
- `settingsLandedRoutes` / `failedRoutes` / N1 abandon 报告语义未变；`recordOwnWrite` 由 `void` 改为返回 `boolean`仅供 C2 判断 journal 是否可删，日志/报告字节不变。
- 健康路径不增加 settings 写入（测试断言 `mutations.length` 仍为 3；第二轮仍为 3）；只增加每路由一次 store 写。

## 4. 对账流程（文字流程图）

```
runGoSyncRound 入口（settings/key 检查之后）
        │
        ▼
[1] reconcileJournals(profile, fingerprint)        sync.ts:278-290
        │   list(profile) → 逐个 slot：
        │     ├─ 解析失败 ───────────────► warn journal-unparseable + 删除（按无 journal 处理）
        │     ├─ profile/fingerprint 不符 ─► warn journal-orphan + 删除
        │     ├─ 现值 hash != journal hash ─► warn journal-stale + 删除（用户值不动）
        │     └─ 现值 hash == journal hash ─► 写账本（unset 则 delete）→ onOwnWrite 补记录 → 删除 journal
        │          └─ 任一步失败 ─────────► warn journal-reconcile-failed + 保留 journal（下轮重试）
        ▼
[2] 若有 reconciled，reloadMigration() 重读记录      sync.ts:302-309
        │   （同轮即可用新记录开启迁移门；失败则沿用旧快照）
        ▼
[3] 迁移门判定（routeWriter）                       sync.ts:312-325
        ▼
[4] fetch → 二次闸 → writer（journal 写 + mutate + 账本 + 记录 + 删 journal）
```

对账只写 store/记录，**禁止写 settings**；对账结果作为 `journal` 字段与 `journal-*`/summary 行并入轮报告（gate 关闭的轮也能看到，满足「门关时也要能对账」）。

## 5. 迁移门前后顺序

- 对账在 `runGoSyncRound` 中位于迁移门判定**之前**（sync.ts:278 对账，sync.ts:312 门判定）。
- 生产接线 index.ts:917-980：`loadMigrationStatus()` 先取快照 → `runGoSyncRound` 先对账 → 若 reconciled 则 `reloadMigration()` 重读 → 再判门。因此 S1 的 `legacy-inline` **不再永久关闭**：对账补记录后同轮或下一轮状态回到 `applied`。
- 二次闸（`reloadMigration`，sync.ts:400-417）语义不变；对账补记录后二次闸看到的是新记录，不会误关。
- M-5 / `applying` 语义不变：对账不写 settings、不碰 `applying` 标志。

## 6. 清理策略

- `migrate apply` 成功：清本 profile 全部 journal（`opencode-go-migrate.ts:1332`）。
- `migrate apply` 失败并字节还原后：清本 profile 全部 journal（:1325），避免被还原的旧 journal 重新入账。
- `migrate rollback` 成功（:1572）与部分失败（:1550）：清本 profile 全部 journal。
- 换 Key 孤儿：对账按 keyFingerprint 不匹配直接丢弃；migrate 的 `clearProfile` 无条件清 profile 下全部 journal（含旧指纹），作为兜底。
- 无 profile 身份时 `journalStoreForRound()` 返回 `undefined`（index.ts:504），绝不回退到真实默认 `~/.dsh`；与账本路径 fail-closed 一致。

## 7. 逐场景测试结果

测试文件 `test/opencode-go-journal.test.mjs`（新增，19 条断言，全部通过）。

| 场景 | 断言要点 | 结果 |
|---|---|---|
| 键形态 | 4 段键；`isUnscopedStoreKey=false`；profile/尾部判定 | PASS |
| 内容哈希 | 顺序/字段序稳定；内容变化则哈希变化 | PASS |
| 解析 | 6 类畸形载荷均报错，不产 journal | PASS |
| 文件 store | write/read/list/clear + 原子性载体 + 解析失败降级 | PASS |
| **S1** | absent 首轮 1 次落地 + 账本/记录失败 → 1 个 journal；次轮对账补账本+记录、同轮门重开（状态 `applied`）、journal 删除，先前被 gate 的 msg/resp 正常写入 | PASS |
| **S1b** | 账本落地、记录失败 → journal 保留；次轮补记录、门重开、journal 删除 | PASS |
| **K1** | 已迁移 + 账本 seam 失败 → 3 个 journal；次轮收敛，模型变 managed，第三轮 `overwrote-managed` 正常刷新 | PASS |
| **S2** | 新增模型 + 账本失败 → 对账后进入账本；随后两轮确认删除成功（不再 `kept-user-owned`） | PASS |
| **S3** | 刷新 + 账本失败 → 对账前 rollback `hash-mismatch`；对账后账本哈希 == 现值哈希，rollback `rolled-back` | PASS |
| 用户改值 | 现值哈希不等 → journal 作废删除，用户模型保留且未被账本认领 | PASS |
| 孤儿 journal | profile/key 不符 → `journal-orphan` 警告、删除、不写账本 | PASS |
| 解析失败 | `journal-unparseable` 警告、轮 `completed`、槽清理 | PASS |
| 对账写失败 | `journal-reconcile-failed`，journal 保留待下轮重试 | PASS |
| 健康路径 | 三路由写入、journal 清空、次轮零写入幂等 | PASS |
| rollback 清理 | rollback 后本 profile journal 清空 | PASS |
| apply 成功清理 | apply 后 journal 清空 | PASS |
| apply 失败还原清理 | 账本失败触发还原后 journal 清空 | PASS |
| 锁/变更语义 | journal 接线后 `store-lock-timeout` 仍零写入；fetch 窗口用户编辑仍 `settings-changed-during-sync` 零写入、无 journal | PASS |

既有 54 条测试全部保持绿色（含 O1 最小集的 S1/S2/S3/K1/S7/S8a 与锁超时断言）。

## 8. 残余风险

- **孤儿 journal 的长期累积**：当前策略是「对账遇到即丢 + migrate 清 profile」，没有独立定时清扫。若用户长期不跑同步也不跑 migrate，旧指纹 journal 会留在共享 store；下一次同步会丢弃它，不会误入账，但 store 有残留。可后续加一个 listRawKeys 级别的定期清理。
- **跨 profile**：键与载荷双盖 profileKey，对账按本 profile 前缀 list 并校验；另一 profile 的 journal 不会被本 profile 读/写。profile 改名后旧 profile 的 journal 成为孤儿，由新 profile 的 key 不匹配路径丢弃（不会被认领）。
- **锁窗口**：journal 与账本共用同一个 store 队列和跨进程锁；若 journal 写也撞上锁超时，按降级处理（warn 后继续 mutate），此时退化为最小集行为——当轮如实报 `settings-written-unaccounted`，但无 journal 可供下轮对账，S1/S2/S3 后果重现。这是「锁不覆盖 settings.mutate」的固有边界，不是新增回归。
- **hash 口径**：内容哈希只覆盖 `models` 数组（writer 写入的 `mergedSorted`），不含 `api/baseURL/apiKeyEnv`。用户仅改这些字段时哈希仍相等，会补账本；但账本记录的是 writer 写入时的 `routeFields` 与 managed 哈希，字段漂移由 planner 的 conflict 检测处理，与本对账无关。
- **无真实 SIGKILL 验证**：K1 用 seam 模拟中断点，未真杀子进程；journal 的原子性由 `writeRaw` 的 tmp+rename 保证。
- **N1 残留窗口、fingerprint-healed 噪声**：最小集报告已记录，本轮未触碰。

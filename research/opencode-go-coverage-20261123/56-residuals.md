# 56 — O1 三项残余收口（实现报告）

日期：2026-11-23
分支：`feat/opencode-go-sync`，基线 HEAD `0351644`
范围：只改实现 + 测试 + 本报告；不写真实 `~/.dsh`，不 push。

## 1. N1 残留窗口：mutate 后按内容哈希建立新基线

**改动位置**

- `src/opencode-go-writer.ts:274` 新增 `expectedUserAfterOps()`：把 `built.ops` 应用到 mutate 前读到的 `live.user`，得到「自己写入后的期望内容」。
- `src/opencode-go-writer.ts:890-906`：mutate 返回后不再无条件采用回读 revision。回读后以 `fingerprintSection()` 计算期望内容与实际 `user` 的哈希；不一致（或描述符消失）即 `abandonForSettingsChange(...)`，报 `settings-changed-during-sync`。
  - 只有哈希一致才推进 `currentExpectedRevision`（滚动基线）。
  - 本路由已落地并记入 `settingsLandedRoutes`，故报告按 S7 口径列出「already written / discarded」，已落地的 mutate 不回滚。
  - **不删除 journal**：残留窗口若只是用户改了别的路由，本路由内容仍与 journal 哈希一致，下轮 C2 对账可补账本；若用户改的是本路由，对账按哈希不符丢弃 journal 并保留用户值。自愈路径未回归。
- 配套测试：`test/opencode-go-writer.test.mjs:715`（mutate 返回后、回读前注入用户编辑 → 后续零写入、原因正确、用户改动保留）、`:757`（无编辑时三路由正常写入 + 幂等）。mock 新增 `afterMutate` seam 与 `revision` getter。

**行为对比**

| | 旧 | 新 |
|---|---|---|
| 新基线依据 | 回读 revision 单调增即采纳 | 回读内容哈希 == 自己写入后的期望内容才采纳 |
| 用户编辑落在 mutate 与回读之间 | 被当作新基线，后续路由按陈旧计划覆盖用户值 | 立即终止整轮；只有已落地那一次 mutate，零追加写入 |

## 2. 锁 detail 旧文案

**改动位置**

- `src/opencode-go-writer.ts:303` 新增 `truthfulLockDetail()`：只剥离 `The store was NOT modified.` 与 `Retry the operation;` 及其附属的 futile-retry 从句，保留锁路径 / 等待时长 / 陈旧锁说明等诊断信息；若仍有异文命中则用如实占位文案兜底。
- `src/opencode-go-writer.ts:345`：`settingsLanded` 时 detail 走清洗；零写入路径 `errorText(err)` 原样保留（原文案不变）。
- `src/opencode-go-writer.ts:59 / 63`：`UNACCOUNTED_ADVICE` / `RECORD_ADVICE` 增补「retrying cannot re-claim / 下轮对账 / 认领命令」；`recordOwnWrite` 内嵌错误也一并清洗。
- 配套测试：`test/opencode-go-writer.test.mjs:1139` 等改为断言 settings 已写路径不含误导句；零写入的 override-stage 锁路径仍断言 `Retry the operation` 存在；`test/opencode-go-lock-hardening.test.mjs` 的 store 层断言未动。

**文案前后对比**（账本锁超时且 settings 已写）

- 前：`route opencode-go ledger commit hit a store lock timeout after settings were written: Timed out after 2000ms waiting for the models-store lock (/tmp/...). The store was NOT modified. Retry the operation; if it keeps failing, ... . settings were written but the ownership ledger was not updated; the next round will keep this route as user-owned (no refresh, no deletion); re-claim it with /model-sync adopt go`
- 后：`route opencode-go ledger commit hit a store lock timeout after settings were written: Timed out after 2000ms waiting for the models-store lock (/tmp/...). A lock left by a crashed process ... . settings were written but the ownership ledger was not updated; retrying cannot re-claim the route; the next round reconciles the write-ahead journal (otherwise keeps this route as user-owned: no refresh, no deletion); re-claim it with /model-sync adopt go`
- 零写入路径（如 override stage 锁超时）：detail 与 `Retry the operation` 文案字节不变。

## 3. fingerprint-healed 噪声

**改动位置**

- `src/opencode-go-migration.ts:271` 新增 `appliedFingerprintFieldsOf()`：身份路由集合取 `record.appliedIdentityRoutes`，管理 id 集合只取传入 map 中实际存在的路由；`migrationStatusOf`(:358) 与 `onOwnWrite` 共用。
- `src/opencode-go-migration.ts:288` 新增 `goLedgerManagedIds()`：只为「有真实账本条目」的路由写入 `<route>: ids`；缺条目 / 读失败不再伪造 `<route>: []`。
- `src/index.ts:559`：`loadMigrationStatus` 改用 `goLedgerManagedIds()`；`:988`：`onOwnWrite` 改用共享 helper。两侧路由集合口径统一。
- 配套测试：`test/opencode-go-migration-gate.test.mjs:437`（按真实 apply 后的记录 + 账本种子构造：首次接入与自写健康轮均不打 `fingerprint-healed`；人为把 fingerprint 改旧后仍产出 heal 并修复）。

**根因**：migrate/onOwnWrite 只持久化实际写入路由的 `appliedManagedIds`；`loadMigrationStatus` 却对配置里的全部路由补 `[]`，导致接入首轮 fingerprint 不等、误报自愈。

## 测试结果

- `npm run check`：exit 0。
- `npm test`（含 pretest tsc）：55/55 node:test 文件通过，0 fail；各文件内 assert 全绿（writer 48 passed、migration-gate 13 passed）。
- 回归：`opencode-go-journal`（C2 对账）、S1/S2/S3、`B4`、`迁移门`、锁硬化相关测试均保持通过。

## 残余风险

1. N1 内容校验哈希整个 `llm-pi-ai user` 对象。若宿主 settings seam 在写入时注入 schema 默认值（超出 ops 的规范化），可能误判为外部编辑而放弃整轮；后果是零追加写入、下轮重新规划，不丢数据。当前离线 mock 与实际 seam 一致，未观察到该情形。
2. 校验仅在带 `expectedRevision` 的受保护路径生效（生产始终提供）；纯单测 writer 的无 revision 路径保持旧行为，属既有设计。
3. 残留窗口放弃时保留 journal 是刻意选择（下轮对账补账本）；若运维不了解 `journal-stale` 提示，可能误读为异常，需在发布说明中解释。
4. lock detail 清洗基于标准 `StoreLockTimeoutError` 文案；异文若仍含「retry」会被兜底占位替换，极端情况下丢失原句细节（锁路径通常仍保留）。零写入路径不受影响。
5. 历史记录若含伪造的空路由条目（旧口径写入），升级后首轮可能出现**一次** `fingerprint-healed`——这是口径迁移的真实修复，不是噪声；之后收敛。

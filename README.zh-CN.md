[English](./README.md) | 简体中文

# dsh-model-sync

[![npm version](https://img.shields.io/npm/v/@aiwayds/dsh-model-sync)](https://www.npmjs.com/package/@aiwayds/dsh-model-sync) · [GitHub](https://github.com/fan56/dsh-model-sync)

一个 dsh（DeepSeek Harness）Cordis 插件：把 `llm-pi-ai` 各 provider 路由的模型目录与 pi.dev 网关的模型列表保持同步，并通过官方 settings 接缝（`settings.mutate`）写进 dsh 的 `settings.yaml`——对 dsh 内部零补丁。

**要求 dsh >= 0.1.2-rc.1** — 本插件只跟随 dsh RC/stable 线（CI 与发版在运行时解析 latest/next 中更新的 dist-tag）。**不再支持 alpha 线。**

https://github.com/user-attachments/assets/c3f9c8b1-ea5e-470c-b8a8-60a81fc5c20a

*一段 dsh 会话里运行 `/model-sync` 的实录（MP4，1.5× 速度）——丢弃原因、各路由同步状态与变更报告一览。更多 demo 见 [Demos issue](https://github.com/fan56/dsh-model-sync/issues/1)。*

## 为什么

模型列表会漂移：provider 不断上架新模型、下线旧模型、调整能力字段（`contextWindow`、`input` 模态、`thinkingFormat`、reasoning efforts）。靠手工跟进既枯燥又容易出错，dsh-model-sync 替你做完这一切：

- **只增只改的写入。** pi.dev 上的新模型被合并进来，已有模型按需更新，没有变化的路由完全不动——writer 会先和 settings 里的原始 user 段做比较，无变化即跳过（`writer.ts`、`profilesEqual`、`reason: 'no-change'`）。
- **不再手工维护模型表。** 对受管路由而言，pi.dev remote catalog 就是唯一事实来源，你的 `settings.yaml` 只是它的投影。
- **定时刷新。** 启动后不久自动跑一轮，之后按可配置的周期持续刷新，目录无需任何手动操作即可保持最新。

## 特性

- **pi.dev 网关同步。** 从 `https://pi.dev/api/models/providers/<route>` 拉取每条受管路由的模型列表，带 ETag/304 revalidation，并在 `~/.dsh/models-store.json` 维护按 provider 持久化的缓存（`remote-catalog.ts`）。瞬时故障与中断保留上次成功的缓存（last-good）；404/501 视为该路由本轮不存在。
- **默认路由。** `managedRoutes` 为空时，同步以下 pi.dev 路由：`opencode-go`、`zai-coding-cn`、`minimax-cn`、`xiaomi-token-plan-cn`（`src/index.ts` 的 `DEFAULT_ROUTES`）。
- **两种写模式**（`writeMode`）：
  - `settings`（默认）——零补丁流水线：fetch → translate → `settings.mutate`。自包含，从不直接改写 `settings.yaml`，只经官方 settings API 落盘。
  - `overlay`（旧方案）——委托打了补丁的 `dsh-llm-pi-ai` 适配器的 `piAiCatalog.refresh()`，把 pi.dev 条目合并进内存（需要可选补丁）。
- **定时刷新。** `intervalMinutes` 周期轮（默认 240，即 4 小时）加 `startupDelaySeconds` 启动延迟（默认 5 秒）；每轮自动刷新输出的报告与手动刷新完全相同。`0` 表示关闭周期（仅启动时刷一次）。配置变更时周期会实时重新挂载（`src/index.ts`）。
- **变更报告 / diff。** 每轮报告新增/移除的模型 id（`diffModelIds`）；`settings` 模式下还会对照当前原始 settings 报告新增/移除/变更的条目（`diffEntries`，`diff.ts`）。被丢弃（dropped）与降级（degraded）的条目连同原因一并报告。
- **`modelSync` 服务。** 对外暴露 `modelSync` 服务（`syncNow()`），UI 调用它即可强制跑一轮刷新并读取报告。
- **`/model-sync` 命令。** 插件自行通过共享的 dsh 命令注册表（`@deepseek-ai/dsh-commands`）注册 `/model-sync` 斜杠命令，所有交互式 UI 自动发现并列出——UI 侧零配合。执行它当场强制跑一轮刷新，输出的报告与定时轮完全相同；同步范围由 `managedRoutes` 决定（参数会被忽略）。命令注册表是可选 peer：没有命令注册服务的宿主照常降级，定时刷新与 `modelSync` 服务不受影响。
- **翻译规则。** pi.dev 条目被翻译成 settings 可写的模型 profile（`translate.ts`）：base-matching 与 base-less 分类、`reasoningEfforts` 推导（S2 gate）、`compat` 门控到 `openai-completions`（S5 gate）、`maxTokens` 处理，以及混合协议路由的丢弃逻辑。容量值另有卫生门：非正整数的 `contextWindow`，或不是「严格小于 contextWindow 的正整数」的 `maxTokens`（有的列表会把 context window 回声填进 maxTokens），一律跳过不写，并在报告中以降级警告说明。
- **你的覆盖不会被吃掉。** `modelOverrides` 是你自己的按模型调整通道（think level、收窄 context window 等）。dsh 拒绝 models 列表与非空 modelOverrides 并存，因此同步会把覆盖字段折叠进写入的 models、在同一次写入中清掉该键，并把原值存进 `~/.dsh/models-store.json` 逐轮回放——只要路由仍被托管，覆盖就持续压过同步值。
- **默认安全的开关：**
  - `keepBuiltinOnly: true`——保留内置目录里有、但 pi.dev 上（还）没有的模型，启用同步不会删掉你正在用的模型。
  - `dropUnserviceable: true`——丢弃不可服务的条目并继续；设为 `false` 则改为中止整条路由，而不是写入残缺列表。
  - `forceMaxReasoningEffort`——强制所有 `thinkingFormat` 非空的模型使用 max reasoning effort（确保 `reasoningEfforts` 包含 `max`，并在 `openai-completions` 上强制 `compat.supportsReasoningEffort = true`）。
- **冲突安全写入。** 写入携带 settings revision，遇 `SETTINGS_CONFLICT` 自动重试一次（`writer.ts`）。

## 安装

需要 Node ≥ 22.19 和一个 dsh profile。作为 dsh 插件安装：

```bash
npm i @aiwayds/dsh-model-sync
dsh plugin add @aiwayds/dsh-model-sync
```

包内附带 `cordis.patch.yml`（经 `dsh.bundle.patch` 接线），它把插件挂载进 profile 的装配树（稳定的插件 id `dsh-model-sync`），并注册 `model-sync` settings 命名空间。

本插件独立分发——需要时用 `dsh plugin add @aiwayds/dsh-model-sync` 显式安装即可。

## 用法

在 `settings.yaml` 的 `model-sync` 命名空间下配置本插件——每个键都是可选的：

| 键 | 默认值 | 说明 |
|---|---|---|
| `writeMode` | `'settings'` | 零补丁流水线；`'overlay'` 走旧的补丁适配器模式 |
| `intervalMinutes` | `240 (4h)` | 自动刷新间隔（分钟）；`0` = 仅启动时刷新 |
| `startupDelaySeconds` | `5` | 首次自动刷新前的延迟，等 llm 适配器就绪 |
| `refreshTimeoutMs` | `120000` | 单轮刷新网络请求的中断预算（最小 `1000`） |
| `managedRoutes` | `[]` | 要同步的路由；为空 = 默认 pi.dev 路由 |
| `keepBuiltinOnly` | `true` | 保留 pi.dev 上没有的内置模型（平滑迁移） |
| `dropUnserviceable` | `true` | 丢弃不可服务的条目；`false` 改为中止整条路由 |
| `syncNotify` | `false` | 有变更时通知（logger + `/model-sync` 报告） |
| `forceMaxReasoningEffort` | `false` | 对 `thinkingFormat` 非空的模型强制 max reasoning effort |

示例：

```yaml
model-sync:
  writeMode: settings
  intervalMinutes: 30
  managedRoutes:
    - opencode-go
    - zai-coding-cn
```

插件写入的是 `llm-pi-ai` 命名空间（`providers.<route>.models`）——与适配器消费的是同一份文档——并且只写它管理的路由。迁移期间，`keepBuiltinOnly` 会保留已安装内置目录中存在、但 pi.dev 上还没有的模型。

### 容量值是模型上限，不是你的运行时实配

同步进来的 `contextWindow` / `maxTokens` 描述的是**模型**在网关列表里宣称的上限，不是你的部署实际配置的值。dsh 解析时 settings 写入的值会压过内置目录，且写入的 `maxTokens` 会成为请求级默认值。如果某条路由实际指向一个上下文更小的本地/代理端点（vLLM / Ollama 之类），却带着目录级的容量值，正是 "Output token limit reached" 一族故障的常见配方（参见上游 #1166）。

需要某个模型在更小的预算下运行时，把它写进同路由的 `modelOverrides`——同步会把字段折叠进同步列表，并从本地 store 逐轮回放：

```yaml
providers:
  zai-coding-cn:
    modelOverrides:
      glm-5.3:
        contextWindow: 32768
```

另外列表数据本身可能有噪声：容量值有卫生门（正整数；`maxTokens` 必须严格小于 `contextWindow`），被剥离的值会在同步报告里以 `DEGRADED` 行连同原因出现。

### 手动刷新：`/model-sync` 命令

在任意交互式 UI 里输入 `/model-sync` 即可当场强制跑一轮同步。命令由插件自己注册进共享命令注册表（`@deepseek-ai/dsh-commands`），UI 自动发现。它返回与定时轮相同的报告；同步范围由 `managedRoutes` 决定，命令后面的参数一律忽略。没有命令注册服务的宿主会平滑降级——定时刷新与 `modelSync` 服务照常工作。

## 开发

```bash
npm run build   # tsc → lib/
npm run check   # tsc --noEmit 类型检查
npm test        # node --test（pretest 先构建）：diff / translate / writer / remote-catalog / serviceability / command
```

测试使用 `test/fixtures/` 下按路由组织的 pi.dev fixtures，并用临时目录充当 models store——绝不触碰真实的 `~/.dsh`。

`scripts/` 下的工具脚本：

- `generate-builtin-snapshot.mjs`——从已安装的 `@deepseek-ai/dsh-llm-pi-ai` catalog 重新生成 `src/builtin-catalog-snapshot.ts`（`--generate` 用于开发，`--check` 用于 CI）。
- `verify-no-patch.mjs`——若已安装的 `dsh-llm-pi-ai` 仍带有 overlay 补丁签名（`withRemoteCatalog` / `piAiCatalog`）则非零退出。
- `backup/backup-patched.mjs`——把打过补丁的 `dsh-llm-pi-ai/lib/index.js` 备份到 `backups/`。
- `backup/restore-official.mjs`——从 npm 恢复官方未打补丁的 `dsh-llm-pi-ai/lib/index.js`，并对照补丁校验（支持 `--dry-run`）。

仓库还保存了记录旧 overlay 行为的参考补丁：`docs-dsh-llm-pi-ai.patch`（`dsh-llm-pi-ai` 的 pi.dev remote-catalog overlay）与 `docs-dsh-llm-pi-ai-compat.patch`（`supportsDeveloperRole` compat 透传）。

## 许可证

MIT。

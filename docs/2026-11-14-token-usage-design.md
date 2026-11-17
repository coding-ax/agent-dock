# AgentDock Token 用量统计设计方案

状态：待讨论，未实现
日期：2026-11-14
范围：只读调研 + 方案；不改代码、不建表、不重启 daemon

## 1. 结论摘要

1. **现在能拿到的不是完整 token 用量。** AgentDock 目前只把 ACP `usage_update` 归一化成
   `status(state=usage)`，字段是 `used/size/breakdown/cost`；`used` 是“当前上下文占用”，
   不是这一轮或这个会话累计消耗的 token。见 `packages/acp-client/src/index.ts:74`。
2. **Claude 与 Codex 都有每轮明细，但入口不同。** 两家都在 prompt 响应里带
   `_meta.quota.token_count` 和 `model_usage`；acpx 会把 turn result 的 `_meta` 保留下来，
   而 AgentDock 目前在 `AcpAdapter` 收尾时把它丢了（`packages/acp-client/src/index.ts:357`）。
3. **不要从 events 现算 token 总量。** 现有 events 里没有 `input/output/cache/thought`，
   只有 2,467 条上下文快照；从 `used` 求和会得到错误答案。上下文和压缩量继续从 events 读，
   每轮 token 另建账本。
4. **建议新增“每轮主表 + 模型明细”两张表，而不是先做按天聚合表。** 本机量级下按轮落账
   每年约几万行，查询聚合很轻；按天聚合会丢失 task/model/父子会话等维度，且无法回填。
5. **准确优先于完整。** 没有 provider 明细时明确标为“仅上下文”，缺失字段写 `NULL` 而不是 0；
   成本只展示 provider 回报值或明确标注“估算”，不假装精确。

## 2. 数据源与缺口

### 2.1 ACP 标准字段

ACP v1 的 `UsageUpdate` 只有三项：

| 字段 | 含义 | 证据 |
|---|---|---|
| `used` | Tokens currently in context | `@agentclientprotocol/sdk@2.6.0/schema/v1/schema.json:4333-4338` |
| `size` | Total context window size | 同上 `:4339-4344` |
| `cost` | **Cumulative session cost**（可选） | 同上 `:4345-4356` |

标准 `PromptResponse` 只有 `stopReason` 和 `_meta`，没有 token 字段
（`schema/v1/schema.json:3489-3510`）。逐轮 `Usage` 在 unstable schema 里，字段包括
`totalTokens/inputTokens/outputTokens/thoughtTokens/cachedReadTokens/cachedWriteTokens`
（`schema/v1/schema.unstable.json:4389-4439`），但它是 **UNSTABLE**，不是所有 provider 都实现。

### 2.2 acpx 已经帮我们做的归一化

acpx 0.20.0 的运行时契约明确区分“每轮明细”和“上下文快照”：

- `AcpRuntimeUsageBreakdown` 的六个字段全部可选，注释明确要求消费方把缺失当成
  **unknown，不是 zero**：`acpx@0.20.0/dist/runtime.d.ts:136-148`。
- `AcpRuntimeSessionUsage.perRequest` 按 user-message id 保存每轮 breakdown：
  `runtime.d.ts:170-181`。
- `usage_update` 的 `_meta.usage` 会被归一化成 `breakdown`：
  `acpx@0.20.0/dist/runtime.js:461-470`、`:515-539`。
- 但 acpx 的 `request_token_usage` 只保留最近 100 轮：
  `acpx@0.20.0/dist/queue-owner-runtime-Be8sr9L5.js:4456-4460`。
  因此 **acpx 记录只能当短期缓存，不能当 AgentDock 的长期账本**。

注意一个容易踩的坑：acpx 的 `cumulative_token_usage` 名字看起来像累计值，但实现是
`conversation.cumulative_token_usage = usage`（直接覆盖），不是求和：
`acpx@0.20.0/dist/queue-owner-runtime-Be8sr9L5.js:4428-4436`。
所以不要把它当 session 总量，也不要把多次快照相加。

### 2.3 Claude Code

Claude ACP adapter 能提供三类数据：

1. **Prompt 响应里的每轮 usage**：`input_tokens/output_tokens/cache_read_input_tokens/
   cache_creation_input_tokens` 累加到 `session.accumulatedUsage`
   （`@agentclientprotocol/claude-agent-acp@0.106.0/dist/v1/acp-agent.js:4107-4118`），
   然后作为 `turnOutcome.usage` 返回（`:8313-8318`）。
2. **`usage_update` 的 cost 与模型信息**：`used/size/cost(amount,USD)`，模型放在
   `_meta["_claude/model"]`（`:4158-4174`、`:2071-2090`）。
3. **Prompt 响应里的 `_meta.quota`**：`token_count` + 按模型的 `model_usage`
   （`session-usage.js:8-20`、`v1/acp-agent.js:8313-8318`）。

Claude 的 `reasoningOutputTokens` 固定为 0，因为 thinking 被计在 output tokens 里，
不单独拆出（`session-usage.js:21-34`）。因此 Claude 的“推理 token”不能和 Codex 直接比较。

### 2.4 Codex

Codex ACP adapter 可以拿到：

1. **Prompt 响应里的每轮 usage**：`buildPromptUsage()` 返回
   `totalTokens/inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens/thoughtTokens`
   （`@agentclientprotocol/codex-acp@2.6.0/dist/index.js:33764-33782`、`:55209-55212`）。
2. **`_meta.quota`**：`token_count` + `model_usage`（`:55192-55202`、`:55159-55164`）。
3. **`usage_update` 只有上下文**：`used = lastTokenUsage.totalTokens`，`size =
   modelContextWindow`，没有每轮输入/输出拆分（`:39405-39431`）。

Codex 的 `inputTokens` 已经减掉 cache read/write（`index.js:33764-33772`），
且 `totalTokens` 是 provider 自己给的完整总量。和 Claude 的字段语义不完全一样，
展示时必须优先使用 provider 的 `totalTokens`，不要自己把不同来源的字段硬加。

### 2.5 其他 provider

内置 provider 从 acpx registry 动态发现，包括 Pi、Gemini、Cursor、Copilot、Droid、
Kimi、Qwen、Trae、OpenCode 等（`packages/config/src/index.ts:24-28`、`:40-46`）。
它们的能力分三档：

- **有标准 prompt `usage` 或 `_meta.usage`**：可拿到每轮明细，按 ACP unstable 字段解析。
- **只发 `usage_update`**：只能拿到上下文 used/size 和可选 cost，标记为“仅上下文”。
- **完全不发**：只能记录“未回报”，不要生成 0。

现有 AgentDock 归一化只透传 `used/size/breakdown/cost`
（`packages/acp-client/src/index.ts:74`），`_meta.usage` 的其它字段和
`_meta["_claude/model"]` 都被丢掉；turn result 的 `_meta` 也没有进入事件
（`packages/acp-client/src/index.ts:352-357`）。这是 P1 需要补的第一处。

### 2.6 现有库实测

本机 `/Users/codeax/workspace/agent-dock/.agentdock/agentdock.db` 的只读快照
（2026-11-08 为止）：

| 指标 | 值 |
|---|---:|
| events 行数 | 807,478 |
| sessions | 23 |
| tasks | 143 |
| `status(state=usage)` 事件 | 2,467 |
| 其中带 `breakdown` | 0 |
| 其中带 `cost` | 3 |
| events 表 + 两个索引占用 | 150 MB + 42 MB + 42 MB |

`select ... group by substr(timestamp,1,10)` 扫描 80 万行的实测约 0.05-0.06 秒。
这说明 **性能不是主要矛盾；数据不存在才是**。可以做一次性 cost/context 回填，
但不能从历史 events 反推出 input/output/cache。

同一会话的三条 cost 快照是递增的：`0.084735 → 0.106496 → 0.123583`
（同 session，USD）。这印证 `cost` 是 cumulative session cost，不能直接逐条相加。

## 3. 指标语义与准确性规则

### 3.1 三个不能混用的概念

| 概念 | 来源 | 用法 |
|---|---|---|
| 上下文占用 `context_used/context_size` | `usage_update.used/size` | 只表示“当前上下文里有多少”，可画占用环；不能求和 |
| 每轮 token `input/output/cache/thought/total` | prompt `_meta.quota` 或 unstable `usage` | 记账、按天/会话/模型聚合 |
| 成本 `cost` | `usage_update.cost` | provider 回报的 cumulative cost；需要做差分后才能按轮/按天归属 |

`context_used` 下降代表上下文被压缩，**不代表消耗减少**。现有前端把每次下降的差值累加为
“累计压缩掉”的 token（`apps/web/src/composer-utils.ts:191-209`，
`apps/web/src/Composer.tsx:72-77`），这个语义应保留，不能拿来当累计用量。

### 3.2 字段映射

内部统一使用以下字段：

```
input_tokens
output_tokens
thought_tokens
cached_read_tokens
cached_write_tokens
total_tokens
```

不同 provider 的别名归一到这套字段：

| 内部字段 | Claude `_meta.quota` | Codex `_meta.quota` | ACP unstable `Usage` |
|---|---|---|---|
| `cached_read_tokens` | `cachedInputTokens` | `cachedReadTokens` | `cachedReadTokens` |
| `cached_write_tokens` | `cachedWriteTokens` | `cachedWriteTokens` | `cachedWriteTokens` |
| `thought_tokens` | `reasoningOutputTokens`（恒 0） | `thoughtTokens` | `thoughtTokens` |

Claude 的 quota 形状来自 `session-usage.js:27-35`；Codex 来自
`index.js:33774-33782`。两者不是同一个形状，P1 必须同时兼容。

规则：

- `total_tokens` 优先用 provider 给的 `totalTokens`。
- provider 没给 total 但给了全部组成字段时，可以求和，但标记
  `total_tokens_estimated = 1`。
- 任何缺失字段写 `NULL`，不写 0。
- `0` 只有在 provider 明确回报 0 时才可信；反代/自研模型的 `used=0` 噪声继续按现有规则忽略
  （`apps/web/src/composer-utils.ts:197-202`）。
- `input_tokens` 是否包含 cache 由 provider 决定，展示时始终把 cache 单列，不把
  input + cache 相加来“修正” provider 的 total。

### 3.3 质量等级

每条账本记录带一个 `quality`：

| 值 | 含义 | UI 文案 |
|---|---|---|
| `exact` | provider 明确给出 total 和完整组成字段 | “provider 回报” |
| `partial` | provider 只给了部分字段，total 可用 | “部分字段缺失” |
| `estimated` | total 由字段求和得到，或成本由价格表估算 | “估算” |
| `context_only` | 只有 used/size，没有每轮 token | “仅上下文” |

聚合结果必须带覆盖率：

```
coverage: {
  turns: 44,
  exactTurns: 38,
  estimatedTurns: 2,
  partialTurns: 1,
  contextOnlyTurns: 3,
  costReportedTurns: 5
}
```

这样用户看到的 `1.83m` 不会被误解为“所有轮次都精确统计过”。

### 3.4 成本

P1 只做两件事：

1. 保存 provider 回报的 `cost_cumulative_amount` 和币种。
2. 在同一 session 内与上一条记录做差分，得到 `cost_amount`；第一次观测（没有上一锚点）
   只存 cumulative，不把历史全量算到这一轮。

不做的事情：

- 不把 `cost` 当每轮价格直接求和。
- 不在 P1 引入模型价格表。价格会变，反代/订阅/套餐的计费方式也不同，容易给出错误结论。
- 订阅账号的 `total_cost_usd` 可能只是 API 等价成本，不等于实际账单，文案必须写
  “provider 估算成本”，不能写“账单”。

P3 如果要做成本估算，单独增加价格表：

```
model_prices(model, currency, input_per_m, output_per_m,
             cache_read_per_m, cache_write_per_m,
             effective_from, source, updated_at)
```

价格表必须是用户可编辑/可覆盖的配置，并在 UI 标注“按价格表估算，不是账单”。

## 4. 归属维度

### 4.1 可用的归属键

| 维度 | 来源 | 说明 |
|---|---|---|
| session | `sessions.id` | 天然主键 |
| task / 轮次 | `tasks.id` + runtime `task.id` | 每轮一个 task；runtime 已有 `taskId` |
| assistant task / 便签 | `assistant_tasks.session_id` | 1 个侧边会话对应 1 个事项；assistant 库是独立文件，查询时映射 |
| agent / provider | `sessions.agent_id` | AgentDock 的 provider 就是 agent id |
| model | `sessions.model` + provider `_meta` | 会话中途可换模型，必须按轮快照 |
| 日期 | 轮次结束时间 | 存 `local_day`，默认 daemon 本地时区 |
| 父子会话 | `sessions.source/source_id` | 只有 `source='side-chat'` 时 `sourceId` 才是父会话 |
| 轮次来源 | `tasks.origin` | `maintenance/handoff/injected` 是系统轮次 |
| 来源渠道 | `sessions.source` | `side-chat/lark/import/delegated/...` |

证据：

- runtime 在每轮写用户锚点并带 `taskId/origin`：
  `packages/agent-runtime/src/index.ts:825-829`；task 记录结构：
  `packages/shared/src/index.ts:213`。
- 系统轮次集合：`SYSTEM_TURN_ORIGINS = ['injected','maintenance','handoff']`
  （`apps/server/src/assistant/service.ts:41-46`）；生命周期另外把
  `maintenance/handoff` 视为系统轮次（`apps/server/src/assistant/lifecycle-service.ts:31-32`）。
- 侧边会话：`source='side-chat'`, `sourceId=主会话 id`
  （`apps/server/src/assistant/service.ts:513-520`，`apps/web/src/side-chat-link.ts:12-19`）。
- 事项表按 `session_id` 关联，且 assistant 库是单独的
  `<database>.assistant.db`（`apps/server/src/assistant/store.ts:17-25`，
  `apps/server/src/assistant/service.ts:138`）。

### 4.2 主会话 / 子会话 / 系统轮次

- **主会话自己**：`task.origin` 为空或普通用户消息；正常计入。
- **侧边会话**：`source='side-chat'`，`parent_session_id` 存 `sourceId`。可以：
  - 默认按会话单独统计；
  - 提供 `includeChildren=1` 把子会话汇总到主会话，但必须避免父子重复计数。
- **定时任务**：`new_session` 也是 `side-chat`，`sourceId` 指向来源会话
  （`apps/server/src/schedules/service.ts:307`），因此会自然挂到父会话下。是否默认合并是开放问题。
- **系统轮次**：`maintenance` / `handoff` / `injected` 在账本里保留 `origin`，默认在总用量里
  单列“系统轮次”或可通过 `includeSystem` 排除。不能直接混进“用户用量”而不标注。
- **导入会话**：`source='import'`，历史轮次通常没有逐轮 usage；只记 context/cost（如果事件里有），
  token 字段保持 `NULL`，`quality='context_only'` 或 `unsupported`。

### 4.3 模型切换

`session.model` 可以在运行中改变（`packages/agent-runtime/src/index.ts:1085-1097`），
所以不能用会话当前模型回填历史。每轮记录：

- 优先 provider `_meta.quota.model_usage` 的模型名；
- 没有时用该轮开始时的 `session.model` 快照；
- 两者都没有时写 `model=NULL`，不要猜。

一轮可能跨多个模型（Claude 的 `model_usage` 可以多行），所以模型明细必须允许一轮多行。

## 5. 存储方案

### 5.1 选型

**P1 采用“每轮主表 + 模型明细”，不建按天聚合表，也不从 events 现算 token。**

理由：

1. events 里没有逐轮 token，现算只能算 context/cost，无法满足需求。
2. 按天+会话+模型聚合会丢失 task、origin、父子会话、成本锚点，后续无法补。
3. 本机量级：每天几十到几百轮，一年几万行；按天/会话/模型 GROUP BY 是毫秒级，
   不需要维护物化表。等单表超过约 100 万行或 p95 超过 200ms，再加 `usage_daily`。
4. 保留期可以独立于 events，历史 events 被压缩/清理也不影响账本。

### 5.2 表结构草案

```sql
CREATE TABLE IF NOT EXISTS usage_turns (
  id TEXT PRIMARY KEY,
  turn_key TEXT NOT NULL UNIQUE,
  request_id TEXT,
  session_id TEXT NOT NULL,
  task_id TEXT,
  parent_session_id TEXT,
  agent_id TEXT NOT NULL,
  origin TEXT,
  session_source TEXT,
  occurred_at TEXT NOT NULL,
  local_day TEXT NOT NULL,
  context_used INTEGER,
  context_size INTEGER,
  cost_amount REAL,
  cost_cumulative_amount REAL,
  cost_currency TEXT,
  quality TEXT NOT NULL,
  usage_source TEXT NOT NULL,
  raw TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_turns_day
  ON usage_turns(local_day, agent_id);
CREATE INDEX IF NOT EXISTS usage_turns_session
  ON usage_turns(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS usage_turns_task
  ON usage_turns(task_id);
CREATE INDEX IF NOT EXISTS usage_turns_parent
  ON usage_turns(parent_session_id, local_day);

CREATE TABLE IF NOT EXISTS usage_turn_models (
  turn_id TEXT NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
  model TEXT,
  model_key TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER,
  output_tokens INTEGER,
  thought_tokens INTEGER,
  cached_read_tokens INTEGER,
  cached_write_tokens INTEGER,
  total_tokens INTEGER,
  total_tokens_estimated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, model_key)
);

CREATE INDEX IF NOT EXISTS usage_turn_models_model
  ON usage_turn_models(model_key);
```

字段说明：

- `turn_key`：AgentDock 内部轮次稳定键，优先 `task_id`；没有 task 时用
  `${session_id}:${request_id}`。用于幂等 upsert，避免重试重复记账。
- `task_id`：AgentDock `tasks.id`，按轮统计的主键。
- `parent_session_id`：只在 `session.source='side-chat'` 时填 `sourceId`，不要对 `lark`
  的复合 `sourceId` 误判。
- `agent_id`：provider/agent 维度。
- `occurred_at`：轮次结束时间，ISO UTC；`local_day` 是写入时按 daemon 本地时区算出的
  `YYYY-MM-DD`，避免查询时依赖当前时区。
- `context_used/context_size`：该轮最后一次有效上下文快照；仅用于会话头部，不参与 token 求和。
- `cost_amount`：本轮可归属成本（按 cumulative 差分）；无法归属时为 `NULL`。
- `cost_cumulative_amount`：provider 原始累计成本；用于下一次差分。
- `quality`：`exact/partial/estimated/context_only/unsupported`。
- `usage_source`：`quota_meta` / `prompt_usage` / `usage_update_meta` /
  `context_snapshot` / `backfill_cost`。
- `raw`：仅保存必要原始账本（可选），不要存完整 prompt/回复。

不把 `assistant_task_id` 落库：assistant 库是独立 SQLite 文件，运行时也拿不到事项 id；
查询时用 `assistant_tasks.session_id` 反查即可，避免双写和不一致。

### 5.3 保留与回填

- 账本默认保留 24 个月，可配置；它是小表，保留成本远低于 events。
- P1 上线前历史不补 token；只做一次可选回填：
  - `context_used/context_size` 从历史 `status(state=usage)` 取每轮最后一条；
  - `cost_cumulative_amount` 从历史 cost 取，按 session 差分；
  - token 字段保持 `NULL`，`usage_source='backfill_cost'`，UI 显示“历史无逐轮明细”。
- 明确写一个 `usage_since` 配置/提示，告诉用户“从某天起才有完整 token 数据”。

## 6. 采集链路

### 6.1 推荐路径

```
ACP agent
  └─ prompt response._meta.quota
       ├─ token_count      → 每轮总量/组成
       └─ model_usage[]    → 每轮按模型拆分
  └─ usage_update
       ├─ used/size        → 本轮最后一次上下文快照
       ├─ cost             → 本轮最后一次累计成本
       └─ _meta.usage      → 部分 adapter 的每轮 breakdown（备用）
        ↓
AcpxAdapter turn result / normalized events
        ↓
AgentDockRuntime runTask 收尾
        ↓
usage_turns + usage_turn_models（best-effort，不影响任务状态）
```

### 6.2 Adapter 层

- 在 `AcpAdapter.sendTurn()` 内收集本轮归一化事件中的：
  - 最后一次有效 `used/size`；
  - 最后一次 `cost`；
  - 最后一次非空 `breakdown`（来自 `_meta.usage`）。
- `turn.result` 成功后读取 `result._meta.quota`。Claude 与 Codex 都会带，
  但字段别名不同，使用第 3.2 节的映射。
- 不要用 `getStatus().usage.cumulative` 作为总量；它可能只是最后一次 usage。
  如需兜底，只用 `perRequest` 中本轮新增的 key，并明确标记来源。
- 将结果作为 `AgentDriver` 的可选 `usage` 返回值/回调交给 runtime，而不是塞进时间线事件。
  这样不会增加 events 体积，也不会让 `status` 事件承担账本职责。

### 6.3 Runtime 层

- 在 `runTask()` 的任务收尾阶段（成功、失败、中断都可）调用一次
  `recordUsage(session, task, snapshot)`。
- 写入必须 best-effort：捕获异常、记 warn，不改变 task/session 状态。
  账本失败不能让用户的轮次失败。
- 幂等：`turn_key = task.id`，重复调用走 upsert。
- 如果 `result.status === 'failed'` 且没有 quota，仍记录 context_only（如果有上下文），
  便于解释失败轮次的上下文占用；没有就完全不写。

### 6.4 非 ACP 协议

`jsonl/pipe/pty` 没有结构化 usage，P1 标记 `unsupported`，不阻塞。后续如果某家 CLI 的
raw 输出里有稳定 usage 字段，再单独加 parser，不要用正则猜。

## 7. HTTP 接口草案

命名注意：现有 `/api/codex/usage`、`/api/claude/usage`、`/api/cursor/usage` 是**账号额度**，
不是 token 用量。新接口统一用 `/api/token-usage`，避免和额度混淆。

### 7.1 汇总

```http
GET /api/token-usage/summary
  ?from=2026-11-14
  &to=2026-11-14
  &groupBy=agent|model|session|task|day
  &sessionId=<可选，限定会话>
  &agentId=<可选>
  &includeSystem=0|1
  &includeChildren=0|1
```

响应：

```json
{
  "range": { "from": "2026-11-14", "to": "2026-11-14", "tz": "Asia/Shanghai" },
  "totals": {
    "totalTokens": 1830000,
    "inputTokens": 420000,
    "outputTokens": 96000,
    "cachedReadTokens": 1200000,
    "cachedWriteTokens": 8000,
    "thoughtTokens": 114000,
    "cost": { "amount": 0.42, "currency": "USD", "estimated": false }
  },
  "coverage": {
    "turns": 44,
    "exactTurns": 38,
    "partialTurns": 1,
    "estimatedTurns": 2,
    "contextOnlyTurns": 3,
    "costReportedTurns": 5
  },
  "groups": [
    {
      "key": "agent:codex",
      "label": "Codex",
      "turns": 30,
      "totalTokens": 1400000,
      "quality": "exact",
      "models": ["gpt-5.1-codex"]
    }
  ],
  "since": "2026-11-14"
}
```

### 7.2 会话 / 任务明细

```http
GET /api/token-usage/sessions/:sessionId?from=&to=
GET /api/token-usage/sessions/:sessionId/turns?limit=50&before=<iso>
GET /api/token-usage/tasks/:taskId
```

会话响应包含：

- 会话总量与按 turn 的最近记录；
- 当前上下文 `context_used/context_size`（从 events 或最新 turn 记录读）；
- `parentSessionId`、`source`、`agentId`、`model`；
- `assistantTaskId`（服务端用 assistant 库映射）；
- `coverage`。

### 7.3 权限

- `GET /api/token-usage/summary` 跨会话聚合，只有 master token 可读。
- `GET /api/token-usage/sessions/:id*`、`/tasks/:id` 允许 session token，但只能读本会话。
  现有 `sessionTokenAllows` 对 `/api/sessions/:id` 前缀放行，新接口需要在
  `apps/server/src/web-access.ts:171-178` 增加对应的参数/路径判断。
- 所有接口只读，无写操作。

## 8. CLI 草案

命令：`agent-dock usage`（token 用量；账号额度仍用现有 `AgentUsagePanel`/额度接口）。

```bash
agent-dock usage --today
agent-dock usage --since 7d
agent-dock usage --from 2026-11-01 --to 2026-11-14
agent-dock usage --session ses_xxx
agent-dock usage --agent codex
agent-dock usage --group-by model
agent-dock usage --include-system
agent-dock usage --json
```

默认：今天、按 agent 汇总、排除 `maintenance/handoff/injected` 系统轮次（但显式打印
“已排除 N 个系统轮次”）。

文本样例：

```
Token usage · 2026-11-14 · Asia/Shanghai
Agent    Model             Turns   Input   Output   Cache R/W      Reasoning   Total
codex    gpt-5.1-codex       12    45.2k    18.1k   120.0k / 0          6.1k   183.3k
claude   sonnet-4.5           3     2.1k     4.0k    60.0k / 8.0k         —     74.1k

Total: 257.4k tokens across 15 turns
Coverage: 14/15 exact, 1 context-only; cost reported for 3 turns ($0.42)
Excluded: 2 system turns (maintenance=1, handoff=1)
```

`--json` 必须稳定，包含 `totals/coverage/groups/range`，方便脚本和后续 UI 复用。

## 9. UI 草图

### 9.1 会话头部

在现有会话标题/Agent/状态行右侧，新增一个轻量入口：

```
┌──────────────────────────────────────────────────────────────────┐
│ 会话标题                                      [◔ 18%] [183k ⓘ] [⋯] │
│ Codex · 运行中 · ~/workspace                                     │
└──────────────────────────────────────────────────────────────────┘
```

`183k` 是**本会话累计 token**，悬停：

```
本会话累计 183.3k tokens（12 轮）
输入 45.2k · 输出 18.1k · 缓存读 120.0k · 推理 6.1k
1 轮仅上下文，未计入总量
provider 回报，非账单
```

不要把这个数字放进现有上下文圆环的百分比里；上下文圆环继续只表示 `used/size`。

### 9.2 设置页用量面板

在现有 Agent 额度面板旁边新增“Token 用量”卡片，标题明确写“Token 用量（非账号额度）”：

```
┌ Token 用量 ────────────────────────────────────────────────┐
│ 今日   7 天   30 天   自定义     [仅用户轮次 ☑] [含系统轮次 ☐] │
│ 总计 1.83m   输入 420k   输出 96k   缓存读 1.2m   推理 114k │
│ 覆盖 41/44 轮（3 轮仅上下文）        provider 成本 $0.42     │
│                                                            │
│ Agent   模型             轮次   总量      占比               │
│ Codex   gpt-5.1-codex     30    1.40m    ███████████░ 76%   │
│ Claude  sonnet-4.5         8    430k     ███░░░░░░░░░ 24%   │
│                                                            │
│ [按天趋势 ▁▂▅▇▆▃▂]  [导出 CSV]                             │
└────────────────────────────────────────────────────────────┘
```

### 9.3 便签卡片

侧边会话的便签底部加一行小字，不抢主信息：

```
┌ 修复登录跳转 ─────────────────────┐
│ 已完成，等验收                      │
│ 183k tokens · 12 轮                 │
└────────────────────────────────────┘
```

只显示本事项会话的累计值；点开进入会话详情。没有逐轮明细时显示“仅上下文”，不写 0。

### 9.4 状态栏

不建议在全局状态栏再放一个总量；会话头部和设置页足够。全局状态栏容易让人误以为是
账号余额，和额度面板冲突。

## 10. 分阶段计划与验收标准

### P1：采集 + CLI

范围：

- 新增 `usage_turns` / `usage_turn_models` 与迁移；
- Adapter 归一化 `_meta.quota` / `_meta.usage` / context / cost；
- Runtime 收尾 best-effort 落账；
- `agent-dock usage`（`--today/--since/--from/--to/--session/--agent/--group-by/--json`）。

验收：

1. Claude 与 Codex 各跑至少 5 轮，账本每轮 `total/input/output/cache/thought` 与
   provider 原始 `_meta.quota` 一致；多模型轮次能拆成多行。
2. 只有 `usage_update` 的 provider，账本写 `context_only`，`total_tokens IS NULL`，
   CLI 明确显示“仅上下文”，不出现 0。
3. `used` 下降（压缩）不改变 `total_tokens`；compaction 事件仍只影响上下文/“压缩掉”指标。
4. 账本写入失败时任务仍能完成，错误只进日志；重复调用同一 `turn_key` 不产生重复行。
5. daemon 重启后数据仍在；迁移可重复执行；旧数据库无破坏。
6. `pnpm typecheck`、相关单测、`pnpm build` 通过；在隔离沙箱
   `node apps/server/dist/cli.js dev up` 完成端到端验证。

### P2：HTTP + 网页

范围：

- `/api/token-usage/*`；
- 会话头部 pill + tooltip；
- 设置页用量面板；
- 便签卡片小字；
- master/session token 权限。

验收：

1. 会话头部显示的本会话累计值等于 `/api/token-usage/sessions/:id` 的 totals；
   上下文百分比仍等于 events 的 `used/size`。
2. 会话 token 只能读自己的用量；跨会话 summary 返回 403。
3. 44 轮/80 万 events 的测试库上，summary p95 < 200ms；页面不产生 N+1 请求。
4. 移动端 390px 宽度下头部 pill 不换行、不遮挡停止按钮；设置面板可滚动。
5. `context_only`/`partial` 的角标和 tooltip 在浅色/深色主题都可读。

### P3：预算 / 告警

范围：

- 日/月预算，按 agent/session 可选；
- 超阈值通知（复用现有 notify；静默时段已下线，不再做免打扰延迟）；
- 可选价格表成本估算（明确标注估算）。

验收：

1. 预算按本地日/月边界重置；同一周期只告警一次，不重复轰炸。
2. 无 token 明细的轮次不触发“超额”误报；预算页显示覆盖率。
3. 告警通知立即发送；关闭预算后不再计算/发送。
4. 价格表变更只影响之后的新记录，不改写历史；历史估算值带 `estimated` 标记。

## 11. 风险与开放问题

### 11.1 风险

- **ACP unstable 字段会变。** `_meta.quota` 和 `usage` 都不是稳定协议；需要 adapter 层做
  宽松解析、别名兼容和 unknown 降级，不能把字段当永远存在。
- **provider 语义不可比。** Claude 的 reasoning 在 output 里，Codex 单列 `thoughtTokens`；
  cache 计费方式也不同。UI 必须分开列，不要只给一个“总量”排名。
- **acpx 记录不是账本。** 只保留最近 100 轮，且 `cumulative` 不是真累计；
  不能把 `~/.agentdock/acpx/sessions/*.json` 当长期数据源。
- **成本不是账单。** 订阅/反代/OAuth 下的 provider 成本可能是等价成本，不是实际扣费。
- **事件与账本双写不一致。** 账本写入失败不能影响任务；需要幂等、可重试、可回填。
- **权限。** 跨会话用量是敏感数据；summary 仅 master，session token 只能看本会话。

### 11.2 需要拍板的问题

1. **统计范围**：默认是否包含 `maintenance/handoff/injected` 系统轮次？建议账本全记，
   CLI/UI 默认排除并在页脚说明“已排除 N 个系统轮次”。
2. **成本口径**：P1 只展示 provider 回报的 cumulative/差分，还是同时接受模型价格表估算？
   建议 P1 只做 provider 回报，P3 再做可选价格表。
3. **保留期**：账本保留多久？建议默认 24 个月、可配置；events 的保留策略不跟账本绑定。
4. **父子汇总**：主会话视图默认是否把侧边会话/定时任务会话合并进来？建议默认分开，
   提供 `includeChildren=1` 的显式汇总，避免主会话和子会话重复计数。
5. **展示策略**：没有逐轮明细时，是隐藏总量还是显示“仅上下文 + 覆盖率”？
   建议显示覆盖率和 `context_only` 角标，绝不把缺失当 0。

## 12. 非目标

- 不做精确账单/发票金额。
- 不把账号额度（Codex/Claude/Cursor 套餐）和 token 用量混成一个指标。
- 不用字符数/上下文 used 反推 token 消耗。
- 不为历史数据编造 input/output/cache。
- 不在本方案内实现代码、建表或迁移。

## 13. 证据索引

| 结论 | 文件与行号 |
|---|---|
| AgentDock 只透传 used/size/breakdown/cost | `packages/acp-client/src/index.ts:74` |
| turn result 的 `_meta` 当前被丢弃 | `packages/acp-client/src/index.ts:352-357` |
| ACP 标准 UsageUpdate 只有 used/size/cost | `@agentclientprotocol/sdk@2.6.0/schema/v1/schema.json:4329-4365` |
| ACP 标准 PromptResponse 没有 usage | `@agentclientprotocol/sdk@2.6.0/schema/v1/schema.json:3489-3510` |
| ACP unstable Usage 字段 | `@agentclientprotocol/sdk@2.6.0/schema/v1/schema.unstable.json:4389-4439` |
| acpx breakdown 缺失应视为 unknown | `acpx@0.20.0/dist/runtime.d.ts:136-148` |
| acpx perRequest 只保留最近 100 轮 | `acpx@0.20.0/dist/queue-owner-runtime-Be8sr9L5.js:4456-4460` |
| acpx cumulative 是覆盖不是累计 | `acpx@0.20.0/dist/queue-owner-runtime-Be8sr9L5.js:4428-4436` |
| acpx 从 `_meta.usage` 归一化 breakdown | `acpx@0.20.0/dist/runtime.js:461-470`、`:515-539` |
| Claude 累加每轮 input/output/cache | `@agentclientprotocol/claude-agent-acp@0.106.0/dist/v1/acp-agent.js:4107-4118` |
| Claude usage_update 带 cost 和模型 meta | `@agentclientprotocol/claude-agent-acp@0.106.0/dist/v1/acp-agent.js:4158-4174` |
| Claude prompt 结果带 usage + quota | `@agentclientprotocol/claude-agent-acp@0.106.0/dist/v1/acp-agent.js:8313-8318` |
| Claude reasoning 合并在 output | `@agentclientprotocol/claude-agent-acp@0.106.0/dist/session-usage.js:21-35` |
| Codex 每轮 usage 字段 | `@agentclientprotocol/codex-acp@2.6.0/dist/index.js:33764-33782` |
| Codex prompt 结果带 quota | `@agentclientprotocol/codex-acp@2.6.0/dist/index.js:55159-55202` |
| Codex usage_update 只有 used/size | `@agentclientprotocol/codex-acp@2.6.0/dist/index.js:39405-39431` |
| 系统轮次 origin 集合 | `apps/server/src/assistant/service.ts:41-46` |
| 生命周期系统轮次 | `apps/server/src/assistant/lifecycle.ts:668-675` |
| 侧边会话父子关系 | `apps/server/src/assistant/service.ts:513-520`、`apps/web/src/side-chat-link.ts:12-19` |
| 事项与 session 的映射；assistant 独立库 | `apps/server/src/assistant/store.ts:17-25`、`apps/server/src/assistant/service.ts:138` |
| 模型可中途切换 | `packages/agent-runtime/src/index.ts:1085-1097` |
| 事件表结构 | `packages/storage/src/index.ts:79-96` |
| 上下文压缩语义 | `apps/web/src/composer-utils.ts:191-209`、`apps/web/src/Composer.tsx:72-77` |
| session token 只允许读本会话 | `apps/server/src/web-access.ts:171-178` |

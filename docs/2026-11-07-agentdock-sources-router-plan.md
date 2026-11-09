# AgentDock 消息源与 Router：任务清单与验收标准

> 状态：草案 · 2026-11-07 · **2026-11-09 起暂停推进**：方向改为 Persona 式主会话，见 [`2026-11-09-agentdock-main-session-design.md`](2026-11-09-agentdock-main-session-design.md)（评审中）。新设计第 1.2 节列出了本计划的问题，第 7 节写明 P0 代码哪些保留、哪些删除。
> 范围：Source Ingress、Case/Router、Session Orchestration、Action/Reply
> 一句话：让外部消息可靠地进入 AgentDock，由轻量 Router 判断并分派到正确的会话，持续跟踪到闭环。

## 0. 背景

用户希望在 AgentDock 上增加一种通用能力：

- 消息源不限于飞书，也可以是 GitHub Issues、PR、CI、邮件、自定义 HTTP。
- 消息源可以由 Agent 按协议实现，支持 Python / JavaScript / Go 等语言。
- 新消息或更新进入后，由一个轻量的 Router Agent 判断该做什么，并在 AgentDock 里创建或复用会话。
- Router 能管理这些会话、跟踪后续变化、在会话之间传递信息，必要时通知人。
- 消息源进程由 AgentDock 托管，能看到状态、日志和运行情况。

这里不做“通用代码执行引擎”。AgentDock 负责的是：接入、去重、路由、编排、跟踪、审计。具体的外部系统逻辑放在 Source Worker 里，用协议通信。

## 1. 目标与非目标

### 1.1 目标

1. 外部事件可靠进入 AgentDock：至少一次投递、幂等、可重放、可观测。
2. 同一外部对象（issue、PR、飞书话题）的后续变化归到同一个 Case，不重复开会话。
3. Router 能根据事件、候选 Case、工作区和策略，决定忽略、通知、追加、新建、重开或升级。
4. Router 能创建和管理 Worker Session，Worker 能向 Router 汇报，人也能直接和 Router 对话。
5. 支持后续跟踪：等 CI、等回复、定时提醒、超时升级，不靠 Router 常驻进程或 `sleep`。
6. Source、Case、Router、Session 的关系在 Web 和 CLI 里都能看清。
7. 外部内容按不可信输入处理；高风险动作可拦截、可审计。

### 1.2 非目标

- 不做通用工作流 DSL，不做任意条件分支和审批编排。
- 不在 P0 里内置 Python / JavaScript / Go 解释器，也不执行任意用户代码。
- 不自动 merge、部署、删除生产资源；这些动作需要单独授权。
- 不做多租户、跨机器调度；P0 只覆盖当前 daemon 所在机器。
- 不替换现有飞书 @ 唤醒行为；飞书 Source 是增量能力。

## 2. 术语与边界

| 术语 | 含义 |
| --- | --- |
| **Source** | 一个消息源实例，例如“GitHub acme/api issues”“飞书告警群”。 |
| **Event** | Source 上报的一条标准化事件；新建和更新都是 Event。 |
| **Case** | 一段持续跟踪的事项，例如一个 issue 从创建到关闭。 |
| **Binding** | Case 与外部对象、Session、Router 的关联。 |
| **Router** | 轻量总控 Agent，负责判断和派发，不亲自做重活。 |
| **Worker** | 真正执行任务的 AgentDock Session。 |
| **Watch** | 挂在 Case 上的后续条件，例如等评论、等 CI、等超时。 |
| **Action** | 回写到外部系统的动作，例如评论 issue、更新卡片。 |

**Case 是跟踪单元，Session 是执行单元。** 一个 Case 可以先后对应多个 Session；Router 的长期记忆主要落在 Case 时间线，而不是某一个 Session 的上下文里。

## 3. 总体架构

```text
外部系统（飞书 / GitHub / 自定义）
        │ webhook / poll / stream
        ▼
Source Worker / Built-in Adapter
        │ 统一 Event Envelope
        ▼
Ingress Gateway ──► Event Store（去重 / 游标 / 重放 / 死信）
                        │
                        ▼
                  Triage（规则预过滤 → Router Agent）
                        │
                        ▼
                  Case / Binding Store
                        │
                        ▼
                Session Orchestrator
                   │             ▲
                   ▼             │ task / completed / error / permission
               Worker Sessions ──┘
                   │
                   ▼
               Action / Reply ──► 外部系统
```

### 3.1 两段式路由

1. **规则层**：source、event type、repo、label、actor、关键词、是否机器人，先做廉价过滤。
2. **关联层**：按 `correlationKey` 找已有 Case；找到就追加，不需要模型。
3. **Router 层**：只有未匹配、语义模糊、需要判断工作区/优先级时才调模型。
4. **策略层**：预算、并发、权限、冷却、人工确认，最后一道闸。

### 3.2 组件职责

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Source Supervisor | 启动/停止 worker、心跳、重启、日志、环境变量 | 不理解业务语义 |
| Ingress Gateway | 鉴权、校验、去重、游标、落库 | 不判断该开哪个会话 |
| Router | 语义判断、选择动作、选择工作区/Agent | 不直接写库、不亲自改代码 |
| Case Service | Case 生命周期、时间线、绑定 | 不调用模型 |
| Session Orchestrator | 创建/复用 Session、派发、等待、中断、归档 | 不决定业务优先级 |
| Action Executor | 评论、更新状态、重试、幂等 | 不创建 Session |

## 4. 数据模型

P0 新增以下表。字段可以在实现时微调，但唯一约束和状态机不变。

| 表 | 关键字段 | 唯一约束 / 索引 |
| --- | --- | --- |
| `source_instances` | `id`, `name`, `kind`, `enabled`, `config`, `secret_refs`, `router_session_id`, `status`, `last_event_at`, `last_error`, `created_at`, `updated_at` | `id` 主键 |
| `source_events` | `id`, `source_id`, `external_event_id`, `event_type`, `dedupe_key`, `correlation_key`, `occurred_at`, `received_at`, `status`, `payload`, `raw`, `trace_id`, `causation_id` | `(source_id, dedupe_key)` 唯一 |
| `source_checkpoints` | `source_id`, `cursor`, `updated_at` | `source_id` 主键 |
| `cases` | `id`, `source_id`, `correlation_key`, `open_key`, `title`, `status`, `priority`, `router_session_id`, `primary_session_id`, `summary`, `created_at`, `updated_at`, `closed_at`, `close_reason` | `(source_id, open_key)` 唯一，`open_key` 为 NULL 时不参与 |
| `case_events` | `id`, `case_id`, `source_event_id`, `kind`, `summary`, `data`, `created_at` | `(case_id, source_event_id)` 唯一 |
| `case_sessions` | `case_id`, `session_id`, `role`, `created_at` | `(case_id, session_id)` 主键 |
| `case_watches` | `id`, `case_id`, `source_id`, `condition`, `expires_at`, `status`, `created_at`, `fired_at` | `id` 主键；`(case_id, status)` 索引 |
| `source_actions` | `id`, `source_id`, `case_id`, `action_type`, `target`, `payload`, `idempotency_key`, `status`, `attempts`, `last_error`, `created_at`, `updated_at` | `(source_id, idempotency_key)` 唯一 |
| `router_inbox` | `id`, `router_session_id`, `case_id`, `kind`, `dedupe_key`, `payload`, `status`, `available_at`, `created_at`, `dispatched_at` | `(router_session_id, dedupe_key)` 唯一 |

状态机：

- `Case`：`open -> waiting -> open -> closed`；`waiting` 表示已派发 Worker，等待结果或外部变化。
- `Watch`：`active -> fired | cancelled | expired`。
- `Action`：`pending -> running -> succeeded | failed | dead`。
- `RouterInbox`：`pending -> dispatched -> done`。

## 5. 协议与接口

### 5.1 Source manifest

```json
{
  "id": "src_github_acme",
  "name": "GitHub Issues · acme",
  "version": "1.0.0",
  "kind": "webhook",
  "configSchema": {},
  "secretRefs": ["GITHUB_WEBHOOK_SECRET"],
  "events": ["issue.created", "issue.updated", "issue_comment.created", "pr.review_requested"],
  "actions": ["comment"],
  "correlation": { "mode": "object" },
  "cursor": "opaque"
}
```

### 5.2 Event Envelope

```json
{
  "specVersion": "agentdock.source.v1",
  "sourceId": "src_github_acme",
  "eventId": "evt_...",
  "eventType": "issue_comment.created",
  "dedupeKey": "github:12345:comment:67890",
  "occurredAt": "2026-11-07T10:00:00Z",
  "object": {
    "type": "issue",
    "id": "acme/api#123",
    "url": "https://github.com/acme/api/issues/123",
    "title": "启动时报错"
  },
  "actor": { "id": "u_1", "name": "张三", "isBot": false },
  "correlationKey": "github:acme/api#123",
  "payload": {},
  "raw": "...",
  "causationId": null,
  "traceId": "trace_..."
}
```

### 5.3 Ingress

```text
POST /api/sources/:id/events       外部/worker 上报事件
GET  /api/sources/:id/checkpoint   读取游标
POST /api/sources/:id/heartbeat    worker 心跳
POST /api/sources/:id/actions      可选：daemon 调 worker 执行回写
GET/POST/PATCH /api/sources        管理源
```

鉴权与限制：

- `X-AgentDock-Signature: sha256=...`，HMAC 覆盖原始 body。
- `X-AgentDock-Timestamp`，默认允许 5 分钟偏差，超出返回 401。
- 默认 body 上限 1 MiB，可配置。
- 先持久化，再返回 `202`；重复事件返回 `200` 和 `duplicate:true`。

### 5.4 投递语义

- 至少一次投递，Source 必须提供稳定 `dedupeKey`。
- `source_events` 落库成功后才推进游标。
- 失败重试、指数退避、死信；重放不会产生重复 Case / Task / Action。
- 更新事件必须带原对象 `correlationKey`，不能被当成新 Case。

### 5.5 Router 决策

Router 必须输出可校验 JSON：

```json
{
  "decision": "append",
  "caseId": "case_...",
  "session": {
    "mode": "reuse",
    "sessionId": "ses_...",
    "agentId": "codex",
    "workspace": "acme/api",
    "model": "gpt-5"
  },
  "task": { "prompt": "...", "mode": "queue" },
  "watch": {
    "on": ["issue_comment.created", "ci.completed"],
    "until": "2026-11-08T10:00:00Z",
    "timeoutMinutes": 120
  },
  "reply": { "action": "comment", "target": "acme/api#123" },
  "reason": "同一 issue 的补充信息，已有排查会话仍有效",
  "confidence": 0.86
}
```

允许的 `decision`：`ignore`、`notify`、`append`、`create`、`reopen`、`escalate`。

### 5.6 Worker 协议（P1）

语言无关，HTTP + JSON：

- `GET /health`：健康检查。
- `POST /events`：向 AgentDock 上报事件。
- `GET /checkpoint`：读取 daemon 保存的游标。
- `POST /heartbeat`：心跳。
- `POST /actions`：接收 daemon 下发的回写动作（可选）。

## 6. 工作约束

- 遵守根目录 `AGENTS.md`。
- 不在会话里执行 `agent-dock restart / stop / update`、`npm install -g` 或 kill 正式 daemon。
- 每次改完先跑相关单测和 `pnpm typecheck`；涉及 API、CLI、调度、daemon 或前端时，`pnpm build` 后用 `node apps/server/dist/cli.js dev up` 起隔离沙箱做端到端验证，完成后 `dev down`。
- 当前工作区可能已有未提交改动，不要回滚或覆盖无关文件。
- 未经用户要求不提交。
- 浏览器验收只用 ego-browser；不引入 Playwright、Puppeteer 或无头 Chromium。
- 用户可见文案用中文；`sourceId`、`caseId`、`sessionId`、错误码保留原文。
- 数据库迁移必须向后兼容，不删除或重命名现有列。

## 7. 任务清单

### 任务总览

| 阶段 | 任务 | 交付物 | 核心验收 |
| --- | --- | --- | --- |
| P0 | T1 | 领域类型、表、repository | 唯一约束、迁移兼容、并发不重复 |
| P0 | T2 | Source CRUD API/CLI | 创建、启停、脱敏、试跑 |
| P0 | T3 | Ingress 网关 | 签名、去重、游标、重启恢复 |
| P0 | T4 | Case 聚合与生命周期 | 同 key 一个 Case、更新追加、关闭/重开 |
| P0 | T5 | Router Session + 决策 | JSON 校验、兜底、限额、dry-run |
| P0 | T6 | 跨会话编排 | 创建/派发/等待、越权拒绝、幂等 |
| P0 | T7 | Router Inbox + Watch | 终态唤醒、合并、重启、超时 |
| P0 | T8 | GitHub Source + 评论 Action | 签名、映射、只评论一次、防自激 |
| P0 | T9 | Web/CLI/可观测 | Source/Case/Router 可见可操作 |
| P0 | T10 | E2E + 文档 | 全链路、重复执行、质量门禁 |
| P1 | T11 | Worker Supervisor | 启停、心跳、重启、无孤儿进程 |
| P1 | T12 | 多语言 SDK | Node/Python/Go 通过一致性测试 |
| P1 | T13 | 飞书 Source | 群消息进入 Case，@ 行为不变 |
| P1 | T14 | Action 扩展 | 策略、人工确认、幂等/死信 |
| P2 | T15 | 跨源关联与高级追踪 | 多源同一 Case、SLA 升级 |
| P2 | T16 | 多 Router、团队与成本 | 路由隔离、预算/配额 |
| P2 | T17 | 沙箱与模板市场 | 越权阻止、安装可回滚 |

### P0：通用 Webhook + 一个真实 Source + Router 闭环

P0 默认用 **GitHub Issues** 作为第一个 Source。理由是 webhook 签名、幂等和本地模拟都容易验证；飞书群消息权限是已知的外部阻塞项，放到 P1。

#### T1 存储与领域模型

**目标**：让 Source、Event、Case、Binding、Inbox、Action 有持久化落点，后续服务只依赖 repository。

**改动**

- `packages/shared/src/index.ts`：新增领域类型和 repository 接口。
- `packages/storage/src/schema.ts`：新增第 4 节的表。
- `packages/storage/src/index.ts`：建表、索引、repository 实现。
- `packages/storage/src/*.test.ts`：唯一约束、状态机、并发测试。

**验收条件**

1. 在已有数据库上启动，新表自动创建；现有 `sessions`、`events`、`schedules` 数据不受影响。
2. 重复写入同一 `(source_id, dedupe_key)` 只保留一条，第二次返回已存在记录而不是抛未处理异常。
3. 同一个 `(source_id, open_key)` 同时只能有一个 open Case；Case 关闭后 `open_key` 置 NULL，同 key 可以新建 Case。
4. 同一 `(case_id, source_event_id)` 只写一条 `case_events`。
5. 同一 `(source_id, idempotency_key)` 只写一条 Action。
6. 同一 `(router_session_id, dedupe_key)` 只写一条 Inbox 记录。
7. 所有读写都经过 repository；路由层不出现裸 SQL。
8. `pnpm typecheck` 和 storage 单测通过。

**验证**

- `pnpm --filter @agent-dock/agent-dock-storage test`
- 用临时 SQLite 文件跑一次“建表 -> 写入 -> 关闭 -> 重开 -> 再写入”的恢复测试。

#### T2 Source 注册与管理

**目标**：AgentDock 能创建、查看、启停 Source；P0 只支持 `webhook`，接口为后续 `poll` / `stream` / `worker` 留出 `kind`。

**改动**

- 新增 `apps/server/src/sources/service.ts`、`routes.ts`。
- 新增 `apps/server/src/source-cli.ts`，接入 `cli-program.ts`。
- `apps/server/src/app.ts` 注册路由；`service.ts` 实例化服务。

**验收条件**

1. `POST /api/sources` 返回 `201`，`id` 以 `src_` 开头。
2. `GET /api/sources` 返回 `name`、`kind`、`enabled`、`status`、`lastEventAt`、`lastError`，不返回 secret 明文。
3. `PATCH /api/sources/:id` 可改名称和配置；`POST /:id/enable` / `disable` 生效。
4. 禁用 Source 的 ingress 返回 `409 SOURCE_DISABLED`。
5. 未知 Source 返回 `404 SOURCE_NOT_FOUND`。
6. `agent-dock source add/list/show/enable/disable` 可用，支持 `--json`。
7. `agent-dock source test <fixture>` 返回规范化 Event 和 Router dry-run 结果；默认不创建 Case、不创建 Session、不发动作。
8. 所有错误返回 `{ "error": { "code": "...", "message": "..." } }`，用户可见文案为中文。
9. 单测覆盖 CRUD、校验、secret 脱敏、禁用 Source。

**验证**

- Fastify inject 测试。
- CLI 用临时数据库跑一遍 add/list/disable/test。

#### T3 Ingress 网关

**目标**：可靠接收外部事件，完成鉴权、校验、去重、游标和落库。

**改动**

- 新增 `apps/server/src/sources/ingress.ts`。
- HMAC 校验、时间戳校验、body 大小限制、zod schema。
- `source_events`、`source_checkpoints` repository。
- `source test` 复用同一套规范化逻辑。

**验收条件**

1. 合法请求返回 `202`，响应含 `eventId`、`accepted:true`、`duplicate:false`；响应前事件已落库。
2. 同一 `dedupeKey` 第二次请求返回 `200`、`duplicate:true`；只有一条 `source_events`，只有一次下游投递。
3. 缺失或错误签名返回 `401 INVALID_SIGNATURE`。
4. 时间戳超过 5 分钟返回 `401 STALE_EVENT`。
5. body 超过上限返回 `413 PAYLOAD_TOO_LARGE`。
6. JSON 或 schema 非法返回 `400 INVALID_EVENT`。
7. 未知 Source 返回 404，禁用 Source 返回 409。
8. `GET /api/sources/:id/checkpoint` 返回最后提交的游标；`POST /heartbeat` 更新 `lastSeenAt` 和状态。
9. daemon 重启后事件、游标、待处理队列都还在；重放不会重复派发。
10. 日志包含 `sourceId`、`eventId`、`traceId`、`dedupeKey`，不打印 secret 和完整 raw body。
11. 单测覆盖以上所有状态码、重复、重放、重启恢复。

**验证**

- Fastify inject + 固定时钟 + 固定 secret。
- 用 100 条事件做一次批量写入，确认无丢失、无重复。

#### T4 Case 聚合与生命周期

**目标**：把事件归到 Case；同一外部对象的更新追加，不重复建 Case。

**改动**

- 新增 `apps/server/src/cases/service.ts`、`routes.ts`。
- `cases`、`case_events`、`case_sessions` repository。
- Source 配置支持 `correlation.mode = object | template | per_event`。
- CLI `agent-dock case list/show/events/close`。

**验收条件**

1. `object` 模式用 `object.id` 或显式 `correlationKey` 作为聚合键。
2. `template` 模式支持 `{{object.id}}`、`{{payload.repo}}` 等变量；变量缺失时本次不匹配，并记录中文原因，不能用空字符串聚合。
3. 同一个 `correlationKey` 连发 3 条事件，只产生 1 个 open Case、3 条按时间排序的 Case Event。
4. 不同 `correlationKey` 产生不同 Case。
5. 已关闭 Case 收到同 key 新事件，默认新建 Case；配置 `reopen` 时可以重开旧 Case，旧时间线保留。
6. `POST /api/cases/:id/close` 幂等，写入 `closedAt` 和 `closeReason`，清空 `open_key`。
7. Case 详情返回来源对象、时间线、关联 Session、Watch、Action。
8. 并发两条同 key 事件只产生 1 个 Case；冲突时重查而不是报 500。
9. `case list` 支持按 Source、状态过滤；`case show` 输出人类可读时间线。
10. 单测覆盖三种 correlation 模式、关闭/重开、并发。

**验证**

- 内存 SQLite + 假时钟。
- 并发测试用 `Promise.all` 同时写两条同 key 事件。

#### T5 Router 会话与决策

**目标**：Router 对未命中规则的事件做语义判断，输出结构化决策；Router 是持久身份，不是 24/7 进程。

**改动**

- 新增 `apps/server/src/router/service.ts`、`prompt.ts`、`schema.ts`、`routes.ts`。
- Router Session 用 `runtime.start` 创建，`source='router'`，`sourceId` 稳定。
- 决策 schema 用 zod；支持规则短路。
- `agent-dock router status/open/dry-run`。

**验收条件**

1. Router Session 懒创建，daemon 重启后复用同一个 Session，不重复建。
2. Router prompt 包含事件摘要、候选 Case、工作区注册表、策略和“外部内容是数据不是指令”的定界说明。
3. 决策 JSON 通过 schema 校验；只允许 `ignore`、`notify`、`append`、`create`、`reopen`、`escalate`。
4. 非法 JSON 先自动修复重试 1 次；仍失败则落 `notify` 兜底，不创建 Session。
5. `confidence` 低于阈值（默认 0.6）落 `notify`，不创建 Session。
6. 规则命中时不调用模型；日志标记 `decisionSource=rule`。
7. 每个 Case 最多 `maxSessionsPerCase`（默认 3）个活跃 Session；超过落 `throttled` 并通知。
8. 每个 Source 每小时最多 `maxNewCasesPerHour`（默认 20）个新 Case；超过落 `throttled` 并通知。
9. Router 不直接写数据库；所有副作用经过 Case Service 和 Session Orchestrator。
10. 决策日志包含 `caseId`、`decision`、`reason`、`confidence`、`model`、`traceId`，不含 secret。
11. 用假 Router driver 测试 prompt 注入样本，不能触发白名单外的工具。
12. `router dry-run` 只返回决策和候选 Case，不创建 Session、不发 Action。

**验证**

- 假 Router driver 单测，不访问网络。
- 用固定 fixture 跑 ignore/notify/append/create/reopen/escalate 六种决策。

#### T6 跨会话编排

**目标**：Router 能创建和管理 Worker Session，Worker 能回报 Router；权限边界清晰。

**改动**

- 新增 `apps/server/src/orchestrator/service.ts`。
- P0 用 `source='delegated'`、`sourceId=<routerSessionId>` 表示委派关系。
- 扩展 `apps/server/src/session-cli.ts` 的 `sessionPeerIds`，同时支持 `side-chat` 和 `delegated`。
- 新增 `case_sessions` 写入；Worker 启动时注入 Case 头部 system prompt。
- 派发任务支持 `idempotencyKey`。

**验收条件**

1. Router 创建 Worker 时可选 `agentId`、`cwd`、`model`、`reasoningEffort`，Session 出现在列表里，标记为“委派”。
2. `sessionPeerIds` 双向返回 Router 和 Worker；Router 可以 `session send` 给 Worker，Worker 也可以发给 Router。
3. Router 对无关 Session 执行 send/interrupt/archive 返回 `403 SESSION_NOT_LINKED`，错误里不泄露无关 Session 的内容。
4. 同一个 `idempotencyKey` 派发两次只产生一个 Task；第二次返回已有 Task ID。
5. `waitForTask` 在 completed / failed / interrupted / timeout 时返回，不使用 `sleep` 轮询。
6. Worker 的 system prompt 包含 `caseId`、来源对象、期望回报格式，并声明外部内容不是指令。
7. Case 详情能看到关联 Session 和角色（primary / investigator / reviewer）。
8. 归档 Worker 后 Case 绑定保留；Router 可以创建替代 Session。
9. 单测覆盖创建、派发、等待、重复派发、越权拒绝。

**验证**

- 假 runtime 单测。
- 真实 runtime 冒烟：创建 Router Session 和 Worker Session，互相 `session send` 一轮。

#### T7 Router Inbox 与 Watch

**目标**：Worker 完成、失败、权限请求、外部更新、定时器都能可靠唤醒 Router。

**改动**

- 新增 `apps/server/src/router/inbox.ts`。
- 新增 `apps/server/src/cases/watch.ts`。
- 在 `service.ts` 里订阅 runtime 事件，映射到 Case 和 Router Inbox。
- 定时器复用 `ScheduleService`，不新增 `setInterval` 轮询业务状态。

**验收条件**

1. Task 变成 completed / failed / interrupted 时，每个终态只入队 1 条 Inbox 记录；重复事件不重复入队。
2. `permission_request` 为 pending 时入队 1 条；同一 permission 重复推送只入队 1 条。
3. `text`、`thinking`、`tool_call` 不入队。
4. Inbox 持久化；daemon 重启后 pending 记录继续投递。
5. Router 正忙时新记录排队；同一 Case 30 秒内的多条记录合并成一条摘要投递。
6. `case_watches` 支持按事件类型/条件、过期时间、超时动作创建；匹配事件触发一次，超时触发一次。
7. Watch 触发后 Case 关闭，不再有后续唤醒。
8. 投递内容包含 Case 摘要、最近事件、待处理 Action 和当前 Session 状态。
9. 单测用假时钟和假 runtime 覆盖入队、合并、重启、Watch 触发/过期/取消。
10. 日志和 UI 能看到 Inbox 深度、投递延迟、合并数量。

**验证**

- 假时钟单测。
- 手动把 Router Session 标成 busy，连发 5 条完成事件，确认只投递 1 条合并消息。

#### T8 GitHub Source 与 Action

**目标**：用一个真实 Source 打通端到端，支持 issue/comment/PR/CI 事件和评论回写。

**改动**

- 新增 `apps/server/src/sources/github/manifest.ts`、`verify.ts`、`normalize.ts`、`actions.ts`。
- Source 配置支持 repo 白名单、事件类型、secret ref。
- 新增本地假 GitHub 服务测试 helper，不访问真实网络。

**验收条件**

1. 校验 `X-Hub-Signature-256`；签名错误返回 401，签名正确才规范化。
2. 事件映射：
   - `issues.opened` -> `issue.created`
   - `issue_comment.created` -> `issue_comment.created`
   - `pull_request.*` -> `pr.*`
   - `check_run.completed` -> `ci.completed`
3. issue/PR 的 `correlationKey` 统一为 `github:<owner>/<repo>#<number>`。
4. 不在 repo 白名单的请求返回 403 或直接忽略，不产生 Case。
5. `comment` Action 成功写一次；5xx 重试，4xx 进死信；`idempotencyKey` 相同的重复执行只评论一次。
6. AgentDock 自己发出的评论回声被识别并忽略，不触发新 Case/Task。
7. 每个 Source 的 Action 有速率上限；超限标记 `throttled`，不无限重试。
8. 本地假 GitHub E2E：issue 创建 -> Case -> Router -> Worker -> 结果 -> 评论；重复 webhook 不重复评论。
9. 单测不访问真实 GitHub。

**验证**

- 本地假 HTTP 服务 + Fastify inject。
- E2E 脚本断言评论请求次数为 1。

#### T9 Web、CLI 与可观测

**目标**：用户能看见 Source、Case、Router、Session 关系，并进行基本操作。

**改动**

- `apps/web/src/api.ts`：新增 source/case/router 类型和请求。
- 新增 Sources 页、Cases 页、Case 详情、Router 面板。
- `apps/web/src/App.tsx` 增加导航和 Router 固定入口。
- Session 列表/详情增加“Router”“委派”“Case”徽标。
- CLI 增加 `source`、`case`、`router` 子命令。

**验收条件**

1. Sources 页显示名称、类型、状态、最近事件、错误；可创建、编辑、启停、试跑。
2. Cases 页显示状态、来源对象、标题、最近活动；可按 Source/状态筛选。
3. Case 详情按时间显示 Source Event、Router 决策、Session 回报、Action；关联 Session 可点击打开。
4. Router 是固定入口，可打开对话、查看 Inbox/状态、暂停/恢复。
5. Session 列表和会话头部有 Router/委派/Case 徽标；点击可跳到 Case。
6. 禁用 Source 后 UI 状态更新，新事件被拒绝，已有 Case 仍可查看。
7. 提供“全部暂停”开关；操作有确认和审计记录。
8. 移动端遵循仓库约定：根容器 `h-[100dvh]`、内部滚动、无横向溢出、`viewport-fit=cover`。
9. CLI `source list/show/logs/test`、`case list/show/events/close`、`router status/open/dry-run` 都有 `--help` 和 `--json`。
10. 结构化日志带 `traceId`、`sourceId`、`caseId`、`sessionId`，不含 secret。
11. UI 组件单测通过；用 ego-browser 在 1440×900 浅色/暗色各截一张图。

**验证**

- `pnpm --filter @agent-dock/agent-dock-web exec tsc --noEmit`
- `pnpm --filter @agent-dock/agent-dock-web exec vitest run`
- 连接隔离沙箱，不点真实写入按钮。

#### T10 端到端验收与文档

**目标**：证明 P0 闭环，并留下可复现的验证证据。

**验收条件**

1. `pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。
2. `node apps/server/dist/cli.js dev up` 能启动隔离沙箱，`dev down` 能完全停止，无遗留进程。
3. E2E 覆盖：
   - 创建 Source；
   - 发送合法事件两次，只产生 1 条 Event、1 个 Case、1 次 Router 唤醒；
   - Router 创建 1 个 Worker Session 和 1 个 Task；
   - Worker 完成，Router 收到 Inbox；
   - Router 触发评论，假 GitHub 只收到 1 次；
   - 发送更新事件，追加到同一 Case；
   - 关闭 Case，状态为 closed；
   - 禁用 Source 后新事件返回 409。
4. 在同一个数据库上重复跑 E2E，不重复创建 Case、Task、评论。
5. README 增加“消息源与 Router”章节：概念、快速开始、协议、CLI、安全边界。
6. `.env.example` 增加签名 secret、body 上限、Router 阈值、并发/速率限制示例。
7. 文档里写清楚 P0 支持 GitHub webhook，P1 才支持托管 worker 和飞书。
8. 不修改、不重启正式 daemon；所有验证在 `dev` 沙箱完成。
9. 交付时附：测试输出、E2E 日志、UI 截图路径（如涉及 UI）。

**验证**

- 按第 8 节的场景逐条执行并记录。
- `git diff --check` 无空白错误。

### P1：托管 Source、多语言与飞书

#### T11 Managed Source Worker 与 Supervisor

**目标**：AgentDock 能托管任意语言的 Source 进程，并保证可观测、可停止、可恢复。

**改动**

- 新增 `apps/server/src/sources/supervisor.ts`。
- Source kind 支持 `worker`；manifest 增加 `command`、`args`、`cwd`、`env`、`heartbeatIntervalMs`、`restart`。
- 进程组管理、SIGTERM/SIGKILL、日志环形缓冲、心跳超时、重启退避。

**验收条件**

1. `worker` Source 能按 manifest 启动，状态依次为 `starting -> running`。
2. 心跳每 10 秒一次；连续 3 次缺失进入 `degraded`，并记录原因。
3. 进程崩溃后按退避重启；超过最大次数进入 `failed`，不无限拉起。
4. 禁用/停止 Source 先 SIGTERM，超时后 SIGKILL 整个进程组，不留孤儿进程。
5. daemon 关闭时所有托管 worker 都被停止；重新启动后启用的 Source 自动恢复。
6. stdout/stderr 进入环形缓冲，`source logs` 能看到最近 N 行。
7. Worker 通过注入的 `AGENTDOCK_SOURCE_TOKEN` 上报事件；token 不出现在日志。
8. 重启 daemon 后不会重复投递已确认事件。
9. 用一个 Node 假 worker 覆盖启动、崩溃、心跳丢失、停止、重启。
10. 沙箱限制写进文档：至少独立进程、独立 cwd、最小环境变量；完整容器隔离放到 P2。

#### T12 多语言 SDK 与一致性测试

**目标**：让 Agent 能用 Python / JavaScript / Go 实现 Source，不依赖私有库。

**改动**

- 新增 `agent-dock source init --language node|python|go`。
- 提供三个最小示例：健康检查、事件上报、去重、游标、心跳。
- 新增一致性测试套件和 fixture。

**验收条件**

1. `source init` 生成 manifest、入口文件、README 和测试命令。
2. Node、Python、Go 三个示例都能通过同一套一致性测试：
   - 合法事件被接受；
   - 同一 dedupeKey 不重复；
   - 重启后从游标继续；
   - 心跳更新状态；
   - 错误签名被拒绝。
3. 示例只依赖标准库或声明的少量依赖，不要求安装 AgentDock SDK。
4. 文档说明 HTTP+JSON 是唯一协议，SDK 只是封装。

#### T13 飞书 Source

**目标**：把飞书群消息作为 Source 接入，复用现有 listener 和权限体系。

**改动**

- 新增 `apps/server/src/sources/feishu/`。
- 复用 `apps/server/src/lark/listener.ts` 的事件解析和群权限。
- 新增 `im:message.group_msg` 权限检测和提示。

**验收条件**

1. 非 @ 的群消息能产生 Source Event；@ 机器人的消息继续走现有路径，不重复处理。
2. 同一个话题的消息归到同一个 `correlationKey`。
3. 重复推送的同一条消息只产生一个 Case。
4. 未开通 `im:message.group_msg` 时，UI 和日志给出明确中文提示和配置入口。
5. 现有飞书 listener 全部测试通过；新增 Source 路径有独立测试。
6. 机器人自己的消息、未列入白名单的机器人消息默认忽略。

#### T14 Action 扩展与策略

**目标**：支持更多回写动作，并把高风险动作纳入策略。

**验收条件**

1. 支持 `comment`、`add_label`、`close`、`update_card`、`reply_thread`。
2. 每个 Source 可配置允许的 Action 列表；未配置的 Action 返回 `ACTION_NOT_ALLOWED`。
3. 高风险动作（close、merge、deploy）默认需要人工确认。
4. 所有 Action 幂等、可重试、可进死信；日志可审计。
5. 单测覆盖成功、重试、死信、权限拒绝、人工确认。

### P2：增强与平台化

#### T15 跨源关联与高级追踪

- 支持多个 Source 指向同一个 Case，例如 GitHub issue + CI + 飞书讨论。
- 支持按 SLA、优先级、负责人自动升级。
- 支持 Watch 组合条件、静默时段、批量摘要。
- 验收：跨源事件进入同一 Case 时间线；SLA 到期只升级一次。

#### T16 多 Router、团队与成本

- 支持按工作区/团队配置多个 Router。
- 增加 Token/成本统计、每 Case 预算、每 Source 配额。
- 验收：不同团队的 Case 不会路由到错误 Router；超预算时停止新建 Session 并通知。

#### T17 沙箱与模板市场

- Source Worker 运行在容器/沙箱中，限制文件系统、网络和资源。
- 提供 Source 模板和安装/升级流程。
- 验收：越权文件访问和未授权网络请求被阻止；模板安装可回滚。

## 8. 端到端验收场景

### 场景 A：GitHub Issue 新建

1. 假 GitHub 发送 `issues.opened` webhook。
2. AgentDock 校验签名、去重、落库。
3. 创建 Case，`correlationKey=github:acme/api#123`。
4. Router 选择 `create`，在 `acme/api` 工作区创建 Worker。
5. Worker 收到带 Case 头部和 issue 内容的 prompt。
6. Worker 完成，Router 收到 Inbox。
7. Router 触发 `comment`，假 GitHub 收到一次评论。

**通过标准**：1 个 Case、1 个 Worker、1 个 Task、1 条评论；时间线完整。

### 场景 B：Issue 追加评论

1. 同一 issue 再发 `issue_comment.created`。
2. 事件追加到已有 Case，不新建 Case。
3. Router 决定 `append`，复用现有 Worker。
4. 时间线出现第二条 Event 和一轮新 Task。

**通过标准**：Case 数量不变；Task 数量 +1；没有重复 Worker。

### 场景 C：Worker 等待权限

1. Worker 发起 `permission_request`。
2. Router Inbox 收到一条通知。
3. Router 决定 `notify`，Web/飞书通知人。
4. 人批准后 Worker 继续，Case 状态回到 `open`。

**通过标准**：只通知一次；批准后任务继续；拒绝后 Case 记录原因。

### 场景 D：重复与重放

1. 同一 webhook 连续发送 3 次。
2. 关闭 daemon 再启动，重放同一批事件。

**通过标准**：1 条 Event、1 个 Case、1 个 Task、1 条评论；Inbox 不重复。

### 场景 E：Source 禁用

1. 禁用 Source。
2. 再发送合法 webhook。

**通过标准**：返回 409；不创建 Event/Case/Task/Action；已有 Case 仍可查看。

## 9. 质量门禁

每个任务完成前必须满足：

1. 相关单测通过，新增行为有测试覆盖。
2. `pnpm typecheck` 通过。
3. 涉及 API、CLI、调度、daemon 或前端时，`pnpm build` 通过。
4. 涉及端到端路径时，在 `dev` 沙箱跑通，并执行 `dev down`。
5. 错误码、HTTP 状态码、中文文案符合现有约定。
6. 日志不含 secret、token、完整敏感 payload。
7. 数据库迁移向后兼容，现有测试全部通过。
8. 没有无关文件改动，没有回滚用户未提交的工作。
9. 文档更新：README、CLI `--help`、协议说明。
10. `git diff --check` 通过。

## 10. 依赖与建议顺序

```text
T1 存储
  └─ T2 Source 管理
       └─ T3 Ingress
            └─ T4 Case
                 ├─ T5 Router
                 │    └─ T6 编排
                 │         └─ T7 Inbox/Watch
                 └─ T8 GitHub Source/Action
                      └─ T9 UI/CLI
                           └─ T10 E2E
```

T6 可以和 T5 并行开发，但联调要在 T5 之后。T8 依赖 T3/T4，不依赖 T5 的模型部分，可以先用固定决策联调。

## 11. 风险与待确认

1. **第一个 Source**：本文默认 GitHub Issues；如果用户要先上飞书，替换 T8/T13 的顺序即可，其余任务不变。
2. **Router 实现方式**：P0 用 AgentDock Session + 假 driver 测试；如果实际调用成本和延迟过高，可以在 T5 增加“小模型直接判定”模式，但必须保留规则短路和 JSON 校验。
3. **现有 Session 接管**：P0 只允许 Router 管理自己创建的 `delegated` Session；接管用户已有 Session 需要单独的“交给 Router”授权入口，放到 P1。
4. **回写范围**：P0 只做 GitHub 评论；close/label/merge 等动作在 T14 单独授权。
5. **Source 代码信任**：Agent 自动生成的 Worker 代码不能默认以 daemon 同等权限运行；P1 至少独立进程，P2 再做容器/沙箱。
6. **数据保留**：raw payload 默认保留 30 天，之后只留规范化摘要；涉及 PII 的 Source 需要脱敏配置。
7. **多机器**：P0 只支持当前 daemon；跨机器 Source 需要 machine affinity，放到 P2。

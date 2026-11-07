# AgentDock 消息源与 Router（P0 模块）

> 2026-11-07 · 独立增量模块

## 范围

本轮实现的是计划中的 P0 通用接入与 GitHub webhook 闭环。模块通过独立数据库文件 `<database>.sources-router.db` 持久化，不修改既有表结构；主控制台正在重构期间，前端以独立入口 `/sources-router.html` 提供，不触碰主 App。

已实现：

- Source 注册、查看、启停、脱敏、心跳、游标、事件日志和试跑。
- 通用 Event Envelope Ingress：HMAC 签名、时间戳、body 上限、zod 校验、去重、游标、错误码。
- GitHub webhook：`X-Hub-Signature-256`、repo/事件白名单、issue/comment/PR/CI 映射、机器人回声忽略。
- Case 聚合：`object`、`template`、`per_event`，并发唯一 open Case，关闭/重开，时间线和详情。
- Router：懒创建持久 Router Session、规则短路、可选小模型 JSON 决策、非法 JSON 修复一次、低置信度/失败 `notify` 兜底、统一 dry-run、阈值/限额、暂停/审计持久化与不可信输入定界。
- 跨会话编排：委派 Worker Session、Case 身份 system prompt、幂等 Task 派发、会话绑定。
- Router Inbox：终态/权限事件去重、30 秒普通消息合并、重启可恢复；Watch 事件匹配与过期。
- GitHub 评论 Action：终态唤醒后才入队、幂等键、重试、4xx 死信、5xx 失败、速率上限、AgentDock 回声标记。
- Web：Source、Case、Router Inbox、Case 详情的固定入口；支持“全部暂停”开关、操作确认提示、浅色/暗色与移动端布局。
- CLI：`source`、`case`、`router` 三组命令及 `--json`。

P1 仍按原计划保留：托管 Source Worker、多语言 SDK、飞书 Source、更多 Action 与人工确认；P0 不内置任意语言解释器，不改变现有飞书 @ 唤醒行为。

## 快速开始

1. 在 `.env` 或 shell 中设置 `AGENTDOCK_ROUTER_AGENT_ID`、`GITHUB_WEBHOOK_SECRET`、`GITHUB_TOKEN`。
2. 启动隔离沙箱：`pnpm build && node apps/server/dist/cli.js dev up`。
3. 创建 Source：

   ```bash
   node apps/server/dist/cli.js dev run -- source add "GitHub Issues · acme" \
     --config '{"correlation":{"mode":"object"},"allowedRepos":["acme/api"],"actions":["comment"],"actionBaseUrl":"http://127.0.0.1:4010"}' \
     --secret-ref GITHUB_WEBHOOK_SECRET --json
   ```

4. 把 GitHub webhook 指向 `POST /api/sources/:id/github/webhook`，通用 Source 指向 `POST /api/sources/:id/events`。
5. 打开 `/sources-router.html` 查看 Source、Case、Router Inbox 和时间线；主控制台入口仍在 `/`。

## 协议

通用 Ingress 使用 `agentdock.source.v1` Envelope，头部带 `X-AgentDock-Signature: sha256=...` 与 `X-AgentDock-Timestamp`。签名覆盖原始 body；默认允许 5 分钟偏差和 1 MiB body。GitHub 路径使用 `X-Hub-Signature-256` 和 `X-GitHub-Event`。

同一 `(source_id, dedupe_key)` 只保留一条事件；重复请求返回 `200 duplicate:true`，新请求在落库后返回 `202 accepted:true`。`source_checkpoints` 与事件写入在同一事务中推进，daemon 重启后可重放且不重复派发。

Router 决策只允许 `ignore`、`notify`、`append`、`create`、`reopen`、`escalate`。默认使用规则短路与策略限额；设置 `AGENTDOCK_ROUTER_MODEL_MODE=true` 时，daemon 会通过 runtime 的 `runOnce` 接入小模型 driver，未命中规则的事件才调用模型输出严格 JSON，解析失败自动修复重试一次，仍失败或置信度低于阈值则落 `notify`。Router Session 是持久身份，不是常驻进程；Worker Session 以 `source='delegated'` 标记，并在 system prompt 中声明外部内容是不可信数据。`AGENTDOCK_ROUTER_PAUSED=true` 或 Web 的“全部暂停”只记录事件，不派发 Worker/Action；Web 开关写入模块 DB，重启后仍生效。

## CLI

```bash
agent-dock source add|list|show|update|enable|disable|logs|test --help
agent-dock case list|show|events|close --help
agent-dock router status|open|dry-run --help
```

所有命令都支持 `--database <file>` 和 `--json`。`source test`、`router dry-run` 不创建 Case、Session 或 Action。

## 安全边界

- Source secret 只存服务端，列表、日志、事件摘要 API 和结构化日志均不回显明文；事件完整 payload/raw 不通过列表 API 返回。
- Web 访问门精确豁免两个外部 Ingress POST，业务层继续用 HMAC 覆盖原始 body 验签；其他管理接口仍要求 Web 凭证。
- 外部标题、正文、评论均按数据而非指令处理；Router 与 Worker prompt 有明确不可信输入定界。
- Router/Worker 只可互通其 `delegated` 关系；无关 Session 的 send/interrupt 仍受 `SESSION_NOT_LINKED` 边界保护。
- P0 只回写 GitHub 评论，不自动 merge、部署、删除生产资源。
- 高风险动作、托管 Worker 代码执行、更多语言 SDK 与飞书 Source 留到 P1/P2。

## 验证

```bash
npx vitest run apps/server/src/sources-router/service.test.ts
pnpm typecheck
pnpm test
pnpm build
node apps/server/dist/cli.js dev up
node apps/server/dist/cli.js dev run -- source list --json
curl http://127.0.0.1:4399/api/health/sources-router -H "Cookie: agentdock_web=<启动输出中的 token>"
node apps/server/dist/cli.js dev down
```

界面截图应通过 ego-browser 在 1440×900 浅色/暗色分别采集 `/sources-router.html`；不要启动额外无头浏览器。

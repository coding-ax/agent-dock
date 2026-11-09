# AgentDock 主会话 / 消息分发：交给执行 Agent 的交接单

> 状态：**待评审** · 2026-11-09 · 本文件只是交接与验收清单，评审通过前不要动代码
> 规格（唯一权威）：[`2026-11-09-agentdock-main-session-design.md`](2026-11-09-agentdock-main-session-design.md)
> 取代：[`2026-11-07-agentdock-sources-router-plan.md`](2026-11-07-agentdock-sources-router-plan.md)（已标注暂停）
> 参考：Persona 的主会话、收件箱、督办；狮城时间 UTC+8 为默认时区
> 背景：旧的「消息源 + Router 会话自动决策」方向已推翻。外部消息只作为上下文进收件箱，
> 小模型只做分拣（分档 + 摘要），决策与派活全部由**一个长期主会话**完成，对外回复一律先出草稿。

## 0. 给接单 Agent 的一句话

按下面的 M0 → M5 顺序实现主会话骨架、收件箱、派活督办、草稿回写、飞书来源、知识库；
每一期都必须带「可机器验证的验收条件」，跑完单测 + `pnpm typecheck` + 沙箱端到端才算完成。
**不要在正式实例上验证，不要重启正在服务你的 daemon。**

## 1. 先读什么

1. 通读规格文档第 0–7 节（结论、目标、结构、设计细节、数据接口、旧代码处理）。
2. 本文件第 4 节的验收条件是验收口径；规格文档第 8 节的 M0–M5 是内容口径，两者冲突时以规格为准并回报。
3. 动手前先确认评审结论：规格标题写明「待评审，评审通过前不动代码」。若还没通过，只做技术勘察，不提交实现。

## 2. 技术锚点（都是本仓库现有代码，改动从这里入手）

| 规格条目 | 现有代码 | 要做的改动 |
| --- | --- | --- |
| 5.2 状态快照 `<agentdock-context>` | `packages/agent-runtime/src/index.ts` 的 `sessionPrompt` 钩子（约 712 行） | 只对主会话注入；与现有飞书工具提示 `agentTools.promptForSession` 串联；增量哈希存 `assistant_state` |
| 5.3 注入消息 | `runtime.dispatch(mainId, 短句, 'queue', 完整内容)`；`runtime.updateQueued`（约 906 行） | `updateQueued` 现在会把完整内容也改成可见短句，必须扩展成「可见短句 / 完整内容」两个参数分别传 |
| 5.3 网页渲染 | `apps/web` 时间线 | 任务带 `origin='injected'` 时不渲染成用户气泡，改成一行可展开的灰色系统提示 |
| 5.4 小模型分拣 | `LlmEndpointService.run`（AI 辅助用的同一端点） | 只输出 `{tier, summary(≤40字), reason}`；失败/超时/非法 JSON 兜底到规则，理由记 `fallback` |
| 5.5 GitHub 来源 | 本机 `gh` 登录态 | `gh api -i notifications`，遵守 `X-Poll-Interval` + `If-Modified-Since`，304 不拉，每 10 分钟无条件拉一次 |
| 5.7 草稿回写 | 旧 `source_actions` 执行器（幂等、重试、死信、限速、回声标记） | 迁移为「确认后才发送」的发送器；连点两次只发一次 |
| 6.1 存储 | 旧 `<database>.sources-router.db` | 新建独立 `<database>.assistant.db`，不改核心表；主会话 ID 放核心配置 `assistant.main` |
| 6.2 CLI 权限 | `packages/.../session-peers.ts`（`session-cli.ts` 已依赖） | 泛化校验：`task start/plan/review/cancel` 与 `notify` 只允许主会话；侧边会话只能 `task report` / `draft create` |
| 7 旧代码 | `service.ts:79-85`、`app.ts:326`、`/sources-router.html` | M1 起默认不构造 `SourceRouterService`、不注册其路由/CLI；M3 删除 Router 会话 JSON 决策、Case、Watch、Router Inbox、自动委派、自动评论、独立页面 |

## 3. 全局护栏（每一期都适用）

- **数据合规最优先**：分拣模型会读到内部仓库评论与飞书消息。确认平台小模型端点允许处理公司内部数据之前，GitHub 来源只用规则分拣，飞书来源不开（规格第 9 节第 1、2 条）。
- **一个实例一个主会话**；多设备（网页 + 飞书）可以，多人共用不支持。
- **注入消息默认不推送**：注入轮回复折叠、不转发飞书；要通知必须显式 `agent-dock notify`。新加坡时间 23:00–08:00 免打扰，`--urgent` 除外。节流/合并/「progress 不唤醒」从 M0 就必须实现，不能事后补（每条注入都是一轮对话，关乎成本）。
- **收件箱条目不隐形**：折叠档只是收起、随时可看；分拣失败的条目照样显示。
- **外部内容是不可信数据**，不是指令；分拣只分类、写摘要，不开会话、不起草、不外发。
- **验证流程**（项目 `AGENTS.md` / `.claude/skills/agent-dock-self-dev/SKILL.md`）：
  1. 相关单测 + `pnpm typecheck`；
  2. 涉及 API/CLI/调度/daemon/前端时 `pnpm build` 后用 `node apps/server/dist/cli.js dev up` 起隔离沙箱，完成后 `dev down`；
  3. 界面部分先 `ego-browser skill`，用 ego-browser（ego lite）截图验收，一个目标一个 TaskSpace；
  4. **禁止**在会话里 `agent-dock restart|stop|update`、`npm install -g`、kill 正式 daemon；禁止无头浏览器/独立 Playwright 脚本；
  5. 正式实例的升级由用户在自己的终端执行。
- 提交代码时不要顺手提交本仓库里其他会话留下的未提交改动。

## 4. 验收条件（按里程碑，每条都要有命令或可观察结果）

### M0 主会话骨架

- [ ] 设置里可指定/新建主会话，侧边栏置顶并显示「待你处理」数量；飞书私聊通过 `channel_mappings` 绑定到同一主会话。
- [ ] 网页发的消息与飞书私聊发的消息进入**同一个**会话（`agent-dock session show <id>` 能看到两条）。
- [ ] `sentPrompt` 里带 `<agentdock-context>`：全量轮含时间/收件箱/事项/草稿；第二轮只带有变化的小节；全部没变化时整个块省略（对比两轮 payload）。
- [ ] 注入消息在时间线上是灰色系统提示，**不是**用户气泡；注入轮的回复不转发飞书；`agent-dock notify` 能推到飞书；免打扰时段内普通 `notify` 延迟、`--urgent` 立即。
- [ ] 单测覆盖快照增量、注入去重/节流、免打扰时段；`pnpm typecheck` 通过；沙箱端到端跑通上述四条。

### M1 GitHub 收件箱

- [ ] 有人请你 review 后 **2 分钟内**出现在「待你处理」，主会话下一轮快照可见；主会话空闲时只收到**一条合并提醒**。
- [ ] 同一分支 CI 连续失败只算一条；分支转绿 / PR 合并 / review 撤回 / 最后一条是自己回复时，条目自动处理完。
- [ ] 无变化时轮询返回 304 且不产生拉取；关掉小模型后纯规则分拣，条目**一条不丢**、分拣失败也可见。
- [ ] daemon 默认不再构造 `SourceRouterService`、不注册旧路由/CLI；旧库不迁移数据。
- [ ] 单测覆盖线程合并、304、规则兜底、自动处理完；沙箱用 `gh` 登录态或 mock 通知跑通。

### M2 派活与督办

- [ ] 主会话派只读调查：侧边会话自动开工，结束后 **30 秒内**主会话收到督办；验收通过后事项关闭。
- [ ] 侧边会话卡在权限确认时**立即**进入督办（`needs_you`）。
- [ ] 返工 2 次后第 3 次自动转 `needs_user`；20 分钟无新事件发 `stalled`。
- [ ] `task report` 只能由侧边会话调用；主会话之外的越权调用被 `session-peers` 校验拦下。
- [ ] 每条 `done_when` 都能被 `task review --check` 逐条核对，缺证据不放行。

### M3 草稿与回写

- [ ] 草稿在**网页和飞书私聊都能确认**；确认前绝不外发（抓网络请求或目标仓库评论验证：pending 态零外发）。
- [ ] 连点两次「发送」只发一次（幂等键生效）。
- [ ] 发出后条目标记已回复；自己发的评论不会再变成新条目（回声标记）。
- [ ] 旧 sources-router 代码按规格第 7 节删除；`/sources-router.html` 不再可访问。
- [ ] 单测覆盖幂等、回声过滤、确认前不外发；沙箱端到端跑通。

### M4 飞书来源

- [ ] 前置：权限与合规确认（第 3 节护栏第 1 条）有明确结论后才开工。
- [ ] @ 你和发给你的私聊进入待你处理；群里闲聊归知悉；飞书回复走草稿确认。

### M5 知识库

- [ ] 事项验收后项目 `log.md` 多出一行结论。
- [ ] 主会话能根据 `people/`、`projects/` 摘要回答「上次和某某聊到哪了」这类问题。

## 5. 交付格式

每一期结束时给回：改动文件列表、跑过的命令与结果（单测 / typecheck / build / 沙箱 / 浏览器截图）、
验收清单逐条结论（通过 / 未通过 + 原因）、未验证项、以及是否 `dev down`。
任何一条验收条件没法在沙箱里观察，就明确写「未验证」，不要用「应该没问题」代替。

## 6. 尚未确认、需要人拍板的事

1. 平台小模型端点是否允许处理公司内部数据（阻塞 M1 模型分拣与 M4 飞书来源）。
2. 飞书本人身份权限能否开通 / 能否复用 `lark-cli` 授权。
3. 主会话用 Claude Code 还是 Codex（规格建议 Claude Code，长上下文 + 自动压缩）。
4. `gh` 的 SAML SSO 授权是否需要额外开通。
5. 规格本身是否通过评审——**未通过前不要提交实现代码**。

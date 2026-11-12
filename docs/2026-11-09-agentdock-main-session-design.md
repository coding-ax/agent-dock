# AgentDock 主会话与督办

> 状态：已实现 · 2026-11-11
> 一句话：一个长期主会话负责和你沟通、判断、派活；侧边会话干活，daemon 把状态变化转成「督办」注入主会话；对外回复先出草稿。

## 1. 功能点与验证方式

### 1.1 主会话

**做什么**

- 每个实例只有一个主会话。网页「设置 → 主会话与督办」可以新建（选 Agent）或清除；CLI 用 `agent-dock main set|get|clear`。
- 主会话固定在侧栏顶部，不进普通会话列表；有 `review` / `needs_user` 事项或待确认草稿时显示数量角标。
- 主会话使用专用系统提示词：只沟通、判断、派活，改代码交给侧边会话；验收前亲自核对证据。
- 主会话的每一轮对话都在同一个会话里延续，上下文由 Agent 自己压缩。

**验证**

- 在网页设置里新建主会话：侧栏顶部出现「主会话」，普通列表不重复出现。
- `agent-dock main get` 返回同一 `sessionId`；`agent-dock session show <id>` 能看到网页发的消息。
- 清除主会话后，顶部入口消失，普通列表仍不出现该会话。

### 1.2 每轮状态快照

**做什么**

- 只对主会话生效：用户消息发给 Agent 前，前面附一段 `<agentdock-context>`，内容是当前事项、watch、草稿、待处理通知等事实。
- 首轮给全量（含当前新加坡时间）；之后只给有变化的小节；全部没变化时整块省略，不浪费上下文。
- 快照是「事实」，督办是「提醒」。即使信号漏了，主会话下一轮也能从快照看到状态。

**验证**

- 主会话发两轮相同消息，查看 `sentPrompt`：第一轮带 `<agentdock-context>`，第二轮不带。
- 新建一个事项后再发一轮：只出现「事项：」小节，不重复时间和其他未变化内容。

### 1.3 派活

**做什么**

- 主会话用 `agent-dock task start --title ... --done-when ...` 派活。daemon 新建一个 `side-chat` 侧边会话，把任务说明和验收标准发给它。
- `task plan` 只登记计划（`plan=true`，状态 `review`），等用户确认后再 `task start <id>` 真正开工。
- 事项状态只有四个：`running`（侧边会话在干）、`review`（等验收）、`needs_user`（需要用户拍板）、`closed`（结束）。
- `task list` / `task show` 查看；`task cancel` 停止侧边会话并关闭事项。

**验证**

- `task start` 后 `task list` 出现 `running` 事项和侧边会话 ID；侧边会话完成后自动变 `review`。
- `task plan` 后侧边会话不创建；`task start <id>` 后才创建。
- `task cancel` 后事项 `closed`，侧边会话 `stopped`。

### 1.4 状态信号与督办

**做什么**

- daemon 订阅 runtime 的全局状态事件，并有 30 秒扫描兜底，把侧边会话状态转成三类信号：
  - `review`：侧边会话这一轮结束（`idle` / `completed`），等主会话验收。
  - `needs_you`：等权限确认（`waiting_for_permission`）、卡住超时（`stalled`）、侧边会话主动 `task report --kind question|blocked`。
  - `failed`：`failed` / `interrupted`。
- 信号按事项和类型节流，15 秒合并窗口；多个信号合并成一条「📋 督办 · N 个事项有变化」注入主会话。
- 注入消息带 `origin=injected`：网页时间线渲染成一行可展开的灰色系统提示，不是用户气泡；注入轮不转发飞书。
- `thinking` / `running_tool` 等中间状态不产生信号，不逐条唤醒主会话。

**验证**

- 派一个只读任务，侧边会话完成后 30 秒内主会话收到一条督办，网页上是灰色可展开行。
- 同一轮里多次工具调用只产生一条 `review`；`task show` 里返工轮次不变。
- 侧边会话停在权限确认时，主会话立即收到 `needs_you`，不等 30 秒扫描。
- 连续完成两个任务，两条信号可以合并成一条督办；展开后能看到每个事项的原因。

### 1.5 验收与返工

**做什么**

- 主会话用 `task review <id> --verdict accepted|rework|needs_user|cancelled` 验收。
- `--check '<验收标准>=met:<证据>'` 或 `=unmet:<原因>` 逐条记录核对结果。
- `accepted` 关闭事项；`rework` 返工并把意见发回侧边会话，返工轮次 +1；第 3 次返工自动转 `needs_user`；`cancelled` 关闭并停止侧边会话。
- 侧边会话可以用 `task report --kind done|question|blocked --text ...` 主动汇报；`done` 触发 `review`，`question` / `blocked` 触发 `needs_you`。

**验证**

- 验收时带 `--check`，`task show` 的 review 记录里有逐条标准和证据。
- `--verdict rework` 后侧边会话收到返工意见并继续运行；连续 3 次返工后状态变 `needs_user`。
- 侧边会话执行 `task report --kind blocked` 后主会话收到 `needs_you`。

### 1.6 watch（自定义检查脚本）

**做什么**

- 主会话用 `agent-dock watch add --name ... --command ...` 登记检查脚本；daemon 按间隔执行，不调用模型。
- 退出码 0 = 条件满足，产生一次信号；默认 `once`（触发后变 `fired`），`--repeat` 可重复触发，`--cooldown` 控制重复间隔。
- 单次默认 30 秒超时；超时先 SIGTERM 再 SIGKILL 整个进程组，不留孤儿。
- 连续 3 次执行失败（非 0 退出）只报一次 `failed`，避免脚本坏了刷屏；`--expires` 到期自动停止。
- `watch list|show|pause|resume|run|remove` 管理；`run` 立即执行一次。

**验证**

- `watch add --name 文件出现 --command 'test -f /tmp/agentdock-watch-ok' --every 5s`，创建文件后 30 秒内主会话收到督办，watch 变 `fired`。
- `watch run <id>` 在条件不满足时退出码 1、`failCount` +1；条件满足时 `fireCount` +1。
- 命令 `sleep 60` 配 `--timeout 2s`：2 秒后被杀，进程组无残留。
- `watch pause` 后不再执行；`watch remove` 后列表消失。

### 1.7 草稿与对外发送

**做什么**

- 主会话用 `agent-dock draft create --channel github_comment --target github:owner/repo#123 --body-file -` 生成草稿；`draft list` 查看。
- 草稿在用户确认前绝不外发；`draft send <id>` 才调用 `gh api` 发 GitHub 评论，`draft discard` 丢弃。
- 发送带隐藏幂等标记；重复发送已发送草稿直接返回原结果，不重复评论；失败最多尝试 3 次，之后标记 `failed`。
- `lark_reply` 目前只支持建草稿，发送接口保留给后续飞书来源。

**验证**

- 建草稿后目标仓库无新评论；`draft list` 显示 `pending`。
- `draft send` 后评论出现且只出现一次；再次 `draft send` 不新增评论。
- `draft discard` 后状态 `discarded`，不能发送。

### 1.8 通知与静默时段

**做什么**

- 主会话用 `agent-dock notify "..."` 推送到绑定的飞书会话；`--ask` 表示需要用户回复，`--urgent` 表示紧急。
- 静默时段默认**关闭**；开启后起止时间由用户设置（网页「主会话与督办」或 `agent-dock settings quiet-hours --enabled --start 22:30 --end 07:15`）。
- 静默时段内普通通知进入待发送队列，到结束时间后由 30 秒扫描补发；`--urgent` 立即发送。
- 没有绑定飞书会话时，通知记录为失败但不会阻塞主会话。

**验证**

- 默认设置下 `notify` 立即发送。
- 开启静默时段并把窗口设为当前时间：普通 `notify` 返回 `delayed: true`，飞书无消息；`notify --urgent` 立即到达。
- 关闭静默时段后，待发送队列在下一次扫描补发。
- 网页设置里的开关和起止时间保存后，`GET /api/assistant/settings` 返回相同值。

### 1.9 权限边界

**做什么**

- 只有主会话能：`task start|plan|review|cancel`、`watch add|remove|pause|resume`、`notify`、修改主会话/设置、`draft send|discard`。
- 侧边会话只能：`task report`、`draft create`。
- 越权调用返回 403；主会话 ID 来自 daemon 配置，不信任请求体。

**验证**

- 在侧边会话里执行 `task start` 或 `watch add`，返回 403。
- 在侧边会话里执行 `task report` / `draft create`，成功。
- 不带 `from` 的普通终端可以执行主会话命令；带错误 `from` 被拒绝。

### 1.10 superagent 编排（2026-11-11）

**做什么**

- 主会话默认是「编排者」，不是执行者：看仓库、读代码、查日志、跑命令、改代码、验证、调研等可执行请求，第一个动作必须是 `agent-dock task start`，不再由主会话自己用 Bash/Read 完成。
- 用户说「随便看看」「给我看看」「你看着办」时，主会话必须真的派一个侧边会话，不能只回复「我可以派」。
- 主会话提示词里写死决策规则、派活示例和红线；对可执行用户消息，还会在用户消息前注入一段 `<agentdock-superagent>` 意图约束，确保这一轮走派活路径。
- 独立的子任务可以一次派多个侧边会话并行做；派完立即回复任务 ID 和侧边会话 ID，不阻塞等待。
- 侧边会话默认完整继承主会话的 Agent、模型、思考深度和工作目录；主会话可按任务自由覆盖 `--agent` / `--cwd`（任意绝对路径工作区）/ `--model` / `--reasoning-effort`，换 Agent 时不再沿用原 Agent 的模型和思考深度。侧边会话用事项标题作为会话名，侧栏可直接辨认。
- 侧边会话的任务提示词要求：独立执行、不做无关改动、完成后必须 `agent-dock task report --kind done` 并逐条给证据；卡住时 report `question|blocked`。
- 主会话收到督办后先 `task show` + `session show` 核对，再 `task review --verdict accepted|rework`；不把侧边会话的转述直接当验收结果。
- daemon 启动时会刷新已有 `assistant-main` 会话的系统提示词，升级后不用手动重建主会话。

**验证**

- 对主会话发「先随便看看这个仓库在干嘛，给我讲讲」：主会话 1 轮内创建事项和侧边会话，回复里带任务 ID、侧边会话 ID 和验收标准。
- 对主会话发「在吗？」：不创建事项，直接回复。
- 侧边会话完成后 30 秒内主会话收到督办；主会话 `task show`/`session show` 核对后 `task review --verdict accepted`，事项变 `closed`，回复里给出验收证据。
- 侧边会话在侧栏的标题等于事项标题，而不是 Agent 自动生成的泛化标题。
- 督办注入本身不会再触发 `<agentdock-superagent>` 派活。

## 2. 明确不做（本期）

- GitHub 收件箱、小模型分拣、外部平台入口：只保留方向，不排期。
- 飞书消息作为主会话来源：需要先确认数据合规和机器人权限，后续单独做。
- 知识库 `log.md` / `people/` / `projects/`：后续里程碑。
- 旧 `sources-router` 不再构造和注册路由；旧数据不迁移。

## 3. 实现位置

| 模块 | 文件 |
| --- | --- |
| 类型 | `apps/server/src/assistant/types.ts` |
| 存储（独立 `<database>.assistant.db`） | `apps/server/src/assistant/store.ts` |
| 主会话、快照、督办、watch、草稿、通知 | `apps/server/src/assistant/service.ts` |
| 飞书通知 | `apps/server/src/assistant/notify.ts` |
| HTTP API | `apps/server/src/assistant/routes.ts` |
| CLI | `apps/server/src/assistant/cli.ts`、`cli-program.ts`、`cli.ts` |
| runtime 全局状态事件 | `packages/agent-runtime/src/index.ts` |
| 注入消息与 `origin` | `packages/shared/src/index.ts`、`packages/storage/src/*`、`apps/web/src/timeline.ts`、`apps/web/src/TimelineItems.tsx` |
| 网页主会话入口与设置 | `apps/web/src/App.tsx`、`apps/web/src/AssistantSettingsDialog.tsx` |
| 单测 | `apps/server/src/assistant/service.test.ts` |

## 4. 验证流程

```bash
pnpm typecheck
pnpm test -- apps/server/src/assistant/service.test.ts
pnpm build
node apps/server/dist/cli.js dev up          # 隔离沙箱，默认 4399
node apps/server/dist/cli.js dev run -- task list
# 网页验收：http://127.0.0.1:4399/
node apps/server/dist/cli.js dev down
```

正式实例的升级由用户在自己的终端执行；不要在 AgentDock 托管的会话里重启正式 daemon。

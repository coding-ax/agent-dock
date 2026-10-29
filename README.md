# AgentDock

AgentDock 是一个本地 Agent 工作台。它把飞书消息、Web 会话、Agent 执行轨迹和 SQLite 持久化串在同一条链路上：你在飞书里 @ 一下机器人，Agent 就在你指定的本地工作区里干活，过程和结果实时回写成一张卡片。

```text
飞书 / Web / HTTP → AgentDock 运行时 → acpx@0.20.0 → ACP Agent
```

AgentDock 不使用 Agent SDK，也不内嵌供应商专属适配器。固定版本的公开 `acpx/runtime` 接口负责 ACP 初始化、持久会话、重连、流式输出、实时权限请求、取消和子进程清理；AgentDock 负责产品状态、标准化事件、存储、API 与通道。

## 能用它做什么

- **自动发现 ACPX 支持的 Agent**：Claude Code、Codex、Cursor Agent、Gemini、Trae、Pi、opencode 等，只保留本机确实装了 CLI 的那些。
- **部署在本地电脑或远端开发机**，当成常驻的 AI 分身用。
- **服务化接入**：完整的 HTTP + SSE 接口，可以作为上层多 Agent 平台的执行底座。
- **天然的多 Agent 群聊**：给机器人开通群权限拉进群，多个 Agent 可以在同一个飞书群里互相发现、读消息、@ 交接。
- **界面化的门禁与白名单**：高危操作拦截、成员白名单，都在 Web 界面里配，不用改配置文件。

设计上刻意做了取舍：卡片状态简单直白、概念尽量少、基于 ACP 而不是 PTY 抓屏。

## 安装与启动

要求 Node.js 22.13+。发布包是 `@agent-dock/cli`，提供 `agent-dock` 命令，内置生产版 Web 界面，并统一管理运行时、ACP 进程、会话持久化、HTTP API 和 SSE 流——客户端不会自己去拉 Agent 进程。

```bash
npm i -g @agent-dock/cli@latest

cd /path/to/your/project
agent-dock start      # 后台启动
agent-dock status     # 查看 PID、地址、日志路径
agent-dock restart
agent-dock stop
agent-dock update     # 更新全局包并重启后台服务
```

新版本检查和 `agent-dock update` 都是直接调用本机 `npm`（`npm view` / `npm install -g`），使用你自己的 npm 配置：默认走官方 registry，如果在 `.npmrc`、环境变量 `npm_config_registry` 或 `@agent-dock:registry` 里配了镜像或私有源，就走你配的源。AgentDock 不内置任何 registry 地址。

启动后打开 `http://127.0.0.1:4310`。

默认绑定 `0.0.0.0`，同一局域网的设备可以通过本机 LAN IP 访问。这不等于暴露到公网，但边界仍然由你的防火墙和网络策略决定。只允许本机访问用 `--local-only`（或 `AGENTDOCK_LOCAL_ONLY=true`），指定网卡用 `--host`。

> **服务没有 API Key、多用户账号或租户隔离。** 控制台只有一层「所有者」访问防护（见下）；对外暴露必须经反向代理补上 HTTPS、身份认证、来源限制和访问日志。

### Web 控制台访问防护

`/api/*` 默认需要凭证，未授权一律返回 401：

- 本机直连（回环地址）免凭证。
- 局域网 / 远程访问必须带凭证链接：`start` 和 `status` 会打印带 `?t=` 令牌的控制台地址（含访问凭证，请勿外传）。首次访问会换成 HttpOnly Cookie。
- 飞书卡片「查看详情」链接携带按会话签名的短期令牌，只能访问对应会话，转发卡片不会暴露其他会话。
- 可选：`agent-dock password set` 设置控制台密码（scrypt 哈希存放在 `~/.agentdock/web-password`），在登录页输入同样获得完整访问；`password clear` 移除，`password status` 查看，改动立即生效。

这套防护只解决「同一网络里的人随手打开」的问题，不替代 HTTPS 与正式的身份认证。

常用启动参数：`--local-only`、`--host`、`--port`、`--cwd`、`--database`、`--idle-timeout-ms`、`--cleanup-interval-ms`、`--no-lark-listen`。完整说明见 `agent-dock --help`。

工作目录按会话解析，优先级：`POST /api/sessions` 的 `cwd` → Agent 专属 `cwd` → 进程级 `--cwd` → 启动 `agent-dock` 时所在目录。

### 前台与后台

不带子命令的 `agent-dock` 在前台直接启动服务；只有显式的 `start` 才转入后台。两者互不干扰，可以同时用。

后台模式通过 `daemonize-process` 把进程重新派生成独立会话的守护进程，PID、状态和日志记在首次启动根目录的 `.agentdock/daemon/` 下。**该根目录会被持久记忆**——之后即使服务已停止，或者从别的目录执行 `start` / `restart`，仍复用同一个根目录和 `.agentdock/agentdock.db`，不会悄悄创建第二套机器人配置。

`start` / `stop` / `restart` / `status` 既可作顶层命令，也可写成 `agent-dock daemon start`，指向同一套实现。`stop` 先发 SIGTERM，超时未退再 SIGKILL 并清理状态文件。日志追加写入 `.agentdock/daemon/agentdock.log`。已在运行时再次 `start` 返回 `ok:false` 和 `state:"already-running"`，不会重复拉起。

### 从源码开发

```bash
pnpm install
cp .env.example .env
pnpm dev              # 同时起 Fastify 和 Vite
```

开发时访问 `http://127.0.0.1:4311`，Vite 会把 API 代理到 `http://127.0.0.1:4310`。

```bash
pnpm dev:server       # 仅 Fastify
pnpm dev:web          # 仅 Vite
pnpm test             # 验收与集成测试
pnpm typecheck
pnpm build
pnpm server           # 先构建，再以发布形态启动
```

## Web 工作台

本地会话和飞书会话统一显示在同一套时间线里。Agent 忙碌时，新消息可以排队，也可以中断当前轮次立即发送；排队消息执行前可以取消。消息、推理过程、工具调用、权限请求和终端输出都落在 SQLite 中。

Agent 输出的 Markdown 随流式内容持续渲染。围栏代码块使用同步 Prism 高亮，新 token 到达时背景保持稳定，展示语言标识并提供一键复制；未知语言标识回退为纯文本，不报错也不异步加载第二套主题。

侧边栏优先显示机器人 Tab，其后是「本地」和「全部」。飞书会话标记所属 App ID，不同机器人的消息不会混进同一个 Tab。

会话可以永久归档：先停掉对应 Agent 进程，再置为只读。归档会话默认隐藏，可从左下角「归档会话」打开。**没有恢复入口，这是有意的。**

## 飞书接入

### 在飞书里怎么用

私聊机器人直接唤醒 Agent，群聊需要 @ 机器人。每个机器人有独立的配置面板、工作区和会话 Tab。

收到有效消息后，机器人先回一个随机确认表情，再发出「正在思考中」卡片，Agent 产生真实输出后持续覆盖同一张卡片，最终变成已完成 / 失败 / 已取消。群聊中卡片作为触发消息的**回复**发出，直接落在用户消息下方；触发消息在话题线程内时卡片也进对应线程（回复失败回退为群内普通发送）。

- 运行中的卡片可以点「中断」，取消后卡片变灰。
- 失败或已取消的任务可以点「重试」，复用同一会话。
- 同一聊天在一次服务生命周期内复用同一个 Agent 会话。

### 飞书开放平台准备

一键创建入口：<https://open.larkoffice.com/page/launcher?from=backend_oneclick>

手动创建：

1. 创建企业自建应用，开启机器人能力。
2. 开通消息发送 / 更新 / 接收和表情回复权限；多 Agent 协作还需要「获取群组中其他机器人和用户 @ 当前机器人的消息」。
3. 事件订阅选择**长连接**，订阅 `im.message.receive_v1`。
4. 打开飞书卡片回调配置。
5. 发布应用版本，把使用者加入可用范围。
6. 群聊场景要先把机器人拉进目标群。

按上述权限在开放平台逐项开通即可。

### 配置机器人

左下角「飞书设置」可选择 **扫码创建机器人**：生成二维码后，用飞书扫码并在授权页确认应用名称和权限（应用名称、头像等可在飞书页面调整）；也可打开授权链接。授权完成后凭证自动保存在服务端，页面只展示应用名称和 App ID。点击「继续配置机器人」，检查工作区和可用成员，再选择 Agent 完成接入。「快速创建机器人」仍保留原来的飞书页面跳转入口，可自行创建和调整；已有应用仍可手动填写 App ID 和 App Secret。

二维码过期可重新生成，关闭弹窗会停止等待；已创建的飞书应用不会因关闭弹窗而删除。连接意外中断时先刷新机器人列表确认是否已保存，避免重复创建。名称查询失败会保留凭证并提示继续配置；使用 `--no-lark-listen` 时不会启动监听。扫码页预设权限是否生效由飞书开放平台决定，仍需在授权页核对权限及消息事件/卡片回调配置。

回复消息时，Agent 会收到被引用消息的发送者和正文，引用的图片/附件从原始消息下载到本地。引用不可访问时保留当前请求；仅 @ 机器人且没有引用内容时，继续使用最近聊天记录兜底。

两步式配置对话框：

**第一步（飞书与白名单）** 校验 App ID 和 App Secret，识别机器人名称。可使用成员通过 TagInput 直接填**真实姓名**；保存时服务端在机器人所在群中精确解析并持久化 `open_id`，运行时不读取成员邮箱。找不到姓名、或不同用户同名时会拒绝保存，避免授权错误。同时保存工作区、Web 访问地址、监听开关、推送间隔和 Trace 上限。

**第二步（Agent 与门禁）** 选默认 Agent、模型、推理强度、每轮预注入 Prompt，以及群协作和高危门禁开关。

两步都完成前，机器人不能开启监听。每个 App ID 只能有一个配置面板，重复会返回 `409 LARK_BOT_ALREADY_CONFIGURED`。

关键约束：工作区必须是绝对路径；`pushIntervalMs` 是 500–20000 的整数，默认 1000；`traceLimit` 为 null 表示不限制，否则必须是正整数，默认 50——**飞书对超长卡片不友好，建议配成 10 左右**；高危正则最长 4096 字符，必须通过语法和灾难性回溯检查。任务完成后默认隐藏前置 Trace，只留 Agent 最终输出。

macOS 上工作区旁的「选择」按钮会打开系统原生目录选择器，其他平台该接口返回 501。

配置以明文 JSON 存在本地 SQLite 的 `configs` 表。`GET /api/lark/config` 返回全部面板，但**永远不返回 App Secret**。

**改配置何时生效**：改默认 Agent、模型、推理强度或工作区时，当前任务不受影响，该机器人下一条消息会停掉旧 Session 按新配置重建（旧记录保留）。只改 Prompt、协作开关、Trace 或卡片策略时继续复用当前 Session，从下一条消息起生效，不需要重启。

单个任务失败（未产生最终输出、输出被截断、瞬时驱动错误）只结束该任务，不会把共享 Session 永久置为 `failed`：Session 回到 `idle` 继续消费队列，排队任务不会再悬死（早期版本会导致 `Unknown queued task` 和整个群聊卡住）。

**临时关闭监听**：用 `agent-dock --no-lark-listen` 启动。界面开关置灰，SQLite 里的值不变，下次不带该参数启动会按保存值恢复监听。

### 飞书群内的 Agent 协作

对已启用协作的群聊，飞书本身就是共享消息总线：AgentDock 不维护第二个房间，也不把群历史复制进协作数据库。每个 Agent 拿到一个仅限当前会话的本地 Capability：

```bash
agent-dock group self
agent-dock group peers
agent-dock group members
agent-dock group bots
agent-dock group messages --limit 20
agent-dock group message om_xxx          # 读取单条消息，合并转发会展开
agent-dock group messages --after '<cursor>' --limit 20
agent-dock group send '请检查这个接口' --to cli_peer
agent-dock group send '请改用 agent-dock' --to '小王'
agent-dock group send '已修复' --reply-to om_xxx --idempotency-key handoff-1
agent-dock group send '运行结果：<img src="/abs/path/screen.png"/>'
agent-dock group send '<img src="https://example.com/a.png"/>'
agent-dock group wait --after '<cursor>' --timeout-ms 15000
```

`peers` 取「当前群内的机器人」与「本实例已配置的机器人」的交集，不会把任意第三方机器人暴露成可调用 Agent。`messages` 和 `wait` 返回不透明游标用于增量读取。回复会校验目标消息属于当前群，`send --to` 只解析发现结果里的协作方。

`group send` 支持发送图片：在内容里用 `<img src="..."/>`（也接受 `<image>`）即可，既能只发一张独立图片，也能与文字混在一条 post 里（多条自动混排）。`src` 支持本地绝对路径、相对机器人服务工作区的路径、http(s) 图片 URL，以及 `data:image/png;base64,...` 数据 URI；服务端会自动上传为飞书 `image_key` 再发送。

界面上是「启用协作」和「允许写入」两个开关（`groupToolsEnabled` / `groupToolsAllowSend`），**均默认关闭**，必须管理员显式启用。

Capability 只含一个随机 Token，精确绑定到指定的 Session、机器人和群聊；App Secret 和访问令牌始终留在服务端。运行时变量 `agentdock_group_tools_url` 和 `agentdock_group_tools_token` 自动注入，不要手工配置（ACPX 持久化键名必须是 snake_case，写大写会触发 `Persisted key policy violation`）。

所需 OpenAPI 权限：

| 操作 | 权限 |
|---|---|
| 发现群内机器人 | `im:chat.members:read` |
| 接收其他机器人 @ 当前机器人的消息 | `im:message.group_at_msg.include_bot:readonly` |
| 读取或等待群消息 | `im:message:readonly` + `im:message.group_msg` |
| 发送或回复消息 | `im:message` |

权限不足时命令返回 `GROUP_TOOL_AUTHORIZATION_REQUIRED`，附带 `requiredScopes`、`instruction` 和 `authorizationUrl`。Agent 会停止该操作并把这些信息展示给用户。**机器人授权不能用 `lark-cli auth login` 修复**，必须管理员在开放平台开权限并发布新版本；Agent 绝不能向用户索要 App Secret 或访问令牌。

### 高危操作门禁

可选，两层。

**软门禁**：门禁启用后固定生效，对不在高危名单内的发送人注入不可绕过的安全约束。高危成员同样填真实姓名，保存时解析为 `open_id`。名单留空时，普通白名单里的所有人都可以执行高危操作。

**硬门禁**：额外启用 ACP 权限拦截器和所选 Agent 的原生工具调用 Hook。

| Agent | 项目级原生入口 |
|---|---|
| Codex | `.codex/hooks.json` 的 `PreToolUse` |
| Claude Code | `.claude/settings.json` 的 `PreToolUse` |
| Trae | `.trae/hooks.json` 的 `PreToolUse` |
| Cursor Agent | `.cursor/hooks.json` 的 `preToolUse`，启用 `failClosed` |
| Pi | `.pi/extensions` 的 `tool_call` Extension |

点「检测并配置 Hook」后，服务保留工作区内已有的无关 Hook，只装当前 Agent 的拦截器。装好之后才能开启硬门禁。硬门禁开启期间默认 Agent 被锁定，模型和推理强度仍可改。

高危正则在前端和服务端同时校验，实际匹配跑在隔离 Worker 里，超过 1000ms 终止并按高风险处理，避免正则回溯拖死服务。

### 命令行发送卡片

发布包内置一次性卡片命令，直接调飞书 OpenAPI，**不需要先启动 AgentDock 服务**。成功时 stdout 输出单行 JSON（`{"ok":true,"messageId":"om_xxx","chatId":"oc_xxx"}`），失败用非零退出码，方便脚本和平台编排。

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=replace_me
export LARK_RECEIVE_ID=user@example.com
export LARK_RECEIVE_ID_TYPE=email

agent-dock lark send '**构建完成**' --task-id release-42

# 发到群里（机器人需已在群内）
agent-dock lark send '**群聊构建通知**' --chat-id oc_xxx --task-id release-42

# 运行态卡片，Markdown 正文原样传递
agent-dock lark send $'### 构建阶段\n\n🟢 依赖安装完成\n🟡 正在执行测试' \
  --state running --agent-name '我的 Agent' --read-only

# 原地更新同一张卡片
agent-dock lark update '**所有检查均已通过。**' \
  --message-id om_xxx --state completed --task-id release-42 --elapsed-seconds 48
```

凭证优先从进程环境或 `.env` 读，别留在 shell 历史里。`--chat-id` 与 `--receive-id` 互斥，群聊 ID 必须以 `oc_` 开头。

常用参数：`--state`（`running` / `completed` / `failed` / `interrupted`）、`--agent-name`、`--task-name`、`--task-id`、`--elapsed-seconds`、`--read-only`、`--app-id`、`--app-secret`、`--base-url`。`send` 额外接受 `--chat-id` / `--receive-id` / `--receive-id-type`，`update` 必须给 `--message-id`。

**按钮语义**：默认 `running` 显示「中断」，`failed` / `interrupted` 显示「重试」，`completed` 不显示按钮。传 `--read-only`（HTTP 里是 `readOnly: true`）后任何状态都不渲染按钮——如果调用平台自己有任务继续 / 排队 / 重试语义，终态卡片应该用只读模式，避免出现跨系统的重复控制入口。

### 环境变量

| 变量 | 是否必需 | 用途 |
|---|---:|---|
| `LARK_APP_ID` | 是 | 企业自建应用 ID（`cli_xxx`） |
| `LARK_APP_SECRET` | 是 | 应用密钥；仅服务端使用，状态 API 永不返回 |
| `LARK_RECEIVE_ID` | 用默认发送目标时 | 默认接收方；单次调用可覆盖 |
| `LARK_RECEIVE_ID_TYPE` | 否 | `open_id` / `union_id` / `user_id` / `email` / `chat_id`，默认 `email` |
| `LARK_CHAT_ID` | 用默认群聊时 | 群聊 ID（`oc_xxx`），优先级高于 `LARK_RECEIVE_ID` |
| `LARK_AGENT_NAME` | 否 | 默认卡片标题前缀，默认 `AgentDock` |
| `LARK_OPEN_API_BASE_URL` | 否 | OpenAPI 地址，默认 `https://open.feishu.cn` |

对应启动参数：`--lark-app-id`、`--lark-app-secret`、`--lark-receive-id`、`--lark-chat-id`、`--lark-receive-id-type`、`--lark-agent-name`、`--lark-base-url`。`--no-lark-listen` 只覆盖当前进程的监听状态。

## 命令行速查

除 `start` / `stop` / `restart` / `status` / `update`、`lark`、`group` 外，发布包还内置：

```bash
# 定时任务：由 daemon 持久化，会话结束和重启后仍然有效
agent-dock schedule add "汇总昨天的告警" --cron "0 9 * * 1-5" --name "工作日早报"
agent-dock schedule add "检查发布状态" --every 45m
agent-dock schedule list | show | pause | resume | run | remove <schedule-id>

# 主 / 侧会话互通：读取记录、排队发送、打断、取消排队任务
agent-dock session peers
agent-dock session show <session-id>
agent-dock session send <session-id> "消息" [--mode interrupt]

# 控制台密码
agent-dock password set | clear | status
```

每条命令的完整参数见 `agent-dock <命令> --help`。`agent-dock dev up | run | env | down` 是开发 AgentDock 自身用的隔离沙箱（独立 HOME、数据库和端口，不影响正式实例），见 `.claude/skills/agent-dock-self-dev/SKILL.md`。

## 服务化接入

Agent 和自动化系统应该通过 AgentDock 的 HTTP API 调用飞书能力，**不需要也不应该**把 lark-cli 当运行时依赖。服务内部用飞书 OpenAPI 和官方长连接 SDK，App Secret 只存本地 SQLite。

默认 Base URL `http://127.0.0.1:4310`，请求响应为 JSON，事件流用 SSE。

### 健康检查与能力发现

| 接口 | 用途 |
|---|---|
| `GET /health` | 存活检查，返回 `{"ok":true}` |
| `GET /api/agents` | 已发现的 Agent：id、名称、协议、权限模式、默认工作区、能力 |
| `GET /api/agents/:id/models` | 指定 Agent 的可用模型和推理强度；可选 `?model=` 基于某模型重新探测 |
| `GET /api/system/capabilities` | 平台名称，以及原生目录 / 文件选择器是否可用 |
| `POST /api/system/select-directory` | macOS 打开原生目录选择器返回 `{"path":"..."}`；取消返回 409，非 macOS 返回 501 |

### Session 生命周期

Session 是 AgentDock 的稳定会话标识。Agent 进程在 Session 内按需启动、释放和重连；调用方应长期保存 `session.id`，**不要**把底层 ACP Session ID 当成 AgentDock Session ID。

```text
POST   /api/sessions                  创建并启动，必填 agentId，可选 cwd / model / reasoningEffort
GET    /api/sessions                  列出全部（含已归档）
GET    /api/sessions/:id              读取单个，不存在返回 404
POST   /api/sessions/:id/interrupt    中断当前回合，保留 Session
POST   /api/sessions/:id/pause        仅 Agent 声明支持时可用
POST   /api/sessions/:id/resume       用持久化 Session Key 重连
POST   /api/sessions/:id/stop         停止底层进程，标记 stopped
POST   /api/sessions/:id/restart      停旧进程 + 新 runId，Session ID 不变
POST   /api/sessions/:id/archive      停进程并永久归档，之后所有动作返回 SESSION_ARCHIVED
```

**Session state**：`created`、`starting`、`idle`、`thinking`、`running_tool`、`waiting_for_permission`、`interrupting`、`interrupted`、`completed`、`failed`、`stopped`。

不支持暂停的 Agent 返回 `UNSUPPORTED_CAPABILITY`，不会假装暂停成功。

### 发送、排队、取消与抢占

`POST /api/sessions/:id/send` 返回 HTTP 202，**只表示任务进了队列，不表示执行完成**。调用方必须通过 tasks、events 或 SSE 观察最终状态。

```json
{ "prompt": "检查当前工作区并给出结论", "mode": "queue" }
```

`mode` 为 `queue` 时排在已有任务之后；`interrupt` 会插到队首，停掉当前回合、重连同一 Session 后立即执行。

```text
GET    /api/sessions/:id/tasks                    持久化任务记录
DELETE /api/sessions/:id/queue/:taskId            取消尚未执行的 queued 任务
POST   /api/sessions/:id/queue/:taskId/steer      提到队首并立即执行，taskId 和 prompt 不变
```

**Task status**：`queued`、`running`、`completed`、`failed`、`interrupted`、`cancelled`。操作已不在队列中的任务返回 404 `QUEUED_TASK_NOT_FOUND`。

**并发约束**：同一 Session 内任务严格串行。多个调用方可以同时提交 queue 任务，但要共同维护 `task.id`；需要抢占时用 `mode=interrupt` 或 `steer`，不要「先 interrupt 再另发一条」——那会产生竞态。

### 事件与 SSE

`GET /api/sessions/:id/events?after=<sequence>` 拉取指定 sequence 之后的持久化事件。

`GET /api/sessions/:id/stream?after=<sequence>` 建立 SSE：先补发断点之后的历史事件，再推实时事件，每 15 秒一次 heartbeat。也识别标准的 `Last-Event-ID` 请求头；同时给了 query 和 header 时取较大的 sequence。**客户端应保存每条 SSE 的 `id`，断线重连时带回**。

```text
id: 42
event: text
data: {"id":"evt_xxx","sessionId":"ses_xxx","sequence":42,"type":"text","timestamp":"...","data":{"text":"结果"}}
```

**事件类型**：`text`、`thinking`、`tool_call`、`tool_result`、`permission_request`、`status`、`error`、`completed`、`task`、`raw_terminal`。解析失败的内容一律转成 `raw_terminal`，**绝不丢弃**。

### 权限请求

事件流出现 `permission_request` 且 `data.status` 为 `pending` 时，向用户展示标题和选项，再调：

```text
POST /api/sessions/:id/permissions/:permissionId
{ "approved": true }
```

重复提交、未知 permissionId 或已结束的请求会返回错误。**不要默认批准高危操作。**

### 飞书 API

```text
GET    /api/lark/status                环境配置状态、机器人数、监听状态、本进程是否禁用监听
GET    /api/lark/config                全部机器人的脱敏配置（永不含 App Secret）
POST   /api/lark/bot/oneclick           扫码创建机器人（POST SSE，凭证仅服务端保存）
PUT    /api/lark/config                按 stage 保存飞书层或 Agent 层配置
DELETE /api/lark/config/:appId         删除配置并停止监听（已有会话记录保留）
POST   /api/lark/bot/inspect           校验凭证，返回机器人名称、openId、头像、激活状态
GET    /api/lark/hooks/status?appId=   Hook 是否受支持 / 已安装 / 可写 / 需要信任
POST   /api/lark/hooks/install         校验正则并安装原生 Hook
POST   /api/lark/send                  发送新卡片，返回 messageId
POST   /api/lark/update                用 messageId 原地覆盖已有卡片
```

配置两阶段提交。编辑现有机器人**必须**传 `originalAppId`；新 App ID 已属于另一面板时返回 409 `LARK_BOT_ALREADY_CONFIGURED`。

```json
{
  "stage": "lark",
  "originalAppId": "编辑时填旧 App ID，新建时省略",
  "appId": "cli_xxx",
  "appSecret": "新建或轮换密钥时填写",
  "workspace": "/absolute/path/to/project",
  "webBaseUrl": "https://agent-dock.example.com",
  "allowedUserNames": ["张三"],
  "listening": true,
  "pushIntervalMs": 1000,
  "traceLimit": 10
}
```

```json
{
  "stage": "agent",
  "originalAppId": "cli_xxx",
  "defaultAgentId": "codex",
  "defaultModel": "可选",
  "defaultReasoningEffort": "high",
  "preInjectPrompt": "每轮飞书请求前注入的约束",
  "groupToolsEnabled": false,
  "groupToolsAllowSend": false,
  "highRiskAllowedUserNames": ["李四"],
  "highRiskPattern": "(?:sudo|rm|git\\s+push)\\b",
  "gateEnabled": true,
  "hardGateEnabled": false,
  "hookTrustConfirmed": false
}
```

卡片接口字段：

| 字段 | 说明 |
|---|---|
| `botAppId` | 选择已保存的机器人凭证；省略时用首个已配置机器人 |
| `chatId` | 群聊 ID，必须 `oc_` 开头；与 `receiveId` 互斥 |
| `receiveId` / `receiveIdType` | 用户或其他接收方；类型为 `open_id` / `union_id` / `user_id` / `email` / `chat_id` |
| `state` | `running` / `completed` / `failed` / `interrupted` |
| `readOnly` | `true` 时不渲染任何操作按钮 |
| `agentName` / `taskName` / `taskId` | 标题、副标题、底部任务标识（也用于中断与重试回调关联） |
| `elapsedSeconds` | 非负耗时秒数 |
| `markdown` | 卡片主体 |
| `retryable` | 失败 / 取消态是否显示重试，默认显示；`readOnly=true` 时始终不显示 |

```json
POST /api/lark/send
{
  "botAppId": "cli_xxx",
  "chatId": "oc_xxx",
  "agentName": "Codex",
  "state": "running",
  "readOnly": true,
  "taskName": "代码检查",
  "taskId": "task-42",
  "elapsedSeconds": 0,
  "markdown": "正在思考中…"
}
→ { "messageId": "om_xxx", "chatId": "oc_xxx" }
```

把返回的 `messageId` 传给 `/api/lark/update` 就能覆盖同一张卡片，而不是刷屏。接口也接受临时 `bot` 凭证对象，但**生产系统不应该在普通业务请求里反复传 App Secret**。

飞书会话的 `source` 为 `lark`，`sourceId` 格式为 `appId:chatId`，可以据此按机器人和聊天维度检索。未配置凭证时调发送 / 更新接口返回 `503 LARK_NOT_CONFIGURED`，其余 Session 和 SSE 路由照常可用。

### 错误结构与重试

校验错误用对应 HTTP 状态码，正文统一为 `{"error":{"code":"...","message":"..."}}`。未捕获错误返回 500 `INTERNAL_ERROR`；飞书网络或 OpenAPI 失败通常映射为 502。

| 状态码 | 建议 |
|---|---|
| 400 | 参数或状态非法。修正后再发，不要原样重试。 |
| 404 | Session / 任务 / 机器人 / 路由不存在。先刷新资源列表。 |
| 409 | 状态冲突：归档会话、重复 App ID、队列任务已变、门禁未就绪、用户取消目录选择。 |
| 422 | Agent 不支持 pause / resume 等能力。 |
| 501 | 当前平台不支持该系统能力。 |
| 502 | 飞书 OpenAPI、网络或上游异常。可指数退避重试，保留 request context。 |
| 503 | Agent、配置存储或必要配置不可用。需要人工检查。 |

### 推荐接入顺序

1. `GET /health` + `GET /api/agents` 做启动探测和 Agent 发现。
2. `POST /api/sessions` 创建 Session，持久化返回的 `session.id`。
3. **先建 SSE 保存最新 sequence，再调 send**——否则极短任务可能在你连上之前就跑完了。
4. 用 `task.id` 关联 queued / running / 终态事件，不要只靠 Session state 判断某个任务是否完成。
5. 断线后用 `Last-Event-ID` 或 `after=` 补拉，再用 tasks 接口对账。
6. 遇到 `permission_request` 交给真实用户决策。
7. 关闭客户端只断 SSE；只有业务明确结束会话时才 `stop` 或 `archive`。

### ACPX 指令透传

`agent-dock acpx` 后面的所有内容原样交给系统里的 `acpx` 可执行文件，不经 shell、不重排参数，标准输入输出错误和退出码全部继承。运行机器需要预装 `acpx` 并在 PATH 中。

```bash
agent-dock acpx agents list --json
agent-dock acpx run --help
```

## ACPX 运行时版本

当前使用 ACPX 0.20.0，最低 Node.js 22.13。`session_options.env` 支持大写及混合大小写环境变量名，并在会话重连时原样恢复；现有群聊变量名保持不变。其他持久化结构键仍使用 snake_case。

单条入站 ACP 消息默认上限为 64 MiB；确需更大消息时，可在启动服务前设置 `ACPX_MAX_ACP_MESSAGE_BYTES`，`0` 表示关闭上限。该设置沿用 ACPX 默认行为。

ACPX 0.20.0 已于 2026-10-21 验证可从空缓存下载，tarball 完整性与锁文件一致。工作区 lockfile 固定官方 ACPX tarball 并校验 integrity；本地补丁只保留上游尚未吸收的三处：会话创建/加载的超时约束、Codex 退出宽限期，以及加载已有会话时重放所选模式。

## Agent 发现与自定义 Agent

启动时读取 ACPX 内置注册表（`pi`、`codex`、`claude`、`gemini`、`cursor`、`copilot`、`trae`、`opencode`、`qwen`、`iflow`、`kilocode` 等），检查本地供应商 CLI 是否存在并调它的版本命令。**只有成功发现的 Agent** 才会出现在 `GET /api/agents`、Session 选择器和飞书默认 Agent 选择器里。Mock ACP、JSONL Demo 和 PTY Demo 仅供测试，不作为可选内置 Agent 发布。

Codex 默认从 PATH 中发现本机 Codex CLI；macOS 上还会比较 `/Applications` 和 `~/Applications` 中 ChatGPT / Codex 桌面应用自带 CLI 的版本，选择较新版本，避免旧 CLI 无法使用 `gpt-6.1-sol` 等新模型。无法识别版本的自定义包装器保持原样，相同版本优先保留 PATH。模型探测、版本展示和实际会话使用同一启动入口。`CODEX_PATH=/absolute/path/to/codex` 显式指定路径时不做自动选择。不限制本机 Codex 版本，也不会自动切换到适配器依赖的 Codex。未安装或配置不兼容时明确报错，不修改用户配置。模型实际可用性仍取决于所选 CLI 和当前账号。

使用内置 Codex 启动入口时，显式选择的模型会在创建 ACP 会话前通过当前子进程的 `CODEX_CONFIG` 注入；原有 provider、网关地址和鉴权配置保持不变，也不会改写共享的 `CODEX_HOME/config.toml`。模型探测采用相同规则，支持未出现在内置目录中的网关模型。若适配器仍拒绝该模型，会明确失败，不自动换成另一模型发起请求。

Codex 的 `permissionMode: full-trust` 会显式切换到 ACP `agent-full-access` 模式，对应底层 `approvalPolicy: never`、`approvalsReviewer: user` 和 `sandboxPolicy: dangerFullAccess`。创建、恢复和发送前均同步模式；ACPX 重连时也会重放所选模式。设置失败则停止发送，不静默使用默认的 `auto_review`。非全信任配置使用适配器的 `read-only`（Ask for approval）模式，并保留 AgentDock 原有权限决策；该模式名称不等同于文件系统完全只读。

AgentDock 固定 ACP 协议适配器 `codex-acp@1.10.0`，直接加载以避免启动时通过 npx 下载。运行时的 `CODEX_PATH` 仅注入 launcher 子进程环境，不写入 ACPX session 的 `env`；结构性持久化键名仍须使用 snake_case；0.20.0 的 `session_options.env` 允许原样保存大写和混合大小写环境变量名。

可以通过 `AGENTDOCK_AGENTS_JSON` 添加自定义 ACP 服务，同样只在命令可用时纳入：

```json
[
  {
    "id": "custom",
    "name": "自定义 ACP",
    "command": "/path/to/custom-agent",
    "args": ["acp", "serve"],
    "protocol": "acp",
    "model": "optional-model",
    "cwd": "/work/project",
    "env": { "TRAE_PROFILE": "work" },
    "permissionMode": "ask",
    "timeout": 600,
    "capabilities": { "pause": false, "resume": true },
    "builtin": false
  }
]
```

该进程必须通过 stdio 使用 ACP 协议，支持 `initialize`、Session 创建 / 加载、Prompt、流式 `session/update`、权限请求和 `session/cancel`。argv 原样传给 acpx；发现阶段忽略命令不存在的配置。

权限模式：`ask`（默认）、`approve-reads`、`deny-all`，以及必须显式启用的 `full-trust`。前两者会把升级后的 ACP 权限请求送到 Web 界面，用户的允许 / 拒绝直接完成实时 acpx 请求。**完全信任模式绝不会默认启用。**

## 生命周期与存储

处于已完成、空闲或已中断状态的 Agent Driver 默认 6 小时后释放，每 5 分钟扫描一次。Session 元数据和事件仍在 SQLite 里，下一条消息自动重连持久 ACP Session。

收到 `SIGINT` / `SIGTERM` 或调用 `server.close()` 时，清除定时器、关闭子 Driver 和 SSE 连接、释放 SQLite。第二次 `Ctrl-C` 立即退出；关闭流程有 5 秒硬上限，避免卡死的子进程占住终端。

业务代码依赖仓储接口而非直接依赖 SQLite。Drizzle / better-sqlite3 实现负责持久化机器、项目、Session、任务、事件、工具调用、权限、错误和通道映射。

SQLite 原生依赖固定为 `better-sqlite3 13.0.3`（N-API）。不要回退到 `12.11.1`：使用 Node 24.20.0 头文件编译的旧版，在跨 V8 上下文的垃圾回收中可能触发 `RemoveEnvironmentCleanupHook: (env) != nullptr`，直接终止整个服务。此类原生崩溃无法通过 JavaScript 异常捕获恢复。排查时同时确认 Node、AgentDock 和实际安装的 SQLite 依赖版本；复现方式见 `docs/2026-10-19-sqlite-glibc-compat-triage.md`。

需求与验证证据的对应关系见[验收计划](docs/acceptance-plan.md)。测试覆盖真实内嵌 acpx 运行时与 Mock ACP 服务、工具调用关联、实时权限、生命周期语义、异常退出、JSONL/PTY 降级、无损原始输出、SSE 回放、仓储恢复、安全默认值和自定义 Agent。

## 许可证

[MIT](LICENSE)

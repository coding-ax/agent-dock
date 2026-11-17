# 飞书 AI 替身：表情触发一轮 Agent

> 日期：2026-11-16
> 范围：`apps/server/src/lark-avatar/`、`apps/server/src/lark/`、`apps/web/src/LarkAvatarPanel.tsx`
> 状态：已实现；真实 reaction 触发需要飞书机器人已加入会话并订阅事件，测试全部走 fake gateway / fake 端口

---

## 0. 结论

1. 主会话原有的「静默触发表情」（**已于 2026-11-17 下线**）是**网页时间线**能力：点消息旁的表情，前端 `claimSilentTrigger` 去重，`api.send(..., 'emoji')` 派活；`origin=emoji` 让时间线不渲染用户气泡。它不读取飞书 reaction。
2. lark-avatar 原有的 `emojiReactions` 是**出站反馈**：`/ai` 触发后替身自己在原消息上加 2–3 个随机表情，和「用表情触发 Agent」方向相反。本次新增独立的 `reactionTrigger*` 配置，不复用这个开关。
3. 飞书官方有 `im.message.reaction.created_v1` / `deleted_v1` 事件；**没有 Pin 事件**。Pin 只有 OpenAPI（`im/v1/pins`），只能主动查询，不能实时触发。因此本次按 reaction 实现，Pin 明确不支持实时触发。
4. reaction 事件只带 `message_id`、`reaction_type.emoji_type`、`operator_type`、`user_id`/`app_id`、`action_time`；**不含 chat_id 和正文**。所以正文、聊天、上下文和询问卡片由事件来源（当前是已配置的飞书机器人 OpenAPI）按 `message_id` 补齐。
5. 三种路由都已实现：`ask`（先回卡片让你选）、`main`（静默发主会话，不新增用户气泡）、`independent`（按消息/话题新开独立会话）。

---

## 1. 现状调研

### 1.1 主会话「静默触发表情」

> 2026-11-17 更新：网页端「静默触发表情」已下线（设置项、时间线入口和前端账本均已移除）。以下 1.1 仅作历史记录；飞书 reaction 触发仍沿用 `origin=emoji` 语义，因此时间线继续不为这类轮次渲染用户气泡。

| 位置 | 行为 |
| --- | --- |
| `apps/web/src/SilentTrigger.tsx` | 消息旁的表情按钮；有小猫时弹「发送主会话 / 在新标签打开 / 直接新开一轮」 |
| `apps/web/src/silent-trigger.ts:4` | `SILENT_TRIGGER_ORIGIN = 'emoji'`；前端账本 `agentdock:silent-trigger-ledger` 按 `sessionId + 消息 + emoji` 去重 |
| `apps/web/src/silent-trigger.ts:226` | `buildSilentPrompt()` 用目标消息前后各 4 条上下文组装 prompt；目标行标 `→ [目标消息]` |
| `apps/web/src/SessionPane.tsx:181` | 点击后 `claimSilentTrigger` → `api.send(targetSessionId, prompt, 'queue', 'emoji')` |
| `apps/server/src/assistant/service.ts:25` | 设置键 `assistant.silentEmoji` |
| `apps/server/src/assistant/routes.ts:19` | 只接受单个 emoji；空串关闭 |
| `apps/server/src/app.ts:468` | `/api/sessions/:id/send` 接受 `origin`，最终传给 `runtime.dispatch` |

结论：去重在前端账本 + 服务端 `clientMessageId`；`origin=emoji` 只影响渲染，不改变执行。飞书侧没有复用这条链路，本次在主会话路由里复用同一个 `origin=emoji` 语义。

### 1.2 lark-avatar 现有触发

- `types.ts` 的 `triggerPrefix`（默认 `/ai`）只匹配**本人发送**的消息；`handleIncomingMessage()` 里 `isSelf` 才触发。
- `emojiReactions` 在 `reactToTrigger()` 里出站加表情，属于触发后的即时反馈。
- 轮次复用 `sessionForThread()`：`source = 'lark-avatar'`，`sourceId` 由 `threadKey + agent/cwd/model/reasoning/contextScope` 哈希得到；同话题共享会话。
- `streamAgentTurn()` 用 `runtime.subscribe + dispatch` 把 AgentText 流式发回飞书；失败会发一条错误文本并记日志。
- 现有 web 协议 `LarkProtocolClient` 只解码消息推送（`CMD_PUSH_MESSAGES`）、批量复制和 sid 补拉；**没有 reaction 推送的解码**，也没有拉取 reaction 的网关命令。因此无法在替身的 Web 会话里可靠拿到 reaction。

### 1.3 reaction 事件与 Pin 的差异

| 能力 | reaction | Pin |
| --- | --- | --- |
| 官方事件 | `im.message.reaction.created_v1`、`deleted_v1` | 无（目前只有 OpenAPI） |
| 事件字段 | `message_id`、`reaction_type.emoji_type`、`operator_type`、`user_id`、`app_id`、`action_time` | — |
| 实时触发 | 可以 | 不可以，只能轮询/主动查询 |
| 需要的权限 | `im:message.reactions:read`（应用已预设） | `im:message.pins:read` |
| 本次实现 | ✅ 已接入 | ❌ 明确不支持实时触发 |

事件本身不带聊天和正文，所以机器人必须**在目标会话里**并且有消息读取权限（`im:message:readonly`）；否则 `GET /open-apis/im/v1/messages/:message_id` 会 403，本次会把 `permission_denied` 和原始错误写进账本。

> 已配置的机器人需要在开发者后台补订阅 `im.message.reaction.created_v1`；新一键创建的机器人已加入预设事件列表（`apps/server/src/lark/routes.ts` 的 `LARK_ONECLICK_PRESET`）。

---

## 2. 实现

### 2.1 配置

`LarkAvatarConfig` / `PublicLarkAvatarConfig` 新增：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `reactionTriggerEnabled` | `false` | 总开关 |
| `reactionTriggerEmoji` | `''` | 单个飞书 `emoji_type`；设置页从常用集合下拉选择，保存时把 `👍` 等常见 emoji 规范成 `THUMBSUP` |
| `reactionTriggerRoute` | `'ask'` | `ask` / `main` / `independent` |
| `reactionTriggerIgnoreBots` | `true` | 忽略机器人/应用添加的表情 |

设置页文案明确写了「在飞书消息上添加一个指定表情」，并说明和「随机表情回应」的区别。
常用集合来自飞书官方 emoji 列表（`packages/shared/src/lark-reaction-emoji.ts`），只列真实代码；`Fire`、`Trophy`、`Music` 等是大小写敏感的混合大小写代码，不能统一转大写。飞书没有 `EYES`，眼睛对应的是 `GLANCE`。历史配置如果不在集合里，会在下拉里置顶显示为「当前配置（不在常用集合）」并继续保留，不会被清空。

### 2.2 事件接入

- `apps/server/src/lark/listener.ts` 注册 `im.message.reaction.created_v1`，`parseLarkReactionEvent()` 统一解析字段并归一化 `operator_type`。
- `LarkLongConnectionListenerOptions.onReaction` 旁路转发给 `LarkAvatarService.handleReaction()`。
- `apps/server/src/lark/routes.ts` 用当前 app 的 `LarkCardService` 构造 `LarkReactionPort`：按 `message_id` 取消息、按 `chat_id`/`thread_id` 取最近上下文、发送询问卡片、更新卡片。
- 卡片按钮回调 `card.action.trigger` 先经过 `onCardAction`；只有 `action === 'avatar_reaction_route'` 才由替身处理，其他值原样交回原有 coordinator。

### 2.3 三种路由

| 路由 | 行为 |
| --- | --- |
| `main` | 通过注入的 `mainSession.dispatch({ origin: 'emoji' })` 发主会话；与网页静默触发一致，不新增用户气泡、不向飞书发消息 |
| `independent` | `runtime.start({ source: 'lark-avatar-reaction', sourceId: 'lark-reaction:<chat>:<thread|message>' })` 后 `dispatch`；同话题复用同一独立会话 |
| `ask` | 在原消息下回一张带「发到主会话 / 单独处理」按钮的卡片；回调按白名单校验操作人后再派活，并把卡片改成结果态 |

`暂停监听` 对所有飞书触发生效（reaction 事件也不能绕过）；配置了 `listenChats` 时，只有列表里的会话会触发，其他会话记 `chat_not_listened`。

### 2.4 去重与排除

- 账本表 `avatar_reaction_triggers`，主键 `messageId + operatorId + emoji`；`INSERT OR IGNORE` 决定是否触发，重投/双机器人同时收到事件只触发一次。
- 保留最近 500 条；`state` 为 `pending | dispatching | awaiting_route | dispatched | ignored | failed`，忽略/失败都写 `reason`（如 `operator_not_allowed`、`chat_not_listened`、`permission_denied: 403 ...`）。
- **操作人白名单**：reaction 与机器人消息入口共用 `isLarkOperatorAllowed()`（`allowedUsers` / `allowedEmails` / `allowedUserNames` / `allowedBots` / `peerBotsAllowed`）。未授权事件只落一条 `ignored/operator_not_allowed`，`main`、`independent`、`ask` 三条路由都不派发。
- **operator 身份**：白名单只保存 `open_id` / 应用 `open_id`。事件只给 `user_id`/`union_id` 时，受限名单下直接 fail-closed 并记 `operator_identity_unresolved`，不会拿 `user_id` 去猜 `open_id`。230001（操作人不在通讯录可见范围）只有 `operator_type` 明确是 `bot`/`app` 时才按 `peerBotsAllowed` 处理；`user`/`unknown` 一律拒绝。卡片回调（`card.action.trigger`）只可能由终端用户点击，入口固定声明 `user` + `open_id`，因此 230001 同样拒绝。
- **公开 trigger id**：账本主键是 `sha256(messageId + operatorId + emoji)` 的前 24 个 base64url 字符，短、稳定、无 NUL。飞书卡片的 `trigger_id` 和消息 `uuid`（`avatar-reaction-ask:<id>`）都用它；旧的 `messageId\0operatorId\0emoji` 拼接超过飞书 50 字符限制，会让默认 `ask` 路由必然失败。
- 替身自己通过 `emojiReactions` 加的表情在 `rememberSelfReaction()` 里按「消息 + emoji + 次数」记录 2 分钟，事件回传时消费一次并判 `self_reaction`。只消费一次是为了避免真实用户随后加同一个表情时被永久排掉；机器人/应用事件不会消费这个令牌。
- `operator_type` 为 `bot`/`app` 时默认忽略；可在设置里关掉。
- 未启用、emoji 不匹配、自己/机器人反应、重复、无主会话、询问卡发送失败、拉消息权限不足都有明确 reason。
- 派发前先把状态原子迁到 `dispatching`（CAS `pending → dispatching`），并给 `runtime.dispatch` 传稳定的 `clientMessageId`（等于 trigger id），覆盖 30 秒内的并发/网络重放（runtime 的 `recentSends` 是进程内、30 秒窗口）。
- 崩溃恢复分两种：`pending` 超过 2 分钟说明派发从未开始，飞书重投可以安全重领；`dispatching` 超过 2 分钟说明**派发可能已经开始**，而 runtime 的 `clientMessageId` 去重窗口只有 30 秒，自动重领会真的跑第二轮。因此 `dispatching` 不自动重领，只标成 `failed/dispatch_uncertain` 并在排障卡片里提示“重新添加表情”；用户新增一次表情（新 `action_time`）才会重试。
- `listenChats` 白名单会同时比较事件里的 `oc_*` chat_id 和反查到的网页网关数字 chat_id，避免两种 ID 体系导致整个群被静默过滤。

### 2.5 与主会话静默表情的差异

- 相同点：`main` 路由同样用 `origin=emoji`，主会话时间线不出现用户气泡。
- 不同点：去重在**服务端持久化账本**（跨重启），不是浏览器 localStorage；上下文来自飞书消息 API，而不是网页时间线；`ask` 路由多一张飞书卡片。

---

## 3. 测试

| 文件 | 覆盖 |
| --- | --- |
| `apps/server/src/lark-avatar/reaction-trigger.test.ts` | emoji 规范化、未启用/未配置/不匹配、自己/机器人排除、key 稳定、prompt 目标标记 |
| `apps/server/src/lark-avatar/reaction-trigger.service.test.ts` | 三种路由、去重（同消息不同用户可再次触发）、自己反应排除、机器人反应可配置、权限失败原因、无主会话、询问卡片授权与重复点击、配置回显 |
| `apps/server/src/lark/reaction-event.test.ts` | `im.message.reaction.created_v1` 字段解析（user/app/unknown/缺字段） |
| `apps/server/src/lark/service.test.ts` | 询问卡片的回调 value、reply 发送、选择后 PATCH |
| `apps/server/src/lark-avatar/routes.test.ts` | 新设置项保存/回显、非法 emoji/路由 400、触发账本列表 |
| `apps/web/src/lark-avatar-emoji.test.ts` | 下拉选项渲染（emoji + 名称 + 真实代码）、选中回显、历史自定义值保留、保存 payload |
| `apps/web/src/lark-avatar-reaction-diagnostics.test.ts` | 设置页把 outcome 翻成可读结论（三路由、跳过、失败） |
| `apps/server/src/lark-avatar/cli.test.ts` | fake reaction 注入参数、诊断输出与 limit 边界 |
| `apps/server/src/lark-avatar/protocol/client.test.ts` | 出站表情使用 command 25 / `reactions.PutReactionRequest` / `reactionType`，并解析 count |
| `apps/server/src/lark-avatar/store.test.ts` | 2 分钟 stale pending 可重新领取；stale dispatching 不自动重领 |
| `apps/server/src/lark/access-config.test.ts` | 共用操作人白名单：仅邮箱、仅姓名、allowedBots、230001 下 human/unknown fail-closed 与 bot 放行、`user_id`/`union_id` 拒绝 |
| `apps/server/src/lark-avatar/reaction-trigger.service.test.ts` | 三条路由的未授权拒绝、`operator_identity_unresolved`、ask 卡片失败归类、同一事件只发一张卡、短 trigger id、诊断不返回 payload、`clientMessageId` 幂等、stale dispatching 不重派、`count=0` 出站失败、事件先于 HTTP 响应的回声竞态 |
| `apps/server/src/lark/reaction-card.test.ts` | 询问卡片正文的 markdown 转义 |
| `apps/server/src/lark-avatar/protocol/client.test.ts` | `count=0`/空 payload/HTTP 200 + status 非 0 都按失败处理 |

所有测试使用 fake runtime / fake 协议客户端 / fake 端口，不给真人发消息。真实触发需要用户授权并准备测试群。

---

## 4. 已知限制

1. **Pin 不能实时触发**：飞书没有 Pin 事件；若以后要支持，只能定时轮询 `GET /open-apis/im/v1/pins`，会有延迟且需要额外权限。
2. **依赖机器人事件**：reaction 事件由机器人应用投递，不是替身的 Web 会话。机器人不在群、未订阅事件或没有消息读取权限时不会触发/会记 `permission_denied`。
3. **`ask` 卡片由机器人发出**（不是替身身份）；`main`/`independent` 不向飞书发消息，因此没有这个差异。
4. **替身自己加的表情靠内存记录 2 分钟**：daemon 在“加表情”和“事件回传”之间重启的极端情况下可能漏判；正常路径（同一进程）稳定。
5. 多机器人同时订阅时，去重账本保证只派活一次。
6. **旧版账本 key 不兼容**：trigger id 从 `messageId\0operatorId\0emoji` 改成了 hash 短 id。该功能此前没有发布过（0.3.9 不含 reaction 代码），正式库不会有旧记录；只有开发库里的历史 pending/awaiting_route 卡片会失效，重新加一次表情即可。
7. **2 分钟内的失败重试**：`pending` 记录在 2 分钟内仍按重复事件处理；如果派发前就失败，用户需要等 2 分钟或换一个 emoji 再试。排障卡片会显示 `duplicate`，不会假装成功。

---

## 5. 追加排查：为什么「加了表情没反应」

### 5.1 环境结论（2026-11-16）

| 环境 | 证据 | 结论 |
| --- | --- | --- |
| 正式 daemon | `agent-dock --version` = `0.3.9`；安装目录 `dist/cli.js` 搜不到 `reactionTrigger` / `im.message.reaction.created_v1`；生产日志有 `no im.message.reaction.created_v1 handle` | 正式实例是旧构建，**没有 reaction 触发代码**，需发版后才有 |
| 预览副本 | 进程环境 `AGENTDOCK_DISABLE_LARK_LISTENER=true`；avatar 状态 `disconnected`、`listening=false` | 不会连飞书，也不会收到事件；属于预期无反应 |
| 正式替身配置 | `~/.agentdock/agentdock.db.lark-avatar.db` 的 `avatar_state` 无记录 | 即使升级，也要先在「AI 飞书替身」里配置并打开监听 |

正式日志里历史上确实收到过 reaction 事件（`no ... handle` 警告出现在 11-08 至 11-13），说明该机器人的事件订阅此前已生效；0.3.9 只是没有 handler。升级到包含本功能的版本后，同一条事件会进入 `handleReaction`。

### 5.2 排障入口

- 设置页「表情触发排障」：显示最近一次 reaction 事件（emoji、operator、message、结论/原因、session/task）和最近 5 条账本。事件到了但被跳过时，会直接显示 `替身监听已暂停`、`emoji 与配置不匹配`、`重复事件`、`机器人没有读取消息权限` 等。
- CLI：`agent-dock lark avatar triggers [--limit 20] [--json]`。
- 日志：每条事件都会打一行 `飞书表情事件 <message> <emoji> <operatorType>/<operatorId> → <outcome>`；失败/跳过原因同时落账本。

### 5.3 失败重试

账本仍是「消息 + 操作人 + emoji」去重，但新增 `action_time` 区分“同一条事件重投”和“用户重新加了一次表情”：

- 失败/跳过记录：相同 `action_time` 重投仍是重复；新的 `action_time` 会允许重试。
- 已成功派发的记录：无论 `action_time` 是否变化都保持只触发一次。

### 5.4 沙箱自测（fake 事件）

仅在隔离沙箱（`AGENTDOCK_ALLOW_REACTION_TEST=true`）开放：

```bash
agent-dock dev run -- lark avatar reaction \
  --message om_test_1 --emoji THUMBSUP --operator ou_me \
  --action-time 100 --content "把发布说明整理一下"
agent-dock dev run -- lark avatar triggers
```

`ask` 路由注入后会返回 `action=awaiting_route`，再模拟点卡片：

```bash
agent-dock dev run -- lark avatar reaction-route --trigger '<短 trigger id>' --route main
```

本次已在隔离沙箱跑通三条链路：

> `agent-dock ... triggers` 会打印每条账本的短 trigger id（24 个字符），可直接复制给 `reaction-route --trigger`。旧的 NUL 拼接 key 无法作为 shell 参数传入。

- `main`：`om_main_1` → `ses_sandbox_main`，任务 `origin=emoji`；
- `independent`：`om_independent` → `ses_sandbox_independent`；
- `ask`：`om_ask2` → 询问卡 → 点击主会话 → `ses_sandbox_main`。

沙箱没有 Agent 登录态，任务落库后会因鉴权失败进入 `failed`；这不影响 reaction → 路由 → dispatch 的链路验证。真实飞书触发仍需用户授权并在测试群执行。

---

## 6. 随机表情回应（出站）不生效的根因与修复

「随机表情回应」和「表情触发」方向相反：前者是 `/ai` 触发后替身**主动给原消息加 2–3 个表情**，不依赖任何 reaction 事件。排查时在网页协议层发现原实现用错了命令：

| 项目 | 错误实现（0.3.9 及之前） | 正确实现（本次修复） |
| --- | --- | --- |
| 命令 | `x-command: 1011` | `x-command: 25` |
| 请求类型 | `messages.CreateReactionRequest` | `reactions.PutReactionRequest` |
| 字段 | `{ messageId, type }` | `{ messageId, reactionType }` |
| 响应 | 未解析 | `reactions.PutReactionResponse { count }` |

依据是上游 LarkAgentX 的 `add_reaction()`（`larkx/client.py:266`）以及其 `cmd_map.json` 中 `reactions.PutReactionRequest → cmd 25` 的映射；本地旧 proto 里的 `messages.CreateReactionRequest` 在飞书协议中并不存在，网关会返回 HTTP 200 但不产生表情。旧代码只在 `Promise.allSettled` 里记录 rejected，因此表现为“开了开关但完全没反应、日志也几乎没有”。

修复后：

- `apps/server/src/lark-avatar/protocol/client.ts` 使用 command 25 和 `reactionType`，并解析 `count`；
- `reactToTrigger()` 记录每个 emoji 的成功/失败，成功打 info、失败打 warn（带 messageId 和 emoji）；
- `GET /api/lark-avatar/reaction-diagnostics` 增加 `lastOutboundReaction`，设置页「表情触发排障」直接显示「随机表情回应：成功 N/M」和失败原因；
- `client.test.ts` 用 fake gateway 校验 command、请求字段和响应解析。

真实飞书里加表情仍需要用户授权；在没有授权时用 fake gateway 和隔离沙箱验证协议与链路。

补充核验（2026-11-16）：

- Web 协议的消息 ID 是**数字串**（`message.id`，例如预览库里的 `7707449809967303948`），不是 `om_*`；`react()` 直接使用这个数字串，单测已固定该行为。
- 用真实飞书网关做了一次**无副作用**探测：以不存在的消息 ID `0` 调 `x-command: 25`，网关返回 HTTP 400，错误体是 `message not found`——说明 command 25 和 `reactionType` 请求结构被网关识别；同时客户端现在会解析这个错误体，不再只显示 HTTP 400。
- 官方 emoji 列表（`https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce`）确认 `THUMBSUP/OK/DONE/HEART/SMILE/LAUGH/Fire/PARTY/GLANCE/CLAP/FINGERHEART/PRAISE/JIAYI/WINK/WOW/MUSCLE/THANKS/APPLAUSE` 等都在列表内；`APPLAUSE`、`JIAYI` 是真实代码，不是臆造。
- 配置保存后不需要重启：`handleIncomingMessage()` 每次都从 store 读取最新 `config.emojiReactions`；单测 `service.test.ts` 已覆盖「保存开关 → 发 `/ai` → 出现 2–3 个表情」以及「开话题回复 + 仅本人触发」组合。

## 7. 环境结论与正确体验方式

| 环境 | 现象 | 原因 / 正确做法 |
| --- | --- | --- |
| 正式 daemon `0.3.9` | 加表情没有轮次 | 该版本没有 `reactionTrigger*` 代码，也没有 `im.message.reaction.created_v1` handler；**需发版后才有**，不能把 0.3.9 当成已修复 |
| 预览副本 | 加表情没有轮次 | 实例设置 `AGENTDOCK_DISABLE_LARK_LISTENER=true`，且替身 `listening=false`；不会连真实飞书。正确做法是在隔离沙箱注入 fake reaction，或临时用测试群打开机器人监听 |
| 新版本 + 已配置机器人 | 事件通道未就绪时会明确显示 | 设置页排障卡片显示「机器人事件监听已关闭 / 还没有配置飞书机器人 / 机器人监听未连接」；reaction 事件只由机器人长连接投递，替身扫码登录本身收不到 |
| 新版本 + 机器人已就绪 | 加指定表情 → 三种路由 | 需要机器人已加入会话、订阅 `im.message.reaction.created_v1`、具备 `im:message:readonly`（读正文）和 reaction 读取权限 |

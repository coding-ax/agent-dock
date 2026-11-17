# 飞书「贴表情」识别说明

> 日期：2026-11-17
> 结论：能识别。飞书里的「贴表情」就是 reaction，事件名 `im.message.reaction.created_v1`；不是发一条 emoji 消息，也不是 Pin。

## 1. 结论与链路

```
飞书消息上贴表情
  → 机器人长连接收到 im.message.reaction.created_v1
  → parseLarkReactionEvent() 取出 message_id / emoji_type / operator / action_time
  → evaluateReactionTrigger() 判断开关、emoji、操作人类型
  → 按 message_id 调 OpenAPI 补 chat_id、正文和上下文
  → main / independent 派发一轮，origin=emoji；ask 先回一张选择卡片
```

关键代码位置：

- 事件注册：`apps/server/src/lark/listener.ts:2165`；收到后打日志 `收到飞书表情事件`（`listener.ts:2168`）并交给 `onReaction`。
- 事件解析：`apps/server/src/lark/listener.ts:71` 的 `parseLarkReactionEvent()`，类型在 `listener.ts:56`。
- 旁路到替身：`apps/server/src/lark/routes.ts:237`；操作人白名单与机器人消息入口共用。
- 判定与派发：`apps/server/src/lark-avatar/service.ts:1678` 的 `handleReaction()`；主会话路由在 `service.ts:2088` 写 `origin: 'emoji'`。
- 持久化账本：`apps/server/src/lark-avatar/store.ts:60` 的 `avatar_reaction_triggers` 表。

### 事件能拿到什么

| 字段 | 说明 |
| --- | --- |
| `message_id` | 被贴表情的消息，`om_*` |
| `reaction_type.emoji_type` | 飞书表情代码，如 `THUMBSUP`、`SMILE`、`DONE` |
| `operator_type` | `user` / `bot` / `app`；未知值归一化为 `unknown` |
| `user_id.open_id` / `user_id` / `union_id` | 操作人身份；解析优先级 open_id → user_id → union_id |
| `app_id` | 应用/机器人操作时的应用 ID |
| `action_time` | 贴表情时间（毫秒时间戳字符串） |

`operator_identity` 会记录 ID 来自哪个字段。白名单只保存 `open_id`，事件只给 `user_id`/`union_id` 时直接 fail-closed，并记 `operator_identity_unresolved`，不拿别的 ID 去猜。

**事件不带 `chat_id`，也不带正文。** 所以 `handleReaction()` 必须再用 `message_id` 调 `GET /open-apis/im/v1/messages/:message_id` 补消息，再按 `chat_id` 拉最近上下文。机器人不在群或没有读消息权限时，这一步会 403，账本记 `permission_denied`。

### 为什么不是 emoji 消息、也不是 Pin

- 发一条内容是 emoji 的消息，走的是 `im.message.receive_v1`，是普通消息，不是 reaction。
- Pin（置顶）飞书目前**没有事件**，只有 OpenAPI；只能主动查询，不能实时触发。给消息贴表情则稳定产生 reaction 事件。

## 2. 真实事件长什么样

飞书开放平台 v2 事件信封如下；本项目收到的是其中的 `event` 对象（`parseLarkReactionEvent` 的入参）。`schema`/`header` 是飞书 v2 事件的标准信封；`event` 内字段与应用内测试夹具一致。来源：`apps/server/src/lark/reaction-event.test.ts` 与 `docs/2026-11-16-lark-avatar-reaction-trigger.md`。下面所有 ID、时间戳均为演示值。

```json
{
  "schema": "2.0",
  "header": {
    "event_id": "0e2f0c3a9b7d4c1e8a5f6b7c8d9e0f1a",
    "event_type": "im.message.reaction.created_v1",
    "create_time": "1763365432000",
    "token": "v2",
    "app_id": "cli_a1b2c3d4e5f6g7h8",
    "tenant_key": "736588c9260f175e"
  },
  "event": {
    "message_id": "om_dc13264520392913993dd051dba21dcf",
    "reaction_type": { "emoji_type": "THUMBSUP" },
    "operator_type": "user",
    "user_id": {
      "union_id": "on_8ed6aa67826108097d9ee143816345",
      "user_id": "e33ggbyz",
      "open_id": "ou_7d8a6e6df7621556ce0d21922b676706"
    },
    "action_time": "1763365431000"
  }
}
```

## 3. 沙箱实证

环境：`node apps/server/dist/cli.js dev up`，独立数据库、独立 HOME；正式实例未重启、未改数据。沙箱本身关闭了飞书长连接，因此本轮用官方格式的事件体注入，验证「解析 → 命中 → 起一轮」；长连接注册本身由上面的代码位置证明。

### 证据 A：解析器吃到官方字段

```bash
npx tsx /tmp/reaction-probe.mts   # 直接 import apps/server/src/lark/listener.ts
```

```json
{
  "messageId": "om_dc13264520392913993dd051dba21dcf",
  "emojiType": "THUMBSUP",
  "operatorType": "user",
  "operatorIdentity": "open_id",
  "operatorId": "ou_7d8a6e6df7621556ce0d21922b676706",
  "actionTime": "1763365431000"
}
```

### 证据 B：命中配置并派发

```bash
node apps/server/dist/cli.js dev run -- lark avatar reaction \
  --message om_dc13264520392913993dd051dba21dcf --emoji THUMBSUP \
  --operator ou_7d8a6e6df7621556ce0d21922b676706 \
  --chat oc_9f2b7c1d4e6a8f0c1b2d3e4f5a6b7c8d --chat-name "表情验收群" \
  --sender "测试同事" --content "帮我把这版发布说明整理一下" \
  --action-time 1763365431000 --json
```

```json
{
  "ok": true,
  "action": "trigger",
  "sessionId": "ses_b049fe44-fab0-465d-aba5-73e4c4bca5e4",
  "taskId": "task_53a32ff9-57fa-4c08-bf3e-fa12da5bb228",
  "diagnostics": {
    "lastEvent": {
      "messageId": "om_dc13264520392913993dd051dba21dcf",
      "emojiType": "THUMBSUP",
      "operatorType": "user",
      "outcome": "triggered:main",
      "route": "main"
    }
  }
}
```

### 证据 C：CLI 排障输出

正式实例用 `agent-dock lark avatar triggers`；沙箱里同一命令为：

```bash
node apps/server/dist/cli.js dev run -- lark avatar triggers --limit 10
```

```
最近一次表情事件：
2026-11-17T08:05:51.949Z  THUMBSUP  user/ou_7d8a6e6df7621556ce0d21922b676706
  triggered:main  session=ses_b049fe44-fab0-465d-aba5-73e4c4bca5e4 task=task_53a32ff9-57fa-4c08-bf3e-fa12da5bb228

最近 1 条触发账本：
- 2026-11-17T08:05:51.949Z [9dduYa9yGmsQ2erRlM3UWfjZ] THUMBSUP dispatched task=task_53a32ff9-57fa-4c08-bf3e-fa12da5bb228
```

同一环境下把 emoji 换成 `SMILE`：

```json
{ "ok": false, "action": "ignore", "reason": "emoji_mismatch",
  "lastEvent": { "emojiType": "SMILE", "outcome": "ignored:emoji_mismatch", "detail": "SMILE" } }
```

机器人贴同样的 `THUMBSUP`：

```json
{ "ok": false, "action": "ignore", "reason": "bot_reaction",
  "lastEvent": { "operatorType": "bot", "outcome": "ignored:bot_reaction" } }
```

### 证据 D：task / 账本落库

```sql
-- agentdock.db
SELECT id, status, origin, session_id FROM tasks;
-- task_53a32ff9-57fa-4c08-bf3e-fa12da5bb228 | completed | emoji | ses_b049fe44-...

-- agentdock.db.lark-avatar.db
SELECT key, message_id, emoji, state, reason FROM avatar_reaction_triggers;
-- 9dduYa9yGmsQ2erRlM3UWfjZ | om_dc1326... | THUMBSUP | dispatched |
-- Azfr7GXwku6cln0D34whgjHX | om_3333...   | THUMBSUP | ignored | bot_reaction
```

注意：`SMILE` 不匹配时**不写账本**（设计上只记录「已启用且 emoji 命中」的跳过原因），但 `lastEvent` 与日志仍会给出 `emoji_mismatch`。

### 证据 E：原始日志行

`/.agentdock/dev/work/.agentdock/daemon/agentdock.log`：

```
飞书表情事件 om_dc13264520392913993dd051dba21dcf THUMBSUP user/ou_7d8a6e6df7621556ce0d21922b676706 → triggered:main
飞书表情事件 om_22222222222222222222222222222222 SMILE user/ou_7d8a6e6df7621556ce0d21922b676706 → ignored:emoji_mismatch：SMILE
飞书表情事件 om_33333333333333333333333333333333 THUMBSUP bot/cli_a1b2c3d4e5f6g7h8 → ignored:bot_reaction：bot
```

## 4. 必须满足的前提

| 条件 | 缺了会看到什么 |
| --- | --- |
| 机器人已加入目标群 | 事件可能到达，但读消息失败：`permission_denied` / `message_fetch_failed`，卡片写「机器人没有读取消息权限」 |
| 应用已订阅 `im.message.reaction.created_v1` | 完全没有事件；`triggers` 显示「还没有收到 reaction 事件」，但事件通道可能是绿色 |
| 应用有 `im:message.reactions:read` | 事件订阅无法生效/收不到 reaction；排障卡片没有最近事件 |
| 应用有 `im:message:readonly` | 读消息 403，账本 `permission_denied`，无法补 `chat_id`/正文 |
| 替身监听已连接 | 排障卡片「机器人监听未连接」/「没有启用中的飞书机器人」/「还没有配置飞书机器人」；账本 `not_connected` |
| `reactionTriggerEnabled=true` 且 emoji 与配置一致 | `ignored:disabled` / `ignored:emoji_not_configured` / `ignored:emoji_mismatch` |
| `listenChats` 为空或包含该群 | 账本 `ignored` + `chat_not_listened`，卡片「会话不在监听白名单」 |
| 操作人在机器人白名单 | 账本 `operator_not_allowed`；只给 user_id/union_id 时是 `operator_identity_unresolved` |

一键创建的机器人已预设上面的事件与权限（`apps/server/src/lark/routes.ts:65-79`）；老机器人需要去开发者后台补订阅和权限。

## 5. 用户亲自试（5 步）

1. 打开 AgentDock → 左下角设置 → **AI 飞书替身**，在「表情触发」里打开 **启用表情触发**，触发 emoji 选 **👍（THUMBSUP）**，默认路由选「主会话」或「先询问」，保存。
2. 确认同一面板上方状态是已连接、监听没有暂停；在飞书开发者后台确认机器人已进群，应用已订阅 `im.message.reaction.created_v1`，并有 `im:message.reactions:read`、`im:message:readonly`。
3. 在群里找一条**别人发的**消息（不要用机器人自己发的），贴 **👍**。不要用 Pin，Pin 不会触发。
4. 回到「AI 飞书替身」→「表情触发排障」看「最近事件」：成功应显示「已发到主会话」或「已发询问卡片」；也可以运行 `agent-dock lark avatar triggers`。
5. 去任务/会话列表看这一轮：应有 `origin=emoji` 的轮次；主会话路由不会在时间线新增用户气泡。

## 6. 识别不到的 5 类原因

| # | 原因 | 典型排障信息 | 处理 |
| --- | --- | --- | --- |
| 1 | 应用没订阅 reaction 事件 | 没有任何最近事件；「还没有收到 reaction 事件」 | 开发者后台 → 事件订阅，加 `im.message.reaction.created_v1`，发布版本 |
| 2 | 机器人不在群 / 没有读消息权限 | `failed:permission_denied`（403/99991672 等）或 `missing_message` | 把机器人拉进群，补 `im:message:readonly` |
| 3 | 替身监听未连接 | 「机器人监听未连接」；`not_connected` / `listening_paused` | 检查机器人配置、打开监听；不要用扫码登录的网页会话代替机器人长连接 |
| 4 | emoji 不匹配 | `ignored:emoji_mismatch`，`detail=SMILE`；卡片「emoji 与配置不匹配」 | 设置里改成同一个表情代码；👍 对应 `THUMBSUP` |
| 5 | 自己或机器人加的表情被排除 | `ignored:self_reaction` / `ignored:bot_reaction` | 这是设计：替身自己发的反馈表情、bot/app 操作默认不触发；换真人账号贴，或在设置里关闭「忽略机器人添加的表情」 |

第 5 类的细节：替身通过 `emojiReactions` 出站加表情时会先记一个令牌，键是「消息 + 规范化 emoji」，有效期 **2 分钟**，事件回传时消费一次并判 `self_reaction`。只消费一次，是为了真实用户随后贴同一个表情仍能触发；bot/app 事件不会消费这个令牌，而是直接按 `operator_type` 排除。所以这不是漏判，而是防止机器人自己的表情回声触发第二轮。

另外两种常见但不是「识别不到」的情况：同一「消息 + 操作人 + emoji」重复投递会记 `duplicate`（账本幂等）；暂停监听时所有飞书触发都记 `listening_paused`。

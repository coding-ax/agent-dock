# lark-avatar @ 机器人：协议、解析与 CLI 方案

> 状态：调研 + 设计草案；**2026-11-16 P0 已修复**（ID 全链路字符串化 + `oc_*` 映射兜底）
> 日期：2026-11-16
> 范围：`apps/server/src/lark-avatar/`（AI 飞书替身，用户身份 Web 协议）
> 目标：在已登录 AI 替身账号时，CLI 既能 `@` 人类，也能 `@` 应用机器人；人类与机器人可混用。

---

## 0. 结论摘要

1. **发送协议层不需要新增“机器人专用字段”。** 机器人是 `entities.Chatter.type = BOT` 的普通 chatter；出站 `@` 仍是富文本 `tag=5` 的 `AtProperty { userId, content }`，机器人数字 id 同时进 `PutMessageRequest.atUserIdList`。没有 `bot=true` 之类的标记。
2. **`AtProperty` / `atUserIdList` 与解析层现已统一使用字符串 ID。** 解析结果中的 `chatId` / `rootId` / `userId` 都是规范十进制字符串，`toDecimalId()` 只校验十进制和 int64 范围，不再用 `Number.isSafeInteger`。19 位 chat/user/root id 可原样进入 protobuf（`atUserIdList` 由 protobufjs 的 `Long` 编码），不会经过 JS `number`。
3. **当前无法可靠“按名字找机器人”。** 现有成员目录只来自本机 inbox 和最近消息参与者（`id-resolution.ts:705-749`），机器人如果从没说过话、也没被人 @ 过，就完全不在目录里。需要新增群成员枚举（`chats.PullChatChattersRequest`，cmd 44），并用 `Chatter.type` 过滤 BOT。
4. **本地 proto 把机器人信息丢了。** 本地 `entities.Chatter` 只有 `id/name/avatar/email`，没有 `type`、`botConfig`、`alias`；`chatters.PullChattersByIdsResponse` 也没有 `botInfo`。请求里虽然已经发了 `needBotInfo: true`（`proto.ts:205-206`），响应字段仍被 protobufjs 忽略。
5. **CLI 建议显式 `--at-bot`，并保留 `--at` 的人类语义。** `--at-bot <名字|cli_*|ou_*|数字 id>` 可重复，可与 `--at` 混用；HTTP 增加 `atBots`（以及可选的 `{ target, kind }` 对象形式）。机器人按名字默认精确匹配，重名必须用 `app_id` 或数字 id 消歧。
6. **“能发出去”不等于“能触发回调”。** 目标必须是**应用机器人**（不是群自定义 webhook 机器人），已加入群、已发布、订阅 `im.message.receive_v1`，并具备群内 @ 消息权限。回调侧用 `mentions[].id.open_id` 匹配自身；`app_id` 不是 @ 目标。`open_id` 有应用作用域，跨应用传入的 `ou_*` 可能无法解析。

---

## 1. 协议与字段证据

### 1.1 人类 vs 机器人：成员与身份

| 维度 | 人类用户 | 应用机器人 |
| --- | --- | --- |
| Web 成员类型 | `Chatter.type = USER(1)` | `Chatter.type = BOT(2)`；`AI(3)` 是 AI 助手 |
| 主要 id | 数字 chatter id（租户内） | 数字 bot id（int64，租户内）；另有 `app_id = cli_*`、`open_id = ou_*` |
| 是否在群成员列表 | 是 | 是（应用机器人加入群后） |
| 消息发送者 | `Message.fromType = USER(1)` | `Message.fromType = BOT(2)`，但参考实现指出私聊里并不可靠，不能作为唯一判据 |
| 出站 @ 编码 | tag 5 `AtProperty.userId` + `atUserIdList` | 完全相同，`userId` 换成机器人数字 id |
| 回调身份 | 无“被 @ 回调” | `im.message.receive_v1` 的 `mentions[].id.open_id` / `sender_type` |

**本地 proto 证据**

- `apps/server/src/lark-avatar/protocol/lark.proto:109-116`：本地 `entities.Chatter` 只有 `id/name/avatarUrl/enUsName/email/avatarImage`，没有 `type`。
- `apps/server/src/lark-avatar/protocol/lark.proto:76`：`Message.FromType { USER = 1; BOT = 2; }`。
- `apps/server/src/lark-avatar/protocol/lark.proto:152`：`AtProperty { string userId = 1; string content = 2; }`。
- `apps/server/src/lark-avatar/protocol/lark.proto:206`：`PutMessageRequest.atUserIdList` 是 `repeated int64`。
- `apps/server/src/lark-avatar/protocol/lark.proto:50-55`：`chatters.PullChattersByIdsRequest` 已有 `needBotInfo = 2`。

**完整 Web schema 证据（公开实现反射）**

用 `LarkAgentX`（commit `d288ef4`）的 `lark_all_pb2.py` 反射得到：

- `lark.entities.Chatter.type`（field 9）枚举：`UNKNOWN_CHATTER=0, USER=1, BOT=2, AI=3`
- `lark.entities.Chatter.botConfig`（field 17）：`withBotTag / inContacts / canJoinGroup / botExtType / isAgent`
- `lark.entities.Chatter.alias`（field 19）
- `lark.chatters.PullChattersByIdsResponse.botInfo`（field 3）：`map<int64, entities.BotInfo>`
- `lark.entities.BotInfo { int64 botId = 1; AppStatusInfo appStatus = 2; }`
- `lark.entities.AppStatusInfo { string cliId = 1; int64 appId = 10; ... }`

这说明：

- 机器人在协议里就是 `Chatter`，不是另一种消息实体。
- `app_id` 不在 `Chatter` 本身上；需要 `botInfo -> appStatus.cliId`（`cli_*`）或 `appStatus.appId`（数字）来映射。
- 本地 decoder 没声明这些字段，所以现在即使服务端返回了，也会被丢弃。

**公开实现证据**

- `LarkAgentX/larkx/client.py:310-322`：`is_bot()` 查 `Chatter.type`，注释明确写 `1 用户, 2 机器人, 3 AI 助手`，并说“消息上的发送者类型不可靠”。
  <https://github.com/cv-cat/LarkAgentX/blob/d288ef4df8a42f6286c5506b7185f64430071490/larkx/client.py#L310-L322>
- `reorx/feishu-lite` 的协议笔记：`PullChattersByIdsRequest` 能查到机器人（`type == 2`），`fromType` 1 用户 / 2 机器人。
  <https://github.com/reorx/feishu-lite/blob/2272275b0f0d7a4badcc6eca07dbf00790ca3d27/kb/notes/2026-09-29-protocol-spike.md#L39-L53>

### 1.2 群成员枚举：机器人是否在成员列表

完整 Web schema 中有两组可用接口：

- `chats.PullChatChattersRequest`（cmd 44）
  - `string chatId = 1`
  - `bool needChatters = 2`
  - `int64 cursor = 3`
  - `string offset = 4`
  - `int32 limit = 5`
- `chats.PullChatChattersResponse`
  - `map<string, entities.Chatter> chatters = 1`
  - `int64 nextCursor = 5`
  - `string nextOffset = 9`
  - `groupNicknames`、`metas` 等附加字段
- `chats.CheckChattersInChatRequest`（cmd 271）
  - `string chatId = 1`
  - `repeated string chatterIds = 2`
  - 响应 `map<string, bool>`，适合做“是否在群”的快速校验
- `chats.PullChatChattersByIDsRequest`（cmd 5023）
  - `int64 chatId = 1`
  - `repeated int64 chatterIds = 3`
  - `needChatters = 2`、`needBotInfo = 4`

公开实现 `SugarMGP/LarkX` 用 `chats.PullChatChattersRequest` 拉群成员，并注明“机器人没有 email”：

<https://github.com/SugarMGP/LarkX/blob/8bd7f9a001dd5f5d20aaefea6e7f6926ca7ae19f/src/larkx/client.py#L315-L325>

OpenAPI 侧也明确区分 `users` 和 `bots`：`apps/server/src/lark/service.ts:660-699` 的 `listChatMembers()` 同时解析 `data.users` 与 `data.bots`，并把 `member_type` 标成 `user` / `bot`；`apps/server/src/lark/service.ts:43-52` 定义了 `LarkChatMemberType = 'user' | 'bot'`。这证明飞书的“群成员”概念本身包含机器人，只是现有 lark-avatar 没走这条枚举路径。

> **待实测**：`chats.PullChatChattersRequest` 在 Web 网关是否一定返回 bot 成员。schema、参考实现和 OpenAPI 都支持这个判断，但仍应在真实群做一次成员枚举确认。

### 1.3 消息里的 @ 表示

出站：

- 富文本元素 `tag = 5`（`AT`）
- `AtProperty.userId` 是字符串；放机器人数字 id
- `AtProperty.content` 是显示文本
- `PutMessageRequest.atUserIdList` 是 `repeated int64`，放机器人数字 id

本地编码路径：

- `apps/server/src/lark-avatar/protocol/proto.ts:319-346`：`LarkMention.userId` 类型是 `string | number | bigint`；`normalizeMentionUserId()` 用 `BigInt` 校验 int64，并明确拒绝 `ou_*`，因为协议层不直接接受 open_id。
- `apps/server/src/lark-avatar/protocol/proto.ts:388-404`：按正文位置切分 `text` / `at` segment。
- `apps/server/src/lark-avatar/protocol/proto.ts:426-431`：`AT` 元素写 `AtProperty { userId, content }`。
- `apps/server/src/lark-avatar/protocol/proto.ts:433-454`：`atUserIdList` 按首次出现去重；注释明确“AT 元素保留重复 @；atUserIdList 是通知集合”。
- `apps/server/src/lark-avatar/protocol/proto.mentions.test.ts:190-204`：已有测试证明 `9007199254740993` 这种超过安全整数的 id 能按字符串精确编码。

公开实现也使用同一形状：

- `LarkAgentX/larkx/proto/compose.py:158-163`：`AtProperty(userId=str(user_id), content='@' + name)`，并加入 `rich.atIds`。
- `LarkAgentX/larkx/proto/compose.py:324-325`：`req.atUserIdList.append(int(uid))`。
- `SugarMGP/LarkX/src/larkx/proto/builders.py:347-348`：`atUserIdList` 只收数字 id；`all` 塞不进 int64，所以不加入。

**@all 是唯一需要特殊 userId 的常见情况**：`AtProperty.userId = "all"`，且不加入 `atUserIdList`。机器人不是这种情况，机器人走普通数字 id。

### 1.4 机器人被 @ 后的回调

官方“接收消息”事件文档：
<https://open.feishu.cn/document/server-docs/im-v1/message/events/receive>

关键点（来自官方页面正文）：

- 事件：`im.message.receive_v1`，机器人接收用户/机器人发送的消息后触发。
- 权限按场景区分：
  - 群内**用户** @ 当前机器人：`im:message.group_at_msg` 或 `im:message.group_at_msg:readonly`
  - 群内**用户和其他机器人** @ 当前机器人：`im:message.group_at_msg.include_bot:readonly`
  - 群内所有消息（含其他机器人）：`im:message.group_msg.include_bot:read`
- 可用 `sender_type` 区分 `user` / `bot`。
- 事件里的发送者 id 同时可能出现 `union_id`、`user_id`、`open_id`。

因此：

- **人类 AI 替身 @ 目标机器人**：目标机器人只需要普通的“用户 @ 机器人”权限。
- **另一个机器人 @ 目标机器人**：目标机器人需要 `include_bot` 版本权限。
- 目标机器人通常用 `mentions[].id.open_id` 与自身 `bot_open_id` 比对；`app_id` 是应用标识，不是 @ 目标。

第三方 A2A 实测文章补充了两个重要事实（非官方，但和官方字段一致）：
<https://www.tianlejin.top/blog/hermes-feishu-a2a-best-practices>

- `open_id` 有应用作用域，同一主体在不同应用下可能不同；A2A 最稳的是目标 bot 自己用 `/open-apis/bot/v3/info` 公布的 self `open_id`。
- 群成员接口返回的 `bot_id` / `member_id` 也可能触发 @；随机伪造的 `ou_*` 不行。

这直接决定 CLI 的 id 策略：优先 `app_id` 或群成员里的数字 bot id；`ou_*` 只做“当前 Web 会话能解析”时的兼容输入，并给出作用域警告。

---

## 2. 与现实现的差距

### P0（已修复，2026-11-16）：ID 曾被强制转成 JS `number`，大 id 直接被拒

**修复结果**

- `ResolvedLarkChat.chatId`、`ResolvedLarkTarget.chatId/rootId`、`ResolvedLarkMention.userId` 全部改成 `string`。
- `toNumericId()` 改为 `toDecimalId()`：只校验十进制与 `1..2^63-1`，返回规范字符串；新增 `ID_OUT_OF_RANGE`，移除 `ID_NOT_SAFE_INTEGER`。
- protobuf 的 string 字段（`chatId` / `rootId` / `parentId` / `AtProperty.userId`）直接写原字符串；`atUserIdList` 的 int64 由 protobufjs 用 `Long` 编码。
- `entities.Chat` 补上公开 schema 中的 `string openChatId = 134`；`oc_*` 优先从 Web 群列表直接映射，其次直查 Web 网关，最后用已配置的飞书机器人 OpenAPI `getChat` 按群名反查并缓存。
- 回归覆盖：19 位 chat/root/user、超过 2^53 的 wire 精度、`oc_*` 直命中/OpenAPI 命中/未命中、CLI 用户实测命令。

修复前证据（历史）：

- `apps/server/src/lark-avatar/id-resolution.ts:81-84`：`ResolvedLarkMention.userId` 是 `number`。
- `apps/server/src/lark-avatar/id-resolution.ts:456-490`：`resolveMention()` 最终都走 `toNumericId()`。
- `apps/server/src/lark-avatar/id-resolution.ts:771-785`：`toNumericId()` 如果 id 超过 `Number.isSafeInteger`，抛 `ID_NOT_SAFE_INTEGER`。
- `apps/server/src/lark-avatar/service.ts:433-438`：发送时再 `String(mention.userId)`。

修复前影响：

- 19 位机器人 id（如 `7701...`）无法通过解析层，尽管编码层完全能处理。
- 部分真实人类 id、chat id 也可能触发同一问题；这不是机器人独有。
- `proto.mentions.test.ts:190-204` 已经证明编码层支持大 int64，说明修在解析层即可，不需要改 wire format。

原建议已全部落地，并且覆盖范围从 mention 扩展到 chat/root：

- `AtProperty.userId` 和 `atUserIdList` 继续保持字符串/`longs: String`，不调用 `Number()`。
- `ID_NOT_SAFE_INTEGER` 已从错误码中移除。
- `chatId/rootId` 与 mention 一起完成字符串化，避免同一条发送链路里两套 ID 语义。

### P1：本地 `Chatter` schema 缺 `type` / `botConfig` / `botInfo`

- `apps/server/src/lark-avatar/protocol/lark.proto:109-116` 没有 `type`。
- `apps/server/src/lark-avatar/protocol/proto.ts:86-91` 的 `LarkChatterInfo` 没有 `type`。
- `apps/server/src/lark-avatar/protocol/proto.ts:208-215` 的 decoder 只取 `id/name/avatar/email`。
- `apps/server/src/lark-avatar/protocol/proto.ts:205-206` 已经发送 `needBotInfo: true`，但响应没有声明 `botInfo`。

后果：即使网关返回 `type=2` 和 `botInfo`，代码也看不见；无法区分人类/机器人，更无法按 `app_id` 查。

### P1：没有群成员枚举，只有“最近消息参与者”

- `apps/server/src/lark-avatar/id-resolution.ts:705-749` 的 `chatterDirectory()` 只从：
  - 本机 inbox 的 `senderId`
  - 最近 `maxScanMessages` 条消息的 `fromId` 和 `atUserIds`
- 然后对这些 id 调 `lookup()` 补名字。

后果：

- 从没发过言、也没被 @ 过的群机器人不在目录里。
- 机器人改名后，旧消息里的名字可能过期。
- 多个同名机器人只能靠消息历史碰运气，不能可靠消歧。

### P2：CLI/API 没有类型维度

- `apps/server/src/lark-avatar/cli.ts:4-22`：`at?: string[]`，没有 kind。
- `apps/server/src/cli-program.ts:247-264`：只有 `--at <user>`。
- `apps/server/src/lark-avatar/routes.ts:51-90`：只接受 `at: string[]` 并透传。
- `apps/server/src/lark-avatar/service.ts:416-438`：mention 只有 `{ userId, name }`，没有 `kind`。

后果：同名人类/机器人无法显式选择；错误提示也只能说“用户找不到”。

### P2：`AtProperty.content` 是否要带 `@` 尚未定论

- 现实现：`content` 是“不含前导 @ 的显示名”（`proto.ts:427-430`）；测试也这样断言（`proto.mentions.test.ts:119-125`）。
- 参考实现：`LarkAgentX` 和 `LarkX` 都写 `content = '@' + name`；`feishu-lite` 笔记也说 `content` 自带 `@`。
- 现有人类 @ 已经能发出，说明服务端至少不依赖 `content` 前缀来寻址；但不能据此断定机器人回调也完全不受影响。

建议：第一版 bot @ **沿用现有人类路径的形状**（`content = 显示名`，`userId = bot 数字 id`），只替换 id；真实环境做 A/B 对照。如果目标机器人收不到 mention，再把所有 AT 的 `content` 统一改成 `@显示名` 并回归人类 @。不要只为机器人引入不同的 content 规则。

---

## 3. 协议/编码草案

### 3.1 schema 增补（只增不改）

在本地 `lark.proto` 中补最小字段：

```proto
message chatters {
  message PullChattersByIdsResponse {
    map<string, entities.Chatter> chatters = 1;
    int64 maxAge = 2;
    map<int64, entities.BotInfo> botInfo = 3;
  }
}

message entities {
  message Chatter {
    enum Type { UNKNOWN_CHATTER = 0; USER = 1; BOT = 2; AI = 3; }
    string id = 1;
    string name = 2;
    string avatarUrl = 5;
    Type type = 9;
    string enUsName = 14;
    string tenantId = 15;
    BotConfig botConfig = 17;
    string alias = 19;
    string email = 25;
    Image avatarImage = 29;
  }

  message BotConfig {
    string withBotTag = 1;
    bool inContacts = 2;
    bool canJoinGroup = 3;
    int32 botExtType = 4;
    bool isAgent = 5;
  }

  message BotInfo {
    int64 botId = 1;
    AppStatusInfo appStatus = 2;
  }

  message AppStatusInfo {
    string cliId = 1;
    int64 appId = 10;
    map<string, string> i18nNames = 7;
  }
}

message chats {
  message PullChatChattersRequest {
    string chatId = 1;
    bool needChatters = 2;
    int64 cursor = 3;
    string offset = 4;
    int32 limit = 5;
  }
  message PullChatChattersResponse {
    map<string, entities.Chatter> chatters = 1;
    int64 nextCursor = 5;
    string nextOffset = 9;
  }
  message CheckChattersInChatRequest {
    string chatId = 1;
    repeated string chatterIds = 2;
  }
  message CheckChattersInChatResponse {
    map<string, bool> chatters = 1;
  }
}
```

命令号（来自公开 `cmd_map.json`）：

| 请求 | cmd |
| --- | ---: |
| `bots.PullBotsRequest` | 38 |
| `chats.PullChatChattersRequest` | 44 |
| `chatters.PullChattersByIdsRequest` | 46 |
| `chats.CheckChattersInChatRequest` | 271 |
| `chats.PullChatChattersByIDsRequest` | 5023 |

### 3.2 内部 mention 模型

```ts
type LarkMentionKind = 'user' | 'bot';

interface ResolvedLarkMention {
  kind: LarkMentionKind;
  userId: string;        // 规范十进制，绝不先转 Number
  name: string;          // 展示名，不含前导 @
  appId?: string;        // 仅 bot：cli_xxx
  openId?: string;       // 仅 bot：ou_xxx，注明应用作用域
}
```

编码时：

```ts
for (const mention of resolvedMentions) {
  // tag 5
  property = AtProperty {
    userId: mention.userId,      // bot 或 human 都是十进制字符串
    content: mention.name        // 第一版沿用现有人类路径
  };
  atUserIdList.push(mention.userId); // bot 同样加入；按首次出现去重
}
```

要点：

- 不把 `appId` / `openId` 写进 `AtProperty`。
- 不为 bot 增加特殊 tag / enum / 布尔字段。
- `atUserIdList` 是通知集合，bot 必须包含；`atOutChatterIds` 只出现在入站 `Message`，不是出站字段。
- 重复 @ 同一个 bot：保留多个 AT 元素，`atUserIdList` 去重。
- `@all`：`userId = "all"`，不加入 `atUserIdList`；与 bot 无关。

---

## 4. 解析方案

### 4.1 目录来源

新增一个“群成员目录”层，优先级：

1. **群成员枚举**（权威）：`chats.PullChatChattersRequest(chatId, needChatters: true, limit: 100)`，翻页收集。
2. **botInfo 补全**：对其中 `type=BOT` 的 id，批量调 `chatters.PullChattersByIdsRequest(ids, needBotInfo: true)`，拿 `botInfo -> appStatus.cliId/appId/i18nNames`。
3. **inbox / 最近消息**：只作为成员枚举不可用时的降级，或作为群昵称补充；不能作为 bot 发现的唯一来源。
4. **全局 bot 目录**（可选）：`bots.PullBotsRequest({ needBotInfo: true, count: 100 })`，用于区分“机器人存在但不在群”和“根本不存在”。该接口在用户 Web 会话下是否可用需实测，失败不应阻断群内解析。

### 4.2 查询分派

对每个 `--at-bot` 输入 `raw`（去掉前导 `@`）：

| 输入形态 | 解析路径 |
| --- | --- |
| 纯数字 | 直接当数字 chatter id；`lookup + botInfo` 确认 `type=BOT`；`CheckChattersInChat` 确认在群 |
| `cli_*` | 在群成员 bot 的 `appStatus.cliId` 中精确匹配；找不到再看全局 bot 目录；仍找不到 -> `BOT_NOT_IN_CHAT` / `BOT_NOT_FOUND` |
| `ou_*` | 先按当前 Web 会话 lookup；能解析则检查 `type=BOT` 和在群；解析失败提示 open_id 应用作用域，建议改用 app_id/数字 id |
| 名字 | 在群成员 `type=BOT` 中做 NFKC + lower + 去空白后的精确匹配；默认不做模糊匹配 |

人类 `--at` 仍走现有路径，但目录项要带 `kind`，并在最终选择时过滤 `kind === 'user'`。

### 4.3 同名与歧义

- 同名两个机器人：`BOT_AMBIGUOUS`，`candidates` 包含 `{ name, userId, appId, openId }`，提示改用 `cli_*` 或数字 id。
- 人类与机器人同名：
  - `--at` 只选人类；
  - `--at-bot` 只选机器人；
  - 如果未来让 `--at` 自动识别，跨 kind 多候选必须报 `MENTION_AMBIGUOUS`，不能靠名字猜。
- 机器人不在群：
  - 群成员里有同名人类但没有该 bot，且全局目录能确认 bot 存在 -> `BOT_NOT_IN_CHAT`，提示“先把机器人拉进群”。
  - 全局目录不可用 -> `BOT_NOT_FOUND`，提示同时检查“名称是否正确 / 是否在群”。
- 机器人存在但 `type` 不是 BOT（例如传了人类 open_id）-> `BOT_TYPE_MISMATCH`，提示改用 `--at`。
- `--at` 解析到 BOT -> `BOT_REQUIRES_AT_BOT`，提示改用 `--at-bot`。

### 4.4 错误码建议

| 错误码 | HTTP | 场景 |
| --- | ---: | --- |
| `BOT_NOT_FOUND` | 404 | 群成员和全局目录都没有匹配的 bot |
| `BOT_NOT_IN_CHAT` | 409 | bot 存在，但不在当前群 |
| `BOT_AMBIGUOUS` | 409 | 多个同名 bot |
| `BOT_REQUIRES_AT_BOT` | 400 | `--at` 命中了 bot |
| `BOT_TYPE_MISMATCH` | 400 | `--at-bot` 命中了人类 |
| `BOT_APP_ID_INVALID` | 400 | `cli_*` 格式错误或无法映射 |
| `BOT_DIRECTORY_UNAVAILABLE` | 409 | 当前 Web 网关没有成员枚举能力 |
| `BOT_DIRECTORY_TRUNCATED` | 409 | 成员分页被截断/达到安全上限 |
| `MENTION_TEXT_MISSING` | 400 | 正文没有对应的 `@显示名`（可保留现有 `INVALID_INPUT` 兼容） |
| `MENTION_KIND_CONFLICT` | 400 | 同一个 id 同时以 user/bot 传入 |

现有 `USER_NOT_FOUND` / `USER_AMBIGUOUS` 保留给人类，避免破坏已有调用方。

---

## 5. CLI / API 设计

### 5.1 CLI 语法

主推显式参数，`--at` 与 `--at-bot` 可重复、可混用：

```bash
agent-dock lark avatar send \
  --chat "发布群" \
  --text "@张三 @小助手 请确认发布窗口" \
  --at 张三 \
  --at-bot 小助手
```

按 app_id / 数字 id 消歧：

```bash
agent-dock lark avatar send --chat "发布群" \
  --text "@小助手 请确认" \
  --at-bot cli_a1b2c3d4

agent-dock lark avatar send --chat "发布群" \
  --text "@小助手 请确认" \
  --at-bot 7701370664338361634
```

参数语义：

- `--at <user>`：人类；接受姓名、`ou_*`、数字 id。若命中 bot，报 `BOT_REQUIRES_AT_BOT`。
- `--at-bot <bot>`：机器人；接受姓名、`cli_*`、`ou_*`、数字 id。默认精确匹配，不做模糊。
- 可选便捷行为：`--at` 在“没有任何人类精确匹配、且只有一个 bot 精确匹配”时自动转 bot，并在结果里显示 `kind=bot`；跨 kind 多候选仍报歧义。若不想引入行为变化，第一版可不做自动识别。
- 两者都按解析后的 `{ kind, userId }` 去重；同 id 不同 kind -> `MENTION_KIND_CONFLICT`。
- mention 上限建议 20 个，防止误构造超长 at 列表。

输出：

```text
已发送 om_xxx
群：7701373657003592719
回复：7706917979643989285
提及：@张三（user:42）、@小助手（bot:7701370664338361634，cli_a1b2c3d4）
```

### 5.2 HTTP API

兼容旧字段，新增 `atBots`：

```json
{
  "chat": "发布群",
  "text": "@张三 @小助手 请确认",
  "at": ["张三"],
  "atBots": ["小助手"],
  "replyTo": "om_parent",
  "inThread": true
}
```

同时接受对象形式，便于程序化调用和未来扩展：

```json
{
  "at": [
    "张三",
    { "target": "小助手", "kind": "bot" },
    { "target": "cli_a1b2c3d4", "kind": "bot" }
  ]
}
```

校验：

- `at` 元素是字符串或 `{ target: string, kind?: "user" | "bot" | "auto" }`。
- `atBots` 必须是字符串数组。
- 字符串 `at` 保持“人类”语义；`at` 对象和 `atBots` 才允许 bot。这样旧调用方不会因为群里出现同名 bot 而改变行为。
- `target` 去空白后不能为空；`kind` 非法 -> 400。

响应：

```json
{
  "ok": true,
  "messageId": "om_xxx",
  "chatId": "7701373657003592719",
  "rootId": "7706917979643989285",
  "mentions": [
    { "kind": "user", "userId": "42", "name": "<人类显示名>" },
    {
      "kind": "bot",
      "userId": "7701370664338361634",
      "name": "小助手",
      "appId": "cli_a1b2c3d4",
      "openId": "ou_xxx"
    }
  ]
}
```

注意：`userId` 从 number 改成 string 是对 JSON 消费方的破坏性变化。推荐直接改，因为 number 对 19 位 id 本来就是错的；如果必须兼容，可同时提供 `userIdText`，但不要继续把大 id 放进 number。

---

## 6. 测试计划

### 6.1 单元测试

**proto 编解码**

- 人类 + 机器人混排：两个 AT 元素、`atUserIdList` 包含两个十进制 id。
- 机器人 id 超过 2^53（如 `7701370664338361634`）编码后逐字节精确，不出现 `ID_NOT_SAFE_INTEGER`。
- `atBots` 传入 `cli_*` / `ou_*` 时，编码前必须已解析成数字 id；wire 里不出现 `cli_` / `ou_`。
- 重复 @ 同一 bot：多个 AT 元素，`atUserIdList` 去重。
- `@all`：`AtProperty.userId="all"`，`atUserIdList` 不包含 `all`。
- 解码 `Chatter.type=BOT` + `botConfig` + `botInfo`，`LarkChatterInfo.kind='bot'`、`appId='cli_*'`。
- 解码 `Chatter.type=AI`：明确归类（建议单独 `ai` 或归入 bot 但带 `isAgent`），并锁测试。

**解析器**

- 群成员：人类 `42/张三`，bot `7701/小助手`；`--at 张三` -> 42；`--at-bot 小助手` -> 7701。
- 人类与 bot 同名：`--at` 选人类，`--at-bot` 选 bot。
- 两个同名 bot：`BOT_AMBIGUOUS`，candidates 含 appId/openId/userId。
- bot 不在群、但全局目录存在：`BOT_NOT_IN_CHAT`。
- 全局目录不可用：`BOT_NOT_FOUND`，hint 同时提示“名称/是否在群”。
- `cli_*` -> 数字 id；`ou_*` -> 数字 id；跨应用 open_id -> 明确错误。
- 成员分页：两页合并；超过安全上限 -> `BOT_DIRECTORY_TRUNCATED`。
- 成员枚举不可用：`BOT_DIRECTORY_UNAVAILABLE`，不得静默退回消息扫描。
- `--at` 命中 bot -> `BOT_REQUIRES_AT_BOT`；`--at-bot` 命中人类 -> `BOT_TYPE_MISMATCH`。
- 正文缺少 `@显示名` -> 现有 400 语义。

**CLI**

- `--at` / `--at-bot` 混用、去重、空值、前导 `@`、`--json` 输出。
- 同名歧义时输出可操作提示，而不是只报“找不到”。

### 6.2 fake gateway 矩阵

用现有 `LarkProtocolClientLike` fake（参考 `id-resolution.test.ts:78-137`）扩展：

```ts
interface FakeClient extends LarkProtocolClientLike {
  listChatMembers?(chatId: string): Promise<LarkChatterInfo[]>;
  checkChatters?(chatId: string, ids: string[]): Promise<Map<string, boolean>>;
}
```

| # | 群成员/目录 | 输入 | 期望 |
| ---: | --- | --- | --- |
| 1 | human 42 张三；bot 7701 小助手 | `at:['张三'], atBots:['小助手']` | sendText mentions `[42,7701]`，顺序按正文 |
| 2 | bot 7701/7702 都叫小助手 | `atBots:['小助手']` | `BOT_AMBIGUOUS`，2 个 candidates |
| 3 | 全局有 bot 7703 运维助手；群成员无 | `atBots:['运维助手']` | `BOT_NOT_IN_CHAT` |
| 4 | human 42 小助手；bot 7701 小助手 | `at:['小助手']` / `atBots:['小助手']` | 分别选 42 / 7701 |
| 5 | bot 7701 app_id cli_abc | `atBots:['cli_abc']` | 7701 |
| 6 | bot 7701 open_id ou_bot | `atBots:['ou_bot']` | 7701；跨应用 ou_ 失败有 hint |
| 7 | bot id 7701370664338361634 | `atBots:['7701370664338361634']` | 编码精确，无精度错误 |
| 8 | 成员分页 2 页 | `atBots:['小助手']` | 合并后命中 |
| 9 | fake 无 listChatMembers | `atBots:['小助手']` | `BOT_DIRECTORY_UNAVAILABLE` |
| 10 | human+bot+thread | `at`/`atBots` + `replyTo`/`inThread` | rootId/threadChat 不丢 |
| 11 | 同 id 同时 user/bot | `at:['42'], atBots:['42']` | `MENTION_KIND_CONFLICT` |
| 12 | 正文缺 `@小助手` | `atBots:['小助手']` | 400 `MENTION_TEXT_MISSING` |

E2E 可复用现有 route/service 注入模式：`POST /api/lark-avatar/send` -> fake client 捕获 `sendText`；再用 `protobufjs` 解码 `PutMessageRequest` 验证 wire，而不是只断言 mock 参数。

### 6.3 真实环境前置条件

1. AI 替身账号已扫码登录，且和测试群在同一租户；账号在群内且有发消息权限。
2. 目标机器人是**应用机器人**，不是群自定义 webhook 机器人；已完成发布/上线，且对当前租户可用。
3. 目标机器人已加入同一个群；群成员列表里能看到它。
4. 目标机器人应用：
   - 开启机器人能力；
   - 订阅 `im.message.receive_v1`；
   - 具备 `im:message.group_at_msg` / `im:message.group_at_msg:readonly`（人类发送者）；
   - 如果还要接收其他机器人 @，再加 `im:message.group_at_msg.include_bot:readonly`；
   - 修改权限/事件后重新发布版本。
5. 目标机器人侧开启事件日志或自动回复，能观察 `mentions[]`。

验收步骤：

1. `agent-dock lark avatar send --chat <群> --text "@张三 @小助手 测试" --at 张三 --at-bot 小助手 --json`。
2. 响应里 `mentions` 有 `kind=user` 和 `kind=bot`，bot 的 `userId` 是数字字符串，`appId` 是 `cli_*`。
3. 目标机器人事件日志出现 `im.message.receive_v1`：
   - `event.sender.sender_type = "user"`（AI 替身是人类账号）；
   - `event.message.mentions[]` 包含目标 bot 的 `open_id`；
   - `event.message.chat_id` 是测试群。
4. 目标机器人能按 mention 策略回复/记录；仅“消息发送成功”不算通过。
5. 回归人类 @、话题回复、引用回复。

如果没触发，按顺序排查：

- 机器人是否在群、是否被禁用；
- 是否应用机器人而非 webhook 机器人；
- 事件/权限是否发布；
- 正文是否只是纯文本 `@名字`，没有真正的 AT 元素；
- `open_id` 是否拿错应用作用域；
- 目标 bot 是否配置了忽略 bot 消息 / 只处理提及；
- 是否是流式/编辑消息，只处理了首帧。

### 6.4 风险

- **webhook 机器人不可回调**：只能发 webhook，不能订阅 `im.message.receive_v1`；@ 它不会触发 Agent。
- **open_id 跨应用失效**：`ou_*` 是应用作用域；CLI 若接受别处复制的 open_id，可能解析失败。优先 `cli_*` / 数字 id。
- **同名机器人**：只靠名字会误 @；必须 app_id/数字 id 消歧。
- **成员列表截断**：安全策略可能截断成员；必须显式报错，不能把“没找到”当成“不存在”。
- **大 id 精度**：任何 `Number()` 都会毁掉 19 位 id；全链路字符串是硬要求。
- **回调循环**：多个机器人互相 @ 可能形成循环；目标 bot 侧应有 mention 白名单、轮次/幂等限制。
- **消息编辑/流式**：目标 bot 可能只处理首次事件，后续编辑不再触发。

---

## 7. 开放问题

1. `chats.PullChatChattersRequest` 在真实 Web 会话里是否稳定返回 bot 成员？需要一次只读实测。
2. `chatters.PullChattersByIdsResponse.botInfo` 在 `needBotInfo: true` 时是否一定返回？是否需要改用 `chats.PullChatChattersByIDsRequest`？
3. `bots.PullBotsRequest` 在用户 Web 会话下是否可用、是否只返回通讯录内机器人？如果不可用，`app_id -> 不在群` 的错误只能降级为“群成员中未找到”。
4. `AtProperty.content` 对 bot 是否必须带前导 `@`？先用现有人类路径，真实回调失败再做 A/B。
5. `Chatter.type = AI(3)` 是否也应纳入 `--at-bot`？建议先只支持 BOT(2)，AI 单独评估。
6. `nextCursor` / `nextOffset` 的实际分页语义和默认 limit；需要真实响应确认。
7. `chatId` / `rootId` 也有大整数问题；本次是否一并改成字符串，还是只改 mention，另开事项处理。
8. 外部租户/外部机器人是否可 @、是否受群外部成员策略限制。

---

## 8. 证据索引

### 本地代码

- `apps/server/src/lark-avatar/protocol/lark.proto:50-55`：`needBotInfo`
- `apps/server/src/lark-avatar/protocol/lark.proto:76`：`FromType USER/BOT`
- `apps/server/src/lark-avatar/protocol/lark.proto:109-116`：本地 Chatter 缺 type
- `apps/server/src/lark-avatar/protocol/lark.proto:152`：`AtProperty`
- `apps/server/src/lark-avatar/protocol/lark.proto:206`：`PutMessageRequest.atUserIdList`
- `apps/server/src/lark-avatar/protocol/proto.ts:86-91`：`LarkChatterInfo`
- `apps/server/src/lark-avatar/protocol/proto.ts:205-215`：chatter 请求/解码
- `apps/server/src/lark-avatar/protocol/proto.ts:319-346`：mention id 规范化
- `apps/server/src/lark-avatar/protocol/proto.ts:426-454`：AT 编码与 atUserIdList
- `apps/server/src/lark-avatar/id-resolution.ts:81-84`：ResolvedLarkMention 用 number
- `apps/server/src/lark-avatar/id-resolution.ts:456-490`：resolveMention
- `apps/server/src/lark-avatar/id-resolution.ts:705-749`：消息参与者目录
- `apps/server/src/lark-avatar/id-resolution.ts:771-785`：toNumericId 拒绝大整数
- `apps/server/src/lark-avatar/service.ts:403-449`：sendMessage
- `apps/server/src/lark-avatar/cli.ts:4-55`：CLI 请求体
- `apps/server/src/cli-program.ts:247-264`：`--at`
- `apps/server/src/lark-avatar/routes.ts:51-90`：send API
- `apps/server/src/lark/service.ts:43-52, 660-699`：OpenAPI 成员类型 users/bots
- `apps/server/src/lark/listener.ts:1527, 1545`：`sender_type` app/bot 判定

### 公开协议/实现

- LarkAgentX `lark_all_pb2.py`（commit `d288ef4`）：`entities.Chatter.type/botConfig`、`botInfo`、`BotInfo`、`AppStatusInfo`
  <https://github.com/cv-cat/LarkAgentX>
- LarkAgentX `larkx/client.py:310-322`：`Chatter.type` 1/2/3
- LarkAgentX `larkx/proto/compose.py:158-163, 324-325`：AtProperty + atUserIdList
- LarkX `src/larkx/client.py:315-325`：web 群成员 + bot 无 email
- LarkX `src/larkx/proto/builders.py:347-348`：`atUserIdList` 只收数字 id
- feishu-lite `kb/notes/2026-09-29-protocol-spike.md:39-53`：机器人 `type == 2`、AtProperty 形状

### 官方/第三方文档

- 飞书接收消息事件（权限与 sender_type）：
  <https://open.feishu.cn/document/server-docs/im-v1/message/events/receive>
- 飞书用户身份介绍（open_id / user_id / union_id）：
  <https://open.feishu.cn/document/home/user-identity-introduction/introduction>
- 飞书获取机器人信息：
  <https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info>
- A2A 实践（open_id 应用作用域、群成员 bot_id 可触发、webhook/权限排查，第三方实测）：
  <https://www.tianlejin.top/blog/hermes-feishu-a2a-best-practices>

---

## 9. 实施顺序建议（不在本次改动范围）

1. ~~先修 mention id 字符串化（P0），补大 id 回归测试。~~ **已完成（2026-11-16）：扩展到 chat/root/user 全链路，并补 19 位 wire 回归。**
2. 补 `Chatter.type` / `botInfo` schema 与 decoder，单测覆盖 BOT/AI。
3. 加 `listChatMembers` + `checkChatters` 到 `LarkProtocolClientLike`，用 fake 跑通群成员目录。
4. 解析器加 `kind` 与 `--at-bot` 错误码。
5. CLI/API 加 `atBots`，保持 `at` 人类兼容。
6. fake gateway 全套矩阵通过后，再做真实群人工验收（应用机器人 + 事件日志）。
7. 最后评估 `chatId/rootId` 的大整数治理，避免和本次 bot 改动绑死。

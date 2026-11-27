# AgentDock 纯 XML 交互输出插件体系开发指南

> 零 MCP、零 Tool、全 Agent CLI（Claude / Codex / Antigravity / Trae 等）通用。

## 1. 核心理念

传统的交互扩展依赖 MCP Server 或特定 CLI 的 Tool Schema，在不同 Agent CLI 之间迁移成本高且占用上下文窗口。

AgentDock 采用**纯 XML 交互输出插件体系（Output Widget Plugins）**：

1. **按需提示词注入**：仅当某会话启用该插件时，才在首轮向发给 Agent 的文本前注入极简 XML 协议规范；关闭插件不注入任何文本，**零 Token 消耗**（活跃会话中途关闭时会下发一条一次性短提醒）。
2. **代码围栏免疫解析**：Agent 在回复**最末尾**输出约定标签 `<agentdock-*>` 时，共享解析引擎自动跳过 Markdown 围栏代码块（```` ``` ```` / `~~~`）与行内代码（`` `...` ``），避免技术讨论误触发；流式生成未闭合期间自动展示轻盈占位条，彻底隐藏裸 XML 源码。
3. **Web + 飞书双端原生卡片**：同一套 XML 输出，在 Web 端渲染交互式 React 卡片，在飞书端自动构建 Schema 2.0 交互卡片并路由 `card.action.trigger` 回调。
4. **跨端幂等回传与锁定**：用户在 Web 或飞书任一端完成操作后，服务端幂等落库并派发结构化续跑轮次驱动 Agent 继续执行，同时双端卡片原地锁定为只读回显态，防止重复提交。

---

## 2. 架构分层与核心模块

| 层级 | 目录 / 文件 | 职责 |
| --- | --- | --- |
| 共享契约与解析 | `packages/shared/src/output-plugins/` | 统一插件契约 `OutputPluginDefinition`、围栏免疫 XML 基础库 `xml-utils.ts`、声明式插件工厂 `declarative.ts`、注册中心 `OutputPluginRegistry`、内置插件 #1 `builtin:ask-user-question` 与内置插件 #2 `builtin:confirm-action`、全局/会话开关归一化与解析 |
| 持久化与运行时 | `packages/storage/src/`<br>`packages/agent-runtime/src/` | `sessions.output_plugins`（JSON）与历史列 `ask_user_question_enabled` 双向同步及旧库自动迁移；`runtime.setOutputPlugins()` 纯元数据极速切换与 SSE 广播（绝不冷启 CLI） |
| 服务端与本地加载 | `apps/server/src/output-plugins/` | `OutputPluginService`、本地声明式目录扫描器 `local-loader.ts`（默认 `~/.agentdock/output-plugins/*.json`）、按需提示词拼装、跨端幂等 `submitInteraction`、HTTP API 路由 |
| 飞书适配层 | `apps/server/src/lark/output-plugins/` | `LarkOutputPluginAdapterRegistry`、`builtin:ask-user-question` 适配器、`builtin:confirm-action` 适配器、声明式通用 Schema 2.0 卡片构造器与 `card.action.trigger` 回调路由、Web↔飞书双向锁定同步 |
| Web 前端层 | `apps/web/src/output-plugins/`<br>`apps/web/src/Composer.tsx` | `WebOutputPluginRendererRegistry`、`ConfirmActionCard` 与通用声明式卡片渲染器、设置页「交互插件中心」、输入框底栏「🧩 交互插件」快捷 Popover、时间线与 Cmd+F 搜索统一路由 |

---

## 2.5 内置插件一览

| 插件 ID（短别名） | XML 标签 | 默认开启 | 能力与回显 |
| --- | --- | --- | --- |
| `builtin:ask-user-question`（`ask-user-question`） | `<agentdock-ask-user-question>` | `true` | 单选 / 多选 / 多题 / 推荐项 / 自定义「其他」输入；专属 Q&A 成对回显轮次；飞书 Schema 2.0 快捷按钮 + 表单回调 |
| `builtin:confirm-action`（`confirm-action`） | `<agentdock-confirm-action>` | `true` | 高风险 / 关键操作前的「确认执行 / 取消 / 补充意见」确认卡（支持 `risk="low\|medium\|high"`、`<summary>`、`<detail>`、`<command>`）；专属确认/取消回显轮次；飞书风险配色头栏 + 一键确认/取消按钮与补充意见表单 |

### 内置插件 #2（`<agentdock-confirm-action>`）输出示例

```xml
<agentdock-confirm-action id="deploy_prod_1" title="确认发布到生产环境" risk="high" confirm-label="确认执行" cancel-label="取消">
  <summary>即将部署 v0.3.28 到生产集群并执行数据库迁移。</summary>
  <detail label="目标集群">prod-cn-east</detail>
  <detail label="预计影响">API 节点滚动重启约 15 秒</detail>
  <command>pnpm deploy --env prod</command>
</agentdock-confirm-action>
```

---

## 3. 开关优先级与向后兼容

每个插件的生效状态按以下优先级解析（高 → 低）：

1. **会话级显式覆写**：`session.outputPlugins[pluginId]`（`true` / `false`；`null` 或缺失表示跟随全局）
2. **历史会话兼容列**（仅 `builtin:ask-user-question`）：`session.askUserQuestionEnabled`
3. **全局默认配置**：`configs['output_plugins.config'].plugins[pluginId]`（自动兼容迁移历史 `configs['ask_user_question.config']`）
4. **插件默认声明**：`plugin.defaultEnabled`（内置插件 `builtin:ask-user-question` 与 `builtin:confirm-action` 为 `true`，新扩展推荐默认 `false`）

> 历史短名 `ask-user-question` 与 `confirm-action` 在读写、路由与存储层均自动归一化为规范 ID `builtin:ask-user-question` / `builtin:confirm-action`。

---

## 4. 快速编写本地 / 社区声明式插件（零代码，JSON 即插即用）

无需修改 AgentDock 源码，只需在本地目录放置 `.json` 清单文件即可同时获得 **Web 交互卡片 + 飞书 Schema 2.0 卡片 + 跨端幂等回传**：

- **默认目录**：`~/.agentdock/output-plugins/`
- **环境变量覆写**：`AGENTDOCK_OUTPUT_PLUGINS_DIR=/your/custom/plugins`
- **零重启热加载**：放入或修改 JSON 后，在 Web 设置 →「交互插件中心」点击 **重新扫描**（或调用 `POST /api/output-plugins/reload`）即可立即生效。

### 清单 Schema 约束

- `id`：唯一插件 ID，仅允许小写字母、数字及 `: . _ -`，推荐使用命名空间前缀如 `local:deploy-approval`、`community:diff-review`。
- `tagName`：**必须以 `agentdock-` 开头**（正则 `^agentdock-[a-z][a-z0-9-]{1,62}$`），彻底避免与标准 HTML 标签冲突；且不可与已有插件重复。
- `kind`：支持三种开箱即用卡片形态：
  - `action-card`：审批 / 危险操作确认 / 多按钮操作卡（支持可选备注输入框）
  - `form-card`：多字段结构化收集表（支持 `text` / `textarea` / `select` 与 `required` 校验）
  - `info-card`：只读结构化结果 / 产物摘要 / 外链展示卡（自动过滤非 `http(s)://` / `/` 危险链接）
- `icon`：内置支持的语义图标键包括 `message-circle-question`、`shield-check`、`check-square`、`clipboard-list`、`file-text`、`sparkles`、`bell`、`terminal`、`git-diff`、`download`、`bar-chart`、`puzzle`。
- `promptInstruction` / `protocolExample` / `disabledNotice`：均可选；留空时系统根据 `tagName` 与 `kind` 自动生成简洁协议指令。
- `responseTemplate`：可选；自定义将用户交互格式化回传给 Agent 的自然语言模板，可用占位符：
  `{{pluginId}}`、`{{pluginName}}`、`{{instanceId}}`、`{{title}}`、`{{source}}`、`{{actedBy}}`、`{{actionValue}}`、`{{actionLabel}}`、`{{fieldsSummary}}`、`{{note}}`。

### 示例 A：生产发布审批卡（`action-card`）

保存为 `~/.agentdock/output-plugins/deploy-approval.json`：

```json
{
  "id": "local:deploy-approval",
  "name": "发布审批卡",
  "description": "执行生产发布或不可逆操作前，让负责人在 Web 或飞书一键确认或驳回。",
  "icon": "shield-check",
  "tagName": "agentdock-deploy-approval",
  "version": "1.0.0",
  "defaultEnabled": false,
  "kind": "action-card",
  "card": {
    "accentTone": "amber",
    "headerTitle": "生产发布确认",
    "allowNote": true,
    "notePlaceholder": "可选：补充发布窗口或限制说明…",
    "actions": [
      { "value": "approve", "label": "确认发布", "style": "primary" },
      { "value": "cancel", "label": "取消发布", "style": "danger" }
    ]
  }
}
```

启用后，Agent 在回复末尾输出如下 XML 即可自动渲染双端交互卡片：

```xml
<agentdock-deploy-approval id="rel_0328" title="发布 v0.3.28 到生产">
  <summary>包含 2 项数据库迁移与 Web 静态资源更新，预计耗时 2 分钟。</summary>
  <field label="目标集群">prod-cn-east</field>
  <field label="变更 Commit">a6f8f69..HEAD</field>
</agentdock-deploy-approval>
```

### 示例 B：多字段参数收集卡（`form-card`）

保存为 `~/.agentdock/output-plugins/env-form.json`：

```json
{
  "id": "local:env-form",
  "name": "部署参数收集表",
  "description": "当需要用户一次补充多个结构化配置参数时渲染交互表单。",
  "icon": "clipboard-list",
  "tagName": "agentdock-env-form",
  "version": "1.0.0",
  "defaultEnabled": false,
  "kind": "form-card",
  "card": {
    "accentTone": "sky",
    "submitLabel": "提交参数"
  }
}
```

Agent 回复末尾 XML：

```xml
<agentdock-env-form id="env_1" title="填写发布参数">
  <summary>请补充以下必要配置项</summary>
  <field name="region" label="目标区域" type="select" required="true" options="cn-hangzhou:杭州,us-west:美西"/>
  <field name="branch" label="构建分支" type="text" placeholder="main" required="true"/>
  <field name="notes" label="发布说明" type="textarea" placeholder="可选"/>
</agentdock-env-form>
```

### 示例 C：构建产物摘要卡（`info-card`，只读）

保存为 `~/.agentdock/output-plugins/build-summary.json`：

```json
{
  "id": "local:build-summary",
  "name": "构建产物摘要",
  "description": "以结构化卡片呈现测试结果、产物信息与文档链接。",
  "icon": "file-text",
  "tagName": "agentdock-build-summary",
  "version": "1.0.0",
  "defaultEnabled": false,
  "kind": "info-card",
  "card": {
    "accentTone": "emerald"
  }
}
```

---

## 5. 编写深度定制的内置 / 代码插件（TypeScript）

当需要超越声明式卡片的专属交互体验（例如 Diff 选行批注、Mermaid 交互画布、音频/图表控件）时，按统一契约注册即可：

1. **共享定义（`packages/shared/src/output-plugins/`）**：
   - 实现 `OutputPluginDefinition<TSpec, TInteraction>`，复用 `extractTrailingXmlBlock` 与 `detectPendingStreamingXmlTag` 自动获得代码围栏免疫与流式占位能力；
   - 加入 `BUILTIN_OUTPUT_PLUGINS`（或在 `OutputPluginRegistry` 中调用 `registry.register(myPlugin)`）。
2. **Web 专属渲染器（`apps/web/src/output-plugins/registry.tsx`）**：
   - 实现 `WebOutputPluginRenderer<TSpec, TInteraction>`（`renderCard`、`renderStreamingPlaceholder`、`renderInteractionTurn`），注册到 `defaultWebOutputPluginRendererRegistry`。
3. **飞书 Schema 2.0 适配器（`apps/server/src/lark/output-plugins/registry.ts`）**：
   - 实现 `LarkOutputPluginAdapter<TSpec, TInteraction>`（`handlesAction`、`buildCard`、`buildAnsweredCard`、`parseAction`），注册到 `defaultLarkOutputPluginAdapterRegistry`。
4. **验证清单**：
   - 共享解析单测（围栏代码块、行内代码、流式截断、非法 XML 容错）
   - 服务端按需注入（开启注入、次轮不重复、关闭发一次性短提醒、跨端幂等）
   - 飞书 Schema 2.0 卡片与回调解析单测
   - Web 亮/暗模式桌面端与 390×844 移动端零溢出验收

---

## 6. HTTP API 速查

| 接口 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/output-plugins` | Master / Session Token | 获取完整插件目录（元数据、全局默认状态、协议示例、本地目录与告警） |
| `PUT /api/output-plugins/config` | Master Token | 更新全局默认开关 `{ plugins: Record<pluginId, boolean> }`（自动同步旧 `ask_user_question.config`） |
| `POST /api/output-plugins/reload` | Master Token | 重新扫描本地声明式插件目录并返回最新目录 |
| `PATCH /api/sessions/:id/config` | Master / 本会话 Token | 极速更新会话级插件覆写 `{ outputPlugins: Record<pluginId, boolean \| null> }`（不冷启 CLI，立即 SSE 广播） |
| `POST /api/sessions/:id/output-plugins/:pluginId/interact` | Master / 本会话 Token | 统一幂等提交交互响应（已响应返回 `409` 及既有记录，首次返回 `202` 并派发续跑轮次） |
| `GET/PUT /api/ask-user-question/config` & `POST /api/sessions/:id/ask-user-question/answer` | 兼容路由 | 与统一插件接口共享同一份底层状态与幂等记录 |

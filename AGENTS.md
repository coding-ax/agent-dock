# AgentDock Agent 指南

## 核心约束

### 验证改动（必须执行）

你多半运行在 AgentDock 自己托管的会话里。在当前轮次里重启、停止、升级正式 daemon，或 `npm install -g` 覆盖它，会把你自己一起杀掉。

- **禁止**在会话里执行 `agent-dock restart` / `stop` / `update`、`npm install -g @agent-dock/cli…`，或 kill 正式 daemon。CLI 会拦截前三者。
- 每次修改代码后：先跑相关单测和 `pnpm typecheck`；涉及 API、CLI、调度、daemon 或前端时，`pnpm build` 后用 `node apps/server/dist/cli.js dev up` 起隔离沙箱做端到端验证，完成后 `dev down`。
- 详细流程（沙箱命令、headless 截图、交付话术）见 `.claude/skills/agent-dock-self-dev/SKILL.md`。
- 正式实例的升级交给用户在自己的终端执行；只有用户在本轮明确要求时，才可设 `AGENTDOCK_ALLOW_SELF_RESTART=1` 自己执行。

### 发包（仅在用户要求发版时）

日常改动不发包。用户要求发版时：

```bash
pnpm build
cd apps/server
# beta：<主>.<次>.<patch>-beta.<YYYYMMDD>.<序号>
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const b=j.version.replace(/-beta\..+$/, '').replace(/\d+$/, n=>String(Number(n)+1));const d=new Date();const pad=x=>String(x).padStart(2,'0');const ts=''+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate());j.version=b+'-beta.'+ts+'.1';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
npm publish --tag beta      # 正式版用纯版本号 + --tag latest
```

- 测试版 tag：`beta`；正式版 tag：`latest`
- 包名：`@agent-dock/cli`；版本文件：`apps/server/package.json`
- `prepack` 会自动构建 web 和 server；只改了 packages（shared、acp-client 等）时，需先 `pnpm build:packages`
- beta 版本号带 beta 后缀和发行日期，例如 `0.2.4-beta.20260911.1`。脚本每次先递增 patch，序号固定 `.1`；重发同版本号时把序号递增到 `.2`。纯 `0.2.5` 这类无后缀版本属于 `latest` 语义。
- 注意 semver 排序：`0.4.54-beta.*` 高于 `0.4.53`。beta 的 patch 超过 latest 后，`@latest` 用户会被提示「有新版本」，此时应发一个更高的正式版。
- 发版后的安装同样由用户在自己的终端执行（见上一节）。

### ACPX 持久化键名

- ACPX session_options 的键必须用 `snake_case`
- 环境变量名不能直接用 `UPPER_SNAKE_CASE` 写入 `acpx.session_options.env`
- 运行时变量用 `agentdock_group_tools_url`、`agentdock_group_tools_token`

### 移动端布局

- viewport：`width=device-width,initial-scale=1.0,viewport-fit=cover,interactive-widget=resizes-content`
- `html, body, #root { height: 100% }`，`body { overflow: hidden }`
- 根容器：`h-[100dvh] overflow-hidden`
- 内部滚动区域自己处理 `overflow-y-auto`
- markdown table：`display: block; overflow-x: auto`

### 模型列表

- 模型列表通过 ACP 动态发现，不是写死的
- Codex 的模型来自 provider 的 `/models` 接口（Codex 格式，非 OpenAI 格式）
- 反代模型如果不在 `/models` 返回中，可通过 `extraModels` 配置项手动补充

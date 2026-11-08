# AgentDock Agent 指南

## 核心约束

### 验证改动（必须执行）

你多半运行在 AgentDock 自己托管的会话里。在当前轮次里重启、停止、升级正式 daemon，或 `npm install -g` 覆盖它，会把你自己一起杀掉。

- **禁止**在会话里执行 `agent-dock restart` / `stop` / `update`、`npm install -g @agent-dock/cli…`，或 kill 正式 daemon。CLI 会拦截前三者。
- 每次修改代码后：先跑相关单测和 `pnpm typecheck`；涉及 API、CLI、调度、daemon 或前端时，`pnpm build` 后用 `node apps/server/dist/cli.js dev up` 起隔离沙箱做端到端验证，完成后 `dev down`。
- 详细流程（沙箱命令、可见浏览器验收、交付话术）见 `.claude/skills/agent-dock-self-dev/SKILL.md`。
- 正式实例的升级交给用户在自己的终端执行；只有用户在本轮明确要求时，才可设 `AGENTDOCK_ALLOW_SELF_RESTART=1` 自己执行。

### 浏览器与自动化进程（必须执行）

- 默认浏览器是 **ego-browser**（ego lite）。网页打开、检查、测试、点击、输入、截图和登录操作一律先用 ego-browser；开始前运行 `ego-browser skill`，按输出的当前版本指南操作。
- 一个用户目标只创建一个 TaskSpace，记下并复用 `spaceId`；不要用新 TaskSpace 绕过卡住或超时的页面。
- 需要复用当前标签页、登录态或 Cookie 时，同样默认 ego-browser，不要改写为脚本方案。
- 如果 ego-browser 不可用（命令不存在，或 `ego-browser skill` 执行失败），停止并说明缺项；不得回退到 Playwright MCP、Codex Chrome 插件、内嵌 Browser 或任何无头浏览器。
- 只有用户明确要求“编写自动化测试”“修改测试脚本”或“为 CI 增加浏览器测试”时，才可以编写或运行浏览器自动化代码。普通页面操作和页面验收不属于例外。
- 允许的自动化必须保证未捕获异常、超时和收到 `SIGINT`/`SIGTERM` 时也能清理：Node 使用 `try/finally` 并注册信号处理；外部 Chrome 记录进程组，并用 shell `trap ... EXIT INT TERM` 终止整个进程组后再删除临时 profile。
- 不得只依赖裸 `timeout node ...`、`browser.close()` 或 `chrome.kill()` 做清理；结束前必须确认没有本次任务遗留的 `--headless`、`--remote-debugging-port` 或临时 profile 进程。
- 只终止本任务启动的进程，不得误杀用户正在使用的正常 Chrome；ego-browser 不可用时停止并说明缺项，不得降级为脚本。

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

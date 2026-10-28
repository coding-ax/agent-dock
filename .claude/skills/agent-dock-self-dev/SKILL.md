---
name: agent-dock-self-dev
description: 在 AgentDock 托管的会话里修改 agent-dock 自身源码并验证。适用于改 apps/server、apps/web、packages/* 后需要跑起来看效果、端到端验证、截图检查界面；不要用 restart/update 正在服务你的 daemon。
---

# 在 AgentDock 里迭代 AgentDock

你很可能正运行在 AgentDock daemon 的子进程里（环境变量里有 `agentdock_session_id`）。
重启、停止或升级这个 daemon，会把你自己一起杀掉：本轮结果丢失，任务被标成 interrupted。

## 禁止

- 在当前轮次里执行 `agent-dock restart` / `stop` / `update`、`agent-dock daemon restart|stop`，或 `kill` 正式 daemon 进程。
  CLI 会拦截前三者；不要用 `AGENTDOCK_ALLOW_SELF_RESTART=1` 绕过，除非用户在本轮明确要求。
- `npm install -g @agent-dock/cli…`：安装会替换正在运行的文件，同样不要做。
- 往正式实例（默认 4310）里写测试数据：建测试会话、注册测试定时任务。

## 验证分三层，按需往上走

1. **单测与类型检查**（每次都做）
   ```bash
   npx vitest run <相关测试文件>    # 改完先跑相关的
   npx vitest run && pnpm typecheck   # 交付前跑全量
   ```
2. **沙箱端到端**（改了 API、CLI、调度、daemon 行为、前端页面时做）
   ```bash
   pnpm build                                  # 只改 packages/* 时也要先 build
   node apps/server/dist/cli.js dev up         # 用本仓库的构建产物起沙箱，打印地址（默认 4399）
   node apps/server/dist/cli.js dev run -- schedule list --all   # 在沙箱里跑任意 agent-dock 子命令
   node apps/server/dist/cli.js dev env        # JSON：url / database / work 目录，给脚本用
   node apps/server/dist/cli.js dev down       # 停止并删除沙箱数据（--keep-data 保留数据库）
   ```
   - 用 `node apps/server/dist/cli.js`，不要用全局 `agent-dock`：全局装的是正式版本，不认识新加的命令。
   - 改完代码重新 `pnpm build` 后再执行一次 `dev up`，它会把沙箱重启到最新构建。
   - 沙箱有独立的 HOME、数据库、端口，飞书监听关闭，Web 免鉴权；Claude 的登录态照常可用，可以真正跑 Agent。
   - 沙箱里调 HTTP 直接 `curl http://127.0.0.1:4399/api/...`，不需要凭证。
3. **界面验证**（改了前端时做）
   在沙箱地址上用本机 Chrome 的 headless 模式加 DevTools 协议操作页面并截图：
   `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=<端口> --user-data-dir=<临时目录>`。
   用仓库里的 `apps/server/node_modules/ws` 连 `http://127.0.0.1:<端口>/json` 给出的 page websocket，
   通过 `Runtime.evaluate` 点击和填值，`Page.captureScreenshot` 截图后用 Read 查看。用完删除临时 profile。

## 交付给用户

- 说明验证到了哪一层，哪些没验证（例如「界面只在沙箱里截图看过，没在正式实例上点」）。
- 需要把改动装到正式实例时，**不要自己装**。把下面的命令交给用户，让用户在自己的终端里执行：
  ```bash
  cd <仓库> && pnpm build && cd apps/server && npm pack --pack-destination /tmp \
    && npm install -g /tmp/agent-dock-cli-<版本>.tgz && agent-dock restart
  ```
- 结束前确认已经 `dev down`，或者明确告诉用户沙箱还开着。

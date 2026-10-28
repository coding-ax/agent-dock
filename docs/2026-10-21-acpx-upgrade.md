# ACPX 0.20.0 升级验证

AgentDock 从 ACPX 0.15.1 升级至 0.20.0。跨度 5 个次版本，`runtime` 导出签名没有破坏性变化（`createAcpRuntime` / `createRuntimeStore` / `createAgentRegistry` 用法不变），因此本次是一次纯对齐上游的升级，不夹带 AgentDock 侧的行为改动。

选择现在升级的直接原因：0.17.1 让配置的初始化超时真正生效，0.18.0 要求「必须有最终 ACP 响应才算完成」。这两条正好命中我们此前排查过的「Agent 连续 600 秒无任何活动，已取消本轮任务」——旧版本里 acpx 可以在没有最终响应的情况下把回合当成结束，留下一个 AgentDock 看不见的悬挂请求。

## 上游变化

- [0.17.1](https://github.com/openclaw/acpx/releases/tag/v0.17.1) 配置的初始化超时被真正执行：agent 初始化无响应时会按超时失败，并清理遗留进程与「迟到的启动」。新增可选的 `antigravity` 内置 agent。
- [0.18.0](https://github.com/openclaw/acpx/releases/tag/v0.18.0) 超时必须等到最终的 ACP 响应才结束；取消、重连、owner 交接过程中保留最终输出、用量与已接受的设置。`createSharedAcpRuntime()` 增加 `setMode()` / `setModel()` / `setConfigOption()` / `getCapabilities()`。
- 0.19.x 以会话恢复与进程/锁回收为主：区分适配器复用 session ID 时的本地记录、`fs` / `terminal` 能力开关、队列 owner 的进程身份校验、Windows 相关清理等。
- [0.20.0](https://github.com/openclaw/acpx/releases/tag/v0.20.0) 新增 Octomind 内置 agent；权限回调可以选择具体的 `optionId`；会话启动失败或丢弃关闭失败时正确把记录标记为 closed。

`AcpRuntime.getStatus()` 现在暴露 `lastRequestId`，`AcpRuntime` 上出现可选的 `watchSession()`（在 `createSharedAcpRuntime()` 返回的 runtime 上是必需能力）。两者都还没有被 AgentDock 用起来：`watchSession()` 需要改用共享 runtime 并放弃现有的本地 `AcpSessionStore`，属于独立改造，不在本次范围。

## 保留的行为与补丁

Codex 继续默认使用 PATH 中的本机 CLI，不固定 CLI 版本，不回退到适配器依赖的副本。群聊变量继续沿用现有小写名称。

旧补丁 `patches/acpx@0.15.1.patch` 的三段内容里，只有一段被上游吸收：

- 上游已吸收：`client.start()` 的超时。0.15.1 时我们手工把 `ensureSession` 里的 `client.start()` 包了一层 `withTimeout`，0.17.1 之后上游自己用 `startRuntimeClient(client, agent, options.timeoutMs)` 做了同样的事，这一段从补丁中删除。
- 上游未吸收：紧随其后的 `session/new` / `session/load` 仍然没有超时。`AcpRuntimeManager.createOwnedRuntimeSession()` 里 `createOrLoadRuntimeSession(...)` 是裸调用，agent 初始化成功、随后卡在会话创建时会一直挂着，调用方只能看到 `ensureSession` 永不返回。这一段继续由补丁补上（包装成 `withTimeout(createOrLoadRuntimeSession(client, input.resumeSessionId, cwd), this.options.timeoutMs)`）。

改这一点时是被测试抓出来的：`terminates a real ACP child that stalls after initialization in session/new` 在升级后开始 10 秒超时，用独立脚本复现后确认 `ensureSession` 在 `timeoutMs: 1000` 下超过 8 秒仍未返回，补上包装后 1.17 秒按 `TimeoutError` 失败。

因此 `patches/acpx@0.20.0.patch` 保留三处：会话创建/加载的超时约束、Codex launcher 的 4 秒 stdin 退出宽限期（上游仍是 100ms 默认值），以及加载已有会话时重放所选模式（`desiredModeId: params.desiredModeId`）。旧补丁文件已删除。

`apps/server/src/agent-models.test.ts` 里对应的断言同步更新：断言新补丁包含这三处行为，并新增一条守护——直接读取已安装 acpx 的 `dist/runtime.js`，确认上游仍在用 `this.options.timeoutMs` 约束 `client.start()`。上游哪天回退这条，我们要立刻发现，否则 agent 完全起不来时会重新退化成「挂到 agent.timeout 才失败」。

## 打包与依赖

`dist/cli.js` 把打补丁的 `acpx` 内联进产物（这样全局安装的用户也能拿到本地补丁，`pnpm patch` 只在开发工作区生效），但 `acpx` 自己的依赖仍按原样保持 external，运行时从宿主 `node_modules` 解析。

acpx 0.17 起新增依赖 `@openclaw/fs-safe`（含按平台分发的原生可选依赖）。内联后这段代码的 `import '@openclaw/fs-safe/advanced'` 等语句需要一个宿主可见的包，因此把它加到 `apps/server` 的依赖里并锁定 `0.26.9`（与 acpx 声明的 `^0.26.7` 兼容）。不加这一条，构建产物启动时会直接报 `ERR_MODULE_NOT_FOUND: Cannot find package '@openclaw/fs-safe'`。

同一条路径上还有一个既有的版本偏斜，本次不处理，记录在案：内联的 acpx 代码运行在宿主解析到的 `zod` 与 `@agentclientprotocol/sdk` 上，而 acpx 0.20.0 声明的是 `zod ^4.6.5` 与 SDK `^1.5.0`，工作区分别固定为 `zod 3.25.67` 和 SDK `1.4.0`。zod 偏斜从 0.15.1 起就存在（它当时就要求 `zod 4.5.4`），SDK 偏斜是本次新出现的。沙箱端到端覆盖的路径（初始化、会话创建、回合、权限、重连恢复）在 SDK 1.4.0 下行为正常，但彻底解决需要让内联代码解析到 acpx 自己声明的依赖副本，属于构建层改造，单独做。

## 验证

- 全量测试 1101 项（102 个文件）与 `pnpm typecheck` 通过；`pnpm build` 通过，`apps/server/dist/cli.js` 可启动。
- 隔离沙箱（`node apps/server/dist/cli.js dev up`，端口 4399）跑真实 Agent：
  - Claude 会话创建、首轮问答、同会话第二轮（复用持久化会话）、`restart` 后重连恢复并再次回复，均正常。
  - Codex 会话在补齐本机 `~/.codex/config.toml` 后的沙箱 HOME 中创建、问答、`restart` 后恢复并再次回复，均正常；Codex 全信任模式的重放生效（否则发送会被拒绝）。
- 升级前的行为回归保持通过：环境变量大小写原样传递、群聊凭证注入、系统 Prompt、模型选择、权限模式与超时（`packages/acp-client` 的边界测试全部通过）。

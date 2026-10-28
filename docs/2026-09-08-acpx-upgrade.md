# ACPX 0.15.1 升级验证

AgentDock 从 ACPX 0.13.0 升级至 0.15.1，同时将发布包的 ACP SDK 从 1.3.0 更新到 1.4.0。新版 runtime 使用 SDK 的 `client` / `methods` API，必须同步更新发布依赖，避免源码测试正常但打包后缺少导出。

## 上游变化

- [0.14.0](https://github.com/openclaw/acpx/releases/tag/v0.14.0) 允许 `acpx.session_options.env` 保存及恢复大写、混合大小写环境变量名。其他结构字段的 snake_case 校验继续有效；这不是取消全部持久化键名约束。
- [0.15.0](https://github.com/openclaw/acpx/releases/tag/v0.15.0) 新增 `agentProcessEnv`，支持不持久化的子进程环境快照。本次不迁移现有群聊凭证注入方式。
- [0.15.1](https://github.com/openclaw/acpx/releases/tag/v0.15.1) 默认将单条入站 ACP 消息限制为 64 MiB，可通过 `ACPX_MAX_ACP_MESSAGE_BYTES` 调整，`0` 关闭上限。
- npm 包最低 Node.js 版本为 22.13，已同步工作区 engines、发布包 engines 和安装说明。

## 保留的行为与补丁

Codex 继续默认使用 PATH 中的本机 CLI，不固定 CLI 版本，不回退到适配器依赖的副本。群聊变量继续沿用现有小写名称，避免无必要的数据迁移。

上游仍未为初次 `client.start()` / `session/new` 提供本项目所需的超时，也仍使用默认 100ms 的 stdin 退出宽限期。因此将原补丁迁移到 `patches/acpx@0.15.1.patch`，保留初始化超时和 Codex launcher 的 4 秒退出宽限期；原 0.13.0 补丁已删除。

## 验证

- 全量 403 项测试、类型检查、构建通过，打包产物 CLI 可以启动。
- 使用真实 AcpxAdapter 与持久化 session key，验证大写、混合大小写、小写环境变量名及大小写混合的值原样传入 Agent；停止后新建适配器、仅从持久化配置恢复，再次验证变量未变。
- 原有群聊凭证、系统 Prompt、模型、权限与超时回归保持通过。
- 本机 Codex 0.153.4 完成真实初始化、思考深度调整、只读工具调用、停止及恢复后第二次回复。
- 官方 npm 空缓存安装 ACPX 0.15.1 及 runtime 导入通过。

# AgentDock CLI

AgentDock 是一个本地 Agent 工作台：一条命令拉起 Web 控制台、SQLite 持久化、ACP Agent 运行时和飞书通道。

```bash
npm i -g @agent-dock/cli@latest

cd /path/to/your/project
agent-dock start      # 后台启动
agent-dock status     # 查看 PID、地址、日志路径
```

启动后打开 <http://127.0.0.1:4310>。

## 桌面客户端

macOS（Apple Silicon / Intel）和 Windows 可以直接下载安装包，无需预装 Node：

- [GitHub Releases](https://github.com/coding-ax/agent-dock/releases)

Linux 不需要桌面壳，安装上面的 npm 包后使用 Web 控制台即可。

## 链接

- [源码与文档](https://github.com/coding-ax/agent-dock)
- [问题反馈](https://github.com/coding-ax/agent-dock/issues)

AgentDock 没有 API Key、多用户账号或租户隔离；对外暴露前请通过反向代理补上 HTTPS、身份认证和访问限制。

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/agentdock-logo-dark.svg">
  <img src="docs/assets/readme/agentdock-logo-light.svg" alt="AgentDock" width="520">
</picture>

English · [简体中文](README_zh.md)

[![npm](https://img.shields.io/npm/v/@agent-dock/cli?color=f2b872&label=%40agent-dock%2Fcli)](https://www.npmjs.com/package/@agent-dock/cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-93bf78)](https://nodejs.org)
[![ACP](https://img.shields.io/badge/protocol-ACP-c97a3a)](https://agentclientprotocol.com)
[![license](https://img.shields.io/badge/license-MIT-5a3e2b)](LICENSE)

**Mention it in Lark, type in the web console, or call the HTTP API. Claude Code and Codex get to work in your local workspace, and you watch every step live.**

[Get started](#get-started) · [Features](#features) · [How it works](#how-it-works) · [Full guide (Chinese)](README_zh.md#完整使用手册)

</div>

<br>

<div align="center">

https://github.com/user-attachments/assets/16a78cd2-5a0b-43ec-b403-ab0a1309200b

</div>

## Features

- 🐾 **Adopt a kitten as your main session.** Say what you need; it splits the work into sticky notes, hands each one to a side session, follows up, reviews the results, and only pings you when it needs you.
- ⏳ **Kittens grow old, then hand over.** As the main session piles up context and compactions, the kitten ages from kitten to elder. When it gets tired it asks you to start a handoff: a new kitten is born and inherits the unfinished notes, so long-running work never chokes on a bloated context.
- 🔌 **Agent discovery.** Claude Code, Codex, Cursor, Gemini, opencode, Trae, Pi and other ACP agents are discovered automatically. Only CLIs actually installed on your machine show up.
- 💬 **Mention it in Lark.** DM the bot or @ it in a group; progress and results stream into a single card. Several agents can find each other and hand off work in the same group.
- 🖥️ **One web console for everything.** Streaming Markdown, tool calls, permission requests and terminal output are stored in SQLite. Queue, interrupt or retry with one click, and scan a QR code to continue from your phone.
- 🔁 **Service CLI with recursive self-improvement (RSI).** A full daemon lifecycle (`start` / `stop` / `restart` / `update` / `autostart`) that agents drive too. `agent-dock dev up` gives them an isolated sandbox to improve AgentDock itself and verify end to end, without ever restarting the daemon they run in. HTTP + SSE API included.
- 🛡️ **Guardrails in the UI.** Block risky commands, allowlist members and protect the console without touching config files.

## Get started

Requires Node.js 22.13+.

```bash
npm i -g @agent-dock/cli@latest

cd /path/to/your/project
agent-dock start      # runs in the background; open http://127.0.0.1:4310
```

Everyday commands:

```bash
agent-dock status     # PID, address and log path
agent-dock restart
agent-dock stop
agent-dock update     # update and restart the background service
agent-dock            # no subcommand: run in the foreground
```

Rather not install Node? Grab the [desktop app](https://github.com/coding-ax/agent-dock/releases) for macOS or Windows.

<details>
<summary><b>Run from source</b></summary>

```bash
pnpm install
cp .env.example .env
pnpm dev              # Fastify + Vite on http://127.0.0.1:4311
pnpm test && pnpm typecheck
pnpm build
```

</details>

<details>
<summary><b>Connect a Lark (Feishu) bot</b></summary>

Open **Lark settings → Create bot by QR code** in the bottom-left corner, scan with Lark to authorize, then pick a workspace and an agent. After that, DM the bot or @ it in a group. Permissions, group collaboration and risky-command gates are covered in the [full guide](README_zh.md#飞书接入) (Chinese).

</details>

## How it works

```text
Lark / Web / HTTP  ──▶  AgentDock runtime  ──▶  acpx  ──▶  Claude Code · Codex · Gemini · …
                          │
                          └── SQLite: sessions, events, tool calls, permissions, all replayable
```

AgentDock embeds no vendor SDK. A pinned `acpx` runtime handles the ACP handshake, persistent sessions, reconnects, streaming, permission requests and process cleanup; AgentDock owns product state, normalized events, storage, the API and channels. If your agent speaks ACP, it plugs in.

> [!WARNING]
> AgentDock listens on `0.0.0.0` by default, so it is reachable on your LAN. The console has a single owner credential and no multi-user or tenant isolation. Use `--local-only` to keep it on this machine, and put HTTPS and real authentication in front before exposing it anywhere else.

## Docs

The full guide is written in Chinese: [Full guide](README_zh.md#完整使用手册) · [HTTP API](README_zh.md#服务化接入) · [Lark](README_zh.md#飞书接入) · [Custom agents](README_zh.md#agent-发现与自定义-agent) · [CLI cheatsheet](README_zh.md#命令行速查) · [Desktop app](apps/desktop/README.md) · [Contributing](AGENTS.md)

## License

[MIT](LICENSE)

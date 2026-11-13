<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme/banner-en-dark.svg">
  <img src="docs/assets/readme/banner-en-light.svg" alt="AgentDock: dock your coding agents on your own machine" width="100%">
</picture>

English · [简体中文](README_zh.md)

[![npm](https://img.shields.io/npm/v/@agent-dock/cli?color=f2b872&label=%40agent-dock%2Fcli)](https://www.npmjs.com/package/@agent-dock/cli)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-93bf78)](https://nodejs.org)
[![ACP](https://img.shields.io/badge/protocol-ACP-c97a3a)](https://agentclientprotocol.com)
[![license](https://img.shields.io/badge/license-MIT-5a3e2b)](LICENSE)

**Mention it in Lark, type in the web console, or call the HTTP API. Claude Code and Codex get to work in your local workspace, and you watch every step live.**

[Get started](#get-started) · [Features](#features) · [Tour](#tour) · [How it works](#how-it-works) · [Full guide (Chinese)](docs/guide.zh-CN.md)

</div>

<br>

<a href="docs/assets/readme/agentdock-intro-en.mp4"><img src="docs/assets/readme/video-cover-en.webp" alt="AgentDock 60-second video tour" width="100%"></a>

<p align="center"><sub>Click the cover for a 60-second video tour. The video, GIFs and screenshots were all recorded from a real AgentDock run; the agent output is unedited.</sub></p>

## Features

- 🐾 **Adopt a kitten as your main session.** Say what you need; it splits the work into sticky notes, hands each one to a side session, follows up, reviews the results, and only pings you when it needs you.
- 🔌 **Use the agents you already have.** Claude Code, Codex, Cursor, Gemini, opencode, Trae, Pi and other ACP agents are discovered automatically. Only CLIs actually installed on your machine show up.
- 💬 **Mention it in Lark.** DM the bot or @ it in a group; progress and results stream into a single card. Several agents can find each other and hand off work in the same group.
- 🖥️ **One web console for everything.** Streaming Markdown, tool calls, permission requests and terminal output are stored in SQLite. Queue, interrupt or retry with one click, and scan a QR code to continue from your phone.
- 🧩 **Built to be embedded.** A complete HTTP + SSE API with resumable streams makes it an execution layer for your own multi-agent platform.
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

Open **Lark settings → Create bot by QR code** in the bottom-left corner, scan with Lark to authorize, then pick a workspace and an agent. After that, DM the bot or @ it in a group. Permissions, group collaboration and risky-command gates are covered in the [full guide](docs/guide.zh-CN.md#飞书接入) (Chinese).

</details>

## Tour

<table>
<tr>
<td width="50%"><b>Ask in one line</b><br><sub>Claude Code fixes <code>remaining()</code> and adds 5 unit tests in 25 seconds</sub><br><br><img src="docs/assets/readme/demo-fix.gif" alt="Claude Code fixes a bug and adds tests"></td>
<td width="50%"><b>Kitten main session</b><br><sub>Adopt "Dango"; it dispatches two sticky notes and reviews each result</sub><br><br><img src="docs/assets/readme/demo-kitten.gif" alt="The kitten main session dispatches and reviews work"></td>
</tr>
<tr>
<td><b>Sticky-note drawer</b><br><sub>Needs review, running and done at a glance</sub><br><br><img src="docs/assets/readme/shot-kitten-notes.webp" alt="Sticky-note drawer"></td>
<td><b>Dark mode</b><br><sub>Streaming Markdown, code highlighting, tool-call traces</sub><br><br><img src="docs/assets/readme/shot-session-dark.webp" alt="A session in dark mode"></td>
</tr>
</table>

<p align="center"><img src="docs/assets/readme/shot-mobile.webp" alt="Mobile view" width="260"><br><sub>Scan the QR code and keep going from your phone</sub></p>

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

The full guide is written in Chinese: [Full guide](docs/guide.zh-CN.md) · [HTTP API](docs/guide.zh-CN.md#服务化接入) · [Lark](docs/guide.zh-CN.md#飞书接入) · [Custom agents](docs/guide.zh-CN.md#agent-发现与自定义-agent) · [CLI cheatsheet](docs/guide.zh-CN.md#命令行速查) · [Desktop app](apps/desktop/README.md) · [Contributing](AGENTS.md)

## License

[MIT](LICENSE)

# 主会话与督办：验收清单

> 状态：已实现 · 2026-11-11
> 规格与功能说明：[`2026-11-09-agentdock-main-session-design.md`](2026-11-09-agentdock-main-session-design.md)
> 本文件只列「怎么验」，不重复设计。

## 0. 验证前置

```bash
pnpm typecheck
pnpm test -- apps/server/src/assistant/service.test.ts
pnpm build
node apps/server/dist/cli.js dev up     # 隔离沙箱，默认 http://127.0.0.1:4399
```

- 沙箱里所有命令都加 `node apps/server/dist/cli.js dev run -- <命令>`。
- 网页验收用 ego-browser；一个目标只用一个 TaskSpace。
- 结束后 `node apps/server/dist/cli.js dev down`。
- **不要**在会话里 `agent-dock restart|stop|update`、`npm install -g` 或 kill 正式 daemon。

## 1. 主会话

- [ ] 网页「设置 → 主会话与督办」可以新建主会话；侧栏顶部出现「主会话」，普通列表不重复。
- [ ] `main get` 返回同一 `sessionId`；`main clear` 后顶部入口消失。
- [ ] 主会话有 `review` / `needs_user` 事项或待确认草稿时，侧栏角标数量正确。
- [ ] 网页发的消息进入主会话，`session show` 能看到。

## 2. 状态快照

- [ ] 首轮 `sentPrompt` 含 `<agentdock-context>` 和「现在：」。
- [ ] 无变化的第二轮不含 `<agentdock-context>`。
- [ ] 新建事项后的下一轮只出现「事项：」小节。

## 3. 派活与状态

- [ ] `task start --title ... --done-when ...` 创建侧边会话，事项 `running`。
- [ ] 侧边会话完成后事项变 `review`，主会话收到督办。
- [ ] `task plan` 不创建侧边会话；`task start <id>` 后才创建。
- [ ] `task cancel` 关闭事项并停止侧边会话。
- [ ] `thinking` / `running_tool` 不产生注入；一轮多次工具调用只产生一条 `review`。

## 4. 验收与返工

- [ ] `task review --verdict accepted --check '<标准>=met:<证据>'` 关闭事项，review 记录含逐条证据。
- [ ] `--verdict rework` 后侧边会话继续运行，返工轮次 +1。
- [ ] 连续 3 次返工自动转 `needs_user`。
- [ ] 侧边会话 `task report --kind blocked` 后主会话收到 `needs_you`。

## 5. watch

- [ ] `watch add --command 'test -f /tmp/agentdock-watch-ok' --every 5s` 后创建文件，30 秒内收到督办，watch 变 `fired`。
- [ ] `watch run` 条件不满足时 `failCount` +1；满足时 `fireCount` +1。
- [ ] `--timeout 2s` 的 `sleep 60` 被杀死，无残留进程。
- [ ] 连续 3 次失败只报一次；`pause` / `resume` / `remove` 生效。

## 6. 草稿

- [ ] `draft create` 后目标仓库无新评论，状态 `pending`。
- [ ] `draft send` 只发一条评论；重复 send 不重复发。
- [ ] `draft discard` 后不能发送。

## 7. 通知与静默时段

- [ ] 默认 `quietHours.enabled=false`，`notify` 立即发送。
- [ ] 开启静默时段并覆盖当前时间后，普通 `notify` 返回 `delayed: true`，`--urgent` 立即发送。
- [ ] 网页设置的开关和起止时间保存后，`GET /api/assistant/settings` 返回相同值。
- [ ] 关闭静默时段后，待发送通知在下一轮扫描补发。

## 8. 权限

- [ ] 侧边会话调用 `task start` / `watch add` / `notify` 返回 403。
- [ ] 侧边会话调用 `task report` / `draft create` 成功。
- [ ] 普通终端（不带 `from`）可以执行主会话命令；带错误 `from` 被拒绝。

## 9. 单测覆盖

`apps/server/src/assistant/service.test.ts`：

- [ ] 首轮全量快照、之后只给变化。
- [ ] 侧边会话完成 → 一条注入督办，事项 `review`。
- [ ] 两次返工后第 3 次转 `needs_user`；验收通过关闭。
- [ ] watch 条件满足只触发一次。
- [ ] 静默时段默认关闭；开启后普通通知延迟，紧急通知绕过。

## 10. 交付时回报

改动文件、跑过的命令与结果、上述清单逐条结论、未验证项、是否已 `dev down`。
无法在沙箱观察的条目写「未验证」，不要用「应该没问题」代替。

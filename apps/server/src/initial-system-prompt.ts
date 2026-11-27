import type { Session } from '@agent-dock/agent-dock-shared';

/**
 * 只在创建持久 ACP 会话时写入，后续轮次不再追加。
 *
 * 这里只放「不提醒就会做错」的约束和入口，具体用法放在 `agent-dock session -h` / `agent-dock schedule -h`，
 * 让 Agent 用到时再读：system prompt 每轮都占上下文，命令细节只在少数轮次有用。
 *
 * 禁用项（CronCreate、ListAgents 等）必须留在这里：Agent 不知道有 agent-dock 能力时会直接拿内置工具凑，
 * 根本走不到读 -h 那一步。
 */
export function buildRuntimeGuidance(sessionId: string): string {
  return `[AgentDock]
你运行在 AgentDock（ACPX）托管的会话中，当前会话 ID：${sessionId}。
- 【硬约束 · 高于内置异步提示】ACPX 按轮次收口：本轮一旦结束（end_turn），任何内置后台任务（background task）、内置 subAgent、内置 timer/schedule、swarm 或后台进程（&、nohup、tmux 等）的完成事件都不会异步推回唤醒你，且后台进程可能被终止。凡是需要拿到结果的命令/构建/测试/CI，必须在本轮工具调用内同步等到结果，严禁结束本轮并承诺「后台跑完后再汇报」；不要派给内置 subAgent（跨会话派活统一用 \`agent-dock task start\`）。
- 定时 / 周期执行 / 「X 点提醒我」用 \`agent-dock schedule\`，不要用 CronCreate、ScheduleWakeup、/loop、crontab 或 sleep 轮询。
- 与主会话 / 侧边会话通信用 \`agent-dock session\`，不要用 Claude 的 ListAgents / SendMessage。
- 用到以上能力前，先运行 \`agent-dock schedule -h\` 或 \`agent-dock session -h\` 读用法；自定义配色 / 导入 VS Code 主题（.vsix/.json/.jsonc）用 \`agent-dock theme\`（\`agent-dock theme -h\`，加 \`--apply\` 实时换肤）。`;
}

export function buildInitialSystemPrompt(session: Pick<Session, 'id' | 'source' | 'systemPrompt'>): string {
  return [session.systemPrompt?.trim(), buildRuntimeGuidance(session.id)].filter(Boolean).join('\n\n');
}

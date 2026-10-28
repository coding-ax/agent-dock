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
你运行在 AgentDock 托管的会话中，当前会话 ID：${sessionId}。
- 本轮结束、被中断或超时后，子代理和后台进程（&、nohup、tmux 等）可能被一并终止：长任务在工具调用内同步等到结果，不要派给 subAgent，也不要「先启动、稍后再看」。
- 定时 / 周期执行 / 「X 点提醒我」用 \`agent-dock schedule\`，不要用 CronCreate、ScheduleWakeup、/loop、crontab 或 sleep 轮询。
- 与主会话 / 侧边会话通信用 \`agent-dock session\`，不要用 Claude 的 ListAgents / SendMessage。
- 用到以上能力前，先运行 \`agent-dock schedule -h\` 或 \`agent-dock session -h\` 读用法。`;
}

export function buildInitialSystemPrompt(session: Pick<Session, 'id' | 'source' | 'systemPrompt'>): string {
  return [session.systemPrompt?.trim(), buildRuntimeGuidance(session.id)].filter(Boolean).join('\n\n');
}

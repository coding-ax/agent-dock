import { AlarmClock, MessageSquare, StickyNote } from 'lucide-react';
import type { Agent, Session } from './api';
import { AgentIcon } from './AgentIcon';
import { isScheduledSession } from './schedule-view';
import { sideChatParentId } from './side-chat-link';

/**
 * 决定侧边栏会话行是否展示行首 Agent 图标：
 * - 时间视图：平铺展示所有会话，每条都带 Agent 图标，一眼区分 Claude / Codex / Antigravity 等；
 * - 项目视图：工作区下已有「Agent 分组头」展示同一图标和名称，常规子项不再重复堆叠；
 *   但挂靠在父会话下的跨 Agent 侧边会话仍保留自身 Agent 图标，做到既不冗余也不缺失。
 */
export function shouldShowSessionRowAgentIcon(mode: 'time' | 'project', sessionAgentId: string, groupAgentId?: string): boolean {
  if (mode === 'time') return true;
  return Boolean(groupAgentId && sessionAgentId !== groupAgentId);
}

/**
 * 侧边栏会话行的行首图标组合：Agent 图标 + 特殊会话类型标记（定时任务 / 小猫便签 / 侧边会话）。
 * 均带 shrink-0，不挤压标题截断区与右侧时间/状态位，也不挂原生 title 避免与整行 HoverTooltip 冲突。
 */
export function SessionRowLeadingIcons({
  session,
  agent,
  noteOf,
  showAgentIcon = true,
}: {
  session: Pick<Session, 'agentId' | 'source' | 'sourceId' | 'systemPrompt'>;
  agent?: Pick<Agent, 'id' | 'name'>;
  noteOf?: string;
  showAgentIcon?: boolean;
}) {
  const scheduled = isScheduledSession(session);
  const sideChat = Boolean(sideChatParentId(session));
  const kindIcon = scheduled
    ? <AlarmClock size={12} aria-label="定时任务会话" className="shrink-0 text-zinc-400"/>
    : noteOf ? <StickyNote size={12} aria-label={`${noteOf}派出的便签`} className="shrink-0 text-amber-600/80"/>
    : sideChat ? <MessageSquare size={12} aria-label="侧边会话" className="shrink-0 text-zinc-400"/>
    : null;

  if (!showAgentIcon && !kindIcon) return null;
  if (showAgentIcon && kindIcon) {
    return <span className="flex shrink-0 items-center gap-1">
      <AgentIcon agentId={session.agentId} agentName={agent?.name} size={14} className="text-zinc-500"/>
      {kindIcon}
    </span>;
  }
  if (showAgentIcon) {
    return <AgentIcon agentId={session.agentId} agentName={agent?.name} size={14} className="text-zinc-500"/>;
  }
  return kindIcon;
}

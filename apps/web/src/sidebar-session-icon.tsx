import { AlarmClock, Clock, MessageSquare, StickyNote } from 'lucide-react';
import type { Agent, Session } from './api';
import { AgentIcon } from './AgentIcon';
import { isScheduledSession } from './schedule-view';
import { sideChatParentId } from './side-chat-link';
import { useBi } from './i18n';

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

type SessionRowKind = 'scheduled' | 'note' | 'side-chat';

function resolveSessionRowKind(
  session: Pick<Session, 'source' | 'sourceId' | 'systemPrompt'>,
  noteOf?: string,
): SessionRowKind | null {
  if (isScheduledSession(session)) return 'scheduled';
  if (noteOf) return 'note';
  if (sideChatParentId(session)) return 'side-chat';
  return null;
}

/**
 * 侧边栏会话行的行首图标槽位：
 * - 展示 Agent 图标时，统一占固定 20×20（w-5 h-5）单槽位，保证全列表标题严格左对齐；
 *   主体为 14px AgentIcon，特殊会话类型（定时任务 / 小猫便签 / 侧边会话）收敛为右下角
 *   11×11 带 1.5px 镂空切边的精简微角标（加粗描边保证 1x/2x 屏清晰，底色随常态/hover/选中态同步）。
 * - 项目视图中隐藏 Agent 图标的同组特殊会话，则居中展示标准 13px 类型图标。
 * - 不挂原生 title，避免与整行 HoverTooltip 冲突。
 */
export function SessionRowLeadingIcons({
  session,
  agent,
  noteOf,
  showAgentIcon = true,
  active = false,
}: {
  session: Pick<Session, 'agentId' | 'source' | 'sourceId' | 'systemPrompt'>;
  agent?: Pick<Agent, 'id' | 'name'>;
  noteOf?: string;
  showAgentIcon?: boolean;
  active?: boolean;
}) {
  const L = useBi();
  const kind = resolveSessionRowKind(session, noteOf);
  if (!showAgentIcon && !kind) return null;

  // 不带透明度的 text-amber-600 可在暗色模式下命中 index.css 的 .text-amber-600 提亮规则。
  if (!showAgentIcon && kind) {
    const standaloneIcon = kind === 'scheduled'
      ? <AlarmClock size={13} aria-label={L("定时任务会话", "Scheduled Session")} className="shrink-0 text-zinc-400"/>
      : kind === 'note'
        ? <StickyNote size={13} aria-label={L(`${noteOf}派出的便签`, `Task dispatched by ${noteOf}`)} className="shrink-0 text-amber-600"/>
        : <MessageSquare size={13} aria-label={L("侧边会话", "Side Session")} className="shrink-0 text-zinc-400"/>;
    return <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
      {standaloneIcon}
    </span>;
  }

  if (!kind) {
    return <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
      <AgentIcon agentId={session.agentId} agentName={agent?.name} size={14} className="text-zinc-500"/>
    </span>;
  }

  const badgeMeta = kind === 'scheduled'
    ? {
        shape: 'rounded-full',
        tone: 'text-zinc-500',
        icon: <Clock size={9} strokeWidth={2.4} aria-label={L("定时任务会话", "Scheduled Session")} className="shrink-0"/>,
      }
    : kind === 'note'
      ? {
          shape: 'rounded-[3px]',
          tone: 'text-amber-600',
          icon: <StickyNote size={9} strokeWidth={2.4} aria-label={L(`${noteOf}派出的便签`, `Task dispatched by ${noteOf}`)} className="shrink-0"/>,
        }
      : {
          shape: 'rounded-[3px]',
          tone: 'text-zinc-500',
          icon: <MessageSquare size={9} strokeWidth={2.4} aria-label={L("侧边会话", "Side Session")} className="shrink-0"/>,
        };

  return <span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
    <AgentIcon agentId={session.agentId} agentName={agent?.name} size={14} className="-translate-x-[1px] -translate-y-[1px] text-zinc-500"/>
    <span
      data-active={active ? 'true' : undefined}
      data-session-badge={kind}
      className={`ui-session-badge-cutout pointer-events-none absolute -bottom-[1px] -right-[1px] grid h-[11px] w-[11px] place-items-center transition-[background-color,box-shadow] duration-150 ${badgeMeta.shape} ${badgeMeta.tone}`}
    >
      {badgeMeta.icon}
    </span>
  </span>;
}

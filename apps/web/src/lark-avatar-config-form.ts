import type { Locale } from '@agent-dock/agent-dock-shared';
import type { LarkAvatarReactionRoute, LarkAvatarReplyForwardMode } from './api';
import { bi, getCurrentLocale } from './i18n';
import { withSavedOption } from './lark-config-form';

export const DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE: LarkAvatarReplyForwardMode = 'final_only';
export const DEFAULT_LARK_AVATAR_REACTION_TRIGGER_EMOJI = 'OK';

export function getLarkAvatarReactionRouteOptions(
  locale: Locale = getCurrentLocale()
): Array<{ value: LarkAvatarReactionRoute; label: string }> {
  return [
    { value: 'main', label: bi('主会话', 'Main session', locale) },
    { value: 'independent', label: bi('独立轮次', 'Independent', locale) },
    { value: 'ask', label: bi('先询问', 'Ask first', locale) }
  ];
}

export const LARK_AVATAR_REACTION_ROUTE_OPTIONS: Array<{ value: LarkAvatarReactionRoute; label: string }> =
  getLarkAvatarReactionRouteOptions('zh-CN');

export function normalizeLarkAvatarReactionRoute(value: unknown): LarkAvatarReactionRoute {
  return value === 'ask' || value === 'independent' || value === 'main' ? value : 'main';
}

export interface LarkAvatarReplyForwardOption {
  value: LarkAvatarReplyForwardMode;
  label: string;
  cardSummary: string;
  description: string;
  shortHint: string;
  badge?: string;
}

export function getLarkAvatarReplyForwardOptions(
  locale: Locale = getCurrentLocale()
): LarkAvatarReplyForwardOption[] {
  return [
    {
      value: 'all',
      label: bi('回复所有 AgentText', 'Forward all AgentText', locale),
      cardSummary: bi('过程文本与最终结果逐条发回', 'Send every progress & final text', locale),
      description: bi(
        '将 Agent 输出的每一段过程文本与最终结果逐条发回飞书，适合需要实时跟进执行进展的场景。',
        'Forwards every intermediate AgentText chunk and the final answer back to Lark—ideal when you want live progress updates.',
        locale
      ),
      shortHint: bi(
        '所有 AgentText 会直接以你的身份发回原会话',
        'all AgentText will be sent back to the chat as you',
        locale
      )
    },
    {
      value: 'final_only',
      label: bi('仅回复最终回复', 'Final reply only', locale),
      cardSummary: bi('屏蔽过程刷屏，只发最终答复', 'Skip chatter, send final reply only', locale),
      description: bi(
        '屏蔽中间过程 AgentText，仅在整轮 Agent 完成后把最终答复发回飞书（默认推荐；无最终文本或主动停止时不发空消息）。',
        'Suppresses intermediate AgentText and sends only the final reply to Lark once the turn finishes (recommended default; sends nothing if empty or stopped).',
        locale
      ),
      shortHint: bi(
        '仅在整轮完成后把最终回复发回原会话',
        'only the final reply will be sent back once the turn finishes',
        locale
      ),
      badge: bi('默认', 'Default', locale)
    },
    {
      value: 'none',
      label: bi('不在飞书回复', 'Do not reply in Lark', locale),
      cardSummary: bi('仅在本地执行留存，不发飞书', 'Run locally only, no Lark messages', locale),
      description: bi(
        'Agent 照常在 AgentDock 会话中运行并留存完整结果，不向飞书发送任何文本或回复消息。',
        'The Agent runs normally and saves full results in AgentDock without sending any text or reply messages to Lark.',
        locale
      ),
      shortHint: bi(
        '仅在 AgentDock 会话内运行并留存结果，不向飞书回复',
        'runs and stores results in AgentDock only, without replying in Lark',
        locale
      ),
      badge: bi('仅本地', 'Local only', locale)
    }
  ];
}

export const LARK_AVATAR_REPLY_FORWARD_OPTIONS: readonly LarkAvatarReplyForwardOption[] =
  getLarkAvatarReplyForwardOptions('zh-CN');

export function getLarkAvatarReplyForwardSummary(locale: Locale = getCurrentLocale()): string {
  return bi(
    '仅回复最终回复（默认）：安静不刷屏；回复所有 AgentText：逐条转发过程与结果；不在飞书回复：仅在 AgentDock 内留存、不发飞书。',
    'Final reply only (default): quiet, no chatter; Forward all AgentText: forward progress and final messages; Do not reply in Lark: keep results in AgentDock only.',
    locale
  );
}

export const LARK_AVATAR_REPLY_FORWARD_SUMMARY = getLarkAvatarReplyForwardSummary('zh-CN');

export function normalizeLarkAvatarReplyForwardMode(value: unknown): LarkAvatarReplyForwardMode {
  return value === 'all' || value === 'final_only' || value === 'none'
    ? value
    : DEFAULT_LARK_AVATAR_REPLY_FORWARD_MODE;
}

export function describeLarkAvatarReplyForwardMode(
  mode: LarkAvatarReplyForwardMode,
  locale: Locale = getCurrentLocale()
): LarkAvatarReplyForwardOption {
  const options = getLarkAvatarReplyForwardOptions(locale);
  return options.find(option => option.value === mode) ?? options[0]!;
}

export interface LarkAvatarAgentOption {
  value: string;
  label: string;
  agentId: string;
}

/**
 * 计算 AI 飞书替身配置页的默认回复器（agentId）。
 *
 * 只有当表单当前未选择、远端配置已加载完毕且远端未保存 agentId 时，
 * 才回退到可用 Agent 列表的首项；否则必须保留当前值或已保存的 agentId，
 * 避免挂载同帧里两个 useEffect 竞态把已保存的 trae 覆写成列表首位（如 codex）。
 */
export function resolveFallbackAgentId(input: {
  currentAgentId: string;
  savedAgentId?: string | null;
  configPending: boolean;
  agents?: Array<{ id: string }>;
}): string {
  const current = input.currentAgentId.trim();
  if (current) return current;
  if (input.configPending) return '';
  const saved = input.savedAgentId?.trim() ?? '';
  if (saved) return saved;
  return input.agents?.[0]?.id ?? '';
}

/**
 * 构造回复器下拉选项；若已保存的 agentId（如 trae）尚未出现在当前可用列表中，
 * 仍保留为「已保存」项展示，避免下拉框显示空白或丢失原值。
 */
export function buildLarkAvatarAgentOptions(
  agents: Array<{ id: string; name: string }> | undefined,
  selectedAgentId: string,
  locale: Locale = getCurrentLocale()
): LarkAvatarAgentOption[] {
  return withSavedOption(agents ?? [], selectedAgentId.trim(), locale).map(agent => ({
    value: agent.id,
    label: agent.name,
    agentId: agent.id
  }));
}

/** 提交保存配置时的 agentId：优先表单值，其次已保存配置，不以空字符串覆写。 */
export function resolveSaveAgentId(draftAgentId: string, savedAgentId?: string | null): string {
  return draftAgentId.trim() || savedAgentId?.trim() || '';
}

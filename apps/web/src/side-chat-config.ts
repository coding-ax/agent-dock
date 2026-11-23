import type { Agent, Session, SideChatConfig } from './api';
import { sideChatParentId, sideChatSource } from './side-chat-link';
import { buildSideSessionSeed } from './side-session';
import type { PaneTab } from './store';

export const DEFAULT_SIDE_CHAT_TRIGGER_PREFIX = '/btw';

export const DEFAULT_SIDE_CHAT_CONFIG: SideChatConfig = {
  targetMode: 'follow_current',
  openMode: 'side_pane',
  btwEnabled: true,
  triggerPrefix: DEFAULT_SIDE_CHAT_TRIGGER_PREFIX,
  btwSessionReuse: 'new_session'
};

export const BTW_COMMAND = {
  name: 'btw',
  description: '按侧边对话配置发起侧边对话（支持 /btw <问题>）'
} as const;

export function sideChatBuiltinCommand(triggerPrefix = DEFAULT_SIDE_CHAT_TRIGGER_PREFIX): { name: string; description: string } | undefined {
  const prefix = triggerPrefix.trim() || DEFAULT_SIDE_CHAT_TRIGGER_PREFIX;
  if (!prefix.startsWith('/')) return undefined;
  const name = prefix.slice(1).trim();
  if (!name || /\s/.test(name)) return undefined;
  return {
    name,
    description: `按侧边对话配置发起侧边对话（支持 ${prefix} <问题>）`
  };
}

export type ParsedBtwCommand =
  | { matched: false }
  | { matched: true; prompt: string };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 解析输入是否命中侧边对话触发前缀（与飞书机器人共用同一套匹配规则）。
 *
 * - 大小写不敏感（`/btw`、`/BTW`、`btw:`、`BTW:` 均可）
 * - 以字母/数字/下划线结尾的前缀要求后接空白或行尾，避免误伤 `/btw2`
 * - 以符号/标点/中文结尾的前缀（如 `btw:`）允许直接紧跟正文或留空格
 */
export function matchSideChatTrigger(
  input: string,
  triggerPrefix = DEFAULT_SIDE_CHAT_TRIGGER_PREFIX
): ParsedBtwCommand {
  const prefix = triggerPrefix.trim() || DEFAULT_SIDE_CHAT_TRIGGER_PREFIX;
  const trimmed = input.trim();
  if (!trimmed) return { matched: false };
  const needsBoundary = /[A-Za-z0-9_]$/.test(prefix);
  const pattern = needsBoundary
    ? new RegExp(`^${escapeRegExp(prefix)}(?:\\s+([\\s\\S]*))?$`, 'i')
    : new RegExp(`^${escapeRegExp(prefix)}\\s*([\\s\\S]*)$`, 'i');
  const match = pattern.exec(trimmed);
  if (!match) return { matched: false };
  return { matched: true, prompt: (match[1] ?? '').trim() };
}

export function parseBtwCommand(input: string): ParsedBtwCommand {
  return matchSideChatTrigger(input, DEFAULT_SIDE_CHAT_TRIGGER_PREFIX);
}

export interface ResolvedSideChatStartOptions {
  agentId: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  systemPrompt: string;
  source: string;
  sourceId: string;
}

/**
 * 结合用户配置的侧边对话策略与当前主会话，生成 `api.create(...)` 参数。
 *
 * - `follow_current`：复用当前会话的 Agent、工作目录，并继承当前会话的模型与思考深度。
 * - `custom_agent`：使用指定的独立 Agent、模型与思考深度；若指定 Agent 已被移除或停用，
 *   自动安全回退到当前会话的 Agent（且不携带跨 Agent 的 model/reasoningEffort）。
 */
export function resolveSideChatStartOptions(
  source: Pick<Session, 'id' | 'agentId' | 'cwd' | 'model' | 'reasoningEffort'>,
  config: SideChatConfig = DEFAULT_SIDE_CHAT_CONFIG,
  availableAgents: Pick<Agent, 'id' | 'disabled'>[] = []
): ResolvedSideChatStartOptions {
  const base = {
    cwd: source.cwd,
    systemPrompt: buildSideSessionSeed(source.id),
    source: sideChatSource,
    sourceId: source.id
  };

  if (config.targetMode === 'custom_agent' && config.agentId?.trim()) {
    const targetAgentId = config.agentId.trim();
    const agentAvailable = availableAgents.length === 0
      || availableAgents.some(agent => agent.id === targetAgentId && !agent.disabled);
    if (agentAvailable) {
      return {
        ...base,
        agentId: targetAgentId,
        ...(config.model?.trim() ? { model: config.model.trim() } : {}),
        ...(config.reasoningEffort?.trim() ? { reasoningEffort: config.reasoningEffort.trim() } : {})
      };
    }
  }

  return {
    ...base,
    agentId: source.agentId,
    ...(source.model ? { model: source.model } : {}),
    ...(source.reasoningEffort ? { reasoningEffort: source.reasoningEffort } : {})
  };
}

/**
 * 当 `/btw` 配置为「优先复用最近侧边会话」时，查找当前主会话可复用的活跃侧边会话。
 *
 * 优先级：
 * 1. 当前副屏已打开的、属于 `sourceId` 的未归档且可继续对话的侧边会话（优先最近标签）；
 * 2. 否则在全部会话中找属于 `sourceId` 的最近活跃的未归档且未停止/失败的侧边会话。
 */
export function findReusableSideChatSession(
  sourceId: string,
  sessions: Session[],
  openTabs: PaneTab[] = []
): Session | undefined {
  const usable = (session: Session | undefined): session is Session => Boolean(
    session
    && !session.archivedAt
    && session.state !== 'stopped'
    && session.state !== 'failed'
    && sideChatParentId(session) === sourceId
    && session.id !== sourceId
  );

  const byId = new Map(sessions.map(session => [session.id, session]));
  for (let index = openTabs.length - 1; index >= 0; index--) {
    const tab = openTabs[index]!;
    if ((tab.kind === 'side-chat' || tab.kind === 'session') && tab.sessionId) {
      const candidate = byId.get(tab.sessionId);
      if (usable(candidate)) return candidate;
    }
  }

  return sessions
    .filter(usable)
    .sort((left, right) => (right.lastMessageAt ?? right.updatedAt).localeCompare(left.lastMessageAt ?? left.updatedAt))[0];
}

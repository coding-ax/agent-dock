/**
 * 侧边对话（side-chat）配置与路由。
 *
 * 侧边聊天面板、快捷键（⌘⇧S）和 `/btw` 快捷命令共用这一套持久化配置，
 * 避免两套入口各自维护参数导致行为割裂。
 */
import type { FastifyInstance } from 'fastify';
import { RuntimeError, type AgentConfig, type ConfigRepository } from '@agent-dock/agent-dock-shared';
import { z } from 'zod';

export const sideChatConfigKey = 'side_chat.config';

export const sideChatTargetModes = ['follow_current', 'custom_agent'] as const;
export type SideChatTargetMode = (typeof sideChatTargetModes)[number];

export const sideChatOpenModes = ['side_pane', 'switch_session'] as const;
export type SideChatOpenMode = (typeof sideChatOpenModes)[number];

export const btwSessionReuseModes = ['new_session', 'reuse_latest'] as const;
export type BtwSessionReuseMode = (typeof btwSessionReuseModes)[number];

const optionalTrimmedString = z.preprocess(
  value => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
  z.string().max(200).optional()
);

export const defaultSideChatTriggerPrefix = '/btw';

const triggerPrefixSchema = z.preprocess(
  value => {
    if (value === undefined || value === null) return defaultSideChatTriggerPrefix;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed || defaultSideChatTriggerPrefix;
  },
  z.string().min(1).max(32)
);

export const sideChatConfigInputSchema = z.object({
  targetMode: z.enum(sideChatTargetModes).default('follow_current'),
  agentId: optionalTrimmedString,
  model: optionalTrimmedString,
  reasoningEffort: optionalTrimmedString,
  openMode: z.enum(sideChatOpenModes).default('side_pane'),
  btwEnabled: z.boolean().default(true),
  triggerPrefix: triggerPrefixSchema.default(defaultSideChatTriggerPrefix),
  btwSessionReuse: z.enum(btwSessionReuseModes).default('new_session')
});

export interface SideChatConfig {
  targetMode: SideChatTargetMode;
  agentId?: string;
  model?: string;
  reasoningEffort?: string;
  openMode: SideChatOpenMode;
  btwEnabled: boolean;
  triggerPrefix: string;
  btwSessionReuse: BtwSessionReuseMode;
}

export interface SideChatConfigState {
  configured: boolean;
  config: SideChatConfig;
}

export const DEFAULT_SIDE_CHAT_CONFIG: SideChatConfig = {
  targetMode: 'follow_current',
  openMode: 'side_pane',
  btwEnabled: true,
  triggerPrefix: defaultSideChatTriggerPrefix,
  btwSessionReuse: 'new_session'
};

export function normalizeSideChatConfig(input: z.infer<typeof sideChatConfigInputSchema>): SideChatConfig {
  const base: SideChatConfig = {
    targetMode: input.targetMode,
    openMode: input.openMode,
    btwEnabled: input.btwEnabled,
    triggerPrefix: input.triggerPrefix.trim() || defaultSideChatTriggerPrefix,
    btwSessionReuse: input.btwSessionReuse
  };
  if (input.targetMode === 'custom_agent') {
    return {
      ...base,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
    };
  }
  // 跟随当前会话时不保留指定独立 Agent 的覆盖参数，避免切换模式后把旧模型带进不兼容的 Agent。
  return base;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type MatchedSideChatTrigger =
  | { matched: false }
  | { matched: true; prompt: string };

/**
 * 判断输入是否命中侧边对话触发前缀（网页端 Composer 与飞书机器人共用同一套规则）。
 *
 * - 大小写不敏感（`/btw`、`/BTW`、`btw:`、`BTW:` 均支持）
 * - 以字母/数字/下划线结尾的前缀（如 `/btw`、`btw`）要求后接空白或行尾，避免误伤 `/btw2`
 * - 以符号/标点/中文结尾的前缀（如 `btw:`、`btw：`）允许直接紧跟正文或留空格
 */
export function matchSideChatTrigger(
  input: string,
  triggerPrefix = defaultSideChatTriggerPrefix
): MatchedSideChatTrigger {
  const prefix = triggerPrefix.trim() || defaultSideChatTriggerPrefix;
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

/** 侧边会话种子提示词：与前端 buildSideSessionSeed 保持一致，经 systemPrompt 注入、不污染转录。 */
export function buildSideSessionSeed(mainSessionId: string): string {
  return [
    `你是一个侧边会话：由主会话 ${mainSessionId} 派生的独立会话，历史和任务队列不共享。`,
    '用户通常会问主会话在做什么，或要你接着主会话的活继续做。',
    `不要假设自己已经知道主会话的内容——需要时先用 \`agent-dock session show ${mainSessionId}\` 读取转录，再回答；发消息、打断等用法见 \`agent-dock session -h\`。`
  ].join('\n');
}

/** 从 ConfigRepository 读取当前侧边对话配置；未配置或损坏时返回默认配置。 */
export async function readSideChatConfig(config?: ConfigRepository): Promise<SideChatConfig> {
  if (!config) return { ...DEFAULT_SIDE_CHAT_CONFIG };
  const raw = await config.get(sideChatConfigKey);
  if (!raw?.trim()) return { ...DEFAULT_SIDE_CHAT_CONFIG };
  try {
    const parsed = sideChatConfigInputSchema.safeParse(JSON.parse(raw));
    return parsed.success ? normalizeSideChatConfig(parsed.data) : { ...DEFAULT_SIDE_CHAT_CONFIG };
  } catch {
    return { ...DEFAULT_SIDE_CHAT_CONFIG };
  }
}

export interface SideChatConfigServiceOptions {
  config: ConfigRepository;
  listAgents?: () => Promise<AgentConfig[]> | AgentConfig[];
}

export class SideChatConfigService {
  constructor(private readonly options: SideChatConfigServiceOptions) {}

  /** 读配置；库里没有或损坏时安全回退默认配置，不让前端 500。 */
  async state(): Promise<SideChatConfigState> {
    const raw = await this.options.config.get(sideChatConfigKey);
    if (!raw?.trim()) return { configured: false, config: { ...DEFAULT_SIDE_CHAT_CONFIG } };
    try {
      const parsed = sideChatConfigInputSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return { configured: false, config: { ...DEFAULT_SIDE_CHAT_CONFIG } };
      return { configured: true, config: normalizeSideChatConfig(parsed.data) };
    } catch {
      return { configured: false, config: { ...DEFAULT_SIDE_CHAT_CONFIG } };
    }
  }

  async get(): Promise<SideChatConfig> {
    return (await this.state()).config;
  }

  async save(input: unknown): Promise<SideChatConfigState> {
    const parsed = sideChatConfigInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeError(
        'INVALID_SIDE_CHAT_CONFIG',
        `侧边对话配置不合法：${parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'} ${issue.message}`).join('；')}`,
        400
      );
    }
    const normalized = normalizeSideChatConfig(parsed.data);
    if (normalized.targetMode === 'custom_agent') {
      if (!normalized.agentId) {
        throw new RuntimeError('SIDE_CHAT_AGENT_REQUIRED', '选择「指定独立 Agent」时必须选择一个 Agent。', 400);
      }
      if (this.options.listAgents) {
        const agents = await this.options.listAgents();
        const found = agents.find(agent => agent.id === normalized.agentId && !agent.disabled);
        if (!found) {
          throw new RuntimeError('SIDE_CHAT_AGENT_NOT_FOUND', `指定的 Agent 不可用或已停用：${normalized.agentId}`, 400);
        }
      }
    }
    await this.options.config.set(sideChatConfigKey, JSON.stringify(normalized));
    return { configured: true, config: normalized };
  }

  async reset(): Promise<SideChatConfigState> {
    await this.options.config.set(sideChatConfigKey, '');
    return { configured: false, config: { ...DEFAULT_SIDE_CHAT_CONFIG } };
  }
}

export function registerSideChatConfigRoutes(app: FastifyInstance, service: SideChatConfigService): void {
  app.get('/api/side-chat/config', async () => service.state());
  app.put('/api/side-chat/config', async request => service.save(request.body));
  app.delete('/api/side-chat/config', async () => service.reset());
}

import { createHash, randomUUID } from 'node:crypto';
import {
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  normalizeOutputPluginId,
  now,
  type ChannelMappingRepository,
  type Locale,
  type OutputPluginRegistry
} from '@agent-dock/agent-dock-shared';
import { getActiveServerLocale } from '../../locale-service.js';
import { LARK_ASK_CARD_CHANNEL } from '../ask-user-question-card.js';
import type { LarkCardService } from '../service.js';
import { LarkTurnTracker, type LarkOutputPluginCardDedupKey } from '../turn-tracker.js';
import { LARK_OUTPUT_PLUGIN_CARD_CHANNEL } from './declarative-adapter.js';
import type { LarkOutputPluginAdapterRegistry } from './registry.js';
import type { PersistedLarkOutputPluginCard } from './types.js';

export type LarkOutputPluginCardSenderPort = Partial<Pick<LarkCardService, 'sendInteractiveCard' | 'replyInteractiveCard'>>;

export interface DispatchLarkOutputPluginCardInput {
  pluginRegistry: OutputPluginRegistry;
  larkPluginAdapters: LarkOutputPluginAdapterRegistry;
  service: LarkOutputPluginCardSenderPort;
  /** 跨 listener / turn-sync 共享的追踪器（同时负责占坑防重与出站 messageId 登记）。 */
  turnTracker?: LarkTurnTracker;
  /** 未注入共享 turnTracker 时的局部占坑防重表（供独立单测或孤立实例使用）。 */
  fallbackTracker?: LarkTurnTracker;
  cardMappings?: ChannelMappingRepository;
  /** 可选本地内存查重钩子（如 `LarkMessageCoordinator.pluginCards` 镜像）。 */
  hasLocalSent?: (key: LarkOutputPluginCardDedupKey) => boolean;
  /** 卡片发出并生成持久化记录后、落库前的回调（供协调器更新本地缓存）。 */
  onDispatched?: (record: PersistedLarkOutputPluginCard) => void;
  appId: string;
  sessionId: string;
  taskId?: string;
  chatId: string;
  receiveIdType?: 'chat_id' | 'open_id';
  chatType: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  forceMainThread?: boolean;
  threadId?: string;
  rootId?: string;
  webBaseUrl?: string;
  pluginId: string;
  spec: unknown;
  locale?: Locale;
}

export function cardChannelForOutputPlugin(pluginId: string): string {
  return normalizeOutputPluginId(pluginId) === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID
    ? LARK_ASK_CARD_CHANNEL
    : LARK_OUTPUT_PLUGIN_CARD_CHANNEL;
}

/**
 * 为飞书 OpenAPI `uuid` 生成确定性幂等键（<= 50 字符）：
 * 基于 `(sessionId, taskId, pluginId, widgetId, chatId)` 的 SHA-256 截断摘要，
 * 即使跨进程或极端网络重试，飞书服务端也会按同一 `uuid` 幂等去重。
 */
export function buildLarkOutputPluginCardIdempotencyKey(key: LarkOutputPluginCardDedupKey): string {
  const canonicalId = normalizeOutputPluginId(key.pluginId);
  const isAsk = canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;
  const payload = [
    key.sessionId.trim(),
    key.taskId?.trim() ?? '',
    canonicalId,
    key.widgetId.trim(),
    key.chatId.trim()
  ].join('\u0000');
  const digest = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return `${isAsk ? 'askq' : 'outp'}-${digest}`;
}

export async function hasPersistedLarkOutputPluginCard(
  cardMappings: ChannelMappingRepository | undefined,
  key: LarkOutputPluginCardDedupKey
): Promise<boolean> {
  if (!cardMappings) return false;
  const sessionId = key.sessionId.trim();
  const canonicalId = normalizeOutputPluginId(key.pluginId);
  const widgetId = key.widgetId.trim();
  const chatId = key.chatId.trim();
  if (!sessionId || !canonicalId || !widgetId || !chatId) return false;

  const channel = cardChannelForOutputPlugin(canonicalId);
  const existing = await cardMappings.list(channel).catch(() => []);
  return existing.some(mapping => {
    if (mapping.sessionId !== sessionId || !mapping.extra) return false;
    let rec: Partial<PersistedLarkOutputPluginCard>;
    try {
      rec = JSON.parse(mapping.extra) as Partial<PersistedLarkOutputPluginCard>;
    } catch {
      return false;
    }
    const recPluginId = rec.pluginId ? normalizeOutputPluginId(rec.pluginId) : BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;
    const recWidgetId = (rec.instanceId || rec.questionId || '').trim();
    if (recPluginId !== canonicalId || recWidgetId !== widgetId) return false;
    const recChatIds = [rec.chatId?.trim(), rec.receiveId?.trim()].filter((v): v is string => Boolean(v));
    // 兼容历史未写 chatId 的记录；若已记录目标群/私聊，则按 chatId/receiveId 精确匹配
    if (recChatIds.length > 0 && !recChatIds.includes(chatId)) return false;
    return true;
  });
}

/**
 * 统一的飞书纯 XML 交互插件卡片强幂等派发器（覆盖 AskUserQuestion、ConfirmAction 与全部声明式插件）：
 * 1. 先同步在共享 `LarkTurnTracker` 中按 `(sessionId, taskId, pluginId, widgetId, chatId)`
 *    及 `(sessionId, pluginId, widgetId, chatId)` 占坑，杜绝任何异步并发竞态发出第 2 张卡片；
 * 2. 再核对本地缓存与持久化 `channel_mappings`，保证跨重启幂等；
 * 3. 携带基于五元组计算的确定性 `idempotencyKey` 调用飞书发卡接口；
 * 4. 发卡成功瞬间提升为永久已发态并登记出站 `messageId`；仅在发卡前失败时释放占坑以允许重试。
 */
export async function dispatchLarkOutputPluginCard(
  input: DispatchLarkOutputPluginCardInput
): Promise<PersistedLarkOutputPluginCard | undefined> {
  const canonicalId = normalizeOutputPluginId(input.pluginId);
  const plugin = input.pluginRegistry.get(canonicalId);
  if (!plugin) return undefined;
  const adapter = input.larkPluginAdapters.resolve(plugin);
  if (!adapter) return undefined;
  const widgetId = plugin.getInstanceId(input.spec)?.trim();
  const sessionId = input.sessionId.trim();
  const targetChatId = input.chatId.trim();
  const taskId = input.taskId?.trim() || undefined;
  if (!widgetId || !sessionId || !targetChatId) return undefined;

  const canReply = !input.forceMainThread
    && Boolean(input.replyToMessageId?.trim())
    && !input.replyToMessageId!.startsWith('askq-reply-')
    && !input.replyToMessageId!.startsWith('outp-reply-')
    && typeof input.service.replyInteractiveCard === 'function';
  if (!canReply && typeof input.service.sendInteractiveCard !== 'function') {
    return undefined;
  }

  const dedupKey: LarkOutputPluginCardDedupKey = {
    sessionId,
    ...(taskId ? { taskId } : {}),
    pluginId: canonicalId,
    widgetId,
    chatId: targetChatId
  };

  const claimStore = input.turnTracker ?? input.fallbackTracker ?? new LarkTurnTracker();
  const claim = claimStore.tryClaimOutputPluginCard(dedupKey);
  if (!claim.acquired) return undefined;

  let sentMessageId: string | undefined;
  try {
    if (input.hasLocalSent?.(dedupKey) || await hasPersistedLarkOutputPluginCard(input.cardMappings, dedupKey)) {
      claim.markSent();
      return undefined;
    }

    const isAsk = canonicalId === BUILTIN_ASK_USER_QUESTION_PLUGIN_ID;
    const cardId = `${isAsk ? 'askc' : 'outpc'}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const card = adapter.buildCard({
      cardId,
      plugin,
      spec: input.spec,
      sessionId,
      webBaseUrl: input.webBaseUrl,
      locale: input.locale ?? getActiveServerLocale()
    });
    const idempotencyKey = buildLarkOutputPluginCardIdempotencyKey(dedupKey);

    const sent = canReply
      ? await input.service.replyInteractiveCard!({
          messageId: input.replyToMessageId!,
          card,
          replyInThread: Boolean(input.replyInThread),
          idempotencyKey
        })
      : await input.service.sendInteractiveCard!({
          ...(input.receiveIdType === 'open_id'
            ? { receiveId: targetChatId, receiveIdType: 'open_id' as const }
            : { chatId: targetChatId }),
          card,
          idempotencyKey
        });

    sentMessageId = sent.messageId;
    claim.markSent();
    const resolvedChatId = sent.chatId?.trim() || targetChatId;
    if (resolvedChatId !== targetChatId) {
      claimStore.markOutputPluginCardSent({ ...dedupKey, chatId: resolvedChatId });
    }
    input.turnTracker?.markOutboundMessage(sent.messageId);

    const record: PersistedLarkOutputPluginCard = {
      cardId,
      pluginId: canonicalId,
      appId: input.appId,
      chatId: resolvedChatId,
      ...(input.receiveIdType === 'open_id' ? { receiveId: targetChatId } : {}),
      chatType: input.chatType,
      messageId: sent.messageId,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.replyInThread ? { replyInThread: true } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
      sessionId,
      ...(taskId ? { taskId } : {}),
      instanceId: widgetId,
      ...(isAsk ? { questionId: widgetId } : {}),
      spec: input.spec,
      ...(input.webBaseUrl ? { webBaseUrl: input.webBaseUrl } : {}),
      createdAt: now()
    };

    input.onDispatched?.(record);

    if (input.cardMappings) {
      const channel = cardChannelForOutputPlugin(canonicalId);
      await input.cardMappings.save({
        id: `${channel}:${cardId}`,
        channel,
        externalId: cardId,
        sessionId,
        extra: JSON.stringify(record),
        createdAt: record.createdAt
      });
    }

    return record;
  } catch (error) {
    if (!sentMessageId) {
      claim.release();
    }
    throw error;
  }
}

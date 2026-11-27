import type { ChannelMapping, ChannelMappingRepository, ConfigRepository, Session } from '@agent-dock/agent-dock-shared';
import { readLarkConfigs, type LarkTurnSyncConfigInput } from './config.js';
import type { HandoverCatLike } from './kitten-handover.js';

/** 「托管给机器人」的绑定通道：externalId 是群 chatId，sessionId 是被接管的会话。 */
export const larkHandoverChannel = (appId: string) => `lark-handover:${appId}`;

/** 原生飞书会话（普通飞书群聊 / 飞书私聊）的会话级全轮次同步覆盖策略通道：externalId 为 sessionId。 */
export const LARK_SESSION_TURN_SYNC_CHANNEL = 'lark-turn-sync';

export interface LarkHandoverExtra {
  appId?: string;
  chatId?: string;
  sessionId?: string;
  name?: string;
  /** 托管群级别的全轮次同步覆盖策略；缺省时继承所属机器人的 turnSync 配置。 */
  turnSync?: LarkTurnSyncConfigInput;
}

export interface LarkHandoverBinding {
  appId: string;
  chatId: string;
  name?: string;
  turnSync?: LarkTurnSyncConfigInput;
  /** 原始映射记录（用于按需更新 extra，如修改群同步开关）。 */
  mapping?: ChannelMapping;
}

export type LarkSessionBindingKind = 'handover' | 'lark-group' | 'lark-p2p';

export interface ParsedLarkSourceBinding {
  appId: string;
  chatId: string;
  receiveIdType: 'chat_id' | 'open_id';
  chatType: 'group' | 'p2p';
  scope: string;
}

export interface LarkSessionBinding {
  kind: LarkSessionBindingKind;
  appId: string;
  chatId: string;
  receiveIdType: 'chat_id' | 'open_id';
  chatType: 'group' | 'p2p';
  name?: string;
  scope?: string;
  turnSync?: LarkTurnSyncConfigInput;
  /** 托管群映射记录（仅 kind === 'handover' 时存在）。 */
  mapping?: ChannelMapping;
}

export function parseHandoverMappingExtra(raw?: string | null): LarkHandoverExtra {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as LarkHandoverExtra;
  } catch {
    return {};
  }
}

/**
 * 解析原生飞书会话（`source === 'lark'`）的 `sourceId`：
 * - 普通飞书群聊：`<appId>:<oc_chatId>:group[:<scope>]`
 * - 飞书私聊（标准格式）：`<appId>:<oc_chatId>:p2p`
 * - 飞书私聊（历史 2 段格式）：`<appId>:<oc_chatId>`
 * - 飞书私聊（open_id 变体）：`<appId>:<ou_openId>:p2p`
 */
export function parseLarkSessionSourceBinding(
  source: string | undefined | null,
  sourceId: string | undefined | null
): ParsedLarkSourceBinding | undefined {
  if (source !== 'lark' || !sourceId) return undefined;
  const parts = sourceId.split(':');
  const appId = parts[0]?.trim();
  const chatId = parts[1]?.trim();
  if (!appId || !chatId) return undefined;

  // 兼容早期 2 段私聊格式：<appId>:<oc_chatId>
  if (parts.length === 2) {
    if (chatId.startsWith('oc_')) {
      return { appId, chatId, receiveIdType: 'chat_id', chatType: 'p2p', scope: '' };
    }
    if (chatId.startsWith('ou_')) {
      return { appId, chatId, receiveIdType: 'open_id', chatType: 'p2p', scope: '' };
    }
    return undefined;
  }

  const chatType = parts[2]?.trim();
  const scope = parts.slice(3).join(':');
  if (chatType === 'group') {
    if (!chatId.startsWith('oc_')) return undefined;
    return { appId, chatId, receiveIdType: 'chat_id', chatType: 'group', scope };
  }
  if (chatType === 'p2p') {
    if (chatId.startsWith('oc_')) {
      return { appId, chatId, receiveIdType: 'chat_id', chatType: 'p2p', scope: '' };
    }
    if (chatId.startsWith('ou_')) {
      return { appId, chatId, receiveIdType: 'open_id', chatType: 'p2p', scope: '' };
    }
  }
  return undefined;
}

export async function readSessionTurnSyncOverride(
  mappings: ChannelMappingRepository,
  sessionId: string
): Promise<LarkTurnSyncConfigInput | undefined> {
  const mapping = await mappings.get(LARK_SESSION_TURN_SYNC_CHANNEL, sessionId).catch(() => undefined);
  if (!mapping?.extra) return undefined;
  const extra = parseHandoverMappingExtra(mapping.extra);
  return extra.turnSync && typeof extra.turnSync === 'object' ? extra.turnSync : undefined;
}

export async function saveSessionTurnSyncOverride(
  mappings: ChannelMappingRepository,
  sessionId: string,
  turnSync: LarkTurnSyncConfigInput | null
): Promise<void> {
  const existing = await mappings.get(LARK_SESSION_TURN_SYNC_CHANNEL, sessionId).catch(() => undefined);
  const extra = parseHandoverMappingExtra(existing?.extra);
  if (turnSync === null) {
    delete extra.turnSync;
  } else {
    extra.turnSync = turnSync;
  }
  await mappings.save({
    id: existing?.id ?? `${LARK_SESSION_TURN_SYNC_CHANNEL}:${sessionId}`,
    channel: LARK_SESSION_TURN_SYNC_CHANNEL,
    externalId: sessionId,
    sessionId,
    extra: JSON.stringify(extra),
    createdAt: existing?.createdAt ?? new Date().toISOString()
  });
}

function toHandoverBinding(appId: string, mapping: ChannelMapping): LarkHandoverBinding {
  const extra = parseHandoverMappingExtra(mapping.extra);
  return {
    appId,
    chatId: mapping.externalId,
    ...(extra.name?.trim() ? { name: extra.name.trim() } : {}),
    ...(extra.turnSync && typeof extra.turnSync === 'object' ? { turnSync: extra.turnSync } : {}),
    mapping
  };
}

/**
 * 按会话 ID 找它被托管到的飞书群。
 *
 * 托管会话的 `source` 不是 lark（多数是桌面端建的），群绑定只记在 channel_mappings 里，
 * 所以不能靠 sourceId 解析，必须反查映射表。一个会话最多托管到一个群（routes 侧保证）。
 *
 * 当传入 `getLineage` 且目标会话为当前在岗主小猫（如第 2 代交接接班后），
 * 若精确映射仍在同家族的上一代主会话上，会自动沿血缘 family 解析到该托管群，
 * 避免交接后出现同步与群工具断层。
 */
export function createHandoverLookup(
  configs: ConfigRepository,
  mappings: ChannelMappingRepository,
  getLineage?: () => HandoverCatLike[]
) {
  return async (sessionId: string): Promise<LarkHandoverBinding | undefined> => {
    const bots = await readLarkConfigs(configs);
    const byBot: Array<{ appId: string; items: ChannelMapping[] }> = [];
    for (const config of bots) {
      const items = await mappings.list(larkHandoverChannel(config.appId));
      const exact = items.find(item => item.sessionId === sessionId && item.externalId.startsWith('oc_'));
      if (exact) return toHandoverBinding(config.appId, exact);
      byBot.push({ appId: config.appId, items });
    }
    const cats = getLineage?.() ?? [];
    const activeCat = cats.find(item => item.sessionId === sessionId && item.state === 'active');
    if (!activeCat) return undefined;
    const familySessionIds = new Set(cats.filter(item => item.familyId === activeCat.familyId).map(item => item.sessionId));
    for (const { appId, items } of byBot) {
      const sibling = items.find(item => familySessionIds.has(item.sessionId) && item.externalId.startsWith('oc_'));
      if (sibling) return toHandoverBinding(appId, sibling);
    }
    return undefined;
  };
}

/**
 * 统一解析任意会话的飞书同步绑定（覆盖所有普通会话与主会话）：
 * 1. 「托管给机器人」的会话（普通托管群 + 主小猫及其多代交接继承）；
 * 2. 直接从飞书普通群聊发起的会话（`source === 'lark'`, `chatType === 'group'`）；
 * 3. 直接从飞书私聊发起的会话（`source === 'lark'`, `chatType === 'p2p'`，兼容 `oc_` 与 `ou_`）。
 */
export function createLarkSessionBindingLookup(
  configs: ConfigRepository,
  mappings: ChannelMappingRepository,
  getSession?: (sessionId: string) => Promise<Pick<Session, 'id' | 'source' | 'sourceId' | 'title' | 'customTitle'> | undefined>,
  getLineage?: () => HandoverCatLike[]
) {
  const handoverLookup = createHandoverLookup(configs, mappings, getLineage);
  return async (
    sessionId: string,
    hint?: { sessionSource?: string; sessionSourceId?: string }
  ): Promise<LarkSessionBinding | undefined> => {
    const handover = await handoverLookup(sessionId).catch(() => undefined);
    if (handover && handover.chatId.startsWith('oc_')) {
      return {
        kind: 'handover',
        appId: handover.appId,
        chatId: handover.chatId,
        receiveIdType: 'chat_id',
        chatType: 'group',
        ...(handover.name ? { name: handover.name } : {}),
        ...(handover.turnSync ? { turnSync: handover.turnSync } : {}),
        ...(handover.mapping ? { mapping: handover.mapping } : {})
      };
    }

    let source = hint?.sessionSource;
    let sourceId = hint?.sessionSourceId;
    let sessionName: string | undefined;
    if (!source || !sourceId) {
      const session = await getSession?.(sessionId).catch(() => undefined);
      source = source ?? session?.source;
      sourceId = sourceId ?? session?.sourceId;
      sessionName = session?.customTitle?.trim() || session?.title?.trim() || undefined;
    }
    const parsed = parseLarkSessionSourceBinding(source, sourceId);
    if (!parsed) return undefined;
    const override = await readSessionTurnSyncOverride(mappings, sessionId);
    return {
      kind: parsed.chatType === 'p2p' ? 'lark-p2p' : 'lark-group',
      appId: parsed.appId,
      chatId: parsed.chatId,
      receiveIdType: parsed.receiveIdType,
      chatType: parsed.chatType,
      ...(sessionName ? { name: sessionName } : {}),
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(override ? { turnSync: override } : {})
    };
  };
}

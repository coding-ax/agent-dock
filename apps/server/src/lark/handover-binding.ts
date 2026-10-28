import type { ChannelMappingRepository, ConfigRepository } from '@agent-dock/agent-dock-shared';
import { readLarkConfigs } from './config.js';

/** 「托管给机器人」的绑定通道：externalId 是群 chatId，sessionId 是被接管的会话。 */
export const larkHandoverChannel = (appId: string) => `lark-handover:${appId}`;

export interface LarkHandoverBinding { appId: string; chatId: string }

/**
 * 按会话 ID 找它被托管到的飞书群。
 *
 * 托管会话的 `source` 不是 lark（多数是桌面端建的），群绑定只记在 channel_mappings 里，
 * 所以不能靠 sourceId 解析，必须反查映射表。一个会话最多托管到一个群（routes 侧保证）。
 */
export function createHandoverLookup(configs: ConfigRepository, mappings: ChannelMappingRepository) {
  return async (sessionId: string): Promise<LarkHandoverBinding | undefined> => {
    for (const config of await readLarkConfigs(configs)) {
      const mapping = (await mappings.list(larkHandoverChannel(config.appId))).find(item => item.sessionId === sessionId);
      if (mapping?.externalId.startsWith('oc_')) return { appId: config.appId, chatId: mapping.externalId };
    }
    return undefined;
  };
}

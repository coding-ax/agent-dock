import type { RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { createLarkCardService } from '../lark/service.js';
import { readLarkConfigs } from '../lark/config.js';
import { larkHandoverChannel } from '../lark/handover-binding.js';

/**
 * 把主会话的通知推到飞书私聊：优先用托管绑定（channel_mappings）找到主会话对应的 chat，
 * 找不到就返回 false，由调用方把通知标成 failed。桌面通知以后再加，不在这里猜。
 */
export function createLarkNotifier(repos: RepositoryBundle, env: NodeJS.ProcessEnv = process.env) {
  return async (input: { text: string; ask: boolean; urgent: boolean; sessionId?: string }): Promise<boolean> => {
    if (!input.sessionId) return false;
    const configs = await readLarkConfigs(repos.config);
    for (const config of configs) {
      const mappings = await repos.channelMappings.list(larkHandoverChannel(config.appId));
      const mapping = mappings.find(item => item.sessionId === input.sessionId);
      if (!mapping) continue;
      const service = createLarkCardService(env, globalThis.fetch, { appId: config.appId, appSecret: config.appSecret });
      await service.sendText({
        chatId: mapping.externalId,
        text: `${input.ask ? '需要你拍板：' : ''}${input.text}`,
        idempotencyKey: `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      });
      return true;
    }
    return false;
  };
}

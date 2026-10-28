/**
 * 飞书来源会话（source === 'lark'）的 applink 解析。
 *
 * listener 写入的 sourceId 形状：
 * - 私聊：`<appId>:<chatId>:p2p`
 * - 群聊主流/按人/按话题：`<appId>:<chatId>:group:<scope>`，scope 可能是
 *   `chat`、`user:<ou_...>`、`thread:<omt_...>`、`message:<om_...>`
 *
 * 因此只要能从 sourceId 里抠出 chatId，就能生成「打开这个飞书会话」的 applink。
 */
export interface ParsedLarkSource {
  appId: string;
  chatId: string;
  chatType: string;
  /** group 下的隔离 scope，私聊为空串。 */
  scope: string;
}

export function parseLarkSourceId(sourceId: string | undefined): ParsedLarkSource | undefined {
  const parts = (sourceId ?? '').split(':');
  const [appId, chatId, chatType, ...rest] = parts;
  if (!appId || !chatId?.startsWith('oc_')) return undefined;
  // 兼容历史格式：早期会话只写了 `<appId>:<chatId>`（私聊），没有 chatType 段。
  // 这类恰恰是最老的飞书发起会话，不能因为格式旧就没有「在飞书中打开」入口。
  if (parts.length === 2) return { appId, chatId, chatType: 'p2p', scope: '' };
  if (parts.length < 3) return undefined;
  return { appId, chatId, chatType, scope: rest.join(':') };
}

/** 打开某个飞书会话（群 / 私聊）的 applink。 */
export function larkChatAppLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

/**
 * 会话对应的飞书 applink。
 *
 * 飞书**没有公开的按 threadId 直达的 applink**（OpenAPI 只有群分享链接 im.chats.link，
 * 且群分享面单聊/密聊不可用，也不是深链）。这里对话题会话做一次 best-effort：在群 applink
 * 上附带 `threadId=<omt_...>`——客户端如果识别就直达话题，不识别也只会忽略这个多余参数、
 * 照常打开群，属于「零风险尝试」。
 *
 * `exact` 表示「是不是确定能落到目标」：群主流/私聊为 true；话题为 false（尽力而为）。
 */
export function larkSessionAppLink(sourceId: string | undefined): { url: string; exact: boolean; threadId?: string } | undefined {
  const parsed = parseLarkSourceId(sourceId);
  if (!parsed) return undefined;
  const threadId = parsed.scope.startsWith('thread:') ? parsed.scope.slice('thread:'.length).trim() : undefined;
  if (!threadId) return { url: larkChatAppLink(parsed.chatId), exact: true };
  return { url: `${larkChatAppLink(parsed.chatId)}&threadId=${encodeURIComponent(threadId)}`, exact: false, threadId };
}

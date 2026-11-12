import { readFileSync } from 'node:fs';
import { gunzipSync, inflateSync } from 'node:zlib';
import protobuf from 'protobufjs';
import { generateRequestCid, generateRequestId } from './ids.js';

const schema = readFileSync(new URL('./lark.proto', import.meta.url), 'utf8');
const root = protobuf.parse(schema, { keepCase: true }).root;

const type = (name: string) => root.lookupType(`lark.${name}`);
const toObjectOptions = {
  longs: String,
  enums: Number,
  bytes: Buffer,
  defaults: false,
  arrays: true,
  objects: true,
  oneofs: true
} as const;

const decodeObject = <T>(name: string, bytes: Uint8Array): T => {
  const messageType = type(name);
  return messageType.toObject(messageType.decode(bytes), toObjectOptions) as T;
};

const encodeObject = (name: string, value: Record<string, unknown>): Buffer =>
  Buffer.from(type(name).encode(type(name).fromObject(value)).finish());

export interface LarkFrame {
  seqid?: string;
  logid?: string;
  service?: number;
  method?: number;
  headers?: Array<{ key?: string; value?: string }>;
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Buffer;
}

export interface LarkPacket {
  sid?: string;
  payloadType?: number;
  cmd?: number;
  status?: number;
  payload?: Buffer;
  cid?: string;
  command?: number;
  cursor?: string;
  compactedSids?: number[];
}

export interface DecodedFrame {
  frame: LarkFrame;
  packet?: LarkPacket;
  json?: unknown;
}

export interface LarkIncomingMessage {
  messageId: string;
  type: number;
  fromId: string;
  chatId: string;
  chatType: number;
  createTime: number;
  content: string;
  rootId: string;
  parentId: string;
  threadId: string;
  position: number;
  cid: string;
  atUserIds: string[];
  atMe: boolean;
  raw: Record<string, unknown>;
}

export interface LarkChatInfo {
  id: string;
  name: string;
  type: number;
  chatMode: number;
  userCount: number;
  memberCount: number;
  lastMessagePosition: number;
  avatarUrl: string;
}

export interface LarkChatterInfo {
  id: string;
  name: string;
  avatarUrl: string;
  email: string;
}

export interface LarkFeedCard {
  id: string;
  type: number;
  updateTime: number;
  parentCardId: string;
}

const asBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'binary');
  return Buffer.alloc(0);
};

const feishuCdnImageQuery = '~?image_size=noop&cut_type=&quality=&format=image&sticker_format=.webp';

/**
 * 群头像只会下发 pstatp.com 的 origin 地址，这个域在部分网络（如新加坡）无法解析，
 * 而飞书 CDN 用同一个资源 key 提供等价图片。统一换到 CDN，历史数据也走这里。
 */
export const normalizeAvatarUrl = (url: string): string => {
  const secure = url.startsWith('http://') ? `https://${url.slice(7)}` : url;
  const origin = /^https:\/\/p\d+\.pstatp\.com\/origin\/([^?#]+)(?:\?.*)?$/.exec(secure);
  return origin ? `https://s1-imfile.feishucdn.com/static-resource/v1/${origin[1]}${feishuCdnImageQuery}` : secure;
};

const imageUrl = (value: unknown): string => {
  if (!value || typeof value !== 'object') return '';
  const image = value as Record<string, unknown>;
  for (const key of ['secureUrls', 'urls']) {
    const urls = image[key];
    if (Array.isArray(urls) && urls.length) return normalizeAvatarUrl(String(urls[0] ?? ''));
    if (typeof urls === 'string' && urls) return normalizeAvatarUrl(urls);
  }
  return '';
};

const framePayload = (frame: LarkFrame): Buffer => {
  const payload = asBuffer(frame.payload);
  const encoding = (frame.payloadEncoding ?? '').toLowerCase();
  if (encoding === 'gzip' || (!encoding && payload[0] === 0x1f && payload[1] === 0x8b)) {
    return gunzipSync(payload);
  }
  if (encoding === 'deflate' || encoding === 'zlib') return inflateSync(payload);
  return payload;
};

export const decodeFrame = (raw: Buffer): DecodedFrame => {
  const frame = decodeObject<LarkFrame>('Frame', raw);
  const encoding = (frame.payloadEncoding ?? '').toLowerCase();
  if (encoding === 'json') {
    try {
      return { frame, json: JSON.parse(asBuffer(frame.payload).toString('utf8')) };
    } catch {
      return { frame, json: undefined };
    }
  }
  const packet = decodeObject<LarkPacket>('improto.Packet', framePayload(frame));
  return { frame, packet };
};

export const decodePacket = (raw: Uint8Array): LarkPacket =>
  decodeObject<LarkPacket>('improto.Packet', raw);

export const encodePacket = (packet: LarkPacket): Buffer =>
  encodeObject('improto.Packet', packet as Record<string, unknown>);

export const encodeFrame = (packet: LarkPacket): Buffer => {
  const packetBytes = encodePacket(packet);
  const seconds = Math.floor(Date.now() / 1000);
  return encodeObject('Frame', {
    seqid: seconds,
    logid: seconds,
    service: 1,
    method: 1,
    headers: [{ key: 'x-request-time', value: String(Date.now()) }],
    payloadType: 'pb',
    payload: packetBytes
  });
};

export const encodeAckPacket = (sid: string): Buffer =>
  encodeFrame({ sid, payloadType: 1, cmd: 1, payload: Buffer.from([0x08, 0x00]) });

export const encodeHeartbeatPacket = (): Buffer =>
  encodeFrame({ payloadType: 1, cmd: 4 });

export const encodePullSidsRequest = (sids: string[]): Buffer =>
  encodeObject('improto.PullPacketsBySidsRequest', { sids });

export const decodePullSidsResponse = (payload: Buffer): LarkPacket[] => {
  const response = decodeObject<{ packets?: Record<string, LarkPacket> }>('improto.PullPacketsBySidsResponse', payload);
  return Object.values(response.packets ?? {});
};

export const encodePullChatsRequest = (chatIds: string[]): Buffer =>
  encodeObject('chats.PullChatsByIdsRequest', { chatIds });

export const decodeChatsResponse = (payload: Buffer): LarkChatInfo[] => {
  const response = decodeObject<{ chats?: Record<string, Record<string, unknown>> }>('chats.PullChatsByIdsResponse', payload);
  return Object.values(response.chats ?? {}).map(chat => ({
    id: String(chat.id ?? ''),
    name: String(chat.name ?? ''),
    type: Number(chat.type ?? 0),
    chatMode: Number(chat.chatMode ?? 0),
    userCount: Number(chat.userCount ?? 0),
    memberCount: Number(chat.memberCount ?? 0),
    lastMessagePosition: Number(chat.lastMessagePosition ?? 0),
    avatarUrl: imageUrl(chat.avatar) || imageUrl(chat.miniAvatar)
  }));
};

export const encodePullChattersRequest = (chatterIds: string[]): Buffer =>
  encodeObject('chatters.PullChattersByIdsRequest', { chatterIds, needBotInfo: true });

export const decodeChattersResponse = (payload: Buffer): LarkChatterInfo[] => {
  const response = decodeObject<{ chatters?: Record<string, Record<string, unknown>> }>('chatters.PullChattersByIdsResponse', payload);
  return Object.values(response.chatters ?? {}).map(chatter => ({
    id: String(chatter.id ?? ''),
    name: String(chatter.name ?? chatter.enUsName ?? ''),
    avatarUrl: normalizeAvatarUrl(String(chatter.avatarUrl ?? '')) || imageUrl(chatter.avatarImage),
    email: String(chatter.email ?? '')
  }));
};

export const encodePullFeedCardsRequest = (): Buffer =>
  encodeObject('feed.PullFeedCardsRequest', { type: 1, pullType: 1, count: 100 });

export const decodeFeedCardsResponse = (payload: Buffer): LarkFeedCard[] => {
  const response = decodeObject<{ cards?: Array<Record<string, unknown>> }>('feed.PullFeedCardsResponse', payload);
  return (response.cards ?? []).map(card => ({
    id: String(card.id ?? ''),
    type: Number(card.type ?? 0),
    updateTime: Number(card.updateTime ?? 0),
    parentCardId: String(card.parentCardId ?? '')
  }));
};

export const encodePullMessagesByIdsRequest = (messageIds: string[]): Buffer =>
  encodeObject('messages.PullMessagesByIdsRequest', { messageIds });

export const decodePullMessagesByIdsResponse = (payload: Buffer): LarkIncomingMessage[] => {
  const response = decodeObject<{ messages?: Record<string, Record<string, unknown>> }>('messages.PullMessagesByIdsResponse', payload);
  return Object.values(response.messages ?? {}).map(message => decodeMessage(message, false));
};

export const encodePullMessagesByPositionsRequest = (chatId: string, positions: number[]): Buffer =>
  encodeObject('messages.PullMessagesByPositionsRequest', { chatId, positions });

export const decodePullMessagesByPositionsResponse = (payload: Buffer): LarkIncomingMessage[] => {
  const response = decodeObject<{ messages?: Record<string, Record<string, unknown>> }>(
    'messages.PullMessagesByPositionsResponse',
    payload
  );
  return Object.values(response.messages ?? {}).map(message => decodeMessage(message, false));
};

export const decodePushMessages = (payload: Buffer): LarkIncomingMessage[] => {
  if (!payload.length) return [];
  const response = decodeObject<{
    messages?: Record<string, Record<string, unknown>>;
    messagesAtMe?: Record<string, boolean>;
  }>('messages.PushMessagesRequest', payload);
  const atMe = response.messagesAtMe ?? {};
  return Object.entries(response.messages ?? {}).map(([key, message]) =>
    decodeMessage(message, Boolean(atMe[String(message.id ?? key)] ?? atMe[key]))
  );
};

export const decodeBatchCopyMessages = (payload: Buffer): { ids: string[]; messages: LarkIncomingMessage[] } => {
  const response = decodeObject<{ messageIds?: string[]; lastMessage?: Record<string, unknown> }>(
    'messages.PushBatchCopyMessages',
    payload
  );
  const ids = (response.messageIds ?? []).map(String);
  const last = response.lastMessage && response.lastMessage.id
    ? [decodeMessage(response.lastMessage, false)]
    : [];
  return { ids, messages: last };
};

export const decodeMessage = (message: Record<string, unknown>, atMe: boolean): LarkIncomingMessage => {
  const messageType = Number(message.type ?? 0);
  const atUserIds = [
    ...((message.atOutChatterIds as string[] | undefined) ?? []),
    ...((message.atUserIdList as string[] | undefined) ?? [])
  ].map(String);
  return {
    messageId: String(message.id ?? ''),
    type: messageType,
    fromId: String(message.fromId ?? ''),
    chatId: String(message.chatId ?? message.channelId ?? ''),
    chatType: Number(message.chatType ?? 0),
    createTime: Number(message.createTime ?? 0),
    content: decodeMessageContent(messageType, asBuffer(message.content)),
    rootId: String(message.rootId ?? ''),
    parentId: String(message.parentId ?? ''),
    threadId: String(message.threadId ?? ''),
    position: Number(message.position ?? 0),
    cid: String(message.cid ?? ''),
    atUserIds,
    atMe,
    raw: {
      id: message.id,
      type: message.type,
      fromId: message.fromId,
      fromType: message.fromType,
      chatId: message.chatId,
      channelId: message.channelId,
      chatType: message.chatType,
      rootId: message.rootId,
      parentId: message.parentId,
      threadId: message.threadId,
      position: message.position,
      createTime: message.createTime,
      cid: message.cid
    }
  };
};

export const encodeCreateReactionRequest = (messageId: string, type: string): Buffer =>
  encodeObject('messages.CreateReactionRequest', { messageId, type });

export const decodeCreateReactionRequest = (payload: Buffer): { messageId?: string; type?: string } =>
  decodeObject('messages.CreateReactionRequest', payload);

export const encodePutMessageRequest = (input: {
  chatId: string;
  text: string;
  rootId?: string;
  quote?: boolean;
  threadChat?: boolean;
}): Buffer => {
  const elementId = generateRequestCid();
  const textProperty = encodeObject('entities.RichTextElement.TextProperty', { content: input.text });
  const request: Record<string, unknown> = {
    type: 4,
    chatId: input.chatId,
    cid: generateRequestCid(),
    isNotified: true,
    version: 1,
    content: {
      richText: {
        elementIds: [elementId],
        innerText: input.text,
        elements: {
          dictionary: {
            [elementId]: {
              tag: 1,
              property: textProperty
            }
          }
        }
      }
    }
  };
  if (input.rootId) {
    request.rootId = input.rootId;
    request.parentId = input.rootId;
    if (!input.quote && !input.threadChat) request.isReplyInThread = true;
  }
  return encodeObject('messages.PutMessageRequest', request);
};

export const decodePutMessageResponse = (content: Buffer): string => {
  if (!content.length) return '';
  const response = decodeObject<{ message?: { id?: string } }>('messages.PutMessageResponse', content);
  return String(response.message?.id ?? '');
};

const TAG = {
  TEXT: 1,
  IMG: 2,
  P: 3,
  AT: 5,
  A: 6,
  EMOTION: 10,
  LINK: 17,
  MEDIA: 18,
  DOCS: 22,
  UL: 26,
  OL: 27,
  LI: 28,
  QUOTE: 29,
  CODE: 30,
  CODE_BLOCK: 31,
  CODE_BLOCK_V2: 37
} as const;

const BLOCK_TAGS = new Set<number>([
  TAG.P, TAG.DOCS, TAG.UL, TAG.OL, TAG.LI, TAG.QUOTE, TAG.CODE, TAG.CODE_BLOCK, TAG.CODE_BLOCK_V2
]);

const extractRichText = (rich: Record<string, unknown> | undefined): string => {
  if (!rich) return '';
  const elements = rich.elements as { dictionary?: Record<string, Record<string, unknown>> } | undefined;
  const dictionary = elements?.dictionary ?? {};
  const seen = new Set<string>();
  let output = '';

  const leaf = (tag: number, property: Buffer) => {
    try {
      if (tag === TAG.TEXT || tag === TAG.P) {
        output += decodeObject<{ content?: string }>('entities.RichTextElement.TextProperty', property).content ?? '';
      } else if (tag === TAG.AT) {
        output += decodeObject<{ content?: string }>('entities.RichTextElement.AtProperty', property).content ?? '';
      } else if (tag === TAG.A || tag === TAG.LINK) {
        const anchor = decodeObject<{ href?: string; content?: string; textContent?: string; isCustom?: boolean; scene?: number }>(
          'entities.RichTextElement.AnchorProperty',
          property
        );
        if (anchor.content && anchor.content !== anchor.href && (anchor.isCustom || anchor.scene)) {
          output += `${anchor.content}(${anchor.href ?? ''})`;
        } else {
          output += anchor.href || anchor.content || anchor.textContent || '';
        }
      } else if (tag === TAG.CODE || tag === TAG.CODE_BLOCK) {
        output += decodeObject<{ content?: string }>('entities.RichTextElement.CodeBlockProperty', property).content ?? '';
      } else if (tag === TAG.IMG) {
        output += '[图片]';
      } else if (tag === TAG.EMOTION) {
        output += '[表情]';
      } else if (tag === TAG.MEDIA) {
        output += '[视频]';
      }
    } catch {
      // 未知属性按空叶子处理，不让一条坏消息毁掉整批推送。
    }
  };

  const walk = (key: string, ordered: boolean, index: number) => {
    const element = dictionary[key];
    if (!element || seen.has(key)) return;
    seen.add(key);
    const tag = Number(element.tag ?? 0);
    const children = (element.childIds as string[] | undefined) ?? [];
    if (tag === TAG.LI) output += ordered ? `${index + 1}. ` : '- ';
    if (children.length) {
      if (BLOCK_TAGS.has(tag) && tag !== TAG.LI && output && !output.endsWith('\n')) output += '\n';
      children.forEach((child, childIndex) => walk(child, tag === TAG.OL, childIndex));
      if (BLOCK_TAGS.has(tag) && !output.endsWith('\n')) output += '\n';
    } else {
      leaf(tag, asBuffer(element.property));
      if (tag === TAG.P && !output.endsWith('\n')) output += '\n';
    }
  };

  const roots = ((rich.elementIds as string[] | undefined) ?? []).filter(key => key in dictionary);
  const listed = new Set(roots);
  const remaining = Object.keys(dictionary)
    .filter(key => !listed.has(key))
    .sort((left, right) => Number(left) - Number(right));
  for (const key of [...roots, ...remaining]) walk(key, false, 0);
  return output.trim();
};

export const decodeMessageContent = (messageType: number, content: Buffer): string => {
  if (!content.length) return '';
  try {
    if (messageType === 4) {
      const text = decodeObject<{ text?: string; richText?: Record<string, unknown> }>('messages.TextContent', content);
      return (extractRichText(text.richText) || text.text || '').trim();
    }
    if (messageType === 2) {
      const post = decodeObject<{ title?: string; text?: string; richText?: Record<string, unknown> }>('messages.PostContent', content);
      const body = extractRichText(post.richText) || post.text || '';
      return [post.title, body].filter(Boolean).join('\n').trim();
    }
    if (messageType === 5) return '[图片]';
    if (messageType === 3) return '[文件]';
    if (messageType === 7) return '[语音]';
    if (messageType === 10) return '[表情包]';
    if (messageType === 14) return '[卡片]';
    if (messageType === 11) return '[合并转发]';
    if (messageType === 15) return '[视频]';
    if (messageType === 6) return '[系统消息]';
  } catch {
    return '[消息解析失败]';
  }
  return `[消息类型 ${messageType}]`;
};

export const requestId = (): string => generateRequestId();

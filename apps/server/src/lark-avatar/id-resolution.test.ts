import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LarkAvatarIdResolver,
  LarkAvatarResolutionError,
  type LarkAvatarIdResolverOptions
} from './id-resolution.js';
import type { LarkAvailableChat, LarkProtocolClientLike } from './protocol/client.js';
import type { LarkChatInfo, LarkChatterInfo, LarkIncomingMessage } from './protocol/proto.js';
import { LarkAvatarService, type LarkAvatarRuntime } from './service.js';
import type { LarkAvatarInboxItem } from './types.js';

const services: LarkAvatarService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
});

const chatInfo = (input: {
  id: string;
  name: string;
  type?: number;
  lastMessagePosition?: number;
  memberCount?: number;
}): LarkChatInfo => ({
  id: input.id,
  name: input.name,
  type: input.type ?? 2,
  chatMode: 1,
  userCount: input.memberCount ?? 0,
  memberCount: input.memberCount ?? 0,
  lastMessagePosition: input.lastMessagePosition ?? 0,
  avatarUrl: ''
});

const chatter = (input: {
  id: string;
  name: string;
  email?: string;
}): LarkChatterInfo => ({
  id: input.id,
  name: input.name,
  avatarUrl: '',
  email: input.email ?? ''
});

const incoming = (input: Partial<LarkIncomingMessage> & { messageId: string; chatId: string }): LarkIncomingMessage => ({
  type: 4,
  fromId: '',
  chatType: 2,
  createTime: 1_767_225_600,
  content: '',
  rootId: '',
  parentId: '',
  threadId: '',
  position: 1,
  cid: '',
  atUserIds: [],
  atMe: false,
  raw: {},
  ...input
});

const inboxItem = (input: Partial<LarkAvatarInboxItem> & { chatId: string }): LarkAvatarInboxItem => ({
  id: `item_${input.chatId}`,
  threadKey: `lark:${input.chatId}`,
  messageId: `om_${input.chatId}`,
  chatId: input.chatId,
  chatType: 'group',
  title: '测试消息',
  tier: 'fyi',
  state: 'handled',
  occurredAt: '2026-01-01T00:00:00.000Z',
  receivedAt: '2026-01-01T00:00:00.000Z',
  payload: {},
  ...input
});

const fakeClient = (input: {
  chats?: LarkChatInfo[];
  chatAliases?: Record<string, string>;
  chatters?: LarkChatterInfo[];
  chatterAliases?: Record<string, string>;
  messages?: LarkIncomingMessage[];
  messageAliases?: Record<string, string>;
} = {}) => {
  const calls = { lookup: 0, listChats: 0, history: 0, messagesByIds: 0 };
  const chats = input.chats ?? [];
  const chatters = input.chatters ?? [];
  const messages = input.messages ?? [];

  const client: LarkProtocolClientLike = {
    start() {},
    stop() {},
    reconnect() {},
    async sendText() {
      throw new Error('解析测试不允许发消息');
    },
    async lookup(chatIds, userIds) {
      calls.lookup++;
      const foundChats = new Map<string, LarkChatInfo>();
      for (const requested of chatIds) {
        const actual = input.chatAliases?.[requested] ?? requested;
        const found = chats.find(chat => chat.id === actual);
        if (found) foundChats.set(found.id, found);
      }
      const foundChatters = new Map<string, LarkChatterInfo>();
      for (const requested of userIds) {
        const actual = input.chatterAliases?.[requested] ?? requested;
        const found = chatters.find(item => item.id === actual);
        if (found) foundChatters.set(found.id, found);
      }
      return { chats: foundChats, chatters: foundChatters };
    },
    async listChats() {
      calls.listChats++;
      return chats.map<LarkAvailableChat>(chat => ({
        ...chat,
        updateTime: Date.parse('2026-01-01T00:00:00.000Z')
      }));
    },
    async history(chatId, beforePosition, limit) {
      calls.history++;
      return messages
        .filter(message => message.chatId === chatId && message.position <= beforePosition)
        .sort((left, right) => left.position - right.position)
        .slice(-limit);
    },
    async messagesByIds(messageIds) {
      calls.messagesByIds++;
      return messageIds.flatMap(id => {
        const actual = input.messageAliases?.[id] ?? id;
        return messages.filter(message => message.messageId === actual);
      });
    }
  };
  return { client, calls };
};

const makeResolver = (
  client: LarkProtocolClientLike | undefined,
  input: Partial<LarkAvatarIdResolverOptions> & { inbox?: LarkAvatarInboxItem[] } = {}
) => {
  const { inbox, ...options } = input;
  return new LarkAvatarIdResolver({
    client: () => client,
    isLoggedIn: () => true,
    inbox: () => inbox ?? [],
    log: { warn: vi.fn() },
    ...options
  });
};

const captureError = async (promise: Promise<unknown>): Promise<LarkAvatarResolutionError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LarkAvatarResolutionError) return error;
    throw error;
  }
  throw new Error('expected resolution to fail');
};

describe('lark avatar id resolution', () => {
  it('uses an already numeric chat id directly without hitting the gateway', async () => {
    const fake = fakeClient();
    const resolver = makeResolver(fake.client);

    const chat = await resolver.resolveChat('900001');

    expect(chat).toMatchObject({ chatId: 900001, webChatId: '900001', type: 'unknown' });
    expect(typeof chat.chatId).toBe('number');
    expect(fake.calls.lookup).toBe(0);
  });

  it('resolves an oc_* chat id through the existing gateway session', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', type: 2, memberCount: 8 })],
      chatAliases: { oc_group: '900001' }
    });
    const resolver = makeResolver(fake.client);

    const chat = await resolver.resolveChat('oc_group');

    expect(chat).toMatchObject({ chatId: 900001, webChatId: '900001', name: '测试群', type: 'group', memberCount: 8 });
    expect(fake.calls.lookup).toBe(1);
  });

  it('resolves a unique exact chat name and a unique fuzzy name', async () => {
    const fake = fakeClient({
      chats: [
        chatInfo({ id: '900001', name: '测试群', type: 2 }),
        chatInfo({ id: '900002', name: '产品讨论组', type: 2 })
      ]
    });
    const resolver = makeResolver(fake.client);

    await expect(resolver.resolveChat('测试群')).resolves.toMatchObject({ chatId: 900001, name: '测试群' });
    await expect(resolver.resolveChat('产品')).resolves.toMatchObject({ chatId: 900002, name: '产品讨论组' });
    expect(fake.calls.listChats).toBe(1);
  });

  it('returns candidates and marks chat-name ambiguity', async () => {
    const fake = fakeClient({
      chats: [
        chatInfo({ id: '900001', name: '测试群', type: 2 }),
        chatInfo({ id: '900002', name: '测试群', type: 3 })
      ]
    });
    const resolver = makeResolver(fake.client);

    const search = await resolver.searchChats('测试群');
    expect(search).toMatchObject({ match: 'exact', ambiguous: true });
    expect(search.candidates.map(candidate => candidate.chatId)).toEqual(['900001', '900002']);

    const error = await captureError(resolver.resolveChat('测试群'));
    expect(error.code).toBe('CHAT_AMBIGUOUS');
    expect(error.candidates).toHaveLength(2);
  });

  it('reports a missing chat with an actionable code', async () => {
    const resolver = makeResolver(fakeClient().client);
    const error = await captureError(resolver.resolveChat('不存在的群'));

    expect(error.code).toBe('CHAT_NOT_FOUND');
    expect(error.hint).toContain('oc_*');
  });

  it('rejects resolution when no login or no gateway session exists', async () => {
    const missingLogin = makeResolver(fakeClient().client, { isLoggedIn: () => false });
    await expect(missingLogin.resolveChat('900001')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });

    const missingClient = makeResolver(undefined);
    const error = await captureError(missingClient.resolveChat('900001'));
    expect(error.code).toBe('NOT_LOGGED_IN');
    expect(error.hint).toContain('监听');
  });

  it('caches chat resolution for a short TTL and refreshes after expiry', async () => {
    let now = 1_000;
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', type: 2 })],
      chatAliases: { oc_group: '900001' }
    });
    const resolver = makeResolver(fake.client, { now: () => now, ttlMs: 1_000 });

    await resolver.resolveChat('oc_group');
    await resolver.resolveChat('oc_group');
    expect(fake.calls.lookup).toBe(1);

    now += 1_001;
    await resolver.resolveChat('oc_group');
    expect(fake.calls.lookup).toBe(2);
  });

  it('never treats oc_/om_/ou_ prefixed gateway ids as numeric ids', async () => {
    const prefixedChat = makeResolver(fakeClient({
      chats: [chatInfo({ id: 'oc_group', name: '测试群' })],
      chatAliases: { oc_group: 'oc_group' }
    }).client);
    await expect(prefixedChat.resolveChat('oc_group')).rejects.toMatchObject({ code: 'ID_NOT_NUMERIC' });

    const prefixedMessage = makeResolver(fakeClient({
      messages: [incoming({ messageId: 'om_root', chatId: '900001', position: 1 })],
      messageAliases: { om_root: 'om_root' }
    }).client);
    const chat = await prefixedMessage.resolveChat('900001');
    await expect(prefixedMessage.resolveRoot(chat, 'om_root')).rejects.toMatchObject({ code: 'ID_NOT_NUMERIC' });

    const prefixedUser = makeResolver(fakeClient({
      chatters: [chatter({ id: 'ou_user', name: '小肥鱼' })],
      chatterAliases: { ou_user: 'ou_user' }
    }).client);
    await expect(prefixedUser.resolveMentions(chat, ['ou_user'])).rejects.toMatchObject({ code: 'ID_NOT_NUMERIC' });
  });

  it('resolves an om_* message id to the numeric thread root', async () => {
    const fake = fakeClient({
      messages: [incoming({ messageId: '700001', chatId: '900001', position: 5, content: '话题根' })],
      messageAliases: { om_root: '700001' }
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('900001');

    await expect(resolver.resolveRoot(chat, 'om_root')).resolves.toBe(700001);
    expect(fake.calls.messagesByIds).toBe(1);
  });

  it('rejects a message id that belongs to another chat', async () => {
    const fake = fakeClient({
      messages: [incoming({ messageId: '700001', chatId: '900002', position: 5 })],
      messageAliases: { om_root: '700001' }
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('900001');

    await expect(resolver.resolveRoot(chat, 'om_root')).rejects.toMatchObject({ code: 'ROOT_NOT_IN_CHAT' });
  });

  it('resolves a unique root keyword inside the selected chat', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', lastMessagePosition: 10 })],
      chatAliases: { oc_900001: '900001' },
      messages: [
        incoming({ messageId: '700010', chatId: '900001', position: 8, content: '昨天部署失败了' }),
        incoming({ messageId: '700011', chatId: '900001', position: 9, content: '今天再看' })
      ]
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('oc_900001');

    await expect(resolver.resolveRoot(chat, '部署')).resolves.toBe(700010);
  });

  it('marks ambiguous and missing root keywords', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', lastMessagePosition: 10 })],
      messages: [
        incoming({ messageId: '700010', chatId: '900001', position: 8, content: '部署一' }),
        incoming({ messageId: '700011', chatId: '900001', position: 9, content: '部署二' })
      ]
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('900001');

    const ambiguous = await captureError(resolver.resolveRoot(chat, '部署'));
    expect(ambiguous.code).toBe('ROOT_AMBIGUOUS');
    expect(ambiguous.candidates).toHaveLength(2);

    await expect(resolver.resolveRoot(chat, '不存在的关键字')).rejects.toMatchObject({ code: 'ROOT_NOT_FOUND' });
  });

  it('resolves ou_* open ids and numeric user ids to numeric mentions', async () => {
    const fake = fakeClient({
      chatters: [chatter({ id: '5001', name: '小肥鱼', email: 'fish@example.com' })],
      chatterAliases: { ou_user: '5001' }
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('900001');

    await expect(resolver.resolveMentions(chat, ['ou_user'])).resolves.toEqual([{ userId: 5001, name: '小肥鱼' }]);
    await expect(resolver.resolveMentions(chat, ['5001'])).resolves.toEqual([{ userId: 5001, name: '小肥鱼' }]);
  });

  it('resolves mentions by exact name, email and reports ambiguity', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', lastMessagePosition: 10 })],
      chatters: [
        chatter({ id: '5001', name: '小肥鱼', email: 'fish@example.com' }),
        chatter({ id: '5002', name: '小肥鱼', email: 'fish2@example.com' }),
        chatter({ id: '5003', name: '另一个人', email: 'other@example.com' })
      ],
      messages: [
        incoming({ messageId: '700010', chatId: '900001', position: 8, fromId: '5001', content: '一' }),
        incoming({ messageId: '700011', chatId: '900001', position: 9, fromId: '5002', content: '二' }),
        incoming({ messageId: '700012', chatId: '900001', position: 10, fromId: '5003', content: '三' })
      ]
    });
    const resolver = makeResolver(fake.client);
    const chat = await resolver.resolveChat('900001');

    const ambiguous = await captureError(resolver.resolveMentions(chat, ['小肥鱼']));
    expect(ambiguous.code).toBe('USER_AMBIGUOUS');
    expect(ambiguous.candidates).toHaveLength(2);

    await expect(resolver.resolveMentions(chat, ['other@example.com'])).resolves.toEqual([
      { userId: 5003, name: '另一个人' }
    ]);
    await expect(resolver.resolveMentions(chat, ['另一个人'])).resolves.toEqual([
      { userId: 5003, name: '另一个人' }
    ]);
    await expect(resolver.resolveMentions(chat, ['查无此人'])).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('returns the unified target shape with number ids only', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', type: 2 })],
      chatAliases: { oc_group: '900001' },
      chatters: [chatter({ id: '5001', name: '小肥鱼' })],
      chatterAliases: { ou_user: '5001' },
      messages: [incoming({ messageId: '700001', chatId: '900001', position: 5 })],
      messageAliases: { om_root: '700001' }
    });
    const resolver = makeResolver(fake.client);

    const target = await resolver.resolveTarget({
      chat: '测试群',
      root: 'om_root',
      mentions: ['ou_user', '5001']
    });

    expect(target).toEqual({
      chatId: 900001,
      rootId: 700001,
      mentions: [{ userId: 5001, name: '小肥鱼' }]
    });
    expect(typeof target.chatId).toBe('number');
    expect(typeof target.rootId).toBe('number');
    expect(target.mentions.every(mention => typeof mention.userId === 'number')).toBe(true);
  });
});

const authFetcher = () => vi.fn<typeof fetch>().mockImplementation(async (request: RequestInfo | URL) => {
  const url = String(request);
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  if (url.includes('/suite/passport/frontier_ticket/')) return json({ ticket: 'ticket-1' });
  if (url.includes('/accounts/web/user')) {
    return json({ data: { user: { id: 42, name: '测试用户', avatar_url: '', email: 'test@example.com' } } });
  }
  if (url.includes('/messenger/')) {
    return new Response('window.__feishuMeta={appKey: "app-key", teaAppId: "161471"}', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    });
  }
  if (url.includes('/accounts/csrf')) return new Response('', { status: 200 });
  throw new Error(`unexpected auth URL: ${url}`);
});

const runtime = (): LarkAvatarRuntime => ({
  async getSession() { return undefined; },
  async start() { return { id: 's1' }; },
  async dispatch() { return { id: 't1', status: 'queued' }; }
});

const makeService = (client: LarkProtocolClientLike) => {
  const service = new LarkAvatarService({
    databaseUrl: ':memory:',
    runtime: runtime(),
    clientFactory: () => client,
    fetcher: authFetcher() as unknown as typeof fetch
  });
  services.push(service);
  return service;
};

describe('lark avatar service resolution wiring', () => {
  it('reuses the logged-in gateway session for target resolution', async () => {
    const fake = fakeClient({
      chats: [chatInfo({ id: '900001', name: '测试群', type: 2 })],
      chatAliases: { oc_group: '900001' },
      chatters: [chatter({ id: '5001', name: '小肥鱼' })],
      chatterAliases: { ou_user: '5001' },
      messages: [incoming({ messageId: '700001', chatId: '900001', position: 5 })],
      messageAliases: { om_root: '700001' }
    });
    const service = makeService(fake.client);
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await expect(service.resolveTarget({
      chat: 'oc_group',
      root: 'om_root',
      mentions: ['ou_user']
    })).resolves.toEqual({
      chatId: 900001,
      rootId: 700001,
      mentions: [{ userId: 5001, name: '小肥鱼' }]
    });
  });

  it('reports not logged in before a session is established', async () => {
    const service = makeService(fakeClient().client);
    await expect(service.resolveChat('900001')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });
});

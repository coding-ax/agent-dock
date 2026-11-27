import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerLarkAvatarRoutes } from './routes.js';
import { LarkAvatarService } from './service.js';
import { LarkAvatarStore } from './store.js';
import type { LarkAvailableChat, LarkProtocolClientLike } from './protocol/client.js';

const stores: LarkAvatarStore[] = [];

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const json = (value: unknown) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});

const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/accounts/qrlogin/init')) {
    return new Response(JSON.stringify({ code: 0, data: { step_info: { token: 'qr-token' } } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-flow-key': 'flow-1' }
    });
  }
  if (url.includes('/suite/passport/frontier_ticket/')) return json({ ticket: 'ticket-1' });
  if (url.includes('/accounts/web/user')) return json({ data: { user: { id: 42, name: '测试用户' } } });
  if (url.includes('/messenger/')) return new Response('appKey: "app-key" teaAppId: "161471"', { status: 200 });
  if (url.includes('/accounts/csrf')) return new Response('', { status: 200 });
  throw new Error(`unexpected URL: ${url}`);
});

const makeClient = (input: {
  chats?: LarkAvailableChat[];
  history?: Array<{
    messageId: string;
    chatId: string;
    fromId: string;
    type: number;
    chatType: number;
    content: string;
    createTime: number;
    position: number;
    rootId: string;
    parentId: string;
    threadId: string;
    raw: Record<string, unknown>;
  }>;
  nonNumericChatAlias?: string;
} = {}) => {
  const sent: Array<Parameters<LarkProtocolClientLike['sendText']>[0]> = [];
  const client: LarkProtocolClientLike = {
    start(handlers) { handlers.onStatus({ state: 'connected' }); },
    stop() {},
    reconnect() {},
    async sendText(body) {
      sent.push(body);
      return { messageId: 'om_sent' };
    },
    async lookup(chatIds, userIds) {
      return {
        chats: new Map(chatIds.map(id => {
          const matched = input.chats?.find(chat => chat.id === id);
          return [id, {
            id: input.nonNumericChatAlias === id ? 'oc_non_numeric' : id,
            name: matched?.name || (id === 'oc_group' ? '测试群' : ''),
            type: matched?.type ?? 2,
            chatMode: matched?.chatMode ?? 1,
            userCount: matched?.userCount ?? 2,
            memberCount: matched?.memberCount ?? 2,
            lastMessagePosition: matched?.lastMessagePosition ?? 10
          }];
        })),
        chatters: new Map(userIds.map(id => [id, {
          id,
          name: id === '42' ? '张三' : id,
          email: ''
        }]))
      };
    },
    async listChats() { return input.chats ?? []; },
    async history(chatId) {
      return (input.history ?? [])
        .filter(item => item.chatId === chatId)
        .map(item => ({ ...item, cid: '', atUserIds: [], atMe: false }));
    }
  };
  return { client, sent };
};

const buildApp = async (
  client: LarkProtocolClientLike = makeClient().client,
  options: { allowReactionTest?: boolean } = {}
) => {
  const store = new LarkAvatarStore(':memory:');
  stores.push(store);
  const service = new LarkAvatarService({
    databaseUrl: ':memory:',
    store,
    runtime: {
      async getSession() { return undefined; },
      async start() { return { id: 'ses_test' }; },
      async dispatch(id) { return { id, status: 'queued' }; }
    },
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    fetcher: fetcher as unknown as typeof fetch,
    clientFactory: () => client
  });
  const app = Fastify({ logger: false });
  registerLarkAvatarRoutes(app, service, options);
  return { app, service };
};

describe('Lark avatar routes', () => {
  it('returns status, config and empty lists', async () => {
    const { app } = await buildApp();
    const status = await app.inject({ method: 'GET', url: '/api/lark-avatar/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ configured: false, connected: false, counts: { inbox: 0, action: 0, pendingDrafts: 0 } });
    const inbox = await app.inject({ method: 'GET', url: '/api/lark-avatar/inbox' });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json()).toEqual([]);
    const drafts = await app.inject({ method: 'GET', url: '/api/lark-avatar/drafts' });
    expect(drafts.statusCode).toBe(200);
    expect(drafts.json()).toEqual([]);
    const chats = await app.inject({ method: 'GET', url: '/api/lark-avatar/chats' });
    expect(chats.statusCode).toBe(200);
    expect(chats.json()).toEqual([]);
  });

  it('validates draft creation', async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: 'POST', url: '/api/lark-avatar/drafts', payload: { target: '', body: '' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_DRAFT');
  });

  it('saves listening rules without returning cookies or app credentials', async () => {
    const { app } = await buildApp();
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: {
        region: 'feishu', triggerPrefix: '!ai', contextMessages: 6, listenChats: ['oc_1'],
        reactionTriggerEnabled: true, reactionTriggerEmoji: '👍', reactionTriggerRoute: 'main', reactionTriggerIgnoreBots: false,
        agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toMatchObject({
      region: 'feishu', triggerPrefix: '!ai', contextMessages: 6, listenChats: ['oc_1'],
      reactionTriggerEnabled: true, reactionTriggerEmoji: 'THUMBSUP', reactionTriggerRoute: 'main', reactionTriggerIgnoreBots: false,
      agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
    });
    expect(saved.body).not.toContain('appSecret');
    expect(saved.body).not.toContain('cookies');
  });

  it('preserves trae agentId and agent settings when updating topic configuration via PUT /api/lark-avatar/config', async () => {
    const { app } = await buildApp();
    const initial = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: {
        agentId: 'trae',
        model: 'glm-4',
        reasoningEffort: 'medium',
        workspace: '/tmp/trae-work',
        replyInTopic: true,
        replyMode: 'direct'
      }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().config.agentId).toBe('trae');

    const updatedTopic = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: {
        replyInTopic: false,
        replyMode: 'thread'
      }
    });
    expect(updatedTopic.statusCode).toBe(200);
    expect(updatedTopic.json().config).toMatchObject({
      agentId: 'trae',
      model: 'glm-4',
      reasoningEffort: 'medium',
      workspace: '/tmp/trae-work',
      replyInTopic: false,
      replyMode: 'thread'
    });

    const updatedWithBlankAgent = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: {
        replyMode: 'quote',
        agentId: ''
      }
    });
    expect(updatedWithBlankAgent.statusCode).toBe(200);
    expect(updatedWithBlankAgent.json().config).toMatchObject({
      agentId: 'trae',
      model: 'glm-4',
      reasoningEffort: 'medium',
      workspace: '/tmp/trae-work',
      replyInTopic: false,
      replyMode: 'quote'
    });

    const fetched = await app.inject({ method: 'GET', url: '/api/lark-avatar/config' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().config.agentId).toBe('trae');
  });

  it('rejects invalid reaction settings and lists recent reaction triggers', async () => {
    const { app } = await buildApp();
    const badEmoji = await app.inject({
      method: 'PUT', url: '/api/lark-avatar/config', payload: { reactionTriggerEmoji: '两个表情' }
    });
    expect(badEmoji.statusCode).toBe(400);
    expect(badEmoji.json().error.code).toBe('INVALID_REACTION_EMOJI');

    const badRoute = await app.inject({
      method: 'PUT', url: '/api/lark-avatar/config', payload: { reactionTriggerRoute: 'somewhere' }
    });
    expect(badRoute.statusCode).toBe(400);
    expect(badRoute.json().error.code).toBe('INVALID_REACTION_ROUTE');

    const triggers = await app.inject({ method: 'GET', url: '/api/lark-avatar/reaction-triggers' });
    expect(triggers.statusCode).toBe(200);
    expect(triggers.json()).toEqual([]);
  });

  it('gates fake reaction injection to sandboxes and exposes diagnostics', async () => {
    const { app } = await buildApp();
    const hidden = await app.inject({ method: 'POST', url: '/api/lark-avatar/reaction-test', payload: { messageId: 'om_1', emojiType: 'THUMBSUP' } });
    expect(hidden.statusCode).toBe(404);
    const diagnostics = await app.inject({ method: 'GET', url: '/api/lark-avatar/reaction-diagnostics' });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual({ triggers: [] });
  });

  it('injects a fake reaction, then resolves the ask card route', async () => {
    const { app, service } = await buildApp(makeClient().client, { allowReactionTest: true });
    await service.saveConfig({
      reactionTriggerEnabled: true,
      reactionTriggerEmoji: 'THUMBSUP',
      reactionTriggerRoute: 'ask',
      listening: true
    });
    const injected = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/reaction-test',
      payload: {
        messageId: 'om_fake', emojiType: 'THUMBSUP', operatorId: 'ou_me',
        operatorType: 'user', actionTime: '1000', chatId: 'oc_test', content: '把发布说明整理一下'
      }
    });
    expect(injected.statusCode).toBe(200);
    expect(injected.json()).toMatchObject({ ok: true, action: 'awaiting_route' });
    expect(injected.json().diagnostics.lastEvent).toMatchObject({ outcome: 'awaiting_route:ask', chatId: 'oc_test' });
    const trigger = injected.json().diagnostics.triggers[0];
    expect(trigger).toMatchObject({ state: 'awaiting_route', emoji: 'THUMBSUP', messageId: 'om_fake' });

    const routed = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/reaction-route-test',
      payload: { triggerId: trigger.key, route: 'independent', operatorId: 'ou_me' }
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json()).toMatchObject({ type: 'success', content: '已单独处理' });
    expect(routed.json().diagnostics.lastEvent).toMatchObject({ outcome: 'route:independent', sessionId: 'ses_test' });
  });

  it('validates and persists pause and resume requests', async () => {
    const { app } = await buildApp();
    const invalid = await app.inject({ method: 'PUT', url: '/api/lark-avatar/listening', payload: { enabled: 'yes' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_LISTENING_STATE');

    await app.inject({ method: 'PUT', url: '/api/lark-avatar/config', payload: { region: 'feishu' } });
    const paused = await app.inject({ method: 'PUT', url: '/api/lark-avatar/listening', payload: { enabled: false } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toEqual({ ok: true, listening: false });
    expect((await app.inject({ method: 'GET', url: '/api/lark-avatar/status' })).json()).toMatchObject({
      configured: false,
      connected: false,
      listening: false
    });

    const resumed = await app.inject({ method: 'PUT', url: '/api/lark-avatar/listening', payload: { enabled: true } });
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.code).toBe('LARK_NOT_CONNECTED');
  });

  it('starts a QR login and returns the QR content without credentials', async () => {
    const { app } = await buildApp();
    const started = await app.inject({ method: 'POST', url: '/api/lark-avatar/login/qr', payload: { region: 'feishu' } });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ state: 'waiting', region: 'feishu' });
    expect(started.json().qrContent).toContain('qr-token');
    const status = await app.inject({ method: 'GET', url: '/api/lark-avatar/login/status' });
    expect(status.json()).toMatchObject({ state: 'waiting', region: 'feishu' });
  });

  it('imports a cookie through the advanced fallback', async () => {
    const { app } = await buildApp();
    const imported = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/login/cookie',
      payload: { cookie: 'session=session-1; passport_web_did=device-1', region: 'feishu' }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ connected: true, account: { userId: '42' } });
    expect(imported.body).not.toContain('session-1');
  });

  describe('POST /api/lark-avatar/send', () => {
    const login = (app: Awaited<ReturnType<typeof buildApp>>['app']) => app.inject({
      method: 'POST',
      url: '/api/lark-avatar/login/cookie',
      payload: { cookie: 'session=session-1; passport_web_did=device-1', region: 'feishu' }
    });

    it('resolves chat, reply target and mentions, then sends through the web gateway', async () => {
      const fake = makeClient();
      const { app } = await buildApp(fake.client);
      const logged = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/login/cookie',
        payload: { cookie: 'session=abc; swp_csrf_token=csrf; passport_web_did=did', region: 'feishu' }
      });
      expect(logged.statusCode).toBe(200);

      const response = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '900001', text: '@张三 收到', replyTo: '555', at: ['42'] }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        messageId: 'om_sent',
        chatId: '900001',
        rootId: '555',
        mentions: [{ userId: '42', name: '张三' }]
      });
      expect(fake.sent).toEqual([{
        chatId: '900001',
        text: '@张三 收到',
        mentions: [{ userId: '42', content: '张三' }],
        rootId: '555',
        quote: true
      }]);
    });

    it('replies inside the thread when inThread is true', async () => {
      const fake = makeClient();
      const { app } = await buildApp(fake.client);
      const logged = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/login/cookie',
        payload: { cookie: 'session=abc; swp_csrf_token=csrf; passport_web_did=did', region: 'feishu' }
      });
      expect(logged.statusCode).toBe(200);

      const response = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '900001', text: '收到', replyTo: '555', inThread: true }
      });

      expect(response.statusCode).toBe(200);
      expect(fake.sent[0]).toEqual({ chatId: '900001', text: '收到', rootId: '555' });
    });

    it('accepts 19-digit chat, root and user ids as strings', async () => {
      const fake = makeClient();
      const { app } = await buildApp(fake.client);
      const logged = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/login/cookie',
        payload: { cookie: 'session=abc; swp_csrf_token=csrf; passport_web_did=did', region: 'feishu' }
      });
      expect(logged.statusCode).toBe(200);
      const chatId = '7246718914305097756';
      const rootId = '7246718914305097758';
      const userId = '7246718914305097757';

      const response = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: chatId, text: `@${userId} 收到`, replyTo: rootId, inThread: true, at: [userId] }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        messageId: 'om_sent',
        chatId,
        rootId,
        mentions: [{ userId, name: userId }]
      });
      expect(fake.sent[0]).toMatchObject({ chatId, rootId, mentions: [{ userId, content: userId }] });
    });

    it('maps empty body and malformed fields to 400 INVALID_INPUT', async () => {
      const { app } = await buildApp();
      const empty = await app.inject({ method: 'POST', url: '/api/lark-avatar/send', payload: { chat: '900001', text: '   ' } });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().error.code).toBe('INVALID_INPUT');

      const badAt = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '900001', text: 'hi', at: [42] }
      });
      expect(badAt.statusCode).toBe(400);
      expect(badAt.json().error.code).toBe('INVALID_INPUT');
    });

    it('maps missing login, missing chats, ambiguity and unmappable oc ids to 401/404/409/404', async () => {
      const loggedOut = await buildApp();
      const unauthorized = await loggedOut.app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '900001', text: 'hi' }
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json().error.code).toBe('NOT_LOGGED_IN');

      const missing = makeClient();
      const missingApp = await buildApp(missing.client);
      await login(missingApp.app);
      const notFound = await missingApp.app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '不存在的群', text: 'hi' }
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json().error.code).toBe('CHAT_NOT_FOUND');

      const ambiguous = makeClient({
        chats: [
          { id: 'oc_a', name: '同名群', type: 2, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 1, updateTime: 0 },
          { id: 'oc_b', name: '同名群', type: 2, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 1, updateTime: 0 }
        ]
      });
      const ambiguousApp = await buildApp(ambiguous.client);
      await login(ambiguousApp.app);
      const conflicted = await ambiguousApp.app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '同名群', text: 'hi' }
      });
      expect(conflicted.statusCode).toBe(409);
      expect(conflicted.json().error.code).toBe('CHAT_AMBIGUOUS');
      expect(conflicted.json().error.candidates).toHaveLength(2);

      const nonNumeric = makeClient({ nonNumericChatAlias: 'oc_alias' });
      const nonNumericApp = await buildApp(nonNumeric.client);
      await login(nonNumericApp.app);
      const invalid = await nonNumericApp.app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: 'oc_alias', text: 'hi' }
      });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.json().error.code).toBe('CHAT_NOT_FOUND');
      expect(invalid.json().error.hint).toContain('openChatId');
    });
  });

  it('persists retention config, exposes over-threshold status, supports unlimited inbox query and cleanup endpoint', async () => {
    const { app, service } = await buildApp();

    // 默认配置与状态
    const initial = await app.inject({ method: 'GET', url: '/api/lark-avatar/status' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().retention).toEqual({
      inboxMaxItems: 60,
      inboxCleanupWarnThreshold: 200,
      inboxCount: 0,
      shouldWarnCleanup: false
    });

    // 非法保留参数返回 400
    const badMax = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: { inboxMaxItems: -5 }
    });
    expect(badMax.statusCode).toBe(400);
    expect(badMax.json().error.code).toBe('INVALID_INBOX_MAX_ITEMS');

    const badThreshold = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: { inboxCleanupWarnThreshold: 1.5 }
    });
    expect(badThreshold.statusCode).toBe(400);
    expect(badThreshold.json().error.code).toBe('INVALID_CLEANUP_WARN_THRESHOLD');

    // 保存为 0 不限制、阈值 65
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: { inboxMaxItems: 0, inboxCleanupWarnThreshold: 65 }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toMatchObject({ inboxMaxItems: 0, inboxCleanupWarnThreshold: 65 });

    // 写入 75 条消息（超过旧硬编码 60 与新阈值 65）
    for (let index = 0; index < 75; index++) {
      service.store.upsertInbox({
        id: `item_route_${index}`,
        threadKey: 'lark:oc_group',
        messageId: `om_route_${index}`,
        chatId: 'oc_group',
        chatType: 'group',
        chatName: '测试群',
        senderId: '42',
        senderName: '张三',
        title: `群消息 ${index}`,
        tier: 'fyi',
        state: 'handled',
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        payload: {}
      });
    }

    const overStatus = await app.inject({ method: 'GET', url: '/api/lark-avatar/status' });
    expect(overStatus.json().retention).toEqual({
      inboxMaxItems: 0,
      inboxCleanupWarnThreshold: 65,
      inboxCount: 75,
      shouldWarnCleanup: true
    });

    const allInbox = await app.inject({ method: 'GET', url: '/api/lark-avatar/inbox' });
    expect(allInbox.json()).toHaveLength(75);
    const limitedInbox = await app.inject({ method: 'GET', url: '/api/lark-avatar/inbox?limit=10' });
    expect(limitedInbox.json()).toHaveLength(10);

    // 非法清理参数返回 400
    const badCleanup = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/inbox/cleanup',
      payload: { keepLatest: -1 }
    });
    expect(badCleanup.statusCode).toBe(400);
    expect(badCleanup.json().error.code).toBe('INVALID_CLEANUP_KEEP_LATEST');

    // 保留最近 20 条
    const trimmed = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/inbox/cleanup',
      payload: { keepLatest: 20 }
    });
    expect(trimmed.statusCode).toBe(200);
    expect(trimmed.json()).toEqual({ ok: true, deleted: 55, remaining: 20, keepLatest: 20 });

    const afterTrim = await app.inject({ method: 'GET', url: '/api/lark-avatar/status' });
    expect(afterTrim.json().retention).toMatchObject({ inboxCount: 20, shouldWarnCleanup: false });

    // 清空全部
    const cleared = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/inbox/cleanup',
      payload: { keepLatest: 0 }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ ok: true, deleted: 20, remaining: 0, keepLatest: 0 });
  });

  it('persists replyForwardMode (all / final_only / none), rejects invalid values, downgrades legacy private_chat and preserves saved agentId', async () => {
    const { app } = await buildApp();

    const initial = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: {
        agentId: 'trae',
        model: 'glm-4',
        inboxMaxItems: 120
      }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().config).toMatchObject({
      agentId: 'trae',
      model: 'glm-4',
      inboxMaxItems: 120,
      replyForwardMode: 'final_only'
    });

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: { replyForwardMode: 'streaming_invalid' }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('INVALID_REPLY_FORWARD_MODE');

    // 已下线的私密分析路由不再暴露，历史 private_chat 路由平滑降级为 main
    const removedPrivateRoute = await app.inject({
      method: 'POST',
      url: '/api/lark-avatar/private-analyze',
      payload: { chatId: 'oc_1' }
    });
    expect(removedPrivateRoute.statusCode).toBe(404);

    const legacyRoute = await app.inject({
      method: 'PUT',
      url: '/api/lark-avatar/config',
      payload: { reactionTriggerRoute: 'private_chat' }
    });
    expect(legacyRoute.statusCode).toBe(200);
    expect(legacyRoute.json().config.reactionTriggerRoute).toBe('main');

    for (const mode of ['final_only', 'none', 'all'] as const) {
      const updated = await app.inject({
        method: 'PUT',
        url: '/api/lark-avatar/config',
        payload: { replyForwardMode: mode }
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().config).toMatchObject({
        replyForwardMode: mode,
        agentId: 'trae',
        model: 'glm-4',
        inboxMaxItems: 120
      });

      const fetched = await app.inject({ method: 'GET', url: '/api/lark-avatar/config' });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().config.replyForwardMode).toBe(mode);
      expect(fetched.json().config.agentId).toBe('trae');
    }
  });
});

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

  describe('private group analysis and anti-leak safeguards', () => {
    it('persists privateReplyChatId and reactionTriggerIntent and validates invalid intent', async () => {
      const { app } = await buildApp();
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/lark-avatar/config',
        payload: {
          reactionTriggerRoute: 'private_chat',
          reactionTriggerIntent: 'summary',
          privateReplyChatId: 'oc_my_private_notes'
        }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().config).toMatchObject({
        reactionTriggerRoute: 'private_chat',
        reactionTriggerIntent: 'summary',
        privateReplyChatId: 'oc_my_private_notes'
      });

      const badIntent = await app.inject({
        method: 'PUT',
        url: '/api/lark-avatar/config',
        payload: { reactionTriggerIntent: 'leak_to_group' }
      });
      expect(badIntent.statusCode).toBe(400);
      expect(badIntent.json().error.code).toBe('INVALID_REACTION_INTENT');
    });

    it('analyzes a group privately without sending anything to the target group and blocks same-chat forwarding', async () => {
      const fake = makeClient({
        chats: [
          { id: '7001', openChatId: 'oc_boss_group', name: '老板核心群', type: 2, chatMode: 1, userCount: 8, memberCount: 8, lastMessagePosition: 2, updateTime: 0 },
          { id: '7002', openChatId: 'oc_my_self', name: '我自己的私聊', type: 1, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 1, updateTime: 0 }
        ],
        history: [{
          messageId: 'm_boss_1',
          chatId: '7001',
          fromId: 'u_boss',
          type: 4,
          chatType: 2,
          content: '周五前把重构方案发出来',
          createTime: 1_700_000_000_000,
          position: 2,
          rootId: '',
          parentId: '',
          threadId: '',
          raw: {}
        }]
      });
      const { app } = await buildApp(fake.client);
      const logged = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/login/cookie',
        payload: { cookie: 'session=abc; swp_csrf_token=csrf; passport_web_did=did', region: 'feishu' }
      });
      expect(logged.statusCode).toBe(200);

      // 1. 独立会话私密分析：不发任何消息到老板群
      const independent = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/private-analyze',
        payload: { chatId: '7001', mode: 'summary', delivery: 'independent', contextMessages: 20 }
      });
      expect(independent.statusCode).toBe(200);
      expect(independent.json()).toMatchObject({
        ok: true,
        delivery: 'independent',
        mode: 'summary',
        chatId: '7001',
        chatName: '老板核心群',
        contextCount: 1,
        sessionId: 'ses_test'
      });
      expect(fake.sent).toHaveLength(0);

      // 2. 自定义模式缺少 prompt 返回 400
      const missingPrompt = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/private-analyze',
        payload: { chatId: '7001', mode: 'custom', delivery: 'independent' }
      });
      expect(missingPrompt.statusCode).toBe(400);
      expect(missingPrompt.json().error.code).toBe('INVALID_INPUT');

      // 3. 私密转发未配置目标会话时拦截
      const noTarget = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/private-analyze',
        payload: { chatId: '7001', mode: 'analyze', delivery: 'private_chat' }
      });
      expect(noTarget.statusCode).toBe(400);
      expect(noTarget.json().error.code).toBe('PRIVATE_CHAT_NOT_CONFIGURED');

      // 4. 私密转发目标与原群相同时拦截防泄密
      await app.inject({
        method: 'PUT',
        url: '/api/lark-avatar/config',
        payload: { privateReplyChatId: '7001' }
      });
      const sameTarget = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/private-analyze',
        payload: { chatId: '7001', mode: 'analyze', delivery: 'private_chat' }
      });
      expect(sameTarget.statusCode).toBe(400);
      expect(sameTarget.json().error.code).toBe('PRIVATE_CHAT_SAME_AS_TARGET');
      expect(fake.sent).toHaveLength(0);

      // 5. 配置合法私密接收会话后，只允许向私密接收会话转发，绝不发到老板群
      await app.inject({
        method: 'PUT',
        url: '/api/lark-avatar/config',
        payload: { privateReplyChatId: '7002' }
      });
      const forwarded = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/private-analyze',
        payload: { chatId: '7001', mode: 'analyze', delivery: 'private_chat' }
      });
      expect(forwarded.statusCode).toBe(200);
      expect(forwarded.json()).toMatchObject({
        ok: true,
        delivery: 'private_chat',
        chatId: '7001',
        targetChatId: '7002'
      });
      expect(fake.sent.every(item => item.chatId !== '7001')).toBe(true);
    });
  });
});

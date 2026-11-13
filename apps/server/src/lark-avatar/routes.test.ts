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
        chats: new Map(chatIds.map(id => [id, {
          id: input.nonNumericChatAlias === id ? 'oc_non_numeric' : id,
          name: id === 'oc_group' ? '测试群' : '',
          type: 2,
          chatMode: 1,
          userCount: 2,
          memberCount: 2,
          lastMessagePosition: 10
        }])),
        chatters: new Map(userIds.map(id => [id, {
          id,
          name: id === '42' ? '张三' : id,
          email: ''
        }]))
      };
    },
    async listChats() { return input.chats ?? []; }
  };
  return { client, sent };
};

const buildApp = async (client: LarkProtocolClientLike = makeClient().client) => {
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
  registerLarkAvatarRoutes(app, service);
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
        agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toMatchObject({
      region: 'feishu', triggerPrefix: '!ai', contextMessages: 6, listenChats: ['oc_1'],
      agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
    });
    expect(saved.body).not.toContain('appSecret');
    expect(saved.body).not.toContain('cookies');
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
      await login(app);

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
        rootId: 555,
        mentions: [{ userId: 42, name: '张三' }]
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
      await login(app);

      const response = await app.inject({
        method: 'POST',
        url: '/api/lark-avatar/send',
        payload: { chat: '900001', text: '收到', replyTo: '555', inThread: true }
      });

      expect(response.statusCode).toBe(200);
      expect(fake.sent[0]).toEqual({ chatId: '900001', text: '收到', rootId: '555' });
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

    it('maps missing login, missing chats, ambiguity and non-numeric ids to 401/404/409/400', async () => {
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
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('ID_NOT_NUMERIC');
    });
  });
});

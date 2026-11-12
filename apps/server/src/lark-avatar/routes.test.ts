import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerLarkAvatarRoutes } from './routes.js';
import { LarkAvatarService } from './service.js';
import { LarkAvatarStore } from './store.js';
import type { LarkProtocolClientLike } from './protocol/client.js';

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

const client: LarkProtocolClientLike = {
  start(handlers) { handlers.onStatus({ state: 'connected' }); },
  stop() {},
  reconnect() {},
  async sendText() { return { messageId: 'om_sent' }; }
};

const buildApp = async () => {
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
});

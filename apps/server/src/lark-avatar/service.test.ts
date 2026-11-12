import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/agent-dock-shared';
import { LarkAvatarService, type LarkAvatarRuntime } from './service.js';
import { LarkAvatarStore } from './store.js';
import type { LarkProtocolClientHandlers, LarkProtocolClientLike } from './protocol/client.js';
import type { LarkIncomingMessage } from './protocol/proto.js';

const stores: LarkAvatarStore[] = [];
const services: LarkAvatarService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
});

const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const authFetcher = () => vi.fn<typeof fetch>().mockImplementation(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/suite/passport/frontier_ticket/')) return json({ ticket: 'ticket-1' });
  if (url.includes('/accounts/web/user')) {
    return json({ data: { user: { id: 42, name: '测试用户', avatar_url: 'https://example.com/me.png', email: 'test@example.com' } } });
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

const message = (input: Partial<LarkIncomingMessage> = {}): LarkIncomingMessage => ({
  messageId: 'om_1',
  type: 4,
  fromId: '100',
  chatId: 'oc_chat',
  chatType: 1,
  createTime: 1_767_225_600,
  content: '你好',
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

const fakeRuntime = () => {
  const sessions = new Map<string, { id: string }>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  const dispatched: Array<{ sessionId: string; prompt: string; agentPrompt?: string }> = [];
  const started: Array<{ agentId: string; cwd?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; systemPrompt?: string }> = [];
  let sequence = 0;
  const emit = (sessionId: string, type: AgentEvent['type'], data: unknown) => {
    const event: AgentEvent = {
      id: `evt_${++sequence}`,
      sessionId,
      sequence,
      type,
      timestamp: new Date().toISOString(),
      data
    };
    for (const listener of listeners.get(sessionId) ?? []) listener(event);
  };
  const runtime: LarkAvatarRuntime = {
    async getSession(id) { return sessions.get(id); },
    async start(input) {
      started.push(input);
      const session = { id: `ses_${started.length}` };
      sessions.set(session.id, session);
      return session;
    },
    async dispatch(id, prompt, _mode, agentPrompt) {
      const taskId = `task_${++sequence}`;
      dispatched.push({ sessionId: id, prompt, ...(agentPrompt ? { agentPrompt } : {}) });
      queueMicrotask(() => {
        emit(id, 'task', { task: { id: taskId, status: 'running' } });
        emit(id, 'text', { text: '第一段' });
        emit(id, 'text', { text: '，第二段' });
        emit(id, 'task', { task: { id: taskId, status: 'completed' } });
      });
      return { id: taskId, status: 'queued' };
    },
    subscribe(id, listener) {
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      return () => set.delete(listener);
    },
    async getTasks() { return []; }
  };
  return { runtime, dispatched, started };
};

const fakeClient = () => {
  let handlers: LarkProtocolClientHandlers | undefined;
  const sent: Array<{ chatId: string; text: string; rootId?: string; quote?: boolean; threadChat?: boolean }> = [];
  const reacted: Array<{ messageId: string; type: string }> = [];
  const historyMessages: LarkIncomingMessage[] = [];
  const historyCalls: Array<{ chatId: string; beforePosition: number; limit: number }> = [];
  const synced: Array<{ sinceMs: number; backfill?: boolean }> = [];
  const availableChats = [
    { id: 'oc_group', name: '测试群', type: 2, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 10, avatarUrl: 'https://example.com/chat.png', updateTime: Date.parse('2026-01-01T00:00:00.000Z') },
    { id: 'oc_chat', name: '小肥鱼', type: 1, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 5, avatarUrl: 'https://example.com/dm.png', updateTime: Date.parse('2025-12-31T00:00:00.000Z') }
  ];
  const client: LarkProtocolClientLike = {
    start(next) {
      handlers = next;
      next.onStatus({ state: 'connected' });
    },
    stop() {},
    reconnect() {},
    async sendText(input) {
      sent.push(input);
      return { messageId: `om_sent_${sent.length}` };
    },
    async react(messageId, type) {
      reacted.push({ messageId, type });
    },
    async lookup(chatIds, userIds) {
      return {
        chats: new Map(chatIds.map(id => [id, {
          id,
          name: id === 'oc_group' ? '测试群' : '',
          type: id === 'oc_group' ? 2 : 1,
          chatMode: 1,
          userCount: 2,
          memberCount: 2,
          lastMessagePosition: 10,
          avatarUrl: 'https://example.com/chat.png'
        }])),
        chatters: new Map(userIds.map(id => [id, {
          id,
          name: id === '42' ? '我' : '小肥鱼',
          avatarUrl: `https://example.com/${id}.png`,
          email: ''
        }]))
      };
    },
    async history(chatId, beforePosition, limit) {
      historyCalls.push({ chatId, beforePosition, limit });
      return [...historyMessages];
    },
    async listChats() { return availableChats; },
    async syncRecent(sinceMs, options) {
      synced.push({ sinceMs, ...(options?.backfill !== undefined ? { backfill: options.backfill } : {}) });
      return 0;
    }
  };
  return {
    client,
    sent,
    reacted,
    historyMessages,
    historyCalls,
    synced,
    availableChats,
    async emit(input: Partial<LarkIncomingMessage>, meta?: { backfill?: boolean }) {
      await handlers?.onMessage(message(input), meta);
    }
  };
};

const createService = (input: {
  fetcher?: typeof fetch;
  client?: LarkProtocolClientLike;
  runtime?: LarkAvatarRuntime;
  llm?: { run(input: { prompt: string }): Promise<{ text: string }> };
  existingStore?: LarkAvatarStore;
} = {}) => {
  const store = input.existingStore ?? new LarkAvatarStore(':memory:');
  if (!input.existingStore) stores.push(store);
  const service = new LarkAvatarService({
    databaseUrl: ':memory:',
    runtime: input.runtime ?? fakeRuntime().runtime,
    store,
    fetcher: input.fetcher ?? authFetcher() as unknown as typeof fetch,
    clientFactory: () => input.client ?? fakeClient().client,
    clock: () => new Date('2026-01-01T00:00:00.000Z'),
    llm: input.llm
  });
  services.push(service);
  return service;
};

describe('Lark avatar service', () => {
  it('saves trigger rules without exposing credentials', async () => {
    const service = createService();
    await service.saveConfig({
      region: 'feishu', triggerPrefix: '!ai', contextMessages: 6,
      contextScope: 'chat', replyInTopic: false, replyMode: 'quote',
      emojiReactions: true, replySignature: '—— AI 替身', agentTimeoutSeconds: 900,
      listenChats: ['oc_1'],
      agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
    });
    expect(service.status()).toMatchObject({ configured: false, connected: false, listenChats: ['oc_1'] });
    expect(service.publicState()?.config).toMatchObject({
      region: 'feishu', triggerPrefix: '!ai', contextMessages: 6,
      contextScope: 'chat', replyInTopic: false, replyMode: 'quote',
      emojiReactions: true, replySignature: '—— AI 替身', agentTimeoutSeconds: 900,
      listenChats: ['oc_1'],
      agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
    });
    expect(JSON.stringify(service.publicState())).not.toContain('session');
  });

  it('defaults emoji reactions off and keeps the saved value across updates', async () => {
    const service = createService();
    await service.saveConfig({});
    expect(service.publicState()?.config.emojiReactions).toBe(false);

    await service.saveConfig({ emojiReactions: true });
    await service.saveConfig({ triggerPrefix: '!ai' });
    expect(service.publicState()?.config).toMatchObject({ emojiReactions: true, triggerPrefix: '!ai' });
  });

  it('completes QR login, stores cookies locally and starts the protocol client', async () => {
    const fake = fakeClient();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/accounts/qrlogin/init')) {
        return json({ code: 0, data: { step_info: { token: 'qr-token' } } }, { 'x-flow-key': 'flow-1' });
      }
      if (url.includes('/accounts/qrlogin/polling')) {
        return json(
          { code: 0, data: { next_step: 'qr_login_success', step_info: { status: 0 } } },
          { 'set-cookie': 'session=session-1; Path=/; HttpOnly' }
        );
      }
      return authFetcher()(input);
    });
    const service = createService({ fetcher: fetcher as unknown as typeof fetch, client: fake.client });

    const started = await service.startQrLogin('feishu');
    expect(started).toMatchObject({ state: 'waiting', region: 'feishu' });
    expect(started.qrContent).toContain('qr-token');

    const completed = await service.pollQrLogin();
    expect(completed.state).toBe('success');
    expect(service.status()).toMatchObject({
      configured: true,
      connected: true,
      account: { userId: '42', name: '测试用户' }
    });
    expect(service.store.getCredentials()).toMatchObject({
      region: 'feishu',
      userId: '42',
      appKey: 'app-key',
      cookies: { session: 'session-1' }
    });
    expect(JSON.stringify(service.publicState())).not.toContain('session-1');
    expect(JSON.stringify(service.status())).not.toContain('app-key');
  });

  it('persists credentials across a service restart', async () => {
    const store = new LarkAvatarStore(':memory:');
    stores.push(store);
    const service = createService({ existingStore: store, client: fakeClient().client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1', 'feishu');
    const restarted = createService({ existingStore: store, client: fakeClient().client });
    expect(restarted.status()).toMatchObject({ configured: true, connected: true, account: { userId: '42' } });
    restarted.start();
  });

  it('lists recent Feishu chats so the UI does not require Chat IDs', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await expect(service.availableChats()).resolves.toMatchObject([
      { id: 'oc_group', name: '测试群', type: 'group', avatarUrl: 'https://example.com/chat.png' },
      { id: 'oc_chat', name: '小肥鱼', type: 'p2p' }
    ]);
  });

  it('rewrites legacy pstatp group avatars to the Feishu CDN', async () => {
    const service = createService();
    service.store.upsertInbox({
      id: 'item_legacy_avatar',
      threadKey: 'lark:oc_legacy',
      messageId: 'om_legacy_avatar',
      chatId: 'oc_legacy',
      chatType: 'group',
      chatName: '历史群',
      chatAvatarUrl: 'https://p2.pstatp.com/origin/default-avatar_v3_0074_abc',
      senderId: '100',
      senderName: '小肥鱼',
      senderAvatarUrl: 'https://p1.pstatp.com/origin/v3_0016s_avatar',
      title: '历史消息',
      tier: 'fyi',
      state: 'handled',
      occurredAt: '2026-01-01T00:00:00.000Z',
      receivedAt: '2026-01-01T00:00:00.000Z',
      payload: {}
    });

    const expected = (key: string) => `https://s1-imfile.feishucdn.com/static-resource/v1/${key}~?image_size=noop&cut_type=&quality=&format=image&sticker_format=.webp`;
    expect(service.inbox()[0]).toMatchObject({
      chatAvatarUrl: expected('default-avatar_v3_0074_abc'),
      senderAvatarUrl: expected('v3_0016s_avatar')
    });
    expect((await service.availableChats())).toContainEqual(expect.objectContaining({
      id: 'oc_legacy',
      avatarUrl: expected('default-avatar_v3_0074_abc')
    }));
  });

  it('stores non-trigger messages as context without starting an agent turn', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({ messageId: 'om_plain', fromId: '100', chatId: 'oc_chat', content: '普通消息' });

    await vi.waitFor(() => expect(service.inbox()).toHaveLength(1));
    expect(service.inbox()[0]).toMatchObject({ state: 'handled', senderName: '小肥鱼', senderAvatarUrl: 'https://example.com/100.png' });
    expect(fake.sent).toHaveLength(0);
  });

  it('stores the user’s own normal messages while filtering only Agent replies', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({ messageId: 'om_self_plain', fromId: '42', chatId: 'oc_chat', content: '我在群里发的普通消息' });

    await vi.waitFor(() => expect(service.inbox()).toHaveLength(1));
    expect(service.inbox()[0]).toMatchObject({
      messageId: 'om_self_plain',
      senderId: '42',
      title: '我在群里发的普通消息',
      state: 'handled'
    });
    expect(fake.sent).toHaveLength(0);
  });

  it('never triggers from another member, even when they send the trigger prefix', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({ messageId: 'om_other_ai', fromId: '100', chatId: 'oc_group', chatType: 2, content: '/ai 代替我执行' });

    await vi.waitFor(() => expect(service.inbox()).toHaveLength(1));
    expect(service.inbox()[0]).toMatchObject({ messageId: 'om_other_ai', senderId: '100', state: 'handled' });
    expect(runtime.dispatched).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
  });

  it('triggers an agent from a self /ai message and sends every AgentText chunk back', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    const trigger = message({ messageId: 'om_ai', fromId: '42', chatId: 'oc_chat', position: 5, content: '/ai 帮我看看这个' });
    fake.historyMessages.push(
      message({ messageId: 'om_prev', fromId: '100', chatId: 'oc_chat', position: 4, content: '之前的消息' }),
      trigger
    );

    await fake.emit(trigger);

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_chat', text: '第一段，第二段' });
    expect(runtime.dispatched[0]).toMatchObject({ prompt: '帮我看看这个' });
    expect(runtime.dispatched[0]?.agentPrompt).toContain('之前的消息');
    expect(runtime.dispatched[0]?.agentPrompt).toContain('[用户请求]');
    await vi.waitFor(() => expect(service.inbox()[0]?.state).toBe('handled'));
    expect(service.inbox()[0]).toMatchObject({
      chatAvatarUrl: 'https://example.com/chat.png',
      senderAvatarUrl: 'https://example.com/42.png'
    });
    expect(service.drafts('sent')).toMatchObject([{
      body: '第一段，第二段',
      state: 'sent',
      sentMessageId: 'om_sent_1',
      target: 'oc_chat'
    }]);
  });

  it('adds 2–3 distinct random reactions to the trigger message when enabled', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ emojiReactions: true });

    await fake.emit({ messageId: 'om_react', fromId: '42', chatId: 'oc_chat', content: '/ai 反应一下' });

    await vi.waitFor(() => expect(fake.reacted.length).toBeGreaterThanOrEqual(2));
    expect(fake.reacted.length).toBeLessThanOrEqual(3);
    expect(fake.reacted.every(item => item.messageId === 'om_react')).toBe(true);
    expect(new Set(fake.reacted.map(item => item.type)).size).toBe(fake.reacted.length);
  });

  it('does not add reactions when the toggle is off', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({ messageId: 'om_no_react', fromId: '42', chatId: 'oc_chat', content: '/ai 不要表情' });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.reacted).toEqual([]);
  });

  it('uses the configured trigger prefix', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ triggerPrefix: '!ai' });

    await fake.emit({ messageId: 'om_old_prefix', fromId: '42', chatId: 'oc_chat', position: 1, content: '/ai 不触发' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.sent).toHaveLength(0);

    await fake.emit({ messageId: 'om_new_prefix', fromId: '42', chatId: 'oc_chat', position: 2, content: '!ai 你好' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
  });

  it('starts the configured Agent with model, reasoning effort and workspace', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({
      agentId: 'claude', model: 'opus', reasoningEffort: 'high', workspace: '/tmp/avatar-work'
    });

    await fake.emit({ messageId: 'om_configured_agent', fromId: '42', chatId: 'oc_chat', content: '/ai 你好' });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(runtime.started.at(-1)).toMatchObject({
      agentId: 'claude',
      cwd: '/tmp/avatar-work',
      model: 'opus',
      reasoningEffort: 'high',
      source: 'lark-avatar'
    });
  });

  it('uses effective text context from the triggering chat only', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    const trigger = message({
      messageId: 'om_context_ai', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 10, content: '/ai 总结一下'
    });
    fake.historyMessages.push(
      message({ messageId: 'om_context_text_1', fromId: '100', chatId: 'oc_group', chatType: 2, position: 6, content: '有效上下文一' }),
      message({ messageId: 'om_context_image', type: 5, fromId: '100', chatId: 'oc_group', chatType: 2, position: 7, content: '[图片]' }),
      message({ messageId: 'om_context_card', type: 14, fromId: '100', chatId: 'oc_group', chatType: 2, position: 8, content: '[卡片]' }),
      message({ messageId: 'om_context_text_2', fromId: '100', chatId: 'oc_group', chatType: 2, position: 9, content: '有效上下文二' }),
      trigger
    );

    await fake.emit(trigger);

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const prompt = runtime.dispatched[0]?.agentPrompt ?? '';
    expect(prompt).toContain('有效上下文一');
    expect(prompt).toContain('有效上下文二');
    expect(prompt).not.toContain('[图片]');
    expect(prompt).not.toContain('[卡片]');
    expect(fake.historyCalls.at(-1)).toMatchObject({ chatId: 'oc_group', beforePosition: 10, limit: 30 });
  });

  it('caps the injected transcript at the configured count, including the trigger message', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ contextMessages: 2 });
    const trigger = message({
      messageId: 'om_cap_ai', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 5, content: '/ai 只看最近两条'
    });
    fake.historyMessages.push(
      message({ messageId: 'om_cap_1', fromId: '100', chatId: 'oc_group', chatType: 2, position: 1, content: '第一条' }),
      message({ messageId: 'om_cap_2', fromId: '100', chatId: 'oc_group', chatType: 2, position: 2, content: '第二条' }),
      message({ messageId: 'om_cap_3', fromId: '100', chatId: 'oc_group', chatType: 2, position: 3, content: '第三条' }),
      message({ messageId: 'om_cap_4', fromId: '100', chatId: 'oc_group', chatType: 2, position: 4, content: '第四条' }),
      trigger
    );

    await fake.emit(trigger);

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const prompt = runtime.dispatched[0]?.agentPrompt ?? '';
    expect(prompt).toContain('最近 2 条文字消息');
    expect(prompt).toContain('第四条');
    expect(prompt).toContain('只看最近两条');
    expect(prompt).not.toContain('第一条');
    expect(prompt).not.toContain('第三条');
    expect(fake.historyCalls.at(-1)).toMatchObject({ chatId: 'oc_group', beforePosition: 5, limit: 6 });
  });

  it('tells the agent which Feishu chat it is replying in', async () => {
    const fake = fakeClient();
    const runtime = fakeRuntime();
    const service = createService({ client: fake.client, runtime: runtime.runtime });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    const trigger = message({
      messageId: 'om_group_identity', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 10, content: '/ai 这是哪个群'
    });

    await fake.emit(trigger);

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const prompt = runtime.dispatched[0]?.agentPrompt ?? '';
    expect(prompt).toContain('[当前飞书会话]');
    expect(prompt).toContain('名称：测试群');
    expect(prompt).toContain('类型：群聊');
    expect(prompt).toContain('Chat ID：oc_group');
    expect(runtime.started.at(-1)?.systemPrompt).toContain('飞书群聊「测试群」');
    expect(runtime.started.at(-1)?.systemPrompt).toContain('会话 Chat ID：oc_group');
  });

  it('syncs recent messages on connect and exposes manual sync', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await vi.waitFor(() => expect(fake.synced.some(item => item.backfill === true)).toBe(true));
    await vi.waitFor(() => expect(service.status().lastSyncedAt).toBe('2026-01-01T00:00:00.000Z'));
    const before = fake.synced.length;
    await service.pollNow();

    expect(fake.synced.length).toBeGreaterThan(before);
    expect(fake.synced.at(-1)).toMatchObject({ backfill: false });
    expect(service.status()).toMatchObject({ syncIntervalSeconds: 30, lastSyncedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('pauses and resumes listening without clearing credentials', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    expect(service.setListening(false)).toEqual({ ok: true, listening: false });
    expect(service.status()).toMatchObject({
      configured: true,
      connected: false,
      listening: false
    });
    expect(service.store.getCredentials()).toBeDefined();
    await expect(service.pollNow()).rejects.toMatchObject({
      code: 'LARK_LISTENING_PAUSED',
      statusCode: 409
    });

    await fake.emit({ messageId: 'om_paused', fromId: '42', chatId: 'oc_chat', content: '/ai 暂停时不应触发' });
    expect(service.inbox()).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);

    expect(service.setListening(true)).toEqual({ ok: true, listening: true });
    await vi.waitFor(() => expect(service.status()).toMatchObject({ connected: true, listening: true }));
    await fake.emit({ messageId: 'om_resumed', fromId: '42', chatId: 'oc_chat', content: '/ai 恢复后触发' });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
  });

  it('replies into the topic root for topic-group triggers', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({
      messageId: 'om_topic', fromId: '42', chatId: 'oc_topic', chatType: 3,
      rootId: 'om_root', position: 2, content: '/ai 话题里回复'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_topic', text: '第一段，第二段', rootId: 'om_root', threadChat: true });
  });

  it('can send topic messages to the main session instead', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ replyInTopic: false });

    await fake.emit({
      messageId: 'om_topic_main', fromId: '42', chatId: 'oc_topic', chatType: 3,
      rootId: 'om_root', position: 2, content: '/ai 发到主会话'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_topic', text: '第一段，第二段' });
    expect(fake.sent[0]?.rootId).toBeUndefined();
  });

  it('supports quote replies for main-session messages', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ replyMode: 'quote' });

    await fake.emit({
      messageId: 'om_quote', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 3, content: '/ai 引用回复'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_group', rootId: 'om_quote', quote: true });
    expect(fake.sent[0]?.threadChat).toBeUndefined();
  });

  it('supports starting a topic from a main-session message', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ replyMode: 'thread' });

    await fake.emit({
      messageId: 'om_thread', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 4, content: '/ai 开话题'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_group', rootId: 'om_thread' });
    expect(fake.sent[0]?.quote).toBeUndefined();
    expect(fake.sent[0]?.threadChat).toBeUndefined();
  });

  it('falls back to a quote in private chats when topic mode is selected', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ replyMode: 'thread' });

    await fake.emit({
      messageId: 'om_p2p_thread', fromId: '42', chatId: 'oc_chat', chatType: 1,
      position: 6, content: '/ai 私聊开话题'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]).toMatchObject({ chatId: 'oc_chat', rootId: 'om_p2p_thread', quote: true });
  });

  it('appends the configured reply signature to Agent messages', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    await service.saveConfig({ replySignature: '—— AI 替身' });

    await fake.emit({
      messageId: 'om_signature', fromId: '42', chatId: 'oc_group', chatType: 2,
      position: 5, content: '/ai 加署名'
    });

    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    expect(fake.sent[0]?.text).toBe('第一段，第二段\n\n—— AI 替身');
  });

  it('never triggers from backfilled history', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');

    await fake.emit({ messageId: 'om_history', fromId: '42', chatId: 'oc_chat', content: '/ai 历史消息' }, { backfill: true });

    await vi.waitFor(() => expect(service.inbox()).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(service.inbox()[0]).toMatchObject({ messageId: 'om_history', state: 'handled' });
    expect(fake.sent).toHaveLength(0);
  });

  it('sends a confirmed manual draft through the protocol gateway', async () => {
    const fake = fakeClient();
    const service = createService({ client: fake.client });
    await service.connectWithCookie('session=session-1; passport_web_did=device-1');
    const draft = await service.createDraft({ target: 'oc_chat', body: '确认发送' });
    const sent = await service.sendDraft(draft.id);
    expect(sent).toMatchObject({ state: 'sent', sentMessageId: 'om_sent_1' });
    expect(fake.sent).toEqual([{ chatId: 'oc_chat', text: '确认发送' }]);
  });
});

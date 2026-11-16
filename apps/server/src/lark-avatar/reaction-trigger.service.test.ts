import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkAvatarService, type LarkAvatarMainSession, type LarkAvatarRuntime, type LarkReactionPort } from './service.js';
import { LarkAvatarStore } from './store.js';
import type { LarkAvatarConfig, LarkAvatarCredentials } from './types.js';
import type { LarkProtocolClientHandlers, LarkProtocolClientLike } from './protocol/client.js';
import type { LarkIncomingMessage } from './protocol/proto.js';

const stores: LarkAvatarStore[] = [];
const services: LarkAvatarService[] = [];
const now = () => new Date('2026-01-01T00:00:00.000Z');

afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
});

const baseConfig = (overrides: Partial<LarkAvatarConfig> = {}): LarkAvatarConfig => ({
  region: 'feishu',
  triggerPrefix: '/ai',
  contextMessages: 10,
  contextScope: 'anchor',
  replyInTopic: true,
  replyMode: 'direct',
  emojiReactions: false,
  reactionTriggerEnabled: true,
  reactionTriggerEmoji: 'THUMBSUP',
  reactionTriggerRoute: 'main',
  reactionTriggerIgnoreBots: true,
  replySignature: '',
  agentTimeoutSeconds: 0,
  listening: true,
  listenChats: [],
  allowedSenders: [],
  agentId: 'codex',
  model: '',
  reasoningEffort: '',
  workspace: '/tmp/avatar-work',
  ...overrides
});

const message = {
  messageId: 'om_target',
  chatId: 'oc_chat',
  chatName: '测试群',
  chatType: 'group',
  senderId: 'ou_alice',
  senderName: '张三',
  content: '把发布说明整理一下',
  messageType: 'text',
  createTime: '1767225600000'
};

const credentials: LarkAvatarCredentials = {
  region: 'feishu',
  cookies: { session: 'session-1' },
  savedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  deviceId: 'device-1',
  appKey: 'app-key',
  userId: '42',
  csrfToken: 'csrf',
  webAppId: 'web-app'
};

const fakeClient = () => {
  let handlers: LarkProtocolClientHandlers | undefined;
  const reacted: Array<{ messageId: string; type: string }> = [];
  const sent: Array<{ chatId: string; text: string }> = [];
  /** 模拟「reaction 事件先于 HTTP 响应到达」：react() 挂起直到 release。 */
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;
  let reactResult: { count: number } = { count: 1 };
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
      if (gate) await gate;
      return reactResult;
    },
    async lookup(chatIds, userIds) {
      return {
        chats: new Map(chatIds.map(id => [id, { id, name: '测试群', type: 2, chatMode: 1, userCount: 2, memberCount: 2, lastMessagePosition: 10 }])),
        chatters: new Map(userIds.map(id => [id, { id, name: id === '42' ? '我' : '张三', avatarUrl: '', email: '' }]))
      };
    },
    async history() { return []; },
    async listChats() { return []; },
    async syncRecent() { return 0; }
  };
  return {
    client,
    reacted,
    sent,
    holdReactions() {
      gate = new Promise<void>(resolve => { openGate = resolve; });
    },
    releaseReactions() {
      openGate?.();
      gate = undefined;
      openGate = undefined;
    },
    setReactionResult(result: { count: number }) { reactResult = result; },
    async emit(input: Partial<LarkIncomingMessage>) {
      await handlers?.onMessage({
        messageId: 'om_1',
        type: 4,
        fromId: '42',
        chatId: 'oc_chat',
        chatType: 2,
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
      }, { backfill: false });
    }
  };
};

const harness = (input: {
  config?: Partial<LarkAvatarConfig>;
  mainSessionId?: string;
  withCredentials?: boolean;
} = {}) => {
  const store = new LarkAvatarStore(':memory:');
  stores.push(store);
  store.saveState({
    id: 'avatar_1',
    config: baseConfig(input.config),
    ...(input.withCredentials ? { account: { userId: '42', name: '测试用户' } } : {}),
    state: 'connected',
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  });
  if (input.withCredentials) store.saveCredentials(credentials);

  const started: Array<{ source?: string; sourceId?: string; systemPrompt?: string }> = [];
  const dispatched: Array<{ sessionId: string; prompt: string; agentPrompt?: string; origin?: string; clientMessageId?: string }> = [];
  const sessions: Array<{ id: string; source?: string; sourceId?: string }> = [];
  let sequence = 0;
  const runtime: LarkAvatarRuntime = {
    async getSession(id) { return sessions.find(session => session.id === id); },
    async listSessions() { return sessions; },
    async start(options) {
      started.push(options);
      const session = { id: `ses_${sessions.length + 1}`, ...(options.source ? { source: options.source } : {}), ...(options.sourceId ? { sourceId: options.sourceId } : {}) };
      sessions.push(session);
      return session;
    },
    async dispatch(id, prompt, _mode, agentPrompt, _risk, origin, clientMessageId) {
      dispatched.push({
        sessionId: id,
        prompt,
        ...(agentPrompt ? { agentPrompt } : {}),
        ...(origin ? { origin } : {}),
        ...(clientMessageId ? { clientMessageId } : {})
      });
      return { id: `task_${++sequence}`, status: 'queued' };
    },
    async send() { return { finalText: null }; }
  };
  const mainDispatches: Array<{ prompt: string; agentPrompt: string; origin?: string; clientMessageId?: string }> = [];
  const mainSession: LarkAvatarMainSession = {
    id: () => input.mainSessionId,
    async dispatch(request) {
      mainDispatches.push(request);
      return { id: `task_main_${mainDispatches.length}`, status: 'queued' };
    }
  };
  const client = fakeClient();
  const service = new LarkAvatarService({
    databaseUrl: ':memory:',
    runtime,
    store,
    mainSession,
    clientFactory: () => client.client,
    clock: now,
    log: { info: () => undefined, warn: () => undefined }
  });
  services.push(service);
  return { service, store, runtime, started, dispatched, mainDispatches, client };
};

const port = (overrides: Partial<LarkReactionPort> = {}): LarkReactionPort => ({
  getMessage: vi.fn(async () => message),
  listContext: vi.fn(async () => [message]),
  sendAskCard: vi.fn(async () => ({ messageId: 'om_card' })),
  updateAskCard: vi.fn(async () => undefined),
  ...overrides
});

const userReaction = { messageId: 'om_target', emojiType: 'THUMBSUP', operatorId: 'ou_me', operatorType: 'user' as const };

describe('Lark avatar reaction trigger', () => {
  it('does nothing when disabled or when the emoji does not match', async () => {
    const disabled = harness({ config: { reactionTriggerEnabled: false } });
    const disabledPort = port();
    await expect(disabled.service.handleReaction(userReaction, disabledPort)).resolves.toMatchObject({ ok: false, reason: 'disabled' });
    expect(disabledPort.getMessage).not.toHaveBeenCalled();

    const mismatch = harness({ config: { reactionTriggerEmoji: 'DONE' } });
    await expect(mismatch.service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: false, reason: 'emoji_mismatch' });
    expect(mismatch.mainDispatches).toHaveLength(0);
  });

  it('respects paused listening and the listenChats allowlist', async () => {
    const paused = harness({ config: { listening: false } });
    const pausedPort = port();
    await expect(paused.service.handleReaction(userReaction, pausedPort)).resolves.toMatchObject({ ok: false, reason: 'listening_paused' });
    expect(pausedPort.getMessage).not.toHaveBeenCalled();
    expect(paused.store.listReactionTriggers()[0]).toMatchObject({ state: 'ignored', reason: 'listening_paused' });

    const filtered = harness({ config: { listenChats: ['oc_other'] }, mainSessionId: 'ses_main' });
    await expect(filtered.service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: false, reason: 'chat_not_listened' });
    expect(filtered.mainDispatches).toHaveLength(0);
    expect(filtered.store.listReactionTriggers()[0]).toMatchObject({ state: 'ignored', reason: 'chat_not_listened' });
  });

  it('routes to the main session with origin=emoji so no user bubble appears', async () => {
    const { service, mainDispatches, store } = harness({ mainSessionId: 'ses_main' });
    const result = await service.handleReaction(userReaction, port());
    expect(result).toMatchObject({ ok: true, action: 'trigger', sessionId: 'ses_main', taskId: 'task_main_1' });
    expect(mainDispatches).toHaveLength(1);
    expect(mainDispatches[0]).toMatchObject({ origin: 'emoji' });
    expect(mainDispatches[0]!.agentPrompt).toContain('← 表情触发目标');
    expect(mainDispatches[0]!.agentPrompt).toContain('把发布说明整理一下');
    expect(store.listReactionTriggers()[0]).toMatchObject({
      state: 'dispatched',
      route: 'main',
      sessionId: 'ses_main',
      taskId: 'task_main_1',
      emoji: 'THUMBSUP'
    });
  });

  it('exposes the last event and the skip reason through diagnostics', async () => {
    const mismatch = harness({ config: { reactionTriggerEmoji: 'DONE' } });
    await mismatch.service.handleReaction(userReaction, port());
    expect(mismatch.service.reactionDiagnostics().lastEvent).toMatchObject({
      messageId: 'om_target',
      emojiType: 'THUMBSUP',
      outcome: 'ignored:emoji_mismatch'
    });

    const bot = harness({ config: { reactionTriggerEmoji: 'THUMBSUP' } });
    await bot.service.handleReaction({ ...userReaction, operatorType: 'bot', operatorId: 'cli_bot', actionTime: '1' }, port());
    expect(bot.service.reactionDiagnostics().lastEvent).toMatchObject({ outcome: 'ignored:bot_reaction' });
    expect(bot.store.listReactionTriggers()[0]).toMatchObject({ state: 'ignored', reason: 'bot_reaction', actionTime: '1' });
  });

  it('creates an independent session for the message thread', async () => {
    const { service, started, dispatched } = harness({ config: { reactionTriggerRoute: 'independent' } });
    const result = await service.handleReaction({ ...userReaction, messageId: 'om_target' }, port());
    expect(result).toMatchObject({ ok: true, action: 'trigger', sessionId: 'ses_1' });
    expect(started[0]).toMatchObject({ source: 'lark-avatar-reaction', sourceId: 'lark-reaction:oc_chat:om_target' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ sessionId: 'ses_1' });
    expect(dispatched[0]!.origin).toBeUndefined();
  });

  it('asks first, then dispatches only after an authorised card action', async () => {
    const { service, mainDispatches, store } = harness({ config: { reactionTriggerRoute: 'ask' }, mainSessionId: 'ses_main' });
    const reactionPort = port();
    await expect(service.handleReaction(userReaction, reactionPort)).resolves.toMatchObject({ ok: true, action: 'awaiting_route' });
    expect(reactionPort.sendAskCard).toHaveBeenCalledOnce();
    const trigger = store.listReactionTriggers()[0]!;
    expect(trigger.state).toBe('awaiting_route');

    const denied = await service.resolveReactionRoute({
      value: { action: 'avatar_reaction_route', trigger_id: trigger.key, route: 'main' },
      operatorId: 'ou_stranger',
      authorize: () => false
    });
    expect(denied).toMatchObject({ type: 'warning' });
    expect(mainDispatches).toHaveLength(0);

    const accepted = await service.resolveReactionRoute({
      value: { action: 'avatar_reaction_route', trigger_id: trigger.key, route: 'main' },
      operatorId: 'ou_me',
      authorize: () => true
    });
    expect(accepted).toMatchObject({ type: 'success' });
    expect(mainDispatches).toHaveLength(1);
    expect(reactionPort.updateAskCard).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_card', ok: true }));
    expect(store.reactionTrigger(trigger.key)?.state).toBe('dispatched');

    const again = await service.resolveReactionRoute({
      value: { action: 'avatar_reaction_route', trigger_id: trigger.key, route: 'main' },
      authorize: () => true
    });
    expect(again).toMatchObject({ type: 'warning' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('triggers once per user + message + emoji even if the event is redelivered', async () => {
    const { service, mainDispatches } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: true });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: false, reason: 'duplicate' });
    expect(mainDispatches).toHaveLength(1);

    // 不同用户对同一消息加同一个表情，是另一次触发。
    await expect(service.handleReaction({ ...userReaction, operatorId: 'ou_other' }, port())).resolves.toMatchObject({ ok: true });
    expect(mainDispatches).toHaveLength(2);
  });

  it('allows a retry after failure only when the user re-adds the reaction', async () => {
    const { service, mainDispatches, store } = harness({ mainSessionId: 'ses_main' });
    const denied = port({
      getMessage: vi.fn(async () => {
        throw Object.assign(new Error('403 Forbidden: no permission'), { code: 'LARK_PERMISSION_DENIED' });
      })
    });
    const first = { ...userReaction, operatorId: 'ou_retry', actionTime: '1000' };
    await expect(service.handleReaction(first, denied)).resolves.toMatchObject({ ok: false, reason: 'permission_denied' });
    // 同一条事件重投（action_time 相同）仍然是重复，不能自动重跑。
    await expect(service.handleReaction(first, port())).resolves.toMatchObject({ ok: false, reason: 'duplicate' });
    expect(mainDispatches).toHaveLength(0);

    // 用户重新加了一次表情（新 action_time），失败记录允许重试并成功派发。
    await expect(service.handleReaction({ ...first, actionTime: '2000' }, port()))
      .resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
    expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'dispatched', actionTime: '2000' });
  });

  it('excludes the avatar’s own acknowledgement reactions', async () => {
    const { service, client } = harness({
      config: { emojiReactions: true, reactionTriggerEmoji: 'THUMBSUP' },
      withCredentials: true
    });
    // Math.random=0 时 reactToTrigger 固定挑 2 个：THUMBSUP、OK。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    service.start();
    await client.emit({ messageId: 'om_self', content: '/ai 你好', fromId: '42' });
    await vi.waitFor(() => expect(client.reacted.length).toBeGreaterThan(0));
    // reactToTrigger 的 allSettled 回调在下一轮微任务里才登记「自己加的表情」，等它落账。
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(client.reacted.map(item => item.type)).toContain('THUMBSUP');
    const result = await service.handleReaction(
      { messageId: 'om_self', emojiType: 'THUMBSUP', operatorId: '42', operatorType: 'user' },
      port()
    );
    expect(result).toMatchObject({ ok: false, reason: 'self_reaction' });
  });

  it('ignores bot reactions by default and allows them when configured', async () => {
    const { service, mainDispatches } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction({ ...userReaction, operatorType: 'bot', operatorId: 'cli_bot', actionTime: '100' }, port()))
      .resolves.toMatchObject({ ok: false, reason: 'bot_reaction' });
    expect(mainDispatches).toHaveLength(0);

    await service.saveConfig({ reactionTriggerIgnoreBots: false });
    await expect(service.handleReaction({ ...userReaction, operatorType: 'bot', operatorId: 'cli_bot', actionTime: '200' }, port()))
      .resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('records permission failures with the underlying reason', async () => {
    const { service, store } = harness({ mainSessionId: 'ses_main' });
    const deniedPort = port({
      getMessage: vi.fn(async () => {
        throw Object.assign(new Error('403 Forbidden: no permission to read message'), { code: 'LARK_PERMISSION_DENIED' });
      })
    });
    const result = await service.handleReaction(userReaction, deniedPort);
    expect(result).toMatchObject({ ok: false, action: 'failed', reason: 'permission_denied' });
    expect(result.detail).toContain('no permission');
    expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'failed' });
    expect(store.listReactionTriggers()[0]!.reason).toContain('permission_denied');
    expect(store.listReactionTriggers()[0]!.reason).toContain('403 Forbidden');
  });

  it('records a deleted or invisible message as missing_message', async () => {
    const { service } = harness({ mainSessionId: 'ses_main' });
    const missingPort = port({
      getMessage: vi.fn(async () => {
        throw Object.assign(new Error('Message om_target not found'), { code: 'LARK_MESSAGE_NOT_FOUND' });
      })
    });
    await expect(service.handleReaction(userReaction, missingPort))
      .resolves.toMatchObject({ ok: false, action: 'failed', reason: 'missing_message' });
  });

  it('fails cleanly when there is no main session or no ask-card support', async () => {
    const noMain = harness({ mainSessionId: undefined });
    await expect(noMain.service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: false, reason: 'no_main_session' });
    expect(noMain.mainDispatches).toHaveLength(0);

    const ask = harness({ config: { reactionTriggerRoute: 'ask' } });
    await expect(ask.service.handleReaction(userReaction, port({ sendAskCard: undefined })))
      .resolves.toMatchObject({ ok: false, reason: 'ask_card_failed' });
  });

  it('saves, clamps and round-trips the reaction settings', async () => {
    const { service } = harness({ config: { reactionTriggerEnabled: false, reactionTriggerEmoji: '', reactionTriggerRoute: 'ask' } });
    const saved = await service.saveConfig({
      reactionTriggerEnabled: true,
      reactionTriggerEmoji: '👍',
      reactionTriggerRoute: 'independent',
      reactionTriggerIgnoreBots: false
    });
    expect(saved.config).toMatchObject({
      reactionTriggerEnabled: true,
      reactionTriggerEmoji: 'THUMBSUP',
      reactionTriggerRoute: 'independent',
      reactionTriggerIgnoreBots: false
    });
    expect(service.publicState()?.config).toMatchObject({ reactionTriggerRoute: 'independent', reactionTriggerEmoji: 'THUMBSUP' });
    await expect(service.saveConfig({ reactionTriggerEmoji: '两个表情' })).rejects.toThrow('触发 emoji');
  });

  it('consumes its own reaction echo once and still lets a later user reaction trigger', async () => {
    const { service, client, mainDispatches } = harness({
      config: { emojiReactions: true, reactionTriggerEmoji: 'THUMBSUP' },
      withCredentials: true,
      mainSessionId: 'ses_main'
    });
    // Math.random=0 时 reactToTrigger 固定挑 2 个：THUMBSUP、OK。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    service.start();
    await client.emit({ messageId: 'om_echo', content: '/ai 你好', fromId: '42' });
    await vi.waitFor(() => expect(client.reacted.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 10));

    const echoPort = port({ getMessage: vi.fn(async () => ({ ...message, messageId: 'om_echo' })) });
    // 第一条同 emoji 事件是替身自己加的表情回声：忽略，但只消费一次。
    await expect(service.handleReaction(
      { messageId: 'om_echo', emojiType: 'THUMBSUP', operatorId: 'ou_me', operatorType: 'user' },
      echoPort
    )).resolves.toMatchObject({ ok: false, reason: 'self_reaction' });
    // 真实用户随后加同一个表情，不能再被 selfReaction 永久排掉。
    await expect(service.handleReaction(
      { messageId: 'om_echo', emojiType: 'THUMBSUP', operatorId: 'ou_me', operatorType: 'user', actionTime: '2' },
      echoPort
    )).resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('reports a generic message fetch failure instead of calling it dispatch_failed', async () => {
    const { service, store } = harness({ mainSessionId: 'ses_main' });
    const brokenPort = port({
      getMessage: vi.fn(async () => { throw new Error('socket hang up'); })
    });
    await expect(service.handleReaction(userReaction, brokenPort))
      .resolves.toMatchObject({ ok: false, action: 'failed', reason: 'message_fetch_failed' });
    expect(store.listReactionTriggers()[0]?.reason).toContain('message_fetch_failed');
  });

  it('matches the listenChats whitelist against the web chat id for oc_* events', async () => {
    const { service, mainDispatches } = harness({
      config: { listenChats: ['7654321'] },
      mainSessionId: 'ses_main'
    });
    const openApiMessage = { ...message, chatId: 'oc_chat_open', webChatId: '7654321' };
    await expect(service.handleReaction(userReaction, port({
      getMessage: vi.fn(async () => openApiMessage),
      listContext: vi.fn(async () => [openApiMessage])
    }))).resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('records outbound emoji reaction failures for the settings diagnostics', async () => {
    const { service, client } = harness({
      config: { emojiReactions: true },
      withCredentials: true
    });
    client.client.react = vi.fn(async () => { throw new Error('gateway 500'); });
    service.start();
    await client.emit({ messageId: 'om_react_fail', content: '/ai 你好', fromId: '42' });
    await vi.waitFor(() => {
      expect(service.reactionDiagnostics().lastOutboundReaction?.failed.length).toBeGreaterThan(0);
    });
    const outbound = service.reactionDiagnostics().lastOutboundReaction!;
    expect(outbound).toMatchObject({ messageId: 'om_react_fail' });
    expect(outbound.picked.length).toBeGreaterThanOrEqual(2);
    expect(outbound.failed[0]?.error).toContain('gateway 500');
  });
});

describe('Lark avatar reaction authorization and failure classification', () => {
  it('refuses a reaction from an operator outside the bot allow list on all routes', async () => {
    for (const route of ['main', 'independent', 'ask'] as const) {
      const { service, mainDispatches, dispatched, store } = harness({
        config: { reactionTriggerRoute: route },
        mainSessionId: 'ses_main'
      });
      const event = { ...userReaction, operatorId: `ou_stranger_${route}`, actionTime: '100' };
      await expect(service.handleReaction(event, port(), { authorizeOperator: () => false }))
        .resolves.toMatchObject({ ok: false, action: 'ignore', reason: 'operator_not_allowed' });
      expect(mainDispatches).toHaveLength(0);
      expect(dispatched).toHaveLength(0);
      expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'ignored', reason: 'operator_not_allowed' });
    }
  });

  it('allows a reaction once the operator is authorized', async () => {
    const { service, mainDispatches } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction(userReaction, port(), { authorizeOperator: operatorId => operatorId === 'ou_me' }))
      .resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('classifies a real ask-card failure as ask_card_failed, not dispatch_failed', async () => {
    const { service, store, mainDispatches } = harness({ config: { reactionTriggerRoute: 'ask' } });
    const failing = port({
      sendAskCard: vi.fn(async () => {
        throw Object.assign(new Error('uuid too long'), { code: 'INVALID_IDEMPOTENCY_KEY' });
      })
    });
    await expect(service.handleReaction(userReaction, failing))
      .resolves.toMatchObject({ ok: false, action: 'failed', reason: 'ask_card_failed' });
    expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'failed' });
    expect(store.listReactionTriggers()[0]!.reason).toContain('uuid too long');
    expect(mainDispatches).toHaveLength(0);
  });

  it('maps the OpenAPI missing-message code to missing_message', async () => {
    const { service } = harness({ mainSessionId: 'ses_main' });
    const missing = port({
      getMessage: vi.fn(async () => {
        throw Object.assign(new Error('message not found'), { code: 'LARK_OPENAPI_ERROR', details: { upstreamCode: 230030 } });
      })
    });
    await expect(service.handleReaction(userReaction, missing))
      .resolves.toMatchObject({ ok: false, action: 'failed', reason: 'missing_message' });
  });

  it('records the ask-card trigger id as a short, NUL-free id and keeps the uuid under 50 chars', async () => {
    const { service } = harness({ config: { reactionTriggerRoute: 'ask' } });
    const sendAskCard = vi.fn(async () => ({ messageId: 'om_card' }));
    await service.handleReaction(userReaction, port({ sendAskCard }));
    const input = sendAskCard.mock.calls[0]![0] as { triggerId: string };
    expect(input.triggerId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(input.triggerId).not.toContain('\u0000');
    expect(`avatar-reaction-ask:${input.triggerId}`.length).toBeLessThanOrEqual(50);
  });

  it('does not expose message bodies or context through the diagnostics ledger', async () => {
    const { service } = harness({ mainSessionId: 'ses_main' });
    await service.handleReaction(userReaction, port());
    const diagnostics = service.reactionDiagnostics() as unknown as { triggers: Array<Record<string, unknown>> };
    expect(diagnostics.triggers[0]).toMatchObject({ messageId: 'om_target', state: 'dispatched' });
    expect(diagnostics.triggers[0]).not.toHaveProperty('payload');
    expect(JSON.stringify(diagnostics)).not.toContain('把发布说明整理一下');
  });

  it('passes a stable clientMessageId so a crash-and-replay cannot run the turn twice', async () => {
    const main = harness({ mainSessionId: 'ses_main' });
    await main.service.handleReaction(userReaction, port());
    const key = main.store.listReactionTriggers()[0]!.key;
    expect(main.mainDispatches[0]).toMatchObject({ clientMessageId: key });

    const independent = harness({ config: { reactionTriggerRoute: 'independent' } });
    await independent.service.handleReaction(userReaction, port());
    expect(independent.dispatched[0]).toMatchObject({ clientMessageId: key });
  });

  it('re-claims a stale pending record because dispatch never started', async () => {
    const { service, store, mainDispatches } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: true });
    // 模拟「落账后、派发前崩溃」：pending 超过 2 分钟，派发从未发生，可以安全重领。
    const key = store.listReactionTriggers()[0]!.key;
    store.updateReactionTrigger(key, { state: 'pending', updatedAt: '2020-01-01T00:00:00.000Z' });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: true });
    expect(mainDispatches).toHaveLength(2);
    // 两次派发共用同一个 clientMessageId，30 秒内的并发/网络重放会被 runtime 去重。
    expect(new Set(mainDispatches.map(item => item.clientMessageId)).size).toBe(1);
  });

  it('does not re-dispatch a stale dispatching record: the Agent turn may already have started', async () => {
    const { service, store, mainDispatches } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({ ok: true });
    // 模拟「派发已开始、进程在写 dispatched 前崩溃」：runtime 的内存去重窗口只有 30 秒，
    // 2 分钟后自动重领会真的跑第二轮，所以这里必须停下来等用户重新加表情。
    const key = store.listReactionTriggers()[0]!.key;
    store.updateReactionTrigger(key, { state: 'dispatching', updatedAt: '2020-01-01T00:00:00.000Z' });
    await expect(service.handleReaction(userReaction, port())).resolves.toMatchObject({
      ok: false,
      action: 'failed',
      reason: 'dispatch_uncertain'
    });
    expect(mainDispatches).toHaveLength(1);
    expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'failed' });
    expect(store.listReactionTriggers()[0]!.reason).toContain('dispatch_uncertain');
    // 用户重新加表情（新 action_time）才是明确的“再跑一次”。
    await expect(service.handleReaction({ ...userReaction, actionTime: '2' }, port())).resolves.toMatchObject({ ok: true });
    expect(mainDispatches).toHaveLength(2);
  });

  it('sends only one ask card when the same reaction is re-delivered', async () => {
    const { service } = harness({ config: { reactionTriggerRoute: 'ask' } });
    const sendAskCard = vi.fn(async () => ({ messageId: 'om_card' }));
    const shared = port({ sendAskCard });
    await service.handleReaction(userReaction, shared);
    await expect(service.handleReaction(userReaction, shared)).resolves.toMatchObject({ ok: false, reason: 'duplicate' });
    expect(sendAskCard).toHaveBeenCalledTimes(1);
  });

  it('records operator_identity_unresolved when the event only carries user_id/union_id', async () => {
    const { service, store } = harness({ mainSessionId: 'ses_main' });
    await expect(service.handleReaction(
      { ...userReaction, operatorIdentity: 'user_id' },
      port(),
      { authorizeOperator: () => false }
    )).resolves.toMatchObject({ ok: false, action: 'ignore', reason: 'operator_identity_unresolved' });
    expect(store.listReactionTriggers()[0]).toMatchObject({ state: 'ignored', reason: 'operator_identity_unresolved' });
  });

  it('treats an outbound reaction with count=0 as a failure and does not consume the user echo token', async () => {
    const { service, client, mainDispatches } = harness({
      config: { emojiReactions: true, reactionTriggerEmoji: 'THUMBSUP' },
      withCredentials: true,
      mainSessionId: 'ses_main'
    });
    client.setReactionResult({ count: 0 });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    service.start();
    await client.emit({ messageId: 'om_zero', content: '/ai 你好', fromId: '42' });
    await vi.waitFor(() => expect(service.reactionDiagnostics().lastOutboundReaction).toBeDefined());
    const outbound = service.reactionDiagnostics().lastOutboundReaction!;
    expect(outbound.succeeded).toHaveLength(0);
    expect(outbound.failed).toHaveLength(2);
    expect(outbound.failed[0]!.error).toContain('count=0');
    // 没有真正加上表情，就不能留下「自己加过」的令牌，否则真实用户的表情会被吞掉。
    await expect(service.handleReaction(
      { messageId: 'om_zero', emojiType: 'THUMBSUP', operatorId: 'ou_me', operatorType: 'user' },
      port({ getMessage: vi.fn(async () => ({ ...message, messageId: 'om_zero' })) })
    )).resolves.toMatchObject({ ok: true, action: 'trigger' });
    expect(mainDispatches).toHaveLength(1);
  });

  it('ignores its own feedback reaction even when the event arrives before the HTTP response', async () => {
    const { service, client, mainDispatches } = harness({
      config: { emojiReactions: true, reactionTriggerEmoji: 'THUMBSUP' },
      withCredentials: true,
      mainSessionId: 'ses_main'
    });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    client.holdReactions();
    service.start();
    const emitting = client.emit({ messageId: 'om_race', content: '/ai 你好', fromId: '42' });
    // react() 还挂着（HTTP 响应未返回），事件先到。
    await vi.waitFor(() => expect(client.reacted.length).toBe(2));
    await expect(service.handleReaction(
      { messageId: 'om_race', emojiType: 'THUMBSUP', operatorId: 'ou_me', operatorType: 'user' },
      port({ getMessage: vi.fn(async () => ({ ...message, messageId: 'om_race' })) })
    )).resolves.toMatchObject({ ok: false, reason: 'self_reaction' });
    expect(mainDispatches).toHaveLength(0);
    client.releaseReactions();
    await emitting;
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { buildApp } from '../app.js';
import { issueMasterToken, issueSessionToken } from '../web-access.js';
import { LarkMessageCoordinator, type LarkListenerPool, type LarkMessageEvent, type LarkRuntime } from './listener.js';
import type { StoredLarkConfig } from './config.js';
import {
  buildRegexTriggerPrompt,
  createLarkRegexTriggerRule,
  LARK_REGEX_PROMPT_TEMPLATES,
  LARK_REGEX_TEMPLATE_VARIABLES,
  matchLarkTriggerMessages,
  readLarkRegexTriggerHits,
  validateLarkTriggerRegex
} from './regex-triggers.js';

const okJson = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

const noopLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

function createMemoryCardMappings() {
  const rows = new Map<string, any>();
  return {
    async save(item: any) { rows.set(`${item.channel}:${item.externalId}`, item); return item; },
    async get(channel: string, externalId: string) { return rows.get(`${channel}:${externalId}`); },
    async list(channel: string) { return [...rows.values()].filter(item => item.channel === channel); },
    async delete(channel: string, externalId: string) { rows.delete(`${channel}:${externalId}`); }
  };
}

const stubListenerPool = (): LarkListenerPool => ({
  listening: false,
  activeAppIds: [],
  sync: vi.fn(async () => undefined),
  stop: vi.fn()
});

function createFakeRuntime(): { runtime: LarkRuntime; starts: any[]; dispatches: any[] } {
  const starts: any[] = [];
  const dispatches: any[] = [];
  const sessions = new Map<string, any>();
  let seq = 0;

  const runtime: LarkRuntime = {
    async start(input) {
      seq += 1;
      const session = {
        id: `sess_${seq}`,
        agentId: input.agentId,
        cwd: input.cwd ?? '/tmp/work',
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        state: 'idle',
        source: input.source,
        sourceId: input.sourceId,
        runId: `run_${seq}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      starts.push(input);
      sessions.set(session.id, session);
      return session;
    },
    async getSession(id) {
      return sessions.get(id);
    },
    async listSessions() {
      return [...sessions.values()];
    },
    async send() {
      return undefined;
    },
    async dispatch(id, prompt, mode, agentPrompt, riskPolicy) {
      dispatches.push({ id, prompt, mode, agentPrompt, riskPolicy });
      return { id: `task_${dispatches.length}`, status: 'running' };
    },
    async interrupt() {
      return undefined;
    },
    subscribe() {
      return () => undefined;
    }
  };
  return { runtime, starts, dispatches };
}

function makeBotConfig(overrides: Partial<StoredLarkConfig> = {}): StoredLarkConfig {
  return {
    appId: 'cli_ops_bot',
    appSecret: 'sec_super_secret_do_not_leak',
    name: '值班运维机器人',
    workspace: '/srv/ops-repo',
    defaultAgentId: 'claude',
    defaultModel: 'claude-sonnet-4-5',
    defaultReasoningEffort: 'high',
    preInjectPrompt: '回答前先给结论。',
    listening: true,
    groupToolsEnabled: false,
    groupToolsAllowSend: false,
    groupSessionScope: 'chat',
    pushIntervalMs: 1_000,
    traceLimit: 50,
    hideTraceOnComplete: true,
    quietReply: false,
    allowedUsers: [],
    allowedUserNames: [],
    allowedEmails: [],
    allowedBots: [],
    allowedBotNames: [],
    peerBotsAllowed: true,
    highRiskAllowedUsers: [],
    highRiskAllowedUserNames: [],
    highRiskAllowedEmails: [],
    highRiskPattern: 'sudo',
    gateEnabled: false,
    softGateEnabled: false,
    hardGateEnabled: false,
    hookTrustConfirmed: false,
    ...overrides
  };
}

describe('Lark group regex triggers', () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const repositories: Array<{ close(): void }> = [];

  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (repositories.length) repositories.pop()!.close();
  });

  describe('regex validation and ReDoS protection', () => {
    it('validates syntax, normalizes flags, and rejects invalid/oversized/ReDoS patterns', () => {
      expect(validateLarkTriggerRegex('P[01]|告警', 'gi')).toEqual({ valid: true, normalizedFlags: 'i' });
      expect(validateLarkTriggerRegex('error', 'umi')).toEqual({ valid: true, normalizedFlags: 'imu' });
      expect(validateLarkTriggerRegex('   ', 'i')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('[unclosed', 'i')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('foo', 'z')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('a'.repeat(1_025), 'i')).toMatchObject({ valid: false });
      // ReDoS nested quantifiers & quantified backreference & deep nesting
      expect(validateLarkTriggerRegex('(a+)+$', 'i')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('([a-zA-Z]+)*b', 'i')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('(.+)\\1+', 'i')).toMatchObject({ valid: false });
      expect(validateLarkTriggerRegex('('.repeat(15) + 'a' + ')'.repeat(15), 'i')).toMatchObject({ valid: false });
    });

    it('returns exact highlight spans and respects ignoreBotMessages & zero-length safety', () => {
      const preview = matchLarkTriggerMessages(
        '(?:P[01]|报错|502)',
        'i',
        [
          { messageId: 'om_1', text: '线上出现 p0 报错：网关返回 502 Bad Gateway', senderType: 'user' },
          { messageId: 'om_2', text: '中午吃什么？', senderType: 'user' },
          { messageId: 'om_3', text: '机器人播报：P1 报错已恢复', senderType: 'app' }
        ],
        { ignoreBotMessages: true }
      );
      expect(preview.valid).toBe(true);
      expect(preview.totalCount).toBe(3);
      expect(preview.matchedCount).toBe(1);
      expect(preview.results[0]).toMatchObject({
        messageId: 'om_1',
        matched: true,
        matches: [
          { start: 5, end: 7, text: 'p0' },
          { start: 8, end: 10, text: '报错' },
          { start: 16, end: 19, text: '502' }
        ]
      });
      expect(preview.results[1]).toEqual({ messageId: 'om_2', matched: false, matches: [] });
      expect(preview.results[2]).toEqual({ messageId: 'om_3', matched: false, skippedBot: true, matches: [] });

      // Zero-length match must not hang
      const zeroLen = matchLarkTriggerMessages('^', 'm', [{ messageId: 'om_z', text: 'line1\nline2' }]);
      expect(zeroLen.valid).toBe(true);
      expect(zeroLen.matchedCount).toBe(1);
    });
  });

  describe('prompt template rendering and mandatory base context injection', () => {
    it('substitutes variables safely without $& corruption and always attaches structured base context', () => {
      const prompt = buildRegexTriggerPrompt({
        promptTemplate: '请排查「{{chatName}}」中 {{senderName}} 上报的问题（命中：{{matchedText}}），规则 {{ruleName}}。',
        chatName: '核心交易告警群',
        chatId: 'oc_trade_alert',
        botName: '值班运维机器人',
        botId: 'cli_ops_bot',
        ruleName: 'P0 告警监控',
        pattern: 'P[01]|502',
        flags: 'i',
        replyMode: 'thread',
        senderName: '张三',
        senderId: 'ou_zhangsan',
        messageId: 'om_alert_1',
        messageTime: '1732670400000',
        messageText: 'P0 告警：支付接口 $& 502 超时',
        matchedText: 'P0 | 502',
        triggerType: 'realtime'
      });

      expect(prompt).toContain('请排查「核心交易告警群」中 张三 上报的问题（命中：P0 | 502），规则 P0 告警监控。');
      expect(prompt).toContain('[群聊正则自动唤起 · 基础上下文]');
      expect(prompt).toContain('所在群聊：核心交易告警群（chat_id: oc_trade_alert）');
      expect(prompt).toContain('所属机器人：值班运维机器人（app_id: cli_ops_bot）');
      expect(prompt).toContain('命中规则：P0 告警监控（/P[01]|502/i）');
      expect(prompt).toContain('消息发送人：张三（ou_zhangsan）');
      expect(prompt).toContain('P0 告警：支付接口 $& 502 超时');
    });

    it('still injects full base context block when promptTemplate is empty', () => {
      const prompt = buildRegexTriggerPrompt({
        promptTemplate: '',
        chatName: '研发群',
        chatId: 'oc_dev',
        botName: '研发助手',
        botId: 'cli_dev',
        ruleName: '简单规则',
        pattern: '报错',
        replyMode: 'main',
        senderName: '李四',
        messageId: 'om_dev_1',
        messageText: '构建报错了',
        matchedText: '报错',
        triggerType: 'backfill'
      });

      expect(prompt).toContain('[群聊正则自动唤起 · 基础上下文]');
      expect(prompt).toContain('触发方式：历史消息补偿触发');
      expect(prompt).toContain('主线程唤起');
      expect(prompt).toContain('所在群聊：研发群（chat_id: oc_dev）');
      expect(prompt).toContain('构建报错了');
    });
  });

  describe('realtime listener auto-wake, reply modes, and deduplication', () => {
    it('auto-wakes in thread mode when group message matches enabled rule without @bot and reuses bot settings', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const botConfig = makeBotConfig();
      await repos.config.set('lark.bots', JSON.stringify([botConfig]));
      const rule = await createLarkRegexTriggerRule(repos.config, [botConfig], {
        name: 'P0 告警排查',
        botId: botConfig.appId,
        chatId: 'oc_ops',
        chatName: '线上运维群',
        pattern: 'P0|OOM',
        flags: 'i',
        replyMode: 'thread',
        promptTemplate: '快速定位「{{chatName}}」的告警：{{matchedText}}'
      });

      const { runtime, starts, dispatches } = createFakeRuntime();
      const reply = vi.fn(async () => ({ messageId: 'om_card_thread', chatId: 'oc_ops' }));
      const send = vi.fn(async () => ({ messageId: 'om_card_send', chatId: 'oc_ops' }));
      const service = {
        reply,
        send,
        update: vi.fn(async () => ({ messageId: 'om_card_thread', chatId: 'oc_ops' })),
        addReaction: vi.fn(async () => ({ messageId: 'om_msg_1', reactionId: 'r1', emojiType: 'OK' })),
        deleteReaction: vi.fn(async () => undefined),
        getUserName: vi.fn(async () => '王五'),
        getChat: vi.fn(async () => ({ chatId: 'oc_ops', name: '线上运维群', userCount: 5 })),
        listChats: vi.fn(async () => ({ items: [{ chatId: 'oc_ops', name: '线上运维群', external: false }], hasMore: false }))
      } as any;

      const coordinator = new LarkMessageCoordinator(runtime, service, noopLog, () => 0, 'ou_self_bot', undefined, createMemoryCardMappings() as any, repos.config);
      const event: LarkMessageEvent = {
        messageId: 'om_msg_1',
        chatId: 'oc_ops',
        chatType: 'group',
        createTime: '1732670400000',
        messageType: 'text',
        content: JSON.stringify({ text: '紧急！订单服务出现 OOM 崩溃' }),
        senderOpenId: 'ou_wangwu',
        senderType: 'user',
        mentions: []
      };

      await coordinator.handle(event, botConfig);
      await vi.waitFor(() => expect(dispatches).toHaveLength(1));

      // 100% 复用机器人已有飞书设置
      expect(starts[0]).toMatchObject({
        agentId: 'claude',
        cwd: '/srv/ops-repo',
        model: 'claude-sonnet-4-5',
        reasoningEffort: 'high'
      });
      // 话题模式强制 replyInThread: true 回复原消息
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'om_msg_1',
        replyInThread: true
      }));
      expect(send).not.toHaveBeenCalled();
      // Prompt 包含模板 + 基础群聊上下文 + 机器人自身 preInjectPrompt
      expect(dispatches[0].prompt).toContain('快速定位「线上运维群」的告警：OOM');
      expect(dispatches[0].prompt).toContain('所在群聊：线上运维群（chat_id: oc_ops）');
      expect(dispatches[0].prompt).toContain('王五');
      expect(dispatches[0].agentPrompt).toContain('[AgentDock 预注入 Prompt]\n回答前先给结论。');

      // 命中账本已记录
      await vi.waitFor(async () => {
        const hits = await readLarkRegexTriggerHits(repos.config);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
          ruleId: rule.id,
          messageId: 'om_msg_1',
          sessionId: 'sess_1',
          triggerType: 'realtime',
          status: 'triggered'
        });
      });
    });

    it('auto-wakes in main thread mode (reply without replyInThread for main messages, send to chat for sub-thread messages)', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const botConfig = makeBotConfig();
      await repos.config.set('lark.bots', JSON.stringify([botConfig]));
      await createLarkRegexTriggerRule(repos.config, [botConfig], {
        name: '上线播报摘要',
        botId: botConfig.appId,
        chatId: 'oc_release',
        chatName: '发版同步群',
        pattern: '发布完成',
        flags: 'i',
        replyMode: 'main',
        promptTemplate: '汇总发布内容'
      });

      const { runtime, dispatches } = createFakeRuntime();
      const reply = vi.fn(async () => ({ messageId: 'om_card_main', chatId: 'oc_release' }));
      const send = vi.fn(async () => ({ messageId: 'om_card_chat', chatId: 'oc_release' }));
      const service = {
        reply,
        send,
        update: vi.fn(async () => ({ messageId: 'om_card_main', chatId: 'oc_release' })),
        addReaction: vi.fn(async () => ({ messageId: 'om_r1', reactionId: 'r1', emojiType: 'OK' })),
        deleteReaction: vi.fn(async () => undefined),
        getUserName: vi.fn(async () => '赵六'),
        getChat: vi.fn(async () => ({ chatId: 'oc_release', name: '发版同步群', userCount: 8 })),
        listChats: vi.fn(async () => ({ items: [], hasMore: false }))
      } as any;

      const coordinator = new LarkMessageCoordinator(runtime, service, noopLog, () => 0, 'ou_self_bot', undefined, createMemoryCardMappings() as any, repos.config);

      // 主流消息：主线程回复（不带 replyInThread: true）
      await coordinator.handle({
        messageId: 'om_rel_1',
        chatId: 'oc_release',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: 'v2.4.0 已发布完成' }),
        senderOpenId: 'ou_zhaoliu',
        senderType: 'user',
        mentions: []
      }, botConfig);
      await vi.waitFor(() => expect(dispatches).toHaveLength(1));
      expect(reply).toHaveBeenCalledTimes(1);
      expect((reply.mock.calls[0] as any)?.[0]?.replyInThread).toBe(false);

      // 子话题消息但规则要求主线程唤起：直接发到群主线程（service.send）
      await coordinator.handle({
        messageId: 'om_rel_2',
        chatId: 'oc_release',
        chatType: 'group',
        threadId: 'omt_sub_thread',
        messageType: 'text',
        content: JSON.stringify({ text: '补丁发布完成' }),
        senderOpenId: 'ou_zhaoliu',
        senderType: 'user',
        mentions: []
      }, botConfig);
      await vi.waitFor(() => expect(dispatches).toHaveLength(2));
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_release' }));
    });

    it('deduplicates when a message both @mentions the bot and matches a regex rule (fires only once)', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const botConfig = makeBotConfig();
      await repos.config.set('lark.bots', JSON.stringify([botConfig]));
      await createLarkRegexTriggerRule(repos.config, [botConfig], {
        name: '告警规则',
        botId: botConfig.appId,
        chatId: 'oc_ops',
        chatName: '运维群',
        pattern: 'P0',
        replyMode: 'thread'
      });

      const { runtime, dispatches } = createFakeRuntime();
      const service = {
        reply: vi.fn(async () => ({ messageId: 'om_card_1', chatId: 'oc_ops' })),
        send: vi.fn(async () => ({ messageId: 'om_card_1', chatId: 'oc_ops' })),
        update: vi.fn(async () => ({ messageId: 'om_card_1', chatId: 'oc_ops' })),
        addReaction: vi.fn(async () => ({ messageId: 'om_both', reactionId: 'r1', emojiType: 'OK' })),
        deleteReaction: vi.fn(async () => undefined),
        getUserName: vi.fn(async () => '张三'),
        getChat: vi.fn(async () => ({ chatId: 'oc_ops', name: '运维群', userCount: 5 })),
        listChats: vi.fn(async () => ({ items: [], hasMore: false }))
      } as any;

      const coordinator = new LarkMessageCoordinator(runtime, service, noopLog, () => 0, 'ou_self_bot', undefined, createMemoryCardMappings() as any, repos.config);
      await coordinator.handle({
        messageId: 'om_both',
        chatId: 'oc_ops',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: '@_user_1 P0 故障请协助' }),
        senderOpenId: 'ou_zhangsan',
        senderType: 'user',
        mentions: [{ key: '@_user_1', name: '值班运维机器人', openId: 'ou_self_bot' }]
      }, botConfig);

      await vi.waitFor(() => expect(dispatches).toHaveLength(1));
      // 再次重复推送同一条 messageId 也绝不再触发
      await coordinator.handle({
        messageId: 'om_both',
        chatId: 'oc_ops',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: '@_user_1 P0 故障请协助' }),
        senderOpenId: 'ou_zhangsan',
        senderType: 'user',
        mentions: [{ key: '@_user_1', name: '值班运维机器人', openId: 'ou_self_bot' }]
      }, botConfig);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(dispatches).toHaveLength(1);
    });

    it('respects ignoreBotMessages and always blocks self-sent bot messages to prevent infinite loops', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const botConfig = makeBotConfig();
      await repos.config.set('lark.bots', JSON.stringify([botConfig]));
      await createLarkRegexTriggerRule(repos.config, [botConfig], {
        name: '忽略机器人规则',
        botId: botConfig.appId,
        chatId: 'oc_ops',
        chatName: '运维群',
        pattern: 'ALERT',
        ignoreBotMessages: true,
        replyMode: 'thread'
      });

      const { runtime, dispatches } = createFakeRuntime();
      const service = {
        reply: vi.fn(async () => ({ messageId: 'om_card', chatId: 'oc_ops' })),
        send: vi.fn(async () => ({ messageId: 'om_card', chatId: 'oc_ops' })),
        update: vi.fn(async () => ({ messageId: 'om_card', chatId: 'oc_ops' })),
        addReaction: vi.fn(async () => ({ messageId: 'om_x', reactionId: 'r1', emojiType: 'OK' })),
        deleteReaction: vi.fn(async () => undefined),
        getUserName: vi.fn(async () => '告警机器人'),
        getChat: vi.fn(async () => ({ chatId: 'oc_ops', name: '运维群', userCount: 5 })),
        listChats: vi.fn(async () => ({ items: [], hasMore: false }))
      } as any;

      const coordinator = new LarkMessageCoordinator(runtime, service, noopLog, () => 0, 'ou_self_bot', undefined, createMemoryCardMappings() as any, repos.config);

      // 其他机器人消息在 ignoreBotMessages=true 时被忽略
      await coordinator.handle({
        messageId: 'om_bot_other',
        chatId: 'oc_ops',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: 'ALERT: CPU 99%' }),
        senderOpenId: 'ou_alert_bot',
        senderType: 'app',
        mentions: []
      }, botConfig);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(dispatches).toHaveLength(0);

      // 即使开启 ignoreBotMessages=false，机器人自己发的消息也绝不自激
      await createLarkRegexTriggerRule(repos.config, [botConfig], {
        name: '允许外部告警机器人',
        botId: botConfig.appId,
        chatId: 'oc_ops',
        chatName: '运维群',
        pattern: 'ALERT',
        ignoreBotMessages: false,
        replyMode: 'thread'
      });
      await coordinator.handle({
        messageId: 'om_self_msg',
        chatId: 'oc_ops',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: 'ALERT: 我自己发的' }),
        senderOpenId: 'ou_self_bot',
        senderType: 'app',
        mentions: []
      }, botConfig);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(dispatches).toHaveLength(0);

      // 外部告警机器人在 ignoreBotMessages=false 规则下可以触发
      await coordinator.handle({
        messageId: 'om_alert_webhook',
        chatId: 'oc_ops',
        chatType: 'group',
        messageType: 'text',
        content: JSON.stringify({ text: 'ALERT: Redis 连接池耗尽' }),
        senderOpenId: 'ou_alert_bot',
        senderType: 'app',
        mentions: []
      }, botConfig);
      await vi.waitFor(() => expect(dispatches).toHaveLength(1));
    });
  });

  describe('HTTP API: chats, messages, rule CRUD, preview, backfill idempotency, and auth', () => {
    it('supports full workflow: list chats, read messages, preview matches, CRUD rules, and idempotent backfill without leaking secrets', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const { runtime, starts, dispatches } = createFakeRuntime();

      const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/open-apis/auth/v3/tenant_access_token/internal/')) {
          return okJson({ code: 0, tenant_access_token: 't-secret-token-xyz123456', expire: 7200 });
        }
        if (url.includes('/open-apis/im/v1/chats?')) {
          const parsed = new URL(url);
          if (!parsed.searchParams.get('page_token')) {
            return okJson({
              code: 0,
              data: {
                items: [{ chat_id: 'oc_ops', name: '线上值班群', description: '告警响应', avatar: 'https://img.example/ops.png', chat_mode: 'group', external: false }],
                has_more: true,
                page_token: 'page_2'
              }
            });
          }
          return okJson({
            code: 0,
            data: {
              items: [{ chat_id: 'oc_dev', name: '产研需求群', chat_mode: 'group', external: false }],
              has_more: false
            }
          });
        }
        if (url.includes('/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_ops')) {
          return okJson({
            code: 0,
            data: {
              items: [
                {
                  message_id: 'om_h2',
                  chat_id: 'oc_ops',
                  msg_type: 'text',
                  create_time: '1732670500000',
                  sender: { id: 'ou_alice', sender_type: 'user', sender_name: '爱丽丝' },
                  body: { content: JSON.stringify({ text: 'P0 告警：订单支付超时 @_user_1' }) },
                  mentions: [{ key: '@_user_1', name: '值班同学', id: 'ou_oncall' }]
                },
                {
                  message_id: 'om_h1',
                  chat_id: 'oc_ops',
                  msg_type: 'text',
                  create_time: '1732670400000',
                  sender: { id: 'ou_bob', sender_type: 'user' },
                  body: { content: JSON.stringify({ text: '早上好，大家辛苦了' }) }
                }
              ],
              has_more: false
            }
          });
        }
        if (url.includes('/open-apis/contact/v3/users/ou_bob')) {
          return okJson({ code: 0, data: { user: { name: '鲍勃' } } });
        }
        if (url.includes('/open-apis/im/v1/images')) {
          return okJson({ code: 0, data: { image_key: 'img_loading' } });
        }
        if (url.includes('/reactions')) {
          return okJson({ code: 0, data: { reaction_id: 'react_1' } });
        }
        if (url.includes('/reply') && init?.method === 'POST') {
          return okJson({ code: 0, data: { message_id: 'om_reply_card_1', chat_id: 'oc_ops' } });
        }
        if (url.includes('/open-apis/im/v1/chats/oc_ops?')) {
          return okJson({ code: 0, data: { name: '线上值班群', user_count: 6 } });
        }
        return okJson({ code: 0, data: {} });
      });

      const app = await buildApp(runtime as any, {
        lark: {
          env: {},
          config: repos.config,
          cardMappings: createMemoryCardMappings() as any,
          fetcher: fetcher as unknown as typeof fetch,
          listener: stubListenerPool(),
          listeningDisabled: true
        }
      });
      apps.push(app);

      // 配置一个完整机器人（含 Agent、模型、工作区、预注入 Prompt）
      await repos.config.set('lark.bots', JSON.stringify([makeBotConfig()]));

      // 1. 拉取群聊列表（all=1 自动跨页汇总）
      const chatsRes = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_ops_bot/chats?all=1' });
      expect(chatsRes.statusCode).toBe(200);
      expect(chatsRes.json().items).toHaveLength(2);
      expect(chatsRes.json().items[0]).toMatchObject({
        chatId: 'oc_ops',
        name: '线上值班群',
        avatar: 'https://img.example/ops.png'
      });
      expect(chatsRes.body).not.toContain('sec_super_secret');
      expect(chatsRes.body).not.toContain('t-secret-token');

      // 2. 读取群聊历史消息（按时间正序 + 补全缺失发送人姓名 + 展开 mention）
      const msgsRes = await app.inject({ method: 'GET', url: '/api/lark/bots/cli_ops_bot/chats/oc_ops/messages?limit=50' });
      expect(msgsRes.statusCode).toBe(200);
      const msgsBody = msgsRes.json();
      expect(msgsBody.items).toHaveLength(2);
      expect(msgsBody.items[0]).toMatchObject({ messageId: 'om_h1', senderName: '鲍勃', text: '早上好，大家辛苦了' });
      expect(msgsBody.items[1]).toMatchObject({ messageId: 'om_h2', senderName: '爱丽丝', text: 'P0 告警：订单支付超时 @值班同学' });
      expect(msgsRes.body).not.toContain('sec_super_secret');
      expect(msgsRes.body).not.toContain('t-secret-token');

      // 3. 预匹配预览接口
      const previewRes = await app.inject({
        method: 'POST',
        url: '/api/lark/regex-triggers/preview',
        payload: {
          pattern: 'P0|超时',
          flags: 'i',
          messages: msgsBody.items.map((m: any) => ({ messageId: m.messageId, text: m.text, senderType: m.senderType }))
        }
      });
      expect(previewRes.statusCode).toBe(200);
      expect(previewRes.json()).toMatchObject({ valid: true, totalCount: 2, matchedCount: 1 });
      expect(previewRes.json().results[1].matches).toEqual([
        { start: 0, end: 2, text: 'P0' },
        { start: 10, end: 12, text: '超时' }
      ]);

      // 4. 创建 / 查询 / 更新 / 删除规则
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/lark/regex-triggers',
        payload: {
          name: '支付告警自动排查',
          botId: 'cli_ops_bot',
          chatId: 'oc_ops',
          chatName: '线上值班群',
          pattern: 'P0|超时',
          flags: 'i',
          replyMode: 'thread',
          promptTemplate: LARK_REGEX_PROMPT_TEMPLATES[0]!.promptTemplate,
          presetId: LARK_REGEX_PROMPT_TEMPLATES[0]!.id
        }
      });
      expect(createRes.statusCode).toBe(201);
      const createdRule = createRes.json().rule;
      expect(createdRule.id).toMatch(/^lrt_/);

      const listRes = await app.inject({ method: 'GET', url: '/api/lark/regex-triggers' });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().rules).toHaveLength(1);
      expect(listRes.json().templates.length).toBeGreaterThanOrEqual(4);
      expect(listRes.json().variables).toEqual(LARK_REGEX_TEMPLATE_VARIABLES);

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/lark/regex-triggers/${createdRule.id}`,
        payload: { enabled: false, replyMode: 'main' }
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().rule).toMatchObject({ enabled: false, replyMode: 'main' });

      // 5. 历史补偿（首次触发成功，第二次幂等跳过，force=true 重新触发）
      const backfillPayload = {
        ruleId: createdRule.id,
        botId: 'cli_ops_bot',
        chatId: 'oc_ops',
        chatName: '线上值班群',
        pattern: 'P0|超时',
        flags: 'i',
        replyMode: 'thread',
        promptTemplate: '请协助定位 {{chatName}} 的 {{matchedText}} 告警',
        messages: [msgsBody.items[1]]
      };
      const bf1 = await app.inject({ method: 'POST', url: '/api/lark/regex-triggers/backfill', payload: backfillPayload });
      expect(bf1.statusCode).toBe(200);
      expect(bf1.json()).toMatchObject({
        triggeredCount: 1,
        skippedCount: 0,
        failedCount: 0,
        results: [{ messageId: 'om_h2', status: 'triggered', sessionId: 'sess_1', cardMessageId: 'om_reply_card_1' }]
      });
      expect(starts[0]).toMatchObject({ agentId: 'claude', model: 'claude-sonnet-4-5', cwd: '/srv/ops-repo' });
      expect(dispatches[0].prompt).toContain('请协助定位 线上值班群 的 P0 | 超时 告警');
      expect(dispatches[0].prompt).toContain('所在群聊：线上值班群（chat_id: oc_ops）');

      // 二次提交同条消息：幂等跳过
      const bf2 = await app.inject({ method: 'POST', url: '/api/lark/regex-triggers/backfill', payload: backfillPayload });
      expect(bf2.statusCode).toBe(200);
      expect(bf2.json()).toMatchObject({
        triggeredCount: 0,
        skippedCount: 1,
        results: [{ messageId: 'om_h2', status: 'skipped', alreadyTriggered: true, sessionId: 'sess_1' }]
      });

      // 显式 force=true：允许再次补偿
      const bf3 = await app.inject({
        method: 'POST',
        url: '/api/lark/regex-triggers/backfill',
        payload: { ...backfillPayload, force: true }
      });
      expect(bf3.statusCode).toBe(200);
      expect(bf3.json().triggeredCount).toBe(1);

      // 删除规则
      const delRes = await app.inject({ method: 'DELETE', url: `/api/lark/regex-triggers/${createdRule.id}` });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json()).toEqual({ deleted: true, id: createdRule.id });
    });

    it('returns clear 403 permission error without leaking tokens and enforces master-only webAuth', async () => {
      const repos = createRepositories(':memory:');
      repositories.push(repos);
      const { runtime } = createFakeRuntime();
      const secret = 'test-web-auth-secret-32-bytes-long!!';

      const fetcher = vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes('/tenant_access_token/')) {
          return okJson({ code: 0, tenant_access_token: 't-sensitive-token-999', expire: 7200 });
        }
        return new Response(JSON.stringify({
          code: 99991672,
          msg: 'Access denied. One of the following scopes is required: im:message:readonly (Bearer t-sensitive-token-999)',
          error: { console_url: 'https://open.feishu.cn/app/cli_ops_bot/auth' }
        }), { status: 403 });
      });

      const app = await buildApp(runtime as any, {
        webAuth: { enabled: true, secret },
        lark: {
          env: {},
          config: repos.config,
          fetcher: fetcher as unknown as typeof fetch,
          listener: stubListenerPool(),
          listeningDisabled: true
        }
      });
      apps.push(app);
      await repos.config.set('lark.bots', JSON.stringify([makeBotConfig()]));

      // 会话级 token 禁止访问正则管理与群消息接口（master-only；用非回环源地址模拟局域网/公网访客）
      const sessionToken = issueSessionToken('sess_1', secret);
      const denied = await app.inject({
        method: 'GET',
        url: '/api/lark/regex-triggers',
        remoteAddress: '192.168.1.50',
        headers: { host: 'dock.example.com', cookie: `agentdock_web_session=${encodeURIComponent(sessionToken)}` }
      });
      expect(denied.statusCode).toBe(403);

      // master token 可以访问，且飞书权限错误被清晰转译、绝不泄露 token/appSecret
      const masterToken = issueMasterToken(secret);
      const permErr = await app.inject({
        method: 'GET',
        url: '/api/lark/bots/cli_ops_bot/chats/oc_ops/messages',
        remoteAddress: '192.168.1.50',
        headers: { host: 'dock.example.com', cookie: `agentdock_web=${encodeURIComponent(masterToken)}` }
      });
      expect(permErr.statusCode).toBe(403);
      expect(permErr.json().error.code).toBe('LARK_PERMISSION_DENIED');
      expect(permErr.json().error.message).toContain('im:message:readonly');
      expect(permErr.body).not.toContain('t-sensitive-token-999');
      expect(permErr.body).not.toContain('sec_super_secret');
    });
  });
});

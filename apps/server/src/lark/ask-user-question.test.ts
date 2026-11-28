import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  extractTrailingAskUserQuestion,
  parseAskUserQuestionAnswer,
  type AgentEvent,
  type AskUserQuestionSpec,
  type ChannelMapping,
  type ChannelMappingRepository,
  type ConfigRepository,
  type Session
} from '@agent-dock/agent-dock-shared';
import { AskUserQuestionService } from '../ask-user-question.js';
import {
  buildLarkAskUserQuestionAnsweredCard,
  buildLarkAskUserQuestionAnsweredFallbackCard,
  buildLarkAskUserQuestionCard,
  buildLarkAskUserQuestionFallbackCard,
  encodeLarkAskOptionValue,
  LARK_ASK_ACTION_OTHER,
  LARK_ASK_ACTION_PICK,
  LARK_ASK_ACTION_PREVIEW,
  LARK_ASK_ACTION_SUBMIT,
  LARK_ASK_CARD_CHANNEL,
  MAX_LARK_ASK_CARD_BYTES,
  MAX_LARK_OPTION_VALUE_LENGTH,
  MAX_LARK_QUICK_PICK_BUTTONS,
  MAX_LARK_SELECT_OPTIONS,
  parseLarkAskUserQuestionAction
} from './ask-user-question-card.js';
import { LarkMessageCoordinator, renderLarkCardElements, toLarkCardCallbackResponse, type LarkMessageEvent, type LarkRuntime } from './listener.js';
import { buildLarkOriginSourceBadge, LarkServiceError, type LarkCardService } from './service.js';
import { registerLarkRoutes } from './routes.js';
import Fastify from 'fastify';
import { OutputPluginService } from '../output-plugins/service.js';
import { defaultHighRiskPattern, saveLarkConfig, type StoredLarkConfig } from './config.js';

function createMemoryConfig(): ConfigRepository {
  const store = new Map<string, string>();
  return {
    get: async key => store.get(key),
    set: async (key, value) => { store.set(key, value); }
  };
}

function createMemoryMappings(): ChannelMappingRepository {
  const store = new Map<string, ChannelMapping>();
  return {
    get: async (channel, externalId) => store.get(`${channel}:${externalId}`),
    list: async channel => [...store.values()].filter(row => row.channel === channel),
    save: async mapping => { store.set(`${mapping.channel}:${mapping.externalId}`, mapping); }
  };
}

const baseBotConfig: StoredLarkConfig = {
  appId: 'cli_test_bot',
  appSecret: 'secret_placeholder',
  name: '测试机器人',
  defaultAgentId: 'codex',
  listening: true,
  groupToolsEnabled: false,
  groupToolsAllowSend: false,
  groupSessionScope: 'user',
  pushIntervalMs: 500,
  hideTraceOnComplete: false,
  quietReply: false,
  allowedUsers: [],
  allowedEmails: [],
  allowedBots: [],
  peerBotsAllowed: true,
  highRiskAllowedUsers: [],
  highRiskAllowedEmails: [],
  highRiskPattern: defaultHighRiskPattern,
  gateEnabled: false,
  softGateEnabled: false,
  hardGateEnabled: false,
  hookTrustConfirmed: false,
  preInjectPrompt: '',
  webBaseUrl: 'http://127.0.0.1:4310'
};

const singleSelectSpec: AskUserQuestionSpec = {
  id: 'ask_db_1',
  title: '选择数据库后端',
  description: '请决定本模块默认落盘方式',
  questions: [{
    id: 'q_db',
    prompt: '采用哪种存储方案？',
    multi: false,
    allowOther: true,
    otherPlaceholder: '填写其他数据库…',
    options: [
      { value: 'sqlite', label: 'SQLite', description: '单文件零运维', recommended: true },
      { value: 'postgres', label: 'PostgreSQL', description: '适合多实例扩展' }
    ]
  }]
};

const multiQuestionSpec: AskUserQuestionSpec = {
  id: 'ask_release_2',
  title: '发布配置确认',
  questions: [
    {
      id: 'q_env',
      prompt: '发布到哪个环境？',
      multi: false,
      allowOther: false,
      options: [
        { value: 'staging', label: '预发环境', recommended: true },
        { value: 'prod', label: '生产环境' }
      ]
    },
    {
      id: 'q_features',
      prompt: '需要开启哪些增强特性？',
      multi: true,
      allowOther: true,
      options: [
        { value: 'trace', label: '链路追踪' },
        { value: 'alert', label: '异常告警' }
      ]
    }
  ]
};

describe('Lark AskUserQuestion Schema 2.0 cards', () => {
  it('builds one-click primary/default buttons + inline other form for single-question single-select', () => {
    const card = buildLarkAskUserQuestionCard({
      cardId: 'askc_demo1',
      spec: singleSelectSpec,
      sessionId: 'ses_1',
      webBaseUrl: 'http://127.0.0.1:4310'
    }) as any;

    expect(card.schema).toBe('2.0');
    expect(card.config.update_multi).toBe(true);
    expect(card.header.template).toBe('blue');

    const buttons = card.body.elements.filter((el: any) => el.tag === 'button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].type).toBe('primary');
    expect(buttons[0].behaviors[0].value).toEqual({
      action: LARK_ASK_ACTION_PICK,
      card_id: 'askc_demo1',
      question_id: 'q_db',
      option_value: 'sqlite'
    });
    expect(buttons[1].type).toBe('default');

    const otherForm = card.body.elements.find((el: any) => el.tag === 'form');
    expect(otherForm).toBeDefined();
    expect(otherForm.elements.some((el: any) => el.tag === 'input' && el.name === 'other_text')).toBe(true);
    expect(otherForm.elements.some((el: any) => el.tag === 'button' && el.form_action_type === 'submit' && el.behaviors[0].value.action === LARK_ASK_ACTION_OTHER)).toBe(true);
  });

  it('builds Schema 2.0 form with select_static, multi_select_static, input, and submit button for multi-question cards', () => {
    const card = buildLarkAskUserQuestionCard({
      cardId: 'askc_demo2',
      spec: multiQuestionSpec
    }) as any;

    expect(card.schema).toBe('2.0');
    const form = card.body.elements.find((el: any) => el.tag === 'form');
    expect(form).toBeDefined();
    expect(form.elements.some((el: any) => el.tag === 'select_static' && el.name === 'q_0_sel' && el.initial_option === 'staging')).toBe(true);
    expect(form.elements.some((el: any) => el.tag === 'multi_select_static' && el.name === 'q_1_sel')).toBe(true);
    expect(form.elements.some((el: any) => el.tag === 'input' && el.name === 'q_1_other')).toBe(true);
    const submitBtn = form.elements.find((el: any) => el.tag === 'button' && el.form_action_type === 'submit');
    expect(submitBtn.behaviors[0].value).toEqual({ action: LARK_ASK_ACTION_SUBMIT, card_id: 'askc_demo2' });
  });

  it('builds locked green answered card with Q&A summary and source/actor attribution', () => {
    const card = buildLarkAskUserQuestionAnsweredCard({
      payload: {
        version: 1,
        questionId: 'ask_db_1',
        title: '选择数据库后端',
        source: 'lark',
        answeredBy: '暮雪离歌',
        answeredAt: '2026-11-27T06:00:00.000Z',
        answers: [{
          questionId: 'q_db',
          prompt: '采用哪种存储方案？',
          selectedValues: ['sqlite'],
          selectedLabels: ['SQLite'],
          otherText: '开启 WAL'
        }]
      }
    }) as any;

    expect(card.schema).toBe('2.0');
    expect(card.header.template).toBe('green');
    expect(card.header.subtitle.content).toContain('飞书');
    expect(card.header.subtitle.content).toContain('暮雪离歌');
    expect(card.body.elements.some((el: any) => el.tag === 'button' || el.tag === 'form')).toBe(false);
    const markdown = card.body.elements.map((el: any) => el.content ?? '').join('\n');
    expect(markdown).toContain('采用哪种存储方案？');
    expect(markdown).toContain('SQLite');
    expect(markdown).toContain('开启 WAL');
  });

  it('parses pick, inline other, and multi-question form submissions with validation', () => {
    expect(parseLarkAskUserQuestionAction(singleSelectSpec, LARK_ASK_ACTION_PICK, {
      question_id: 'q_db',
      option_value: 'postgres'
    })).toEqual({
      ok: true,
      answers: [{
        questionId: 'q_db',
        prompt: '采用哪种存储方案？',
        selectedValues: ['postgres'],
        selectedLabels: ['PostgreSQL']
      }]
    });

    expect(parseLarkAskUserQuestionAction(singleSelectSpec, LARK_ASK_ACTION_OTHER, {
      question_id: 'q_db'
    }, { other_text: 'DuckDB' })).toEqual({
      ok: true,
      answers: [{
        questionId: 'q_db',
        prompt: '采用哪种存储方案？',
        selectedValues: [],
        selectedLabels: [],
        otherText: 'DuckDB'
      }]
    });

    const multiOk = parseLarkAskUserQuestionAction(multiQuestionSpec, LARK_ASK_ACTION_SUBMIT, {}, {
      q_0_sel: 'prod',
      q_1_sel: ['trace', 'alert'],
      q_1_other: '开启灰度'
    });
    expect(multiOk).toEqual({
      ok: true,
      answers: [
        { questionId: 'q_env', prompt: '发布到哪个环境？', selectedValues: ['prod'], selectedLabels: ['生产环境'] },
        { questionId: 'q_features', prompt: '需要开启哪些增强特性？', selectedValues: ['trace', 'alert'], selectedLabels: ['链路追踪', '异常告警'], otherText: '开启灰度' }
      ]
    });

    const missing = parseLarkAskUserQuestionAction(multiQuestionSpec, LARK_ASK_ACTION_SUBMIT, {}, {
      q_0_sel: 'staging'
    });
    expect(missing.ok).toBe(false);
  });

  it('strips trailing XML from completed Lark card elements and masks incomplete streaming XML', () => {
    const completedEvents: AgentEvent[] = [{
      id: 'e1',
      sessionId: 'ses_1',
      sequence: 1,
      type: 'text',
      timestamp: '2026-11-27T00:00:00.000Z',
      data: {
        text: `准备就绪，请选择：\n\n<agentdock-ask-user-question id="a1" title="确认"><question id="q1"><prompt>继续？</prompt><option value="yes">继续</option></question></agentdock-ask-user-question>`
      }
    }];

    const renderedCompleted = renderLarkCardElements(completedEvents, { traceLimit: 50 }, true, false, { askUserQuestionXmlEnabled: true });
    const finalEl = renderedCompleted.find(el => el.element_id === 'final_output');
    expect(finalEl?.content).toContain('准备就绪，请选择：');
    expect(finalEl?.content).not.toContain('<agentdock-ask-user-question');

    // 关闭开关时原样保留文本
    const renderedDisabled = renderLarkCardElements(completedEvents, { traceLimit: 50 }, true, false, { askUserQuestionXmlEnabled: false });
    expect(renderedDisabled.find(el => el.element_id === 'final_output')?.content).toContain('<agentdock-ask-user-question');

    // 流式阶段屏蔽未闭合 XML
    const streamingEvents: AgentEvent[] = [{
      id: 'e2',
      sessionId: 'ses_1',
      sequence: 2,
      type: 'text',
      timestamp: '2026-11-27T00:00:01.000Z',
      data: {
        text: '请确认方向。\n\n<agentdock-ask-user-question id="a2"><question id="q1"><prompt>选'
      }
    }];
    const renderedStreaming = renderLarkCardElements(streamingEvents, { traceLimit: 50 }, false, false, { askUserQuestionXmlEnabled: true });
    const serialized = JSON.stringify(renderedStreaming);
    expect(serialized).toContain('正在生成选项卡片');
    expect(serialized).not.toContain('<agentdock-ask-user-question');
  });
});

describe('LarkMessageCoordinator AskUserQuestion bidirectional flow', () => {
  it('pushes AskUserQuestion interactive card on turn completion and handles idempotent card callback', async () => {
    const configRepo = createMemoryConfig();
    await saveLarkConfig(configRepo, undefined, baseBotConfig);
    const mappings = createMemoryMappings();
    const session: Session = {
      id: 'ses_lark_1',
      agentId: 'codex',
      state: 'idle',
      cwd: '/tmp',
      source: 'lark',
      sourceId: 'cli_test_bot:oc_chat1:group:user:ou_user1',
      runId: 'run_1',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z'
    };

    const subscribers = new Map<string, Set<(event: AgentEvent) => void>>();
    const dispatchCalls: Array<{ prompt: string; agentPrompt?: string; origin?: string; clientMessageId?: string }> = [];
    let taskSeq = 0;

    const runtime: LarkRuntime = {
      start: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async (id: string) => (id === session.id ? session : undefined)),
      send: vi.fn(async () => undefined),
      dispatch: vi.fn(async (
        _sessionId: string,
        prompt: string,
        _mode?: 'queue' | 'interrupt',
        agentPrompt?: string,
        _risk?: unknown,
        origin?: string,
        clientMessageId?: string
      ) => {
        taskSeq += 1;
        const taskId = `task_${taskSeq}`;
        dispatchCalls.push({ prompt, agentPrompt, origin, clientMessageId });
        if (taskSeq === 1) {
          queueMicrotask(() => {
            const listeners = subscribers.get(session.id) ?? new Set();
            const emit = (ev: AgentEvent) => listeners.forEach(fn => fn(ev));
            emit({ id: 'ev_1', sessionId: session.id, sequence: 1, type: 'task', timestamp: '2026-11-27T00:00:01.000Z', data: { task: { id: taskId, status: 'running' } } });
            emit({
              id: 'ev_2',
              sessionId: session.id,
              sequence: 2,
              type: 'text',
              timestamp: '2026-11-27T00:00:02.000Z',
              data: {
                text: `已整理好两个数据库方案：\n\n<agentdock-ask-user-question id="ask_db_1" title="选择数据库后端"><question id="q_db" multi="false" allow-other="true"><prompt>采用哪种存储方案？</prompt><option value="sqlite" recommended="true">SQLite</option><option value="postgres">PostgreSQL</option></question></agentdock-ask-user-question>`
              }
            });
            emit({ id: 'ev_3', sessionId: session.id, sequence: 3, type: 'completed', timestamp: '2026-11-27T00:00:03.000Z', data: {} });
            emit({ id: 'ev_4', sessionId: session.id, sequence: 4, type: 'task', timestamp: '2026-11-27T00:00:03.000Z', data: { task: { id: taskId, status: 'completed' } } });
          });
        }
        return { id: taskId, status: 'queued', queuedAhead: 0 };
      }),
      interrupt: vi.fn(async () => undefined),
      subscribe: (sessionId, listener) => {
        let set = subscribers.get(sessionId);
        if (!set) subscribers.set(sessionId, set = new Set());
        set.add(listener);
        return () => set!.delete(listener);
      }
    };

    const replyInteractiveCalls: Array<{ messageId: string; card: Record<string, unknown>; replyInThread?: boolean }> = [];
    const updateInteractiveCalls: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const service = {
      addReaction: vi.fn(async () => ({ messageId: 'om_1', reactionId: 'react_1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: 'om_progress_1', chatId: 'oc_chat1' })),
      send: vi.fn(async () => ({ messageId: 'om_progress_2', chatId: 'oc_chat1' })),
      update: vi.fn(async () => ({ messageId: 'om_progress_1', chatId: 'oc_chat1' })),
      replyInteractiveCard: vi.fn(async input => {
        replyInteractiveCalls.push(input);
        return { messageId: 'om_ask_card_1', chatId: 'oc_chat1' };
      }),
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_ask_card_2', chatId: 'oc_chat1' })),
      updateInteractiveCard: vi.fn(async input => {
        updateInteractiveCalls.push(input);
        return { messageId: input.messageId, chatId: 'oc_chat1' };
      }),
      getUserName: vi.fn(async () => '暮雪离歌'),
      getChat: vi.fn(async () => ({ chatId: 'oc_chat1', name: '测试群', userCount: 2 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const askService = new AskUserQuestionService({
      config: configRepo,
      channelMappings: mappings,
      runtime: runtime as any
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new LarkMessageCoordinator(
      runtime,
      service,
      log,
      () => 0,
      'ou_bot',
      undefined,
      mappings,
      configRepo,
      askService,
      undefined,
      undefined,
      undefined,
      15
    );

    const incoming: LarkMessageEvent = {
      messageId: 'om_user_msg_1',
      chatId: 'oc_chat1',
      chatType: 'group',
      threadId: 'omt_thread_1',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我选数据库' }),
      senderOpenId: 'ou_user1',
      senderType: 'user',
      mentions: [{ key: '@_user_1', name: '测试机器人', openId: 'ou_bot' }]
    };

    await coordinator.handle(incoming, baseBotConfig);
    // 等待异步 finish / finalizeCard 完成推卡
    await vi.waitFor(() => {
      expect(replyInteractiveCalls).toHaveLength(1);
    });

    // 验证话题回复继承且已持久化映射
    expect(replyInteractiveCalls[0]!.messageId).toBe('om_user_msg_1');
    expect(replyInteractiveCalls[0]!.replyInThread).toBe(true);
    const savedCards = await mappings.list(LARK_ASK_CARD_CHANNEL);
    expect(savedCards).toHaveLength(1);
    const persistedCard = JSON.parse(savedCards[0]!.extra!);
    expect(persistedCard.questionId).toBe('ask_db_1');

    // 预览动作仅返回说明 toast
    const previewRes = await coordinator.handleAction({ action: LARK_ASK_ACTION_PREVIEW }, 'ou_user1');
    expect(previewRes.type).toBe('info');

    // 模拟用户在飞书点击「SQLite」按钮
    const clickRes = await coordinator.handleAction(
      {
        action: LARK_ASK_ACTION_PICK,
        card_id: persistedCard.cardId,
        question_id: 'q_db',
        option_value: 'sqlite'
      },
      'ou_user1',
      { openMessageId: 'om_ask_card_1', openChatId: 'oc_chat1' }
    );
    expect(clickRes.type).toBe('success');

    // 同步回调响应直接携带绿色「已回答」Schema 2.0 锁定卡片（避免回调未结束前先调 PATCH 被飞书覆盖回原卡片）
    const callbackPayload = toLarkCardCallbackResponse(clickRes);
    expect(callbackPayload?.toast).toEqual({ type: 'success', content: clickRes.content });
    expect(callbackPayload?.card?.type).toBe('raw');
    expect((callbackPayload?.card?.data as any)?.schema).toBe('2.0');
    expect((callbackPayload?.card?.data as any)?.config?.update_multi).toBe(true);
    expect((callbackPayload?.card?.data as any)?.header?.template).toBe('green');
    expect(JSON.stringify(callbackPayload?.card?.data)).toContain('暮雪离歌');
    // 回调返回瞬间尚未发起同步 PATCH，消除与回调终态写盘竞态
    expect(updateInteractiveCalls).toHaveLength(0);

    // 回调返回后异步 PATCH 兜底落位，确保超时丢弃同步响应时仍能锁定
    await vi.waitFor(() => {
      expect(updateInteractiveCalls).toHaveLength(1);
    });
    expect(updateInteractiveCalls[0]!.messageId).toBe('om_ask_card_1');
    expect((updateInteractiveCalls[0]!.card as any).header.template).toBe('green');
    expect(JSON.stringify(updateInteractiveCalls[0]!.card)).toContain('暮雪离歌');

    // 驱动了第 2 轮，携带 ASK_USER_QUESTION_ANSWER_ORIGIN 和结构化 source='lark' 载荷
    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[1]!.origin).toBe(ASK_USER_QUESTION_ANSWER_ORIGIN);
    const parsedAnswer = parseAskUserQuestionAnswer(dispatchCalls[1]!.prompt);
    expect(parsedAnswer).toMatchObject({
      questionId: 'ask_db_1',
      source: 'lark',
      answeredBy: '暮雪离歌',
      answers: [{ questionId: 'q_db', selectedValues: ['sqlite'], selectedLabels: ['SQLite'] }]
    });
    expect(dispatchCalls[1]!.agentPrompt).toContain('SQLite (sqlite)');

    // 重复点击同一张卡片：命中幂等，不重复派第 3 轮！
    const dupRes = await coordinator.handleAction(
      {
        action: LARK_ASK_ACTION_PICK,
        card_id: persistedCard.cardId,
        question_id: 'q_db',
        option_value: 'postgres'
      },
      'ou_user1',
      { openMessageId: 'om_ask_card_1' }
    );
    expect(dupRes.type).toBe('info');
    expect(dupRes.content).toContain('已作答');
    expect(dispatchCalls).toHaveLength(2);

    coordinator.stop();
  });

  it('does not push Lark AskUserQuestion card when global XML switch is disabled, and enforces form validation + whitelist', async () => {
    const configRepo = createMemoryConfig();
    await saveLarkConfig(configRepo, undefined, {
      ...baseBotConfig,
      allowedUsers: [{ openId: 'ou_allowed', name: '白名单用户' }]
    });
    const mappings = createMemoryMappings();
    const session: Session = {
      id: 'ses_lark_2',
      agentId: 'codex',
      state: 'idle',
      cwd: '/tmp',
      source: 'lark',
      sourceId: 'cli_test_bot:oc_chat2:group',
      runId: 'run_2',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z'
    };

    const dispatchCalls: Array<{ prompt: string; origin?: string }> = [];
    const runtime: LarkRuntime = {
      start: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async () => session),
      send: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_sid, prompt, _m, _ap, _r, origin) => {
        dispatchCalls.push({ prompt, origin });
        return { id: `task_${dispatchCalls.length}`, status: 'queued', queuedAhead: 0 };
      }),
      interrupt: vi.fn(async () => undefined),
      subscribe: vi.fn(() => vi.fn())
    };

    const updateInteractiveCalls: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const service = {
      addReaction: vi.fn(async () => ({ messageId: 'om_1', reactionId: 'r1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: 'om_p', chatId: 'oc_chat2' })),
      send: vi.fn(async () => ({ messageId: 'om_p2', chatId: 'oc_chat2' })),
      update: vi.fn(async () => ({ messageId: 'om_p', chatId: 'oc_chat2' })),
      replyInteractiveCard: vi.fn(async () => ({ messageId: 'om_multi_card', chatId: 'oc_chat2' })),
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_multi_card', chatId: 'oc_chat2' })),
      updateInteractiveCard: vi.fn(async input => {
        updateInteractiveCalls.push(input);
        return { messageId: input.messageId, chatId: 'oc_chat2' };
      }),
      getUserName: vi.fn(async () => '白名单用户'),
      getChat: vi.fn(async () => ({ chatId: 'oc_chat2', name: '测试群2', userCount: 2 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const askService = new AskUserQuestionService({
      config: configRepo,
      channelMappings: mappings,
      runtime: runtime as any
    });
    const coordinator = new LarkMessageCoordinator(
      runtime,
      service,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => 0,
      'ou_bot',
      undefined,
      mappings,
      configRepo,
      askService,
      undefined,
      undefined,
      undefined,
      15
    );

    // 推送一张多题表单卡片
    const pushed = await coordinator.pushAskUserQuestionCard({
      config: { ...baseBotConfig, allowedUsers: [{ openId: 'ou_allowed', name: '白名单用户' }] },
      sessionId: session.id,
      chatId: 'oc_chat2',
      chatType: 'group',
      spec: multiQuestionSpec
    });
    expect(pushed).toBeDefined();

    // 非白名单操作人被拦截
    const denied = await coordinator.handleAction(
      { action: LARK_ASK_ACTION_SUBMIT, card_id: pushed!.cardId },
      'ou_stranger',
      { formValue: { q_0_sel: 'prod', q_1_sel: ['trace'] } }
    );
    expect(denied.type).toBe('warning');
    expect(denied.content).toContain('白名单');
    expect(dispatchCalls).toHaveLength(0);

    // 白名单用户漏答第 2 题时给出清晰校验提示
    const invalid = await coordinator.handleAction(
      { action: LARK_ASK_ACTION_SUBMIT, card_id: pushed!.cardId },
      'ou_allowed',
      { formValue: { q_0_sel: 'prod' } }
    );
    expect(invalid.type).toBe('warning');
    expect(invalid.content).toContain('第 2 题');
    expect(dispatchCalls).toHaveLength(0);

    // 完整作答（含多选 + 自定义补充）成功提交并锁定卡片
    const ok = await coordinator.handleAction(
      { action: LARK_ASK_ACTION_SUBMIT, card_id: pushed!.cardId },
      'ou_allowed',
      {
        openMessageId: 'om_multi_card',
        formValue: { q_0_sel: 'prod', q_1_sel: ['trace', 'alert'], q_1_other: '灰度 10%' }
      }
    );
    expect(ok.type).toBe('success');
    expect((ok.card as any)?.header?.template).toBe('green');
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.origin).toBe(ASK_USER_QUESTION_ANSWER_ORIGIN);
    expect(parseAskUserQuestionAnswer(dispatchCalls[0]!.prompt)?.answers[1]).toMatchObject({
      selectedValues: ['trace', 'alert'],
      otherText: '灰度 10%'
    });
    expect(updateInteractiveCalls).toHaveLength(0);
    await vi.waitFor(() => {
      expect(updateInteractiveCalls).toHaveLength(1);
    });

    // 关闭全局开关确认持久化生效
    await askService.save({ askUserQuestionXmlEnabled: false });
    expect(await askService.isEnabled()).toBe(false);

    coordinator.stop();
  });

  it('respects per-session askUserQuestionEnabled overrides for outbound Lark cards while keeping historical card callbacks working', async () => {
    const configRepo = createMemoryConfig();
    const mappings = createMemoryMappings();
    await saveLarkConfig(configRepo, undefined, baseBotConfig);

    const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
    const session: Session = {
      id: 'ses_lark_override',
      agentId: 'codex',
      state: 'idle',
      cwd: '/tmp',
      source: 'lark',
      sourceId: 'cli_test_bot:oc_chat_override:group:user:ou_user1',
      askUserQuestionEnabled: false, // 全局默认开启，但本会话显式关闭
      runId: 'run_override',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z'
    };

    const emitToSession = (type: AgentEvent['type'], data: Record<string, unknown>, seq: number) => {
      const event: AgentEvent = {
        id: `evt_ov_${seq}`,
        sessionId: session.id,
        sequence: seq,
        type,
        timestamp: '2026-11-27T00:00:01.000Z',
        data
      };
      for (const listener of listeners.get(session.id) ?? []) listener(event);
    };

    let seq = 0;
    const dispatchCalls: Array<{ prompt: string; origin?: string }> = [];
    const runtime: LarkRuntime = {
      start: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async () => session),
      send: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_id, prompt, _mode, _agentPrompt, _riskPolicy, origin) => {
        dispatchCalls.push({ prompt, origin });
        const taskId = `task_ov_${dispatchCalls.length}`;
        if (origin !== ASK_USER_QUESTION_ANSWER_ORIGIN) {
          queueMicrotask(() => {
            emitToSession('task', { task: { id: taskId, status: 'running' } }, ++seq);
            emitToSession('text', {
              text: `请确认：\n\n<agentdock-ask-user-question id="ask_ov_${dispatchCalls.length}" title="会话级覆写验证">\n  <question id="q1" multi="false" allow-other="false">\n    <prompt>选择方案？</prompt>\n    <option value="a" recommended="true">方案 A</option>\n  </question>\n</agentdock-ask-user-question>`
            }, ++seq);
            emitToSession('completed', {}, ++seq);
            emitToSession('task', { task: { id: taskId, status: 'completed' } }, ++seq);
          });
        }
        return { id: taskId, status: 'queued', queuedAhead: 0 };
      }),
      interrupt: vi.fn(async () => undefined),
      subscribe: (sessionId, listener) => {
        let set = listeners.get(sessionId);
        if (!set) { set = new Set(); listeners.set(sessionId, set); }
        set.add(listener);
        return () => set!.delete(listener);
      }
    };

    const replyInteractiveCalls: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const updateInteractiveCalls: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    const service = {
      addReaction: vi.fn(async () => ({ messageId: 'om_1', reactionId: 'r_1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: 'om_p_ov', chatId: 'oc_chat_override' })),
      send: vi.fn(async () => ({ messageId: 'om_p_ov2', chatId: 'oc_chat_override' })),
      update: vi.fn(async () => ({ messageId: 'om_p_ov', chatId: 'oc_chat_override' })),
      replyInteractiveCard: vi.fn(async input => {
        replyInteractiveCalls.push(input);
        return { messageId: `om_ask_ov_${replyInteractiveCalls.length}`, chatId: 'oc_chat_override' };
      }),
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_ask_ov_send', chatId: 'oc_chat_override' })),
      updateInteractiveCard: vi.fn(async input => {
        updateInteractiveCalls.push(input);
        return { messageId: input.messageId, chatId: 'oc_chat_override' };
      }),
      getUserName: vi.fn(async () => '暮雪离歌'),
      getChat: vi.fn(async () => ({ chatId: 'oc_chat_override', name: '覆写群', userCount: 2 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const askService = new AskUserQuestionService({
      config: configRepo,
      channelMappings: mappings,
      runtime: runtime as any
    });
    const coordinator = new LarkMessageCoordinator(
      runtime,
      service,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => 0,
      'ou_bot',
      undefined,
      mappings,
      configRepo,
      askService,
      undefined,
      undefined,
      undefined,
      15
    );

    // 1) 全局 ON + 会话级 false：不推送飞书询问卡片
    await coordinator.handle({
      messageId: 'om_u_off',
      chatId: 'oc_chat_override',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 测试会话关闭' }),
      senderOpenId: 'ou_user1',
      senderType: 'user',
      mentions: [{ key: '@_user_1', name: '测试机器人', openId: 'ou_bot' }]
    }, baseBotConfig);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(replyInteractiveCalls).toHaveLength(0);

    // 2) 全局 OFF + 会话级 true：显式开启的会话照常推送飞书询问卡片
    await askService.save({ askUserQuestionXmlEnabled: false });
    session.askUserQuestionEnabled = true;
    await coordinator.handle({
      messageId: 'om_u_on',
      chatId: 'oc_chat_override',
      chatType: 'group',
      messageType: 'text',
      content: JSON.stringify({ text: '@_user_1 测试会话开启' }),
      senderOpenId: 'ou_user1',
      senderType: 'user',
      mentions: [{ key: '@_user_1', name: '测试机器人', openId: 'ou_bot' }]
    }, baseBotConfig);
    await vi.waitFor(() => {
      expect(replyInteractiveCalls).toHaveLength(1);
    });

    // 3) 历史已发出的卡片：即使随后把该会话切为 false，回调依然正常作答并回写已答态
    session.askUserQuestionEnabled = false;
    const savedCards = await mappings.list(LARK_ASK_CARD_CHANNEL);
    const persistedCard = JSON.parse(savedCards[0]!.extra!);
    const actionRes = await coordinator.handleAction(
      {
        action: LARK_ASK_ACTION_PICK,
        card_id: persistedCard.cardId,
        question_id: 'q1',
        option_value: 'a'
      },
      'ou_user1',
      { openMessageId: 'om_ask_ov_1', openChatId: 'oc_chat_override' }
    );
    expect(actionRes.type).toBe('success');
    expect((actionRes.card as any)?.header?.template).toBe('green');
    expect(updateInteractiveCalls).toHaveLength(0);
    await vi.waitFor(() => {
      expect(updateInteractiveCalls).toHaveLength(1);
    });

    coordinator.stop();
  });

  it('reproduces 2026-11-28 20:05 rich_text_upgrade_plan JSON-in-XML in Lark reply card rendering, Schema 2.0 form building, and callback parsing', () => {
    const richTextReply = `图里这套富文本渲染体系非常精致，请你拍板两个细节：

<agentdock-ask-user-question>
{
  "id": "rich_text_upgrade_plan",
  "title": "原生富文本渲染升级范围确认",
  "description": "确认一下你想把图里哪些能力做到 AgentDock 里（全部完美适配 20 套亮/暗主题、中英双语、飞书降级可读与 390px 移动端）：",
  "questions": [
    {
      "id": "scope",
      "question": "这次落地范围选哪一档？",
      "options": [
        { "value": "full_rich_text_plus_prompt", "label": "全套原生富文本渲染 + 教 Agent 会主动输出（推荐）", "description": "一次做齐：无框 KPI 指标条、步进时间轴、5 级无框 Callout、荧光高亮/kbd 按键/精致任务清单、紧凑表格（复制/MD切换）、Mermaid 流程图与全屏 Lightbox，并同步接入输出语法提示（飞书同步自动优雅降级）" },
        { "value": "render_only", "label": "只做前端全套富文本渲染器，不改 Agent 提示词", "description": "完整升级 Markdown/富文本前端渲染能力（含上述全部组件与 Lightbox），保持现有 Agent prompt 零 Token 增量" },
        { "value": "rich_text_plus_ipad_chrome", "label": "全套富文本 + 图里的顶部任务胶囊条/底部实时进度条一起评估", "description": "先做全套富文本，同时把图里的顶部运行任务胶囊条与底部实时子任务折叠条纳入后续 UI 规划" }
      ]
    },
    {
      "id": "release_order",
      "question": "跟本地刚验收好的飞书卡片「🕊️ 飞书发起」怎么安排发版？",
      "options": [
        { "value": "ship_0331_first", "label": "先发 0.3.31 上线飞书卡片来源 Tag，再干净基线开工富文本（推荐）", "description": "把已经 246/246 全绿验收完的飞书全来源 Tag 先切 0.3.31 上线，避免大改动堆叠在一个版本里" },
        { "value": "bundle_together", "label": "不急发 0.3.31，直接接着做完富文本再合并发一版", "description": "在当前工作区直接启动富文本任务，做完验收后和飞书卡片来源 Tag 一起发版" }
      ]
    }
  ]
}
</agentdock-ask-user-question>`;

    // 1) 主回复卡片必须剥离原始 XML+JSON 并展示下方交互卡引导
    const rendered = renderLarkCardElements([{
      id: 'e_rich',
      sessionId: 'ses_7437ff6a',
      sequence: 15253,
      type: 'text',
      timestamp: '2026-11-28T12:05:45.666Z',
      data: { text: richTextReply }
    }], { traceLimit: 50 }, true, false, { askUserQuestionXmlEnabled: true });
    const finalEl = rendered.find(el => el.element_id === 'final_output');
    expect(String(finalEl?.content ?? '')).toContain('图里这套富文本渲染体系非常精致');
    expect(String(finalEl?.content ?? '')).toContain('请在下方交互卡片中确认并作答');
    expect(String(finalEl?.content ?? '')).not.toContain('<agentdock-ask-user-question');
    expect(String(finalEl?.content ?? '')).not.toContain('rich_text_upgrade_plan');

    // 2) 构建飞书 Schema 2.0 多题表单卡片，保留 🕊️ 飞书发起 来源 Tag 且体积远小于 24KB
    const extracted = extractTrailingAskUserQuestion(richTextReply);
    expect(extracted).not.toBeNull();
    const card = buildLarkAskUserQuestionCard({
      cardId: 'askc_rich_text',
      spec: extracted!.spec,
      sessionId: 'ses_7437ff6a',
      webBaseUrl: 'http://127.0.0.1:4310',
      sourceBadge: buildLarkOriginSourceBadge('zh-CN')
    }) as any;
    expect(card.schema).toBe('2.0');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThan(MAX_LARK_ASK_CARD_BYTES);
    expect(card.body.elements[0]?.element_id).toBe('task_source_badge');
    expect(String(card.body.elements[0]?.text?.content ?? '')).toContain('🕊️ 飞书发起');
    const form = card.body.elements.find((el: any) => el.tag === 'form');
    expect(form).toBeDefined();
    const selects = form.elements.filter((el: any) => el.tag === 'select_static');
    expect(selects).toHaveLength(2);
    expect(selects[0].options.map((o: any) => o.value)).toEqual([
      'full_rich_text_plus_prompt',
      'render_only',
      'rich_text_plus_ipad_chrome'
    ]);
    expect(selects[1].options.map((o: any) => o.value)).toEqual([
      'ship_0331_first',
      'bundle_together'
    ]);

    // 3) 回调提交能完整还原双题作答
    const parsed = parseLarkAskUserQuestionAction(extracted!.spec, LARK_ASK_ACTION_SUBMIT, {}, {
      q_0_sel: 'full_rich_text_plus_prompt',
      q_1_sel: 'ship_0331_first'
    });
    expect(parsed).toEqual({
      ok: true,
      answers: [
        {
          questionId: 'scope',
          prompt: '这次落地范围选哪一档？',
          selectedValues: ['full_rich_text_plus_prompt'],
          selectedLabels: ['全套原生富文本渲染 + 教 Agent 会主动输出（推荐）']
        },
        {
          questionId: 'release_order',
          prompt: '跟本地刚验收好的飞书卡片「🕊️ 飞书发起」怎么安排发版？',
          selectedValues: ['ship_0331_first'],
          selectedLabels: ['先发 0.3.31 上线飞书卡片来源 Tag，再干净基线开工富文本（推荐）']
        }
      ]
    });
  });

  it('enforces Feishu Schema 2.0 safety limits (long option values, >8 options switch to select_static, 24KB size cap, and bilingual fallback card)', () => {
    const longValue = `very_long_option_value_${'x'.repeat(120)}`;
    const longSpec: AskUserQuestionSpec = {
      id: 'schema2_guard',
      title: 'T'.repeat(90),
      description: 'D'.repeat(700),
      questions: [
        {
          id: 'q_long',
          prompt: 'P'.repeat(450),
          multi: false,
          allowOther: true,
          options: [
            { value: longValue, label: '超长 value 选项', description: '说明'.repeat(300), recommended: true },
            { value: 'short_opt', label: '短选项' }
          ]
        }
      ]
    };

    // 单题超长 option value 自动编码为 <= 80 字符短键，回调无损还原原 value
    const quickCard = buildLarkAskUserQuestionCard({ cardId: 'askc_long', spec: longSpec }) as any;
    const firstBtn = quickCard.body.elements.find((el: any) => el.tag === 'button');
    const encodedVal = firstBtn.behaviors[0].value.option_value;
    expect(encodedVal.length).toBeLessThanOrEqual(MAX_LARK_OPTION_VALUE_LENGTH);
    expect(encodedVal).toBe(encodeLarkAskOptionValue(longValue, 0));
    expect(parseLarkAskUserQuestionAction(longSpec, LARK_ASK_ACTION_PICK, {
      question_id: 'q_long',
      option_value: encodedVal
    })).toEqual({
      ok: true,
      answers: [{
        questionId: 'q_long',
        prompt: longSpec.questions[0]!.prompt,
        selectedValues: [longValue],
        selectedLabels: ['超长 value 选项']
      }]
    });

    // 单题超过 MAX_LARK_QUICK_PICK_BUTTONS 个选项自动切到 select_static 表单且截断在 MAX_LARK_SELECT_OPTIONS 以内
    const manyOptionsSpec: AskUserQuestionSpec = {
      id: 'many_opts',
      title: '超多选项',
      questions: [{
        id: 'q1',
        prompt: '请选择一项',
        multi: false,
        allowOther: false,
        options: Array.from({ length: MAX_LARK_SELECT_OPTIONS + 12 }, (_, i) => ({
          value: i === 0 ? longValue : `opt_${i}`,
          label: `选项 ${i + 1}`,
          description: '详细描述文案 '.repeat(40),
          ...(i === 0 ? { recommended: true } : {})
        }))
      }]
    };
    const manyCard = buildLarkAskUserQuestionCard({ cardId: 'askc_many', spec: manyOptionsSpec }) as any;
    expect(manyCard.body.elements.some((el: any) => el.tag === 'button')).toBe(false);
    const form = manyCard.body.elements.find((el: any) => el.tag === 'form');
    const select = form.elements.find((el: any) => el.tag === 'select_static');
    expect(select.options).toHaveLength(MAX_LARK_SELECT_OPTIONS);
    expect(select.options[0].value.length).toBeLessThanOrEqual(MAX_LARK_OPTION_VALUE_LENGTH);
    expect(select.initial_option).toBe(select.options[0].value);
    expect(Buffer.byteLength(JSON.stringify(manyCard), 'utf8')).toBeLessThanOrEqual(MAX_LARK_ASK_CARD_BYTES);
    expect(parseLarkAskUserQuestionAction(manyOptionsSpec, LARK_ASK_ACTION_SUBMIT, {}, {
      q_0_sel: select.options[0].value
    })).toMatchObject({
      ok: true,
      answers: [{ selectedValues: [longValue], selectedLabels: ['选项 1'] }]
    });

    // 极简降级卡在 en-US 下零中文泄漏，且保留单一 task_source_badge
    const enFallback = buildLarkAskUserQuestionFallbackCard({
      cardId: 'askc_fb_en',
      spec: {
        id: 'fb_en',
        title: 'Choose Mode',
        description: 'Pick one option',
        questions: [{ id: 'q1', prompt: 'Which mode?', multi: false, allowOther: true, options: [{ value: 'fast', label: 'Fast' }] }]
      },
      sessionId: 'ses_en',
      webBaseUrl: 'http://127.0.0.1:4310',
      sourceBadge: buildLarkOriginSourceBadge('en-US'),
      locale: 'en-US'
    }) as any;
    expect(enFallback.schema).toBe('2.0');
    expect(enFallback.body.elements[0]?.element_id).toBe('task_source_badge');
    expect(/[\u4e00-\u9fff]/.test(JSON.stringify(enFallback))).toBe(false);
  });

  it('reproduces 2026-11-28 20:55 herder_engine_decisions (3 questions + single-select combined with otherText): returns sync Schema 2.0 locked card, avoids premature PATCH race, runs deferred PATCH + sibling lock, and handles retry/fallback/observability', async () => {
    const herderSpec: AskUserQuestionSpec = {
      id: 'herder_engine_decisions',
      title: 'Herdr / Herder 双执行引擎关键取舍确认',
      description: '确认以下 3 项架构决策后，立即基于独立 git worktree（../agent-dock-herder）启动双引擎实现：',
      questions: [
        {
          id: 'target_project',
          prompt: '1. 确认第二执行引擎的目标路线？',
          multi: false,
          allowOther: true,
          options: [
            { value: 'herdr_pty', label: '锁定 herdrdev/herdr 作为第二执行引擎（推荐）', recommended: true },
            { value: 'builtin_direct_cli', label: '不引入外部 Herdr，内置直连 CLI 协议驱动' }
          ]
        },
        {
          id: 'read_surface',
          prompt: '2. MVP 的输出读面策略选哪一种？',
          multi: false,
          allowOther: true,
          options: [
            { value: 'pty_first_then_jsonl', label: '先纯 Herdr PTY + 实时终端直连，后续叠 JSONL 旁路（推荐）', recommended: true },
            { value: 'hybrid_from_day1', label: '一步到位：Herdr 控制面 + Claude/Codex JSONL 混合读面' }
          ]
        },
        {
          id: 'session_isolation',
          prompt: '3. Herdr 后台会话（socket）的隔离策略？',
          multi: false,
          allowOther: true,
          options: [
            { value: 'isolated_named_session', label: '默认独占隔离命名会话（推荐，预留接管默认会话开关）', recommended: true },
            { value: 'shared_default_session', label: '直接共享本机默认 Herdr 会话' }
          ]
        }
      ]
    };

    const configRepo = createMemoryConfig();
    await saveLarkConfig(configRepo, undefined, baseBotConfig);
    const mappings = createMemoryMappings();
    const session: Session = {
      id: 'ses_herder_repro',
      agentId: 'codex',
      state: 'idle',
      cwd: '/tmp',
      source: 'lark',
      sourceId: 'cli_test_bot:oc_herder:group',
      runId: 'run_herder',
      createdAt: '2026-11-28T12:47:12.000Z',
      updatedAt: '2026-11-28T12:47:12.000Z'
    };

    const dispatched: Array<{ prompt: string; origin?: string }> = [];
    const runtime: LarkRuntime = {
      start: vi.fn(async () => session),
      listSessions: vi.fn(async () => [session]),
      getSession: vi.fn(async () => session),
      send: vi.fn(async () => undefined),
      dispatch: vi.fn(async (_sid, prompt, _m, _ap, _r, origin) => {
        dispatched.push({ prompt, origin });
        return { id: `task_herder_${dispatched.length}`, status: 'queued', queuedAhead: 0 };
      }),
      interrupt: vi.fn(async () => undefined),
      subscribe: vi.fn(() => vi.fn())
    };

    const patchedCalls: Array<{ messageId: string; card: Record<string, unknown> }> = [];
    let failFirstPrimaryWith230099 = true;
    const service = {
      addReaction: vi.fn(async () => ({ messageId: 'om_1', reactionId: 'r1', emojiType: 'OK' })),
      deleteReaction: vi.fn(async () => undefined),
      reply: vi.fn(async () => ({ messageId: 'om_turn_1', chatId: 'oc_herder' })),
      send: vi.fn(async () => ({ messageId: 'om_turn_2', chatId: 'oc_herder' })),
      update: vi.fn(async () => ({ messageId: 'om_turn_1', chatId: 'oc_herder' })),
      replyInteractiveCard: vi.fn(async () => ({ messageId: 'om_x100b7f989bc54ca0de62b1e61ff7f7e', chatId: 'oc_herder' })),
      sendInteractiveCard: vi.fn(async () => ({ messageId: 'om_x100b7f989bc54ca0de62b1e61ff7f7e', chatId: 'oc_herder' })),
      updateInteractiveCard: vi.fn(async (input: { messageId: string; card: Record<string, unknown> }) => {
        patchedCalls.push(input);
        // 模拟主卡首次 PATCH 触发飞书 230099 Schema 拒收，验证极简锁定兜底卡自动接管
        if (input.messageId === 'om_x100b7f989bc54ca0de62b1e61ff7f7e' && failFirstPrimaryWith230099) {
          failFirstPrimaryWith230099 = false;
          throw new LarkServiceError('LARK_OPENAPI_ERROR', 'Failed to create card content (code: 230099)', 502, {
            upstreamCode: 230099,
            httpStatus: 400
          });
        }
        return { messageId: input.messageId, chatId: 'oc_herder' };
      }),
      getUserName: vi.fn(async () => '暮雪离歌'),
      getChat: vi.fn(async () => ({ chatId: 'oc_herder', name: '小A同学 · AgentDock', userCount: 1 })),
      listChats: vi.fn(async () => ({ items: [], hasMore: false }))
    } as unknown as LarkCardService;

    const askService = new AskUserQuestionService({
      config: configRepo,
      channelMappings: mappings,
      runtime: runtime as any
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const coordinator = new LarkMessageCoordinator(
      runtime,
      service,
      log,
      () => 0,
      'ou_bot',
      undefined,
      mappings,
      configRepo,
      askService,
      undefined,
      undefined,
      undefined,
      20
    );

    const pushed = await coordinator.pushAskUserQuestionCard({
      config: baseBotConfig,
      sessionId: session.id,
      chatId: 'oc_herder',
      chatType: 'group',
      spec: herderSpec
    });
    expect(pushed).toBeDefined();

    // 同时写入一张同题历史重复卡片，验证回调后异步兜底也会把它一并锁定
    await mappings.save({
      id: `${LARK_ASK_CARD_CHANNEL}:askc_sibling_dup`,
      channel: LARK_ASK_CARD_CHANNEL,
      externalId: 'askc_sibling_dup',
      sessionId: session.id,
      extra: JSON.stringify({
        ...pushed!,
        cardId: 'askc_sibling_dup',
        messageId: 'om_sibling_dup_card'
      }),
      createdAt: '2026-11-28T12:47:13.000Z'
    });

    // 模拟 2026-11-28 20:55 现场提交：3 题 + 第 2 题单选叠加自定义补充文本
    const result = await coordinator.handleAction(
      { action: LARK_ASK_ACTION_SUBMIT, card_id: pushed!.cardId },
      'ou_user1',
      {
        openMessageId: 'om_x100b7f989bc54ca0de62b1e61ff7f7e',
        openChatId: 'oc_herder',
        formValue: {
          q_0_sel: 'herdr_pty',
          q_1_sel: 'hybrid_from_day1',
          q_1_other: '只能支持 claude 和 codex 吗？感觉不够啊',
          q_2_sel: 'shared_default_session'
        }
      }
    );

    // 1) 回调响应瞬间即包含飞书 Schema 2.0 `{ toast, card: { type: 'raw', data } }` 锁定完成态卡片
    const cbResp = toLarkCardCallbackResponse(result);
    expect(cbResp?.toast.type).toBe('success');
    expect(cbResp?.card?.type).toBe('raw');
    const syncCard = cbResp?.card?.data as any;
    expect(syncCard.schema).toBe('2.0');
    expect(syncCard.config.update_multi).toBe(true);
    expect(syncCard.header.template).toBe('green');
    expect(syncCard.body.elements.some((el: any) => el.tag === 'form' || el.tag === 'button')).toBe(false);
    expect(syncCard.body.elements.filter((el: any) => el.element_id === 'task_source_badge')).toHaveLength(1);
    const serializedSync = JSON.stringify(syncCard);
    expect(serializedSync).toContain('锁定 herdrdev/herdr 作为第二执行引擎（推荐）');
    expect(serializedSync).toContain('一步到位：Herdr 控制面 + Claude/Codex JSONL 混合读面');
    expect(serializedSync).toContain('只能支持 claude 和 codex 吗？感觉不够啊');
    expect(serializedSync).toContain('直接共享本机默认 Herdr 会话');

    // 2) 绝对不在同步回调返回前抢先发 PATCH（根除被飞书表单终态覆盖回原卡片的竞态）
    expect(patchedCalls).toHaveLength(0);

    // 3) 回调返回后异步 PATCH 兜底执行：主卡遇到 230099 自动降级极简锁定卡重试成功，同时锁定兄弟重复卡
    await vi.waitFor(() => {
      expect(patchedCalls).toHaveLength(3);
    });
    expect(patchedCalls[0]!.messageId).toBe('om_x100b7f989bc54ca0de62b1e61ff7f7e');
    expect(patchedCalls[1]!.messageId).toBe('om_x100b7f989bc54ca0de62b1e61ff7f7e');
    expect((patchedCalls[1]!.card as any).header.template).toBe('green');
    expect(patchedCalls[2]!.messageId).toBe('om_sibling_dup_card');
    expect((patchedCalls[2]!.card as any).header.template).toBe('green');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'om_x100b7f989bc54ca0de62b1e61ff7f7e', pluginId: 'builtin:ask-user-question' }),
      expect.stringContaining('极简锁定卡')
    );

    // 4) 超大 otherText 触发体积护栏，始终安全控制在 MAX_LARK_ASK_CARD_BYTES 以内且极简回显卡保持合法
    const hugeAnswered = buildLarkAskUserQuestionAnsweredCard({
      payload: {
        version: 1,
        questionId: 'herder_engine_decisions',
        title: herderSpec.title,
        source: 'lark',
        answeredBy: '暮雪离歌',
        answeredAt: '2026-11-28T12:55:47.899Z',
        answers: herderSpec.questions.map(q => ({
          questionId: q.id,
          prompt: q.prompt,
          selectedValues: [q.options[0]!.value],
          selectedLabels: [q.options[0]!.label],
          otherText: '补充说明内容 '.repeat(2_000)
        }))
      }
    });
    expect(Buffer.byteLength(JSON.stringify(hugeAnswered), 'utf8')).toBeLessThanOrEqual(MAX_LARK_ASK_CARD_BYTES);
    const fallbackCard = buildLarkAskUserQuestionAnsweredFallbackCard({
      payload: {
        version: 1,
        questionId: 'herder_engine_decisions',
        title: herderSpec.title,
        source: 'lark',
        answeredBy: '暮雪离歌',
        answeredAt: '2026-11-28T12:55:47.899Z',
        answers: [{ questionId: 'read_surface', prompt: 'Q2', selectedValues: ['hybrid_from_day1'], selectedLabels: ['混合读面'], otherText: '只能支持 claude 和 codex 吗？' }]
      }
    }) as any;
    expect(fallbackCard.schema).toBe('2.0');
    expect(fallbackCard.config.update_multi).toBe(true);
    expect(fallbackCard.header.template).toBe('green');

    coordinator.stop();
  });

  it('reverse-updates Lark interactive cards for both Web and Assistant (小猫代答) submissions via registerLarkRoutes', async () => {
    const configRepo = createMemoryConfig();
    await saveLarkConfig(configRepo, undefined, { ...baseBotConfig, listening: false });
    const mappings = createMemoryMappings();
    const session: Session = {
      id: 'ses_cross_end',
      agentId: 'codex',
      state: 'idle',
      cwd: '/tmp',
      runId: 'run_cross',
      createdAt: '2026-11-28T12:00:00.000Z',
      updatedAt: '2026-11-28T12:00:00.000Z'
    };
    const runtime = {
      getSession: vi.fn(async () => session),
      dispatch: vi.fn(async () => ({ id: 't_cross', sessionId: session.id, prompt: '', status: 'queued', createdAt: '', updatedAt: '' }))
    };
    const outputPlugins = new OutputPluginService({
      config: configRepo,
      channelMappings: mappings,
      runtime: runtime as any,
      disableLocalPlugins: true
    });

    await mappings.save({
      id: `${LARK_ASK_CARD_CHANNEL}:askc_assistant_1`,
      channel: LARK_ASK_CARD_CHANNEL,
      externalId: 'askc_assistant_1',
      sessionId: session.id,
      extra: JSON.stringify({
        cardId: 'askc_assistant_1',
        pluginId: 'builtin:ask-user-question',
        appId: baseBotConfig.appId,
        chatId: 'oc_chat_cross',
        chatType: 'group',
        messageId: 'om_card_assistant_1',
        sessionId: session.id,
        instanceId: 'q_assistant_answer',
        questionId: 'q_assistant_answer',
        spec: singleSelectSpec,
        webBaseUrl: baseBotConfig.webBaseUrl,
        createdAt: '2026-11-28T12:00:00.000Z'
      }),
      createdAt: '2026-11-28T12:00:00.000Z'
    });

    const patched: Array<{ url: string; card: Record<string, unknown> }> = [];
    const mockFetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't_mock', expire: 7200 }), { status: 200 });
      }
      if (url.includes('/im/v1/messages/') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body ?? '{}')) as { content?: string };
        patched.push({ url, card: JSON.parse(body.content ?? '{}') as Record<string, unknown> });
        return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_card_assistant_1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const app = Fastify({ logger: false });
    await registerLarkRoutes(app, {
      config: configRepo,
      cardMappings: mappings,
      outputPlugins,
      fetcher: mockFetcher,
      listeningDisabled: true
    });

    try {
      const res = await outputPlugins.submitInteraction({
        pluginId: 'builtin:ask-user-question',
        sessionId: session.id,
        instanceId: 'q_assistant_answer',
        title: '选择数据库后端',
        source: 'assistant',
        responderName: '小A同学',
        answers: [{
          questionId: 'q_db',
          prompt: '采用哪种存储方案？',
          selectedValues: ['sqlite'],
          selectedLabels: ['SQLite']
        }]
      });
      expect(res.status).toBe('submitted');
      expect(patched).toHaveLength(1);
      expect(patched[0]!.url).toContain('om_card_assistant_1');
      expect((patched[0]!.card as any).header.template).toBe('green');
      expect(JSON.stringify(patched[0]!.card)).toContain('小A同学');
    } finally {
      await app.close();
    }
  });
});

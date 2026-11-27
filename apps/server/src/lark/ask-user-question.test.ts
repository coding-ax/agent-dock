import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
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
  buildLarkAskUserQuestionCard,
  LARK_ASK_ACTION_OTHER,
  LARK_ASK_ACTION_PICK,
  LARK_ASK_ACTION_PREVIEW,
  LARK_ASK_ACTION_SUBMIT,
  LARK_ASK_CARD_CHANNEL,
  parseLarkAskUserQuestionAction
} from './ask-user-question-card.js';
import { LarkMessageCoordinator, renderLarkCardElements, type LarkMessageEvent, type LarkRuntime } from './listener.js';
import type { LarkCardService } from './service.js';
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
      askService
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

    // 原飞书卡片被立即回写为绿色「已回答」锁定态
    expect(updateInteractiveCalls).toHaveLength(1);
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
      askService
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
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]!.origin).toBe(ASK_USER_QUESTION_ANSWER_ORIGIN);
    expect(parseAskUserQuestionAnswer(dispatchCalls[0]!.prompt)?.answers[1]).toMatchObject({
      selectedValues: ['trace', 'alert'],
      otherText: '灰度 10%'
    });
    expect(updateInteractiveCalls).toHaveLength(1);

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
      askService
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
    expect(updateInteractiveCalls).toHaveLength(1);

    coordinator.stop();
  });
});

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASK_USER_QUESTION_XML_TAG,
  parseAskUserQuestionAnswer,
  type ChannelMapping,
  type ChannelMappingRepository,
  type ConfigRepository,
  type Session,
  type TaskRecord
} from '@agent-dock/agent-dock-shared';
import { AskUserQuestionService, registerAskUserQuestionRoutes } from './ask-user-question.js';
import { buildApp } from './app.js';
import { sessionTokenAllows } from './web-access.js';

function createMemoryConfig(): ConfigRepository {
  const store = new Map<string, string>();
  return {
    get: async key => store.get(key),
    set: async (key, value) => { store.set(key, value); }
  };
}

function createMemoryChannelMappings(): ChannelMappingRepository {
  const rows = new Map<string, ChannelMapping>();
  return {
    get: async (channel, externalId) => rows.get(`${channel}:${externalId}`),
    list: async channel => [...rows.values()].filter(row => row.channel === channel),
    save: async mapping => { rows.set(`${mapping.channel}:${mapping.externalId}`, mapping); }
  };
}

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  agentId: 'codex',
  state: 'completed',
  cwd: '/tmp',
  runId: 'run_1',
  createdAt: '2026-11-27T00:00:00.000Z',
  updatedAt: '2026-11-27T00:00:00.000Z',
  ...overrides
});

describe('AskUserQuestionService', () => {
  it('defaults to enabled, persists toggle changes, and gates XML prompt injection', async () => {
    const config = createMemoryConfig();
    const service = new AskUserQuestionService({ config });

    expect(await service.state()).toEqual({
      configured: false,
      config: { askUserQuestionXmlEnabled: true }
    });
    expect(await service.isEnabled()).toBe(true);

    // 首轮注入 XML 协议提示词，次轮不重复注入
    const session = makeSession();
    const firstTurn = await service.promptForSession(session, '帮我设计方案');
    expect(firstTurn).toContain('[AgentDock 用户询问卡片协议]');
    expect(firstTurn).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
    expect(firstTurn.endsWith('帮我设计方案')).toBe(true);

    const secondTurn = await service.promptForSession(session, '继续');
    expect(secondTurn).toBe('继续');

    // 非交互来源与系统轮次不注入
    expect(await service.promptForSession(makeSession({ id: 'ses_router', source: 'router' }), 'test')).toBe('test');
    expect(await service.promptForSession(makeSession({ id: 'ses_new' }), 'sys', 'maintenance')).toBe('sys');

    // 关闭后：已注入过的会话下发一次简短停用提醒，新会话完全不注入
    const updated = await service.save({ askUserQuestionXmlEnabled: false });
    expect(updated).toEqual({ configured: true, config: { askUserQuestionXmlEnabled: false } });
    expect(await service.isEnabled()).toBe(false);

    const afterDisableExisting = await service.promptForSession(session, '下一步');
    expect(afterDisableExisting).toContain('用户询问卡片协议已关闭');
    expect(await service.promptForSession(session, '再下一步')).toBe('再下一步');

    const freshWhileDisabled = await service.promptForSession(makeSession({ id: 'ses_fresh' }), '你好');
    expect(freshWhileDisabled).toBe('你好');
  });

  it('enforces idempotency across repeated answers and notifies cross-channel listeners', async () => {
    const config = createMemoryConfig();
    const channelMappings = createMemoryChannelMappings();
    const dispatched: Array<{ sessionId: string; prompt: string; agentPrompt?: string; origin?: string; clientMessageId?: string }> = [];
    const tasks: TaskRecord[] = [];
    const runtime = {
      getSession: vi.fn(async (id: string) => (id === 'ses_1' ? makeSession({ id }) : undefined)),
      getTasks: vi.fn(async () => tasks),
      dispatch: vi.fn(async (
        sessionId: string,
        prompt: string,
        _mode?: 'queue' | 'interrupt',
        agentPrompt?: string,
        _risk?: unknown,
        origin?: string,
        clientMessageId?: string
      ) => {
        dispatched.push({ sessionId, prompt, agentPrompt, origin, clientMessageId });
        const record: TaskRecord = {
          id: `task_${dispatched.length}`,
          sessionId,
          prompt,
          sentPrompt: agentPrompt,
          status: 'queued',
          origin: origin ?? null,
          createdAt: '2026-11-27T00:01:00.000Z',
          updatedAt: '2026-11-27T00:01:00.000Z'
        };
        tasks.push(record);
        return { ...record, queuedAhead: 0 };
      })
    };

    const service = new AskUserQuestionService({ config, channelMappings, runtime });
    const answeredEvents: Array<{ sessionId: string; questionId: string; source: string }> = [];
    service.onAnswered((sessionId, payload) => {
      answeredEvents.push({ sessionId, questionId: payload.questionId, source: payload.source });
    });

    const first = await service.submitAnswer({
      sessionId: 'ses_1',
      questionId: 'ask_db',
      title: '数据库选型',
      source: 'web',
      answers: [{
        questionId: 'q1',
        prompt: '使用哪种数据库？',
        selectedValues: ['sqlite'],
        selectedLabels: ['SQLite']
      }]
    });

    expect(first.status).toBe('answered');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.origin).toBe(ASK_USER_QUESTION_ANSWER_ORIGIN);
    expect(parseAskUserQuestionAnswer(dispatched[0]!.prompt)?.questionId).toBe('ask_db');
    expect(dispatched[0]!.agentPrompt).toContain('SQLite (sqlite)');
    expect(answeredEvents).toEqual([{ sessionId: 'ses_1', questionId: 'ask_db', source: 'web' }]);

    // 第二次提交（即便来自飞书）直接命中幂等，不再派发新轮次
    const duplicate = await service.submitAnswer({
      sessionId: 'ses_1',
      questionId: 'ask_db',
      source: 'lark',
      answeredBy: '测试用户',
      answers: [{
        questionId: 'q1',
        prompt: '使用哪种数据库？',
        selectedValues: ['postgres'],
        selectedLabels: ['PostgreSQL']
      }]
    });
    expect(duplicate.status).toBe('already_answered');
    if (duplicate.status === 'already_answered') {
      expect(duplicate.existing.source).toBe('web');
      expect(duplicate.existing.answers[0]!.selectedValues).toEqual(['sqlite']);
    }
    expect(dispatched).toHaveLength(1);
  });

  it('exposes HTTP config + answer routes and allows GET config for session tokens', async () => {
    const config = createMemoryConfig();
    const channelMappings = createMemoryChannelMappings();
    const runtime = {
      getSession: vi.fn(async (id: string) => (id === 'ses_1' ? makeSession({ id }) : undefined)),
      getTasks: vi.fn(async () => []),
      dispatch: vi.fn(async (sessionId: string, prompt: string) => ({
        id: 'task_web_1',
        sessionId,
        prompt,
        status: 'queued',
        origin: ASK_USER_QUESTION_ANSWER_ORIGIN,
        createdAt: '2026-11-27T00:01:00.000Z',
        updatedAt: '2026-11-27T00:01:00.000Z',
        queuedAhead: 0
      }))
    };

    const service = new AskUserQuestionService({ config, channelMappings, runtime });
    const app = Fastify();
    registerAskUserQuestionRoutes(app, service);

    const getRes = await app.inject({ method: 'GET', url: '/api/ask-user-question/config' });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({ configured: false, config: { askUserQuestionXmlEnabled: true } });

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/ask-user-question/config',
      payload: { askUserQuestionXmlEnabled: false }
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json()).toEqual({ configured: true, config: { askUserQuestionXmlEnabled: false } });

    const answerRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/ask-user-question/answer',
      payload: {
        questionId: 'ask_1',
        title: '确认部署',
        answers: [{ questionId: 'q1', prompt: '环境？', selectedValues: ['prod'], selectedLabels: ['生产'] }]
      }
    });
    expect(answerRes.statusCode).toBe(202);
    expect(answerRes.json().accepted).toBe(true);

    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/ask-user-question/answer',
      payload: {
        questionId: 'ask_1',
        answers: [{ questionId: 'q1', prompt: '环境？', selectedValues: ['prod'], selectedLabels: ['生产'] }]
      }
    });
    expect(duplicateRes.statusCode).toBe(409);
    expect(duplicateRes.json().alreadyAnswered).toBe(true);

    // 会话级 token 允许只读拉取配置，禁止写配置
    expect(sessionTokenAllows('GET', '/api/ask-user-question/config', 'ses_1')).toBe(true);
    expect(sessionTokenAllows('PUT', '/api/ask-user-question/config', 'ses_1')).toBe(false);
    expect(sessionTokenAllows('POST', '/api/sessions/ses_1/ask-user-question/answer', 'ses_1')).toBe(true);
    expect(sessionTokenAllows('PATCH', '/api/sessions/ses_1/config', 'ses_1')).toBe(true);

    await app.close();
  });

  it('honors session-level askUserQuestionEnabled overrides (true/false/null) for prompt injection and HTTP config routes', async () => {
    const config = createMemoryConfig();
    const service = new AskUserQuestionService({ config });

    // 全局开启时，会话显式 false 直接阻断 XML 协议注入
    const sessionOff = makeSession({ id: 'ses_override_off', askUserQuestionEnabled: false });
    expect(await service.isEnabledForSession(sessionOff)).toBe(false);
    expect(await service.promptForSession(sessionOff, '请帮我排查问题')).toBe('请帮我排查问题');

    // 先按全局开启注入，随后会话级切为 false：下发一次性停用提醒后恢复透传
    const sessionToggle = makeSession({ id: 'ses_toggle', askUserQuestionEnabled: null });
    expect(await service.promptForSession(sessionToggle, '第一轮')).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
    const afterSessionOff = await service.promptForSession({ ...sessionToggle, askUserQuestionEnabled: false }, '第二轮');
    expect(afterSessionOff).toContain('用户询问卡片协议已关闭');
    expect(await service.promptForSession({ ...sessionToggle, askUserQuestionEnabled: false }, '第三轮')).toBe('第三轮');

    // 全局关闭时，会话显式 true 仍可单独启用并注入 XML 协议
    await service.save({ askUserQuestionXmlEnabled: false });
    const sessionOn = makeSession({ id: 'ses_override_on', askUserQuestionEnabled: true });
    expect(await service.isEnabledForSession(sessionOn)).toBe(true);
    expect(await service.promptForSession(sessionOn, '帮我做个选型')).toContain(`<${ASK_USER_QUESTION_XML_TAG}`);
    expect(await service.isEnabledForSession(makeSession({ id: 'ses_follow_off', askUserQuestionEnabled: null }))).toBe(false);

    // 验证 POST /api/sessions 与 PATCH /api/sessions/:id/config 透传与快速切换（绝不触碰 setModel/setReasoningEffort）
    const baseSession = makeSession({ id: 'ses_cfg_fast', askUserQuestionEnabled: null });
    const runtime: any = {
      start: vi.fn(async (input: Record<string, unknown>) => ({ ...baseSession, ...input })),
      setModel: vi.fn(async () => baseSession),
      setReasoningEffort: vi.fn(async () => baseSession),
      setAskUserQuestionEnabled: vi.fn(async (_id: string, enabled: boolean | null) => ({ ...baseSession, askUserQuestionEnabled: enabled })),
      getSessionConfigOptions: vi.fn(() => undefined)
    };
    const app = await buildApp(runtime, { askUserQuestion: service });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { agentId: 'codex', askUserQuestionEnabled: false }
      });
      expect(created.statusCode).toBe(200);
      expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', askUserQuestionEnabled: false }));

      const invalidCreate = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { agentId: 'codex', askUserQuestionEnabled: 'nope' }
      });
      expect(invalidCreate.statusCode).toBe(400);

      const patchedFalse = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/ses_cfg_fast/config',
        payload: { askUserQuestionEnabled: false }
      });
      expect(patchedFalse.statusCode).toBe(200);
      expect(patchedFalse.json()).toMatchObject({ id: 'ses_cfg_fast', askUserQuestionEnabled: false });
      expect(runtime.setAskUserQuestionEnabled).toHaveBeenCalledWith('ses_cfg_fast', false);
      expect(runtime.setModel).not.toHaveBeenCalled();
      expect(runtime.setReasoningEffort).not.toHaveBeenCalled();

      const patchedNull = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/ses_cfg_fast/config',
        payload: { askUserQuestionEnabled: null }
      });
      expect(patchedNull.statusCode).toBe(200);
      expect(patchedNull.json()).toMatchObject({ id: 'ses_cfg_fast', askUserQuestionEnabled: null });
      expect(runtime.setAskUserQuestionEnabled).toHaveBeenCalledWith('ses_cfg_fast', null);

      const invalidPatch = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/ses_cfg_fast/config',
        payload: { askUserQuestionEnabled: 'bad' }
      });
      expect(invalidPatch.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

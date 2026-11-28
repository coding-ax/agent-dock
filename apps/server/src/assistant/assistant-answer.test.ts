import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import {
  ASK_USER_QUESTION_ANSWER_ORIGIN,
  ASSISTANT_REPLY_ORIGIN,
  BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
  BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
  CONFIRM_ACTION_INTERACTION_ORIGIN,
  now,
  parseAskUserQuestionAnswer,
  parseConfirmActionInteraction,
  type RepositoryBundle,
  type Session,
  type TaskRecord
} from '@agent-dock/agent-dock-shared';
import { OutputPluginService, registerOutputPluginRoutes } from '../output-plugins/service.js';
import { AskUserQuestionService, registerAskUserQuestionRoutes } from '../ask-user-question.js';
import { createCliProgram } from '../cli-program.js';
import { buildLarkAskUserQuestionAnsweredCard } from '../lark/ask-user-question-card.js';
import { confirmActionLarkAdapter } from '../lark/output-plugins/confirm-action-adapter.js';
import { AssistantService, buildMainSystemPrompt } from './service.js';
import { registerAssistantRoutes } from './routes.js';
import { parseQuickAnswerArg } from './cli.js';

const repositories: RepositoryBundle[] = [];
const services: AssistantService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const repos of repositories.splice(0)) repos.close();
});

function createHarness() {
  const repos = createRepositories(':memory:');
  repositories.push(repos);
  const dispatched: Array<{
    sessionId: string;
    prompt: string;
    mode?: string;
    agentPrompt?: string;
    origin?: string;
    clientMessageId?: string;
  }> = [];
  const tasksBySession = new Map<string, TaskRecord[]>();

  const runtime = {
    onStatus: () => () => undefined,
    start: vi.fn(async (input: { agentId: string; cwd?: string; source?: string; sourceId?: string }) => {
      const session: Session = {
        id: 'ses_side',
        agentId: input.agentId,
        state: 'idle',
        cwd: input.cwd ?? '/tmp',
        runId: 'run_side',
        source: input.source,
        sourceId: input.sourceId,
        createdAt: now(),
        updatedAt: now()
      };
      await repos.sessions.save(session);
      return session;
    }),
    getSession: (id: string) => repos.sessions.get(id),
    dispatch: vi.fn(async (
      id: string,
      prompt: string,
      mode?: 'queue' | 'interrupt',
      agentPrompt?: string,
      _risk?: unknown,
      origin?: string,
      clientMessageId?: string
    ) => {
      dispatched.push({ sessionId: id, prompt, mode, agentPrompt, origin, clientMessageId });
      const record: TaskRecord = {
        id: `task_${dispatched.length}`,
        sessionId: id,
        prompt,
        sentPrompt: agentPrompt ?? prompt,
        status: 'queued',
        origin: origin ?? null,
        createdAt: now(),
        updatedAt: now()
      };
      const list = tasksBySession.get(id) ?? [];
      list.push(record);
      tasksBySession.set(id, list);
      await repos.tasks.save(record);
      return record;
    }),
    getTasks: vi.fn(async (id: string) => tasksBySession.get(id) ?? []),
    stop: vi.fn(async () => undefined)
  };

  const outputPlugins = new OutputPluginService({
    config: repos.config,
    channelMappings: repos.channelMappings,
    runtime: runtime as never,
    disableLocalPlugins: true
  });
  const assistant = new AssistantService({
    databaseUrl: ':memory:',
    runtime: runtime as never,
    repos,
    outputPlugins
  });
  services.push(assistant);
  const completePendingTasks = async (sessionId: string) => {
    const list = tasksBySession.get(sessionId) ?? [];
    for (const item of list) {
      if (item.status === 'queued' || item.status === 'running') {
        item.status = 'completed';
        item.updatedAt = now();
        await repos.tasks.save(item);
      }
    }
  };

  return { repos, runtime, outputPlugins, assistant, dispatched, completePendingTasks };
}

describe('🐾 小猫代答侧边提问后端闭环', () => {
  it('surfaces unanswered AskUserQuestion and ConfirmAction widget summaries in [review] signals', async () => {
    const { repos, assistant, dispatched, completePendingTasks } = createHarness();
    await assistant.initialize();
    const main: Session = {
      id: 'ses_main',
      agentId: 'claude',
      state: 'idle',
      cwd: '/tmp',
      runId: 'run_main',
      source: 'assistant-main',
      createdAt: now(),
      updatedAt: now()
    };
    await repos.sessions.save(main);
    await assistant.setMainSession(main.id);

    const task = await assistant.startTask({ title: '设计持久化层', doneWhen: ['完成选型并落地'], agentId: 'claude' });
    const sideId = task.sessionId!;

    await repos.events.append({ id: 'e1', sessionId: sideId, sequence: 1, type: 'text', timestamp: now(), data: { role: 'user', text: '开始做' } });
    await repos.events.append({
      id: 'e2',
      sessionId: sideId,
      sequence: 2,
      type: 'text',
      timestamp: now(),
      data: {
        role: 'assistant',
        text: `已整理两个方案，请拍板：\n\n<agentdock-ask-user-question id="ask_db" title="选择存储方案">\n  <question id="q1" multi="false" allow-other="true">\n    <prompt>希望采用哪种持久化方案？</prompt>\n    <option value="sqlite" recommended="true">SQLite</option>\n    <option value="postgres">PostgreSQL</option>\n  </question>\n</agentdock-ask-user-question>`
      }
    });

    await completePendingTasks(sideId);
    await assistant.handleStatus({ sessionId: sideId, state: 'completed' });
    await assistant.flushNow();

    const reviewDispatch = dispatched.at(-1)!;
    expect(reviewDispatch.sessionId).toBe(main.id);
    expect(reviewDispatch.origin).toBe('injected');
    const reviewLine = reviewDispatch.agentPrompt!.split('\n').find(line => line.startsWith('- [review] '))!;
    expect(reviewLine).toContain('待答询问卡 widgetId=ask_db「选择存储方案」');
    expect(reviewLine).toContain('Q1(q1) 希望采用哪种持久化方案？');
    expect(reviewLine).toContain('sqlite=SQLite(推荐)');
    expect(reviewLine).toContain('postgres=PostgreSQL');
    expect(reviewLine).toContain(`agent-dock task answer ${task.id} --widget ask_db`);
    expect(reviewLine.endsWith(`（${task.id}）`)).toBe(true);

    // 确认 ConfirmAction 卡片同样能被透出
    await repos.events.append({ id: 'e3', sessionId: sideId, sequence: 3, type: 'text', timestamp: now(), data: { role: 'user', text: '继续' } });
    await repos.events.append({
      id: 'e4',
      sessionId: sideId,
      sequence: 4,
      type: 'text',
      timestamp: now(),
      data: {
        role: 'assistant',
        text: `准备执行清理：\n\n<agentdock-confirm-action id="confirm_clean" title="清理本地缓存" risk="low" confirm-label="确认清理" cancel-label="跳过">\n  <summary>清理 dist 构建缓存目录</summary>\n  <command>rm -rf dist</command>\n</agentdock-confirm-action>`
      }
    });
    const pendingConfirm = await assistant.getPendingTaskInteraction(task.id);
    expect(pendingConfirm).toMatchObject({
      pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
      widgetId: 'confirm_clean',
      title: '清理本地缓存'
    });
  });

  it('submits source="assistant" AskUserQuestion and ConfirmAction answers idempotently via routes and resumes task', async () => {
    const { repos, assistant, outputPlugins, dispatched, completePendingTasks } = createHarness();
    await assistant.initialize();
    const main: Session = {
      id: 'ses_main',
      agentId: 'claude',
      state: 'idle',
      cwd: '/tmp',
      runId: 'run_main',
      source: 'assistant-main',
      createdAt: now(),
      updatedAt: now()
    };
    await repos.sessions.save(main);
    await assistant.setMainSession(main.id);
    await assistant.renameCompanion('小A同学');

    const task = await assistant.startTask({ title: '确认存储方案', doneWhen: ['完成选型'], agentId: 'claude' });
    const sideId = task.sessionId!;
    await repos.events.append({ id: 'e1', sessionId: sideId, sequence: 1, type: 'text', timestamp: now(), data: { role: 'user', text: '开始' } });
    await repos.events.append({
      id: 'e2',
      sessionId: sideId,
      sequence: 2,
      type: 'text',
      timestamp: now(),
      data: {
        role: 'assistant',
        text: `请确认：\n\n<agentdock-ask-user-question id="ask_storage" title="选择存储方案">\n  <question id="q1" multi="false" allow-other="true">\n    <prompt>选择哪个数据库？</prompt>\n    <option value="sqlite" recommended="true">SQLite</option>\n    <option value="postgres">PostgreSQL</option>\n  </question>\n</agentdock-ask-user-question>`
      }
    });
    await completePendingTasks(sideId);
    await assistant.handleStatus({ sessionId: sideId, state: 'completed' });
    expect(assistant.getTask(task.id)?.state).toBe('review');

    const app = Fastify();
    registerAssistantRoutes(app, assistant);
    registerOutputPluginRoutes(app, outputPlugins);
    registerAskUserQuestionRoutes(app, new AskUserQuestionService({ config: repos.config, channelMappings: repos.channelMappings, outputPlugins }));

    try {
      // GET /api/assistant/tasks/:id 透出 pendingInteraction
      const showRes = await app.inject({ method: 'GET', url: `/api/assistant/tasks/${task.id}` });
      expect(showRes.statusCode).toBe(200);
      expect(showRes.json().pendingInteraction).toMatchObject({
        pluginId: BUILTIN_ASK_USER_QUESTION_PLUGIN_ID,
        widgetId: 'ask_storage',
        title: '选择存储方案'
      });

      // 非主会话伪造 from 应返回 403
      const forbiddenRes = await app.inject({
        method: 'POST',
        url: `/api/assistant/tasks/${task.id}/answer`,
        payload: { from: sideId, quickAnswers: [{ questionId: 'q1', values: ['sqlite'] }] }
      });
      expect(forbiddenRes.statusCode).toBe(403);

      // 主会话小猫原生代答（无需手传 widgetId，自动定位最新未答卡片）
      const answerRes = await app.inject({
        method: 'POST',
        url: `/api/assistant/tasks/${task.id}/answer`,
        payload: {
          from: main.id,
          quickAnswers: [{ questionId: 'q1', values: ['sqlite'] }],
          otherText: '单机轻量默认选 SQLite 并开启 WAL 模式'
        }
      });
      expect(answerRes.statusCode).toBe(202);
      const body = answerRes.json();
      expect(body.accepted).toBe(true);
      expect(body.pluginId).toBe(BUILTIN_ASK_USER_QUESTION_PLUGIN_ID);
      expect(body.instanceId).toBe('ask_storage');
      expect(body.payload).toMatchObject({
        source: 'assistant',
        answeredBy: '小A同学',
        responderName: '小A同学',
        responderSessionId: main.id,
        answers: [{
          questionId: 'q1',
          prompt: '选择哪个数据库？',
          selectedValues: ['sqlite'],
          selectedLabels: ['SQLite'],
          otherText: '单机轻量默认选 SQLite 并开启 WAL 模式'
        }]
      });
      expect(assistant.getTask(task.id)?.state).toBe('running');

      // 侧边会话收到 ASK_USER_QUESTION_ANSWER_ORIGIN 续跑轮次
      const answerTurn = dispatched.at(-1)!;
      expect(answerTurn.sessionId).toBe(sideId);
      expect(answerTurn.origin).toBe(ASK_USER_QUESTION_ANSWER_ORIGIN);
      expect(parseAskUserQuestionAnswer(answerTurn.prompt)?.source).toBe('assistant');
      expect(answerTurn.agentPrompt).toContain('主会话小猫（小A同学）已代用户回答');

      // 重复代答或网页端再提交同一卡片均返回 409 幂等锁定
      const dupAssistantRes = await app.inject({
        method: 'POST',
        url: `/api/assistant/tasks/${task.id}/answer`,
        payload: { from: main.id, widgetId: 'ask_storage', quickAnswers: [{ questionId: 'q1', values: ['postgres'] }] }
      });
      expect(dupAssistantRes.statusCode).toBe(409);
      expect(dupAssistantRes.json().alreadySubmitted).toBe(true);

      const dupWebRes = await app.inject({
        method: 'POST',
        url: `/api/sessions/${sideId}/ask-user-question/answer`,
        payload: {
          questionId: 'ask_storage',
          answers: [{ questionId: 'q1', prompt: '选择哪个数据库？', selectedValues: ['postgres'], selectedLabels: ['PostgreSQL'] }]
        }
      });
      expect(dupWebRes.statusCode).toBe(409);

      // 已代答后 pendingInteraction 不再出现
      const showAfterRes = await app.inject({ method: 'GET', url: `/api/assistant/tasks/${task.id}` });
      expect(showAfterRes.json().pendingInteraction).toBeUndefined();

      // ConfirmAction 卡片同样支持主会话原生代答
      await repos.events.append({ id: 'e3', sessionId: sideId, sequence: 3, type: 'text', timestamp: now(), data: { role: 'user', text: '下一步' } });
      await repos.events.append({
        id: 'e4',
        sessionId: sideId,
        sequence: 4,
        type: 'text',
        timestamp: now(),
        data: {
          role: 'assistant',
          text: `准备清理：\n\n<agentdock-confirm-action id="confirm_cache" title="清理沙箱缓存" risk="low" confirm-label="确认清理" cancel-label="取消">\n  <summary>清理沙箱临时文件</summary>\n</agentdock-confirm-action>`
        }
      });
      const confirmRes = await app.inject({
        method: 'POST',
        url: `/api/assistant/tasks/${task.id}/answer`,
        payload: {
          from: main.id,
          decision: 'confirm',
          comment: '沙箱缓存可直接清理'
        }
      });
      expect(confirmRes.statusCode).toBe(202);
      const confirmTurn = dispatched.at(-1)!;
      expect(confirmTurn.origin).toBe(CONFIRM_ACTION_INTERACTION_ORIGIN);
      expect(parseConfirmActionInteraction(confirmTurn.prompt)).toMatchObject({
        actionId: 'confirm_cache',
        decision: 'confirm',
        decisionLabel: '确认清理',
        comment: '沙箱缓存可直接清理',
        source: 'assistant',
        responderName: '小A同学',
        responderSessionId: main.id
      });
    } finally {
      await app.close();
    }
  });

  it('marks natural-language appendTask and rework dispatches with origin="assistant_reply"', async () => {
    const { repos, assistant, dispatched } = createHarness();
    await assistant.initialize();
    const main: Session = {
      id: 'ses_main',
      agentId: 'claude',
      state: 'idle',
      cwd: '/tmp',
      runId: 'run_main',
      source: 'assistant-main',
      createdAt: now(),
      updatedAt: now()
    };
    await repos.sessions.save(main);
    await assistant.setMainSession(main.id);

    const task = await assistant.startTask({ title: '修侧边提问', doneWhen: ['测试通过'], agentId: 'claude' });
    await assistant.appendTask(task.id, '直接使用 SQLite WAL 即可，无需引入外部服务');
    const appendDispatch = dispatched.at(-1)!;
    expect(appendDispatch.sessionId).toBe(task.sessionId);
    expect(appendDispatch.origin).toBe(ASSISTANT_REPLY_ORIGIN);
    expect(appendDispatch.prompt).toBe('直接使用 SQLite WAL 即可，无需引入外部服务');
    expect(appendDispatch.agentPrompt).toContain('直接使用 SQLite WAL 即可，无需引入外部服务');

    await assistant.reviewTask(task.id, 'rework', [{ criterion: '测试通过', met: false, evidence: '缺少截图' }], '请补齐暗色模式截图');
    const reworkDispatch = dispatched.at(-1)!;
    expect(reworkDispatch.sessionId).toBe(task.sessionId);
    expect(reworkDispatch.origin).toBe(ASSISTANT_REPLY_ORIGIN);
    expect(reworkDispatch.prompt).toContain('返工第 1 轮');
    expect(reworkDispatch.prompt).toContain('请补齐暗色模式截图');
  });

  it('parses task answer CLI options, updates main prompt guidance, and formats Lark locked cards for assistant source', async () => {
    expect(parseQuickAnswerArg('q1=sqlite,postgres|按单机优先')).toEqual({
      questionId: 'q1',
      values: ['sqlite', 'postgres'],
      otherText: '按单机优先'
    });
    expect(parseQuickAnswerArg('sqlite')).toEqual({
      values: ['sqlite']
    });

    const taskAnswer = vi.fn();
    const program = createCliProgram('0.0.0-test', { taskAnswer });
    await program.parseAsync([
      'node',
      'agent-dock',
      'task',
      'answer',
      'atask_demo',
      '--widget',
      'ask_db',
      '--answer',
      'q1=sqlite',
      '--other',
      '保持轻量',
      '--json'
    ]);
    expect(taskAnswer).toHaveBeenCalledWith('atask_demo', expect.objectContaining({
      widget: 'ask_db',
      answer: ['q1=sqlite'],
      other: '保持轻量',
      json: true
    }));

    const prompt = buildMainSystemPrompt();
    expect(prompt).toContain('agent-dock task answer <任务ID>');
    expect(prompt).toContain('并向用户简述「已代答什么」');

    // 飞书已锁定卡片正确显示 🐾 小猫代答，不再误标为「飞书」
    const larkAskCard = buildLarkAskUserQuestionAnsweredCard({
      sessionId: 'ses_side',
      payload: {
        version: 1,
        questionId: 'ask_db',
        title: '选择存储方案',
        source: 'assistant',
        answeredBy: '小A同学',
        responderName: '小A同学',
        responderSessionId: 'ses_main',
        answeredAt: '2026-11-28T02:20:00.000Z',
        answers: [{ questionId: 'q1', prompt: '数据库', selectedValues: ['sqlite'], selectedLabels: ['SQLite'] }]
      }
    });
    expect((larkAskCard.header as any).subtitle.content).toContain('🐾 小A同学代答');
    expect((larkAskCard.header as any).subtitle.content).not.toContain('飞书');

    const larkConfirmCard = confirmActionLarkAdapter.buildAnsweredCard({
      sessionId: 'ses_side',
      payload: {
        version: 1,
        pluginId: BUILTIN_CONFIRM_ACTION_PLUGIN_ID,
        actionId: 'confirm_cache',
        title: '清理缓存',
        decision: 'confirm',
        decisionLabel: '确认执行',
        source: 'assistant',
        decidedBy: '小A同学',
        responderName: '小A同学',
        decidedAt: '2026-11-28T02:21:00.000Z'
      }
    });
    expect((larkConfirmCard.header as any).subtitle.content).toContain('🐾 小A同学代答');
    expect((larkConfirmCard.header as any).subtitle.content).not.toContain('飞书');
  });
});

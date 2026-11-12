import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { now, type RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { AssistantService, buildMainSystemPrompt, buildSuperagentDirective, classifyMainTurn } from './service.js';
import { HANDOFF_BRIEFING_MARKER, MAINTENANCE_MARKER } from './lifecycle.js';

const repositories: RepositoryBundle[] = [];
const services: AssistantService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const repos of repositories.splice(0)) repos.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function mainSession(repos: RepositoryBundle) {
  const session = { id: 'ses_main', agentId: 'claude', state: 'idle' as const, cwd: '/tmp', runId: 'run_1', createdAt: now(), updatedAt: now() };
  await repos.sessions.save(session);
  return session;
}

function harness() {
  const repos = createRepositories(':memory:');
  repositories.push(repos);
  const listeners: Array<(event: { sessionId: string; state: string }) => void> = [];
  const runtime = {
    onStatus: (listener: (event: { sessionId: string; state: string }) => void) => { listeners.push(listener); return () => undefined; },
    start: vi.fn(async (input: { agentId: string; source?: string; sourceId?: string }) => ({
      id: 'ses_side', agentId: input.agentId, state: 'idle' as const, cwd: '/tmp', runId: 'run_side',
      source: input.source, sourceId: input.sourceId, createdAt: now(), updatedAt: now()
    })),
    dispatch: vi.fn(async (id: string, prompt: string, mode?: string, agentPrompt?: string, _risk?: unknown, origin?: string) => ({
      id: `task_${runtime.dispatch.mock.calls.length}`, sessionId: id, prompt, status: 'queued', origin,
      createdAt: now(), updatedAt: now()
    })),
    getTasks: vi.fn(async () => []),
    stop: vi.fn(async () => undefined)
  };
  const notify = vi.fn(async () => true);
  const service = new AssistantService({ databaseUrl: ':memory:', runtime: runtime as never, repos, notify });
  services.push(service);
  return { repos, service, runtime, listeners, notify };
}

describe('AssistantService', () => {
  it('injects a full snapshot first and only changed sections afterwards', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const first = await service.composePrompt(main, '你好');
    expect(first).toContain('<agentdock-context>');
    expect(first).toContain('现在：');
    expect(first.endsWith('你好')).toBe(true);
    expect(first).not.toContain('<agentdock-superagent>');

    const second = await service.composePrompt(main, '你好');
    expect(second).toBe('你好');

    service.planTask({ title: '修登录超时', doneWhen: ['测试通过'], agentId: 'claude' });
    const third = await service.composePrompt(main, '你好');
    expect(third).toContain('事项：');
    expect(third).toContain('修登录超时');
  });

  it('pushes actionable main-session turns into delegation instead of self-execution', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const chat = await service.composePrompt(main, '在吗？');
    expect(chat.endsWith('在吗？')).toBe(true);
    expect(chat).not.toContain('<agentdock-superagent>');

    const action = await service.composePrompt(main, '随便看看这个仓库在干嘛，给我讲讲');
    expect(action).toContain('<agentdock-superagent>');
    expect(action).toContain('agent-dock task start');
    expect(action.endsWith('随便看看这个仓库在干嘛，给我讲讲')).toBe(true);

    expect(buildMainSystemPrompt()).toContain('第一个工具调用必须是 `agent-dock task start`');
    expect(buildMainSystemPrompt()).toContain('直接派一个范围明确、可验收的侧边会话');
    expect(buildSuperagentDirective('你好')).toBe('');
    expect(buildSuperagentDirective('以下是 daemon 汇总的督办信号。先看是否需要你处理')).toBe('');
    expect(buildSuperagentDirective('现在任务进度怎么样了？')).toBe('');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('task start');
    expect(buildSuperagentDirective('看看这个任务为什么失败')).toContain('task start');
    expect(buildSuperagentDirective(`${MAINTENANCE_MARKER}（amaint_1），不是用户消息`)).toBe('');
    expect(buildSuperagentDirective(`${HANDOFF_BRIEFING_MARKER}，不是用户消息`)).toBe('');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('2-3 行');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('侧边会话 ID');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('硬规则（不是建议');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('你是 AgentDock 的灵魂');
  });

  it('limits the main session to delegation, review, reporting and decisions', () => {
    const prompt = buildMainSystemPrompt();
    expect(prompt).toContain('只做四件事：派活、验收、汇报、拍板');
    expect(prompt).toContain('AgentDock 的灵魂');
    expect(prompt).toContain('硬规则，不是建议：不要自己干活');
    expect(prompt).toContain('回复限定 2-3 行');
    expect(prompt).toContain('任务 ID 与侧边会话 ID');
    expect(prompt).toContain('--done-when');
    expect(prompt).toContain('例外（直接回答，不派活）：打招呼/闲聊');
    expect(prompt).toContain('问进度/状态直接看快照和已有事项，不派活');
    expect(prompt).toContain('第一个工具调用必须是 `agent-dock task start`');
    expect(prompt).toContain('禁止调用 Bash、Read、Grep、Glob、数据库客户端、浏览器');
    expect(prompt).toContain('工作区里的 AGENTS.md');
    expect(prompt).toContain('唯一例外：用户在本轮明确说');
  });

  it('teaches the main session the orchestration commands, examples and delegation criteria', () => {
    const prompt = buildMainSystemPrompt();
    for (const command of [
      'agent-dock task start', 'agent-dock task plan', 'agent-dock task list',
      'agent-dock task show', 'agent-dock task review', 'agent-dock task cancel',
      'agent-dock session show', 'agent-dock session send',
      'agent-dock watch add', 'agent-dock notify', 'agent-dock draft create',
      'agent-dock status --json'
    ]) {
      expect(prompt).toContain(command);
    }
    expect(prompt).toContain('什么情况该派活 / 不该派活');
    expect(prompt).toContain('拿不准时默认派活');
    expect(prompt).toContain('【常用示例】');
    expect(prompt).toContain('--check "验收标准=met:证据"');
    expect(prompt).toContain('--mode queue');
    expect(prompt).toContain('--mode interrupt');
  });

  it('keeps greetings and progress checks out of delegation', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    for (const prompt of ['你好，在吗？', '现在任务进度怎么样了？']) {
      expect(buildSuperagentDirective(prompt)).toBe('');
      expect(await service.composePrompt(main, prompt)).not.toContain('<agentdock-superagent>');
    }
  });

  it('defaults ordinary executable requests to delegation, including the real-session misses', () => {
    const prompts = [
      '小A同学主会话也是可以建立机器人的，要做两件事：\n1. 还是要支持托管给机器人\n2. 然后如果因为换代变成了新的小猫，那这里还可以加一个按钮\n请你处理一下',
      '你是Agent-dock的主会话啊\n然后这个事件条数老的也太快了，很浪费啊',
      '我们的prompt是有问题的，第二代小猫出现了严重的干活倾向，需要做调整，请你用 agent-dock cli 的能力分派便签去干活，处理上述轮次的所有问题',
      '把登录页的按钮改成小猫头像',
      '帮我查一下 CI 为什么失败',
      '你不要自己做，去派活处理这个 bug',
      '随便看看这个仓库在干嘛，给我讲讲'
    ];
    for (const prompt of prompts) {
      expect(classifyMainTurn(prompt)).toBe('delegate');
      expect(buildSuperagentDirective(prompt)).toContain('第一个工具调用必须是 `agent-dock task start`');
      expect(buildSuperagentDirective(prompt)).toContain('工作区 AGENTS.md');
    }
  });

  it('does not delegate chat, status checks, explicit self-work, or system turns', () => {
    expect(classifyMainTurn('你好，在吗？')).toBe('chat');
    expect(classifyMainTurn('谢谢，辛苦了')).toBe('chat');
    expect(classifyMainTurn('今天天气不错，哈哈')).toBe('chat');
    expect(classifyMainTurn('你觉得 A 和 B 哪个好？')).toBe('chat');
    expect(classifyMainTurn('现在任务进度怎么样了？')).toBe('status');
    expect(classifyMainTurn('还在跑吗')).toBe('status');
    expect(classifyMainTurn('这个你自己做吧，不用派活')).toBe('chat');
    expect(classifyMainTurn(`${MAINTENANCE_MARKER}（amaint_1），不是用户消息`)).toBe('system');
    expect(classifyMainTurn(`${HANDOFF_BRIEFING_MARKER}，不是用户消息`)).toBe('system');
    expect(classifyMainTurn(buildMainSystemPrompt())).toBe('system');

    for (const prompt of ['你好，在吗？', '谢谢，辛苦了', '今天天气不错，哈哈', '现在任务进度怎么样了？', '这个你自己做吧，不用派活']) {
      expect(buildSuperagentDirective(prompt)).toBe('');
    }
  });

  it('puts the directive immediately before the user message', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const prompt = '帮我把登录页的按钮改成小猫头像';
    const composed = await service.composePrompt(main, prompt);
    const contextEnd = composed.indexOf('</agentdock-context>');
    const directiveStart = composed.indexOf('<agentdock-superagent>');
    expect(contextEnd).toBeGreaterThanOrEqual(0);
    expect(directiveStart).toBeGreaterThan(contextEnd);
    expect(composed.endsWith(`</agentdock-superagent>\n\n${prompt}`)).toBe(true);
  });

  it('requires criterion-by-criterion evidence and rework when any evidence is missing', () => {
    const prompt = buildMainSystemPrompt();
    expect(prompt).toContain('对 done-when 每一条逐条找证据');
    expect(prompt).toContain('任一条找不到证据');
    expect(prompt).toContain('--verdict rework');
    expect(prompt).toContain('只有每一条都有证据才 `--verdict accepted`');
  });

  it('adopts a named companion, tells the main session its name, and forgets it on release', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    runtime.start.mockImplementationOnce(async (input: { agentId: string; source?: string; sourceId?: string }) => {
      const session = { id: 'ses_kitten', agentId: input.agentId, state: 'idle' as const, cwd: '/tmp', runId: 'run_k', source: input.source, createdAt: now(), updatedAt: now() };
      await repos.sessions.save(session);
      return session;
    });

    const session = await service.createMainSession({ agentId: 'claude', name: '  年糕\n  ' });
    expect(session.id).toBe('ses_kitten');
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ source: 'assistant-main' }));
    expect(await service.getCompanion()).toMatchObject({ name: '年糕' });
    expect((await repos.sessions.get('ses_kitten'))?.customTitle).toBe('年糕');

    const first = await service.composePrompt(session, '在吗？');
    expect(first).toContain('你的名字：年糕');

    await service.renameCompanion('芝麻');
    expect((await repos.sessions.get('ses_kitten'))?.customTitle).toBe('芝麻');
    const renamed = await service.composePrompt(session, '在吗？');
    expect(renamed).toContain('你的名字：芝麻');
    expect(renamed).not.toContain('现在：');
    await expect(service.renameCompanion('   ')).rejects.toThrow('名字不能为空');

    await service.clearMainSession();
    expect(await service.getCompanion()).toBeUndefined();
  });

  it('falls back to the default name for a main session that was never named', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);
    expect(await service.getCompanion()).toMatchObject({ name: '小A同学', adoptedAt: main.createdAt });
  });

  it('refreshes an existing main-session prompt when the daemon starts', async () => {
    const { repos, service } = harness();
    await repos.sessions.save({
      id: 'ses_main', agentId: 'claude', state: 'idle', cwd: '/tmp', runId: 'run_1',
      source: 'assistant-main', systemPrompt: '旧提示词', createdAt: now(), updatedAt: now()
    });
    await repos.config.set('assistant.main', 'ses_main');
    await service.initialize();
    expect((await repos.sessions.get('ses_main'))?.systemPrompt).toBe(buildMainSystemPrompt());
  });

  it('inherits the main session agent and cwd and tells the side session to report', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);
    await repos.sessions.save({
      id: 'ses_side', agentId: 'claude', state: 'idle', cwd: '/tmp', runId: 'run_side',
      createdAt: now(), updatedAt: now()
    });

    const task = await service.startTask({ title: '梳理仓库', doneWhen: ['给出证据'] });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude', cwd: '/tmp', source: 'side-chat', sourceId: 'ses_main'
    }));
    expect((await repos.sessions.get('ses_side'))?.customTitle).toBe('梳理仓库');
    const prompt = runtime.dispatch.mock.calls.at(-1)![1];
    expect(prompt).toContain(`事项 ID：${task.id}`);
    expect(prompt).toContain('agent-dock task report --kind done');
  });

  it('inherits the full main-session config by default and lets every task override it', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await repos.sessions.save({ ...main, cwd: '/repo/main', model: 'claude-opus-5-5', reasoningEffort: 'high' });
    await service.setMainSession(main.id);
    await repos.sessions.save({
      id: 'ses_side', agentId: 'claude', state: 'idle', cwd: '/repo/main', runId: 'run_side',
      createdAt: now(), updatedAt: now()
    });

    const inherited = await service.startTask({ title: '默认继承', doneWhen: ['给出证据'] });
    expect(runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'claude', cwd: '/repo/main', model: 'claude-opus-5-5', reasoningEffort: 'high'
    }));
    expect(inherited).toMatchObject({ agentId: 'claude', cwd: '/repo/main', model: 'claude-opus-5-5', reasoningEffort: 'high' });

    // 主会话可以随意换 Agent、工作区、模型和思考深度，不受主会话配置限制。
    const overridden = await service.startTask({
      title: '自由组合', doneWhen: ['给出证据'],
      agentId: 'codex', cwd: '/tmp/another-workspace', model: 'gpt-5-codex', reasoningEffort: 'low'
    });
    expect(runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'codex', cwd: '/tmp/another-workspace', model: 'gpt-5-codex', reasoningEffort: 'low'
    }));
    expect(overridden).toMatchObject({ agentId: 'codex', cwd: '/tmp/another-workspace', model: 'gpt-5-codex', reasoningEffort: 'low' });

    // 只换 Agent、不指定模型时，用新 Agent 自己的默认，而不是把主会话的模型硬塞过去。
    await service.startTask({ title: '换 Agent', doneWhen: ['给出证据'], agentId: 'codex' });
    const switched = runtime.start.mock.calls.at(-1)![0] as { agentId: string; cwd?: string; model?: string; reasoningEffort?: string };
    expect(switched).toMatchObject({ agentId: 'codex', cwd: '/repo/main' });
    expect(switched.model).toBeUndefined();
    expect(switched.reasoningEffort).toBeUndefined();

    // 计划卡也要记住配置，开工时不能被默认值冲掉。
    const plan = service.planTask({
      title: '计划也记住配置', doneWhen: ['给出证据'],
      agentId: 'codex', cwd: '/tmp/plan-workspace', model: 'gpt-5-codex', reasoningEffort: 'medium'
    });
    expect(plan).toMatchObject({ agentId: 'codex', cwd: '/tmp/plan-workspace', model: 'gpt-5-codex', reasoningEffort: 'medium' });
    await service.startPlannedTask(plan.id);
    expect(runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'codex', cwd: '/tmp/plan-workspace', model: 'gpt-5-codex', reasoningEffort: 'medium'
    }));

    const inheritPlan = service.planTask({ title: '计划开工时继承', doneWhen: ['给出证据'] });
    await service.startPlannedTask(inheritPlan.id);
    expect(runtime.start).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'claude', cwd: '/repo/main', model: 'claude-opus-5-5', reasoningEffort: 'high'
    }));
  });

  it('tells the main session it may freely choose agent, workspace, model and reasoning depth', () => {
    const prompt = buildMainSystemPrompt();
    expect(prompt).toContain('完整继承主会话自己');
    expect(prompt).toContain('--agent');
    expect(prompt).toContain('任意绝对路径的工作区');
    expect(prompt).toContain('--model');
    expect(prompt).toContain('--reasoning-effort');
    expect(prompt).toContain('不需要先问用户');
  });

  it('turns a side-session completion into one injected review signal', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '调查 CI', doneWhen: ['给出原因'], agentId: 'claude' });
    expect(task.sessionId).toBe('ses_side');
    await service.handleStatus({ sessionId: task.sessionId!, state: 'completed' });
    await service.flushNow();

    const review = runtime.dispatch.mock.calls.at(-1)!;
    expect(review[0]).toBe(main.id);
    expect(review[1]).toContain('📋 督办');
    expect(review[3]).toContain('调查 CI');
    expect(review[5]).toBe('injected');
    expect(service.getTask(task.id)?.state).toBe('review');

    // 这条督办注入回到 composePrompt 时不能再生成派活指令，否则每次验收都会再派一个侧边会话。
    expect(await service.composePrompt(main, review[3] as string, review[5] as string)).not.toContain('<agentdock-superagent>');
    expect(await service.composePrompt(main, `[飞书群工具说明]\n\n${review[3] as string}`)).not.toContain('<agentdock-superagent>');
  });

  it('reports an explicit interrupt as interrupted, never as failed', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '发布 v0.3.2', doneWhen: ['发布完成'], agentId: 'claude' });
    await service.handleStatus({ sessionId: task.sessionId!, state: 'interrupted', interruptIntent: 'user' });
    await service.flushNow();

    const injected = runtime.dispatch.mock.calls.at(-1)!;
    expect(injected[3]).toContain('[interrupted]');
    expect(injected[3]).toContain('侧边会话被主动打断');
    expect(injected[3]).not.toContain('[failed]');
    // 会话确实停了，事项仍需要主会话决定返工/取消/验收。
    expect(service.getTask(task.id)?.state).toBe('needs_user');
  });

  it('keeps real failures as failed signals', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '修 CI', doneWhen: ['测试通过'], agentId: 'claude' });
    await service.handleStatus({ sessionId: task.sessionId!, state: 'failed', error: 'Agent exited with code 17' });
    await service.flushNow();

    const injected = runtime.dispatch.mock.calls.at(-1)!;
    expect(injected[3]).toContain('[failed]');
    expect(injected[3]).toContain('Agent exited with code 17');
    expect(injected[3]).not.toContain('[interrupted]');
    expect(service.getTask(task.id)?.state).toBe('needs_user');
  });

  it('reports a crashed turn recovered to idle+error as failed, not review', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '真实崩溃', doneWhen: ['给出证据'], agentId: 'claude' });
    // runtime 对轮次内失败的会话会回到 idle 以便继续接活，错误留在 session.error。
    await service.handleStatus({ sessionId: task.sessionId!, state: 'idle', error: 'ACP agent disconnected during request' });
    await service.flushNow();

    const injected = runtime.dispatch.mock.calls.at(-1)!;
    expect(injected[3]).toContain('[failed]');
    expect(injected[3]).toContain('ACP agent disconnected during request');
    expect(injected[3]).not.toContain('[interrupted]');
    expect(service.getTask(task.id)?.state).toBe('needs_user');
  });

  it('treats an interrupted state without explicit intent as a failure', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '长跑任务', doneWhen: ['给出结果'], agentId: 'claude' });
    await service.handleStatus({ sessionId: task.sessionId!, state: 'interrupted', interruptIntent: 'daemon_restart' });
    await service.flushNow();

    const injected = runtime.dispatch.mock.calls.at(-1)!;
    expect(injected[3]).toContain('[failed]');
    expect(injected[3]).not.toContain('[interrupted]');
  });

  it('scan reports an explicit interrupt as interrupted', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '扫描主动打断', doneWhen: ['给出结果'], agentId: 'claude' });
    await repos.sessions.save({
      id: task.sessionId!, agentId: 'claude', state: 'interrupted', interruptIntent: 'user',
      cwd: '/tmp', runId: 'run_side', createdAt: now(), updatedAt: now()
    });
    await service.scan();
    await service.flushNow();
    expect(runtime.dispatch.mock.calls.at(-1)![3]).toContain('[interrupted]');
    expect(runtime.dispatch.mock.calls.at(-1)![3]).not.toContain('[failed]');
  });

  it('scan reports an unexpected interrupted session as failed', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '扫描意外中断', doneWhen: ['给出结果'], agentId: 'claude' });
    await repos.sessions.save({
      id: task.sessionId!, agentId: 'claude', state: 'interrupted', interruptIntent: 'daemon_restart',
      cwd: '/tmp', runId: 'run_side', createdAt: now(), updatedAt: now()
    });
    await service.scan();
    await service.flushNow();
    expect(runtime.dispatch.mock.calls.at(-1)![3]).toContain('[failed]');
    expect(runtime.dispatch.mock.calls.at(-1)![3]).not.toContain('[interrupted]');
  });

  it('scan reports an idle session with a task error as failed', async () => {
    const { repos, service, runtime } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const task = await service.startTask({ title: '扫描真实崩溃', doneWhen: ['给出结果'], agentId: 'claude' });
    await repos.sessions.save({
      id: task.sessionId!, agentId: 'claude', state: 'idle', error: 'Agent exited with code 17',
      cwd: '/tmp', runId: 'run_side', createdAt: now(), updatedAt: now()
    });
    await service.scan();
    await service.flushNow();
    expect(runtime.dispatch.mock.calls.at(-1)![3]).toContain('[failed]');
    expect(runtime.dispatch.mock.calls.at(-1)![3]).toContain('Agent exited with code 17');
    expect(runtime.dispatch.mock.calls.at(-1)![3]).not.toContain('[review]');
  });

  it('never delegates an injected review signal when other layers prefix the prompt', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    const larkPrefix = '[飞书群工具说明]\n\n';
    const signalText = '以下是 daemon 汇总的督办信号。先看是否需要你处理；需要用户拍板时用 agent-dock notify --ask。\n\n- [review] 修复登录失败问题：侧边会话这一轮结束，等待验收（task_1）';

    const injected = await service.composePrompt(main, `${larkPrefix}${signalText}`, 'injected');
    expect(injected).not.toContain('<agentdock-superagent>');
    expect(injected.endsWith(`${larkPrefix}${signalText}`)).toBe(true);

    // 文本兜底：旧队列/重放漏传 origin 时，带前缀的督办文本也不能被当成用户请求。
    const fallback = await service.composePrompt(main, `${larkPrefix}${signalText}`);
    expect(fallback).not.toContain('<agentdock-superagent>');
    expect(buildSuperagentDirective(`${larkPrefix}${signalText}`)).toBe('');

    // 正常用户的可执行消息仍然要派活。
    const userPrompt = '帮我检查一下这个仓库的 CI 为什么失败';
    const user = await service.composePrompt(main, userPrompt, 'user');
    expect(user).toContain('<agentdock-superagent>');
    expect(user.endsWith(userPrompt)).toBe(true);
  });

  it('escalates after two reworks and closes on acceptance', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);
    const task = service.planTask({ title: '修 bug', doneWhen: ['测试通过'], agentId: 'claude' });
    await service.startPlannedTask(task.id);

    await service.reviewTask(task.id, 'rework', [{ criterion: '测试通过', met: false, evidence: '仍失败' }]);
    await service.reviewTask(task.id, 'rework', [{ criterion: '测试通过', met: false, evidence: '仍失败' }]);
    const third = await service.reviewTask(task.id, 'rework', [{ criterion: '测试通过', met: false, evidence: '仍失败' }]);
    expect(third.state).toBe('needs_user');

    const accepted = await service.reviewTask(task.id, 'accepted', [{ criterion: '测试通过', met: true, evidence: 'pnpm test' }]);
    expect(accepted.state).toBe('closed');
    expect(accepted.outcome).toBe('accepted');
  });

  it('keeps quiet hours off by default and delays only normal notifications when enabled', async () => {
    const { repos, service, notify } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);

    expect(service.getQuietHours()).toEqual({ enabled: false, start: '23:00', end: '08:00' });

    // 用「当前时间 ±1 小时」做静默窗口，避免测试在任意时刻跑都落到窗口外。
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const clock = (minutes: number) => {
      const value = (minutes + 24 * 60) % (24 * 60);
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    };
    expect(service.setQuietHours({ enabled: true, start: clock(current - 60), end: clock(current + 60) })).toMatchObject({ enabled: true });

    const delayed = await service.notify({ text: '普通通知' });
    expect(delayed.delayed).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    const urgent = await service.notify({ text: '紧急通知', urgent: true });
    expect(urgent).toMatchObject({ delayed: false, sent: true });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('runs a watch script and fires once when the condition becomes true', async () => {
    const { repos, service } = harness();
    await service.initialize();
    const main = await mainSession(repos);
    await service.setMainSession(main.id);
    const directory = mkdtempSync(join(tmpdir(), 'agentdock-watch-'));
    directories.push(directory);
    const marker = join(directory, 'ready');
    const watch = service.addWatch({
      ownerSessionId: main.id, name: '文件出现', command: `test -f ${marker}`,
      every: '5s', timeout: '2s', mode: 'once'
    });

    const before = await service.runWatchNow(watch.id);
    expect(before.lastExitCode).toBe(1);
    expect(before.failCount).toBe(1);

    writeFileSync(marker, 'ok');
    const after = await service.runWatchNow(watch.id);
    expect(after.lastExitCode).toBe(0);
    expect(after.fireCount).toBe(1);
    expect(after.state).toBe('fired');
  });
});

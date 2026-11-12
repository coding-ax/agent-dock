import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { now, type RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { AssistantService, buildMainSystemPrompt, buildSuperagentDirective } from './service.js';

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

    const first = await service.composePrompt(main, 'hello');
    expect(first).toContain('<agentdock-context>');
    expect(first).toContain('现在：');
    expect(first.endsWith('hello')).toBe(true);

    const second = await service.composePrompt(main, 'hello');
    expect(second).toBe('hello');

    service.planTask({ title: '修登录超时', doneWhen: ['测试通过'], agentId: 'claude' });
    const third = await service.composePrompt(main, 'hello');
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

    expect(buildMainSystemPrompt()).toContain('而不是自己用 Bash/Read 去做');
    expect(buildMainSystemPrompt()).toContain('给我看看');
    expect(buildSuperagentDirective('你好')).toBe('');
    expect(buildSuperagentDirective('以下是 daemon 汇总的督办信号。先看是否需要你处理')).toBe('');
    expect(buildSuperagentDirective('现在任务进度怎么样了？')).toBe('');
    expect(buildSuperagentDirective('帮我查一下 CI')).toContain('task start');
    expect(buildSuperagentDirective('看看这个任务为什么失败')).toContain('task start');
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { now, RuntimeError, type RepositoryBundle, type Session, type TaskRecord } from '@agent-dock/agent-dock-shared';
import { AssistantService, buildMainSystemPrompt, buildSuperagentDirective } from './service.js';
import { registerAssistantRoutes } from './routes.js';
import { HANDOFF_BRIEFING_MARKER, MAINTENANCE_MARKER } from './lifecycle.js';

const repositories: RepositoryBundle[] = [];
const services: AssistantService[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  for (const repos of repositories.splice(0)) repos.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type StartInput = { agentId: string; cwd?: string; model?: string; reasoningEffort?: string; source?: string; sourceId?: string; systemPrompt?: string };
type StatusListener = (event: { sessionId: string; state: Session['state']; error?: string }) => void;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 运行时替身：会话写进真实的内存库，dispatch 的任务按会话记账，归档会真的写 archivedAt。 */
function createRuntime(repos: RepositoryBundle) {
  const tasks = new Map<string, TaskRecord[]>();
  const listeners: StatusListener[] = [];
  let sessionCounter = 0;
  let taskCounter = 0;
  const list = (id: string) => { if (!tasks.has(id)) tasks.set(id, []); return tasks.get(id)!; };
  const runtime = {
    tasks, listeners, list,
    onStatus: (listener: StatusListener) => { listeners.push(listener); return () => { listeners.splice(listeners.indexOf(listener), 1); }; },
    start: vi.fn(async (input: StartInput) => {
      sessionCounter += 1;
      const session: Session = {
        id: `${input.source === 'assistant-main' ? 'ses_main' : 'ses_side'}_${sessionCounter}`, agentId: input.agentId, state: 'idle',
        cwd: input.cwd ?? '/tmp', runId: `run_${sessionCounter}`,
        ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.source ? { source: input.source } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        createdAt: now(), updatedAt: now()
      } as Session;
      await repos.sessions.save(session);
      return session;
    }),
    dispatch: vi.fn(async (id: string, prompt: string, _mode: string = 'queue', agentPrompt: string = prompt, _risk?: unknown, origin?: string) => {
      taskCounter += 1;
      const task: TaskRecord = { id: `rt_${taskCounter}`, sessionId: id, prompt, sentPrompt: agentPrompt, status: 'queued', ...(origin ? { origin } : {}), createdAt: now(), updatedAt: now() };
      list(id).push(task);
      return task;
    }),
    getTasks: vi.fn(async (id: string) => [...list(id)]),
    stop: vi.fn(async () => undefined),
    archive: vi.fn(async (id: string) => {
      const session = await repos.sessions.get(id);
      if (!session) throw new Error(`会话不存在：${id}`);
      session.state = 'stopped';
      session.archivedAt = now();
      await repos.sessions.save(session);
      return session;
    }),
    restart: vi.fn(async (id: string) => {
      const session = await repos.sessions.get(id);
      if (!session) throw new Error(`会话不存在：${id}`);
      session.state = 'idle';
      await repos.sessions.save(session);
      return session;
    })
  };
  return runtime;
}

function harness(options: { repos?: RepositoryBundle; databaseUrl?: string } = {}) {
  const repos = options.repos ?? createRepositories(':memory:');
  if (!options.repos) repositories.push(repos);
  const runtime = createRuntime(repos);
  const service = new AssistantService({ databaseUrl: options.databaseUrl ?? ':memory:', runtime: runtime as never, repos, notify: vi.fn(async () => true) });
  services.push(service);
  return { repos, service, runtime, lifecycle: service.lifecycle };
}

async function appendEvent(repos: RepositoryBundle, sessionId: string, sequence: number, type: string, data: Record<string, unknown>) {
  await repos.events.append({ id: `evt_${sessionId}_${sequence}`, sessionId, sequence, type: type as never, timestamp: now(), data });
}

/** 一只第 1 代小猫，墙上有进行中、计划、已完成三张便签，外加一个 watch 和一份待确认草稿。 */
async function adoptedWithNotes(h: ReturnType<typeof harness>) {
  await h.service.initialize();
  const main = await h.service.createMainSession({ agentId: 'claude', cwd: '/work/dock', model: 'opus', reasoningEffort: 'high', name: '团子' });
  const running = await h.service.startTask({ title: '修登录超时', doneWhen: ['测试通过'] });
  const plan = h.service.planTask({ title: '升级依赖', doneWhen: ['构建通过'] });
  const done = await h.service.startTask({ title: '写周报', doneWhen: ['发出去'] });
  await h.service.reviewTask(done.id, 'accepted');
  const watch = h.service.addWatch({ ownerSessionId: main.id, name: 'CI 变绿', command: 'true', every: '60s' });
  const draft = h.service.createDraft({ channel: 'github_comment', target: 'github:o/r#1', body: 'LGTM' });
  await appendEvent(h.repos, main.id, 1, 'text', { role: 'user', text: '看看 /Users/codeax/notes/plan.md', taskId: 'rt_x' });
  await appendEvent(h.repos, main.id, 2, 'tool_call', { input: { file_path: '/Users/codeax/workspace/agent-dock/README.md' } });
  // 主会话真跑过一轮：交接包里的「最近几轮」从这里来
  h.runtime.list(main.id).push({ id: 'rt_user_1', sessionId: main.id, prompt: '帮我盯一下发版', status: 'completed', finalText: '好的，已派活', createdAt: now(), updatedAt: now() });
  return { main, running, plan, done, watch, draft };
}

describe('main-session handoff ceremony', () => {
  it('archives the old main session, hands everything to a new kitten, and briefs it as a system round', async () => {
    const h = harness();
    const { main, running, plan, done, watch, draft } = await adoptedWithNotes(h);
    const eventsBefore = await h.repos.events.countBySession(main.id);
    const firstCat = (await h.lifecycle.light()).cat!;
    expect(firstCat).toMatchObject({ generation: 1, lifeStage: 'kitten', name: '团子' });

    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user', reason: '上下文太满了' });
    expect(proposal.state).toBe('proposed');
    // 幂等：同一时刻只有一单
    expect((await h.lifecycle.proposeHandoff({ trigger: 'agent' })).id).toBe(proposal.id);

    const started = await h.lifecycle.confirmHandoff(proposal.id, { name: '豆豆' });
    expect(['confirmed', 'packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing', 'done']).toContain(started.state);
    await h.lifecycle.settle();

    const view = h.lifecycle.getHandoff(proposal.id);
    expect(view.state).toBe('done');
    // 计划卡和草稿要用户拍板 → needs_confirmation
    expect(view.outcome).toBe('needs_confirmation');
    expect(view.steps.filter(step => step.ok).map(step => step.step)).toEqual(['packing', 'spawning', 'transferring', 'switching', 'retiring', 'briefing']);

    // 旧主会话：归档只读，事件一条不少
    const old = await h.repos.sessions.get(main.id);
    expect(old?.archivedAt).toBeTruthy();
    expect(await h.repos.events.countBySession(main.id)).toBe(eventsBefore);

    // 新主会话：继承 Agent / 模型 / 思考深度 / 目录，名字用新起的
    const newId = h.service.mainSessionId!;
    expect(newId).not.toBe(main.id);
    expect(view.toSessionId).toBe(newId);
    const fresh = await h.repos.sessions.get(newId);
    expect(fresh).toMatchObject({ agentId: 'claude', model: 'opus', reasoningEffort: 'high', cwd: '/work/dock', source: 'assistant-main', customTitle: '豆豆' });
    expect(fresh?.systemPrompt).toBe(buildMainSystemPrompt());
    expect(await h.service.getCompanion()).toMatchObject({ name: '豆豆' });

    // 血缘：旧猫退休、新猫第 2 代从幼猫开始
    const lineage = h.lifecycle.lineage();
    expect(lineage).toHaveLength(2);
    const [retired, kitten] = lineage;
    expect(retired).toMatchObject({ id: firstCat.id, state: 'retired', sessionId: main.id, generation: 1, successorId: kitten!.id, handoffId: proposal.id });
    expect(retired!.retiredAt).toBeTruthy();
    expect(kitten).toMatchObject({ state: 'active', generation: 2, lifeStage: 'kitten', sessionId: newId, predecessorId: firstCat.id, familyId: retired!.familyId, name: '豆豆' });
    expect((await h.lifecycle.light()).ancestorSessionIds).toEqual([main.id]);

    // 便签交接：每条单独记账
    const transfers = Object.fromEntries(view.transfers.map(item => [item.itemId, item.status]));
    expect(transfers).toEqual({ [running.id]: 'transferred', [plan.id]: 'needs_confirmation', [watch.id]: 'transferred', [draft.id]: 'needs_confirmation' });
    expect(h.service.getWatch(watch.id)?.ownerSessionId).toBe(newId);
    // 已完成便签折叠进归档区，没有删除
    const archived = h.service.getTask(done.id);
    expect(archived?.archivedAt).toBeTruthy();
    expect(archived?.archiveBatchId).toBe(view.archiveBatchId);
    expect(h.service.listTasks()).toHaveLength(3);

    // 交接说明：发给新主会话、origin=handoff、明说不是用户消息、写着旧会话 id
    const briefingCall = h.runtime.dispatch.mock.calls.find(call => call[5] === 'handoff')!;
    expect(briefingCall[0]).toBe(newId);
    expect(briefingCall[1]).toBe('🐾 交接说明 · 第 2 代豆豆接班（前任：第 1 代团子）');
    expect(briefingCall[3]).toContain(HANDOFF_BRIEFING_MARKER);
    expect(briefingCall[3]).toContain('不是用户消息');
    expect(briefingCall[3]).toContain(`agent-dock session show ${main.id}`);
    expect(briefingCall[3]).toContain('修登录超时');
    expect(briefingCall[3]).toContain('帮我盯一下发版');
    expect(briefingCall[3]).toContain('/Users/codeax/workspace/agent-dock/README.md');
    expect(view.package?.closedNotes.archived).toBe(1);
    expect(h.runtime.dispatch.mock.calls.filter(call => call[0] === main.id && call[5])).toHaveLength(0);

    // 系统轮次不加派活指令；新主会话的快照知道自己是第 2 代、前任在哪
    const composed = await h.service.composePrompt(fresh!, briefingCall[1], 'handoff');
    expect(composed).not.toContain('<agentdock-superagent>');
    expect(composed).toContain('你的身份：第 2 代 · 幼猫');
    expect(composed).toContain(`前任：第 1 代团子（${main.id}，已归档只读）`);
    expect(buildSuperagentDirective(briefingCall[3]!)).toBe('');

    // 重复确认只返回进度，不会再跑一遍
    const startsBefore = h.runtime.start.mock.calls.length;
    expect((await h.lifecycle.confirmHandoff(proposal.id)).state).toBe('done');
    expect(h.runtime.start.mock.calls.length).toBe(startsBefore);
  });

  it('rolls back without touching the old main session when the new session cannot start', async () => {
    const h = harness();
    const { main, done, watch } = await adoptedWithNotes(h);
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user' });
    h.runtime.start.mockRejectedValueOnce(new Error('Agent 起不来'));
    await h.lifecycle.confirmHandoff(proposal.id);
    await h.lifecycle.settle();

    const view = h.lifecycle.getHandoff(proposal.id);
    expect(view.state).toBe('rolled_back');
    expect(view.error).toContain('spawning 失败：Agent 起不来');
    expect(view.error).toContain('旧主会话完好');
    expect(h.service.mainSessionId).toBe(main.id);
    expect((await h.repos.sessions.get(main.id))?.archivedAt).toBeFalsy();
    expect(h.lifecycle.lineage().map(cat => cat.state)).toEqual(['active']);
    expect(h.service.getTask(done.id)?.archivedAt).toBeUndefined();
    expect(h.service.getWatch(watch.id)?.ownerSessionId).toBe(main.id);
    expect(h.runtime.archive).not.toHaveBeenCalled();
    // 回滚后可以重新发起
    expect((await h.lifecycle.proposeHandoff({ trigger: 'user' })).id).not.toBe(proposal.id);
  });

  it('rolls everything back when archiving the old session fails at the commit point', async () => {
    const h = harness();
    const { main, done, watch } = await adoptedWithNotes(h);
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user' });
    h.runtime.archive.mockRejectedValueOnce(new Error('磁盘满了'));
    await h.lifecycle.confirmHandoff(proposal.id, { name: '豆豆' });
    await h.lifecycle.settle();

    const view = h.lifecycle.getHandoff(proposal.id);
    expect(view.state).toBe('rolled_back');
    expect(view.error).toContain('retiring 失败：磁盘满了');
    expect(h.service.mainSessionId).toBe(main.id);
    expect(await h.service.getCompanion()).toMatchObject({ name: '团子' });
    expect((await h.repos.sessions.get(main.id))?.archivedAt).toBeFalsy();
    const [oldCat, aborted] = h.lifecycle.lineage();
    expect(oldCat).toMatchObject({ state: 'active', sessionId: main.id });
    expect(oldCat!.retiredAt).toBeUndefined();
    expect(aborted).toMatchObject({ state: 'aborted', generation: 2 });
    // 便签交接复原、归档批次撤销
    expect(h.service.getWatch(watch.id)?.ownerSessionId).toBe(main.id);
    expect(view.transfers.every(item => item.status === 'reverted')).toBe(true);
    expect(h.service.getTask(done.id)?.archivedAt).toBeUndefined();
    // 回滚放回原处不是用户的决定：下次交接或整理照常折叠这张便签
    expect(h.service.getTask(done.id)?.restoredAt).toBeUndefined();
    // 半路新建的会话留档：改名「交接失败」并归档
    const orphan = await h.repos.sessions.get(view.toSessionId!);
    expect(orphan?.archivedAt).toBeTruthy();
    expect(orphan?.customTitle).toBe('交接失败 · 豆豆');
    // 回滚后旧猫照常工作，不会立刻又冒出一张提议
    expect((await h.lifecycle.light()).cat).toMatchObject({ generation: 1, name: '团子' });
    await h.lifecycle.scan();
    expect(h.lifecycle.listHandoffs().filter(item => item.state === 'proposed')).toHaveLength(0);
  });

  it('refuses to start while the main session is busy, and voids proposals for a replaced main session', async () => {
    const h = harness();
    const { main } = await adoptedWithNotes(h);
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user' });
    h.runtime.list(main.id).push({ id: 'rt_busy', sessionId: main.id, prompt: '还在跑', status: 'running', createdAt: now(), updatedAt: now() });
    await expect(h.lifecycle.confirmHandoff(proposal.id)).rejects.toMatchObject({ code: 'MAIN_BUSY', statusCode: 409 });
    expect(h.lifecycle.getHandoff(proposal.id).state).toBe('proposed');
    h.runtime.list(main.id).pop();

    const other = await h.runtime.start({ agentId: 'codex', source: 'assistant-main' });
    await h.service.setMainSession(other.id);
    await expect(h.lifecycle.confirmHandoff(proposal.id)).rejects.toMatchObject({ code: 'HANDOFF_STALE' });
    expect(h.lifecycle.getHandoff(proposal.id).state).toBe('cancelled');
  });

  it('lets the user decline; a declined proposal cannot be confirmed', async () => {
    const h = harness();
    await adoptedWithNotes(h);
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'threshold' });
    expect(h.lifecycle.cancelHandoff(proposal.id).state).toBe('cancelled');
    expect(h.lifecycle.cancelHandoff(proposal.id).state).toBe('cancelled');
    expect((await h.lifecycle.overview()).alerts.lastDismissedAt).toBeTruthy();
    await expect(h.lifecycle.confirmHandoff(proposal.id)).rejects.toMatchObject({ code: 'HANDOFF_CANCELLED' });
  });

  it('blocks re-adopting while the ceremony runs', async () => {
    const h = harness();
    await adoptedWithNotes(h);
    const gate = deferred();
    const original = h.runtime.start.getMockImplementation()!;
    h.runtime.start.mockImplementationOnce(async input => { await gate.promise; return original(input); });
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user' });
    await h.lifecycle.confirmHandoff(proposal.id);
    await expect(h.service.createMainSession({ agentId: 'claude' })).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' });
    await expect(h.service.clearMainSession()).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' });
    await expect(h.lifecycle.runMaintenance({ trigger: 'manual' })).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' });
    gate.resolve();
    await h.lifecycle.settle();
    expect(h.lifecycle.getHandoff(proposal.id).state).toBe('done');
  });

  it('marks the handoff partial when the briefing cannot be delivered, and resends it exactly once', async () => {
    const h = harness();
    await adoptedWithNotes(h);
    const proposal = await h.lifecycle.proposeHandoff({ trigger: 'user' });
    h.runtime.dispatch.mockRejectedValueOnce(new Error('driver 掉线'));
    await h.lifecycle.confirmHandoff(proposal.id);
    await h.lifecycle.settle();
    const partial = h.lifecycle.getHandoff(proposal.id);
    expect(partial).toMatchObject({ state: 'done', outcome: 'partial' });
    expect(partial.error).toContain(`agent-dock main handoff resend ${proposal.id}`);
    // 提交点已过：新猫在岗，旧会话已归档
    expect(h.service.mainSessionId).toBe(partial.toSessionId);

    const resent = await h.lifecycle.resendBriefing(proposal.id);
    expect(resent.outcome).toBe('needs_confirmation');
    expect(resent.error).toBeNull();
    const calls = h.runtime.dispatch.mock.calls.filter(call => call[5] === 'handoff').length;
    await h.lifecycle.resendBriefing(proposal.id);
    expect(h.runtime.dispatch.mock.calls.filter(call => call[5] === 'handoff').length).toBe(calls);
  });
});

describe('lifecycle metrics', () => {
  it('recalculates a legacy peak once and cancels the old events-based proposal', async () => {
    const h = harness();
    await h.service.initialize();
    const main = await h.service.createMainSession({ agentId: 'codex', cwd: '/work/dock', name: '团子' });
    const cat = (await h.lifecycle.ensureCat())!;
    const store = (h.lifecycle as unknown as { store: any }).store;
    cat.peakAgeScore = 1.127;
    cat.lifeStage = 'elder';
    cat.rounds = 9;
    store.saveCat(cat);
    store.saveHandoff({
      id: 'ahand_legacy', state: 'proposed', trigger: 'threshold',
      fromCatId: cat.id, fromSessionId: main.id, successorName: '豆豆',
      metrics: { rounds: 9, compactions: 0, events: 30_469, contextPercent: 9.7, openNotes: 3, closedNotes: 1, archivedNotes: 12, uptimeDays: 0.024 },
      reasons: [{ metric: 'events', level: 'handoff', value: 30_469, threshold: 30_000 }],
      steps: [], createdAt: now(), updatedAt: now()
    });
    store.setSetting('assistant.lifecycle.alerts', JSON.stringify({ catId: cat.id, levels: { events: 'handoff' }, autoRuns: [], lastProposalAt: now() }));

    const collected = (await h.lifecycle.collectMetrics(true))!;
    expect(collected.cat.peakAgeScore).toBe(0);
    expect(collected.cat.lifeStage).toBe('kitten');
    expect((await h.lifecycle.overview()).handoff).toBeNull();
    expect((await h.lifecycle.overview()).handoffs.find(item => item.id === 'ahand_legacy')?.state).toBe('cancelled');
    expect(store.getSetting('assistant.lifecycle.metricVersion')).toBe('2');
    expect((await h.lifecycle.overview()).alerts.levels).toEqual({});

    // 迁移只做一次：之后再长出的 peak 不会被第二次重置。
    cat.peakAgeScore = 0.7;
    cat.lifeStage = 'senior';
    store.saveCat(cat);
    const later = (await h.lifecycle.collectMetrics(true))!;
    expect(later.cat.peakAgeScore).toBe(0.7);
    expect(later.cat.lifeStage).toBe('senior');
  });

  it('counts only completed compactions and ages by them', async () => {
    const h = harness();
    await h.service.initialize();
    const main = await h.service.createMainSession({ agentId: 'codex', cwd: '/work/dock', name: '团子' });
    let sequence = 0;
    const append = (type: string, data: Record<string, unknown>) => appendEvent(h.repos, main.id, ++sequence, type, data);
    await append('status', { state: 'compaction', phase: 'start' });
    await append('status', { state: 'compaction', phase: 'start' });
    await append('status', { state: 'compaction', phase: 'summary' });
    await append('status', { state: 'compaction', phase: 'completed' });
    expect((await h.lifecycle.collectMetrics(true))!.metrics.compactions).toBe(1);

    for (let index = 0; index < 5; index++) await append('status', { state: 'compaction', phase: 'completed' });
    const collected = (await h.lifecycle.collectMetrics(true))!;
    expect(collected.metrics.compactions).toBe(6);
    expect(collected.ageScore).toBe(0.8);
    await h.lifecycle.scan();
    const view = await h.lifecycle.overview();
    expect(view.levels?.compactions).toBe('handoff');
    expect(view.handoff).toMatchObject({ state: 'proposed', reasons: [{ metric: 'compactions', level: 'handoff', value: 6, threshold: 6 }] });
  });

  it('counts merged conversation segments instead of raw streaming rows', async () => {
    const h = harness();
    await h.service.initialize();
    const main = await h.service.createMainSession({ agentId: 'codex', cwd: '/work/dock', name: '团子' });
    h.lifecycle.updateConfig({ set: { 'events.tidy': 5, 'events.handoff': 10 } });

    let sequence = 0;
    const append = (type: string, data: Record<string, unknown>) => appendEvent(h.repos, main.id, ++sequence, type, data);
    for (let index = 0; index < 1_000; index++) await append('thinking', { text: 'x' });
    for (let index = 0; index < 100; index++) await append('status', { state: 'usage', used: 10, size: 100 });
    for (let index = 0; index < 50; index++) await append('raw_terminal', { text: 'noise' });
    await append('text', { role: 'user', text: '开始' });
    await append('text', { text: '收到' });
    await append('tool_call', { title: 'read' });

    // 1,152 行原始事件，但只有 1 个思考段 + 用户锚点 + 正文段 + 工具 = 4 个对话段。
    const before = (await h.lifecycle.collectMetrics(true))!;
    expect(await h.repos.events.countBySession(main.id)).toBe(1_153);
    expect(before.metrics.events).toBe(4);
    await h.lifecycle.scan();
    expect((await h.lifecycle.overview()).levels?.events).toBe('ok');
    expect((await h.lifecycle.overview()).handoff).toBeNull();

    for (let index = 0; index < 10; index++) await append('tool_call', { title: `call-${index}` });
    const after = (await h.lifecycle.collectMetrics(true))!;
    expect(after.metrics.events).toBe(14);
    await h.lifecycle.scan();
    expect((await h.lifecycle.overview()).levels?.events).toBe('handoff');
    expect((await h.lifecycle.overview()).reasons).toContainEqual({ metric: 'events', level: 'handoff', value: 14, threshold: 10 });
    expect((await h.lifecycle.overview()).handoff).toMatchObject({ state: 'proposed', reasons: [{ metric: 'events', level: 'handoff', value: 14, threshold: 10 }] });
  });
});

describe('lifecycle config migration', () => {
  const storeOf = (h: ReturnType<typeof harness>) => (h.lifecycle as unknown as { store: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void } }).store;

  it('restores the temporary events guard and fills compaction thresholds exactly once', async () => {
    const h = harness();
    const store = storeOf(h);
    store.setSetting('assistant.lifecycle.config', JSON.stringify({
      autoMaintenance: true, autoProposeHandoff: true, foldClosedAfterHours: 12, maxAutoRunsPerDay: 2,
      thresholds: {
        rounds: { tidy: 200, handoff: 600 },
        events: { tidy: 200_000, handoff: 300_000 },
        contextPercent: { tidy: 75, handoff: 90 },
        openNotes: { tidy: 15 }, closedNotes: { tidy: 40 }, archivedNotes: { tidy: 500 },
        uptimeDays: { tidy: 14, handoff: 45 }
      }
    }));

    await h.service.initialize();
    const config = h.lifecycle.getConfig();
    expect(config.thresholds.compactions).toEqual({ tidy: 3, handoff: 6 });
    expect(config.thresholds.events).toEqual({ tidy: 20_000, handoff: 60_000 });
    expect(config.thresholds.rounds).toEqual({ tidy: 200, handoff: 600 });
    expect(store.getSetting('assistant.lifecycle.configVersion')).toBe('1');
    // 规范化结果要落库，不能只靠读取时补默认值。
    const persisted = JSON.parse(store.getSetting('assistant.lifecycle.config')!);
    expect(persisted.thresholds.compactions).toEqual({ tidy: 3, handoff: 6 });
    expect(persisted.thresholds.events).toEqual({ tidy: 20_000, handoff: 60_000 });

    // 版本标记之后不再干预：用户明确设置守卫值也会被保留。
    h.lifecycle.updateConfig({ set: { 'events.tidy': 200_000, 'events.handoff': 300_000 } });
    await h.service.initialize();
    expect(h.lifecycle.getConfig().thresholds.events).toEqual({ tidy: 200_000, handoff: 300_000 });
    expect(h.lifecycle.getConfig().thresholds.compactions).toEqual({ tidy: 3, handoff: 6 });
  });

  it('keeps intentional thresholds while filling missing compaction thresholds', async () => {
    const h = harness();
    const store = storeOf(h);
    store.setSetting('assistant.lifecycle.config', JSON.stringify({
      thresholds: { events: { tidy: 100_000, handoff: 200_000 } }
    }));

    await h.service.initialize();
    const config = h.lifecycle.getConfig();
    expect(config.thresholds.events).toEqual({ tidy: 100_000, handoff: 200_000 });
    expect(config.thresholds.compactions).toEqual({ tidy: 3, handoff: 6 });
    expect(config.autoMaintenance).toBe(true);
  });
});

describe('crash recovery', () => {
  async function crashDuringRetiring(archiveFirst: boolean) {
    const directory = mkdtempSync(join(tmpdir(), 'agentdock-lifecycle-'));
    directories.push(directory);
    const databaseUrl = join(directory, 'agentdock.db');
    const repos = createRepositories(':memory:');
    repositories.push(repos);
    const first = harness({ repos, databaseUrl });
    const { main } = await adoptedWithNotes(first);
    // 让「归档旧会话」永远不返回：模拟 daemon 在提交点附近被杀
    first.runtime.archive.mockImplementationOnce(async (id: string) => {
      if (archiveFirst) {
        const session = (await repos.sessions.get(id))!;
        session.archivedAt = now();
        session.state = 'stopped';
        await repos.sessions.save(session);
      }
      return new Promise<never>(() => undefined);
    });
    const proposal = await first.lifecycle.proposeHandoff({ trigger: 'user' });
    await first.lifecycle.confirmHandoff(proposal.id, { name: '豆豆' });
    await vi.waitFor(() => expect(first.lifecycle.getHandoff(proposal.id).state).toBe('retiring'));
    await first.service.close();

    const second = harness({ repos, databaseUrl });
    await second.service.initialize();
    return { second, main, proposal };
  }

  it('rolls back a ceremony that died before the commit point', async () => {
    const { second, main, proposal } = await crashDuringRetiring(false);
    const view = second.lifecycle.getHandoff(proposal.id);
    expect(view.state).toBe('rolled_back');
    expect(view.error).toContain('daemon 重启');
    expect(second.service.mainSessionId).toBe(main.id);
    expect(second.lifecycle.lineage().map(cat => cat.state)).toEqual(['active', 'aborted']);
  });

  it('keeps a ceremony that died after archiving the old session and marks it partial', async () => {
    const { second, main, proposal } = await crashDuringRetiring(true);
    const view = second.lifecycle.getHandoff(proposal.id);
    expect(view).toMatchObject({ state: 'done', outcome: 'partial' });
    expect(view.error).toContain('resend');
    expect(second.service.mainSessionId).toBe(view.toSessionId);
    expect(second.service.mainSessionId).not.toBe(main.id);
    expect(second.lifecycle.lineage().map(cat => cat.state)).toEqual(['retired', 'active']);
  });
});

describe('housekeeping rounds', () => {
  it('runs a visible maintenance round that cannot dispatch work, then folds closed notes reversibly', async () => {
    const h = harness();
    const { main, done } = await adoptedWithNotes(h);
    const run = await h.lifecycle.runMaintenance({ trigger: 'manual', reason: '收拾一下', from: main.id });
    const call = h.runtime.dispatch.mock.calls.find(item => item[5] === 'maintenance')!;
    expect(call[0]).toBe(main.id);
    // 主会话自己要的整理：可见文本和指令都写明是它自己，不冒充用户
    expect(call[1]).toBe('🧹 整理轮次 · 我自己收拾一下');
    expect(call[3]).toContain('你（主会话）要求整理：收拾一下');
    expect(call[3]).toContain(MAINTENANCE_MARKER);
    expect(call[3]).toContain(done.id);
    expect(call[3]).toContain('/Users/codeax/notes/plan.md');
    // 同一时刻只有一轮
    expect((await h.lifecycle.runMaintenance({ trigger: 'manual' })).id).toBe(run.id);
    expect(h.runtime.dispatch.mock.calls.filter(item => item[5] === 'maintenance')).toHaveLength(1);

    // 整理轮次跑起来后：主会话的派活、通知、再开整理都被拒绝；用户和侧边会话不受影响
    const task = h.runtime.list(main.id).find(item => item.id === run.runtimeTaskId)!;
    task.status = 'running';
    await expect(h.lifecycle.assertNoSystemRound(main.id, '派活')).rejects.toMatchObject({ code: 'SYSTEM_ROUND_ACTIVE', statusCode: 409 });
    await expect(h.lifecycle.runMaintenance({ trigger: 'manual', from: main.id })).rejects.toMatchObject({ code: 'SYSTEM_ROUND_ACTIVE' });
    await expect(h.lifecycle.assertNoSystemRound(undefined, '派活')).resolves.toBeUndefined();
    await expect(h.lifecycle.assertNoSystemRound('ses_side_2', '派活')).resolves.toBeUndefined();
    const composed = await h.service.composePrompt((await h.repos.sessions.get(main.id))!, call[1], 'maintenance');
    expect(composed).not.toContain('<agentdock-superagent>');
    expect(buildSuperagentDirective(call[3]!)).toBe('');

    // 结束：最终回复当摘要，关闭够久的便签折叠进归档区（由主会话的状态事件触发）
    h.lifecycle.start();
    h.lifecycle.updateConfig({ foldClosedAfterHours: 0 });
    task.status = 'completed';
    task.finalText = '## 本代摘要\n在修登录超时。';
    for (const listener of h.runtime.listeners) listener({ sessionId: main.id, state: 'idle' });
    await vi.waitFor(() => expect(h.lifecycle.overview().then(view => view.maintenance)).resolves.toBeNull());
    const finished = (await h.lifecycle.overview()).maintenanceRuns[0]!;
    expect(finished).toMatchObject({ id: run.id, state: 'completed', summary: '## 本代摘要\n在修登录超时。' });
    expect(finished.archiveBatchId).toBeTruthy();
    expect(h.service.getTask(done.id)?.archivedAt).toBeTruthy();
    expect(h.lifecycle.latestLetter((await h.lifecycle.light()).cat!.id)?.summary).toContain('在修登录超时');

    // 撤销折叠：便签回到墙上
    const undone = h.lifecycle.unarchiveNotes({ batchId: finished.archiveBatchId! });
    expect(undone.restored).toEqual([done.id]);
    expect(undone.batch?.undoneAt).toBeTruthy();
    expect(h.service.getTask(done.id)?.archivedAt).toBeUndefined();

    // 撤销要算数：取出的便签不再算「待整理」，下一轮自动折叠也不收它；用户自己归档照常
    expect(h.service.getTask(done.id)?.restoredAt).toBeTruthy();
    expect((await h.lifecycle.collectMetrics(true))?.metrics.closedNotes).toBe(0);
    expect(h.lifecycle.archiveNotes({ closedBeforeHours: 0, source: 'maintenance' })).toBeUndefined();
    expect(h.lifecycle.archiveNotes({ closedBeforeHours: 0, source: 'handoff' })).toBeUndefined();
    expect(h.lifecycle.archiveNotes({ taskIds: [done.id], source: 'manual' })?.taskIds).toEqual([done.id]);
  });

  it('refreshes metrics as soon as a main-session round ends instead of waiting for the cache', async () => {
    const h = harness();
    const { main } = await adoptedWithNotes(h);
    h.lifecycle.start();
    const before = (await h.lifecycle.collectMetrics())!.metrics.rounds;
    const task = await h.runtime.dispatch(main.id, '用户：再来一轮');
    task.status = 'completed';
    expect((await h.lifecycle.collectMetrics())!.metrics.rounds).toBe(before);
    // 侧边会话结束不影响主会话的缓存；主会话回到空闲才重算
    for (const listener of h.runtime.listeners) listener({ sessionId: 'ses_side_9', state: 'idle' });
    expect((await h.lifecycle.collectMetrics())!.metrics.rounds).toBe(before);
    for (const listener of h.runtime.listeners) listener({ sessionId: main.id, state: 'idle' });
    expect((await h.lifecycle.collectMetrics())!.metrics.rounds).toBe(before + 1);
  });

  it('records an interrupted round instead of folding anything', async () => {
    const h = harness();
    const { main, done } = await adoptedWithNotes(h);
    h.lifecycle.updateConfig({ foldClosedAfterHours: 0 });
    const run = await h.lifecycle.runMaintenance({ trigger: 'manual' });
    h.runtime.list(main.id).find(item => item.id === run.runtimeTaskId)!.status = 'interrupted';
    await h.lifecycle.checkMaintenanceCompletion();
    expect((await h.lifecycle.overview()).maintenanceRuns[0]).toMatchObject({ state: 'interrupted' });
    expect(h.service.getTask(done.id)?.archivedAt).toBeUndefined();
  });

  it('auto-detects once per threshold and never spams', async () => {
    const h = harness();
    const { main } = await adoptedWithNotes(h);
    h.lifecycle.updateConfig({ set: { 'closedNotes.tidy': 1 } });
    await h.lifecycle.scan();
    const maintenanceCalls = () => h.runtime.dispatch.mock.calls.filter(call => call[5] === 'maintenance');
    expect(maintenanceCalls()).toHaveLength(1);
    expect(maintenanceCalls()[0]![1]).toBe('🧹 整理轮次 · 已完成便签 1/1');
    const run = (await h.lifecycle.overview()).maintenance!;
    expect(run.trigger).toBe('auto');

    // 轮次结束；刚关闭的便签不到 12 小时不折叠，指标还在整理档
    h.runtime.list(main.id).find(item => item.id === run.runtimeTaskId)!.status = 'completed';
    await h.lifecycle.checkMaintenanceCompletion();
    for (let index = 0; index < 3; index++) await h.lifecycle.scan();
    expect(maintenanceCalls()).toHaveLength(1);
    expect(h.lifecycle.listHandoffs()).toHaveLength(0);
  });

  it('proposes a handoff once at the handoff level and holds tidy rounds while the proposal is open', async () => {
    const h = harness();
    await adoptedWithNotes(h);
    // 主会话跑过 1 轮；把交接档压到 1 轮，整理档关掉
    h.lifecycle.updateConfig({ set: { 'rounds.tidy': null, 'rounds.handoff': 1 } });
    await h.lifecycle.scan();
    const open = h.lifecycle.listHandoffs();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ state: 'proposed', trigger: 'threshold' });
    expect(open[0]!.reasons).toEqual([{ metric: 'rounds', level: 'handoff', value: 1, threshold: 1 }]);
    expect((await h.lifecycle.light()).cat?.lifeStage).toBe('elder');

    h.lifecycle.updateConfig({ set: { 'closedNotes.tidy': 1 } });
    await h.lifecycle.scan();
    await h.lifecycle.scan();
    expect(h.lifecycle.listHandoffs()).toHaveLength(1);
    expect(h.runtime.dispatch.mock.calls.filter(call => call[5] === 'maintenance')).toHaveLength(0);
    // 快照提醒主会话：确认只能由用户做
    const main = (await h.repos.sessions.get(h.service.mainSessionId!))!;
    expect(await h.service.composePrompt(main, '在吗')).toContain('确认只能由用户在网页或终端完成');
  });
});

describe('notes archive and lineage bookkeeping', () => {
  it('only folds closed notes and never deletes them', async () => {
    const h = harness();
    const { running, done } = await adoptedWithNotes(h);
    expect(() => h.lifecycle.archiveNotes({ taskIds: [running.id], source: 'manual' })).toThrow('只能归档已关闭的便签');
    expect(() => h.lifecycle.archiveNotes({ taskIds: ['atask_missing'], source: 'manual' })).toThrow('事项不存在');
    expect(h.lifecycle.archiveNotes({ closedBeforeHours: 24, source: 'manual' })).toBeUndefined();
    const batch = h.lifecycle.archiveNotes({ taskIds: [done.id], source: 'manual', reason: '手动收起' })!;
    expect(batch.taskIds).toEqual([done.id]);
    expect(h.lifecycle.archiveNotes({ taskIds: [done.id], source: 'manual' })).toBeUndefined();
    const view = h.lifecycle.archiveView();
    expect(view.batches.map(item => item.id)).toEqual([batch.id]);
    expect(view.tasks.map(task => task.id)).toEqual([done.id]);
    expect(h.service.listTasks()).toHaveLength(3);
    expect((await h.lifecycle.collectMetrics(true))?.metrics).toMatchObject({ openNotes: 2, closedNotes: 0, archivedNotes: 1 });
    expect(h.lifecycle.unarchiveNotes({ taskIds: [done.id] }).restored).toEqual([done.id]);
  });

  it('keeps released cats in the record and starts a new family on re-adoption', async () => {
    const h = harness();
    await h.service.initialize();
    const first = await h.service.createMainSession({ agentId: 'claude', name: '团子' });
    await h.service.clearMainSession();
    expect(h.lifecycle.lineage()).toMatchObject([{ sessionId: first.id, state: 'released' }]);
    const second = await h.service.createMainSession({ agentId: 'claude', name: '年糕' });
    const third = await h.runtime.start({ agentId: 'codex', source: 'assistant-main' });
    await h.service.setMainSession(third.id);
    const cats = h.lifecycle.lineage();
    expect(cats.map(cat => [cat.sessionId, cat.state, cat.generation])).toEqual([
      [first.id, 'released', 1], [second.id, 'released', 1], [third.id, 'active', 1]
    ]);
    expect(new Set(cats.map(cat => cat.familyId)).size).toBe(3);
    await h.service.renameCompanion('芝麻');
    expect(h.lifecycle.lineage().at(-1)?.name).toBe('芝麻');
  });

  it('persists thresholds and rejects invalid config with a 400', async () => {
    const h = harness();
    await adoptedWithNotes(h);
    const config = h.lifecycle.updateConfig({ autoMaintenance: false, set: { 'uptimeDays.handoff': null } });
    expect(config.thresholds.uptimeDays).toEqual({ tidy: 14 });
    expect(h.lifecycle.getConfig()).toEqual(config);
    expect(() => h.lifecycle.updateConfig({ set: { 'rounds.tidy': 9_999 } })).toThrow(expect.objectContaining({ code: 'INVALID_LIFECYCLE_CONFIG', statusCode: 400 }));
  });
});

describe('lifecycle HTTP routes', () => {
  async function appFor(service: AssistantService) {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof RuntimeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } });
    });
    registerAssistantRoutes(app, service);
    await app.ready();
    return app;
  }

  it('lets the main session propose but only the user confirm', async () => {
    const h = harness();
    const { main, running } = await adoptedWithNotes(h);
    const app = await appFor(h.service);
    try {
      const side = await app.inject({ method: 'POST', url: '/api/assistant/handoff', payload: { from: running.sessionId } });
      expect(side.statusCode).toBe(403);
      const proposed = await app.inject({ method: 'POST', url: '/api/assistant/handoff', payload: { from: main.id, reason: '我有点累了' } });
      expect(proposed.statusCode).toBe(200);
      const handoff = proposed.json().handoff;
      expect(handoff).toMatchObject({ state: 'proposed', trigger: 'agent', reason: '我有点累了' });
      const agentConfirm = await app.inject({ method: 'POST', url: `/api/assistant/handoff/${handoff.id}/confirm`, payload: { from: main.id } });
      expect(agentConfirm.statusCode).toBe(403);
      expect(agentConfirm.json().error.message).toContain('用户本人');

      const state = await app.inject({ method: 'GET', url: '/api/assistant/state' });
      expect(state.json().lifecycle).toMatchObject({ cat: { generation: 1, name: '团子', lifeStage: 'kitten' }, handoff: { id: handoff.id, state: 'proposed' } });

      const confirmed = await app.inject({ method: 'POST', url: `/api/assistant/handoff/${handoff.id}/confirm`, payload: { name: '豆豆' } });
      expect(confirmed.statusCode).toBe(200);
      await h.lifecycle.settle();
      const detail = await app.inject({ method: 'GET', url: `/api/assistant/handoff/${handoff.id}` });
      expect(detail.json().handoff).toMatchObject({ state: 'done', outcome: 'needs_confirmation', fromSessionId: main.id });
      const after = (await app.inject({ method: 'GET', url: '/api/assistant/state' })).json();
      expect(after.mainSessionId).not.toBe(main.id);
      expect(after.lifecycle).toMatchObject({ cat: { generation: 2, name: '豆豆', lifeStage: 'kitten', predecessor: { generation: 1, sessionId: main.id } }, handoff: null, lastHandoff: { id: handoff.id } });
      const lineage = (await app.inject({ method: 'GET', url: '/api/assistant/lineage' })).json().lineage;
      expect(lineage.map((cat: { state: string }) => cat.state)).toEqual(['retired', 'active']);
      expect((await app.inject({ method: 'GET', url: '/api/assistant/handoff/ahand_missing' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects dispatch, watches and plain notifications from the main session during a system round', async () => {
    const h = harness();
    const { main } = await adoptedWithNotes(h);
    const app = await appFor(h.service);
    try {
      const started = await app.inject({ method: 'POST', url: '/api/assistant/maintenance/run', payload: { from: main.id } });
      expect(started.statusCode).toBe(200);
      const run = started.json().run;
      h.runtime.list(main.id).find(item => item.id === run.runtimeTaskId)!.status = 'running';

      const dispatch = await app.inject({ method: 'POST', url: '/api/assistant/tasks', payload: { from: main.id, title: '再派一个', doneWhen: ['x'] } });
      expect(dispatch.statusCode).toBe(409);
      expect(dispatch.json().error.code).toBe('SYSTEM_ROUND_ACTIVE');
      expect((await app.inject({ method: 'POST', url: '/api/assistant/tasks', payload: { from: main.id, title: '记一张', doneWhen: ['x'], plan: true } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/assistant/watches', payload: { from: main.id, name: 'w', command: 'true' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/assistant/notify', payload: { from: main.id, text: '整理好了' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/assistant/maintenance/run', payload: { from: main.id } })).statusCode).toBe(409);
      // 真要紧的通知、用户在网页上的操作不受影响
      expect((await app.inject({ method: 'POST', url: '/api/assistant/notify', payload: { from: main.id, text: '线上挂了', urgent: true } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/assistant/tasks', payload: { title: '用户记的', doneWhen: ['x'], plan: true } })).statusCode).toBe(200);

      const status = (await app.inject({ method: 'GET', url: '/api/assistant/maintenance' })).json();
      expect(status.active).toMatchObject({ id: run.id, trigger: 'manual' });
      expect(status.config.thresholds.rounds).toEqual({ tidy: 200, handoff: 600 });
    } finally {
      await app.close();
    }
  });

  it('validates config and archive input', async () => {
    const h = harness();
    const { running, done } = await adoptedWithNotes(h);
    const app = await appFor(h.service);
    try {
      const bad = await app.inject({ method: 'PUT', url: '/api/assistant/maintenance/config', payload: { set: { 'rounds.tidy': 10_000 } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('INVALID_LIFECYCLE_CONFIG');
      const good = await app.inject({ method: 'PUT', url: '/api/assistant/maintenance/config', payload: { autoMaintenance: false, set: { 'rounds.tidy': 300 } } });
      expect(good.json().config).toMatchObject({ autoMaintenance: false, thresholds: { rounds: { tidy: 300, handoff: 600 } } });
      expect((await app.inject({ method: 'PUT', url: '/api/assistant/maintenance/config', payload: { from: running.sessionId, autoMaintenance: true } })).statusCode).toBe(403);

      expect((await app.inject({ method: 'POST', url: '/api/assistant/notes/archive', payload: { taskIds: [running.id] } })).statusCode).toBe(400);
      const archived = await app.inject({ method: 'POST', url: '/api/assistant/notes/archive', payload: { taskIds: [done.id], reason: '收起来' } });
      expect(archived.json()).toMatchObject({ archived: 1, batch: { source: 'manual', taskIds: [done.id] } });
      const view = (await app.inject({ method: 'GET', url: '/api/assistant/notes/archive' })).json();
      expect(view.tasks.map((task: { id: string }) => task.id)).toEqual([done.id]);
      const restored = await app.inject({ method: 'POST', url: '/api/assistant/notes/unarchive', payload: { batchId: archived.json().batch.id } });
      expect(restored.json().restored).toEqual([done.id]);
      expect((await app.inject({ method: 'POST', url: '/api/assistant/notes/unarchive', payload: {} })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

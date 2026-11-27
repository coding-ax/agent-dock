import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { AgentDockRuntime } from '@agent-dock/agent-dock-runtime';
import type { RepositoryBundle } from '@agent-dock/agent-dock-shared';
import { buildApp } from '../app.js';
import { AssistantService } from '../assistant/service.js';
import { BoardService } from './service.js';
import { runNotifyChannelCommandSet } from '../notifications/cli.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function setupBoardApp() {
  const repos: RepositoryBundle = createRepositories(':memory:');
  const runtime = new AgentDockRuntime(repos, { acpxCommand: 'true' });
  await runtime.initialize([{
    id: 'mock',
    name: 'Mock Agent',
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    protocol: 'jsonl',
    env: {},
    permissionMode: 'full-trust',
    timeout: 60,
    capabilities: { pause: false, resume: true },
    builtin: false
  }]);
  let boards: BoardService;
  const assistant = new AssistantService({
    databaseUrl: ':memory:',
    runtime,
    repos,
    boardSnapshot: () => boards.snapshotForMainSession(),
    onTaskMutated: task => boards.hub.broadcast({ event: 'task.updated', data: { taskId: task.id, state: task.state } })
  });
  await assistant.initialize();
  boards = new BoardService({ repos, runtime, assistant, throttleMs: 20 });
  boards.start();
  const app = await buildApp(runtime, { assistant, boards });

  cleanups.push(async () => {
    boards.close();
    await assistant.close();
    await app.close();
    await runtime.shutdown();
    repos.close();
  });

  return { repos, runtime, assistant, boards, app };
}

describe('BoardService & /api/boards', () => {
  it('seeds default status board and auto-projects tasks & sessions by live state', async () => {
    const { repos, boards, assistant, app } = await setupBoardApp();
    const t = new Date().toISOString();

    const cwd = process.cwd();
    await repos.sessions.save({
      id: 'ses_main',
      agentId: 'mock',
      state: 'idle',
      cwd,
      runId: 'run_main',
      source: 'assistant-main',
      createdAt: t,
      updatedAt: t
    });
    await assistant.setMainSession('ses_main');

    const planned = assistant.planTask({
      title: '计划中的功能',
      doneWhen: ['方案通过'],
      cwd
    });

    await repos.sessions.save({
      id: 'ses_running',
      agentId: 'mock',
      state: 'running_tool',
      cwd,
      runId: 'run_1',
      createdAt: t,
      updatedAt: t
    });
    await repos.sessions.saveTitles('ses_running', { customTitle: '后台联调会话' });

    const res = await app.inject({ method: 'GET', url: '/api/boards/default' });
    expect(res.statusCode).toBe(200);
    const hydrated = res.json();
    expect(hydrated.board.name).toBe('运行状态');
    expect(hydrated.columns.map((c: { name: string }) => c.name)).toEqual(['需要你', '进行中', '待验收', '近期完成']);

    const needsCol = hydrated.columns.find((c: { name: string }) => c.name === '需要你');
    const runningCol = hydrated.columns.find((c: { name: string }) => c.name === '进行中');
    expect(needsCol.items.some((i: { entityId: string }) => i.entityId === planned.id)).toBe(true);
    expect(runningCol.items.some((i: { entityId: string }) => i.entityId === 'ses_running')).toBe(true);
    // 主会话自身不应被自动投进规则列
    expect(hydrated.columns.flatMap((c: { items: Array<{ entityId: string }> }) => c.items).some((i: { entityId: string }) => i.entityId === 'ses_main')).toBe(false);

    // 把运行中的会话手动拖入「待验收」：应自动物化并打 manualOverride=true，防止被规则列吸回「进行中」
    const reviewCol = hydrated.columns.find((c: { name: string }) => c.name === '待验收');
    const virtualRunningItem = runningCol.items.find((i: { entityId: string }) => i.entityId === 'ses_running');
    const moveRes = await app.inject({
      method: 'POST',
      url: `/api/boards/${hydrated.board.id}/items/${encodeURIComponent(virtualRunningItem.id)}/move`,
      payload: { toColumnId: reviewCol.id, actor: 'web' }
    });
    expect(moveRes.statusCode).toBe(200);
    const movedBody = moveRes.json();
    expect(movedBody.item.manualOverride).toBe(true);
    expect(movedBody.item.columnId).toBe(reviewCol.id);

    const afterHydrated = await boards.getHydratedBoard(hydrated.board.id);
    expect(afterHydrated.columns.find(c => c.id === reviewCol.id)?.items.some(i => i.entityId === 'ses_running')).toBe(true);
    expect(afterHydrated.columns.find(c => c.id === runningCol.id)?.items.some(i => i.entityId === 'ses_running')).toBe(false);
  });

  it('supports custom boards, quick switching memory (use), column moves, notes, and export/import', async () => {
    const { app } = await setupBoardApp();

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/boards',
      payload: { name: '发布冲刺', template: 'blank', viewMode: 'grid', density: 'comfortable', isDefault: true }
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.board.isDefault).toBe(true);
    expect(created.board.viewMode).toBe('grid');
    expect(created.columns).toHaveLength(3);

    // 切回默认看板再切回自定义看板，验证记忆切换
    const listRes = await app.inject({ method: 'GET', url: '/api/boards' });
    expect(listRes.json().defaultBoardId).toBe(created.board.id);

    // 加列与调整列序
    const addColRes = await app.inject({
      method: 'POST',
      url: `/api/boards/${created.board.id}/columns`,
      payload: { name: '高优阻塞', color: 'red', wipLimit: 3 }
    });
    expect(addColRes.statusCode).toBe(201);
    const newCol = addColRes.json().column;

    const moveColRes = await app.inject({
      method: 'POST',
      url: `/api/boards/columns/${newCol.id}/move`,
      payload: { index: 0 }
    });
    expect(moveColRes.statusCode).toBe(200);
    expect(moveColRes.json().board.columns[0].id).toBe(newCol.id);

    // 加轻量卡片与写小猫批注
    const addItemRes = await app.inject({
      method: 'POST',
      url: `/api/boards/${created.board.id}/items`,
      payload: { columnId: newCol.id, entityKind: 'note', title: '今晚 22:00 回归验证', kittenNote: '团子会提前提醒', pinned: true, tags: ['发布'] }
    });
    expect(addItemRes.statusCode).toBe(201);
    expect(addItemRes.json().item.kittenNote).toBe('团子会提前提醒');

    // 导出并导入成副本看板
    const expRes = await app.inject({ method: 'GET', url: `/api/boards/${created.board.id}/export?includeItems=1` });
    expect(expRes.statusCode).toBe(200);
    const tpl = expRes.json();
    expect(tpl.version).toBe(1);
    expect(tpl.columns[0].name).toBe('高优阻塞');

    const impRes = await app.inject({
      method: 'POST',
      url: '/api/boards/import',
      payload: { template: tpl, name: '发布冲刺-复制' }
    });
    expect(impRes.statusCode).toBe(201);
    expect(impRes.json().board.name).toBe('发布冲刺-复制');
    expect(impRes.json().columns[0].items).toHaveLength(1);
  });

  it('produces compact board snapshot for main kitten context', async () => {
    const { boards } = await setupBoardApp();
    const snap = await boards.snapshotForMainSession();
    expect(snap).toContain('运行状态');
    expect(snap).toContain('进行中');
  });

  it('serves aggregated /api/usage/quotas and streams board hub events', async () => {
    const { app, boards } = await setupBoardApp();
    const res = await app.inject({ method: 'GET', url: '/api/usage/quotas?agent=codex' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['codex']);

    const seen: string[] = [];
    const off = boards.hub.subscribe(ev => seen.push(ev.event));
    await boards.createBoard({ name: '监控看板', template: 'blank' });
    off();
    expect(seen).toContain('board.mutated');
  });

  it('blocks Agent sessions from passing --trust-confirm on notify command channel', async () => {
    const prev = process.env.agentdock_session_id;
    process.env.agentdock_session_id = 'ses_agent_test';
    try {
      await expect(runNotifyChannelCommandSet({ enabled: true, cmd: 'echo test', trustConfirm: true })).rejects.toThrow(/本地终端执行/);
    } finally {
      if (prev === undefined) delete process.env.agentdock_session_id;
      else process.env.agentdock_session_id = prev;
    }
  });
});

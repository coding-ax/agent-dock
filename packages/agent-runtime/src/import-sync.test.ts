import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { AgentConfig, ImportedTurn, TaskRecord } from '@agent-dock/agent-dock-shared';
import { AgentDockRuntime, alignImportedTurns, type AgentDriver } from './index.js';

const agent: AgentConfig = { id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
const turn = (prompt: string): ImportedTurn => ({ prompt, finalText: `re:${prompt}`, events: [{ type: 'text', data: { text: `re:${prompt}` } }] });
const task = (prompt: string, status = 'completed', sentPrompt?: string, at = prompt): TaskRecord => ({ id: `task_${prompt}`, sessionId: 's', prompt, sentPrompt, status, createdAt: at, updatedAt: at });

const prompts = (result: ReturnType<typeof alignImportedTurns>) => result && { turns: result.turns.map(item => item.prompt), skipped: result.skipped };

describe('alignImportedTurns', () => {
  it('按序对齐后只返回外部多出来的尾部轮次', () => {
    expect(prompts(alignImportedTurns([task('a'), task('b')], [turn('a'), turn('b'), turn('c')]))).toEqual({ turns: ['c'], skipped: 0 });
    expect(prompts(alignImportedTurns([task('a'), task('b')], [turn('a'), turn('b')]))).toEqual({ turns: [], skipped: 0 });
  });

  it('AgentDock 续聊的轮次按实际发送文本也能对上，空白差异不影响', () => {
    const tasks = [task('a', 'completed', undefined, '1'), task('hi', 'completed', '[工具说明]\nhi', '2')];
    expect(prompts(alignImportedTurns(tasks, [turn('a'), turn('[工具说明] hi'), turn('c')]))).toEqual({ turns: ['c'], skipped: 0 });
  });

  it('两边交替聊：夹在中间的外部轮次计入 skipped，不判失败，尾部照常追加', () => {
    // AgentDock 发 X → Codex 发 Y → 没同步就回 AgentDock 发 Z → Codex 又发 W。
    const tasks = [task('x', 'completed', undefined, '1'), task('z', 'completed', undefined, '2')];
    expect(prompts(alignImportedTurns(tasks, [turn('x'), turn('y'), turn('z'), turn('w')]))).toEqual({ turns: ['w'], skipped: 1 });
  });

  it('排队/取消的任务不参与；中断失败的轮次外部没记下时跳过', () => {
    const tasks = [task('a', 'completed', undefined, '1'), task('x', 'interrupted', 'x', '2'), task('q', 'queued', undefined, '3'), task('z', 'cancelled', undefined, '4')];
    expect(prompts(alignImportedTurns(tasks, [turn('a'), turn('b')]))).toEqual({ turns: ['b'], skipped: 0 });
  });

  it('重复的短句按顺序逐个消耗，不会两个本地轮次对到同一个外部轮次', () => {
    const tasks = [task('继续', 'completed', undefined, '1'), task('继续', 'completed', undefined, '2')];
    expect(prompts(alignImportedTurns(tasks, [turn('继续'), turn('继续'), turn('继续')]))).toEqual({ turns: ['继续'], skipped: 0 });
  });

  it('发送前就失败的任务不占位，同名重发的那一轮仍能对上', () => {
    const tasks = [task('a', 'completed', undefined, '1'), { ...task('r', 'failed', undefined, '2'), id: 'task_r1' }, { ...task('r', 'completed', 'r', '3'), id: 'task_r2' }];
    expect(prompts(alignImportedTurns(tasks, [turn('a'), turn('r'), turn('n')]))).toEqual({ turns: ['n'], skipped: 0 });
  });

  it('兼容早期导入留下的「（外部会话）」前缀', () => {
    expect(prompts(alignImportedTurns([task('（外部会话）a', 'completed', undefined, '1')], [turn('a'), turn('b')]))).toEqual({ turns: ['b'], skipped: 0 });
  });

  it('已完成的轮次在外部完全找不到才判无法合并', () => {
    expect(alignImportedTurns([task('a', 'completed', undefined, '1'), task('b', 'completed', undefined, '2')], [turn('a'), turn('c')])).toBeUndefined();
    expect(alignImportedTurns([task('a')], [])).toBeUndefined();
  });
});

describe('syncImportedSession', () => {
  function harness() {
    const repos = createRepositories(':memory:');
    const driver: AgentDriver = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const resumeIds: Array<string | undefined> = [];
    const runtime = new AgentDockRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: (_a, _p, _e, _x, _s, options) => { resumeIds.push(options?.resumeSessionId); return driver; } });
    return { repos, runtime, driver, resumeIds };
  }

  it('先释放自己的 driver 再读外部历史，只追加新轮次，之后按导入 id 惰性重连', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const session = await h.runtime.start({ agentId: 'mock', resumeSessionId: 'ext-1', source: 'import', sourceId: 'ext-1', importTurns: [turn('a')] });
    const load = vi.fn(async () => { expect(h.driver.stop).toHaveBeenCalled(); return { replayed: true, turns: [turn('a'), turn('b'), turn('c')] }; });
    expect(await h.runtime.syncImportedSession(session.id, load)).toEqual({ added: 2, skipped: 0 });
    expect((await h.runtime.getTasks(session.id)).map(item => item.prompt).sort()).toEqual(['a', 'b', 'c']);
    const texts = (await h.runtime.getEvents(session.id)).filter(event => event.type === 'text' && (event.data as any).role === 'user').map(event => (event.data as any).text);
    expect(texts).toEqual(['a', 'b', 'c']);
    // 再同步一次是幂等的。
    expect(await h.runtime.syncImportedSession(session.id, load)).toEqual({ added: 0, skipped: 0 });
    await h.runtime.send(session.id, 'd');
    expect(h.resumeIds.at(-1)).toBe('ext-1');
    h.repos.close();
  });

  it('同步后立刻发消息：重连遇到 active writer 会退避重试', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const h = harness();
      await h.runtime.initialize([agent]);
      const session = await h.runtime.start({ agentId: 'mock', resumeSessionId: 'ext-3', source: 'import', sourceId: 'ext-3', importTurns: [turn('a')] });
      await h.runtime.syncImportedSession(session.id, async () => ({ replayed: true, turns: [turn('a')] }));
      const writer = Object.assign(new Error('Internal error'), { data: { details: 'thread ext-3 already has an active writer' } });
      // 第一次是裸错误，第二次是适配层包过一层的（设权限模式时撞锁），两种都要重试。
      vi.mocked(h.driver.start).mockRejectedValueOnce(writer).mockRejectedValueOnce(new Error('无法将 Codex 权限模式设为 agent-full-access，已停止执行。', { cause: writer }));
      const sending = h.runtime.send(session.id, 'b');
      await vi.advanceTimersByTimeAsync(3_000);
      // mock driver 不产出最终文本，轮次状态不在这里关心；关键是重连没有把 active writer 直接抛给用户。
      await expect(sending).resolves.toBeTruthy();
      expect(h.driver.send).toHaveBeenCalledWith('b');
      expect(h.driver.start).toHaveBeenCalledTimes(4);
      h.repos.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('非导入会话、历史分叉都拒绝且不写入任何轮次', async () => {
    const h = harness();
    await h.runtime.initialize([agent]);
    const plain = await h.runtime.start({ agentId: 'mock' });
    await expect(h.runtime.syncImportedSession(plain.id, async () => ({ replayed: true, turns: [] }))).rejects.toMatchObject({ code: 'NOT_IMPORTED_SESSION' });
    const imported = await h.runtime.start({ agentId: 'mock', resumeSessionId: 'ext-2', source: 'import', sourceId: 'ext-2', importTurns: [turn('a')] });
    await expect(h.runtime.syncImportedSession(imported.id, async () => ({ replayed: true, turns: [turn('other'), turn('b')] }))).rejects.toMatchObject({ code: 'IMPORT_DIVERGED' });
    expect(await h.runtime.getTasks(imported.id)).toHaveLength(1);
    h.repos.close();
  });
});

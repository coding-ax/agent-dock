import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { Session, StartSessionInput, TaskRecord } from '@agent-dock/agent-dock-shared';
import { followingRun, initialNextRun, nextCronRun } from './rules.js';
import { ScheduleService, type ScheduleRuntime } from './service.js';

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id, agentId: 'claude', state: 'idle', cwd: '/work', model: 'opus', runId: 'run', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra
} as Session);

class FakeRuntime implements ScheduleRuntime {
  sessions = new Map<string, Session>();
  tasks = new Map<string, TaskRecord[]>();
  started: StartSessionInput[] = [];
  dispatched: Array<{ sessionId: string; prompt: string }> = [];
  archived: string[] = [];
  private seq = 0;
  async getSession(id: string) { return this.sessions.get(id); }
  async getTasks(id: string) { return this.tasks.get(id) ?? []; }
  async start(input: StartSessionInput) {
    const created = session(`ses_new_${++this.seq}`, { agentId: input.agentId, cwd: input.cwd!, source: input.source, sourceId: input.sourceId });
    this.sessions.set(created.id, created); this.started.push(input);
    return created;
  }
  async dispatch(id: string, prompt: string) {
    const task = { id: `task_${++this.seq}`, sessionId: id, prompt, status: 'queued', createdAt: '', updatedAt: '' };
    this.tasks.set(id, [...(this.tasks.get(id) ?? []), task]); this.dispatched.push({ sessionId: id, prompt });
    return task;
  }
  async archive(id: string) { const s = this.sessions.get(id)!; s.archivedAt = 'archived'; this.archived.push(id); return s; }
  finishAll() { for (const list of this.tasks.values()) for (const task of list) task.status = 'completed'; }
}

function setup(start = '2026-10-14T00:00:00.000Z') {
  const repos = createRepositories(':memory:');
  const runtime = new FakeRuntime();
  let clock = new Date(start);
  const service = new ScheduleService(repos.schedules, repos.sessions, runtime, { clock: () => clock, keepSessions: 2 });
  const source = session('ses_src');
  runtime.sessions.set(source.id, source);
  void repos.sessions.save(source);
  return { repos, runtime, service, source, setClock: (iso: string) => { clock = new Date(iso); } };
}

describe('schedules table migration', () => {
  it('relaxes the session_id NOT NULL constraint from earlier beta builds without losing rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-sched-'));
    const file = join(dir, 'old.db');
    const old = new Database(file);
    old.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT NOT NULL, delivery TEXT NOT NULL, session_template TEXT, cron TEXT, run_at TEXT, timezone TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT, last_status TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_by_session_id TEXT, extra TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    old.exec("INSERT INTO schedules VALUES ('sch_old', 'n', 'ses_1', 'append', NULL, '0 9 * * *', NULL, 'UTC', 'p', 1, '2026-10-15T09:00:00.000Z', NULL, NULL, 0, NULL, NULL, 't', 't')");
    old.close();
    const repos = createRepositories(file);
    try {
      expect(await repos.schedules.get('sch_old')).toMatchObject({ sessionId: 'ses_1', enabled: true });
      await repos.schedules.save({ ...(await repos.schedules.get('sch_old'))!, id: 'sch_new', sessionId: null });
      expect((await repos.schedules.get('sch_new'))?.sessionId).toBeNull();
      expect(await repos.schedules.listDue('2026-10-16T00:00:00.000Z')).toHaveLength(2);
    } finally { repos.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('schedule rules', () => {
  it('computes the next cron run in the schedule timezone', () => {
    // 周五 11:00（上海）之后的下一个工作日 9:00 是下周一。
    expect(nextCronRun('0 9 * * 1-5', 'Asia/Shanghai', new Date('2026-10-16T03:00:00Z'))?.toISOString()).toBe('2026-10-19T01:00:00.000Z');
  });

  it('rejects invalid cron, past one-shot times and ambiguous input', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    expect(() => initialNextRun({ cron: 'not a cron', runAt: null, timezone: 'UTC' }, now)).toThrow(/cron/);
    expect(() => initialNextRun({ cron: null, runAt: '2026-10-13T00:00:00Z', timezone: 'UTC' }, now)).toThrow(/过去/);
    expect(() => initialNextRun({ cron: '* * * * *', runAt: '2026-10-15T00:00:00Z', timezone: 'UTC' }, now)).toThrow(/三选一/);
    expect(() => initialNextRun({ cron: null, runAt: null, intervalMinutes: 0.5, timezone: 'UTC' }, now)).toThrow(/间隔/);
    expect(() => initialNextRun({ cron: null, runAt: null, timezone: 'UTC' }, now)).toThrow();
  });

  it('catches up only once after downtime instead of replaying every missed run', () => {
    // 每小时一次，停机 5 小时：下一次从现在往后算，而不是从错过的 01:00 往后。
    expect(followingRun({ cron: '0 * * * *', timezone: 'UTC' }, new Date('2026-10-14T01:00:00Z'), new Date('2026-10-14T05:30:00Z'))).toBe('2026-10-14T06:00:00.000Z');
    expect(followingRun({ cron: null, timezone: 'UTC' }, new Date('2026-10-14T01:00:00Z'), new Date('2026-10-14T05:30:00Z'))).toBeNull();
  });
});

describe('fixed-interval schedules', () => {
  it('allows intervals that do not divide 60 and keeps the planned phase', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    expect(initialNextRun({ cron: null, runAt: null, intervalMinutes: 7, timezone: 'UTC' }, now)).toBe('2026-10-14T00:07:00.000Z');
    // 按时触发：从计划时刻往后加一个间隔，不随扫描延迟漂移。
    expect(followingRun({ cron: null, intervalMinutes: 7, timezone: 'UTC' }, new Date('2026-10-14T00:07:00Z'), new Date('2026-10-14T00:07:10Z'))).toBe('2026-10-14T00:14:00.000Z');
    // 停机 1 小时：只补这一次，下一次是 now 之后的第一个点，相位不变。
    expect(followingRun({ cron: null, intervalMinutes: 90, timezone: 'UTC' }, new Date('2026-10-14T00:00:00Z'), new Date('2026-10-14T04:00:00Z'))).toBe('2026-10-14T04:30:00.000Z');
  });
});

describe('ScheduleService', () => {
  it('lists recent runs across schedules, newest first, optionally limited to one session', async () => {
    const { service, setClock } = setup();
    const bound = await service.create({ sessionId: 'ses_src', intervalMinutes: 10, prompt: 'A' });
    const standalone = await service.create({ template: { agentId: 'claude', cwd: '/work' }, intervalMinutes: 15, prompt: 'B' });
    setClock('2026-10-14T00:10:01.000Z'); await service.tick();
    setClock('2026-10-14T00:15:01.000Z'); await service.tick();
    expect((await service.recentRuns()).map(run => run.scheduleId)).toEqual([standalone.id, bound.id]);
    expect((await service.recentRuns(50, 'ses_src')).map(run => run.scheduleId)).toEqual([bound.id]);
    expect(await service.recentRuns(50, 'ses_none')).toEqual([]);
  });

  it('keeps a fixed-interval schedule running and resumable', async () => {
    const { service, setClock, repos } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', intervalMinutes: 45, prompt: '巡检' });
    expect(schedule.nextRunAt).toBe('2026-10-14T00:45:00.000Z');
    setClock('2026-10-14T00:45:03.000Z');
    await service.tick();
    expect(await repos.schedules.get(schedule.id)).toMatchObject({ enabled: true, runCount: 1, nextRunAt: '2026-10-14T01:30:00.000Z', intervalMinutes: 45 });
    await service.pause(schedule.id);
    expect((await service.resume(schedule.id)).enabled).toBe(true);
  });

  it('defaults to a new side session per run, seeded with the source session config', async () => {
    const { service, runtime, setClock, repos } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', cron: '0 9 * * *', timezone: 'UTC', prompt: '汇总群消息' });
    expect(schedule.delivery).toBe('new_session');
    expect(schedule.nextRunAt).toBe('2026-10-14T09:00:00.000Z');
    setClock('2026-10-14T09:00:05.000Z');
    await service.tick();
    expect(runtime.started).toMatchObject([{ agentId: 'claude', cwd: '/work', model: 'opus', source: 'side-chat', sourceId: 'ses_src' }]);
    expect(runtime.dispatched[0]!.prompt).toMatch(/^\[AgentDock 定时任务 sch_.* · 第 1 次触发\]\n汇总群消息$/);
    const [run] = await repos.schedules.listRuns(schedule.id);
    expect(run).toMatchObject({ status: 'delivered', sessionId: 'ses_new_1', fireAt: '2026-10-14T09:00:00.000Z' });
    expect(await repos.schedules.get(schedule.id)).toMatchObject({ runCount: 1, lastStatus: 'delivered', nextRunAt: '2026-10-15T09:00:00.000Z' });
  });

  it('appends to the bound session when asked, and skips while that session is busy', async () => {
    const { service, runtime, setClock, repos, source } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', delivery: 'append', cron: '0 * * * *', timezone: 'UTC', prompt: '看一下进展' });
    source.state = 'thinking';
    setClock('2026-10-14T01:00:00.000Z');
    await service.tick();
    expect(runtime.dispatched).toEqual([]);
    expect((await repos.schedules.listRuns(schedule.id))[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('正忙') });
    source.state = 'idle';
    setClock('2026-10-14T02:00:00.000Z');
    await service.tick();
    expect(runtime.dispatched).toMatchObject([{ sessionId: 'ses_src' }]);
    expect(runtime.started).toEqual([]);
  });

  it('fires each due run exactly once even when two scanners race', async () => {
    const { service, runtime, setClock, repos } = setup();
    await service.create({ sessionId: 'ses_src', cron: '0 * * * *', timezone: 'UTC', prompt: 'p' });
    // 第二个服务实例模拟另一个进程连同一个库。
    const other = new ScheduleService(repos.schedules, repos.sessions, runtime, { clock: () => new Date('2026-10-14T01:00:01.000Z') });
    setClock('2026-10-14T01:00:01.000Z');
    await Promise.all([service.tick(), other.tick(), service.tick()]);
    expect(runtime.dispatched).toHaveLength(1);
  });

  it('skips a run while the previous run is still queued or running', async () => {
    const { service, runtime, setClock, repos } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', cron: '0 * * * *', timezone: 'UTC', prompt: 'p' });
    setClock('2026-10-14T01:00:00.000Z'); await service.tick();
    setClock('2026-10-14T02:00:00.000Z'); await service.tick();
    expect(runtime.started).toHaveLength(1);
    expect((await repos.schedules.listRuns(schedule.id))[0]).toMatchObject({ status: 'skipped', reason: expect.stringContaining('queued') });
    runtime.finishAll();
    setClock('2026-10-14T03:00:00.000Z'); await service.tick();
    expect(runtime.started).toHaveLength(2);
  });

  it('runs a one-shot schedule once and then marks it finished', async () => {
    const { service, runtime, setClock, repos } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', runAt: '2026-10-14T18:00:00.000Z', prompt: '提醒我看发布' });
    setClock('2026-10-14T18:00:30.000Z'); await service.tick();
    setClock('2026-10-14T19:00:00.000Z'); await service.tick();
    expect(runtime.dispatched).toHaveLength(1);
    expect(await repos.schedules.get(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null, runCount: 1 });
    await expect(service.resume(schedule.id)).rejects.toThrow(/单次任务/);
  });

  it('pauses and resumes from the next future slot', async () => {
    const { service, runtime, setClock } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', cron: '0 * * * *', timezone: 'UTC', prompt: 'p' });
    await service.pause(schedule.id);
    setClock('2026-10-14T05:30:00.000Z'); await service.tick();
    expect(runtime.dispatched).toEqual([]);
    expect((await service.resume(schedule.id)).nextRunAt).toBe('2026-10-14T06:00:00.000Z');
  });

  it('disables itself when the source session is archived', async () => {
    const { service, runtime, setClock, repos, source } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', cron: '0 * * * *', timezone: 'UTC', prompt: 'p' });
    source.archivedAt = 'gone';
    setClock('2026-10-14T01:00:00.000Z'); await service.tick();
    expect(runtime.dispatched).toEqual([]);
    expect(await repos.schedules.get(schedule.id)).toMatchObject({ enabled: false, nextRunAt: null, lastStatus: 'failed' });
  });

  it('archives sessions beyond the keep limit for new_session schedules', async () => {
    const { service, runtime, setClock } = setup();
    await service.create({ sessionId: 'ses_src', cron: '0 * * * *', timezone: 'UTC', prompt: 'p' });
    for (const hour of ['01', '02', '03', '04']) {
      setClock(`2026-10-14T${hour}:00:00.000Z`); await service.tick(); runtime.finishAll();
    }
    expect(runtime.started).toHaveLength(4);
    expect(runtime.archived).toEqual(['ses_new_1', 'ses_new_3']);
  });

  it('creates a standalone new-session schedule from an explicit agent/cwd template', async () => {
    const { service, runtime, setClock, repos } = setup();
    const schedule = await service.create({ template: { agentId: 'codex', cwd: '/repo', model: 'gpt-5' }, cron: '0 9 * * *', timezone: 'UTC', prompt: '巡检' });
    expect(schedule.sessionId).toBeNull();
    setClock('2026-10-14T09:00:00.000Z'); await service.tick();
    expect(runtime.started).toEqual([expect.objectContaining({ agentId: 'codex', cwd: '/repo', model: 'gpt-5' })]);
    // 独立会话：不挂在任何会话下面，种子里也不提来源会话。
    expect(runtime.started[0]).not.toHaveProperty('sourceId');
    expect(runtime.started[0]!.systemPrompt).not.toContain('来源会话');
    expect((await repos.schedules.listRuns(schedule.id))[0]).toMatchObject({ status: 'delivered' });
  });

  it('requires a session for append and a full template for unbound new-session schedules', async () => {
    const { service } = setup();
    await expect(service.create({ delivery: 'append', cron: '0 9 * * *', prompt: 'p' })).rejects.toThrow(/必须指定会话/);
    await expect(service.create({ cron: '0 9 * * *', prompt: 'p' })).rejects.toThrow(/Agent 和工作目录/);
    await expect(service.create({ template: { agentId: 'codex', cwd: ' ' }, cron: '0 9 * * *', prompt: 'p' })).rejects.toThrow(/同时指定/);
  });

  it('runs once on demand without moving the planned next run', async () => {
    const { service, runtime, repos } = setup();
    const schedule = await service.create({ sessionId: 'ses_src', cron: '0 9 * * *', timezone: 'UTC', prompt: 'p' });
    const run = await service.runNow(schedule.id);
    expect(run.status).toBe('delivered');
    expect(runtime.dispatched).toHaveLength(1);
    expect(await repos.schedules.get(schedule.id)).toMatchObject({ nextRunAt: '2026-10-14T09:00:00.000Z', enabled: true });
  });
});

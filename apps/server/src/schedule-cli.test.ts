import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { Session, StartSessionInput, TaskRecord } from '@agent-dock/agent-dock-shared';
import { registerScheduleRoutes } from './schedules/routes.js';
import { ScheduleService, type ScheduleRuntime } from './schedules/service.js';
import { runScheduleAdd, runScheduleList, runScheduleShow, runScheduleUpdate } from './schedule-cli.js';

const makeSession = (id: string, extra: Partial<Session> = {}): Session => ({
  id, agentId: 'claude', state: 'idle', cwd: '/work', model: 'opus', runId: 'run',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra
} as Session);

class FakeRuntime implements ScheduleRuntime {
  sessions = new Map<string, Session>();
  tasks = new Map<string, TaskRecord[]>();
  async getSession(id: string) { return this.sessions.get(id); }
  async getTasks(id: string) { return this.tasks.get(id) ?? []; }
  async start(input: StartSessionInput) {
    const s = makeSession('ses_new', { agentId: input.agentId, cwd: input.cwd! });
    this.sessions.set(s.id, s);
    return s;
  }
  async dispatch(id: string, prompt: string) {
    const task = { id: 'task_1', sessionId: id, prompt, status: 'queued', createdAt: '', updatedAt: '' };
    this.tasks.set(id, [...(this.tasks.get(id) ?? []), task]);
    return task;
  }
  async archive(id: string) { return this.sessions.get(id); }
}

async function startFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ad-sched-cli-'));
  const dbPath = join(dir, 'agentdock.db');
  const repos = createRepositories(dbPath);
  const runtime = new FakeRuntime();
  const main = makeSession('ses_main_1');
  const other = makeSession('ses_other_1');
  runtime.sessions.set(main.id, main);
  runtime.sessions.set(other.id, other);
  await repos.sessions.save(main);
  await repos.sessions.save(other);
  await repos.config.set('assistant.main', main.id);

  const service = new ScheduleService(repos.schedules, repos.sessions, runtime, {
    resolveMainSessionId: () => main.id
  });
  const app = Fastify();
  registerScheduleRoutes(app, service);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  writeFileSync(join(dir, 'agentdock.pid'), `${process.pid}\n`);
  writeFileSync(join(dir, 'agentdock.state.json'), JSON.stringify({
    pid: process.pid, ready: true, address, database: dbPath
  }));

  return {
    daemonDir: dir,
    main,
    other,
    async close() {
      await app.close();
      repos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('schedule CLI (--main / --session main / update)', () => {
  it('supports adding, listing, showing, and updating schedules that dynamically follow the active main session', async () => {
    const fixture = await startFixture();
    try {
      const added = await runScheduleAdd('每日主会话汇报', {
        cron: '0 9 * * *',
        delivery: 'append',
        main: true,
        from: fixture.main.id,
        name: '主会话早报',
        daemonDir: fixture.daemonDir
      });
      expect(added).toContain('跟随当前主会话（换代自动跟随）');
      const idMatch = added.match(/sch_[a-zA-Z0-9_-]+/);
      expect(idMatch).toBeTruthy();
      const scheduleId = idMatch![0]!;

      const listed = await runScheduleList({ main: true, daemonDir: fixture.daemonDir });
      expect(listed).toContain(scheduleId);
      expect(listed).toContain('跟随当前主会话（换代自动跟随）');

      const shown = await runScheduleShow(scheduleId, { daemonDir: fixture.daemonDir });
      expect(shown).toContain('主会话早报');
      expect(shown).toContain('跟随当前主会话（换代自动跟随）');

      // 切到固定会话再切回 --session main
      const toFixed = await runScheduleUpdate(scheduleId, {
        session: fixture.other.id,
        from: fixture.other.id,
        every: '30m',
        daemonDir: fixture.daemonDir
      });
      expect(toFixed).toContain(`会话 ${fixture.other.id}`);
      expect(toFixed).toContain('每 30 分钟');

      const backToMain = await runScheduleUpdate(scheduleId, {
        session: 'main',
        from: fixture.main.id,
        name: '主会话巡检',
        daemonDir: fixture.daemonDir
      });
      expect(backToMain).toContain('主会话巡检');
      expect(backToMain).toContain('跟随当前主会话（换代自动跟随）');
    } finally {
      await fixture.close();
    }
  });

  it('rejects conflicting --main and --session options', async () => {
    const fixture = await startFixture();
    try {
      await expect(runScheduleAdd('冲突测试', {
        every: '1h',
        delivery: 'append',
        main: true,
        session: fixture.other.id,
        daemonDir: fixture.daemonDir
      })).rejects.toThrow(/不能与 --session 同时指定/);
    } finally {
      await fixture.close();
    }
  });
});

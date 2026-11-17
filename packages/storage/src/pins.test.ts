import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

const dirs: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-pins-'));
  dirs.push(dir);
  return join(dir, 'agentdock.db');
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const session = {
  id: 'ses_pin',
  agentId: 'codex',
  state: 'idle',
  cwd: '/tmp/project',
  runId: 'run_1',
  createdAt: '2026-11-17T01:00:00.000Z',
  updatedAt: '2026-11-17T01:00:00.000Z'
} as const;

describe('会话置顶持久化', () => {
  it('写库后重开数据库仍在', async () => {
    const file = tempDb();
    const first = createRepositories(file);
    await first.sessions.save(session);
    await first.sessions.savePinned(session.id, '2026-11-17T02:00:00.000Z');
    first.close();

    const second = createRepositories(file);
    expect((await second.sessions.get(session.id))?.pinnedAt).toBe('2026-11-17T02:00:00.000Z');
    second.close();
  });

  it('整行 save 不会用过期快照清掉置顶', async () => {
    const repos = createRepositories(':memory:');
    await repos.sessions.save(session);
    await repos.sessions.savePinned(session.id, '2026-11-17T02:00:00.000Z');
    // 模拟运行中的会话：手里是置顶之前的旧快照，收尾时整行 save。
    await repos.sessions.save({ ...session, state: 'idle', updatedAt: '2026-11-17T03:00:00.000Z' });
    expect((await repos.sessions.get(session.id))?.pinnedAt).toBe('2026-11-17T02:00:00.000Z');
    repos.close();
  });
});

describe('项目登记与置顶', () => {
  it('同路径 ensure 只保留一条，且不会清掉置顶和名字', async () => {
    const repos = createRepositories(':memory:');
    const created = await repos.projects.ensure('/tmp/demo');
    await repos.projects.setPinned(created.id, '2026-11-17T02:00:00.000Z');
    const again = await repos.projects.ensure('/tmp/demo');
    expect(again.id).toBe(created.id);
    expect(await repos.projects.list()).toHaveLength(1);
    expect(again.pinnedAt).toBe('2026-11-17T02:00:00.000Z');
    expect(again.name).toBe('demo');
    repos.close();
  });

  it('项目置顶写库后重开数据库仍在', async () => {
    const file = tempDb();
    const first = createRepositories(file);
    const project = await first.projects.ensure('/tmp/persist');
    await first.projects.setPinned(project.id, '2026-11-17T02:00:00.000Z');
    first.close();

    const second = createRepositories(file);
    expect((await second.projects.getByCwd('/tmp/persist'))?.pinnedAt).toBe('2026-11-17T02:00:00.000Z');
    second.close();
  });
});

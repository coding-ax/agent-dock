import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { acquireDatabaseServerLock } from './db-lock.js';
import { writeState } from './daemon.js';
import { startLocalServer } from '../service.js';

const directories: string[] = [];

function tempDir(prefix = 'agentdock-dblock-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('database server ownership lock', () => {
  it('blocks a second live owner and reclaims stale locks from dead processes', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agentdock.db');

    const lock = acquireDatabaseServerLock(dbPath, { pid: 10001, isAlive: pid => pid === 10001, daemonDirs: [] });
    expect(() => acquireDatabaseServerLock(dbPath, { pid: 10002, isAlive: pid => pid === 10001, daemonDirs: [] }))
      .toThrow(/pid 10001/);

    // 模拟持有者崩溃后残留的锁文件：isAlive 返回 false 时应自动回收。
    lock.release();
    writeFileSync(`${dbPath}.server.lock`, JSON.stringify({ pid: 99999, database: dbPath }));
    const reclaimed = acquireDatabaseServerLock(dbPath, { pid: 10003, isAlive: () => false, daemonDirs: [] });
    reclaimed.release();
  });

  it('cross-checks sibling daemon state.json to protect older running daemons without lock files', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agentdock.db');
    const daemonDir = join(dir, 'daemon');
    writeState(daemonDir, {
      pid: 20001,
      ready: true,
      startedAt: new Date().toISOString(),
      cwd: dir,
      database: dbPath
    });

    expect(() => acquireDatabaseServerLock(dbPath, { pid: 20002, isAlive: pid => pid === 20001, daemonDirs: [daemonDir] }))
      .toThrow(/pid 20001/);
  });

  it('prevents a duplicate startLocalServer from running runtime.initialize() on a live DB', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agentdock.db');
    const ts = new Date().toISOString();

    // 模拟在线 daemon 已有一条正在运行的任务与会话。
    const repos = createRepositories(dbPath);
    await repos.sessions.save({
      id: 'ses_live', agentId: 'claude', state: 'thinking', cwd: dir,
      permissionMode: 'full-trust', protocol: 'acp', runId: 'run_live',
      createdAt: ts, updatedAt: ts
    });
    await repos.tasks.save({
      id: 'task_live', sessionId: 'ses_live', prompt: 'running work',
      status: 'running', createdAt: ts, updatedAt: ts
    });
    repos.close();

    // 模拟在线 daemon 正在持有该数据库的锁。
    const liveLock = acquireDatabaseServerLock(dbPath, { pid: process.pid, daemonDirs: [] });
    try {
      await expect(startLocalServer({
        env: {
          ...process.env,
          HOME: dir,
          AGENTDOCK_HOST: '127.0.0.1',
          AGENTDOCK_PORT: '4398',
          AGENTDOCK_DATABASE_URL: dbPath,
          AGENTDOCK_DEFAULT_CWD: dir,
          AGENTDOCK_DISABLE_LARK_LISTENER: 'true',
          AGENTDOCK_WEB_AUTH: 'off'
        }
      })).rejects.toThrow(/重复启动服务/);

      // 关键断言：被拦截的重复实例绝对不能把在线 running 任务误改成 interrupted！
      const verify = createRepositories(dbPath);
      try {
        expect((await verify.sessions.get('ses_live'))?.state).toBe('thinking');
        expect((await verify.tasks.listBySession('ses_live'))[0]?.status).toBe('running');
        expect(await verify.events.list('ses_live')).toHaveLength(0);
      } finally {
        verify.close();
      }
    } finally {
      liveLock.release();
    }
  });
});

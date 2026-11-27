import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Session } from '@agent-dock/agent-dock-shared';
import { createRepositories } from './index.js';

const session = (over: Partial<Session> = {}): Session => ({
  id: 'ses_1', agentId: 'codex', state: 'idle', cwd: '/tmp', runId: 'run_1',
  createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', ...over
});

describe('session last_message_at', () => {
  it('落盘并读回最后一次对话时间；从未对话过就是 null', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.sessions.save(session());
      expect((await repos.sessions.get('ses_1'))?.lastMessageAt ?? null).toBeNull();
      await repos.sessions.save(session({ lastMessageAt: '2026-09-23T10:00:00.000Z' }));
      expect((await repos.sessions.get('ses_1'))?.lastMessageAt).toBe('2026-09-23T10:00:00.000Z');
    } finally { repos.close(); }
  });

  it('旧库缺列时自动补列，历史行保持 null 且能写入新值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-migrate-'));
    const file = join(dir, 'agentdock.db');
    const legacy = new Database(file);
    // 老 schema：除 last_message_at 外与当前一致，模拟升级前的库。
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, state TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT, reasoning_effort TEXT, system_prompt TEXT, permission_mode TEXT DEFAULT 'full-trust', source TEXT, source_id TEXT, archived_at TEXT, protocol TEXT, run_id TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO sessions (id, agent_id, state, cwd, run_id, created_at, updated_at) VALUES ('legacy', 'codex', 'idle', '/tmp', 'run', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
    `);
    legacy.close();
    const repos = createRepositories(file);
    try {
      expect((await repos.sessions.get('legacy'))?.lastMessageAt ?? null).toBeNull();
      expect((await repos.sessions.get('legacy'))?.interruptIntent ?? null).toBeNull();
      await repos.sessions.save(session({ id: 'legacy', lastMessageAt: '2026-09-23T11:00:00.000Z', interruptIntent: 'daemon_restart' }));
      expect(await repos.sessions.get('legacy')).toMatchObject({
        lastMessageAt: '2026-09-23T11:00:00.000Z',
        interruptIntent: 'daemon_restart'
      });
    } finally { repos.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('save 显式清空 error 与 interruptIntent（不再被 drizzle undefined 跳过）', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.sessions.save(session({
        state: 'interrupted',
        error: 'AgentDock 守护进程重启，正在进行的任务已中断',
        interruptIntent: 'daemon_restart'
      }));
      expect(await repos.sessions.get('ses_1')).toMatchObject({
        state: 'interrupted',
        error: 'AgentDock 守护进程重启，正在进行的任务已中断',
        interruptIntent: 'daemon_restart'
      });

      await repos.sessions.save(session({ state: 'completed', error: undefined, interruptIntent: undefined }));
      const recovered = await repos.sessions.get('ses_1');
      expect(recovered?.state).toBe('completed');
      expect(recovered?.error ?? null).toBeNull();
      expect(recovered?.interruptIntent ?? null).toBeNull();
    } finally { repos.close(); }
  });
});

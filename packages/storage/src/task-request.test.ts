import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

describe('task request storage', () => {
  it('migrates an existing database and persists the actual Agent request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentdock-task-request-'));
    try {
      const filename = join(directory, 'agentdock.db');
      const old = new Database(filename);
      old.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
      old.close();
      const repos = createRepositories(filename);
      try {
        const task = { id: 'task_1', sessionId: 'ses_1', prompt: '用户原文', sentPrompt: '[预注入]\n用户原文', finalText: '本轮最终输出', status: 'completed', createdAt: '', updatedAt: '' };
        await repos.tasks.save(task);
        // 老库里既没有 sent_prompt 也没有 final_text，两个 ALTER TABLE 都得在这条路径上生效
        // （轨迹面板不开这一列就要为每轮扫事件）。
        expect((await repos.tasks.listBySession('ses_1'))[0]).toMatchObject(task);
      } finally {
        repos.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

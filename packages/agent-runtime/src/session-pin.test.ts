import { describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { AgentDockRuntime } from './index.js';

describe('会话置顶边界', () => {
  it('归档时自动取消置顶，归档后不允许再置顶', async () => {
    const repos = createRepositories(':memory:');
    const runtime = new AgentDockRuntime(repos, { cleanupIntervalMs: 0 });
    const time = '2026-11-17T01:00:00.000Z';
    await repos.sessions.save({ id: 'ses_archive', agentId: 'mock', state: 'idle', cwd: '/tmp', runId: 'run_1', createdAt: time, updatedAt: time });

    await runtime.setSessionPinned('ses_archive', true);
    await runtime.archive('ses_archive');
    expect((await runtime.getSession('ses_archive'))?.pinnedAt ?? null).toBeNull();
    await expect(runtime.setSessionPinned('ses_archive', true)).rejects.toMatchObject({ code: 'SESSION_ARCHIVED', statusCode: 409 });
    repos.close();
  });
});

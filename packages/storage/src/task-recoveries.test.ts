import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryBundle, TaskRecoveryRecord } from '@agent-dock/agent-dock-shared';
import { createRepositories } from './index.js';

const bundles: RepositoryBundle[] = [];

function createBundle(): RepositoryBundle {
  const repos = createRepositories(':memory:');
  bundles.push(repos);
  return repos;
}

afterEach(() => {
  while (bundles.length) bundles.pop()?.close();
});

function makeRecord(overrides: Partial<TaskRecoveryRecord> = {}): TaskRecoveryRecord {
  const stamp = '2026-11-28T07:00:00.000Z';
  return {
    id: 'rec_1',
    sessionId: 'ses_1',
    interruptedTaskId: 'task_1',
    rootTaskId: 'task_1',
    originalPrompt: '修复并测试',
    originalOrigin: null,
    interruptReason: 'daemon_restart',
    interruptedAt: '2026-11-28T06:58:00.000Z',
    detectedAt: stamp,
    mode: 'confirm',
    status: 'pending_confirm',
    skipReason: null,
    attemptCount: 0,
    recoveryTaskId: null,
    decidedSource: null,
    decidedBy: null,
    decidedAt: null,
    larkAppId: null,
    larkChatId: null,
    larkMessageId: null,
    larkCardId: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides
  };
}

describe('taskRecoveries repository', () => {
  it('enforces uniqueness on interruptedTaskId via insertIfAbsent and supports lookups', async () => {
    const repos = createBundle();
    const rec = makeRecord();
    expect(await repos.taskRecoveries.insertIfAbsent(rec)).toBe(true);
    expect(await repos.taskRecoveries.insertIfAbsent({ ...rec, id: 'rec_dup' })).toBe(false);

    expect(await repos.taskRecoveries.getByInterruptedTaskId('task_1')).toMatchObject({ id: 'rec_1', status: 'pending_confirm' });
    expect(await repos.taskRecoveries.listBySession('ses_1')).toHaveLength(1);
  });

  it('performs atomic claimTransition so concurrent callers cannot both win', async () => {
    const repos = createBundle();
    await repos.taskRecoveries.insertIfAbsent(makeRecord({ larkCardId: 'recc_abc' }));

    const first = await repos.taskRecoveries.claimTransition('rec_1', ['pending_confirm'], {
      status: 'resumed',
      attemptCount: 1,
      decidedSource: 'web',
      decidedAt: '2026-11-28T07:01:00.000Z',
      recoveryTaskId: 'task_rec_1'
    });
    expect(first).toMatchObject({ status: 'resumed', attemptCount: 1, decidedSource: 'web', recoveryTaskId: 'task_rec_1' });

    const second = await repos.taskRecoveries.claimTransition('rec_1', ['pending_confirm'], {
      status: 'dismissed',
      decidedSource: 'lark',
      decidedAt: '2026-11-28T07:01:01.000Z'
    });
    expect(second).toBeUndefined();

    expect(await repos.taskRecoveries.getByRecoveryTaskId('task_rec_1')).toMatchObject({ id: 'rec_1', rootTaskId: 'task_1' });
    expect(await repos.taskRecoveries.getByLarkCardId('recc_abc')).toMatchObject({ id: 'rec_1', status: 'resumed' });
  });
});

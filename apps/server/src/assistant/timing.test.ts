import { describe, expect, it } from 'vitest';
import { beginTaskRun, finishTaskRun } from './timing.js';

describe('assistant task run timing', () => {
  it('accumulates only active runs and excludes review waiting time', () => {
    const task = { activeMs: 0 } as Parameters<typeof beginTaskRun>[0];
    beginTaskRun(task, '2026-01-01T00:00:00.000Z');
    finishTaskRun(task, '2026-01-01T00:02:00.000Z');
    expect(task.completedAt).toBe('2026-01-01T00:02:00.000Z');

    // 验收等了一天再返工：等待不计入 activeMs。
    beginTaskRun(task, '2026-01-02T00:00:00.000Z');
    finishTaskRun(task, '2026-01-02T00:01:00.000Z');
    expect(task.activeMs).toBe(180_000);
    expect(task.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clamps negative spans instead of producing negative elapsed time', () => {
    const task = { activeMs: 0 } as Parameters<typeof beginTaskRun>[0];
    beginTaskRun(task, '2026-01-02T00:00:00.000Z');
    finishTaskRun(task, '2026-01-01T00:00:00.000Z');
    expect(task.activeMs).toBe(0);
  });

  it('does not overwrite completion time when closing a reviewed task', () => {
    const task = { activeMs: 60_000, completedAt: '2026-01-01T00:01:00.000Z' } as Parameters<typeof beginTaskRun>[0];
    finishTaskRun(task, '2026-01-03T00:00:00.000Z');
    expect(task.completedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(task.activeMs).toBe(60_000);
  });
});

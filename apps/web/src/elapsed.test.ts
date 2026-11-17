import { describe, expect, it } from 'vitest';
import { elapsedText, formatElapsed, resolveElapsed } from './elapsed';

const at = (iso: string) => Date.parse(iso);

describe('task elapsed time', () => {
  it('ticks while running and stops at the completed timestamp', () => {
    const task = {
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
      runStartedAt: '2026-01-01T00:00:00.000Z',
      activeMs: 0
    };
    expect(elapsedText(resolveElapsed(task, at('2026-01-01T00:03:12.000Z')))).toBe('已用时 3 分 12 秒');
    expect(elapsedText(resolveElapsed(task, at('2026-01-01T00:03:13.000Z')))).toBe('已用时 3 分 13 秒');

    const done = resolveElapsed({ ...task, state: 'review', completedAt: '2026-01-01T00:08:00.000Z', runStartedAt: undefined, activeMs: 480_000 }, at('2026-01-01T02:00:00.000Z'));
    expect(done.ms).toBe(480_000);
    expect(elapsedText(done)).toBe('用时 8 分钟');
  });

  it('uses accumulated active time so review waiting is not counted', () => {
    const task = {
      state: 'review',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
      // 第一轮 2 分钟；一天后返工又跑了 1 分钟。
      activeMs: 180_000
    };
    expect(elapsedText(resolveElapsed(task, at('2026-01-05T00:00:00.000Z')))).toBe('用时 3 分钟');
  });

  it('shows queue waiting time for a planned task and while queued', () => {
    const plan = {
      state: 'review',
      plan: true,
      createdAt: '2026-01-01T00:00:00.000Z'
    };
    expect(elapsedText(resolveElapsed(plan, at('2026-01-01T00:01:05.000Z')))).toBe('排队 1 分 5 秒');
    expect(elapsedText(resolveElapsed({ state: 'queued', createdAt: '2026-01-01T00:00:00.000Z' }, at('2026-01-01T00:02:00.000Z')))).toBe('排队 2 分钟');
  });

  it('falls back to createdAt and marks the value approximate for old records', () => {
    const task = {
      state: 'closed',
      createdAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-01T00:09:00.000Z'
    };
    const elapsed = resolveElapsed(task, at('2026-01-02T00:00:00.000Z'));
    expect(elapsed.approximate).toBe(true);
    expect(elapsed.ms).toBe(540_000);
    expect(elapsedText(elapsed)).toBe('用时约 9 分钟');
  });

  it('never renders negative time when the browser clock is behind the server', () => {
    const elapsed = resolveElapsed({
      state: 'running',
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:00.000Z',
      runStartedAt: '2026-01-02T00:00:00.000Z',
      activeMs: 0
    }, at('2026-01-01T00:00:00.000Z'));
    expect(elapsed.ms).toBe(0);
    expect(elapsedText(elapsed)).toContain('不足 1 秒');
    expect(elapsedText(elapsed)).not.toContain('-');
  });

  it('formats long running tasks with hours and days', () => {
    expect(formatElapsed(80 * 60_000)).toBe('1 小时 20 分');
    expect(formatElapsed(51 * 3_600_000)).toBe('2 天 3 小时');
  });
});

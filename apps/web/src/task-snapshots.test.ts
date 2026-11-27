import { describe, expect, it } from 'vitest';
import type { Task } from './api';
import { fetchTaskSnapshot, mergeTaskSnapshots, preferNewerTask, upsertTask } from './task-snapshots';

const task = (id: string, status: string, createdAt = '2026-01-01T00:00:00.000Z', updatedAt = createdAt): Task =>
  ({ id, sessionId: 's1', prompt: id, status, createdAt, updatedAt });

describe('task snapshot reconciliation', () => {
  it('never lets a late tasks poll write a started task back to queued', () => {
    // SSE 已经推来 running；更早发出的轮询这时才返回 queued。
    const queued = task('t1', 'queued', '2026-01-01T00:00:00.000Z');
    const running = task('t1', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z');
    expect(preferNewerTask(running, queued)).toBe(running);
    expect(mergeTaskSnapshots([queued, running].slice(1), [queued])[0]!.status).toBe('running');
  });

  it('never regresses terminal or running states to queued even if timestamps are equal', () => {
    const queued = task('t1', 'queued');
    for (const status of ['running', 'completed', 'failed', 'interrupted', 'cancelled']) {
      expect(preferNewerTask(task('t1', status), queued).status).toBe(status);
    }
  });

  it('still moves forward after a missed SSE task event', () => {
    // 断线漏掉 running：缓存里只有 queued；重连后的轮询带回 running，必须接受。
    const queued = task('t1', 'queued');
    const running = task('t1', 'running', queued.createdAt, '2026-01-01T00:00:05.000Z');
    expect(mergeTaskSnapshots([queued], [running])[0]!.status).toBe('running');
    expect(upsertTask([queued], running)[0]!.status).toBe('running');
  });

  it('re-reads the cache after the poll resolves, so an in-flight poll cannot undo SSE', async () => {
    // 轮询 t0 发出 → t1 SSE running 写入缓存 → t2 轮询响应带回 t0 时刻的 queued。
    const queued = task('t1', 'queued', '2026-01-01T00:00:00.000Z');
    const running = task('t1', 'running', queued.createdAt, '2026-01-01T00:00:02.000Z');
    let cache: Task[] = [queued];
    const result = await fetchTaskSnapshot(() => cache, async () => {
      cache = [running];
      return [queued];
    });
    expect(result[0]!.status).toBe('running');
  });

  it('accepts completion and keeps the list identity when nothing moved backwards', () => {
    const running = task('t1', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:02.000Z');
    const completed = { ...running, status: 'completed', updatedAt: '2026-01-01T00:00:09.000Z' };
    const incoming = [completed];
    expect(mergeTaskSnapshots([running], incoming)).toBe(incoming);
    expect(upsertTask([running], completed)[0]).toBe(completed);
  });

  it('adds a new task and returns the same array when the snapshot is already current', () => {
    const running = task('t1', 'running');
    expect(upsertTask([running], task('t2', 'queued'))).toEqual([running, task('t2', 'queued')]);
    const list = [running];
    expect(upsertTask(list, running)).toBe(list);
  });

  it('keeps two rapid sends ordered by id and only settles the one that started', () => {
    const first = task('t1', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
    const second = task('t2', 'queued', '2026-01-01T00:00:00.500Z');
    const snapshots = mergeTaskSnapshots([first], [first, second]);
    expect(snapshots.map(item => [item.id, item.status])).toEqual([['t1', 'running'], ['t2', 'queued']]);
    // 第一轮完成后第二轮开始：两份快照都必须前进。
    const after = mergeTaskSnapshots(snapshots, [
      { ...first, status: 'completed', updatedAt: '2026-01-01T00:00:09.000Z' },
      { ...second, status: 'running', updatedAt: '2026-01-01T00:00:10.000Z' }
    ]);
    expect(after.map(item => [item.id, item.status])).toEqual([['t1', 'completed'], ['t2', 'running']]);
  });

  it('preserves a newly queued task received via SSE when an older in-flight poll omits it', () => {
    const running = task('t1', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
    const newlyQueued = task('t2', 'queued', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z');
    const merged = mergeTaskSnapshots([running, newlyQueued], [running]);
    expect(merged.map(item => [item.id, item.status])).toEqual([['t1', 'running'], ['t2', 'queued']]);
  });
});

import { describe, expect, it } from 'vitest';
import { mergeEventBatch } from './event-buffer';
import type { DockEvent } from './api';

const event = (sequence: number, data: any = {}, type = 'text'): DockEvent =>
  ({ id: `e${sequence}`, sequence, type, timestamp: '', data });

describe('SSE event batch merge', () => {
  it('takes the whole batch when nothing is cached yet', () => {
    const batch = [event(1), event(2)];
    expect(mergeEventBatch([], batch).map(item => item.sequence)).toEqual([1, 2]);
  });

  it('appends unseen sequences in arrival order', () => {
    const merged = mergeEventBatch([event(1), event(2)], [event(3), event(4)]);
    expect(merged.map(item => item.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('replaces a known sequence in place so tool cards settle without reordering', () => {
    const cached = [event(1, { id: 't1', status: 'running' }, 'tool_call'), event(2, { text: 'after' })];
    const merged = mergeEventBatch(cached, [event(1, { id: 't1', status: 'completed' }, 'tool_result')]);
    expect(merged.map(item => item.sequence)).toEqual([1, 2]);
    expect(merged[0]).toMatchObject({ type: 'tool_result', data: { status: 'completed' } });
    expect(cached[0]).toMatchObject({ type: 'tool_call' });
  });

  it('keeps the last write when one batch carries the same sequence twice', () => {
    const merged = mergeEventBatch([event(1)], [event(2, { text: 'first' }), event(2, { text: 'second' })]);
    expect(merged.map(item => item.sequence)).toEqual([1, 2]);
    expect(merged[1].data.text).toBe('second');
  });

  it('returns the same array reference when the batch adds nothing', () => {
    const cached = [event(1), event(2)];
    expect(mergeEventBatch(cached, [])).toBe(cached);
  });

  it('merges a batch that mixes replacements with new events', () => {
    const cached = [event(1, { text: 'a' }), event(2, { text: 'b' })];
    const merged = mergeEventBatch(cached, [event(2, { text: 'b2' }), event(3, { text: 'c' })]);
    expect(merged.map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(merged[1].data.text).toBe('b2');
    expect(merged[2].data.text).toBe('c');
  });

  it('inserts genuinely out-of-order arrivals at their sequence position', () => {
    // 原始日志靠数组顺序拼接，乱序直接追加会让 raw 面板内容次序错乱。
    expect(mergeEventBatch([event(1), event(3)], [event(2)]).map(item => item.sequence)).toEqual([1, 2, 3]);
    expect(mergeEventBatch([event(1)], [event(5), event(3), event(4)]).map(item => item.sequence)).toEqual([1, 3, 4, 5]);
  });

  it('merges an incremental refetch payload that overlaps the cache', () => {
    const merged = mergeEventBatch([event(1), event(2), event(3, { text: 'old' })], [event(3, { text: 'new' }), event(4)]);
    expect(merged.map(item => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(merged[2].data.text).toBe('new');
  });

  it('keeps events that the SSE stream wrote while a refetch was in flight', () => {
    // queryFn 在 await 后重新读缓存，再把窗口期内新写入的事件补回 fresh 之后。
    const fresh = [event(1), event(2), event(3)];
    const live = [event(1), event(2), event(99, { text: 'mid-flight' })];
    const newest = fresh.reduce((max, item) => Math.max(max, item.sequence), 0);
    const merged = mergeEventBatch(fresh, live.filter(item => item.sequence > newest));
    expect(merged.map(item => item.sequence)).toEqual([1, 2, 3, 99]);
  });

  it('is equivalent to merging the same events one at a time', () => {
    const base = [event(1)];
    const script = [event(2), event(3), event(2, { text: 'updated' }), event(4)];
    const batched = mergeEventBatch(base, script);
    const sequential = script.reduce((acc, item) => mergeEventBatch(acc, [item]), base);
    expect(batched).toEqual(sequential);
  });

  it('stays on the append fast path for a session-sized stream', () => {
    // 真实最大会话有 94145 条事件。若哪天退化成「每批都重建索引」，这里会从
    // 亚秒级变成十几秒（实测 0.38s vs 10.7s），CI 的默认超时会直接把它拦下来。
    let merged: ReturnType<typeof mergeEventBatch> = [];
    let batch: ReturnType<typeof event>[] = [];
    for (let sequence = 1; sequence <= 100_000; sequence++) {
      batch.push(event(sequence));
      if (batch.length === 25) { merged = mergeEventBatch(merged, batch); batch = []; }
    }
    merged = mergeEventBatch(merged, batch);
    expect(merged).toHaveLength(100_000);
    expect(merged[0].sequence).toBe(1);
    expect(merged[99_999].sequence).toBe(100_000);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/agent-dock-shared';
import { StreamEventCoalescer, isCoalescableStreamDelta, type CoalescedStreamDelta } from './stream-coalescer.js';

function fixture(options: { maxBytes?: number; maxDelayMs?: number } = {}) {
  const appended: CoalescedStreamDelta[] = [];
  const queued: string[] = [];
  let sequence = 0;
  const coalescer = new StreamEventCoalescer({
    maxBytes: options.maxBytes,
    maxDelayMs: options.maxDelayMs,
    append: async (sessionId, delta) => {
      appended.push(delta);
      return { id: `evt-${++sequence}`, sessionId, sequence, type: delta.type, timestamp: new Date().toISOString(), data: delta.data } as AgentEvent;
    },
    enqueue: async (sessionId, task) => { queued.push(sessionId); return task(); }
  });
  const write = async (type: 'text' | 'thinking', data: Record<string, unknown>) => {
    const input = { type, data };
    if (!isCoalescableStreamDelta(input)) throw new Error('not coalescable');
    return coalescer.write('session-a', input);
  };
  return { coalescer, appended, queued, write };
}

afterEach(() => vi.useRealTimers());

describe('写入侧流式分片合并', () => {
  it('把连续的思考拼成一段，flush 时只落一条完整正文', async () => {
    const f = fixture({ maxBytes: 1024 });
    expect(await f.write('thinking', { text: '先' })).toBeUndefined();
    expect(await f.write('thinking', { text: '想' })).toBeUndefined();
    expect(f.appended).toHaveLength(0);

    const event = await f.coalescer.flush('session-a');
    expect(f.appended).toHaveLength(1);
    expect(event?.data).toEqual({ text: '先想' });
    expect(event?.sequence).toBe(1);
    // 再 flush 是空操作，不会把同一段文字写第二遍。
    expect(await f.coalescer.flush('session-a')).toBeUndefined();
    expect(f.appended).toHaveLength(1);
  });

  it('类型或附加字段变化时先落旧段，任务/角色不会串到同一行', async () => {
    const f = fixture({ maxBytes: 1024 });
    await f.write('thinking', { text: '思考', taskId: 'task-1' });
    await f.write('text', { text: '回答', taskId: 'task-1' });
    await f.write('text', { text: '别的轮次', taskId: 'task-2' });
    await f.coalescer.flush('session-a');

    expect(f.appended.map(delta => [delta.type, delta.data])).toEqual([
      ['thinking', { text: '思考', taskId: 'task-1' }],
      ['text', { text: '回答', taskId: 'task-1' }],
      ['text', { text: '别的轮次', taskId: 'task-2' }]
    ]);
  });

  it('撞到字节阈值立即落库，不让单个分片段无限变长', async () => {
    const f = fixture({ maxBytes: 8 });
    expect(await f.write('text', { text: '1234' })).toBeUndefined();
    const flushed = await f.write('text', { text: '5678' });
    expect(flushed?.data).toEqual({ text: '12345678' });
    expect(await f.coalescer.flush('session-a')).toBeUndefined();
    expect(f.appended).toHaveLength(1);
  });

  it('超过最大延迟由定时器落库，且走与会话相同的串行队列', async () => {
    vi.useFakeTimers();
    const f = fixture({ maxBytes: 1024, maxDelayMs: 250 });
    await f.write('thinking', { text: '慢速流' });
    expect(f.appended).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.appended).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.queued).toEqual(['session-a']);
    expect(f.appended.map(delta => delta.data.text)).toEqual(['慢速流']);
  });

  it('只合并正文/思考分片：用户提问、raw 事件与其它类型原样旁路', () => {
    expect(isCoalescableStreamDelta({ type: 'thinking', data: { text: 'x' } })).toBe(true);
    expect(isCoalescableStreamDelta({ type: 'text', data: { text: 'x' } })).toBe(true);
    expect(isCoalescableStreamDelta({ type: 'text', data: { text: '提问', role: 'user' } })).toBe(false);
    expect(isCoalescableStreamDelta({ type: 'text', data: { text: 'x' }, raw: '{"x":1}' })).toBe(false);
    expect(isCoalescableStreamDelta({ type: 'status', data: { text: 'state' } })).toBe(false);
    expect(isCoalescableStreamDelta({ type: 'text', data: {} })).toBe(false);
  });

  it('Agent 告警单独成段，不会把后面的正文吸进 Warning 行', async () => {
    const f = fixture({ maxBytes: 1024 });
    await f.write('text', { text: 'Warning: skills budget trimmed' });
    await f.write('text', { text: '平台' });
    await f.write('text', { text: ' AI 已就绪。' });
    await f.coalescer.flush('session-a');
    expect(f.appended.map(delta => delta.data.text)).toEqual(['Warning: skills budget trimmed', '平台 AI 已就绪。']);
  });
});

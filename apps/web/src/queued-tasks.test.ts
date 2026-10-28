import { describe, expect, it } from 'vitest';
import type { Task } from './api';
import { buildTimeline, startsImmediately, waitingQueuedTasks } from './timeline';

const task = (id: string, status: string, createdAt = '2026-01-01T00:00:00.000Z'): Task =>
  ({ id, sessionId: 's1', prompt: id, status, createdAt, updatedAt: createdAt });

describe('queued task panel visibility', () => {
  it('treats the head of the queue as about to start while the session is idle', () => {
    // 服务端对 send 一律返回 202 + status='queued'，即使会话空闲、这条马上就会执行。
    // 照搬会让「等待发送 / 立即发送」在发完消息后闪现，直到 SSE 推来 running 才消失。
    expect(waitingQueuedTasks([task('t1', 'queued')], false)).toEqual([]);
  });

  it('keeps later prompts in the panel in the gap between two queued tasks', () => {
    // 上一条完成到队首切成 running 之间会话短暂是 completed，队列不能整个消失。
    const tasks = [task('t1', 'completed'), task('t2', 'queued', '2026-01-01T00:00:01.000Z'), task('t3', 'queued', '2026-01-01T00:00:02.000Z')];
    expect(waitingQueuedTasks(tasks, false).map(item => item.id)).toEqual(['t3']);
  });

  it('shows genuinely queued tasks while the Agent is busy', () => {
    const tasks = [task('t1', 'running'), task('t2', 'queued'), task('t3', 'queued')];
    expect(waitingQueuedTasks(tasks, true).map(item => item.id)).toEqual(['t2', 't3']);
  });

  it('never counts running or terminal tasks as queued', () => {
    const tasks = [task('t1', 'running'), task('t2', 'completed'), task('t3', 'failed'), task('t4', 'cancelled')];
    expect(waitingQueuedTasks(tasks, true)).toEqual([]);
  });

  it('tolerates a missing task list', () => {
    expect(waitingQueuedTasks(undefined, true)).toEqual([]);
    expect(waitingQueuedTasks(undefined, false)).toEqual([]);
  });

  it('never shows a prompt in both the panel and the timeline, nor in neither', () => {
    const tasks = [task('t1', 'completed'), task('t2', 'queued', '2026-01-01T00:00:01.000Z'), task('t3', 'queued', '2026-01-01T00:00:02.000Z')];
    const optimistic = tasks.slice(1).map(item => ({ id: `local-${item.id}`, prompt: item.prompt, createdAt: item.createdAt, taskId: item.id }));
    for (const busy of [true, false]) {
      const inPanel = waitingQueuedTasks(tasks, busy).map(item => item.id);
      const inTimeline = buildTimeline([], tasks, optimistic, busy).filter(item => item.data.optimistic).map(item => item.data.text);
      expect([...inPanel, ...inTimeline].sort()).toEqual(['t2', 't3']);
    }
  });
});

describe('scroll to bottom on send', () => {
  it('scrolls when the message will start right away', () => {
    expect(startsImmediately('idle', 'queue', [task('t1', 'completed')])).toBe(true);
    expect(startsImmediately('thinking', 'interrupt', [task('t1', 'running')])).toBe(true);
  });

  it('leaves the reader where they are when the message has to wait in the queue', () => {
    expect(startsImmediately('thinking', 'queue', [task('t1', 'running')])).toBe(false);
    // 两条任务交接的空档：会话短暂是 completed，但前面还有排队消息。
    expect(startsImmediately('completed', 'queue', [task('t1', 'completed'), task('t2', 'queued')])).toBe(false);
  });
});

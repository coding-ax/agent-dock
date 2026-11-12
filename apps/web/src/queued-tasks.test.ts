import { describe, expect, it } from 'vitest';
import type { DockEvent, Task } from './api';
import { awaitsFirstOutput, bindOptimisticTask, buildTimeline, buildTimelineSections, optimisticRowKeys, startsImmediately, timelineRowKey, waitingQueuedTasks, type OptimisticMessage, type TimelineEvent } from './timeline';

const task = (id: string, status: string, createdAt = '2026-01-01T00:00:00.000Z'): Task =>
  ({ id, sessionId: 's1', prompt: id, status, createdAt, updatedAt: createdAt });
const userEvent = (sequence: number, text: string, taskId: string, timestamp: string): DockEvent =>
  ({ id: `event-${sequence}`, sequence, type: 'text', timestamp, data: { role: 'user', text, taskId } });

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

  it('never shows silent-origin tasks in the editable wait panel', () => {
    const silent = { ...task('t2', 'queued', '2026-01-01T00:00:01.000Z'), origin: 'emoji', prompt: '静默触发：完整上下文' };
    const normal = { ...task('t3', 'queued', '2026-01-01T00:00:02.000Z'), prompt: '普通排队消息' };
    const hidden = new Set(['emoji']);
    expect(waitingQueuedTasks([task('t1', 'running'), silent, normal], true, [], hidden).map(item => item.id)).toEqual(['t3']);
    // 隐藏项仍占着队首位置：idle 时后面的普通消息不能顶上来冒充「即将发送」。
    expect(waitingQueuedTasks([task('t1', 'completed'), silent, normal], false, [], hidden)).toEqual([]);
  });

  it('lists a prompt submitted into the queue the moment it is sent, before the server answers', () => {
    const unsent: OptimisticMessage = { id: 'local-2', prompt: '排队的消息', createdAt: '2026-01-01T00:00:05.000Z', placement: 'queue' };
    const rows = waitingQueuedTasks([task('t1', 'running'), task('t0', 'queued', '2026-01-01T00:00:01.000Z')], true, [unsent]);
    expect(rows.map(row => [row.prompt, row.pending ?? false])).toEqual([['t0', false], ['排队的消息', true]]);
  });

  it('swaps the pending row for the real queued task without listing it twice', () => {
    const unsent: OptimisticMessage = { id: 'local-2', prompt: 't2', createdAt: '2026-01-01T00:00:01.000Z', placement: 'queue' };
    const queued = task('t2', 'queued', '2026-01-01T00:00:01.200Z');
    // SSE 先到：还没绑定 taskId，按「同文本 + 5 秒内」认领。
    expect(waitingQueuedTasks([task('t1', 'running'), queued], true, [unsent]).map(row => [row.id, row.pending ?? false])).toEqual([['t2', false]]);
    // send 响应回来、已绑定。
    expect(waitingQueuedTasks([task('t1', 'running'), queued], true, [{ ...unsent, taskId: 't2' }]).map(row => row.id)).toEqual(['t2']);
  });

  it('keeps an idle queue head in the panel when this page submitted it there', () => {
    // 上一轮刚结束、会话短暂空闲：它马上就要开始，但开始前不该从面板消失、也不该先进时间线。
    const message: OptimisticMessage = { id: 'local-2', prompt: 't2', createdAt: '2026-01-01T00:00:01.000Z', placement: 'queue', taskId: 't2' };
    expect(waitingQueuedTasks([task('t1', 'completed'), task('t2', 'queued', '2026-01-01T00:00:01.000Z')], false, [message]).map(row => row.id)).toEqual(['t2']);
  });

  it('never lists a prompt that was submitted onto the timeline', () => {
    // 打断发送时会话是 busy 的，这条在队首等着打断完成；它已经以「发送中」气泡显示在时间线里。
    const message: OptimisticMessage = { id: 'local-2', prompt: 't2', createdAt: '2026-01-01T00:00:01.000Z', placement: 'timeline', taskId: 't2' };
    expect(waitingQueuedTasks([task('t1', 'running'), task('t2', 'queued', '2026-01-01T00:00:01.000Z')], true, [message])).toEqual([]);
  });

  it('shows every prompt exactly once across the panel and the timeline through its whole lifecycle', () => {
    const createdAt = '2026-01-01T00:00:01.000Z';
    for (const placement of ['timeline', 'queue'] as const) {
      const base: OptimisticMessage = { id: `local-${placement}`, prompt: 'p', createdAt, placement };
      const queued = { ...task('t2', 'queued', createdAt), prompt: 'p' };
      const running = { ...queued, status: 'running' };
      const previous = task('t1', placement === 'timeline' ? 'completed' : 'running');
      const stages: Array<{ tasks: Task[]; messages: OptimisticMessage[]; events: DockEvent[]; busy: boolean[] }> = [
        { tasks: [previous], messages: [base], events: [], busy: [true, false] },
        { tasks: [previous, queued], messages: [base], events: [], busy: [true, false] },
        { tasks: [previous, queued], messages: [{ ...base, taskId: 't2' }], events: [], busy: [true, false] },
        { tasks: [previous, running], messages: [{ ...base, taskId: 't2', settled: true }], events: [], busy: [true, false] },
        { tasks: [previous, running], messages: [{ ...base, taskId: 't2', settled: true }], events: [userEvent(5, 'p', 't2', '2026-01-01T00:00:02.000Z')], busy: [true] }
      ];
      for (const stage of stages) {
        for (const busy of stage.busy) {
          const inPanel = waitingQueuedTasks(stage.tasks, busy, stage.messages).filter(row => row.prompt === 'p');
          const inTimeline = buildTimeline(stage.events, stage.tasks, stage.messages).filter(item => item.data.role === 'user' && item.data.text === 'p');
          expect({ placement, busy, shown: inPanel.length + inTimeline.length }).toEqual({ placement, busy, shown: 1 });
          if (placement === 'queue') expect(inTimeline.length === 0 || stage.tasks.at(-1)!.status === 'running').toBe(true);
        }
      }
    }
  });
});

describe('binding optimistic prompts to server tasks', () => {
  const message: OptimisticMessage = { id: 'local-1', prompt: 't1', createdAt: '2026-01-01T00:00:00.000Z', placement: 'timeline' };

  it('binds the send response to the exact message it came from', () => {
    const other: OptimisticMessage = { ...message, id: 'local-0' };
    expect(bindOptimisticTask([other, message], task('t1', 'queued'), 'local-1')).toEqual([other, { ...message, taskId: 't1' }]);
  });

  it('claims a task pushed over SSE before the send response by matching text and time', () => {
    expect(bindOptimisticTask([message], task('t1', 'queued', '2026-01-01T00:00:00.300Z'))).toEqual([{ ...message, taskId: 't1' }]);
    expect(bindOptimisticTask([message], task('t1', 'queued', '2026-01-01T00:00:09.000Z'))).toEqual([message]);
  });

  it('settles a message once its task leaves the queue and never unsettles it on a stale poll', () => {
    const settled = bindOptimisticTask([{ ...message, taskId: 't1' }], task('t1', 'running'));
    expect(settled).toEqual([{ ...message, taskId: 't1', settled: true }]);
    expect(bindOptimisticTask(settled, task('t1', 'queued'))).toBe(settled);
  });

  it('returns the same array when nothing changes so React skips the update', () => {
    const bound = [{ ...message, taskId: 't1' }];
    expect(bindOptimisticTask(bound, task('t1', 'queued'))).toBe(bound);
    expect(bindOptimisticTask(bound, task('unrelated', 'running'))).toBe(bound);
  });

  it('does not let a second identical prompt steal a task another message already owns', () => {
    const first = { ...message, taskId: 't1', settled: true };
    const second: OptimisticMessage = { ...message, id: 'local-2', createdAt: '2026-01-01T00:00:01.000Z' };
    expect(bindOptimisticTask([first, second], task('t1', 'completed'))).toEqual([first, second]);
  });
});

describe('stable timeline row keys', () => {
  it('keeps one key while a prompt goes from sending bubble to task row to the real event', () => {
    // 三种身份 id 各不相同；key 跟着 id 变会让气泡连着重挂三次、每次从透明重播入场动画。
    const createdAt = '2026-01-01T00:00:01.000Z';
    const sending: OptimisticMessage = { id: 'local-1', prompt: 'p', createdAt, placement: 'timeline' };
    const stages: Array<{ tasks: Task[]; messages: OptimisticMessage[]; events: DockEvent[] }> = [
      { tasks: [], messages: [sending], events: [] },
      { tasks: [{ ...task('t1', 'queued', createdAt), prompt: 'p' }], messages: [{ ...sending, taskId: 't1' }], events: [] },
      { tasks: [{ ...task('t1', 'running', createdAt), prompt: 'p' }], messages: [{ ...sending, taskId: 't1', settled: true }], events: [] },
      { tasks: [{ ...task('t1', 'running', createdAt), prompt: 'p' }], messages: [{ ...sending, taskId: 't1', settled: true }], events: [userEvent(3, 'p', 't1', '2026-01-01T00:00:01.500Z')] }
    ];
    const keys = stages.map(stage => {
      const [row] = buildTimeline(stage.events, stage.tasks, stage.messages);
      return timelineRowKey(row!, optimisticRowKeys(stage.messages));
    });
    expect(new Set(keys)).toEqual(new Set(['local-1']));
  });

  it('falls back to the event id for prompts sent from elsewhere', () => {
    const [row] = buildTimeline([userEvent(1, 'from lark', 't9', '2026-01-01T00:00:00.000Z')]);
    expect(timelineRowKey(row!, optimisticRowKeys([]))).toBe('event-1');
  });
});

describe('a queued prompt taking its turn', () => {
  // 上一轮跑到一半时提交的排队消息：创建时间落在上一轮中间，开始执行是在上一轮回复之后。
  const previousTurn: DockEvent[] = [
    userEvent(1, 'previous', 't1', '2026-01-01T00:00:00.000Z'),
    { id: 'event-2', sequence: 2, type: 'tool_call', timestamp: '2026-01-01T00:00:01.000Z', data: { id: 'c1', name: 'Bash', status: 'completed' } },
    { id: 'event-3', sequence: 3, type: 'text', timestamp: '2026-01-01T00:01:30.000Z', data: { role: 'assistant', text: '完成' } }
  ];
  const previous: Task = { ...task('t1', 'completed'), prompt: 'previous', updatedAt: '2026-01-01T00:01:30.500Z' };
  const next: Task = { ...task('t2', 'running', '2026-01-01T00:00:10.000Z'), prompt: 'next', updatedAt: '2026-01-01T00:01:31.000Z' };
  const shape = (events: DockEvent[]) => buildTimelineSections(buildTimeline(events, [previous, next]), [previous, next])
    .map(section => section.kind === 'event' ? `${section.final ? 'final' : 'row'}:${section.event.data.text}` : 'activity');

  it('lands after the previous answer the moment the task starts, before its own user event arrives', () => {
    // task running 立即生效，真实用户事件晚一帧才到。按创建时间排，补出来的行会插进上一轮中间，
    // 上一轮的回复被挤到它下面、下一帧又跳回去：实测时间线弹 60px，回复闪一下。
    expect(shape(previousTurn)).toEqual(['row:previous', 'activity', 'final:完成', 'row:next']);
  });

  it('keeps the same layout when the real user event replaces the task row', () => {
    const started = [...previousTurn, userEvent(4, 'next', 't2', '2026-01-01T00:01:31.002Z')];
    expect(shape(started)).toEqual(shape(previousTurn));
  });

  it('keeps the task row when the closing status lands a frame before the user event', () => {
    // 事件按帧合批：上一轮的收尾 status 可能单独占一帧。增量重建只重放 events，补出来的行会被丢掉，气泡闪没一帧。
    const tasks = [previous, next];
    const before = buildTimeline(previousTurn, tasks).map(item => item.data.text ?? item.type);
    const closing: DockEvent = { id: 'event-4', sequence: 4, type: 'status', timestamp: '2026-01-01T00:01:30.600Z', data: { state: 'completed' } };
    expect(buildTimeline([...previousTurn, closing], tasks).map(item => item.data.text ?? item.type)).toEqual(before);
  });
});

describe('a prompt sent onto the timeline', () => {
  const answering: DockEvent[] = [
    userEvent(1, 'previous', 't1', '2026-01-01T00:00:00.000Z'),
    { id: 'event-2', sequence: 2, type: 'text', timestamp: '2026-01-01T00:00:05.000Z', data: { role: 'assistant', text: '正在' } }
  ];
  const rows = (timeline: TimelineEvent[]) => timeline.map(item => `${item.data.role}:${item.data.text}`);

  it('sits below everything on screen even when this machine’s clock runs behind the server', () => {
    // 按本机提交时间排序：时钟慢几秒，气泡就插到上一轮回复上面，真实事件一到再跳回末尾。
    const sending: OptimisticMessage = { id: 'local-1', prompt: 'next', createdAt: '2026-01-01T00:00:03.000Z', placement: 'timeline' };
    expect(rows(buildTimeline(answering, [task('t1', 'completed')], [sending]))).toEqual(['user:previous', 'assistant:正在', 'user:next']);
  });

  it('stays put, with the interrupted turn’s closing output above it, while that output streams in', () => {
    // 打断发送：被打断的那一轮还会再吐几段收尾输出。它们属于上一轮；气泡也不能在增量重建时被丢掉。
    const sending: OptimisticMessage = { id: 'local-1', prompt: 'next', createdAt: '2026-01-01T00:00:05.500Z', placement: 'timeline' };
    const tasks = [task('t1', 'running')];
    const messages = [sending];
    expect(rows(buildTimeline(answering, tasks, messages))).toEqual(['user:previous', 'assistant:正在', 'user:next']);
    const closing: DockEvent = { id: 'event-3', sequence: 3, type: 'text', timestamp: '2026-01-01T00:00:06.000Z', data: { role: 'assistant', text: '收尾' } };
    expect(rows(buildTimeline([...answering, closing], tasks, messages))).toEqual(['user:previous', 'assistant:正在收尾', 'user:next']);
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
    // 任务已切成 running、会话状态的 SSE 还没到。
    expect(startsImmediately('completed', 'queue', [task('t1', 'running')])).toBe(false);
  });
});

describe('first output placeholder', () => {
  const [sending] = buildTimeline([], [], [{ id: 'local-1', prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', placement: 'timeline' }]);
  const [started] = buildTimeline([userEvent(1, 'p', 't1', '2026-01-01T00:00:00.000Z')]);

  it('appears together with the sending bubble so nothing moves when the task starts', () => {
    expect(awaitsFirstOutput(sending, [], false, false)).toBe(true);
  });

  it('stays up while the task runs even before the busy status arrives', () => {
    expect(awaitsFirstOutput(started, [task('t1', 'running')], false, false)).toBe(true);
    expect(awaitsFirstOutput(started, [task('t1', 'running')], true, false)).toBe(true);
  });

  it('never flashes between task completion and the idle status', () => {
    expect(awaitsFirstOutput(started, [task('t1', 'completed')], true, false)).toBe(false);
  });

  it('yields to the real activity panel and needs a user message', () => {
    expect(awaitsFirstOutput(started, [task('t1', 'running')], true, true)).toBe(false);
    expect(awaitsFirstOutput(undefined, [], true, false)).toBe(false);
  });
});

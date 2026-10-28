import { describe, expect, it } from 'vitest';
import type { DockEvent, SessionRecord, Task } from './api';
import { AUTO_LOAD_MAX_ROWS, AUTO_LOAD_ROUNDS, buildRequestTrajectory, buildRoundActivity, processSummary, splitInjectedPrefix } from './session-request-log';

function task(overrides: Partial<Task>): Task {
  return { id: 'task_1', sessionId: 'ses_1', prompt: '你好', status: 'completed', createdAt: '2026-09-24T00:00:01Z', updatedAt: '2026-09-24T00:00:02Z', ...overrides };
}

function record(tasks: Task[], systemPrompt?: string, events: DockEvent[] = []): SessionRecord {
  return {
    session: { id: 'ses_1', agentId: 'claude', state: 'completed', cwd: '/tmp', runId: 'run_1', createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', systemPrompt },
    tasks,
    events
  };
}

/** 序号决定时间戳：本轮事件的 timestamp 必须晚于 task.createdAt，否则补出来的提问会排到回答后面。 */
const event = (sequence: number, type: string, data: any): DockEvent => ({ id: `e${sequence}`, sequence, type, timestamp: new Date(Date.UTC(2026, 8, 24, 0, 0, sequence)).toISOString(), data });

function available(activity: ReturnType<typeof buildRoundActivity>): Extract<ReturnType<typeof buildRoundActivity>, { state: 'available' }> {
  if (activity.state !== 'available') throw new Error(`期望 available，实际 ${JSON.stringify(activity)}`);
  return activity;
}

describe('splitInjectedPrefix', () => {
  it('marks the injected prefix when the sent text ends with the visible text', () => {
    expect(splitInjectedPrefix('你好', '[机器人身份]\n[用户请求]\n你好')).toEqual({ state: 'sent', text: '[机器人身份]\n[用户请求]\n你好', form: 'injected', prefix: '[机器人身份]\n[用户请求]\n' });
  });

  it('reports identical when nothing was injected', () => {
    expect(splitInjectedPrefix('你好', '你好')).toEqual({ state: 'sent', text: '你好', form: 'identical' });
  });

  it('refuses to attribute a difference it cannot explain', () => {
    expect(splitInjectedPrefix('你好', '完全不同的文本')).toEqual({ state: 'sent', text: '完全不同的文本', form: 'unrelated' });
  });
});

describe('buildRequestTrajectory', () => {
  it('keeps the session prompt and the exact sent text, ordered by round', () => {
    const trajectory = buildRequestTrajectory(record([
      task({ id: 'task_2', createdAt: '2026-09-24T00:00:05Z', prompt: '第二轮' }),
      task({ id: 'task_1', prompt: '你好', sentPrompt: '[机器人身份]\n[用户请求]\n你好' })
    ], '创建时提示词'));

    expect(trajectory.scope.systemPrompt).toBe('创建时提示词');
    expect(trajectory.rounds.map(round => round.id)).toEqual(['task_1', 'task_2']);
    expect(trajectory.rounds[0]).toMatchObject({ index: 1, visiblePrompt: '你好', payload: { form: 'injected', prefix: '[机器人身份]\n[用户请求]\n' } });
    expect(trajectory.sentRounds).toBe(1);
  });

  it('does not present a historical missing prompt as the request that was sent', () => {
    expect(buildRequestTrajectory(record([task({})])).rounds[0].payload).toEqual({ state: 'unavailable' });
  });

  it('distinguishes a task that was never handed to the agent', () => {
    expect(buildRequestTrajectory(record([task({ status: 'cancelled' })])).rounds[0].payload).toEqual({ state: 'not-sent' });
  });

  it('treats an absent session prompt as unset, not as an empty string', () => {
    expect(buildRequestTrajectory(record([], '  ')).scope.systemPrompt).toBeNull();
  });

  it('carries the stored final output and the process size from the turn map', () => {
    const trajectory = buildRequestTrajectory(record([
      task({ id: 'task_1', finalText: '本轮结论' }),
      task({ id: 'task_2', createdAt: '2026-09-24T00:00:05Z', finalText: null })
    ]), [
      { taskId: 'task_1', startSequence: 1, endSequence: 4, segments: 2 },
      { taskId: 'task_2', startSequence: 4, endSequence: 9, segments: 0 }
    ]);
    expect(trajectory.rounds.map(round => [round.id, round.finalText, round.processEvents])).toEqual([['task_1', '本轮结论', 2], ['task_2', null, 0]]);
    // updatedAt 要跟着进来：过程面板的「耗时」用它当完成时刻，缺了就只能是 0 秒。
    expect(trajectory.rounds[0]!.updatedAt).toBe('2026-09-24T00:00:02Z');
    expect(trajectory.scope.modelLabel).toBe('claude');
  });

  it('reports no process count for a round the turn map does not know', () => {
    const trajectory = buildRequestTrajectory(record([task({ id: 'task_9' })]));
    expect(trajectory.rounds[0]!.processEvents).toBe(0);
    expect(trajectory.rounds[0]!.finalText).toBeNull();
  });

  // 自动恢复的额度是「打开面板不炸」的那条线：旧会话（没存最终输出）几十轮，若每轮都自动拉，
  // 面板一打开就是几十个请求——正是这次要避开的事。所以只有最近几轮、且过程便宜的那些才自动拉。
  it('auto-loads the final output only for recent, cheap rounds that never stored one', () => {
    const rounds = Array.from({ length: AUTO_LOAD_ROUNDS + 1 }, (_, index) => task({
      id: `task_${index + 1}`,
      createdAt: `2026-09-24T00:00:${String(index + 1).padStart(2, '0')}Z`,
      finalText: null
    }));
    const turns = rounds.map((round, index) => ({ taskId: round.id, startSequence: index, endSequence: index + 1, segments: 10 }));
    const auto = buildRequestTrajectory(record(rounds), turns).rounds.map(round => round.autoLoadProcess);
    // 只有最后一轮在额度内（AUTO_LOAD_ROUNDS 是「最近几轮」），最早的这一轮不在。
    expect(auto).toEqual([false, ...Array.from({ length: AUTO_LOAD_ROUNDS }, () => true)]);
  });

  it('never auto-loads a round that stored its own final output or was never sent', () => {
    const trajectory = buildRequestTrajectory(record([
      task({ id: 'task_1', finalText: '已经存了' }),
      task({ id: 'task_2', createdAt: '2026-09-24T00:00:02Z', status: 'cancelled' })
    ]), [
      { taskId: 'task_1', startSequence: 1, endSequence: 2, segments: 5 },
      { taskId: 'task_2', startSequence: 2, endSequence: 3, segments: 5 }
    ]);
    expect(trajectory.rounds.map(round => round.autoLoadProcess)).toEqual([false, false]);
  });

  it('leaves a heavy round for the user to open on purpose', () => {
    const trajectory = buildRequestTrajectory(record([
      task({ id: 'task_1', finalText: null }),
      task({ id: 'task_2', createdAt: '2026-09-24T00:00:02Z', finalText: null })
    ]), [
      { taskId: 'task_1', startSequence: 1, endSequence: 2, segments: AUTO_LOAD_MAX_ROWS + 1 },
      { taskId: 'task_2', startSequence: 2, endSequence: 3, segments: AUTO_LOAD_MAX_ROWS }
    ]);
    // 上限本身也算「便宜」——差一条就翻脸是没道理的。
    expect(trajectory.rounds.map(round => round.autoLoadProcess)).toEqual([false, true]);
  });
});

describe('buildRoundActivity', () => {
  it('reads a whole round out of its own events, with the final output picked by the shared rules', () => {
    const round = task({ id: 'task_1', prompt: '你好', status: 'completed' });
    const activity = available(buildRoundActivity(round, { state: 'events', events: [
      event(2, 'thinking', { text: '先看看代码' }),
      event(3, 'tool_call', { id: 'tool_1', name: 'Read', status: 'running', input: { file: 'a.ts' } }),
      event(4, 'tool_result', { id: 'tool_1', status: 'completed' }),
      event(5, 'text', { text: '答案' })
    ] }));

    expect(activity.groups).toHaveLength(1);
    expect(activity.groups[0]!.events.some(item => item.type === 'thinking')).toBe(true);
    expect(activity.hasAnswer).toBe(true);
    expect(activity.final?.data.text).toBe('答案');
    expect(activity.taskStatus).toBe('completed');
    // 过程面板的时间轴从这一轮开始算，不是从「面板打开时」算。
    expect(activity.startedAt).toBe(round.createdAt);
    expect(activity.completedAt).toBe(round.updatedAt);
    // 加过程视图不能顺手改掉「实际请求」那一半的判定。
    const trajectory = buildRequestTrajectory(record([round]));
    expect(trajectory.sentRounds).toBe(0);
    expect(trajectory.rounds[0]!.payload).toEqual({ state: 'unavailable' });
  });

  it('counts merged thinking and tool calls instead of raw event rows', () => {
    // 真实一轮：一句话的回答，原始行里有 status/task/completed/raw_terminal 和 token 级分片，老文案会写「26 条事件」。
    const round = task({ id: 'task_1', status: 'completed' });
    const events = [
      event(2, 'status', { state: 'thinking' }), event(3, 'task', { status: 'running' }), event(4, 'raw_terminal', { text: 'x' }),
      ...Array.from({ length: 10 }, (_, i) => event(5 + i, 'thinking', { text: `t${i}` })),
      event(20, 'tool_call', { id: 'tool_1', name: 'Read', status: 'running' }), event(21, 'tool_result', { id: 'tool_1', status: 'completed' }),
      ...Array.from({ length: 8 }, (_, i) => event(30 + i, 'text', { text: `a${i}` })),
      event(40, 'status', { state: 'completed' }), event(41, 'completed', {})
    ];
    expect(processSummary(buildRoundActivity(round, { state: 'events', events }))).toBe('1 段思考 · 1 次工具调用');
    expect(processSummary(buildRoundActivity(round, { state: 'events', events: [event(2, 'thinking', { text: 'a' }), event(3, 'text', { text: '答' })] }))).toBe('1 段思考');
    // 还没拉过程时不乱报数字。
    expect(processSummary(buildRoundActivity(round, { state: 'missing', reason: 'no-events-saved' }))).toBeUndefined();
  });

  it('says the events were never saved instead of pretending the round was empty', () => {
    expect(buildRoundActivity(task({}), { state: 'missing', reason: 'no-events-saved' }))
      .toEqual({ state: 'unavailable', reason: 'no-events-saved' });
  });

  it('refuses to claim a round it cannot anchor, even when the text matches', () => {
    const round = task({ id: 'task_2', prompt: '第二轮问题', status: 'completed', createdAt: '2026-09-24T00:00:10Z' });
    expect(buildRoundActivity(round, { state: 'missing', reason: 'no-anchor' }))
      .toEqual({ state: 'unavailable', reason: 'no-anchor' });
    // 事件里那条 role:'user' 的文本与提问逐字相同，但它没有 taskId——timeline.ts 的 legacyPrompts
    // 去重正是不给它补一条锚点，于是这一轮认不出 task，也就拿不到最终输出。按文本认领是错的。
    const guessed = available(buildRoundActivity(round, { state: 'events', events: [
      event(11, 'text', { text: '第二轮问题', role: 'user' }),
      event(12, 'thinking', { text: '别人的思考' }),
      event(13, 'text', { text: '别人的答案' })
    ] }));
    expect(guessed.hasAnswer).toBe(false);
    expect(guessed.final).toBeNull();
    // 状态仍以任务自己为准：认不出轮次不等于把已完成的轮次说成还在跑。
    expect(guessed.taskStatus).toBe('completed');
  });

  it('reports an empty round as empty rather than as a process panel', () => {
    // toEqual 是刻意的：这里要证明确实没有凭空造出 groups / final / hasAnswer。
    expect(buildRoundActivity(task({}), { state: 'events', events: [] }))
      .toEqual({ state: 'unavailable', reason: 'no-events-this-round' });
  });

  it('never presents a queued or cancelled round as having run', () => {
    const events = [event(2, 'thinking', { text: '不该有过程的轮次' })];
    expect(buildRoundActivity(task({ status: 'queued' }), { state: 'events', events })).toEqual({ state: 'not-sent' });
    expect(buildRoundActivity(task({ status: 'cancelled' }), { state: 'events', events })).toEqual({ state: 'not-sent' });
  });

  it('keeps each round paired with its own events', () => {
    const first = task({ id: 'task_1', prompt: '第一轮', createdAt: '2026-09-24T00:00:01Z' });
    const second = task({ id: 'task_2', prompt: '第二轮', createdAt: '2026-09-24T00:00:05Z' });
    const firstRound = available(buildRoundActivity(first, { state: 'events', events: [event(2, 'thinking', { text: '第一轮思考' }), event(3, 'text', { text: '第一轮答案' })] }));
    const secondRound = available(buildRoundActivity(second, { state: 'events', events: [event(6, 'thinking', { text: '第二轮思考' }), event(7, 'text', { text: '第二轮答案' })] }));

    expect(firstRound.final?.data.text).toBe('第一轮答案');
    expect(secondRound.final?.data.text).toBe('第二轮答案');
    // 每轮只吃自己那份事件：组的思考文本与时间轴都来自本轮，不是按位置错位的邻居。
    expect(firstRound.groups[0]!.events.map(item => item.data.text)).toEqual(['第一轮思考']);
    expect(secondRound.groups[0]!.events.map(item => item.data.text)).toEqual(['第二轮思考']);
    expect(firstRound.groups[0]!.startedAt).toBe('2026-09-24T00:00:02.000Z');
    expect(secondRound.groups[0]!.startedAt).toBe('2026-09-24T00:00:06.000Z');
  });

  it('folds raw streamed deltas on the client, so it does not depend on the server compacting them', () => {
    const activity = available(buildRoundActivity(task({}), { state: 'events', events: [
      event(2, 'thinking', { text: '思' }),
      event(3, 'thinking', { text: '考' }),
      event(4, 'text', { text: '结' }),
      event(5, 'text', { text: '论' })
    ] }));
    const thinking = activity.groups[0]!.events.filter(item => item.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.data.text).toBe('思考');
    expect(activity.final?.data.text).toBe('结论');
  });
});

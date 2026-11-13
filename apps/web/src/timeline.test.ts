import { describe, expect, it } from 'vitest';
import { buildActivitySteps, thinkingTitle, buildTimeline, buildTimelineSections, eventRenderSignature, groupTimelineSections, isStreamingSection, isTurnOngoing, toolDisplayName, turnTimeBadge, type TimelineEvent } from './timeline';

const event = (sequence: number, type: string, data: any) => ({ id: `e${sequence}`, sequence, type, timestamp: '', data });

describe('conversation timeline', () => {
  it('joins streamed token deltas into one Markdown message', () => {
    const timeline = buildTimeline([event(1, 'thinking', { text: 'Con' }), event(2, 'status', { state: 'thinking' }), event(3, 'thinking', { text: 'sidering' }), event(4, 'text', { text: '你' }), event(5, 'text', { text: '好' })]);
    expect(timeline).toHaveLength(2);
    expect(timeline.map(item => item.id)).toEqual(['e1', 'e4']);
    expect(timeline.map(item => item.sequence)).toEqual([3, 5]);
    expect(timeline[0].data.text).toBe('Considering');
    expect(timeline[1].data.text).toBe('你好');
  });

  it('keeps Markdown table row breaks when newline chunks are merged', () => {
    const chunks = ['结论。\n\n', '| 步骤 | 结果 |\n', '|---|---|\n', '| 1 | 通过 |'];
    const timeline = buildTimeline(chunks.map((text, index) => event(index + 1, 'text', { text })));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.data.text).toBe(chunks.join(''));
  });

  it('does not merge user and assistant messages', () => {
    const timeline = buildTimeline([event(1, 'text', { text: 'Hello', role: 'user' }), event(2, 'text', { text: 'Hi', role: 'assistant' })]);
    expect(timeline.map(item => item.data.text)).toEqual(['Hello', 'Hi']);
  });

  it('drops cursor-agent stream-error chunks instead of appending them to the answer', () => {
    const timeline = buildTimeline([
      event(1, 'text', { text: '你好，有什么需要帮忙的？' }),
      event(2, 'text', { text: '\n\nError: RetriableError: WritableIterable is closed' })
    ]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: 'text', data: { text: '你好，有什么需要帮忙的？' } });
  });

  it('extracts repeated agent warnings into one dedicated timeline notice', () => {
    const warning = 'Warning: Skill descriptions were shortened to fit the context budget.';
    const timeline = buildTimeline([
      event(1, 'text', { text: warning }),
      event(2, 'text', { text: warning }),
      event(3, 'text', { text: 'Ready', role: 'assistant' })
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ type: 'warning', data: { warningKind: 'skill', text: 'Skill descriptions were shortened to fit the context budget.' } });
    expect(timeline[1]).toMatchObject({ type: 'text', data: { text: 'Ready' } });
  });

  it('folds tool updates into one completed tool item', () => {
    const timeline = buildTimeline([event(1, 'tool_call', { id: 't1', name: 'Read', status: 'running', input: '.' }), event(2, 'tool_result', { id: 't1', status: 'completed', output: 'ok' })]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ type: 'tool_result', data: { name: 'Read', input: '.', output: 'ok', status: 'completed' } });
  });

  it('folds interleaved parallel tool updates by call id and retains the concrete name', () => {
    const timeline = buildTimeline([
      { ...event(1, 'tool_call', { id: 'a', name: 'Terminal', status: 'running', input: { command: 'pwd' } }), timestamp: '2026-01-01T00:00:01.000Z' },
      { ...event(2, 'tool_call', { id: 'b', name: 'Read', status: 'running', input: { path: 'README.md' } }), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...event(3, 'tool_result', { id: 'a', name: 'tool call', status: 'completed', output: '/repo' }), timestamp: '2026-01-01T00:00:04.000Z' },
      { ...event(4, 'tool_result', { id: 'b', name: 'tool call', status: 'failed', output: 'missing' }), timestamp: '2026-01-01T00:00:05.000Z' }
    ]);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ data: { id: 'a', name: 'Terminal', status: 'completed', startedAt: '2026-01-01T00:00:01.000Z', completedAt: '2026-01-01T00:00:04.000Z' } });
    expect(timeline[1]).toMatchObject({ data: { id: 'b', name: 'Read', status: 'failed', startedAt: '2026-01-01T00:00:02.000Z', completedAt: '2026-01-01T00:00:05.000Z' } });
  });

  it('uses the concrete command as the tool display name', () => {
    expect(toolDisplayName({ name: 'tool call', input: { command: '  pnpm   test\n--runInBand  ' } })).toBe('pnpm test --runInBand');
    expect(toolDisplayName({ name: 'Terminal', input: { cmd: ['git', 'status', '--short'] } })).toBe('git status --short');
    expect(toolDisplayName({ name: 'Read', input: { path: 'README.md' } })).toBe('Read');
  });

  it('restores historical user prompts from persisted tasks without duplicating new user events', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: 'historical prompt', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' }];
    expect(buildTimeline([], tasks)[0]).toMatchObject({ type: 'text', data: { role: 'user', text: 'historical prompt' } });
    const newEvent = { ...event(1, 'text', { text: 'historical prompt', role: 'user', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' };
    expect(buildTimeline([newEvent], tasks)).toHaveLength(1);
  });

  it('orders a task-restored prompt by timestamp even though its sequence is a placeholder', () => {
    // tasks 补出来的历史用户消息 sequence 固定为 -1，必须按 timestamp 插回中间。
    // 排序守卫若只看原始 events 是否有序就会漏掉这种情况，导致历史提问跑到最前面。
    const tasks = [{ id: 'task-2', sessionId: 's1', prompt: '第二个提问', status: 'completed', createdAt: '2026-01-01T00:00:05.000Z', updatedAt: '2026-01-01T00:00:06.000Z' }];
    const timeline = buildTimeline([
      { ...event(1, 'text', { text: '第一个提问', role: 'user', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:01.000Z' },
      { ...event(2, 'text', { text: '第一个回答' }), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...event(3, 'text', { text: '第二个回答' }), timestamp: '2026-01-01T00:00:09.000Z' }
    ], tasks);
    expect(timeline.map(item => item.data.text)).toEqual(['第一个提问', '第一个回答', '第二个提问', '第二个回答']);
  });

  it('preserves order for a large already-sorted stream that skips the sort', () => {
    // 有序时走线性检查跳过排序；这里确认跳过后的结果与排序一致。
    const events = Array.from({ length: 500 }, (_, index) =>
      ({ ...event(index + 1, 'tool_call', { id: `t${index}`, name: 'Bash', status: 'running' }), timestamp: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z` }));
    const timeline = buildTimeline(events, []);
    expect(timeline).toHaveLength(500);
    expect(timeline.every((item, index) => index === 0 || item.sequence > timeline[index - 1]!.sequence)).toBe(true);
  });

  it('keeps queued and cancelled prompts out of the conversation timeline', () => {
    const tasks = [
      { id: 'queued', sessionId: 's1', prompt: 'later', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'cancelled', sessionId: 's1', prompt: 'never', status: 'cancelled', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' }
    ];
    expect(buildTimeline([], tasks)).toEqual([]);
    expect(buildTimeline([event(1, 'task', { task: tasks[0] })], tasks)).toEqual([]);
  });

  it('shows a just-submitted prompt immediately and replaces it with the real task without duplicates', () => {
    const optimistic = { id: 'optimistic-1', prompt: '检查项目', createdAt: '2026-01-01T00:00:00.000Z', placement: 'timeline' as const };
    const queued = { id: 'task-1', sessionId: 's1', prompt: optimistic.prompt, status: 'queued', createdAt: optimistic.createdAt, updatedAt: optimistic.createdAt };
    expect(buildTimeline([], [], [optimistic])).toMatchObject([{ id: 'optimistic-1', data: { optimistic: true } }]);
    expect(buildTimeline([], [queued], [{ ...optimistic, taskId: queued.id }])).toMatchObject([{ id: 'optimistic-1', data: { optimistic: true } }]);
    expect(buildTimeline([], [{ ...queued, status: 'running' }], [{ ...optimistic, taskId: queued.id }])).toMatchObject([{ id: 'task-event-task-1', data: { text: '检查项目' } }]);
    expect(buildTimeline([], [{ ...queued, status: 'running' }], [{ ...optimistic, taskId: queued.id, settled: true }])).toMatchObject([{ id: 'task-event-task-1', data: { text: '检查项目' } }]);
    const realEvent = { ...event(1, 'text', { role: 'user', text: '检查项目', taskId: queued.id }), timestamp: optimistic.createdAt };
    expect(buildTimeline([realEvent], [{ ...queued, status: 'running' }], [optimistic])).toHaveLength(1);
    expect(buildTimeline([], [{ ...queued, status: 'cancelled' }], [{ ...optimistic, taskId: queued.id }])).toEqual([]);
  });

  it('never puts a prompt submitted into the queue panel on the timeline', () => {
    // 过去排队消息会先在时间线里冒一下：正在跑的那一轮被挤成「上一轮」整块折叠，响应回来再展开。
    const running = { id: 'task-1', sessionId: 's1', prompt: 'first', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const queued = { id: 'task-2', sessionId: 's1', prompt: 'second', status: 'queued', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const unsent = { id: 'optimistic-2', prompt: 'second', createdAt: queued.createdAt, placement: 'queue' as const };
    expect(buildTimeline([], [running], [unsent]).map(item => item.data.text)).toEqual(['first']);
    expect(buildTimeline([], [running, queued], [{ ...unsent, taskId: queued.id }]).map(item => item.data.text)).toEqual(['first']);
    const done = { ...running, status: 'completed' };
    expect(buildTimeline([], [done, queued], [{ ...unsent, taskId: queued.id }]).map(item => item.data.text)).toEqual(['first']);
  });

  it('keeps a prompt submitted to start right away on the timeline even if the session turns busy first', () => {
    // 打断发送 / 会话状态先到：它不该被挪进面板再挪回来。
    const running = { id: 'task-1', sessionId: 's1', prompt: 'first', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    const queued = { id: 'task-2', sessionId: 's1', prompt: 'second', status: 'queued', createdAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const optimistic = { id: 'optimistic-2', prompt: 'second', createdAt: queued.createdAt, placement: 'timeline' as const, taskId: queued.id };
    expect(buildTimeline([], [running, queued], [optimistic]).map(item => item.data.text)).toEqual(['first', 'second']);
  });

  it('never streams the previous turn\'s final answer while the next queued prompt is starting', () => {
    const user = { ...event(1, 'text', { role: 'user', text: 'first', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' };
    const thinking = { ...event(2, 'thinking', { text: 'hmm' }), timestamp: '2026-01-01T00:00:01.000Z' };
    const answer = { ...event(3, 'text', { role: 'assistant', text: 'done' }), timestamp: '2026-01-01T00:00:02.000Z' };
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: 'first', status: 'completed', createdAt: user.timestamp, updatedAt: answer.timestamp }];
    const sections = buildTimelineSections(buildTimeline([user, thinking, answer], tasks), tasks);
    const last = sections.at(-1)!;
    expect(last).toMatchObject({ kind: 'event', final: true });
    expect(isStreamingSection(last, true, true)).toBe(false);
  });

  it('keeps consecutive user turns separate while an optimistic message is visible', () => {
    const previous = { ...event(1, 'text', { role: 'user', text: 'first', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' };
    const optimistic = { id: 'optimistic-2', prompt: 'second', createdAt: '2026-01-01T00:00:01.000Z', placement: 'timeline' as const };
    expect(buildTimeline([previous], [], [optimistic]).map(item => item.data.text)).toEqual(['first', 'second']);
  });

  it('places each optimistic prompt where it was submitted, regardless of later session state', () => {
    const first = { id: 'local-1', prompt: 'first', createdAt: '2026-01-01T00:00:00.000Z', taskId: 'task-1', placement: 'timeline' as const };
    const second = { id: 'local-2', prompt: 'second', createdAt: '2026-01-01T00:00:01.000Z', taskId: 'task-2', placement: 'queue' as const };
    const tasks = [first, second].map(item => ({ id: item.taskId, sessionId: 's1', prompt: item.prompt, status: 'queued', createdAt: item.createdAt, updatedAt: item.createdAt }));
    expect(buildTimeline([], tasks, [first, second]).map(item => item.data.text)).toEqual(['first']);
  });

  it('groups chronological activity and keeps only the post-activity terminal text as final', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查一下', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查一下', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先看看文件' }),
      event(3, 'tool_call', { id: 't1', name: 'Read', status: 'running' }),
      event(4, 'tool_result', { id: 't1', name: 'Read', status: 'completed', output: 'ok' }),
      event(5, 'thinking', { text: '整理结果' }),
      event(6, 'text', { text: '已经检查完了', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.map(section => section.kind)).toEqual(['event', 'activity', 'event']);
    expect(sections[1]).toMatchObject({ kind: 'activity', hasAnswer: true, taskStatus: 'completed', isLatestTurn: true });
    expect(sections[2]).toMatchObject({ kind: 'event', final: true });
    if (sections[1].kind === 'activity') expect(sections[1].groups.map(group => group.events.map(item => item.type))).toEqual([['thinking', 'tool_result', 'thinking']]);
  });

  it('marks only the newest turn activity as current', () => {
    const tasks = [
      { id: 'task-1', sessionId: 's1', prompt: 'first', status: 'completed', createdAt: '', updatedAt: '' },
      { id: 'task-2', sessionId: 's1', prompt: 'next', status: 'running', createdAt: '', updatedAt: '' }
    ];
    const timeline = buildTimeline([
      event(1, 'text', { text: 'first', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: 'done thinking' }),
      event(3, 'text', { text: 'done', role: 'assistant' }),
      event(4, 'text', { text: 'next', role: 'user', taskId: 'task-2' }),
      event(5, 'tool_call', { id: 't2', name: 'Search', status: 'running' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).filter(section => section.kind === 'activity');
    expect(activity).toMatchObject([
      { hasAnswer: true, isLatestTurn: false },
      { hasAnswer: false, isLatestTurn: true }
    ]);
  });

  it('nests intermediate assistant descriptions with the following thinking and tools', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '协作', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '协作', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先检查群消息' }),
      event(3, 'text', { text: '我先查看群成员和最近消息', role: 'assistant' }),
      event(4, 'tool_result', { id: 'peers', name: 'group peers', status: 'completed', output: 'peer' }),
      event(5, 'thinking', { text: '对方还没回复' }),
      event(6, 'text', { text: '消息已发送，现在等待回复', role: 'assistant' }),
      event(7, 'tool_result', { id: 'wait', name: 'group wait', status: 'completed', output: 'pong' }),
      event(8, 'text', { text: '协作完成', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    const activity = sections.find(section => section.kind === 'activity');
    expect(sections.map(section => section.kind)).toEqual(['event', 'activity', 'event']);
    expect(activity?.groups.map(group => group.label)).toEqual(['我先查看群成员和最近消息', '消息已发送，现在等待回复']);
    expect(activity?.groups.map(group => group.events.map(item => item.type))).toEqual([
      ['thinking', 'text', 'tool_result'], ['thinking', 'text', 'tool_result']
    ]);
    expect(sections.at(-1)).toMatchObject({ kind: 'event', final: true, event: { data: { text: '协作完成' } } });
  });

  it('never promotes intermediate assistant text to final while the task is still running', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '继续', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '继续', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '先发消息', role: 'assistant' }),
      event(3, 'tool_result', { id: 'send', name: 'group send', status: 'completed' }),
      event(4, 'text', { text: '继续等待', role: 'assistant' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.some(section => section.kind === 'event' && section.final)).toBe(false);
    expect(sections.find(section => section.kind === 'activity')?.groups.map(group => group.label)).toEqual(['先发消息', '继续等待']);
  });

  it('收尾动作跑完之后用之前的文本收尾——Trae 答完再 group send 的形状', () => {
    // 老规则要求「最终输出必须在最后一次活动之后」，因此把这种轮次判成没有回答（标红 +
    // 未返回最终输出）。线上实测这是 Agent 的正常收尾顺序，答案是真实存在的。
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '先运行命令', role: 'assistant' }),
      event(3, 'tool_result', { id: 'pwd', name: 'pwd', status: 'completed', output: '/repo' })
    ]);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.find(section => section.kind === 'event' && section.final)).toMatchObject({ event: { data: { text: '先运行命令' } } });
    const activity: any = sections.find(section => section.kind === 'activity');
    expect(activity).toMatchObject({ hasAnswer: true, taskStatus: 'completed' });
    // 正文已经提升为最终输出，阶段里只剩收尾的那次工具调用。
    expect(activity.groups.map((group: any) => group.label)).toEqual(['pwd']);
  });

  it('上一轮起在后台的进程推送落在回答中间：不进时间线，也不把回答切成两段', () => {
    // runtime 给这类推送打 carriedOver。以前它按首次出现占位，回答被切成「现在的情况：」
    // 和后半句，最终输出只剩后半句，阶段里还多一条永远执行中的无标题 tool call。
    const tasks = [{ id: 'task-2', sessionId: 's1', prompt: '现在怎么处理噪声', status: 'completed', createdAt: '', updatedAt: '' }];
    const carried = (sequence: number) => event(sequence, 'tool_call', { id: 'bg-server', name: 'tool call', status: 'in_progress', carriedOver: true });
    const timeline = buildTimeline([
      event(1, 'text', { text: '现在怎么处理噪声', role: 'user', taskId: 'task-2' }),
      event(2, 'tool_result', { id: 'grep-1', name: 'rg', status: 'completed', output: '' }),
      event(3, 'text', { text: '现在的情况：', role: 'assistant' }),
      carried(4),
      event(5, 'text', { text: '只做到了不触发，', role: 'assistant' }),
      carried(6),
      event(7, 'text', { text: '还没做噪声处理。', role: 'assistant' }),
      carried(8)
    ]);
    expect(timeline.some(item => item.data.id === 'bg-server')).toBe(false);
    const sections = buildTimelineSections(timeline, tasks);
    expect(sections.find(section => section.kind === 'event' && section.final)).toMatchObject({ event: { data: { text: '现在的情况：只做到了不触发，还没做噪声处理。' } } });
    const activity: any = sections.find(section => section.kind === 'activity');
    expect(activity).toMatchObject({ hasAnswer: true, taskStatus: 'completed' });
    expect(activity.groups.flatMap((group: any) => group.events).map((item: any) => item.data.id)).toEqual(['grep-1']);
  });

  it('uses plain one-line text for activity labels instead of leaking Markdown syntax', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '确认 **AgentDock** 并读取 [说明](https://example.com)\n继续执行', role: 'assistant' }),
      event(3, 'tool_call', { id: 'read', name: 'Read', status: 'running' })
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      groups: [expect.objectContaining({ label: '确认 AgentDock 并读取 说明 继续执行' })]
    });
  });

  it('keeps the full text in labelTitle so hover is not the same clipped sentence', () => {
    const long = `开头${'内'.repeat(200)}结尾`;
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: `**${long}**`, role: 'assistant' }),
      event(3, 'tool_call', { id: 'read', name: 'Read', status: 'running' })
    ]);
    const group = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')?.groups[0];
    // 一行标题仍然截断，hover 给完整内容；两者都不能带 Markdown 记号。
    expect(group?.label).toHaveLength(100);
    expect(group?.label.endsWith('…')).toBe(true);
    expect(group?.labelTitle).toBe(long);
    expect(group?.labelTitle).not.toContain('**');
  });

  it('falls back to the same text for label and labelTitle when nothing is truncated', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '检查', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '检查', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '短标题', role: 'assistant' }),
      event(3, 'tool_call', { id: 'read', name: 'Read', status: 'running' })
    ]);
    const group = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')?.groups[0];
    expect(group?.label).toBe('短标题');
    expect(group?.labelTitle).toBe('短标题');
  });

  it('keeps the turn marked ongoing while a tool is still running after Agent text', () => {
    // Agent 调工具前总会先输出阶段描述。旧口径「用户消息后有 Agent 文本 = 已答复」
    // 会在这一刻把整轮标成已完成，于是外层显示「已完成」、里面的工具卡还在转「执行中」。
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '同步 master', status: 'running', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '同步 master', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: 'Fetch master and check divergence' }),
      event(3, 'tool_result', { id: 't1', name: 'Bash', status: 'completed', output: 'ok' }),
      event(4, 'text', { text: 'Flaky, 1-in-5. 先抓失败输出。' }),
      event(5, 'tool_call', { id: 't2', name: 'Bash', status: 'running' })
    ], tasks);
    const section = buildTimelineSections(timeline, tasks).find(item => item.kind === 'activity')!;
    expect(isTurnOngoing(section, true)).toBe(true);
    // 会话空闲时不该再显示执行中，否则中断后卡片会一直转。
    expect(isTurnOngoing(section, false)).toBe(false);
  });

  it('stops marking a turn ongoing once its task reaches a terminal status', () => {
    const base = [
      event(1, 'text', { text: '同步 master', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: '开始执行' }),
      event(3, 'tool_result', { id: 't1', name: 'Bash', status: 'completed', output: 'ok' }),
      event(4, 'text', { text: '完成了' })
    ];
    for (const status of ['completed', 'failed', 'interrupted', 'cancelled']) {
      const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '同步 master', status, createdAt: '', updatedAt: '' }];
      const section = buildTimelineSections(buildTimeline(base, tasks), tasks).find(item => item.kind === 'activity')!;
      expect(isTurnOngoing(section, true)).toBe(false);
    }
  });

  it('prefers the tool description over its command for an implicit stage label', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: 'pwd', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: 'pwd', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '先确认目录' }),
      event(3, 'tool_result', { id: 'pwd', name: 'Terminal', status: 'completed', input: { command: 'pwd', description: 'Show current working directory' }, output: '/repo' })
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      groups: [expect.objectContaining({ label: 'Show current working directory' })]
    });
  });

  it('preserves an interrupted task status when no final output exists', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '探索', status: 'interrupted', createdAt: '', updatedAt: '2026-01-01T00:01:07.000Z' }];
    const timeline = buildTimeline([
      { ...event(1, 'text', { text: '探索', role: 'user', taskId: 'task-1' }), timestamp: '2026-01-01T00:00:00.000Z' },
      { ...event(2, 'text', { text: '先检查源码', role: 'assistant' }), timestamp: '2026-01-01T00:00:01.000Z' },
      { ...event(3, 'tool_result', { id: 'search', name: 'find', status: 'completed' }), timestamp: '2026-01-01T00:00:02.000Z' },
      { ...event(4, 'thinking', { text: '继续查找实际仓库' }), timestamp: '2026-01-01T00:00:03.000Z' },
      { ...event(5, 'tool_call', { id: 'last', name: 'find / -name repo', status: 'running' }), timestamp: '2026-01-01T00:00:04.000Z' }
    ]);
    expect(buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity')).toMatchObject({
      hasAnswer: false,
      taskStatus: 'interrupted',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:07.000Z'
    });
  });

  it('does not promote tool-interrupted thinking fragments into separate stage titles', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '演示', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '演示', role: 'user', taskId: 'task-1' }),
      event(2, 'thinking', { text: '检查 Explore 子代理是否' }),
      event(3, 'tool_result', { id: 'check', name: '检查后台任务', status: 'completed' }),
      event(4, 'thinking', { text: '完成了，我应该继续等待。' }),
      event(5, 'tool_result', { id: 'wait', name: '等待通知', status: 'completed' }),
      event(6, 'thinking', { text: '，我再做一些操作。' }),
      event(7, 'tool_result', { id: 'next', name: '读取文件', status: 'completed' }),
      event(8, 'text', { text: '演示完成', role: 'assistant' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity');
    expect(activity?.groups).toHaveLength(1);
    expect(activity?.groups[0]).toMatchObject({ label: '检查后台任务' });
    expect(activity?.groups[0]?.events.map(item => item.type)).toEqual([
      'thinking', 'tool_result', 'thinking', 'tool_result', 'thinking', 'tool_result'
    ]);
  });

  it('keeps later thinking and tools in the most recent assistant-described stage', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '演示', status: 'completed', createdAt: '', updatedAt: '' }];
    const timeline = buildTimeline([
      event(1, 'text', { text: '演示', role: 'user', taskId: 'task-1' }),
      event(2, 'text', { text: 'Explore 子代理已启动，同时继续其他操作。', role: 'assistant' }),
      event(3, 'tool_result', { id: 'a', name: '任务 A', status: 'completed' }),
      event(4, 'thinking', { text: '继续等待子代理。' }),
      event(5, 'tool_result', { id: 'b', name: '任务 B', status: 'completed' }),
      event(6, 'thinking', { text: '再读取一个文件。' }),
      event(7, 'tool_result', { id: 'c', name: '任务 C', status: 'completed' }),
      event(8, 'text', { text: '全部完成', role: 'assistant' })
    ]);
    const activity = buildTimelineSections(timeline, tasks).find(section => section.kind === 'activity');
    expect(activity?.groups).toHaveLength(1);
    expect(activity?.groups[0]).toMatchObject({ label: 'Explore 子代理已启动，同时继续其他操作。' });
    expect(activity?.groups[0]?.events).toHaveLength(6);
  });
});

describe('turn identity stability (闪屏修复)', () => {
  it('assistantDescription 中间插入导致重切组时 turnId 保持不变', () => {
    const tasks = [{ id: 'task-1', sessionId: 's1', prompt: '协作', status: 'running', createdAt: '', updatedAt: '' }];
    const before = buildTimelineSections(buildTimeline([
      { ...event(1, 'text', { text: '协作', role: 'user', taskId: 'task-1' }), id: 'u1' },
      event(2, 'thinking', { text: '先检查' }),
      event(3, 'tool_result', { id: 'peers', name: 'group peers', status: 'completed', output: 'peer' })
    ]), tasks).find(section => section.kind === 'activity');
    const after = buildTimelineSections(buildTimeline([
      { ...event(1, 'text', { text: '协作', role: 'user', taskId: 'task-1' }), id: 'u1' },
      event(2, 'thinking', { text: '先检查' }),
      event(3, 'tool_result', { id: 'peers', name: 'group peers', status: 'completed', output: 'peer' }),
      event(4, 'text', { text: '我先查看', role: 'assistant' }),
      event(5, 'tool_result', { id: 'wait', name: 'group wait', status: 'running' }),
      event(6, 'thinking', { text: '等待' })
    ]), tasks).find(section => section.kind === 'activity');
    expect(before?.kind).toBe('activity');
    expect(after?.kind).toBe('activity');
    if (before?.kind === 'activity' && after?.kind === 'activity') {
      expect(before.turnId).toBe(after.turnId);
      // 有 taskId 时用任务身份，乐观气泡换成服务端事件后也不会重挂整轮。
      expect(after.turnId).toBe('turn-task-1');
      // 中间 assistant text 重切了组：组结构不同，但 turn 身份稳定，React 不重挂
      expect(before.groups.length).toBe(1);
      expect(after.groups.length).toBe(2);
    }
  });
});

describe('buildActivitySteps', () => {
  const ev = (id: string, type: string, data: Record<string, unknown> = {}): TimelineEvent => ({ id, sequence: 1, type, timestamp: '2026-01-01T00:00:00.000Z', data } as TimelineEvent);
  const group = (events: TimelineEvent[]) => ({ id: 'g', label: '', labelTitle: '', events, startedAt: '2026-01-01T00:00:00.000Z' });

  it('keeps thinking, agent text and tool calls in output order and merges consecutive tool calls', () => {
    const steps = buildActivitySteps([group([
      ev('t1', 'thinking', { text: '想' }),
      ev('a1', 'text', { role: 'assistant', text: '先看看' }),
      ev('c1', 'tool_call', { id: 'c1' }), ev('c2', 'tool_call', { id: 'c2' }),
      ev('t2', 'thinking', { text: '再想' }),
      ev('c3', 'tool_call', { id: 'c3' })
    ])]);
    expect(steps.map(step => step.kind)).toEqual(['thinking', 'text', 'tools', 'thinking', 'tools']);
    expect(steps[2]!.kind === 'tools' && steps[2]!.events).toHaveLength(2);
  });
});

describe('thinkingTitle', () => {
  it('uses the bold / heading line the agent gave the thought, latest while live and first once settled', () => {
    const text = '**检查仓库结构**\n\n先看目录。\n\n**定位报错**\n\n再看日志。';
    expect(thinkingTitle(text, true)).toBe('定位报错');
    expect(thinkingTitle(text, false)).toBe('检查仓库结构');
    expect(thinkingTitle('## 规划方案\n内容', false)).toBe('规划方案');
  });
  it('falls back to the first prose line when the agent gave no markdown heading', () => {
    // Codex 的推理没有标题行，只有普通段落：折叠行要能显示第一句，而不是只剩「已思考」。
    expect(thinkingTitle('\n\nThe user says "巡检" — inspect traffic.\nSecond line.', false)).toBe('The user says "巡检" — inspect traffic.');
    expect(thinkingTitle('这是一段**没有标题**的普通思考。', true)).toBe('这是一段没有标题的普通思考。');
    expect(thinkingTitle('   \n\t\n', false)).toBeUndefined();
    expect(thinkingTitle('', true)).toBeUndefined();
    expect(thinkingTitle('**\n__\n#', false)).toBeUndefined();
  });
});

describe('timeline incremental cache', () => {
  const at = (sequence: number, type: string, data: Record<string, unknown>) => ({
    id: `e${sequence}`, sequence, type,
    timestamp: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    data
  });
  const user = (sequence: number, text: string, taskId = `task-${sequence}`) => at(sequence, 'text', { text, role: 'user', taskId });
  // 克隆首事件即可绕开增量缓存，得到一份独立的全量构建结果用于对比。
  const full = (events: any[], tasks: any[] = [], optimistic: any[] = []) =>
    buildTimeline(events.map((item, index) => index === 0 ? { ...item, data: { ...item.data } } : item), tasks, optimistic);

  it('appending a turn only rebuilds the tail and matches a full rebuild', () => {
    const first = [user(1, '第一轮'), at(2, 'text', { text: '回答一' }), user(3, '第二轮')];
    const before = buildTimeline(first);
    const next = first.concat([at(4, 'text', { text: '回答' }), at(5, 'text', { text: '二' })]);
    const after = buildTimeline(next);
    expect(after).toEqual(full(next));
    expect(after).not.toBe(before);
    expect(buildTimeline(next)).toBe(after);
  });

  it('folds a tool result appended after a cached tool call', () => {
    const first = [user(1, '跑命令'), at(2, 'tool_call', { id: 't1', name: 'Terminal', status: 'running', input: { command: 'pwd' } })];
    buildTimeline(first);
    const next = first.concat([at(3, 'tool_result', { id: 't1', name: 'tool call', status: 'completed', output: '/repo' })]);
    const after = buildTimeline(next);
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ type: 'tool_result', data: { id: 't1', name: 'Terminal', status: 'completed', output: '/repo' } });
    expect(after).toEqual(full(next));
  });

  it('caches render signatures per event object without going stale across rebuilds', () => {
    const before = buildTimeline([user(1, '一'), at(2, 'text', { text: '答一' })]);
    const firstSignature = eventRenderSignature(before[1]!);
    expect(eventRenderSignature(before[1]!)).toBe(firstSignature);
    // 增量重建会为变化的那一轮创建新对象，缓存不能把旧签名带过去。
    const changed = buildTimeline([user(1, '一'), at(2, 'text', { text: '答一（改）' })]);
    expect(changed[1]).not.toBe(before[1]);
    expect(eventRenderSignature(changed[1]!)).not.toBe(firstSignature);
  });

  it('rebuilds from the changed turn when a later batch updates an older turn', () => {
    const turn1 = [user(1, '一'), at(2, 'text', { text: '答一' })];
    const turn2 = [user(3, '二'), at(4, 'text', { text: '答二' })];
    buildTimeline([...turn1, ...turn2]);
    const changed = [turn1[0]!, at(2, 'text', { text: '答一（改）' }), ...turn2];
    expect(buildTimeline(changed)).toEqual(full(changed));
  });

  it('keeps consecutive same-task user messages merged across batches', () => {
    const first = [user(1, '第一句', 'task-x'), user(2, '第二句', 'task-x')];
    buildTimeline(first);
    const next = first.concat([user(3, '第三句', 'task-x')]);
    const after = buildTimeline(next);
    expect(after).toHaveLength(1);
    expect(after[0]!.data.text).toBe('第一句第二句第三句');
    expect(after).toEqual(full(next));
  });

  it('dedupes warnings across an incremental batch', () => {
    const warning = 'Warning: Skill descriptions were shortened to fit the context budget.';
    const first = [user(1, '一'), at(2, 'text', { text: warning })];
    buildTimeline(first);
    const next = first.concat([user(3, '二'), at(4, 'text', { text: warning }), at(5, 'text', { text: '继续' })]);
    const after = buildTimeline(next);
    expect(after.filter(item => item.type === 'warning')).toHaveLength(1);
    expect(after).toEqual(full(next));
  });

  it('falls back to a full rebuild when tasks change', () => {
    const events = [user(1, '一'), at(2, 'text', { text: '答' })];
    buildTimeline(events, []);
    const tasks = [{ id: 'task-9', sessionId: 's', prompt: '历史', status: 'completed', createdAt: '2026-01-01T00:00:00.500Z', updatedAt: '' }];
    expect(buildTimeline(events, tasks)).toEqual(full(events, tasks));
  });
});

describe('send time on terminal segments', () => {
  const turn = (status: string) => {
    const prompt = { ...event(1, 'text', { role: 'user', text: '问题', taskId: 'task-1' }), timestamp: '2026-11-12T13:50:06.000Z' };
    const thinking = { ...event(2, 'thinking', { text: '想一下' }), timestamp: '2026-11-12T13:50:07.000Z' };
    const answer = { ...event(3, 'text', { role: 'assistant', text: '答案' }), timestamp: '2026-11-12T13:50:10.000Z' };
    const tasks = [{ id: 'task-1', sessionId: 's', prompt: '问题', status, createdAt: '2026-11-12T13:50:05.120Z', updatedAt: '2026-11-12T13:50:10.500Z' }];
    return buildTimelineSections(buildTimeline([prompt, thinking, answer], tasks), tasks);
  };

  it('groups every segment of a finished turn into one timestamped turn', () => {
    const sections = turn('completed');
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every(section => section.terminal)).toBe(true);
    expect(sections.map(section => section.sentAt)).toEqual(sections.map(() => '2026-11-12T13:50:05.120Z'));
    expect(sections.map(section => section.completedAt)).toEqual(sections.map(() => '2026-11-12T13:50:10.500Z'));
    const turns = groupTimelineSections(sections);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.sections).toHaveLength(sections.length);
    // 发送时间交给用户气泡常驻展示；轮末只保留完成时间，避免同一轮出现两个发送角标。
    expect(turnTimeBadge(turns[0]!)).toEqual({ timestamp: '2026-11-12T13:50:10.500Z', align: 'left', kind: '完成' });
  });

  it('shows nothing while the turn is still running', () => {
    const sections = turn('running');
    expect(sections.every(section => section.terminal)).toBe(false);
    expect(sections.every(section => section.sentAt === undefined)).toBe(true);
    expect(turnTimeBadge(groupTimelineSections(sections)[0]!)).toBeUndefined();
  });

  it('keeps consecutive turns separate', () => {
    const first = { ...event(1, 'text', { role: 'user', text: '第一轮' }), timestamp: '2026-11-12T13:50:06.000Z' };
    const answer = { ...event(2, 'text', { role: 'assistant', text: '答' }), timestamp: '2026-11-12T13:50:08.000Z' };
    const next = { ...event(3, 'text', { role: 'user', text: '第二轮' }), timestamp: '2026-11-12T13:51:00.000Z' };
    const turns = groupTimelineSections(buildTimelineSections(buildTimeline([first, answer, next]), []));
    expect(turns).toHaveLength(2);
    expect(turns.map(turn => turn.sections.length)).toEqual([2, 1]);
  });

  it('treats failed and interrupted turns as terminal', () => {
    for (const status of ['failed', 'interrupted']) expect(turn(status).every(section => section.terminal)).toBe(true);
  });

  it('falls back to the last event time for legacy turns without task records', () => {
    const first = { ...event(1, 'text', { role: 'user', text: '第一轮' }), timestamp: '2026-11-12T13:50:06.000Z' };
    const answer = { ...event(2, 'text', { role: 'assistant', text: '答' }), timestamp: '2026-11-12T13:50:08.000Z' };
    const next = { ...event(3, 'text', { role: 'user', text: '第二轮' }), timestamp: '2026-11-12T13:51:00.000Z' };
    const sections = buildTimelineSections(buildTimeline([first, answer, next]), []);
    const turns = groupTimelineSections(sections);
    expect(turns[0]!.sentAt).toBe('2026-11-12T13:50:06.000Z');
    expect(turnTimeBadge(turns[0]!)).toEqual({ timestamp: '2026-11-12T13:50:08.000Z', align: 'left', kind: '完成' });
    // 最后一行（还在跑的那一轮）没有发送时间。
    expect(turnTimeBadge(turns.at(-1)!)).toBeUndefined();
  });

  it('leaves the turn-end badge to the user bubble when the turn has no answer', () => {
    const first = { ...event(1, 'text', { role: 'user', text: '第一轮' }), timestamp: '2026-11-12T13:50:06.000Z' };
    const next = { ...event(2, 'text', { role: 'user', text: '第二轮' }), timestamp: '2026-11-12T13:51:00.000Z' };
    const turns = groupTimelineSections(buildTimelineSections(buildTimeline([first, next]), []));
    expect(turns[0]!.sections).toHaveLength(1);
    expect(turnTimeBadge(turns[0]!)).toBeUndefined();
  });
});

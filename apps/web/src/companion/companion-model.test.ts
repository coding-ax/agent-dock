import { describe, expect, it } from 'vitest';
import type { AssistantTask } from '../api';
import {
  companionBubble, companionStatus, countNotes, deriveMood, diffTasks, greeting, groupNotes,
  noteTilt, noteTone, parseSupervisionDetail, pickKittenName, sinceLabel, snapshotTasks,
  supervisionChipTone, supervisionKindLabel, supervisionKindTone, tapeTilt, KITTEN_NAMES
} from './companion-model';

const task = (patch: Partial<AssistantTask> & { id: string }): AssistantTask => ({
  title: patch.id, notes: '', doneWhen: ['给出证据'], state: 'running', round: 0, plan: false,
  createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z', ...patch
});

describe('diffTasks', () => {
  it('only builds a baseline on the first poll', () => {
    expect(diffTasks(undefined, [task({ id: 'a' })])).toEqual([]);
  });

  it('announces new notes in creation order and skips ones that arrive already closed', () => {
    const before = snapshotTasks([]);
    const events = diffTasks(before, [
      task({ id: 'b', createdAt: '2026-11-11T10:02:00.000Z' }),
      task({ id: 'a', createdAt: '2026-11-11T10:01:00.000Z', plan: true, state: 'review' }),
      task({ id: 'old', state: 'closed', outcome: 'accepted' })
    ]);
    expect(events.map(event => [event.kind, event.task.id])).toEqual([['planned', 'a'], ['dispatched', 'b']]);
  });

  it('maps state transitions to reactions', () => {
    const before = snapshotTasks([
      task({ id: 'review' }),
      task({ id: 'needs', state: 'review' }),
      task({ id: 'accepted', state: 'review' }),
      task({ id: 'cancelled' }),
      task({ id: 'rework', state: 'review' }),
      task({ id: 'started', state: 'review', plan: true }),
      task({ id: 'round' }),
      task({ id: 'same' })
    ]);
    const events = diffTasks(before, [
      task({ id: 'review', state: 'review' }),
      task({ id: 'needs', state: 'needs_user' }),
      task({ id: 'accepted', state: 'closed', outcome: 'accepted' }),
      task({ id: 'cancelled', state: 'closed', outcome: 'cancelled' }),
      task({ id: 'rework', state: 'running', round: 1 }),
      task({ id: 'started', state: 'running', plan: false }),
      task({ id: 'round', round: 1 }),
      task({ id: 'same' })
    ]);
    expect(Object.fromEntries(events.map(event => [event.task.id, event.kind]))).toEqual({
      review: 'review', needs: 'needs_user', accepted: 'accepted', cancelled: 'cancelled',
      rework: 'rework', started: 'started', round: 'rework'
    });
  });

  it('turns events into short bubble lines', () => {
    expect(companionBubble({ kind: 'dispatched', task: task({ id: 'x', title: '梳理仓库' }) })).toEqual({ text: '派出一张便签：梳理仓库', tone: 'info' });
    expect(companionBubble({ kind: 'needs_user', task: task({ id: 'x', title: '发版' }) }).tone).toBe('alert');
    expect(companionBubble({ kind: 'accepted', task: task({ id: 'x', title: '修 CI' }) }).tone).toBe('success');
  });
});

describe('notes', () => {
  const tasks = [
    task({ id: 'run', updatedAt: '2026-11-11T10:05:00.000Z' }),
    task({ id: 'run2', updatedAt: '2026-11-11T10:09:00.000Z' }),
    task({ id: 'rev', state: 'review' }),
    task({ id: 'plan', state: 'review', plan: true }),
    task({ id: 'need', state: 'needs_user' }),
    task({ id: 'done', state: 'closed', outcome: 'accepted', closedAt: '2026-11-11T11:00:00.000Z' }),
    task({ id: 'gone', state: 'closed', outcome: 'cancelled', closedAt: '2026-11-11T12:00:00.000Z' })
  ];

  it('counts what needs attention without treating plans as reviews', () => {
    expect(countNotes(tasks)).toEqual({ running: 2, review: 1, planned: 1, needsUser: 1, closed: 2, open: 5, attention: 2 });
  });

  it('groups by urgency and keeps the most recent first', () => {
    const sections = groupNotes(tasks);
    expect(sections.map(section => section.key)).toEqual(['needs_user', 'planned', 'review', 'running', 'closed']);
    expect(sections.find(section => section.key === 'review')!.tasks.map(item => item.id)).toEqual(['rev']);
    expect(sections.find(section => section.key === 'planned')!.tasks.map(item => item.id)).toEqual(['plan']);
    expect(sections.find(section => section.key === 'running')!.tasks.map(item => item.id)).toEqual(['run2', 'run']);
    expect(sections.find(section => section.key === 'closed')!.tasks.map(item => item.id)).toEqual(['gone', 'done']);
    expect(groupNotes([], 'review')).toEqual([{ key: 'review', label: '待验收', tasks: [] }]);
    expect(groupNotes([])).toEqual([]);
  });

  it('shows plans together with needs-me, without red-hot counting', () => {
    expect(groupNotes(tasks, 'needs_user').map(section => [section.key, section.label, section.tasks.map(item => item.id)]))
      .toEqual([['needs_user', '需要你', ['need']], ['planned', '等你点头', ['plan']]]);
    expect(groupNotes([task({ id: 'plan', state: 'review', plan: true })], 'needs_user').map(section => section.key)).toEqual(['planned']);
    expect(groupNotes([], 'needs_user')).toEqual([]);
  });

  it('picks paper tones', () => {
    expect(tasks.map(noteTone)).toEqual(['running', 'running', 'review', 'plan', 'needs', 'done', 'cancelled']);
  });

  it('tilts every note the same way on every render, within a gentle range', () => {
    for (const id of ['a', 'atask_1', 'atask_c0ffee', 'long-id-with-many-characters']) {
      expect(noteTilt(id)).toBe(noteTilt(id));
      expect(Math.abs(noteTilt(id))).toBeLessThanOrEqual(1.6);
      expect(Math.abs(tapeTilt(id))).toBeLessThanOrEqual(5);
    }
  });
});

describe('mood and status', () => {
  const base = { tasks: [] as AssistantTask[], lastActiveAt: 0, now: 1_000 };

  it('reacts to the main session and its notes', () => {
    expect(deriveMood({ ...base })).toBe('curious');
    expect(deriveMood({ ...base, mainState: 'thinking' })).toBe('busy');
    expect(deriveMood({ ...base, mainState: 'waiting_for_permission' })).toBe('alert');
    expect(deriveMood({ ...base, mainState: 'idle', tasks: [task({ id: 'n', state: 'needs_user' })] })).toBe('alert');
    // 计划卡只是等你点头，不该让小猫紧张。
    expect(deriveMood({ ...base, mainState: 'idle', tasks: [task({ id: 'p', state: 'review', plan: true })] })).toBe('idle');
    expect(deriveMood({ ...base, mainState: 'idle', recent: { kind: 'accepted', at: 500 } })).toBe('happy');
    expect(deriveMood({ ...base, mainState: 'idle', recent: { kind: 'accepted', at: -10_000 } })).toBe('idle');
    expect(deriveMood({ ...base, mainState: 'idle', recent: { kind: 'cheer', at: 500 } })).toBe('happy');
    expect(deriveMood({ ...base, mainState: 'failed' })).toBe('sad');
    expect(deriveMood({ ...base, mainState: 'idle', now: 10 * 60_000 })).toBe('sleepy');
    expect(deriveMood({ ...base, mainState: 'idle', now: 10 * 60_000, tasks: [task({ id: 'r' })] })).toBe('idle');
  });

  it('describes what the kitten is doing', () => {
    const counts = countNotes([task({ id: 'r' }), task({ id: 'v', state: 'review' })]);
    expect(companionStatus({ mainState: 'thinking', counts, mood: 'busy' })).toBe('正在思考…');
    expect(companionStatus({ mainState: 'idle', counts, mood: 'idle' })).toBe('1 张便签待验收');
    expect(companionStatus({ mainState: 'idle', counts: countNotes([task({ id: 'r' })]), mood: 'idle' })).toBe('在盯着 1 张便签');
    expect(companionStatus({ mainState: 'idle', counts: countNotes([task({ id: 'n', state: 'needs_user' })]), mood: 'alert' })).toBe('1 件事等你拍板');
    expect(companionStatus({ mainState: 'idle', counts: countNotes([task({ id: 'p', state: 'review', plan: true })]), mood: 'idle' })).toBe('1 张计划等你点头');
    expect(companionStatus({ mainState: 'idle', counts: countNotes([]), mood: 'sleepy' })).toBe('打盹中');
    expect(companionStatus({ counts: countNotes([]), mood: 'curious' })).toBe('等你来认领');
    // 刚认领、刚改名的开心不是验收通过。
    expect(companionStatus({ mainState: 'idle', counts: countNotes([]), mood: 'happy', recent: 'cheer' })).toBe('开心地摇尾巴');
    expect(companionStatus({ mainState: 'idle', counts: countNotes([]), mood: 'happy', recent: 'accepted' })).toBe('验收通过啦');
  });

  it('greets by local hour', () => {
    expect(greeting(new Date(2026, 10, 11, 3))).toBe('夜深了');
    expect(greeting(new Date(2026, 10, 11, 9))).toBe('早上好');
    expect(greeting(new Date(2026, 10, 11, 12))).toBe('中午好');
    expect(greeting(new Date(2026, 10, 11, 15))).toBe('下午好');
    expect(greeting(new Date(2026, 10, 11, 21))).toBe('晚上好');
  });
});

describe('helpers', () => {
  it('never re-rolls the same name', () => {
    for (let index = 0; index < 20; index++) {
      const next = pickKittenName('小A同学', () => index / 20);
      expect(next).not.toBe('小A同学');
      expect(KITTEN_NAMES).toContain(next);
    }
  });

  it('formats elapsed time', () => {
    const now = Date.parse('2026-11-11T10:00:00.000Z');
    expect(sinceLabel('2026-11-11T09:59:40.000Z', now)).toBe('刚刚');
    expect(sinceLabel('2026-11-11T09:48:00.000Z', now)).toBe('12 分钟前');
    expect(sinceLabel('2026-11-11T07:00:00.000Z', now)).toBe('3 小时前');
    expect(sinceLabel('2026-11-09T10:00:00.000Z', now)).toBe('2 天前');
    expect(sinceLabel(undefined, now)).toBe('');
  });

  it('parses supervision signals back into note chips', () => {
    const detail = [
      '以下是 daemon 汇总的督办信号。先看是否需要你处理；需要用户拍板时用 agent-dock notify --ask。',
      '',
      '- [review] 梳理仓库现状：侧边会话这一轮结束，等待验收（atask_abc-1）',
      '- [needs_you] watch：文件出现：条件满足：ok',
      '- [failed] 修 CI：侧边会话失败：boom（atask_def）',
      '- [interrupted] 发布 v0.3.2：侧边会话被主动打断，等待你决定返工/取消/验收（atask_ghi）'
    ].join('\n');
    expect(parseSupervisionDetail(detail)).toEqual([
      { kind: 'review', title: '梳理仓库现状', detail: '侧边会话这一轮结束，等待验收', taskId: 'atask_abc-1' },
      { kind: 'needs_you', title: 'watch', detail: '文件出现：条件满足：ok' },
      { kind: 'failed', title: '修 CI', detail: '侧边会话失败：boom', taskId: 'atask_def' },
      { kind: 'interrupted', title: '发布 v0.3.2', detail: '侧边会话被主动打断，等待你决定返工/取消/验收', taskId: 'atask_ghi' }
    ]);
  });

  it('shows interrupted supervision as a neutral amber chip, never the failed tone', () => {
    expect(supervisionKindLabel.interrupted).toBe('已打断');
    expect(supervisionKindTone.interrupted).toBe('interrupted');
    expect(supervisionKindTone.interrupted).not.toBe(supervisionKindTone.failed);
    // 被打断的事项在服务端仍是 needs_user；任务纸色不能覆盖信号本身的语义。
    expect(supervisionChipTone('interrupted', 'needs')).toBe('interrupted');
    expect(supervisionChipTone('failed', 'needs')).toBe('needs');
  });
});

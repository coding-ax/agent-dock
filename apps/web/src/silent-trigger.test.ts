import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from './timeline';
import {
  addSilentTriggerKey,
  buildSilentPrompt,
  normalizeSilentEmoji,
  removeSilentTriggerKey,
  silentTriggerKey,
  silentTriggerTargets
} from './silent-trigger';

let sequence = 0;

function textEvent(id: string, role: 'user' | 'assistant', text: string, timestamp: string, taskId?: string): TimelineEvent {
  return {
    id,
    sequence: ++sequence,
    type: 'text',
    timestamp,
    data: { role, text, ...(taskId ? { taskId } : {}) }
  };
}

describe('normalizeSilentEmoji', () => {
  it('accepts one emoji, including ZWJ and skin-tone sequences', () => {
    expect(normalizeSilentEmoji('🐱')).toBe('🐱');
    expect(normalizeSilentEmoji('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
    expect(normalizeSilentEmoji('👍🏽')).toBe('👍🏽');
    expect(normalizeSilentEmoji('❤️')).toBe('❤️');
  });

  it('treats blank as off and rejects text or multiple emoji', () => {
    expect(normalizeSilentEmoji('')).toBe('');
    expect(normalizeSilentEmoji('   ')).toBe('');
    expect(normalizeSilentEmoji(null)).toBe('');
    expect(normalizeSilentEmoji('喵')).toBeUndefined();
    expect(normalizeSilentEmoji('🐱🐶')).toBeUndefined();
    expect(normalizeSilentEmoji('🐱 hi')).toBeUndefined();
  });
});

describe('silentTriggerTargets', () => {
  it('goes straight to the current session without a main session', () => {
    expect(silentTriggerTargets(false)).toEqual(['here']);
  });

  it('offers main / new tab / current session when a kitten exists', () => {
    expect(silentTriggerTargets(true)).toEqual(['main', 'tab', 'here']);
  });
});

describe('silentTriggerKey', () => {
  it('uses taskId + role for user rows so task-event and real event share one key', () => {
    const temporary = textEvent('task-event-task_1', 'user', 'hi', '2026-01-01T00:00:00.000Z', 'task_1');
    const real = textEvent('evt_1', 'user', 'hi', '2026-01-01T00:00:01.000Z', 'task_1');
    expect(silentTriggerKey({ sessionId: 'ses_1', event: temporary, emoji: '🐱' }))
      .toBe(silentTriggerKey({ sessionId: 'ses_1', event: real, emoji: '🐱' }));
  });

  it('keeps assistant messages distinct by event id', () => {
    const first = textEvent('evt_1', 'assistant', 'a', '2026-01-01T00:00:00.000Z', 'task_1');
    const second = textEvent('evt_2', 'assistant', 'b', '2026-01-01T00:00:01.000Z', 'task_1');
    expect(silentTriggerKey({ sessionId: 'ses_1', event: first, emoji: '🐱' }))
      .not.toBe(silentTriggerKey({ sessionId: 'ses_1', event: second, emoji: '🐱' }));
  });
});

describe('silent trigger ledger', () => {
  it('claims the same message + emoji only once across repeated renders', () => {
    const key = 'ses_1\u0000event:evt_1:assistant\u0000🐱';
    const first = addSilentTriggerKey(null, key);
    expect(first.added).toBe(true);
    const second = addSilentTriggerKey(first.value, key);
    expect(second.added).toBe(false);
    expect(second.value).toBe(first.value);
  });

  it('trims old entries but keeps the newest claim', () => {
    let raw: string | null = null;
    for (let index = 0; index < 5; index++) raw = addSilentTriggerKey(raw, `key-${index}`, 3).value;
    const keys = JSON.parse(raw!);
    expect(keys).toEqual(['key-2', 'key-3', 'key-4']);
  });

  it('ignores corrupt storage values', () => {
    const next = addSilentTriggerKey('not json', 'key-1');
    expect(next.added).toBe(true);
    expect(JSON.parse(next.value)).toEqual(['key-1']);
  });

  it('rolls back a failed send so the same message + emoji can be retried', () => {
    const key = 'ses_1\u0000event:evt_1:assistant\u0000🐱';
    const first = addSilentTriggerKey(null, key);
    const released = removeSilentTriggerKey(first.value, key);
    expect(released.removed).toBe(true);
    expect(JSON.parse(released.value)).toEqual([]);
    expect(addSilentTriggerKey(released.value, key).added).toBe(true);
  });
});

describe('buildSilentPrompt', () => {
  const timeline: TimelineEvent[] = [
    textEvent('evt_0', 'user', '把登录页的报错修掉', '2026-01-01T10:00:00.000Z', 'task_1'),
    {
      id: 'evt_tool',
      sequence: ++sequence,
      type: 'tool_call',
      timestamp: '2026-01-01T10:00:02.000Z',
      data: { name: 'terminal', input: { command: 'pnpm test login' }, status: 'completed' }
    },
    textEvent('evt_1', 'assistant', '报错来自空 token 没有兜底，我改一下。', '2026-01-01T10:00:03.000Z', 'task_1'),
    textEvent('evt_2', 'user', '顺手补个测试', '2026-01-01T10:00:04.000Z', 'task_2'),
    textEvent('evt_3', 'assistant', '测试已补，等待你确认。', '2026-01-01T10:00:05.000Z', 'task_2')
  ];

  it('includes the target and surrounding context with roles, time and tool summary', () => {
    const prompt = buildSilentPrompt(timeline, timeline[2]!, '🐱', 1);
    expect(prompt).toContain('「🐱」');
    expect(prompt).toContain('→ [目标消息] [Agent · 2026-01-01 10:00:03]');
    expect(prompt).toContain('报错来自空 token 没有兜底');
    expect(prompt).toContain('[工具 · 2026-01-01 10:00:02] pnpm test login（completed）');
    expect(prompt).toContain('[用户 · 2026-01-01 10:00:04] 顺手补个测试');
    expect(prompt).not.toContain('把登录页的报错修掉');
  });

  it('drops invisible injected/emoji context but never drops the target', () => {
    const injected: TimelineEvent = {
      id: 'evt_injected',
      sequence: ++sequence,
      type: 'text',
      timestamp: '2026-01-01T10:00:01.000Z',
      data: { role: 'user', text: '督办信号', origin: 'injected' }
    };
    const emojiRow: TimelineEvent = {
      id: 'evt_emoji',
      sequence: ++sequence,
      type: 'text',
      timestamp: '2026-01-01T10:00:02.500Z',
      data: { role: 'user', text: '上一轮静默 prompt', origin: 'emoji' }
    };
    const target = textEvent('evt_target', 'assistant', '目标回复', '2026-01-01T10:00:03.000Z');
    const prompt = buildSilentPrompt([injected, emojiRow, target], target, '🐱', 4);
    expect(prompt).not.toContain('督办信号');
    expect(prompt).not.toContain('上一轮静默 prompt');
    expect(prompt).toContain('→ [目标消息] [Agent · 2026-01-01 10:00:03] 目标回复');
  });

  it('marks a target that is missing from the timeline', () => {
    const target = textEvent('evt_orphan', 'assistant', '孤立消息', '2026-01-01T10:00:00.000Z');
    expect(buildSilentPrompt([], target, '🐱')).toContain('→ [目标消息] [Agent · 2026-01-01 10:00:00] 孤立消息');
  });
});

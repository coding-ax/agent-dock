import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { resolveActiveSteeringTaskId } from './composer-utils';
import { buildTimeline, eventRenderSignature, type OptimisticMessage, type QueuedTask } from './timeline';

// ComposerEditor 依赖浏览器 DOM / Milkdown，SSR 渲染测试中用轻量占位替代。
vi.mock('./ComposerEditor', () => ({
  ComposerEditor: () => createElement('div', { 'data-testid': 'composer-editor-mock' })
}));

import { Composer, QueuedTasks } from './Composer';
import { TimelineItem } from './TimelineItems';

const noop = () => undefined;

const queued = (id: string, prompt: string): QueuedTask => ({
  id,
  sessionId: 'ses_1',
  prompt,
  status: 'queued',
  createdAt: '2026-01-01T00:00:01.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z'
});

describe('resolveActiveSteeringTaskId', () => {
  const tasks = [queued('t1', '第一条'), queued('t2', '第二条')];

  it('prefers the in-flight steering task id while mutation is pending', () => {
    expect(resolveActiveSteeringTaskId('t1', undefined, tasks)).toBe('t1');
    expect(resolveActiveSteeringTaskId('t1', 't2', tasks)).toBe('t1');
  });

  it('holds the transition state across the brief window until the task leaves the queue', () => {
    expect(resolveActiveSteeringTaskId(undefined, 't1', tasks)).toBe('t1');
    expect(resolveActiveSteeringTaskId(undefined, 't1', [queued('t2', '第二条')])).toBeUndefined();
  });

  it('clears immediately on failure rollback when heldTaskId is reset', () => {
    expect(resolveActiveSteeringTaskId(undefined, undefined, tasks)).toBeUndefined();
  });
});

describe('QueuedTasks immediate-send transition UI', () => {
  const tasks = [queued('t1', '帮我优先修这个 bug'), queued('t2', '顺便看下日志')];

  it('shows immediate spinner + 正在打断… on the steering row and disables concurrent clicks', () => {
    const html = renderToStaticMarkup(createElement(QueuedTasks, {
      tasks,
      steeringTaskId: 't1',
      onCancel: noop,
      onSteer: noop,
      onEdit: noop
    }));

    expect(html).toContain('正在打断当前回复…');
    expect(html).toContain('data-steering=""');
    expect(html).toContain('正在打断…');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    // 正在插队的行不再显示编辑/取消按钮，避免误触；其他排队行仍被禁用防并发。
    expect(html).not.toContain('aria-label="取消排队：帮我优先修这个 bug"');
    expect(html).toContain('aria-label="取消排队：顺便看下日志"');
    expect(html).toContain('disabled=""');
  });

  it('restores normal clickable state without losing queued messages after failure rollback', () => {
    const html = renderToStaticMarkup(createElement(QueuedTasks, {
      tasks,
      steeringTaskId: undefined,
      onCancel: noop,
      onSteer: noop,
      onEdit: noop
    }));

    expect(html).not.toContain('正在打断…');
    expect(html).not.toContain('data-steering=""');
    expect(html).toContain('帮我优先修这个 bug');
    expect(html).toContain('顺便看下日志');
    expect(html).toContain('>立即发送</button>');
  });
});

describe('Composer interrupt-and-send transition UI', () => {
  const baseProps = {
    sessionId: 'ses_1',
    state: 'thinking',
    value: '',
    references: [],
    sending: false,
    mode: 'queue' as const,
    queuedTasks: [],
    skills: [],
    models: [],
    reasoningEfforts: [],
    context: {},
    advertisedCommands: [],
    modelReadiness: { kind: 'ready' as const },
    switchingModel: false,
    switchingReasoningEffort: false,
    refreshingModels: false,
    onChange: noop,
    onReferencesChange: noop,
    onModeChange: noop,
    onSubmit: noop,
    onInterrupt: noop,
    onCancelQueued: noop,
    onSteerQueued: noop,
    onEditQueued: noop,
    onModelChange: noop,
    onReasoningEffortChange: noop,
    onRefreshModels: noop
  };

  it('shows disabled spinner + 正在打断… instead of falling back to static stop button during interrupt send', () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      ...baseProps,
      sending: true,
      sendingMode: 'interrupt',
      value: ''
    }));

    expect(html).toContain('data-interrupting-send=""');
    expect(html).toContain('aria-label="正在打断并发送"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('正在打断…');
    expect(html).not.toContain('aria-label="中断当前任务"');
  });

  it('restores draft and interrupt mode when interrupt send fails and rolls back', () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      ...baseProps,
      sending: false,
      sendingMode: undefined,
      mode: 'interrupt',
      value: '先停一下，改看这里'
    }));

    expect(html).not.toContain('data-interrupting-send=""');
    expect(html).toContain('发送方式：打断并发送');
    expect(html).toContain('aria-label="发送消息"');
    expect(html).not.toContain('aria-label="发送消息" aria-keyshortcuts="Enter" title="发送消息（Enter 发送，Shift+Enter 换行）" disabled');
  });
});

describe('Optimistic interrupting bubble in timeline', () => {
  it('propagates interrupting flag into optimistic timeline row and render signature', () => {
    const normal: OptimisticMessage = { id: 'opt-1', prompt: '普通消息', createdAt: '2026-01-01T00:00:01.000Z', placement: 'timeline' };
    const interrupting: OptimisticMessage = { id: 'opt-2', prompt: '插队消息', createdAt: '2026-01-01T00:00:02.000Z', placement: 'timeline', interrupting: true };

    const [normalRow] = buildTimeline([], [], [normal]);
    const [interruptRow] = buildTimeline([], [], [interrupting]);

    expect(normalRow?.data.interrupting).toBeUndefined();
    expect(interruptRow?.data.interrupting).toBe(true);
    expect(eventRenderSignature(interruptRow!)).toContain(':optimistic:interrupting');
    expect(eventRenderSignature(normalRow!)).not.toContain(':interrupting');

    const interruptHtml = renderToStaticMarkup(createElement(TimelineItem, {
      event: interruptRow!,
      final: false,
      streaming: false,
      replay: false,
      assistantLabel: 'Claude',
      sessionId: 'ses_1'
    }));
    expect(interruptHtml).toContain('aria-label="正在打断并发送"');
    expect(interruptHtml).toContain('正在打断当前回复，即将发送…');

    const normalHtml = renderToStaticMarkup(createElement(TimelineItem, {
      event: normalRow!,
      final: false,
      streaming: false,
      replay: false,
      assistantLabel: 'Claude',
      sessionId: 'ses_1'
    }));
    expect(normalHtml).toContain('aria-label="发送中"');
    expect(normalHtml).not.toContain('正在打断当前回复，即将发送…');
  });
});

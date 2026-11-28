import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./ComposerEditor', () => ({
  ComposerEditor: () => createElement('div', { 'data-testid': 'mock-composer-editor' })
}));
vi.mock('./AiTextAssist', () => ({
  AiTextAssistControl: () => null,
  AiUndoCapsule: () => null,
  useAiFlash: () => ({ flashClass: '', triggerFlash: () => undefined })
}));

import { Composer } from './Composer';
import { TooltipProvider } from './HoverTooltip';
import { createSessionConfigSwitchLane } from './session-config-switch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type ComposerProps = Parameters<typeof Composer>[0];

const baseComposerProps: ComposerProps = {
  sessionId: 'sess_test',
  state: 'completed',
  value: '',
  references: [],
  sending: false,
  mode: 'queue',
  queuedTasks: [],
  skills: [],
  models: [
    { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5' },
    { id: 'claude-opus-4-5', name: 'Opus 4.5' }
  ],
  reasoningEfforts: [
    { id: 'low', name: '低' },
    { id: 'high', name: '高' }
  ],
  currentModel: 'claude-sonnet-4-5',
  currentReasoningEffort: 'low',
  advertisedCommands: [],
  modelReadiness: { kind: 'ready' },
  switchingModel: false,
  switchingReasoningEffort: false,
  refreshingModels: false,
  onChange: () => undefined,
  onReferencesChange: () => undefined,
  onModeChange: () => undefined,
  onSubmit: () => undefined,
  onInterrupt: () => undefined,
  onCancelQueued: () => undefined,
  onSteerQueued: () => undefined,
  onEditQueued: () => undefined,
  onModelChange: () => undefined,
  onReasoningEffortChange: () => undefined,
  onRefreshModels: () => undefined
};

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props = { ...baseComposerProps, ...overrides } as ComposerProps;
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(Composer, props))
  );
}

describe('Composer model & reasoning loading/saved micro-interactions', () => {
  it('renders clear loading state, spinner, aria-busy and target name while switching model', () => {
    const html = renderComposer({
      switchingModel: true,
      pendingModel: 'claude-opus-4-5',
      modelReadiness: { kind: 'blocked', label: '模型切换中…', reason: '正在切换模型，完成后即可发送。' }
    });
    expect(html).toContain('data-testid="composer-model-trigger"');
    expect(html).toContain('data-state="switching"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('ui-chip-loading');
    expect(html).toContain('animate-spin');
    expect(html).toContain('切换至 Opus 4.5…');
  });

  it('renders clear loading state, spinner and aria-busy while switching reasoning effort', () => {
    const html = renderComposer({
      switchingReasoningEffort: true,
      pendingReasoningEffort: 'high'
    });
    expect(html).toContain('data-testid="composer-reasoning-trigger"');
    expect(html).toContain('data-state="switching"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('ui-chip-loading');
    expect(html).toContain('animate-spin');
    expect(html).toContain('高…');
  });

  it('renders spinner and loading state while fetching model catalog', () => {
    const html = renderComposer({
      models: [],
      reasoningEfforts: [],
      currentModel: undefined,
      currentReasoningEffort: undefined,
      refreshingModels: true,
      modelReadiness: { kind: 'loading', label: '模型加载中…', reason: '正在读取模型列表…' }
    });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('模型加载中…');
    expect(html).toContain('animate-spin');
  });

  it('renders brief saved confirmation feedback on model and reasoning chips after completion', () => {
    const html = renderComposer({
      modelJustSwitched: true,
      reasoningJustSwitched: true
    });
    expect(html).toContain('data-state="saved"');
    expect(html).toContain('ui-chip-saved');
    expect(html).toContain('ui-icon-pop');
  });

  it('keeps mobile 390px compact width guards on both model and reasoning chips', () => {
    const html = renderComposer();
    expect(html).toContain('max-w-[88px]');
    expect(html).toContain('sm:max-w-[16rem]');
    expect(html).toContain('sm:max-w-[10rem]');
  });
});

describe('session config switch lane (optimistic + last-write-wins + rollback)', () => {
  it('optimistically updates, tracks pending, and converges on success', async () => {
    const lane = createSessionConfigSwitchLane();
    const req = deferred<{ model: string }>();
    let current = 'sonnet';
    const optimistic: string[] = [];
    const applied: string[] = [];

    const run = lane.submit('opus', {
      currentValue: current,
      request: () => req.promise,
      onOptimistic: target => { optimistic.push(target); current = target; },
      onSuccess: res => { applied.push(res.model); current = res.model; },
      onRollback: () => { throw new Error('must not rollback'); }
    });

    expect(lane.pending).toBe('opus');
    expect(lane.rollbackValue).toBe('sonnet');
    expect(optimistic).toEqual(['opus']);
    // 重复点击当前在途目标值应去重跳过。
    expect(await lane.submit('opus', {
      currentValue: current,
      request: () => { throw new Error('must not fire duplicate request'); },
      onOptimistic: () => undefined,
      onSuccess: () => undefined,
      onRollback: () => undefined
    })).toBe('skipped');

    req.resolve({ model: 'opus' });
    expect(await run).toBe('applied');
    expect(lane.pending).toBeUndefined();
    expect(applied).toEqual(['opus']);
    expect(current).toBe('opus');
  });

  it('enforces last-write-wins when an older request resolves or fails after a newer selection', async () => {
    const lane = createSessionConfigSwitchLane();
    const first = deferred<{ model: string }>();
    const second = deferred<{ model: string }>();
    let current: string | undefined = 'sonnet';
    const applied: string[] = [];
    const rollbacks: Array<string | undefined> = [];

    const p1 = lane.submit('opus', {
      currentValue: current,
      request: () => first.promise,
      onOptimistic: target => { current = target; },
      onSuccess: res => { applied.push(res.model); current = res.model; },
      onRollback: prev => { rollbacks.push(prev); current = prev; }
    });
    const p2 = lane.submit('haiku', {
      currentValue: current,
      request: () => second.promise,
      onOptimistic: target => { current = target; },
      onSuccess: res => { applied.push(res.model); current = res.model; },
      onRollback: prev => { rollbacks.push(prev); current = prev; }
    });

    // 第一次请求更晚失败/返回，绝不能覆盖或回滚掉用户后选的 haiku。
    second.resolve({ model: 'haiku' });
    expect(await p2).toBe('applied');
    expect(current).toBe('haiku');

    first.reject(new Error('stale timeout'));
    expect(await p1).toBe('stale');
    expect(applied).toEqual(['haiku']);
    expect(rollbacks).toEqual([]);
    expect(current).toBe('haiku');
  });

  it('rolls back to the pre-burst original value and reports error message when the latest request fails', async () => {
    const lane = createSessionConfigSwitchLane();
    const first = deferred<void>();
    const second = deferred<void>();
    let current: string | undefined = 'low';
    const errors: Array<{ previous: string | undefined; message: string }> = [];

    const p1 = lane.submit('medium', {
      currentValue: current,
      request: () => first.promise,
      onOptimistic: target => { current = target; },
      onSuccess: () => undefined,
      onRollback: (previous, message) => { current = previous; errors.push({ previous, message }); }
    });
    const p2 = lane.submit('high', {
      currentValue: current,
      request: () => second.promise,
      onOptimistic: target => { current = target; },
      onSuccess: () => undefined,
      onRollback: (previous, message) => { current = previous; errors.push({ previous, message }); }
    });

    second.reject(new Error('不支持该思考深度'));
    expect(await p2).toBe('rolled_back');
    first.resolve();
    expect(await p1).toBe('stale');

    // 连切 low -> medium -> high 中最后一个失败时，回滚回连切前初始值 low（而非中途值 medium）。
    expect(current).toBe('low');
    expect(errors).toEqual([{ previous: 'low', message: '不支持该思考深度' }]);
    expect(lane.pending).toBeUndefined();
  });

  it('shields in-flight responses after reset() on session switch', async () => {
    const lane = createSessionConfigSwitchLane();
    const req = deferred<{ model: string }>();
    const onSuccess = vi.fn();
    const onRollback = vi.fn();

    const run = lane.submit('opus', {
      currentValue: 'sonnet',
      request: () => req.promise,
      onOptimistic: () => undefined,
      onSuccess,
      onRollback
    });
    lane.reset();
    req.resolve({ model: 'opus' });
    expect(await run).toBe('stale');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onRollback).not.toHaveBeenCalled();
  });
});

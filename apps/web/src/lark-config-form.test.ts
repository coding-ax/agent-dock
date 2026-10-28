import { describe, expect, it } from 'vitest';
import { canSaveHardGate, canToggleHardGate, resolveReasoningEffort, withSavedOption, type HardGateFormState } from './lark-config-form';

const state = (overrides: Partial<HardGateFormState> = {}): HardGateFormState => ({
  enabled: false,
  persisted: false,
  agentSelectionSaved: true,
  hookInstalled: false,
  ...overrides
});

describe('hard gate form state', () => {
  it('does not block unrelated saves when a persisted hook is no longer installed', () => {
    const missingPersistedHook = state({ enabled: true, persisted: true });

    expect(canSaveHardGate(missingPersistedHook)).toBe(true);
    expect(canToggleHardGate(missingPersistedHook)).toBe(true);
  });

  it('allows an enabled hard gate to be turned off even when its hook is missing', () => {
    expect(canToggleHardGate(state({ enabled: true }))).toBe(true);
    expect(canSaveHardGate(state({ enabled: false, persisted: true }))).toBe(true);
  });

  it('requires an installed hook before enabling a new hard gate', () => {
    expect(canToggleHardGate(state())).toBe(false);
    expect(canSaveHardGate(state({ enabled: true }))).toBe(false);
    expect(canToggleHardGate(state({ hookInstalled: true }))).toBe(true);
    expect(canSaveHardGate(state({ enabled: true, hookInstalled: true }))).toBe(true);
  });

  it('does not carry a persisted hard gate across an unsaved Agent selection', () => {
    expect(canSaveHardGate(state({ enabled: true, persisted: true, agentSelectionSaved: false }))).toBe(false);
  });
});

describe('reasoning effort resolution', () => {
  const options = { reasoningEfforts: [{ id: 'low' }, { id: 'high' }] };

  it('keeps a selection that the current Agent still offers', () => {
    expect(resolveReasoningEffort('high', options, false)).toBe('high');
  });

  it('falls back to the Agent default once the selection disappears', () => {
    // 换 Agent 后旧强度不在新列表里，必须回落，否则会把非法值提交上去。
    expect(resolveReasoningEffort('max', options, false)).toBe('');
  });

  it('keeps the selection while options are still loading', () => {
    // 请求途中列表为空，此时清空会把用户刚选的值抹掉。
    expect(resolveReasoningEffort('high', options, true)).toBe('high');
    expect(resolveReasoningEffort('high', undefined, false)).toBe('high');
  });

  it('leaves the empty default alone', () => {
    expect(resolveReasoningEffort('', options, false)).toBe('');
  });
});

it('preserves saved model and effort values when discovery returns no choices', () => {
  expect(resolveReasoningEffort('high', { reasoningEfforts: [] }, false)).toBe('high');
  expect(withSavedOption([], 'model-a')).toEqual([{ id: 'model-a', name: 'model-a（已保存）' }]);
  expect(withSavedOption([{ id: 'model-a', name: 'Model A' }], 'model-a')).toHaveLength(1);
});

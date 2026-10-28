export type HardGateFormState = {
  enabled: boolean;
  persisted: boolean;
  agentSelectionSaved: boolean;
  hookInstalled: boolean;
};

export function canSaveHardGate(state: HardGateFormState): boolean {
  if (!state.enabled) return true;
  if (!state.agentSelectionSaved) return false;
  return state.persisted || state.hookInstalled;
}

export function canToggleHardGate(state: HardGateFormState): boolean {
  return state.enabled || (state.agentSelectionSaved && state.hookInstalled);
}

/**
 * 已选推理强度在当前 Agent / 模型下是否仍然有效，无效时回落到「使用默认」。
 *
 * 做成渲染期派生而不是用 Effect 纠正 state：Effect 版本会先渲染一帧非法值再改写，
 * 既多一次渲染，也让「表单当前值」在这一帧里是不可提交的。
 * 列表还在加载时保持原值，避免请求途中把用户的选择清掉。
 */
export function resolveReasoningEffort(
  selected: string,
  options: { reasoningEfforts: Array<{ id: string }> } | undefined,
  loading: boolean
): string {
  if (!selected || loading || !options || !options.reasoningEfforts.length) return selected;
  return options.reasoningEfforts.some(option => option.id === selected) ? selected : '';
}

/** 保留已保存但暂未发现的选项，避免加载/降级时显示空白或静默清空。 */
export function withSavedOption(options: Array<{ id: string; name: string }>, selected: string) {
  return selected && !options.some(option => option.id === selected)
    ? [{ id: selected, name: `${selected}（已保存）` }, ...options]
    : options;
}

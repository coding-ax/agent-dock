import type { LarkTurnSyncConfig, LarkTurnSyncConfigInput } from './api';

export const DEFAULT_LARK_TURN_SYNC: LarkTurnSyncConfig = {
  enabled: true,
  sources: {
    supervision: true,
    web: true,
    schedule: true,
    maintenance: false
  },
  filterSilentSchedule: true
};

export function normalizeLarkTurnSyncForm(
  input?: LarkTurnSyncConfigInput | null,
  fallback: LarkTurnSyncConfig = DEFAULT_LARK_TURN_SYNC
): LarkTurnSyncConfig {
  const base: LarkTurnSyncConfig = {
    enabled: typeof fallback.enabled === 'boolean' ? fallback.enabled : DEFAULT_LARK_TURN_SYNC.enabled,
    sources: {
      supervision: typeof fallback.sources?.supervision === 'boolean' ? fallback.sources.supervision : DEFAULT_LARK_TURN_SYNC.sources.supervision,
      web: typeof fallback.sources?.web === 'boolean' ? fallback.sources.web : DEFAULT_LARK_TURN_SYNC.sources.web,
      schedule: typeof fallback.sources?.schedule === 'boolean' ? fallback.sources.schedule : DEFAULT_LARK_TURN_SYNC.sources.schedule,
      maintenance: typeof fallback.sources?.maintenance === 'boolean' ? fallback.sources.maintenance : DEFAULT_LARK_TURN_SYNC.sources.maintenance
    },
    filterSilentSchedule: typeof fallback.filterSilentSchedule === 'boolean' ? fallback.filterSilentSchedule : DEFAULT_LARK_TURN_SYNC.filterSilentSchedule
  };
  if (!input || typeof input !== 'object') return base;
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base.enabled,
    sources: {
      supervision: typeof input.sources?.supervision === 'boolean' ? input.sources.supervision : base.sources.supervision,
      web: typeof input.sources?.web === 'boolean' ? input.sources.web : base.sources.web,
      schedule: typeof input.sources?.schedule === 'boolean' ? input.sources.schedule : base.sources.schedule,
      maintenance: typeof input.sources?.maintenance === 'boolean' ? input.sources.maintenance : base.sources.maintenance
    },
    filterSilentSchedule: typeof input.filterSilentSchedule === 'boolean' ? input.filterSilentSchedule : base.filterSilentSchedule
  };
}

/**
 * 新建飞书机器人表单的推荐默认值（仅作用于新建草稿；已保存的机器人始终按远端配置回填）。
 *
 * - `listening: true`：填完凭证并完成配置后直接上线接收消息，避免保存后无响应再折返开开关。
 * - `groupToolsEnabled / groupToolsAllowSend: true`：默认支持群内多 Agent 协作与 @ 交接。
 * - `groupSessionScope: 'chat'`：普通群主流消息默认全群共享上下文（话题内仍按话题隔离）。
 * - `turnSync`：默认开启系统督办 + Web 对话 + 定时任务（静默过滤）同步，关闭整理维护避免刷屏。
 */
export const DEFAULT_NEW_LARK_BOT_FORM = {
  listening: true,
  groupToolsEnabled: true,
  groupToolsAllowSend: true,
  groupSessionScope: 'chat' as const,
  peerBotsAllowed: true,
  quietReply: false,
  pushIntervalMs: 1_000,
  gateEnabled: false,
  turnSync: DEFAULT_LARK_TURN_SYNC
} as const;

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

import { withSavedOption } from './lark-config-form';

export interface LarkAvatarAgentOption {
  value: string;
  label: string;
  agentId: string;
}

/**
 * 计算 AI 飞书替身配置页的默认回复器（agentId）。
 *
 * 只有当表单当前未选择、远端配置已加载完毕且远端未保存 agentId 时，
 * 才回退到可用 Agent 列表的首项；否则必须保留当前值或已保存的 agentId，
 * 避免挂载同帧里两个 useEffect 竞态把已保存的 trae 覆写成列表首位（如 codex）。
 */
export function resolveFallbackAgentId(input: {
  currentAgentId: string;
  savedAgentId?: string | null;
  configPending: boolean;
  agents?: Array<{ id: string }>;
}): string {
  const current = input.currentAgentId.trim();
  if (current) return current;
  if (input.configPending) return '';
  const saved = input.savedAgentId?.trim() ?? '';
  if (saved) return saved;
  return input.agents?.[0]?.id ?? '';
}

/**
 * 构造回复器下拉选项；若已保存的 agentId（如 trae）尚未出现在当前可用列表中，
 * 仍保留为「已保存」项展示，避免下拉框显示空白或丢失原值。
 */
export function buildLarkAvatarAgentOptions(
  agents: Array<{ id: string; name: string }> | undefined,
  selectedAgentId: string
): LarkAvatarAgentOption[] {
  return withSavedOption(agents ?? [], selectedAgentId.trim()).map(agent => ({
    value: agent.id,
    label: agent.name,
    agentId: agent.id
  }));
}

/** 提交保存配置时的 agentId：优先表单值，其次已保存配置，不以空字符串覆写。 */
export function resolveSaveAgentId(draftAgentId: string, savedAgentId?: string | null): string {
  return draftAgentId.trim() || savedAgentId?.trim() || '';
}

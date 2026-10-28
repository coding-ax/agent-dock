import type { Agent } from './api';

/**
 * Agent 表单的草稿与校验。
 *
 * 只留三个真正需要人填的字段：名称、启动命令、工作目录。
 *
 * 其余字段（协议、超时、参数、补充模型、模型、reasoning effort、pause/resume、权限模式、
 * 环境变量、系统提示词）都已从表单移除，理由是它们要么由扫描/探测得出（协议、版本、argv）、
 * 要么是全版本固定值（权限模式一律 full-trust）、要么写了没有任何代码读（pause）、
 * 要么属于会话级而非 Agent 级（模型、reasoning effort 在 Composer 里选）。
 * 这些字段仍保留在 agentConfigSchema 里并走 schema 默认值，所以存量 Agent 行为不变。
 *
 * id 不再由用户填写：从名称派生。内置 Agent 的 id 是机器给的且不可改（AGENT_ID_IMMUTABLE），
 * 自定义 Agent 让人手填 id 只是多一个要解释的规则。
 */
export interface AgentFormDraft {
  name: string;
  command: string;
  cwd: string;
}

export interface FormError { field: keyof AgentFormDraft; message: string }

const idPattern = /^[a-z0-9][a-z0-9-_]*$/;

export function agentToDraft(agent?: Agent): AgentFormDraft {
  return {
    name: agent?.name ?? '',
    command: agent?.command ?? '',
    cwd: agent?.cwd ?? ''
  };
}

export function newAgentDraft(): AgentFormDraft {
  return agentToDraft(undefined);
}

/**
 * 从名称派生 id：转小写、非字母数字压成连字符、去掉首尾连字符。
 *
 * 派生结果必须过 idPattern——非 ASCII 名称（比如纯中文）会被压成空串，
 * 那种情况由调用方补一个兜底值，这里只负责保证「有字符时」的形态。
 */
export function nameToId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return idPattern.test(slug) ? slug : '';
}

/**
 * 挑一个不与现有 id 冲突的 id：重名时依次加 -2、-3……
 *
 * 不做静默覆盖：同名的两个自定义 Agent 若能共用 id，保存第二个会顶掉第一个的配置。
 */
export function uniqueAgentId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = nameToId(name) || 'agent';
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function validateDraft(draft: AgentFormDraft): FormError[] {
  const errors: FormError[] = [];
  if (!draft.name.trim()) errors.push({ field: 'name', message: '名称不能为空' });
  if (!draft.command.trim()) errors.push({ field: 'command', message: '启动命令不能为空' });
  return errors;
}

export function canSave(draft: AgentFormDraft): boolean {
  return validateDraft(draft).length === 0;
}

/**
 * 表单 → API 提交体。
 *
 * 只下发这三个字段。被移除的字段不再出现在提交体里，于是服务端 schema 的默认值生效——
 * 编辑一个存量 Agent 时，它原有的 args/env/systemPrompt 等值会保持原样吗？不会：
 * updateAgent 是按提交体合并的，未提交的字段走 schema 默认值。这正是我们要的语义
 * （这些字段已无法从 UI 编辑，任由它们保留旧值只会让库里出现表里不一的行），
 * 但内置 Agent 不受影响——它们每次启动都由 scanBuiltinAgents 重写。
 */
export function draftToPayload(draft: AgentFormDraft) {
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    // 空字符串表示「跟随会话 cwd」，不下发这个键，避免把空串写成一个真实的空路径。
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {})
  };
}

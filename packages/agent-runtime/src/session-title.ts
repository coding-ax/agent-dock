/** 会话列表标题的最大字符数（按 JS code unit 计，足够中文场景）。 */
export const SESSION_TITLE_MAX_CHARS = 120;

/**
 * 把会话第一条用户 prompt 压成一行列表标题：
 * 折叠所有连续空白（含换行）为单个空格、去首尾空白、超长截断加省略号；空输入返回空串。
 */
export function summarizeSessionTitle(prompt: string | null | undefined, maxChars = SESSION_TITLE_MAX_CHARS): string {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * 清洗一个由外部（Agent 或用户）提供的标题。
 *
 * 和 `summarizeSessionTitle` 的差别只在语义：那个是「把任意长 prompt 压成标题」，
 * 这个是「接受一个已经是标题的字符串」。同样折叠空白、同样截断——Agent 侧没有统一的
 * 长度约定（Claude 限 256，Codex 不限），落库前必须自己收口，否则一个超长标题
 * 会把侧栏撑坏。全空白视为「没有标题」，返回空串而不是空白的标题。
 */
export function normalizeSessionTitle(value: string | null | undefined, maxChars = SESSION_TITLE_MAX_CHARS): string {
  return summarizeSessionTitle(value, maxChars);
}

/** 展示名的三个来源档位，与 `SessionTitleSource` 一一对应。 */
export type SessionTitleSource = 'user' | 'agent' | 'prompt';

/**
 * 按「用户手改的 > Agent 推来的 > 首条 prompt 摘要」算出一个会话的展示名。
 *
 * 三级是刻意的：用户命名过就锁定，不让 Agent 把它悄悄冲掉；Agent 没给（真机上多数
 * adapter 不给，见 acpx 的 `applySessionInfoUpdate` 只在收到 `session_info_update` 时才写）
 * 就退回老行为，保证任何情况下都不会比改动前更差。
 *
 * `title` 为空时返回 `undefined`——调用方据此决定是「不设字段」还是「设成空串」，
 * 沿用了 `listSessions()` 原先的「没有消息的会话 title 缺省」。
 */
export function resolveSessionTitle(input: {
  customTitle?: string | null;
  agentTitle?: string | null;
  firstPrompt?: string | null;
}): { title: string; source: SessionTitleSource } | undefined {
  const custom = normalizeSessionTitle(input.customTitle);
  if (custom) return { title: custom, source: 'user' };
  const agent = normalizeSessionTitle(input.agentTitle);
  if (agent) return { title: agent, source: 'agent' };
  const prompt = summarizeSessionTitle(input.firstPrompt);
  return prompt ? { title: prompt, source: 'prompt' } : undefined;
}

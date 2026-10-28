/**
 * 会话里记的 model 是 agent 侧原样透传的标识，形状并不统一，直接塞进徽标会出现
 * 一坨 JSON、或与推理强度字段重复。实测到的三种形状：
 *
 * - 普通 id：`gpt-6-astra`、`auto_model/seed-evolving-auto`
 * - 尾部带推理参数：`grok-4.6[effort=high,fast=true]`
 * - 误存成 JSON 数组：`["superrelay","opensource/deepseek_v4_flash_0731"]`
 *
 * 这里只做展示层的收敛，不改动入库数据：会话创建时仍按原串回填。
 */
export interface ModelBadge {
  model?: string;
  effort?: string;
}

const effortPattern = /(?:^|[,[])\s*effort\s*=\s*([^,\]]+)/i;

/**
 * 拆出尾部 `[...]` 参数段。只有内容像 `k=v` 才当参数剥掉——模型 id 本身可能带
 * 方括号（如 `foo[beta]`），无条件剥离会误伤。
 */
function splitParams(raw: string): { head: string; params: string } {
  const match = /^(.*?)\[([^\]]*)\]$/.exec(raw);
  if (!match || !match[2]!.includes('=')) return { head: raw, params: '' };
  return { head: match[1]!.trim(), params: match[2]! };
}

/**
 * `["provider","model"]` 这类误存的 JSON 数组取最后一个非空字符串：它才是真实
 * 模型标识。解析失败或不是数组时返回 undefined，交给调用方退回原串。
 */
function unwrapJsonArray(raw: string): string | undefined {
  if (!raw.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const last = [...parsed].reverse().find(item => typeof item === 'string' && item.trim());
    return typeof last === 'string' ? last.trim() : '';
  } catch {
    return undefined;
  }
}

/** 把会话的 model / reasoningEffort 收敛成可直接渲染的徽标字段。 */
export function modelBadge(model?: string, effort?: string): ModelBadge {
  const stated = effort?.trim();
  const raw = model?.trim();
  if (!raw) return stated ? { effort: stated } : {};
  const base = unwrapJsonArray(raw) ?? raw;
  const { head, params } = splitParams(base);
  // 独立的 reasoningEffort 才是这个会话真正生效的值，优先于 model 串里烧死的参数。
  const resolved = stated || (params ? effortPattern.exec(params)?.[1]?.trim() : undefined);
  return { ...(head ? { model: head } : {}), ...(resolved ? { effort: resolved } : {}) };
}

/** 单枚徽标的文案；两者都有时并排显示，避免一行挂两个标签把行高撑乱。 */
export function modelBadgeText(badge: ModelBadge): string | undefined {
  const parts = [badge.model, badge.effort].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : undefined;
}

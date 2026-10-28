/**
 * 侧边栏三层（工作区 / Agent / 会话）的手动排序覆盖。
 *
 * 默认顺序永远是「时间倒序」：工作区与 Agent 按组内最新会话、会话按 updatedAt。
 * 这个模块只负责在默认序之上叠加用户拖出来的顺序，不改变默认序本身。
 */
export type SidebarItemOrder = {
  /** 工作区 cwd 的顺序。 */
  workspaces: string[];
  /** 工作区 cwd → 该工作区下 agentId 的顺序。 */
  agents: Record<string, string[]>;
  /** `${cwd}\0${agentId}` → 该 Agent 下顶层会话 id 的顺序（侧边会话跟着父会话走，不单独排）。 */
  sessions: Record<string, string[]>;
};

export const EMPTY_ITEM_ORDER: SidebarItemOrder = { workspaces: [], agents: {}, sessions: {} };

const stringList = (input: unknown): string[] =>
  Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];

const idMap = (input: unknown): Record<string, string[]> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(input as Record<string, unknown>)) out[key] = stringList(ids);
  return out;
};

/**
 * localStorage 是外部输入（旧版本、手改、别的标签页）。只保留字符串数组形状的部分，
 * 其余静默丢弃——排序是锦上添花，不能因为它把整个侧边栏渲染搞崩。
 */
export function normalizeItemOrder(value: unknown): SidebarItemOrder {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { workspaces: stringList(source.workspaces), agents: idMap(source.agents), sessions: idMap(source.sessions) };
}

/** 把 `from` 拖到 `to` 原来的槽位；任一不在列表里就原样返回。 */
export function moveInList<T extends string>(ids: T[], from: T, to: T): T[] {
  if (from === to) return ids;
  const fromIndex = ids.indexOf(from);
  const toIndex = ids.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return ids;
  const rest = ids.filter((_, index) => index !== fromIndex);
  rest.splice(toIndex, 0, from);
  return rest;
}

/**
 * 应用手动顺序。
 *
 * - 手动排过的项：按保存的顺序。
 * - 没排过的项（新增会话、从未拖过的集合）：按调用方传入的默认序放在**最前**。
 *   默认序是时间倒序，所以「最前」正好等于「刚聊过的浮上来」。
 * - 保存的 id 一个都没命中（会话全被归档等）：整体退回默认序，不把列表清空。
 */
export function applyOrder<T>(items: T[], savedIds: string[] | undefined, keyOf: (item: T) => string): T[] {
  if (!savedIds?.length) return items;
  const rank = new Map(savedIds.map((id, index) => [id, index]));
  const ranked: T[] = [];
  const unranked: T[] = [];
  for (const item of items) (rank.has(keyOf(item)) ? ranked : unranked).push(item);
  if (!ranked.length) return items;
  ranked.sort((left, right) => rank.get(keyOf(left))! - rank.get(keyOf(right))!);
  return [...unranked, ...ranked];
}

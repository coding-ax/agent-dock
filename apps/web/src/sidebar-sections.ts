/**
 * 侧边栏的分区顺序。目前只有两块（最近 / 项目），用户可以拖拽互换，顺序持久化在 localStorage。
 */
export type SidebarSectionKey = 'recent' | 'projects';

export const DEFAULT_SECTION_ORDER: SidebarSectionKey[] = ['recent', 'projects'];

const VALID_SECTIONS: SidebarSectionKey[] = ['recent', 'projects'];

/**
 * 把持久化里可能出现的脏数据收敛成一个合法的全排列：丢未知项、去重、补齐缺失项。
 * localStorage 是外部输入（旧版本、手改、别的标签页写的），不能假设它正好是当前 schema。
 */
export function normalizeSectionOrder(value: unknown): SidebarSectionKey[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<SidebarSectionKey>();
  for (const item of raw) {
    if (VALID_SECTIONS.includes(item as SidebarSectionKey)) seen.add(item as SidebarSectionKey);
  }
  return [...seen, ...VALID_SECTIONS.filter(key => !seen.has(key))];
}

/**
 * 把 `from` 插到 `to` 原来的位置。两块之间是互换；更多块时是「移动 + 其余保序」。
 * `from` / `to` 不在合法集合里就原样返回，避免脏调用把顺序搞丢一块。
 */
export function reorderSections(order: SidebarSectionKey[], from: SidebarSectionKey, to: SidebarSectionKey): SidebarSectionKey[] {
  const normalized = normalizeSectionOrder(order);
  if (from === to || !VALID_SECTIONS.includes(from) || !VALID_SECTIONS.includes(to)) return normalized;
  const fromIndex = normalized.indexOf(from);
  const toIndex = normalized.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return normalized;
  // 用 to 的「原下标」插入：先摘掉 from 再插回 to 原来占的槽位，两块互换时才是真正的对调。
  const rest = normalized.filter((_, index) => index !== fromIndex);
  rest.splice(toIndex, 0, from);
  return rest;
}

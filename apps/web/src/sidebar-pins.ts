/**
 * 置顶排序的纯逻辑。
 *
 * 两套置顶互相独立：会话置顶只改变「时间」视图，项目置顶只改变「项目」视图。
 * 置顶组内部保持调用方传进来的顺序（时间视图=最近活动，项目视图=原有工作区顺序），
 * 不按置顶时间重排——否则用户刚聊过的会话会被一个更早的置顶压下去。
 */
export function pinnedFirst<T>(items: T[], isPinned: (item: T) => boolean): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isPinned(item) ? pinned : rest).push(item);
  return [...pinned, ...rest];
}

export function splitPinned<T>(items: T[], isPinned: (item: T) => boolean): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) (isPinned(item) ? pinned : rest).push(item);
  return { pinned, rest };
}

export const isSessionPinned = (session: { pinnedAt?: string | null }) => Boolean(session.pinnedAt);
export const isProjectPinned = (project: { pinnedAt?: string | null }) => Boolean(project.pinnedAt);

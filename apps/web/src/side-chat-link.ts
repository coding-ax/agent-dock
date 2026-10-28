import type { Session } from './api';

/**
 * 主会话与其侧边会话的归属关系。
 *
 * 复用 Session 已有的 `source` / `sourceId` 两个自由字符串字段，不新增表列——
 * runtime 只把它们原样存下来、从不解释，所以这里加上一种取值是安全的。
 *
 * 取值必须与飞书的 `source === 'lark'`（sourceId 形如 `${appId}:${chatId}:${chatType}:${scope}`）
 * 区分开：两者共用 sourceId 这一个字段，靠 source 的值分流。下面两个函数都先判 source。
 */
export const sideChatSource = 'side-chat';

/** 这个会话是不是某个主会话派生出的侧边会话；是则返回主会话 id。 */
export function sideChatParentId(session: Pick<Session, 'source' | 'sourceId'>): string | undefined {
  if (session.source !== sideChatSource) return undefined;
  const parent = session.sourceId?.trim();
  // 自引用（不该出现，但手改库或旧数据可能有）不能当成有父会话，否则分组会成环。
  return parent || undefined;
}

/**
 * 把「父会话 id → 它的侧边会话」整理出来，供列表缩进展示。
 *
 * 只认确实存在于本次列表里的父会话：父会话已归档/被过滤掉时，其侧边会话不能被藏起来，
 * 否则那些会话在界面上直接消失——用户只能去数据库里捞。
 */
export function groupSideChats(sessions: Session[]): { children: Map<string, Session[]>; nestedIds: Set<string> } {
  const ids = new Set(sessions.map(session => session.id));
  const children = new Map<string, Session[]>();
  /** 确实被挂到某个父会话下的会话 id——列表里不再单独占行。 */
  const nestedIds = new Set<string>();
  for (const session of sessions) {
    const parentId = sideChatParentId(session);
    if (!parentId) continue;
    // 父会话不在列表里（已归档/被过滤）或是自引用：照常平铺显示，
    // 否则这些会话在界面上直接消失，用户只能去数据库里捞。
    if (!ids.has(parentId) || parentId === session.id) continue;
    const bucket = children.get(parentId);
    if (bucket) bucket.push(session);
    else children.set(parentId, [session]);
    nestedIds.add(session.id);
  }
  return { children, nestedIds };
}

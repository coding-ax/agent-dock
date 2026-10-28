import type { Agent, Session } from './api';
import { groupSideChats } from './side-chat-link';

export type SessionAgentGroup = {
  agentId: string;
  agentName: string;
  sessions: Session[];
  /** 每个会话派生出的侧边会话（按主会话 id 索引），列表里缩进挂在主会话下面。 */
  sideChats: Map<string, Session[]>;
};

export type WorkspaceGroup = {
  cwd: string;
  label: string;
  /** 组内最新会话时间，用于排序 */
  latest: string;
  agents: SessionAgentGroup[];
};

/**
 * 会话的「活跃时间」：优先最后一次对话时间，缺失（旧数据、从未对话）回退 updatedAt。
 * 侧边栏默认排序、⌘K 最近组合、工作区排序全都走这一个口径，避免三处各排各的。
 */
export function sessionActivityTime(session: Pick<Session, 'lastMessageAt' | 'updatedAt' | 'createdAt'>): string {
  return session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
}

const sessionTime = sessionActivityTime;

/**
 * 会话的显示名。优先首条消息摘要——同名会话多的时候它是唯一能区分的字段，
 * 没有消息才回退 Agent 名，再回退 agentId。
 *
 * 侧栏行、搜索命中、副屏标签名都走这一个口径：三处各写一遍必然漂移
 * （出现过副屏标签显示会话 id 的情况）。
 */
export function sessionLabel(session: Pick<Session, 'title' | 'agentId'>, agentName?: string): string {
  return session.title || agentName || session.agentId;
}

/** 取路径最后一段作为工作区显示名；/ 的兜底为根路径本身。 */
export function workspaceLabel(cwd: string): string {
  if (cwd === '/') return '/';
  const base = cwd.replace(/\/+$/, '').split('/').pop();
  return base || cwd;
}

/**
 * 把已过滤、已按时间倒序的会话按 工作区(cwd) → Agent 两级分组。
 *
 * 输入有序是契约的一部分：visibleSessions 已按 updatedAt 倒序，
 * 分组时保持首次出现顺序即可同时得到「工作区倒序」「组内会话倒序」，
 * 无需再排序（真实会话数百条时省一轮排序，也便于单测断言）。
 */
export function groupSessions(sessions: Session[], agents: Agent[] = []): WorkspaceGroup[] {
  const agentNames = new Map(agents.map(agent => [agent.id, agent.name]));
  const { children, nestedIds } = groupSideChats(sessions);
  const workspaces = new Map<string, WorkspaceGroup>();
  for (const session of sessions) {
    // 侧边会话不单独占一行：缩进挂在父会话下面。父会话不在列表里的不在此列，照常平铺。
    if (nestedIds.has(session.id)) continue;
    let workspace = workspaces.get(session.cwd);
    if (!workspace) {
      workspace = { cwd: session.cwd, label: workspaceLabel(session.cwd), latest: sessionTime(session), agents: [] };
      workspaces.set(session.cwd, workspace);
    }
    let agentGroup = workspace.agents.find(group => group.agentId === session.agentId);
    if (!agentGroup) {
      agentGroup = { agentId: session.agentId, agentName: agentNames.get(session.agentId) ?? session.agentId, sessions: [], sideChats: new Map() };
      workspace.agents.push(agentGroup);
    }
    agentGroup.sessions.push(session);
    // 挂靠的侧边会话归到父会话那一行的下面。跨工作区也照样挂——
    // 归属关系比 cwd 分组更重要，用户找的是「我从哪个会话派生的」。
    const mine = children.get(session.id);
    if (mine?.length) {
      for (const child of mine) {
        agentGroup.sideChats.set(session.id, [...(agentGroup.sideChats.get(session.id) ?? []), child]);
      }
    }
  }
  return [...workspaces.values()];
}

/** 侧边栏「最近操作」区最多显示多少条。默认 50，够覆盖一天的跳跃，又不至于让置顶区本身变成第二份长列表。 */
export const RECENT_SESSION_LIMIT = 50;

export type RecentSessionEntry = {
  session: Session;
  /** 挂在它下面的侧边会话；与分组列表同一套归属规则。 */
  sideChats: Session[];
};

/**
 * 取最近操作过的 N 个会话。输入必须已按活动时间倒序——这是 visibleSessions 的既有契约。
 *
 * 侧边会话不单独占一条：它跟在父会话下面，和分组列表一致。否则「最近」里会出现一条
 * 孤零零的派生会话，看不出它从哪儿来。父会话不在最近窗口内的侧边会话直接不出现，
 * 分组列表里照常能找到它。
 *
 * **整块的位置按「组内最新成员」算，不是父会话自己**。分组优先于时间的代价就在这里：
 * 只取父会话自己的时间，会导致刚聊过的侧边会话被压在父会话的旧位次上，看起来就是
 * 「最近没按最后一次对话时间排序」。组内顺序不动，只抬高整块的位置。
 */
export function recentSessions(sessions: Session[], limit = RECENT_SESSION_LIMIT): RecentSessionEntry[] {
  const { children, nestedIds } = groupSideChats(sessions);
  const entries: Array<RecentSessionEntry & { latest: string }> = [];
  for (const session of sessions) {
    if (nestedIds.has(session.id)) continue;
    const sideChats = children.get(session.id) ?? [];
    // 空数组时 reduce 的初值就是父会话自己的时间，所以这一行同时覆盖了「没有侧边会话」。
    const latest = sideChats.reduce((newest, child) => (sessionTime(child) > newest ? sessionTime(child) : newest), sessionTime(session));
    entries.push({ session, sideChats, latest });
  }
  entries.sort((left, right) => right.latest.localeCompare(left.latest));
  return entries.slice(0, limit).map(({ session, sideChats }) => ({ session, sideChats }));
}

/**
 * 两棵分组树的「层级与顺序」是否完全一致。
 *
 * 用来判断手动排序是否真的在生效：只看 localStorage 里存没存 id 是不够的——会话被归档/删除后
 * 那些 id 永远失效，会让「恢复默认排序」按钮一直挂着却点了没变化。比较渲染结果最直接。
 */
export function sameSessionTree(left: WorkspaceGroup[], right: WorkspaceGroup[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!, b = right[i]!;
    if (a.cwd !== b.cwd || a.agents.length !== b.agents.length) return false;
    for (let j = 0; j < a.agents.length; j++) {
      const groupA = a.agents[j]!, groupB = b.agents[j]!;
      if (groupA.agentId !== groupB.agentId || groupA.sessions.length !== groupB.sessions.length) return false;
      for (let k = 0; k < groupA.sessions.length; k++) if (groupA.sessions[k]!.id !== groupB.sessions[k]!.id) return false;
    }
  }
  return true;
}

export type SessionSearchHit = {
  session: Session;
  agentName: string;
};

/**
 * ⌘K 搜索会话：只在未归档会话里找（归档有自己的入口），按活跃时间倒序。
 * 空查询返回最近的 limit 条；关键字按空白切分，每个词都要命中标题 / Agent / 工作目录 / 模型 / id 之一。
 */
export function searchSessions(sessions: Session[], agents: Agent[] = [], query = '', limit = 50): SessionSearchHit[] {
  const agentNames = new Map(agents.map(agent => [agent.id, agent.name]));
  const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hits: SessionSearchHit[] = [];
  const sorted = sessions
    .filter(session => !session.archivedAt)
    .sort((left, right) => sessionTime(right).localeCompare(sessionTime(left)));
  for (const session of sorted) {
    const agentName = agentNames.get(session.agentId) ?? session.agentId;
    const haystack = [session.title, agentName, session.agentId, session.cwd, session.model, session.id]
      .filter(Boolean).join('\n').toLowerCase();
    if (!keywords.every(keyword => haystack.includes(keyword))) continue;
    hits.push({ session, agentName });
    if (hits.length >= limit) break;
  }
  return hits;
}

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

/* ---------- 按时间分组（侧栏默认视图） ---------- */

export type TimeGroupKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'earlier';
export type TimeSessionGroup = { key: TimeGroupKey; label: string; sessions: Session[] };

const TIME_GROUP_LABELS: Array<{ key: TimeGroupKey; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'last7', label: '过去 7 天' },
  { key: 'last30', label: '过去 30 天' },
  { key: 'earlier', label: '更早' }
];

/**
 * 本地日历日的序数。用 UTC 序数比较本地年月日，避免夏令时把 24 小时切成 23/25 小时导致跨天误判。
 * 未来时间（时钟偏差）按今天处理。
 */
const localDayOrdinal = (date: Date) => Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);

/**
 * 按活跃时间把会话分到「今天 / 昨天 / 过去 7 天 / 过去 30 天 / 更早」。
 * 输入已按时间倒序时组内顺序保持不变；空组不输出。
 */
export function groupSessionsByTime(sessions: Session[], now: Date = new Date()): TimeSessionGroup[] {
  const today = localDayOrdinal(now);
  const buckets = new Map<TimeGroupKey, Session[]>();
  for (const session of sessions) {
    const parsed = new Date(sessionActivityTime(session));
    const day = Number.isNaN(parsed.getTime()) ? today : localDayOrdinal(parsed);
    const age = today - day;
    const key: TimeGroupKey = age <= 0 ? 'today' : age === 1 ? 'yesterday' : age <= 7 ? 'last7' : age <= 30 ? 'last30' : 'earlier';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session); else buckets.set(key, [session]);
  }
  return TIME_GROUP_LABELS.flatMap(({ key, label }) => {
    const list = buckets.get(key);
    return list?.length ? [{ key, label, sessions: list }] : [];
  });
}

/** 会话行悬停时显示的相对时间，如「3 分钟」「2 小时」「5 天」。 */
export function relativeTimeLabel(iso: string, now: number = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
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

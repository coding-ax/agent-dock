import { describe, expect, it } from 'vitest';
import type { Agent, Session } from './api';
import { groupSessions, groupSessionsByTime, relativeTimeLabel, searchSessions, sessionLabel, sameSessionTree, sessionActivityTime, workspaceLabel } from './session-groups';

const agent = (id: string, name = id.toUpperCase()): Agent => ({ id, name, command: id, args: [], protocol: 'acp', env: {}, permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: false });
let seq = 0;
const session = (over: Partial<Session> & Pick<Session, 'agentId' | 'cwd'>): Session => ({
  id: `ses${++seq}`, state: 'idle', runId: `run${seq}`, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', ...over
});

describe('workspaceLabel', () => {
  it('取路径最后一段', () => {
    expect(workspaceLabel('/Users/me/code/agent-dock')).toBe('agent-dock');
    expect(workspaceLabel('/')).toBe('/');
    expect(workspaceLabel('/foo/bar/')).toBe('bar');
  });
});

describe('sessionLabel', () => {
  it('优先首条消息摘要，没有才回退 Agent 名', () => {
    expect(sessionLabel({ title: '改一下副屏', agentId: 'codex' }, 'Codex')).toBe('改一下副屏');
    expect(sessionLabel({ agentId: 'codex' }, 'Codex')).toBe('Codex');
  });

  it('Agent 名缺失时回退 agentId，不产生空标题', () => {
    expect(sessionLabel({ agentId: 'codex' })).toBe('codex');
    expect(sessionLabel({ title: '', agentId: 'codex' }, '')).toBe('codex');
  });
});

describe('groupSessions', () => {
  it('按 cwd 再按 agent 两级分组，保持时间倒序输入的出现顺序', () => {
    const sessions = [
      session({ agentId: 'codex', cwd: '/repo-a', updatedAt: '2026-09-17T10:00:00Z' }),
      session({ agentId: 'claude', cwd: '/repo-a', updatedAt: '2026-09-17T09:00:00Z' }),
      session({ agentId: 'codex', cwd: '/repo-a', updatedAt: '2026-09-17T08:00:00Z' }),
      session({ agentId: 'gemini', cwd: '/repo-b', updatedAt: '2026-09-17T07:00:00Z' })
    ];
    const groups = groupSessions(sessions, [agent('codex', 'Codex'), agent('claude', 'Claude')]);
    expect(groups.map(group => group.cwd)).toEqual(['/repo-a', '/repo-b']);
    expect(groups[0]!.label).toBe('repo-a');
    expect(groups[0]!.agents.map(group => group.agentId)).toEqual(['codex', 'claude']);
    expect(groups[0]!.agents[0]!.agentName).toBe('Codex');
    expect(groups[0]!.agents[0]!.sessions).toHaveLength(2);
    // 未知 agent id 回退显示 id 本身
    expect(groups[1]!.agents[0]!.agentName).toBe('gemini');
  });

  it('空列表返回空分组', () => {
    expect(groupSessions([])).toEqual([]);
  });

  it('跨 Agent 的侧边会话仍挂在父会话所在组，且只显示一次', () => {
    const childAgentSession = session({ agentId: 'claude', cwd: '/repo', id: 'other' });
    const parent = session({ agentId: 'codex', cwd: '/repo', id: 'parent' });
    const child = session({ agentId: 'claude', cwd: '/other-repo', id: 'child', source: 'side-chat', sourceId: 'parent' });
    const groups = groupSessions([childAgentSession, parent, child]);
    const repo = groups.find(group => group.cwd === '/repo')!;
    const parentGroup = repo.agents.find(group => group.agentId === 'codex')!;
    expect(parentGroup.sideChats.get('parent')?.map(item => item.id)).toEqual(['child']);
    expect(repo.agents.find(group => group.agentId === 'claude')!.sideChats.size).toBe(0);
    expect(groups.flatMap(group => group.agents.flatMap(agentGroup => agentGroup.sessions)).map(item => item.id)).toEqual(['other', 'parent']);
  });
});

describe('groupSessionsByTime', () => {
  const now = new Date(2026, 10, 7, 15, 0, 0); // 2026-11-07 15:00 本地时间
  const at = (id: string, iso: string) => session({ id, agentId: 'codex', cwd: '/repo', lastMessageAt: iso });

  it('按本地日历日分到五档，组内保持输入顺序', () => {
    // 用相对 now 的日历日偏移构造，避免手写日期算错。
    const daysAgo = (id: string, days: number) => {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 10);
      return at(id, date.toISOString());
    };
    const groups = groupSessionsByTime([
      daysAgo('today-a', 0), daysAgo('today-b', 0), daysAgo('yesterday', 1),
      daysAgo('day7', 7), daysAgo('day8', 8), daysAgo('day30', 30), daysAgo('day31', 31)
    ], now);
    expect(groups.map(group => group.key)).toEqual(['today', 'yesterday', 'last7', 'last30', 'earlier']);
    expect(groups.map(group => group.sessions.map(item => item.id))).toEqual([
      ['today-a', 'today-b'], ['yesterday'], ['day7'], ['day8', 'day30'], ['day31']
    ]);
    expect(groups.map(group => group.label)).toEqual(['今天', '昨天', '过去 7 天', '过去 30 天', '更早']);
  });

  it('空组不输出；跨天边界按本地时间而不是 24 小时', () => {
    const yesterdayLate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59).toISOString();
    const todayEarly = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1).toISOString();
    const groups = groupSessionsByTime([at('today', todayEarly), at('yesterday', yesterdayLate)], now);
    expect(groups.map(group => group.key)).toEqual(['today', 'yesterday']);
    expect(groupSessionsByTime([at('today', todayEarly)], now).map(group => group.key)).toEqual(['today']);
    expect(groupSessionsByTime([], now)).toEqual([]);
  });

  it('缺失或非法时间按今天处理，未来时间也算今天', () => {
    const missing = session({ id: 'missing', agentId: 'codex', cwd: '/repo', updatedAt: '' });
    const future = at('future', new Date(now.getTime() + 3 * 86_400_000).toISOString());
    const groups = groupSessionsByTime([missing, future], now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('today');
    expect(groups[0]!.sessions.map(item => item.id)).toEqual(['missing', 'future']);
  });

  it('优先用最后对话时间，其次 updatedAt', () => {
    const staleUpdated = session({ id: 'stale', agentId: 'codex', cwd: '/repo', updatedAt: new Date(now.getTime() - 40 * 86_400_000).toISOString(), lastMessageAt: new Date(now.getTime() - 2 * 86_400_000).toISOString() });
    expect(groupSessionsByTime([staleUpdated], now)[0]!.key).toBe('last7');
  });
});

describe('relativeTimeLabel', () => {
  const now = Date.parse('2026-11-07T15:00:00Z');
  it('按分钟 / 小时 / 天显示，未来时间归零', () => {
    expect(relativeTimeLabel('2026-11-07T14:59:40Z', now)).toBe('刚刚');
    expect(relativeTimeLabel('2026-11-07T14:57:00Z', now)).toBe('3 分钟');
    expect(relativeTimeLabel('2026-11-07T13:00:00Z', now)).toBe('2 小时');
    expect(relativeTimeLabel('2026-11-05T15:00:00Z', now)).toBe('2 天');
    expect(relativeTimeLabel('2026-11-07T15:10:00Z', now)).toBe('刚刚');
    expect(relativeTimeLabel('not-a-date', now)).toBe('');
  });
});

describe('sessionActivityTime', () => {
  it('优先最后一次对话时间，缺失或为 null 时回退 updatedAt', () => {
    expect(sessionActivityTime({ lastMessageAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T09:00:00Z', createdAt: '2026-09-17T08:00:00Z' })).toBe('2026-09-17T10:00:00Z');
    expect(sessionActivityTime({ lastMessageAt: null, updatedAt: '2026-09-17T09:00:00Z', createdAt: '2026-09-17T08:00:00Z' })).toBe('2026-09-17T09:00:00Z');
    expect(sessionActivityTime({ updatedAt: '2026-09-17T09:00:00Z', createdAt: '2026-09-17T08:00:00Z' })).toBe('2026-09-17T09:00:00Z');
  });
});

describe('sameSessionTree', () => {
  const build = (sessions: Session[]) => groupSessions(sessions);

  it('同样的输入算同一棵树', () => {
    const sessions = [session({ agentId: 'codex', cwd: '/repo', id: 'a' }), session({ agentId: 'codex', cwd: '/repo', id: 'b' })];
    expect(sameSessionTree(build(sessions), build(sessions))).toBe(true);
  });

  it('会话顺序变了就不算同一棵', () => {
    const forward = [session({ agentId: 'codex', cwd: '/repo', id: 'a' }), session({ agentId: 'codex', cwd: '/repo', id: 'b' })];
    const reversed = [session({ agentId: 'codex', cwd: '/repo', id: 'b' }), session({ agentId: 'codex', cwd: '/repo', id: 'a' })];
    expect(sameSessionTree(build(forward), build(reversed))).toBe(false);
  });

  it('工作区或 Agent 顺序变了就不算同一棵', () => {
    const repos = [session({ agentId: 'codex', cwd: '/a', id: 'a' }), session({ agentId: 'codex', cwd: '/b', id: 'b' })];
    expect(sameSessionTree(build(repos), build([repos[1]!, repos[0]!]))).toBe(false);
    const agents = [session({ agentId: 'codex', cwd: '/repo', id: 'a' }), session({ agentId: 'claude', cwd: '/repo', id: 'b' })];
    expect(sameSessionTree(build(agents), build([agents[1]!, agents[0]!]))).toBe(false);
  });
});

describe('searchSessions', () => {
  const agents = [agent('codex', 'Codex'), agent('claude', 'Claude')];
  const list = [
    session({ id: 's1', agentId: 'codex', cwd: '/Users/me/agent-dock', title: '修复侧边栏', model: 'gpt-5', updatedAt: '2026-09-17T08:00:00Z' }),
    session({ id: 's2', agentId: 'claude', cwd: '/Users/me/web', title: '写说明书', updatedAt: '2026-09-17T10:00:00Z' }),
    session({ id: 's3', agentId: 'codex', cwd: '/Users/me/agent-dock', title: '已归档', updatedAt: '2026-09-17T11:00:00Z', archivedAt: '2026-09-17T12:00:00Z' })
  ];

  it('空查询返回未归档会话，按活跃时间倒序', () => {
    expect(searchSessions(list, agents).map(hit => hit.session.id)).toEqual(['s2', 's1']);
  });

  it('匹配标题、Agent 名、路径、模型，大小写不敏感', () => {
    expect(searchSessions(list, agents, '侧边栏').map(hit => hit.session.id)).toEqual(['s1']);
    expect(searchSessions(list, agents, 'CLAUDE').map(hit => hit.session.id)).toEqual(['s2']);
    expect(searchSessions(list, agents, 'agent-dock').map(hit => hit.session.id)).toEqual(['s1']);
    expect(searchSessions(list, agents, 'gpt').map(hit => hit.session.id)).toEqual(['s1']);
  });

  it('多个关键字需全部命中', () => {
    expect(searchSessions(list, agents, 'codex 侧边').map(hit => hit.session.id)).toEqual(['s1']);
    expect(searchSessions(list, agents, 'codex 说明书')).toEqual([]);
  });

  it('受 limit 约束', () => {
    expect(searchSessions(list, agents, '', 1)).toHaveLength(1);
  });
});

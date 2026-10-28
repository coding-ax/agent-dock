import { describe, expect, it } from 'vitest';
import type { Agent, Session } from './api';
import { groupSessions, recentSessions, searchSessions, sessionLabel, RECENT_SESSION_LIMIT, sameSessionTree, sessionActivityTime, workspaceLabel } from './session-groups';

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

describe('recentSessions', () => {
  it('截断到 N 条且保持传入的 updatedAt 倒序', () => {
    const sessions = [1, 2, 3, 4, 5].map(index => session({ agentId: 'codex', cwd: `/repo-${index}`, id: `s${index}`, updatedAt: `2026-09-17T1${9 - index}:00:00Z` }));
    const recent = recentSessions(sessions, 3);
    expect(recent.map(entry => entry.session.id)).toEqual(['s1', 's2', 's3']);
  });

  // 上游（visibleSessions）已经排好序了，这里再排一次按活动时间倒序，正常情况下是无操作。
  it('输入乱序时按活动时间倒序——不再原样露出', () => {
    const sessions = [session({ agentId: 'codex', cwd: '/a', id: 'a', updatedAt: '2026-09-17T01:00:00Z' }), session({ agentId: 'codex', cwd: '/b', id: 'b', updatedAt: '2026-09-17T09:00:00Z' })];
    expect(recentSessions(sessions).map(entry => entry.session.id)).toEqual(['b', 'a']);
  });

  it('活动时间相同则保持输入顺序（稳定排序，不让列表无谓抖动）', () => {
    const sessions = ['a', 'b', 'c'].map(id => session({ agentId: 'codex', cwd: '/repo', id, updatedAt: '2026-09-17T09:00:00Z' }));
    expect(recentSessions(sessions).map(entry => entry.session.id)).toEqual(['a', 'b', 'c']);
  });

  // 分组优先于时间的代价：只取父会话自己的时间，刚聊过的侧边会话就会被压在父的旧位次上，
  // 看起来就是「最近没按最后一次对话时间排序」。整块的位置必须跟着最新成员走。
  it('侧边会话比父会话新时，整块浮到父会话自身位次之上，嵌套不变', () => {
    const parent = session({ agentId: 'codex', cwd: '/repo', id: 'parent', updatedAt: '2026-09-12T00:00:00Z' });
    const other = session({ agentId: 'codex', cwd: '/repo', id: 'other', updatedAt: '2026-09-20T00:00:00Z' });
    const child = session({ agentId: 'codex', cwd: '/other', id: 'child', source: 'side-chat', sourceId: 'parent', updatedAt: '2026-09-25T00:00:00Z' });
    // 输入按自身时间倒序：child(09-25) > other(09-20) > parent(09-12)。
    const recent = recentSessions([child, other, parent]);
    expect(recent.map(entry => entry.session.id)).toEqual(['parent', 'other']);
    expect(recent[0]!.sideChats.map(item => item.id)).toEqual(['child']);
  });

  it('侧边会话不比父会话新时，位次仍按父会话自己算', () => {
    const parent = session({ agentId: 'codex', cwd: '/repo', id: 'parent', updatedAt: '2026-09-24T00:00:00Z' });
    const other = session({ agentId: 'codex', cwd: '/repo', id: 'other', updatedAt: '2026-09-20T00:00:00Z' });
    const child = session({ agentId: 'codex', cwd: '/other', id: 'child', source: 'side-chat', sourceId: 'parent', updatedAt: '2026-09-13T00:00:00Z' });
    const recent = recentSessions([parent, other, child]);
    expect(recent.map(entry => entry.session.id)).toEqual(['parent', 'other']);
  });

  it('默认上限是 50', () => {
    const sessions = Array.from({ length: 60 }, (_, index) => session({ agentId: 'codex', cwd: `/repo-${index}`, id: `s${index}` }));
    expect(recentSessions(sessions)).toHaveLength(RECENT_SESSION_LIMIT);
  });

  it('侧边会话不单独占位，挂在父会话下面；父会话不在窗口里就不出现', () => {
    const parent = session({ agentId: 'codex', cwd: '/repo', id: 'parent' });
    const child = session({ agentId: 'codex', cwd: '/other', id: 'child', source: 'side-chat', sourceId: 'parent' });
    const orphan = session({ agentId: 'codex', cwd: '/elsewhere', id: 'orphan', source: 'side-chat', sourceId: 'missing-parent' });
    const recent = recentSessions([child, parent, orphan]);
    // child 归到 parent 名下，不再单独占一行；orphan 的父会话不在列表里，照常平铺，不能凭空消失。
    expect(recent.map(entry => entry.session.id)).toEqual(['parent', 'orphan']);
    expect(recent[0]!.sideChats.map(item => item.id)).toEqual(['child']);
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

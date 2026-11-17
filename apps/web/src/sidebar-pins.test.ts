import { describe, expect, it } from 'vitest';
import { isProjectPinned, isSessionPinned, pinnedFirst, splitPinned } from './sidebar-pins';

const sessions = [
  { id: 'a', pinnedAt: null },
  { id: 'b', pinnedAt: '2026-11-17T01:00:00.000Z' },
  { id: 'c', pinnedAt: null },
  { id: 'd', pinnedAt: '2026-11-17T02:00:00.000Z' }
];

describe('置顶排序', () => {
  it('置顶项排最前，组内保持传入顺序（时间视图=最近活动）', () => {
    expect(pinnedFirst(sessions, isSessionPinned).map(item => item.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('拆成置顶组与普通组，两组各自保持原顺序', () => {
    expect(splitPinned(sessions, isSessionPinned)).toEqual({
      pinned: [sessions[1], sessions[3]],
      rest: [sessions[0], sessions[2]]
    });
  });

  it('会话置顶不会影响项目列表：两套判定完全独立', () => {
    const projects = [{ id: 'p1', pinnedAt: null }, { id: 'p2', pinnedAt: null }];
    expect(pinnedFirst(projects, isProjectPinned).map(item => item.id)).toEqual(['p1', 'p2']);
    expect(isSessionPinned(projects[0])).toBe(false);
  });

  it('两套置顶各自排序，不会因为另一侧置顶而改变', () => {
    const projectList = [{ id: 'p1', pinnedAt: null }, { id: 'p2', pinnedAt: null }];
    // 会话列表里有人置顶：项目列表顺序不受影响。
    expect(pinnedFirst(projectList, isProjectPinned).map(item => item.id)).toEqual(['p1', 'p2']);
    expect(pinnedFirst(sessions, isSessionPinned).map(item => item.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

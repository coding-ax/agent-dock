import { describe, expect, it } from 'vitest';
import type { Project } from './api';
import { mergeProjectGroups } from './project-groups';
import { pinnedFirst, isProjectPinned } from './sidebar-pins';
import type { WorkspaceGroup } from './session-groups';

const group = (cwd: string, latest: string): WorkspaceGroup => ({
  cwd,
  label: cwd.split('/').at(-1)!,
  latest,
  agents: [{ agentId: 'codex', agentName: 'Codex', sessions: [], sideChats: new Map() }]
});

const project = (cwd: string, overrides: Partial<Project> = {}): Project => ({
  id: `local:${cwd}`,
  machineId: 'local',
  name: cwd.split('/').at(-1)!,
  cwd,
  pinnedAt: null,
  exists: true,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...overrides
});

describe('项目视图分组', () => {
  it('把项目的置顶状态贴到同名工作区上', () => {
    const merged = mergeProjectGroups([group('/tmp/a', '2026-11-16T00:00:00.000Z')], [project('/tmp/a', { pinnedAt: '2026-11-17T01:00:00.000Z' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.pinnedAt).toBe('2026-11-17T01:00:00.000Z');
  });

  it('已登记但没有会话的项目也会出现在列表里', () => {
    const merged = mergeProjectGroups([], [project('/tmp/imported')]);
    expect(merged[0]).toMatchObject({ cwd: '/tmp/imported', label: 'imported', agents: [] });
  });

  it('同 cwd 不会因为项目登记而重复出现', () => {
    const merged = mergeProjectGroups([group('/tmp/a', '2026-11-16T00:00:00.000Z')], [project('/tmp/a')]);
    expect(merged.map(item => item.cwd)).toEqual(['/tmp/a']);
  });

  it('路径失效的项目保留并标记 missing，置顶后仍排最前', () => {
    const merged = mergeProjectGroups([
      group('/tmp/active', '2026-11-17T03:00:00.000Z'),
      group('/tmp/old', '2026-11-01T00:00:00.000Z')
    ], [project('/tmp/old', { exists: false, pinnedAt: '2026-11-17T01:00:00.000Z' })]);
    const ordered = pinnedFirst(merged, isProjectPinned);
    expect(ordered[0]).toMatchObject({ cwd: '/tmp/old', missing: true, pinnedAt: '2026-11-17T01:00:00.000Z' });
    expect(ordered.map(item => item.cwd)).toEqual(['/tmp/old', '/tmp/active']);
  });

  it('刚导入、还没有会话的项目按登记时间排在前面', () => {
    const merged = mergeProjectGroups([group('/tmp/active', '2026-11-16T00:00:00.000Z')], [project('/tmp/imported', { createdAt: '2026-11-17T09:00:00.000Z' })]);
    expect(merged.map(item => item.cwd)).toEqual(['/tmp/imported', '/tmp/active']);
  });
});

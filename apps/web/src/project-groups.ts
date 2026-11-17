import type { Project } from './api';
import type { WorkspaceGroup } from './session-groups';
import { workspaceLabel } from './session-groups';

/**
 * 项目视图的渲染分组：会话派生出来的工作区 + 已登记但还没有会话的项目。
 * `missing` 表示导入时存在、现在路径失效（被删/被移走）；置顶项仍然保留并标警告。
 */
export type ProjectGroup = WorkspaceGroup & { pinnedAt?: string | null; missing?: boolean };

export function mergeProjectGroups(groups: WorkspaceGroup[], projects: Project[]): ProjectGroup[] {
  const projectByCwd = new Map(projects.map(project => [project.cwd, project]));
  const merged: ProjectGroup[] = groups.map(group => {
    const project = projectByCwd.get(group.cwd);
    return {
      ...group,
      pinnedAt: project?.pinnedAt ?? null,
      ...(project && !project.exists ? { missing: true } : {})
    };
  });
  const known = new Set(merged.map(group => group.cwd));
  for (const project of projects) {
    if (known.has(project.cwd)) continue;
    // 没有会话的导入项目用登记时间当活跃时间：刚导入的排在项目列表前部，用户能立刻看到。
    merged.push({
      cwd: project.cwd,
      label: project.name || workspaceLabel(project.cwd),
      latest: project.createdAt,
      agents: [],
      pinnedAt: project.pinnedAt ?? null,
      ...(project.exists ? {} : { missing: true })
    });
  }
  return merged.sort((left, right) => right.latest.localeCompare(left.latest));
}

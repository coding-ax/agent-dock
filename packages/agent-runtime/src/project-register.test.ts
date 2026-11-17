import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import { AgentDockRuntime } from './index.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('项目导入登记', () => {
  it('同一路径重复导入只保留一条，并返回 created=false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-project-'));
    dirs.push(dir);
    const repos = createRepositories(':memory:');
    const runtime = new AgentDockRuntime(repos);

    const first = await runtime.registerProject(dir);
    const second = await runtime.registerProject(`${dir}/`);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.project.id).toBe(first.project.id);
    expect(await runtime.listProjects()).toHaveLength(1);
    repos.close();
  });

  it('置顶后取消置顶，记录仍在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdock-project-'));
    dirs.push(dir);
    const repos = createRepositories(':memory:');
    const runtime = new AgentDockRuntime(repos);
    const { project } = await runtime.registerProject(dir);

    const pinned = await runtime.setProjectPinned(project.cwd, true);
    expect(pinned.pinnedAt).toBeTruthy();
    const unpinned = await runtime.setProjectPinned(project.cwd, false);
    expect(unpinned.pinnedAt).toBeNull();
    expect(await runtime.listProjects()).toHaveLength(1);
    repos.close();
  });
});

import { describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { AgentConfig } from '@agent-dock/agent-dock-shared';
import { AgentDockRuntime, mergeDiscoveredAgent } from './index.js';

const baseAgent: AgentConfig = { id: 'claude', name: 'Claude', command: 'claude', args: [], protocol: 'auto', env: {}, permissionMode: 'full-trust', timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: '1.0' };

function runtime() {
  const repos = createRepositories(':memory:');
  const rt = new AgentDockRuntime(repos, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), driverFactory: () => ({ start: async () => {}, send: async () => {}, interrupt: async () => {}, resume: async () => {}, stop: async () => {} }) });
  return { repos, rt };
}

describe('mergeDiscoveredAgent', () => {
  it('首次发现强制完全访问', () => {
    const merged = mergeDiscoveredAgent(undefined, { ...baseAgent, permissionMode: 'ask' });
    expect(merged.permissionMode).toBe('full-trust');
    expect(merged.disabled).toBe(false);
  });

  it('面板编辑（command/model/env/systemPrompt）重启不丢，version 用新探测值', () => {
    const stored: AgentConfig = { ...baseAgent, command: '/custom/claude', model: 'opus-x', env: { FOO: '1' }, systemPrompt: 'hi', version: '0.9' };
    const merged = mergeDiscoveredAgent(stored, { ...baseAgent, command: 'claude', version: '2.0' });
    expect(merged.command).toBe('/custom/claude');
    expect(merged.model).toBe('opus-x');
    expect(merged.env).toEqual({ FOO: '1' });
    expect(merged.systemPrompt).toBe('hi');
    expect(merged.version).toBe('2.0');
    expect(merged.permissionMode).toBe('full-trust');
  });

  it('停用状态在重新发现后不复活', () => {
    const stored: AgentConfig = { ...baseAgent, disabled: true };
    const merged = mergeDiscoveredAgent(stored, { ...baseAgent, version: '2.0' });
    expect(merged.disabled).toBe(true);
    expect(merged.version).toBe('2.0');
  });
});

describe('agent admin CRUD', () => {
  it('initialize 合并：编辑保留、version 刷新、停用内置不复活', async () => {
    const { repos, rt } = runtime();
    await rt.initialize([{ ...baseAgent, version: '1.0' }]);
    await rt.updateAgent('claude', { ...(await repos.agents.get('claude'))!, command: '/custom/claude' });
    await rt.initialize([{ ...baseAgent, command: 'claude', version: '2.0' }]);
    const after = await repos.agents.get('claude');
    expect(after?.command).toBe('/custom/claude');
    expect(after?.version).toBe('2.0');

    await rt.deleteAgent('claude');
    await rt.initialize([{ ...baseAgent, version: '3.0' }]);
    const deleted = await repos.agents.get('claude');
    expect(deleted?.disabled).toBe(true);
    expect((await rt.listAgents()).some(a => a.id === 'claude')).toBe(false);
    expect((await rt.listAgents(true)).some(a => a.id === 'claude')).toBe(true);
    repos.close();
  });

  it('create/update/delete 自定义 agent', async () => {
    const { repos, rt } = runtime();
    const custom = await rt.createAgent({ id: 'my-bot', name: 'My Bot', command: 'my-bot', protocol: 'jsonl' });
    expect(custom.builtin).toBe(false);
    await expect(rt.createAgent({ id: 'my-bot', name: 'Dup', command: 'x' })).rejects.toMatchObject({ code: 'AGENT_EXISTS' });
    await expect(rt.createAgent({ id: 'claude', name: 'X', command: 'x' })).rejects.toMatchObject({ code: 'AGENT_ID_RESERVED' });

    const updated = await rt.updateAgent('my-bot', { ...custom, name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    await expect(rt.updateAgent('my-bot', { ...updated, id: 'other' })).rejects.toMatchObject({ code: 'AGENT_ID_IMMUTABLE' });

    const result = await rt.deleteAgent('my-bot');
    expect(result.disabled).toBe(false);
    expect(await repos.agents.get('my-bot')).toBeUndefined();
    repos.close();
  });

  it('停用 agent 不能新建会话', async () => {
    const { repos, rt } = runtime();
    await rt.initialize([{ ...baseAgent }]);
    await rt.deleteAgent('claude');
    await expect(rt.start({ agentId: 'claude' })).rejects.toMatchObject({ code: 'AGENT_DISABLED' });
    repos.close();
  });
});

import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@agent-dock/agent-dock-shared';
import { remoteAgentCommand, supportsSshAgent, wrapAgentForSsh } from './ssh-agent.js';

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'codex',
    name: 'Codex',
    command: '/usr/bin/codex',
    args: ['--acp'],
    protocol: 'acp',
    env: {},
    permissionMode: 'full-trust',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: true,
    ...overrides
  } as AgentConfig;
}

describe('wrapAgentForSsh', () => {
  it('turns the agent into an ssh stdio bridge and cds on the remote side', () => {
    const wrapped = wrapAgentForSsh(agent({ model: 'gpt-5' }), 'gcp', '/home/codeax/my project', { localCwd: '/tmp' });
    expect(wrapped.command).toBe('ssh');
    expect(wrapped.protocol).toBe('acp');
    expect(wrapped.cwd).toBe('/tmp');
    expect(wrapped.env).toEqual({});
    expect(wrapped.args).toContain('gcp');
    const remote = wrapped.args.at(-1)!;
    expect(remote).toContain('cd \'/home/codeax/my project\'');
    expect(remote).toContain('npx -y \'@agentclientprotocol/codex-acp@2.6.0\'');
    expect(remote).toContain('CODEX_CONFIG');
    expect(remote).toContain('"model":"gpt-5"');
  });

  it('pins the Claude remote adapter to the bundled version', () => {
    const wrapped = wrapAgentForSsh(agent({ id: 'claude', name: 'Claude Code', command: '/usr/bin/claude', args: [] }), 'gcp', '/home/codeax', { localCwd: '/tmp' });
    expect(wrapped.args.at(-1)).toContain("npx -y '@agentclientprotocol/claude-agent-acp@0.106.0'");
  });

  it('forwards provider credentials but not local AgentDock plumbing', () => {
    const wrapped = wrapAgentForSsh(agent({
      env: {
        OPENAI_API_KEY: 'sk-test',
        OPENAI_BASE_URL: 'https://example.test/v1',
        agentdock_database: '/tmp/db.sqlite',
        agentdock_group_tools_token: 'secret'
      }
    }), 'gcp', '/srv/app');
    const remote = wrapped.args.at(-1)!;
    expect(remote).toContain("OPENAI_API_KEY='sk-test'");
    expect(remote).toContain("OPENAI_BASE_URL='https://example.test/v1'");
    expect(remote).not.toContain('agentdock_database');
    expect(remote).not.toContain('agentdock_group_tools_token');
  });

  it('rejects unsupported agents and invalid hosts', () => {
    expect(() => wrapAgentForSsh(agent({ id: 'gemini', name: 'Gemini' }), 'gcp', '/srv')).toThrow(/暂不支持/);
    expect(() => wrapAgentForSsh(agent(), '-oProxyCommand=evil', '/srv')).toThrow(/Invalid SSH host/);
    expect(supportsSshAgent(agent())).toBe(true);
    expect(supportsSshAgent(agent({ id: 'gemini' }))).toBe(false);
  });
});

describe('remoteAgentCommand', () => {
  it('quotes values containing single quotes', () => {
    const command = remoteAgentCommand('@scope/pkg@1.0.0', '/srv/it\'s', { OPENAI_API_KEY: 'a\'b' });
    expect(command).toContain(`cd '/srv/it'\\''s'`);
    expect(command).toContain(`OPENAI_API_KEY='a'\\''b'`);
  });
});

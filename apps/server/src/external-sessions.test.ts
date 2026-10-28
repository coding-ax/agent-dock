import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';

const { listExternalSessions } = vi.hoisted(() => ({ listExternalSessions: vi.fn() }));
vi.mock('@agent-dock/agent-dock-acp-client', () => ({ listExternalSessions }));

const apps: any[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  listExternalSessions.mockReset();
});

const agents = [
  { id: 'codex', name: 'Codex', protocol: 'acp', disabled: false },
  { id: 'opencode', name: 'OpenCode', protocol: 'acp', disabled: false }
];

async function mount() {
  const runtime = { listAgents: vi.fn(async () => agents) };
  const app = await buildApp(runtime as any, {});
  apps.push(app);
  return { app, runtime };
}

describe('external session listing route', () => {
  it('returns the agent sessions from ACP session/list', async () => {
    listExternalSessions.mockResolvedValue({ supported: true, sessions: [{ sessionId: 's1', cwd: '/tmp', title: 'hi' }], nextCursor: 'cursor-2' });
    const { app } = await mount();
    const response = await app.inject({ method: 'GET', url: '/api/agents/codex/external-sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ agentId: 'codex', agentName: 'Codex', supported: true, nextCursor: 'cursor-2' });
    expect(response.json().sessions).toHaveLength(1);
  });

  it('forwards cursor and cwd filters to the agent', async () => {
    listExternalSessions.mockResolvedValue({ supported: true, sessions: [] });
    const { app } = await mount();
    await app.inject({ method: 'GET', url: '/api/agents/codex/external-sessions?cursor=abc&cwd=%2Ftmp' });
    expect(listExternalSessions).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex' }), expect.objectContaining({ cursor: 'abc', filterCwd: '/tmp' }));
  });

  it('reports agents that do not implement session/list without failing', async () => {
    listExternalSessions.mockResolvedValue({ supported: false, sessions: [] });
    const { app } = await mount();
    const response = await app.inject({ method: 'GET', url: '/api/agents/opencode/external-sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ supported: false, sessions: [] });
  });

  it('404s for an unknown agent instead of spawning anything', async () => {
    const { app } = await mount();
    const response = await app.inject({ method: 'GET', url: '/api/agents/missing/external-sessions' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('AGENT_NOT_FOUND');
    expect(listExternalSessions).not.toHaveBeenCalled();
  });
});

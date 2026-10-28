import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfRestartBlockReason } from './daemon/self-guard.js';
import { devDown, devRun, devUp, sandboxEnv, sandboxPaths } from './dev-sandbox.js';

describe('self-restart guard', () => {
  const own = '/home/u/.agentdock/agentdock.db';
  const agentEnv = { agentdock_session_id: 'ses_1', agentdock_database: own };

  it('blocks an agent from restarting, stopping or updating the daemon it runs in', () => {
    for (const action of ['restart', 'stop', 'update'] as const) {
      const reason = selfRestartBlockReason(action, { env: agentEnv, targetDatabase: own, ownDatabase: own });
      expect(reason).toContain('已拦截');
      expect(reason).toContain('agent-dock dev up');
    }
  });

  it('blocks conservatively when the agent cannot tell which daemon it runs in', () => {
    expect(selfRestartBlockReason('restart', { env: { agentdock_session_id: 'ses_1' }, targetDatabase: own })).toBeTruthy();
    // update 总会重启正在运行的实例，即使拿不到目标库也拦。
    expect(selfRestartBlockReason('update', { env: { agentdock_session_id: 'ses_1' } })).toBeTruthy();
  });

  it('lets agents operate a different daemon such as the dev sandbox', () => {
    expect(selfRestartBlockReason('restart', { env: agentEnv, targetDatabase: '/repo/.agentdock/dev/agentdock.db', ownDatabase: own })).toBeUndefined();
  });

  it('never blocks a human terminal, a stopped daemon, or an explicit override', () => {
    expect(selfRestartBlockReason('restart', { env: {}, targetDatabase: own, ownDatabase: own })).toBeUndefined();
    expect(selfRestartBlockReason('stop', { env: agentEnv, ownDatabase: own })).toBeUndefined();
    expect(selfRestartBlockReason('restart', { env: { ...agentEnv, AGENTDOCK_ALLOW_SELF_RESTART: '1' }, targetDatabase: own, ownDatabase: own })).toBeUndefined();
  });
});

describe('dev sandbox', () => {
  function fakeRepo() {
    const repo = mkdtempSync(join(tmpdir(), 'ad-repo-'));
    mkdirSync(join(repo, 'apps', 'server', 'dist'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'server', 'package.json'), '{}');
    writeFileSync(join(repo, 'apps', 'server', 'dist', 'cli.js'), '');
    writeFileSync(join(repo, 'pnpm-workspace.yaml'), '');
    return repo;
  }

  it('isolates HOME and strips the session variables that would route commands back to the live daemon', () => {
    const sandbox = sandboxPaths('/repo', 4399);
    const env = sandboxEnv(sandbox, { HOME: '/home/u', PATH: '/bin', agentdock_session_id: 'ses_1', agentdock_group_tools_token: 't', agentdock_database: '/home/u/.agentdock/agentdock.db' });
    expect(env).toMatchObject({ HOME: '/repo/.agentdock/dev/home', PATH: '/bin', AGENTDOCK_DISABLE_LARK_LISTENER: 'true', agentdock_database: '/repo/.agentdock/dev/agentdock.db' });
    expect(env).not.toHaveProperty('agentdock_session_id');
    expect(env).not.toHaveProperty('agentdock_group_tools_token');
  });

  it('starts from the repo build with its own database and port, runs commands there, and cleans up', async () => {
    const repo = fakeRepo();
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const run = (args: string[], env: NodeJS.ProcessEnv) => { calls.push({ args, env }); return { status: 0, stdout: '' }; };
    try {
      const out = await devUp({ repo, port: 4555, run });
      expect(out).toContain('http://127.0.0.1:4555/');
      const start = calls.at(-1)!;
      expect(start.args).toEqual([join(repo, 'apps/server/dist/cli.js'), 'daemon', 'start', '--port', '4555', '--local-only', '--database', join(repo, '.agentdock/dev/agentdock.db')]);
      expect(start.env.HOME).toBe(join(repo, '.agentdock/dev/home'));
      expect(devRun(['schedule', 'list'], { repo, run })).toBe(0);
      expect(calls.at(-1)!.args.slice(1)).toEqual(['schedule', 'list']);
      expect(devDown({ repo, run })).toContain('清理');
      expect(calls.at(-1)!.args.slice(1)).toEqual(['daemon', 'stop']);
      expect(() => devRun(['status'], { repo, run })).toThrow(/dev up/);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it('refuses to start without a build', async () => {
    const repo = fakeRepo();
    rmSync(join(repo, 'apps', 'server', 'dist'), { recursive: true });
    try { await expect(devUp({ repo, port: 4555, run: () => ({ status: 0, stdout: '' }) })).rejects.toThrow(/pnpm build/); }
    finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@agent-dock/agent-dock-storage';
import type { Session } from '@agent-dock/agent-dock-shared';
import { writeState } from './daemon/daemon.js';
import { runSessionCancel, runSessionInterrupt, runSessionPeers, runSessionSend, sessionPeerIds } from './session-cli.js';

const now = '2026-09-23T00:00:00.000Z';
const session = (id: string, source?: string, sourceId?: string): Session => ({
  id, agentId: 'codex', state: 'idle', cwd: '/tmp/project', runId: `run_${id}`, createdAt: now, updatedAt: now,
  ...(source ? { source } : {}), ...(sourceId ? { sourceId } : {})
});

describe('session peers', () => {
  const sessions = [session('main'), session('side-a', 'side-chat', 'main'), session('side-b', 'side-chat', 'main'), session('other')];

  it('finds both directions and excludes unrelated sessions', () => {
    expect(sessionPeerIds(sessions, 'main')).toEqual(['side-a', 'side-b']);
    expect(sessionPeerIds(sessions, 'side-a')).toEqual(['main']);
    expect(sessionPeerIds(sessions, 'other')).toEqual([]);
  });

  it('ignores orphaned and self-referential side chats', () => {
    expect(sessionPeerIds([session('orphan', 'side-chat', 'missing')], 'orphan')).toEqual([]);
    expect(sessionPeerIds([session('self', 'side-chat', 'self')], 'self')).toEqual([]);
  });
});

describe('session control CLI', () => {
  const temporary: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'agentdock-session-cli-')); temporary.push(root);
    const database = join(root, 'agentdock.db');
    const daemonDir = join(root, 'daemon');
    const repos = createRepositories(database);
    await Promise.all([repos.sessions.save(session('main')), repos.sessions.save(session('side', 'side-chat', 'main')), repos.sessions.save(session('other'))]);
    repos.close();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method ?? '', path: request.url ?? '', body: body ? JSON.parse(body) : undefined });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ task: { id: 'task_1', status: 'queued' } }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    writeState(daemonDir, { pid: process.pid, ready: true, startedAt: now, cwd: root, database, address: `http://127.0.0.1:${address.port}` });
    return { database, daemonDir, requests };
  }

  it('lists linked peers from either session', async () => {
    const { database } = await fixture();
    expect(await runSessionPeers('main', { database })).toContain('side');
    expect(await runSessionPeers('side', { database })).toContain('main');
    expect(await runSessionPeers('other', { database })).toContain('没有关联');
  });

  it('uses daemon APIs for queue send, interrupt send, active interrupt and queued cancel', async () => {
    const { daemonDir, requests } = await fixture();
    const options = { from: 'main', daemonDir };
    expect(JSON.parse(await runSessionSend('side', '你好', options))).toMatchObject({ ok: true, from: 'main', to: 'side', task: { id: 'task_1' } });
    await runSessionSend('side', '现在处理', { ...options, mode: 'interrupt' });
    await runSessionInterrupt('side', options);
    await runSessionCancel('side', 'task_queued', options);
    expect(requests).toEqual([
      { method: 'POST', path: '/api/sessions/side/send', body: { prompt: '你好', mode: 'queue' } },
      { method: 'POST', path: '/api/sessions/side/send', body: { prompt: '现在处理', mode: 'interrupt' } },
      { method: 'POST', path: '/api/sessions/side/interrupt', body: undefined },
      { method: 'DELETE', path: '/api/sessions/side/queue/task_queued', body: undefined }
    ]);
  });

  it('rejects unrelated targets before any API call', async () => {
    const { daemonDir, requests } = await fixture();
    await expect(runSessionSend('other', '误发', { from: 'main', daemonDir })).rejects.toThrow('不是当前会话的主副会话');
    expect(requests).toEqual([]);
  });
});

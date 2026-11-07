import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { signatureFor } from './ingress.js';
import { SourceRouterService } from './service.js';

const apps: any[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Source Router HTTP 边界', () => {
  it('开启 webAuth 时非回环 Ingress 仍靠 HMAC 接收，管理接口保持 401', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdock-sr-http-'));
    roots.push(root);
    let sequence = 0;
    const sessions = new Map<string, any>();
    const runtime = {
      async getSession(id: string) { return sessions.get(id); },
      async getTasks() { return []; },
      async start(input: any) {
        const session = { id: `ses_${++sequence}`, agentId: input.agentId, state: 'idle', cwd: '/tmp', source: input.source, sourceId: input.sourceId, runId: 'r', createdAt: 'now', updatedAt: 'now' };
        sessions.set(session.id, session);
        return session;
      },
      async dispatch() { return { id: `task_${++sequence}`, status: 'queued' }; }
    };
    const service = new SourceRouterService({
      databaseUrl: join(root, 'agentdock.db'), runtime,
      routerAgentId: 'fake', startRouterPoll: false,
      env: { AGENTDOCK_ROUTER_PAUSED: 'true' }
    });
    const source = service.createSource({ name: 'GitHub', secrets: { signingSecret: 'secret' } });
    const app = await buildApp({} as any, { webAuth: { enabled: true, secret: 'web-secret' }, sourcesRouter: service, lark: { env: {} } });
    apps.push(app);
    const remote = { remoteAddress: '192.168.1.9', headers: { host: '192.168.1.9:4310' } };
    expect((await app.inject({ method: 'GET', url: '/api/sources', ...remote })).statusCode).toBe(401);
    const event = {
      specVersion: 'agentdock.source.v1', sourceId: source.id, eventId: 'e1', eventType: 'issue.created',
      dedupeKey: 'd1', occurredAt: '2026-11-07T10:00:00.000Z', object: { type: 'issue', id: 'acme/api#1' },
      correlationKey: 'k1', payload: {}, traceId: 't1'
    };
    const raw = `{\n  "specVersion": "agentdock.source.v1",\n  "sourceId": ${JSON.stringify(source.id)},\n  "eventId": "e1",\n  "eventType": "issue.created",\n  "dedupeKey": "d1",\n  "occurredAt": "2026-11-07T10:00:00.000Z",\n  "object": { "type": "issue", "id": "acme/api#1" },\n  "correlationKey": "k1",\n  "payload": {},\n  "traceId": "t1"\n}`;
    expect(JSON.parse(raw)).toEqual(event);
    const response = await app.inject({
      method: 'POST', url: `/api/sources/${source.id}/events`, ...remote,
      headers: {
        ...remote.headers, 'content-type': 'application/json',
        'x-agentdock-signature': signatureFor(raw, 'secret'),
        'x-agentdock-timestamp': String(Date.now())
      },
      payload: raw
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, duplicate: false });
    expect(service.listEventSummaries(source.id)[0]).not.toHaveProperty('payload');
    expect(service.listEventSummaries(source.id)[0]).not.toHaveProperty('raw');
    await service.close();
  });
});

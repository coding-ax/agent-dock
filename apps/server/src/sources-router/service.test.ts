import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, Session, StartSessionInput, TaskRecord } from '@agent-dock/agent-dock-shared';
import { signatureFor } from './ingress.js';
import { SourceRouterService, type SourceRouterRuntime } from './service.js';
import { SourceRouterStore } from './store.js';
import type { JsonObject, SourceInstance } from './types.js';

const roots: string[] = [];
const services: SourceRouterService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeRuntime implements SourceRouterRuntime {
  sessions = new Map<string, Session>();
  tasks = new Map<string, TaskRecord[]>();
  listeners = new Map<string, Array<(event: AgentEvent) => void>>();
  startCalls: StartSessionInput[] = [];
  dispatchCalls: Array<{ sessionId: string; prompt: string }> = [];
  sequence = 0;

  async getSession(id: string) { return this.sessions.get(id); }
  async getTasks(sessionId: string) { return this.tasks.get(sessionId) ?? []; }
  async start(input: StartSessionInput) {
    this.startCalls.push(input);
    const stamp = new Date().toISOString();
    const session: Session = {
      id: `ses_${this.startCalls.length}`, agentId: input.agentId ?? 'fake', state: 'idle',
      cwd: input.cwd ?? '/tmp', ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      source: input.source, sourceId: input.sourceId, systemPrompt: input.systemPrompt,
      runId: `run_${this.startCalls.length}`, createdAt: stamp, updatedAt: stamp
    };
    this.sessions.set(session.id, session);
    return session;
  }
  async dispatch(id: string, prompt: string) {
    this.dispatchCalls.push({ sessionId: id, prompt });
    const stamp = new Date().toISOString();
    const task: TaskRecord = { id: `task_${this.dispatchCalls.length}`, sessionId: id, prompt, status: 'queued', createdAt: stamp, updatedAt: stamp };
    this.tasks.set(id, [...(this.tasks.get(id) ?? []), task]);
    return task;
  }
  subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
    const current = this.listeners.get(sessionId) ?? [];
    current.push(listener); this.listeners.set(sessionId, current);
    return () => { this.listeners.set(sessionId, (this.listeners.get(sessionId) ?? []).filter(item => item !== listener)); };
  }
  complete(sessionId: string, taskId: string) {
    for (const listener of this.listeners.get(sessionId) ?? []) listener({
      id: `evt_${++this.sequence}`, sessionId, sequence: this.sequence, type: 'task',
      timestamp: new Date().toISOString(), data: { task: { id: taskId, status: 'completed' } }
    });
  }
}

function tempDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'agentdock-sr-'));
  roots.push(root);
  return join(root, 'agentdock.db');
}

function makeService(options: { database?: string; runtime?: FakeRuntime; fetcher?: typeof fetch; clock?: () => Date; env?: NodeJS.ProcessEnv } = {}) {
  const runtime = options.runtime ?? new FakeRuntime();
  const database = options.database ?? tempDatabase();
  const fetcher = options.fetcher ?? vi.fn(async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
  const service = new SourceRouterService({
    databaseUrl: database, runtime, fetcher, clock: options.clock,
    routerAgentId: 'fake-router', routerWorkspace: '/tmp/router',
    startRouterPoll: false, env: options.env ?? { AGENTDOCK_GITHUB_API_BASE_URL: 'http://github.test' }
  });
  services.push(service);
  return { service, runtime, database, fetcher: fetcher as unknown as ReturnType<typeof vi.fn> };
}

function createSource(service: SourceRouterService, overrides: Partial<SourceInstance> = {}) {
  const created = service.createSource({
    name: 'GitHub Issues', secrets: { signingSecret: 'secret', githubWebhookSecret: 'secret', actionToken: 'token' },
    config: { correlation: { mode: 'object' }, allowedRepos: ['acme/api'], actions: ['comment'], actionBaseUrl: 'http://github.test' },
    ...overrides
  });
  return created.id;
}

function envelope(sourceId: string, patch: JsonObject = {}) {
  const eventId = String(patch.eventId ?? 'evt_1');
  const stamp = '2026-11-07T10:00:00.000Z';
  return {
    specVersion: 'agentdock.source.v1', sourceId, eventId, eventType: String(patch.eventType ?? 'issue.created'),
    dedupeKey: String(patch.dedupeKey ?? `dedupe:${eventId}`), occurredAt: stamp,
    object: patch.object ?? { type: 'issue', id: 'acme/api#123', url: 'https://github.test/acme/api/issues/123', title: '启动时报错' },
    actor: patch.actor ?? { id: 'u_1', name: '张三', isBot: false },
    ...(patch.correlationKey ? { correlationKey: patch.correlationKey } : {}),
    payload: patch.payload ?? { repository: { full_name: 'acme/api' } },
    traceId: String(patch.traceId ?? `trace_${eventId}`)
  };
}

function signedHeaders(body: string, timestamp: string, github = false) {
  const signature = signatureFor(body, 'secret');
  return github ? { 'x-hub-signature-256': signature } : { 'x-agentdock-signature': signature, 'x-agentdock-timestamp': timestamp };
}

async function signedIngest(service: SourceRouterService, sourceId: string, value: JsonObject, github = false, timestamp = String(Date.parse('2026-11-07T10:00:01.000Z'))) {
  const body = JSON.stringify(value);
  return service.ingest({ sourceId, body, github, headers: signedHeaders(body, timestamp, github) });
}

describe('Source Router 存储与闭环', () => {
  it('启动旧库只新增表，唯一约束与关闭/重开状态机生效', () => {
    const database = tempDatabase();
    const initial = new SourceRouterStore(database);
    expect(initial.listSources()).toEqual([]);
    const source: SourceInstance = {
      id: 'src_1', name: 'test', kind: 'webhook', enabled: true,
      config: { correlation: { mode: 'object' } }, secretRefs: [], secrets: {},
      status: 'created', traceId: 'trace_1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
    };
    initial.saveSource(source);
    const first = initial.insertEvent({
      event: {
        sourceId: source.id, externalEventId: 'evt_1', eventType: 'issue.created', dedupeKey: 'd1',
        occurredAt: '2026-01-01T00:00:00.000Z', payload: '{}', traceId: 't1'
      }
    }, '2026-01-01T00:00:01.000Z');
    const duplicate = initial.insertEvent({
      event: {
        sourceId: source.id, externalEventId: 'evt_1', eventType: 'issue.created', dedupeKey: 'd1',
        occurredAt: '2026-01-01T00:00:00.000Z', payload: '{}', traceId: 't1'
      }
    }, '2026-01-01T00:00:02.000Z');
    expect(first.created).toBe(true); expect(duplicate.created).toBe(false);
    expect(initial.listEvents(source.id)).toHaveLength(1);
    const created = initial.createCase({
      id: 'case_1', sourceId: source.id, correlationKey: 'github:acme/api#1', title: 'issue', priority: 'normal',
      summary: '', object: '{}', status: 'open', createdAt: '2026-01-01T00:00:00.000Z'
    });
    expect(created.created).toBe(true);
    expect(initial.createCase({
      id: 'case_2', sourceId: source.id, correlationKey: 'github:acme/api#1', title: 'issue', priority: 'normal',
      summary: '', object: '{}', status: 'open', createdAt: '2026-01-01T00:00:01.000Z'
    }).created).toBe(false);
    expect(initial.appendCaseEvent({ caseId: 'case_1', sourceEventId: first.record.id, kind: 'source.event', summary: 'x', data: '{}' })).toBe(true);
    expect(initial.appendCaseEvent({ caseId: 'case_1', sourceEventId: first.record.id, kind: 'source.event', summary: 'x', data: '{}' })).toBe(false);
    const closed = { ...created.record, status: 'closed' as const, openKey: null, closedAt: '2026-01-01T00:01:00.000Z' };
    initial.saveCase(closed);
    expect(initial.createCase({
      id: 'case_3', sourceId: source.id, correlationKey: 'github:acme/api#1', title: 'issue', priority: 'normal',
      summary: '', object: '{}', status: 'open', createdAt: '2026-01-01T00:02:00.000Z'
    }).created).toBe(true);
    initial.close();

    const reopened = new SourceRouterStore(database);
    expect(reopened.getSource(source.id)?.id).toBe(source.id);
    expect(reopened.listCases()).toHaveLength(2);
    reopened.close();
  });

  it('校验签名、时间戳、大小、schema、未知/禁用 Source 并保持 secret 脱敏', async () => {
    const { service } = makeService({ clock: () => new Date('2026-11-07T10:00:01.000Z') });
    const sourceId = createSource(service);
    expect(service.getSource(sourceId).secrets).toBeUndefined();
    const body = JSON.stringify(envelope(sourceId));
    const signature = signatureFor(body, 'secret');
    expect((await service.ingest({ sourceId, body, headers: { 'x-agentdock-signature': signature, 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:00:01.000Z')) } })).accepted).toBe(true);
    for (const [headers, code] of [
      [{ 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:00:01.000Z')) }, 'INVALID_SIGNATURE'],
      [{ 'x-agentdock-signature': 'sha256=bad', 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:00:01.000Z')) }, 'INVALID_SIGNATURE'],
      [{ 'x-agentdock-signature': signature, 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:10:01.000Z')) }, 'STALE_EVENT'],
      [{ 'x-agentdock-signature': signature }, 'INVALID_TIMESTAMP']
    ] as const) {
      await expect(service.ingest({ sourceId, body, headers })).rejects.toMatchObject({ code });
    }
    await expect(service.ingest({ sourceId: 'src_missing', body, headers: { 'x-agentdock-signature': signature, 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:00:01.000Z')) } })).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    const huge = JSON.stringify(envelope(sourceId, { eventId: 'evt_huge', dedupeKey: 'dedupe:huge', payload: { text: 'x'.repeat(2_000_000) } }));
    await expect(service.ingest({ sourceId, body: huge, headers: {} })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const invalid = JSON.stringify({ specVersion: 'agentdock.source.v1' });
    await expect(service.ingest({ sourceId, body: invalid, headers: { 'x-agentdock-signature': signatureFor(invalid, 'secret'), 'x-agentdock-timestamp': String(Date.parse('2026-11-07T10:00:01.000Z')) } })).rejects.toMatchObject({ code: 'INVALID_EVENT' });
    service.setSourceEnabled(sourceId, false);
    await expect(signedIngest(service, sourceId, envelope(sourceId, { eventId: 'evt_disabled', dedupeKey: 'dedupe:disabled' }))).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
  });

  it('同一关联键连发与并发只产生一个 Case，重复事件不重复派发', async () => {
    const { service, runtime } = makeService({ clock: () => new Date('2026-11-07T10:00:01.000Z') });
    const sourceId = createSource(service);
    const first = envelope(sourceId, { eventId: 'evt_1', dedupeKey: 'd1', correlationKey: 'github:acme/api#123' });
    const duplicate = envelope(sourceId, { eventId: 'evt_1', dedupeKey: 'd1', correlationKey: 'github:acme/api#123' });
    const second = envelope(sourceId, { eventId: 'evt_2', dedupeKey: 'd2', eventType: 'issue_comment.created', correlationKey: 'github:acme/api#123' });
    const results = await Promise.all([signedIngest(service, sourceId, first), signedIngest(service, sourceId, duplicate), signedIngest(service, sourceId, second)]);
    expect(results.filter(item => item.duplicate)).toHaveLength(1);
    expect(service.listCases()).toHaveLength(1);
    expect(runtime.startCalls).toHaveLength(2);
    expect(runtime.dispatchCalls).toHaveLength(2);
    const detail = service.caseDetail(service.listCases()[0]!.id);
    expect(detail.events.filter(item => item.kind === 'source.event')).toHaveLength(2);
    expect(detail.sessions).toHaveLength(1);
    expect(runtime.startCalls[1]?.source).toBe('delegated');
    expect(runtime.startCalls[1]?.systemPrompt).toContain('不可信数据');
    expect(runtime.startCalls[1]?.systemPrompt).toContain(detail.id);
  });

  it('关闭 Case 后同 key 默认新建，reopen 配置则重开并保留时间线', async () => {
    const { service } = makeService({ clock: () => new Date('2026-11-07T10:00:01.000Z') });
    const sourceId = createSource(service);
    await signedIngest(service, sourceId, envelope(sourceId, { correlationKey: 'k1' }));
    const first = service.listCases()[0]!;
    service.closeCase(first.id, 'issue closed');
    await signedIngest(service, sourceId, envelope(sourceId, { eventId: 'evt_2', dedupeKey: 'd2', correlationKey: 'k1' }));
    expect(service.listCases()).toHaveLength(2);
    const reopenSource = createSource(service, { name: 'Reopen' });
    service.updateSource(reopenSource, { config: { correlation: { mode: 'object', reopen: true } } });
    await signedIngest(service, reopenSource, envelope(reopenSource, { correlationKey: 'k2' }));
    const second = service.listCases().find(item => item.sourceId === reopenSource)!;
    const before = service.caseDetail(second.id).events.length;
    service.closeCase(second.id, 'closed');
    await signedIngest(service, reopenSource, envelope(reopenSource, { eventId: 'evt_4', dedupeKey: 'd4', correlationKey: 'k2' }));
    expect(service.caseDetail(second.id).status).toBe('waiting');
    expect(service.caseDetail(second.id).events.length).toBeGreaterThan(before);
  });

  it('GitHub webhook 完成全链路、评论只发一次，回声和禁用 Source 不产生副作用', async () => {
    const { service, runtime, fetcher } = makeService({ clock: () => new Date('2026-11-07T10:00:01.000Z') });
    const sourceId = createSource(service);
    const github = {
      action: 'opened', repository: { full_name: 'acme/api' },
      issue: { number: 123, title: '启动时报错', html_url: 'https://github.test/acme/api/issues/123' },
      sender: { login: 'alice', type: 'User' }
    };
    const body = JSON.stringify(github);
    const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': signatureFor(body, 'secret'), 'x-github-delivery': 'delivery_1' };
    const first = await service.ingest({ sourceId, body, headers, github: true });
    expect(first.accepted).toBe(true); expect(first.duplicate).toBe(false);
    expect(first.decision?.decision).toBe('create');
    expect(service.listCases()).toHaveLength(1);
    expect(runtime.startCalls).toHaveLength(2);
    expect(runtime.dispatchCalls).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
    const taskId = runtime.dispatchCalls[0] ? 'task_1' : '';
    runtime.complete(runtime.startCalls[1] ? 'ses_2' : '', taskId);
    await service.tick();
    expect(service.inbox()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task.terminal' })]));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.dispatchCalls.filter(call => call.sessionId === 'ses_2')).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/repos/acme/api/issues/123/comments');
    const duplicate = await service.ingest({ sourceId, body, headers, github: true });
    expect(duplicate.duplicate).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const echo = {
      action: 'created', repository: { full_name: 'acme/api' },
      issue: { number: 123 }, comment: { body: '<!-- agentdock:case_1:sevt_1 --> done', html_url: 'https://github.test/x' },
      sender: { login: 'agentdock[bot]', type: 'Bot' }
    };
    const echoBody = JSON.stringify(echo);
    const echoResult = await service.ingest({ sourceId, body: echoBody, headers: { ...headers, 'x-github-event': 'issue_comment', 'x-hub-signature-256': signatureFor(echoBody, 'secret'), 'x-github-delivery': 'delivery_echo' }, github: true });
    expect(echoResult.reason).toContain('回声');
    expect(runtime.dispatchCalls.filter(call => call.sessionId === 'ses_2')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    service.setSourceEnabled(sourceId, false);
    const disabledBody = JSON.stringify({ ...github, sender: { login: 'alice', type: 'User' } });
    await expect(service.ingest({ sourceId, body: disabledBody, headers: { ...headers, 'x-hub-signature-256': signatureFor(disabledBody, 'secret'), 'x-github-delivery': 'delivery_disabled' }, github: true })).rejects.toMatchObject({ code: 'SOURCE_DISABLED' });
  });

  it('重启后事件、游标、Case 和 Inbox 保留，重放不重复派发/评论', async () => {
    const database = tempDatabase();
    const runtime = new FakeRuntime();
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 })) as unknown as typeof fetch;
    const clock = () => new Date('2026-11-07T10:00:01.000Z');
    const first = new SourceRouterService({
      databaseUrl: database, runtime, fetcher, routerAgentId: 'fake-router', startRouterPoll: false,
      env: { AGENTDOCK_GITHUB_API_BASE_URL: 'http://github.test' }, clock
    });
    services.push(first);
    const sourceId = createSource(first);
    const value = envelope(sourceId, { correlationKey: 'k1' });
    await signedIngest(first, sourceId, value);
    await first.close();
    const second = new SourceRouterService({
      databaseUrl: database, runtime, fetcher, routerAgentId: 'fake-router', startRouterPoll: false,
      env: { AGENTDOCK_GITHUB_API_BASE_URL: 'http://github.test' }, clock
    });
    services.push(second);
    expect(second.listEvents(sourceId)).toHaveLength(1);
    expect(second.checkpoint(sourceId).cursor).toBe('evt_1');
    expect(second.listCases()).toHaveLength(1);
    expect(second.inbox().length).toBeGreaterThan(0);
    const replay = await signedIngest(second, sourceId, value);
    expect(replay.duplicate).toBe(true);
    expect(second.listCases()).toHaveLength(1);
    expect(runtime.dispatchCalls).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('source test 与 router dry-run 不创建 Case/Session/Action', async () => {
    const { service, runtime, fetcher } = makeService();
    const sourceId = createSource(service);
    const fixture = JSON.stringify(envelope(sourceId, { correlationKey: 'dry-run-key' }));
    const result = await service.testFixture(sourceId, fixture);
    expect(result.decision.decision).toBe('notify');
    expect(service.listCases()).toHaveLength(0);
    expect(runtime.startCalls).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('无签名密钥的 Source 也能通过统一链路 dry-run', async () => {
    const { service } = makeService();
    const sourceId = service.createSource({ name: 'No secret' }).id;
    const fixture = JSON.stringify(envelope(sourceId, { correlationKey: 'no-secret-key' }));
    const result = await service.testFixture(sourceId, fixture);
    expect(result.decision.decision).toBe('notify');
    expect(result.correlationKey).toBe('no-secret-key');
    expect(service.listCases()).toHaveLength(0);
  });

  it('暂停状态持久化到重启后，审计记录不依赖 open Case', async () => {
    const database = tempDatabase();
    const first = makeService({ database }).service;
    expect(first.setRouterPaused(true, 'test').paused).toBe(true);
    expect(first.audits().map(item => item.kind)).toContain('router.paused');
    await first.close();
    const second = makeService({ database }).service;
    expect(second.isPaused()).toBe(true);
    expect(second.setRouterPaused(false, 'test').paused).toBe(false);
  });

  it('通用签名密钥与 GitHub webhook 密钥同时存在时，GitHub 事件使用后者验签', async () => {
    const { service } = makeService({
      clock: () => new Date('2026-11-07T10:00:01.000Z'),
      env: { AGENTDOCK_GITHUB_API_BASE_URL: 'http://github.test', SIGNING_SECRET: 'general-secret', GITHUB_WEBHOOK_SECRET: 'github-secret' }
    });
    const sourceId = service.createSource({
      name: 'GitHub dedicated', secretRefs: ['SIGNING_SECRET', 'GITHUB_WEBHOOK_SECRET'],
      config: { correlation: { mode: 'object' }, actions: [] }
    }).id;
    const body = JSON.stringify({
      action: 'opened', repository: { full_name: 'acme/api' },
      issue: { number: 9, title: 'dedicated secret' }, sender: { login: 'alice', type: 'User' }
    });
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'delivery_dedicated', 'x-hub-signature-256': signatureFor(body, 'github-secret') };
    await expect(service.ingest({ sourceId, body, headers, github: true })).resolves.toMatchObject({ accepted: true });
    const wrong = { ...headers, 'x-hub-signature-256': signatureFor(body, 'general-secret'), 'x-github-delivery': 'delivery_wrong' };
    await expect(service.ingest({ sourceId, body, headers: wrong, github: true })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('PR 与 issue 关闭事件保留具体 action，机器人事件只在自身回声时忽略', async () => {
    const { service } = makeService({ clock: () => new Date('2026-11-07T10:00:01.000Z') });
    const sourceId = createSource(service, { config: { correlation: { mode: 'object' }, actions: [], allowedEvents: [] } });
    const base = { repository: { full_name: 'acme/api' }, sender: { login: 'alice', type: 'User' } };
    const closed = JSON.stringify({ ...base, action: 'closed', issue: { number: 1, title: 'done' } });
    const closedResult = await service.ingest({ sourceId, body: closed, github: true, headers: { 'x-github-event': 'issues', 'x-github-delivery': 'd_closed', 'x-hub-signature-256': signatureFor(closed, 'secret') } });
    expect(closedResult.decision?.decision).toBe('create');
    const pull = JSON.stringify({ ...base, action: 'synchronize', pull_request: { number: 2, title: 'PR' } });
    const pullResult = await service.ingest({ sourceId, body: pull, github: true, headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'd_pr', 'x-hub-signature-256': signatureFor(pull, 'secret') } });
    expect(pullResult.decision?.decision).toBe('create');
    expect(service.listEvents(sourceId).map(item => item.eventType)).toEqual(expect.arrayContaining(['issue.closed', 'pr.synchronize']));
  });
});

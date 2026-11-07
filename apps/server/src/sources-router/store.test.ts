import { afterEach, describe, expect, it } from 'vitest';
import { SourceRouterStore } from './store.js';
import type { SourceActionRecord, SourceInstance } from './types.js';

const stores: SourceRouterStore[] = [];
function store() {
  const instance = new SourceRouterStore(':memory:');
  stores.push(instance);
  return instance;
}
afterEach(() => {
  for (const instance of stores.splice(0)) instance.close();
});

const now = '2026-11-08T00:00:00.000Z';
function source(overrides: Partial<SourceInstance> = {}): SourceInstance {
  return {
    id: 'src_test', name: 'Test', kind: 'webhook', enabled: true,
    config: { correlation: { mode: 'object' } }, secretRefs: [], secrets: {},
    status: 'created', traceId: 'trace_test', createdAt: now, updatedAt: now,
    ...overrides
  };
}

describe('SourceRouterStore events', () => {
  it('marks a created source as running after its first accepted event', () => {
    const repo = store();
    repo.saveSource(source());
    repo.insertEvent({
      event: {
        sourceId: 'src_test', externalEventId: 'evt_1', eventType: 'alert.opened', dedupeKey: 'alert:1',
        correlationKey: 'alert:1', occurredAt: now, payload: JSON.stringify({ event: {} }), raw: null,
        traceId: 'trace_1', causationId: null
      },
      checkpoint: 'cursor_1'
    }, now);
    expect(repo.getSource('src_test')?.status).toBe('running');
    expect(repo.checkpoint('src_test')).toBe('cursor_1');
  });

  it('de-duplicates by source and dedupe key', () => {
    const repo = store();
    repo.saveSource(source());
    const input = {
      event: {
        sourceId: 'src_test', externalEventId: 'evt_1', eventType: 'alert.opened', dedupeKey: 'alert:1',
        correlationKey: 'alert:1', occurredAt: now, payload: '{}', raw: null, traceId: 'trace_1', causationId: null
      }
    };
    expect(repo.insertEvent(input, now).created).toBe(true);
    expect(repo.insertEvent(input, now).created).toBe(false);
  });
});

describe('SourceRouterStore inbox', () => {
  it('finds due pending entries without scanning only the newest thousand', () => {
    const repo = store();
    const base = { routerSessionId: 'router_1', caseId: null, kind: 'event', payload: '{}', dispatchedAt: null };
    repo.insertInbox({ ...base, id: 'inbox_due', dedupeKey: 'due', status: 'pending', availableAt: '2026-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z' });
    repo.insertInbox({ ...base, id: 'inbox_later', dedupeKey: 'later', status: 'pending', availableAt: '2026-11-09T00:00:00.000Z', createdAt: '2026-11-08T00:00:00.000Z' });
    for (let index = 0; index < 1_001; index += 1) {
      repo.insertInbox({ ...base, id: `inbox_done_${index}`, dedupeKey: `done-${index}`, status: 'dispatched', availableAt: now, createdAt: now, dispatchedAt: now });
    }
    expect(repo.dueInbox('router_1', now).map(item => item.id)).toEqual(['inbox_due']);
  });
});

describe('SourceRouterStore actions', () => {  function action(overrides: Partial<SourceActionRecord> = {}): SourceActionRecord {
    return {
      id: 'action_1', sourceId: 'src_test', caseId: 'case_1', actionType: 'comment', target: 'acme/api#1',
      payload: '{}', idempotencyKey: 'case_1:evt_1:comment', status: 'pending', attempts: 0,
      lastError: null, createdAt: now, updatedAt: now, ...overrides
    };
  }

  it('counts one attempt per finished run, not both running and failed', () => {
    const repo = store();
    repo.insertAction(action());
    repo.markActionRunning('action_1', now);
    expect(repo.actionsForCase('case_1')[0]?.attempts).toBe(0);
    repo.setActionStatus('action_1', 'failed', now, 'HTTP 500');
    expect(repo.actionsForCase('case_1')[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('claims an action once and recovers orphaned running actions after restart', () => {
    const repo = store();
    repo.insertAction(action());
    expect(repo.markActionRunning('action_1', now)).toBe(true);
    expect(repo.markActionRunning('action_1', now)).toBe(false);
    expect(repo.recoverRunningActions(now)).toBe(1);
    const recovered = repo.actionsForCase('case_1')[0];
    expect(recovered).toMatchObject({ status: 'failed', lastError: '进程重启，动作已重新排队' });
    expect(repo.markActionRunning('action_1', now)).toBe(true);
  });

  it('re-queues throttled actions instead of leaving them stuck', () => {
    const repo = store();
    repo.insertAction(action({ status: 'throttled' }));
    expect(repo.markActionRunning('action_1', now)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { Session } from '@agent-dock/agent-dock-shared';
import { assertDelegatedControl, extendedSessionPeerIds } from './session-peers.js';

const session = (id: string, source?: string, sourceId?: string): Session => ({
  id, agentId: 'fake', state: 'idle', cwd: '/tmp', ...(source ? { source } : {}),
  ...(sourceId ? { sourceId } : {}), runId: `run_${id}`,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
});

describe('delegated session peers', () => {
  const sessions = [
    session('router'), session('worker_a', 'delegated', 'router'),
    session('worker_b', 'delegated', 'router'), session('unrelated')
  ];
  it('allows Router and its Workers to reach each other only', () => {
    expect(extendedSessionPeerIds(sessions, 'router', [])).toEqual(['worker_a', 'worker_b']);
    expect(extendedSessionPeerIds(sessions, 'worker_a', [])).toEqual(['router']);
    expect(extendedSessionPeerIds(sessions, 'unrelated', [])).toEqual([]);
    expect(extendedSessionPeerIds(sessions, 'worker_a', ['side_1'])).toEqual(['side_1', 'router']);
  });
  it('rejects unrelated sessions without leaking their content', () => {
    const router = sessions[0]!;
    const unrelated = sessions[3]!;
    expect(() => assertDelegatedControl(router, unrelated, [])).toThrowError('目标会话不在当前 Router 的委派关系内');
    expect(() => assertDelegatedControl(router, sessions[1]!, [])).not.toThrow();
  });
});

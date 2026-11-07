import { describe, expect, it } from 'vitest';
import { signatureFor, verifyIngress, IngressError } from './ingress.js';
import type { SourceInstance } from './types.js';

const now = new Date('2026-11-08T00:00:00.000Z');

function source(overrides: Partial<SourceInstance> = {}): SourceInstance {
  return {
    id: 'src_test', name: 'Test', kind: 'webhook', enabled: true,
    config: { correlation: { mode: 'object' } }, secretRefs: [],
    secrets: { signingSecret: 'generic-secret', githubWebhookSecret: 'github-secret' },
    status: 'running', traceId: 'trace_test',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    ...overrides
  };
}

const githubBody = JSON.stringify({
  action: 'opened',
  repository: { full_name: 'acme/api' },
  issue: { number: 7, title: 'Broken', html_url: 'https://github.test/acme/api/issues/7' },
  sender: { login: 'alice', type: 'User' }
});

const genericBody = JSON.stringify({
  specVersion: 'agentdock.source.v1', sourceId: 'src_test', eventId: 'evt_1', eventType: 'alert.opened',
  dedupeKey: 'alert:1', occurredAt: now.toISOString(), object: { type: 'alert', id: 'alert_1' },
  payload: {}, traceId: 'trace_1'
});

describe('verifyIngress signatures', () => {
  it('uses the GitHub webhook secret for GitHub payloads', () => {
    const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': signatureFor(githubBody, 'github-secret') };
    const result = verifyIngress({ source: source(), sourceId: 'src_test', body: githubBody, headers, github: true, now });
    expect(result.envelope.eventType).toBe('issue.created');
    expect(result.envelope.correlationKey).toBe('github:acme/api#7');
  });

  it('does not accept a GitHub payload signed with the generic signing secret', () => {
    const headers = { 'x-github-event': 'issues', 'x-hub-signature-256': signatureFor(githubBody, 'generic-secret') };
    expect(() => verifyIngress({ source: source(), sourceId: 'src_test', body: githubBody, headers, github: true, now }))
      .toThrow(IngressError);
  });

  it('uses signingSecret for custom envelopes', () => {
    const headers = {
      'x-agentdock-signature': signatureFor(genericBody, 'generic-secret'),
      'x-agentdock-timestamp': String(now.getTime())
    };
    const result = verifyIngress({ source: source(), sourceId: 'src_test', body: genericBody, headers, now });
    expect(result.envelope.eventId).toBe('evt_1');
    expect(result.correlationKey).toBe('alert:alert_1');
  });
});

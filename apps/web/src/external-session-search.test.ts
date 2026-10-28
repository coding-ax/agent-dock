import { describe, expect, it } from 'vitest';
import { matchesExternalSession, sessionIdFromQuery } from './external-session-search.js';

const session = { sessionId: '01a124f0-357b-7a21-8db4-3260e2238d00', cwd: '/Users/me/Documents/Codex', title: '看看这批改动的状态' };

describe('sessionIdFromQuery', () => {
  it('从 codex 深链里抠出 uuid', () => {
    expect(sessionIdFromQuery('codex://threads/01a124f0-357b-7a21-8db4-3260e2238d00')).toBe('01a124f0-357b-7a21-8db4-3260e2238d00');
  });
  it('裸 uuid 原样返回（小写）', () => {
    expect(sessionIdFromQuery('01A124F0-357B-7A21-8DB4-3260E2238D00')).toBe('01a124f0-357b-7a21-8db4-3260e2238d00');
  });
  it('前缀按原文处理', () => {
    expect(sessionIdFromQuery('01a124f0')).toBe('01a124f0');
  });
  it('空串返回 undefined', () => {
    expect(sessionIdFromQuery('   ')).toBeUndefined();
  });
});

describe('matchesExternalSession', () => {
  it('深链命中会话 id', () => {
    expect(matchesExternalSession(session, 'codex://threads/01a124f0-357b-7a21-8db4-3260e2238d00')).toBe(true);
  });
  it('裸 id 与前缀命中', () => {
    expect(matchesExternalSession(session, '01a124f0-357b-7a21-8db4-3260e2238d00')).toBe(true);
    expect(matchesExternalSession(session, '01a124f0')).toBe(true);
  });
  it('标题与目录仍可命中，不相关词不命中', () => {
    expect(matchesExternalSession(session, '改动')).toBe(true);
    expect(matchesExternalSession(session, 'Documents/Codex')).toBe(true);
    expect(matchesExternalSession(session, 'zzz-nope')).toBe(false);
  });
  it('空关键词全部命中', () => {
    expect(matchesExternalSession(session, '  ')).toBe(true);
  });
});

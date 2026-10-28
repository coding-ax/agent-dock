import { describe, expect, it } from 'vitest';
import {
  defaultMasterTokenTtlMs,
  isLocalOwnerRequest,
  isLoopbackAddress,
  isLoopbackHostHeader,
  issueMasterToken,
  issueSessionToken,
  parseCookieHeader,
  sessionTokenAllows,
  verifyWebToken,
  webAccessCookieName,
  webAccessCookieNameFor,
  webAccessCookieNames,
  webAccessSessionCookieName
} from './web-access.js';

describe('web-access tokens', () => {
  const secret = 'test-secret-32-bytes-aaaaaaaaaa';
  const otherSecret = 'other-secret-32-bytes-bbbbbbbb';

  it('round-trips a session token and binds it to one session', () => {
    const token = issueSessionToken('ses_1', secret);
    const claim = verifyWebToken(token, secret);
    expect(claim?.kind).toBe('session');
    expect(claim?.sessionId).toBe('ses_1');
    expect(sessionTokenAllows('GET', '/api/sessions/ses_1/events', claim!.sessionId!)).toBe(true);
    expect(sessionTokenAllows('POST', '/api/sessions/ses_1/send', claim!.sessionId!)).toBe(true);
    expect(sessionTokenAllows('GET', '/api/sessions/ses_2/events', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('GET', '/api/lark/config', claim!.sessionId!)).toBe(true);
    expect(sessionTokenAllows('PUT', '/api/lark/config', claim!.sessionId!)).toBe(false);
    // 模型端点面板一打开就会读端点配置：读放行，改/试跑（要带密钥向外部地址发请求）不放行。
    expect(sessionTokenAllows('GET', '/api/llm', claim!.sessionId!)).toBe(true);
    expect(sessionTokenAllows('PUT', '/api/llm', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('DELETE', '/api/llm', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('POST', '/api/llm/test', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('GET', '/api/codex/usage', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('GET', '/api/claude/usage', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('GET', '/api/cursor/usage', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('POST', '/api/system/select-directory', claim!.sessionId!)).toBe(false);
    expect(sessionTokenAllows('POST', '/api/sessions', claim!.sessionId!)).toBe(false);
  });

  it('lets a session token render the session page without hitting the deny panel', () => {
    const sid = 'ses_1';
    // 打开会话页时 SPA 会无条件拉这几个全局只读接口；漏掉任一个都会把整页打成「访问被拒」，
    // 让持有效卡片链接的用户被再要一次密码。
    for (const pathname of ['/api/sessions', '/api/agents', '/api/agents/codex/models', '/api/lark/config', '/api/system/capabilities', '/api/system/skills', '/api/system/update', '/api/llm']) {
      expect(sessionTokenAllows('GET', pathname, sid)).toBe(true);
    }
    // 定时任务只放行显式按本会话过滤的查询：不带 sessionId 的列表会返回所有会话的定时任务。
    expect(sessionTokenAllows('GET', '/api/schedules', sid, new URLSearchParams(`sessionId=${sid}`))).toBe(true);
    expect(sessionTokenAllows('GET', '/api/schedules', sid, new URLSearchParams('sessionId=ses_2'))).toBe(false);
    expect(sessionTokenAllows('GET', '/api/schedules', sid, new URLSearchParams())).toBe(false);
    expect(sessionTokenAllows('GET', '/api/schedules', sid)).toBe(false);
    expect(sessionTokenAllows('POST', '/api/schedules', sid, new URLSearchParams(`sessionId=${sid}`))).toBe(false);
    // 触发自升级会 spawn npm install -g 并重启 daemon，只有 master 能进。
    expect(sessionTokenAllows('POST', '/api/system/update', sid)).toBe(false);
  });

  it('rejects forged and expired tokens', () => {
    expect(verifyWebToken(issueSessionToken('ses_1', secret), otherSecret)).toBeNull();
    expect(verifyWebToken('garbage', secret)).toBeNull();
    const expired = issueSessionToken('ses_1', secret, -1);
    expect(verifyWebToken(expired, secret)).toBeNull();
  });

  it('master token reaches management endpoints but session token does not', () => {
    const master = verifyWebToken(issueMasterToken(secret), secret);
    expect(master?.kind).toBe('master');
    // master 在中间件里直接放行，不需要走 sessionTokenAllows
    const session = verifyWebToken(issueSessionToken('ses_1', secret, 1000), secret)!;
    expect(sessionTokenAllows('GET', '/api/system/capabilities', session.sessionId!)).toBe(true);
    expect(sessionTokenAllows('POST', '/api/system/select-directory', session.sessionId!)).toBe(false);
  });

  it('parses cookies and exposes a stable cookie name / master ttl', () => {
    expect(parseCookieHeader(`foo=1; ${webAccessCookieName}=abc%20%3D; bar=2`, webAccessCookieName)).toBe('abc =');
    expect(parseCookieHeader(undefined, webAccessCookieName)).toBeUndefined();
    expect(defaultMasterTokenTtlMs).toBeGreaterThan(0);
  });
});

describe('local owner detection', () => {
  it('accepts loopback sources including the IPv6-mapped form', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.53')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.9')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.9')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('requires a loopback Host header so a rebound domain cannot ride along', () => {
    expect(isLoopbackHostHeader('localhost:4310')).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1:4310')).toBe(true);
    expect(isLoopbackHostHeader('[::1]:4310')).toBe(true);
    expect(isLoopbackHostHeader('evil.example.com:4310')).toBe(false);
    expect(isLoopbackHostHeader('192.168.1.9:4310')).toBe(false);
  });

  it('refuses cross-site and same-site origins, allows direct navigation and non-browser clients', () => {
    const base = { address: '127.0.0.1', host: 'localhost:4310' };
    expect(isLocalOwnerRequest({ ...base, fetchSite: undefined })).toBe(true);
    expect(isLocalOwnerRequest({ ...base, fetchSite: 'none' })).toBe(true);
    expect(isLocalOwnerRequest({ ...base, fetchSite: 'same-origin' })).toBe(true);
    expect(isLocalOwnerRequest({ ...base, fetchSite: 'cross-site' })).toBe(false);
    expect(isLocalOwnerRequest({ ...base, fetchSite: 'same-site' })).toBe(false);
    expect(isLocalOwnerRequest({ ...base, fetchSite: 'Cross-Site' })).toBe(false);
    expect(isLocalOwnerRequest({ address: '192.168.1.9', host: '192.168.1.9:4310' })).toBe(false);
  });

  it('splits the cookie name so a session link cannot demote the console credential', () => {
    expect(webAccessCookieNameFor('master')).toBe(webAccessCookieName);
    expect(webAccessCookieNameFor('session')).toBe(webAccessSessionCookieName);
    expect(webAccessCookieNames).toContain(webAccessCookieName);
    expect(webAccessCookieNames).toContain(webAccessSessionCookieName);
  });
});

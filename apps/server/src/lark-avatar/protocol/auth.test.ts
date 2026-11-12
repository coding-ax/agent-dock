import { describe, expect, it, vi } from 'vitest';
import { CookieJar, validateCredentials } from './auth.js';

describe('Lark cookie jar', () => {
  it('merges multiple set-cookie headers and emits a cookie header', () => {
    const jar = new CookieJar({ existing: 'value' });
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/; HttpOnly');
    headers.append('set-cookie', 'passport_web_did=device-1; Path=/');
    jar.absorb(headers);
    expect(jar.toObject()).toEqual({
      existing: 'value',
      session: 'abc',
      passport_web_did: 'device-1'
    });
    expect(jar.header()).toContain('session=abc');
  });

  it('follows tenant redirects with the session cookie when reading the web appKey', async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect; cookie?: string }> = [];
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, redirect: init?.redirect, cookie: headers?.cookie });
      if (url.includes('/suite/passport/frontier_ticket/')) return json({ ticket: 'ticket-1' });
      if (url.includes('/accounts/web/user')) {
        return json({ data: { user: { id: 42, name: '测试用户' } } });
      }
      if (url === 'https://open-dev.feishu.cn/messenger/') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://tenant.feishu.cn/messenger/' }
        });
      }
      if (url === 'https://tenant.feishu.cn/messenger/') {
        return new Response('<script>window.__meta={appKey: "tenant-key", teaAppId: "123456"}</script>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        });
      }
      if (url.includes('/accounts/csrf')) return new Response('', { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await validateCredentials({
      region: 'feishu',
      cookies: { session: 'session-1', passport_web_did: 'device-1' },
      fetcher: fetcher as unknown as typeof fetch
    });

    expect(result.credentials).toMatchObject({ appKey: 'tenant-key', webAppId: '123456', userId: '42' });
    const pageCalls = calls.filter(call => call.url.includes('/messenger/'));
    expect(pageCalls).toHaveLength(2);
    expect(pageCalls.every(call => call.redirect === 'manual')).toBe(true);
    expect(pageCalls[1]?.cookie).toContain('session=session-1');
  });
});

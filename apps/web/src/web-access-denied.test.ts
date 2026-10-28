import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AUTH_STATUS_QUERY_KEY, localBypassUrl, shouldCancelOnAccessDenied } from './WebAccessDeniedPanel';

describe('WebAccessDeniedPanel local bypass hint', () => {
  it('keeps the current port so a forwarded/tunnelled address only needs the host swapped', () => {
    expect(localBypassUrl('14310')).toBe('http://localhost:14310/');
    expect(localBypassUrl('4310')).toBe('http://localhost:4310/');
    expect(localBypassUrl('')).toBe('http://localhost/');
  });
});

describe('WebAccessDeniedPanel query cancellation race', () => {
  it('keeps in-flight auth-status query alive when later 401/403 responses trigger cancelQueries', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveAuthStatus!: (value: { passwordEnabled: boolean }) => void;
    const authStatusPromise = new Promise<{ passwordEnabled: boolean }>(resolve => {
      resolveAuthStatus = resolve;
    });

    // 模拟第 1 个 401 后 WebAccessDeniedPanel 挂载并发起 /api/auth/status 请求（尚在途中）
    const fetchAuthStatus = qc.fetchQuery({
      queryKey: AUTH_STATUS_QUERY_KEY,
      queryFn: () => authStatusPromise
    });

    let otherCancelled = false;
    const fetchSessions = qc.fetchQuery({
      queryKey: ['sessions'],
      queryFn: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          otherCancelled = true;
          reject(new Error('aborted'));
        });
      })
    }).catch(() => undefined);

    // 模拟第 2~6 个并发 API 的 401 响应陆续回来，再次触发 agentdock:web-access-denied 的 cancelQueries
    await qc.cancelQueries({ predicate: shouldCancelOnAccessDenied });
    await fetchSessions;

    // 随后 /api/auth/status 正常返回 { passwordEnabled: true }
    resolveAuthStatus({ passwordEnabled: true });
    const data = await fetchAuthStatus;

    expect(otherCancelled).toBe(true);
    expect(data).toEqual({ passwordEnabled: true });
    expect(qc.getQueryData(AUTH_STATUS_QUERY_KEY)).toEqual({ passwordEnabled: true });
  });
});

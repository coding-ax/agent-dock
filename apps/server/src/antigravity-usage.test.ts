import { describe, expect, it } from 'vitest';
import { antigravitySpawnEnv, normalizeAntigravityUsage, readAntigravityUsage } from './antigravity-usage.js';

describe('Antigravity 账号额度', () => {
  it('归一化多模型组额度，按 5 小时 -> 7 天排序并计算已用百分比与重置时间', () => {
    const usage = normalizeAntigravityUsage({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          tier: { name: 'Google AI Ultra' },
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.96, reset_time: '2026-11-30T05:17:44Z' },
                { id: 'gemini-5h', window: '5h', remaining_fraction: 0.985, reset_time: '2026-11-23T20:17:44Z' }
              ]
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-30T15:49:06Z' },
                { id: '3p-5h', window: '5h', remaining_fraction: 0.25, reset_time: '2026-11-23T20:49:06Z' }
              ]
            }
          ]
        }
      }
    }, 1000);

    expect(usage).toEqual({
      status: 'available',
      plan: 'Google AI Ultra',
      source: 'Antigravity CLI',
      checkedAt: 1000,
      windows: [
        { label: 'Gemini · 5 小时', usedPercent: 1.5, resetsAt: 1795465064 },
        { label: 'Gemini · 7 天', usedPercent: 4, resetsAt: 1796015864 },
        { label: 'Claude / GPT · 5 小时', usedPercent: 75, resetsAt: 1795466946 },
        { label: 'Claude / GPT · 7 天', usedPercent: 0, resetsAt: 1796053746 }
      ]
    });
  });

  it('无有效窗口或状态非 SUCCESS 时优雅降级为 unavailable', () => {
    expect(normalizeAntigravityUsage({ status: 'SUCCESS', command: { data: { groups: [] } } }, 1).status).toBe('unavailable');
    expect(normalizeAntigravityUsage({ status: 'SUCCESS', command: { data: { groups: [{ name: 'Gemini Models', buckets: [{ remaining_fraction: -0.1 }] }] } } }, 1).status).toBe('unavailable');

    const unauth = normalizeAntigravityUsage({ status: 'ERROR', error: { message: 'UNAUTHENTICATED (code 401)' } }, 2);
    expect(unauth.status).toBe('unavailable');
    expect(unauth.reason).toContain('尚未登录');

    const authFailed = normalizeAntigravityUsage({ status: 'ERROR', error: 'authentication failed or timed out' }, 2);
    expect(authFailed.status).toBe('unavailable');
    expect(authFailed.reason).toContain('尚未登录');

    const otherErr = normalizeAntigravityUsage({ status: 'ERROR', error: 'internal error' }, 3);
    expect(otherErr.status).toBe('unavailable');
    expect(otherErr.reason).not.toContain('internal error');
  });

  it('agy 不存在时自动回退到 antigravity，并兼容前置日志行后的 JSON', async () => {
    const called: string[] = [];
    const usage = await readAntigravityUsage(async (cmd) => {
      called.push(cmd);
      if (cmd === 'agy') {
        const err = new Error('spawn agy ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        stdout: 'warning: minor notice\n' + JSON.stringify({
          status: 'SUCCESS',
          command: {
            data: {
              groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.6 }] }]
            }
          }
        }),
        stderr: ''
      };
    });

    expect(called).toEqual(['agy', 'antigravity']);
    expect(usage.status).toBe('available');
    expect(usage.windows).toEqual([{ label: 'Gemini · 5 小时', usedPercent: 40 }]);
  });

  it('处理 CLI 缺失、超时、未登录与无效 JSON 异常', async () => {
    const missing = await readAntigravityUsage(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(missing.status).toBe('unavailable');
    expect(missing.reason).toContain('找不到 Antigravity CLI');

    const timedOut = await readAntigravityUsage(async () => {
      const err = new Error('timeout') as NodeJS.ErrnoException & { killed?: boolean };
      err.killed = true;
      throw err;
    });
    expect(timedOut.status).toBe('unavailable');
    expect(timedOut.reason).toContain('超时');

    const unauth = await readAntigravityUsage(async () => {
      const err = new Error('Command failed') as NodeJS.ErrnoException & { stderr?: string };
      err.stderr = 'Authentication required: secret-token-123';
      throw err;
    });
    expect(unauth.status).toBe('unavailable');
    expect(unauth.reason).toContain('尚未登录');
    expect(unauth.reason).not.toContain('secret-token-123');

    const invalid = await readAntigravityUsage(async () => ({ stdout: 'not-json', stderr: '' }));
    expect(invalid.status).toBe('unavailable');
    expect(invalid.reason).toContain('无效数据');
  });

  it('沙箱替换 HOME 时仍复用系统真实 HOME 并禁止子进程拉起浏览器', async () => {
    const env = antigravitySpawnEnv({ HOME: '/repo/.agentdock/dev/home', PATH: '/usr/bin', BROWSER: 'open' }, '/Users/alice');
    expect(env.HOME).toBe('/Users/alice');
    expect(env.BROWSER).toBe('true');
    expect(env.NO_BROWSER).toBe('1');
    expect(env.PATH).toBe('/usr/bin');

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    await readAntigravityUsage(async (_cmd, _args, options) => {
      capturedEnv = options.env;
      return {
        stdout: JSON.stringify({
          status: 'SUCCESS',
          command: { data: { groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.9 }] }] } }
        }),
        stderr: ''
      };
    });
    expect(capturedEnv?.BROWSER).toBe('true');
    expect(capturedEnv?.NO_BROWSER).toBe('1');
    expect(capturedEnv?.HOME).toBeTruthy();
  });
});

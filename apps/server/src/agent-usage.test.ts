import { describe, expect, it } from 'vitest';
import { normalizeClaudeUsage } from './claude-usage.js';
import { normalizeCursorUsage } from './cursor-usage.js';

describe('Agent 账号额度', () => {
  it('Cursor 优先采用仪表盘百分比，而非 used / limit', () => {
    const usage = normalizeCursorUsage({ billingCycleStart: '2026-09-01T00:00:00Z', billingCycleEnd: '2026-10-01T00:00:00Z', membershipType: 'pro', individualUsage: {
      plan: { enabled: true, autoPercentUsed: 6, apiPercentUsed: 5 }, overall: { enabled: true, used: 32, limit: 100 }
    } }, 123);
    expect(usage).toMatchObject({ status: 'available', plan: 'pro', checkedAt: 123, windows: [{ label: 'Auto', usedPercent: 6 }, { label: 'API', usedPercent: 5 }] });
    expect(usage.windows[0].resetsAt).toBe(1790812800);
  });

  it('Cursor 旧版响应使用有效的额度上限', () => {
    const usage = normalizeCursorUsage({ billingCycleStart: '2026-09-01', individualUsage: { overall: { enabled: true, used: 2, limit: 10 } } });
    expect(usage.windows).toMatchObject([{ label: '个人', usedPercent: 20 }]);
  });

  it('Claude 读取 statusline 和 OnWatch 两种快照', () => {
    expect(normalizeClaudeUsage({ quotas: { five_hour: { used_percent: 40, resets_at: '2026-09-24T15:00:00Z' } } }).windows).toMatchObject([{ label: '5 小时', usedPercent: 40 }]);
    expect(normalizeClaudeUsage({ rate_limits: { seven_day: { remaining_percentage: 25, resets_at: 1790445611 } } }).windows).toMatchObject([{ label: '7 天', usedPercent: 75 }]);
  });

  it('无有效额度时不把空快照展示成 0%', () => {
    expect(normalizeClaudeUsage({ quotas: { five_hour: {} } }).status).toBe('unavailable');
    expect(normalizeCursorUsage({ billingCycleStart: '2026-09-01' }).status).toBe('unavailable');
  });
});

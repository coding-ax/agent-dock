import { describe, expect, it } from 'vitest';
import { normalizeCodexUsage } from './codex-usage.js';

describe('Codex 账号额度', () => {
  it('按真实时长识别窗口，不依赖 primary/secondary 的顺序', () => {
    const usage = normalizeCodexUsage({ rateLimitsByLimitId: { codex: {
      planType: 'pro',
      primary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 2000000000 },
      secondary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 }
    } } }, 1000);
    expect(usage).toEqual({ status: 'available', plan: 'pro', checkedAt: 1000, windows: [
      { label: '5 小时', usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
      { label: '7 天', usedPercent: 80, windowDurationMins: 10080, resetsAt: 2000000000 }
    ] });
  });

  it('支持旧版单桶，并拒绝缺失/无效窗口', () => {
    expect(normalizeCodexUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 101, windowDurationMins: 300 } } }, 1).windows[0]?.usedPercent).toBe(100);
    expect(normalizeCodexUsage({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 0 } } }, 1).status).toBe('unavailable');
    expect(normalizeCodexUsage({}, 1).status).toBe('unavailable');
  });
});

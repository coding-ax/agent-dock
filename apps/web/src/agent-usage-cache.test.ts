import { describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from './api';
import {
  AGENT_USAGE_CACHE_TTL_MS,
  formatQuotaResetCountdown,
  formatUpdatedAt,
  isUsageCacheFresh,
  loadAgentUsage,
  quotaUsageTone,
  readCachedAgentUsage,
  readFreshCachedAgentUsage,
  resolveQuotaAgentId,
  summarizeQuotaTooltip,
  writeCachedAgentUsage,
  type UsageCacheStorage
} from './agent-usage-cache';

function createMemoryStorage(): UsageCacheStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); }
  };
}

const sampleUsage = (usedPercent = 28, checkedAt = 1_700_000_000_000): AgentUsage => ({
  status: 'available',
  plan: 'Pro',
  source: 'Antigravity CLI',
  checkedAt,
  windows: [
    { label: 'Gemini · 5 小时', usedPercent, resetsAt: Math.floor(checkedAt / 1000) + 3 * 3600 + 20 * 60 },
    { label: 'Claude / GPT · 7 天', usedPercent: 14, resetsAt: Math.floor(checkedAt / 1000) + 4 * 86400 + 2 * 3600 }
  ]
});

describe('agent-usage-cache 5 分钟前端缓存与手动刷新', () => {
  it('TTL 固定为 5 分钟，支持识别 4 个可查询额度的 Agent', () => {
    expect(AGENT_USAGE_CACHE_TTL_MS).toBe(5 * 60_000);
    expect(resolveQuotaAgentId('codex')).toBe('codex');
    expect(resolveQuotaAgentId('claude')).toBe('claude');
    expect(resolveQuotaAgentId('cursor')).toBe('cursor');
    expect(resolveQuotaAgentId('antigravity')).toBe('antigravity');
    expect(resolveQuotaAgentId(' Codex ')).toBe('codex');
    expect(resolveQuotaAgentId('gemini')).toBeUndefined();
    expect(resolveQuotaAgentId('custom-agent')).toBeUndefined();
    expect(resolveQuotaAgentId(undefined)).toBeUndefined();
  });

  it('5 分钟内命中缓存不重复请求服务端，超过 5 分钟自动重新拉取并更新时间戳', async () => {
    const storage = createMemoryStorage();
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const fetcher = vi.fn(async (_id, _refresh) => sampleUsage(currentTime === 1_700_000_000_000 ? 25 : 42, currentTime));

    // 首次拉取：缓存未命中，调用 fetcher(refresh=false)
    const first = await loadAgentUsage('antigravity', { storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenLastCalledWith('antigravity', false);
    expect(first.fromCache).toBe(false);
    expect(first.updatedAt).toBe(1_700_000_000_000);
    expect(first.data.windows[0]?.usedPercent).toBe(25);

    // 4 分 59 秒后：仍在 5 分钟缓存期内，不发网络请求
    currentTime += AGENT_USAGE_CACHE_TTL_MS - 1_000;
    const second = await loadAgentUsage('antigravity', { storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
    expect(second.updatedAt).toBe(1_700_000_000_000);
    expect(second.data.windows[0]?.usedPercent).toBe(25);

    // 满 5 分钟整：缓存过期，重新请求服务端并覆盖缓存
    currentTime = 1_700_000_000_000 + AGENT_USAGE_CACHE_TTL_MS;
    const third = await loadAgentUsage('antigravity', { storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('antigravity', false);
    expect(third.fromCache).toBe(false);
    expect(third.updatedAt).toBe(currentTime);
    expect(third.data.windows[0]?.usedPercent).toBe(42);
  });

  it('手动刷新（refresh: true）无视 5 分钟缓存，强制走服务端刷新并重置缓存时间', async () => {
    const storage = createMemoryStorage();
    let currentTime = 1_700_000_000_000;
    const now = () => currentTime;
    const fetcher = vi.fn(async (_id, refresh) => sampleUsage(refresh ? 66 : 20, currentTime));

    await loadAgentUsage('codex', { storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 仅过 30 秒，手动刷新必须跳过前端缓存并传 refresh=true
    currentTime += 30_000;
    const refreshed = await loadAgentUsage('codex', { refresh: true, storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith('codex', true);
    expect(refreshed.fromCache).toBe(false);
    expect(refreshed.updatedAt).toBe(1_700_000_030_000);
    expect(refreshed.data.windows[0]?.usedPercent).toBe(66);

    // 紧接着常规读取应命中刚刚刷新的新缓存
    currentTime += 10_000;
    const cached = await loadAgentUsage('codex', { storage, now, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cached.fromCache).toBe(true);
    expect(cached.updatedAt).toBe(1_700_000_030_000);
    expect(cached.data.windows[0]?.usedPercent).toBe(66);
  });

  it('坏 JSON 或过期条目会被安全忽略，请求抛错不会覆盖既有缓存', async () => {
    const storage = createMemoryStorage();
    storage.setItem('agentdock.agent_usage.v1:claude', '{broken-json');
    expect(readCachedAgentUsage('claude', storage)).toBeUndefined();

    const base = 1_700_000_000_000;
    writeCachedAgentUsage('claude', sampleUsage(33, base), storage, base);
    expect(isUsageCacheFresh(readCachedAgentUsage('claude', storage), base + 60_000)).toBe(true);
    expect(readFreshCachedAgentUsage('claude', storage, base + AGENT_USAGE_CACHE_TTL_MS)).toBeUndefined();

    const failingFetcher = vi.fn(async () => { throw new Error('network down'); });
    await expect(loadAgentUsage('claude', { refresh: true, storage, now: () => base + 60_000, fetcher: failingFetcher }))
      .rejects.toThrow('network down');
    // 失败后旧缓存仍完好保留
    expect(readCachedAgentUsage('claude', storage)?.data.windows[0]?.usedPercent).toBe(33);
  });

  it('格式化重置倒计时、更新时间、阈值色阶与外层提示摘要', () => {
    const now = new Date(2026, 10, 27, 2, 0, 0).getTime();
    const sec = Math.floor(now / 1000);

    expect(formatQuotaResetCountdown(sec - 10, now)).toBe('即将重置');
    expect(formatQuotaResetCountdown(sec + 30, now)).toBe('1 分钟内重置');
    expect(formatQuotaResetCountdown(sec + 25 * 60, now)).toBe('25 分钟后重置');
    expect(formatQuotaResetCountdown(sec + 3 * 3600 + 15 * 60, now)).toBe('3 小时 15 分后重置');
    expect(formatQuotaResetCountdown(sec + 5 * 3600, now)).toBe('5 小时后重置');
    expect(formatQuotaResetCountdown(sec + 2 * 86400 + 4 * 3600, now)).toBe('2 天 4 小时后重置');

    expect(formatUpdatedAt(now - 20_000, now)).toBe('刚刚更新 · 01:59');
    expect(formatUpdatedAt(now - 3 * 60_000, now)).toBe('3 分钟前 · 01:57');

    expect(quotaUsageTone(0)).toBe('normal');
    expect(quotaUsageTone(69.9)).toBe('normal');
    expect(quotaUsageTone(70)).toBe('warning');
    expect(quotaUsageTone(89.9)).toBe('warning');
    expect(quotaUsageTone(90)).toBe('danger');
    expect(quotaUsageTone(120)).toBe('danger');

    expect(summarizeQuotaTooltip(sampleUsage(78, now))).toBe('Gemini · 5 小时 剩余 22%');
    expect(summarizeQuotaTooltip({ status: 'unavailable', reason: '未登录', windows: [], checkedAt: now })).toBeUndefined();
  });
});

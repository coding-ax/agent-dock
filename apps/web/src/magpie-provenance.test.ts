import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AgentUsage } from './api';
import { TooltipProvider } from './HoverTooltip';
import { UsageSourceBadge } from './UsageSourceBadge';
import { AgentQuotaView } from './AgentUsagePanel';
import {
  formatQuotaRunsOutCountdown,
  loadAgentUsage,
  resolveQuotaTarget,
  summarizeQuotaTooltip,
  type UsageCacheStorage
} from './agent-usage-cache';

const noop = () => undefined;
const now = new Date(2026, 10, 27, 2, 0, 0).getTime();

function renderWithProviders(node: ReturnType<typeof createElement>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(TooltipProvider, null, node)
    )
  );
}

function createMemoryStorage(): UsageCacheStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); }
  };
}

describe('Magpie 来源显式提示（Provenance UI）与四态卡片展示', () => {
  it('UsageSourceBadge 四态区分清晰且绝不使用原生 title', () => {
    const magpieHtml = renderWithProviders(
      createElement(UsageSourceBadge, {
        agentDisplayName: 'Claude Code',
        sourceMeta: {
          service: 'magpie',
          providerId: 'workbuddy',
          providerName: 'WorkBuddy',
          endpoint: 'http://127.0.0.1:3425',
          gatewayVersion: '0.1.4808',
          matchedBy: 'session_model',
          matchedModel: 'workbuddy/deepseek-v4.1-flash',
          accountCount: 3,
          activeAccount: '落***秋'
        }
      })
    );
    expect(magpieHtml).toContain('data-usage-source-badge="magpie"');
    expect(magpieHtml).toContain('来源：Magpie · WorkBuddy');
    expect(magpieHtml).toContain('border-sky-200');
    expect(magpieHtml).not.toContain('title="');

    const unreachableHtml = renderWithProviders(
      createElement(UsageSourceBadge, {
        agentDisplayName: 'Codex',
        sourceMeta: { service: 'magpie', endpoint: 'http://127.0.0.1:3425', matchedBy: 'agent_config' },
        unavailableCode: 'magpie_unreachable'
      })
    );
    expect(unreachableHtml).toContain('data-usage-source-badge="magpie_warn"');
    expect(unreachableHtml).toContain('Magpie · 未连接');
    expect(unreachableHtml).toContain('border-amber-200');

    const authHtml = renderWithProviders(
      createElement(UsageSourceBadge, {
        agentDisplayName: 'Codex',
        sourceMeta: { service: 'magpie', endpoint: 'http://127.0.0.1:3425', matchedBy: 'agent_config' },
        unavailableCode: 'magpie_auth_required'
      })
    );
    expect(authHtml).toContain('data-usage-source-badge="magpie_warn"');
    expect(authHtml).toContain('Magpie · 需授权');

    const officialHtml = renderWithProviders(
      createElement(UsageSourceBadge, {
        agentDisplayName: 'Antigravity',
        sourceMeta: { service: 'official', providerName: 'Antigravity CLI', matchedBy: 'official_direct' }
      })
    );
    expect(officialHtml).toContain('data-usage-source-badge="official"');
    expect(officialHtml).toContain('来源：官方直连');
    expect(officialHtml).not.toContain('Magpie');
  });

  it('AgentQuotaView：Class A 订阅多账号池展示聚合进度条、runsOutAt 预警、账号明细折叠入口与源切换', () => {
    const usage: AgentUsage = {
      status: 'available',
      plan: 'Free plan',
      source: 'Magpie · WorkBuddy',
      sourceMeta: {
        service: 'magpie',
        providerId: 'workbuddy',
        providerName: 'WorkBuddy',
        endpoint: 'http://127.0.0.1:3425',
        matchedBy: 'session_model',
        matchedModel: 'workbuddy/deepseek-v4.1-flash',
        accountCount: 3,
        activeAccount: '落***秋'
      },
      windows: [
        {
          label: 'Total credits',
          usedPercent: 39,
          display: '5,886 / 15,080 credits',
          resetsAt: Math.floor(now / 1000) + 3 * 86400,
          runsOutAt: Math.floor(now / 1000) + 5 * 86400,
          aggregated: true
        }
      ],
      accounts: [
        { label: '暮***歌', plan: 'Free plan', windows: [{ label: 'Total credits', usedPercent: 59 }] },
        { label: '尘*', plan: 'Free plan', windows: [{ label: 'Total credits', usedPercent: 8 }] },
        { label: '落***秋', plan: 'Free plan', active: true, windows: [{ label: 'Total credits', usedPercent: 48 }] }
      ],
      alternateSources: [{ kind: 'official', label: '查看官方直连额度' }],
      checkedAt: now - 60_000,
      cacheTtlMs: 5 * 60_000
    };

    const html = renderWithProviders(
      createElement(AgentQuotaView, {
        agentId: 'claude',
        variant: 'embedded',
        data: usage,
        updatedAt: now - 60_000,
        now,
        onSourceChange: noop,
        onRefresh: noop
      })
    );

    expect(html).toContain('来源：Magpie · WorkBuddy');
    expect(html).toContain('3 账号汇总');
    expect(html).toContain('剩余 61%');
    expect(html).toContain('5,886 / 15,080 credits');
    expect(html).toContain('预计 5 天后耗尽');
    expect(html).toContain('查看 3 个账号明细');
    expect(html).toContain('查看官方');
    expect(html).toContain('由 Magpie 同步 · WorkBuddy');
    expect(html).toContain('自动缓存 5 分钟');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('title="');
  });

  it('AgentQuotaView：Class B 余额型（DeepSeek）、Class C 无额度型（CPA + 今日统计）与未连接态', () => {
    // Class B 余额型
    const balanceUsage: AgentUsage = {
      status: 'available',
      source: 'Magpie · DeepSeek',
      sourceMeta: { service: 'magpie', providerId: 'deepseek', providerName: 'DeepSeek', matchedBy: 'session_model' },
      windows: [],
      balance: { display: '¥256.16', currency: '¥', amount: 256.16 },
      checkedAt: now
    };
    const balanceHtml = renderWithProviders(
      createElement(AgentQuotaView, { agentId: 'codex', variant: 'card', data: balanceUsage, now, onRefresh: noop })
    );
    expect(balanceHtml).toContain('data-quota-balance=""');
    expect(balanceHtml).toContain('账户余额');
    expect(balanceHtml).toContain('¥256.16');
    expect(balanceHtml).toContain('来源：Magpie · DeepSeek');

    // Class C 无上游额度 + 今日网关统计
    const cpaUsage: AgentUsage = {
      status: 'unavailable',
      unavailableCode: 'provider_no_quota',
      reason: '已识别经由 Magpie 的 CPA Singapore 供应商，该供应商未提供上游额度/余额查询。',
      source: 'Magpie · CPA Singapore',
      sourceMeta: { service: 'magpie', providerId: 'cpa', providerName: 'CPA Singapore', matchedBy: 'session_model' },
      windows: [],
      gatewayStats: { period: 'today', calls: 12, errors: 1, totalTokens: 119_500, costUsd: 0.482 },
      checkedAt: now
    };
    const cpaHtml = renderWithProviders(
      createElement(AgentQuotaView, { agentId: 'claude', variant: 'embedded', data: cpaUsage, now, onRefresh: noop })
    );
    expect(cpaHtml).toContain('data-magpie-no-quota=""');
    expect(cpaHtml).toContain('来源：Magpie · CPA Singapore');
    expect(cpaHtml).toContain('Magpie 今日网关统计');
    expect(cpaHtml).toContain('12 次');
    expect(cpaHtml).toContain('120k');
    expect(cpaHtml).toContain('$0.4820');

    // Magpie 未连接
    const downUsage: AgentUsage = {
      status: 'unavailable',
      unavailableCode: 'magpie_unreachable',
      reason: '检测到当前 Agent 代理指向 Magpie，但网关未启动。',
      source: 'Magpie',
      sourceMeta: { service: 'magpie', endpoint: 'http://127.0.0.1:3425', matchedBy: 'agent_config' },
      windows: [],
      checkedAt: now,
      cacheTtlMs: 30_000
    };
    const downHtml = renderWithProviders(
      createElement(AgentQuotaView, { agentId: 'codex', variant: 'embedded', data: downUsage, now, onRefresh: noop })
    );
    expect(downHtml).toContain('data-magpie-issue="magpie_unreachable"');
    expect(downHtml).toContain('Magpie · 未连接');
    expect(downHtml).toContain('重新检测');
    expect(downHtml).toContain('30 秒后可自动重试');
  });

  it('按 (agentId, model, source) 隔离前端 5 分钟缓存，支持额外 Agent 与 Tooltip 摘要', async () => {
    expect(resolveQuotaTarget('omp')).toBe('omp');
    expect(resolveQuotaTarget('opencode')).toBe('opencode');
    expect(resolveQuotaTarget('custom', 'magpie/workbuddy/deepseek-v4.1-flash')).toBe('custom');
    expect(resolveQuotaTarget('gemini', 'gemini-2.5-pro')).toBeUndefined();

    const storage = createMemoryStorage();
    const fetcher = vi.fn(async (_id, _refresh, ctx) => ({
      status: 'available' as const,
      source: `Magpie · ${ctx?.model ?? 'default'}`,
      sourceMeta: { service: 'magpie' as const, providerName: ctx?.model ?? 'default', matchedBy: 'session_model' as const },
      windows: [{ label: 'Total credits', usedPercent: ctx?.model?.includes('workbuddy') ? 39 : 10 }],
      checkedAt: now
    }));

    const wb = await loadAgentUsage('claude', { model: 'workbuddy/deepseek-v4.1-flash[1m]', storage, now: () => now, fetcher });
    const cpa = await loadAgentUsage('claude', { model: 'cpa/claude-opus-5-5[1m]', storage, now: () => now, fetcher });
    // 同是 claude 但模型对应不同 Magpie 供应商，缓存互不串味
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wb.data.windows[0]?.usedPercent).toBe(39);
    expect(cpa.data.windows[0]?.usedPercent).toBe(10);

    // 同一模型再次读取命中前端缓存
    const wbCached = await loadAgentUsage('claude', { model: 'workbuddy/deepseek-v4.1-flash', storage, now: () => now + 60_000, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wbCached.fromCache).toBe(true);

    expect(summarizeQuotaTooltip(wb.data)).toContain('Magpie ·');
    expect(summarizeQuotaTooltip(wb.data)).toContain('剩余 61%');
    expect(summarizeQuotaTooltip({
      status: 'available',
      sourceMeta: { service: 'magpie', providerName: 'DeepSeek', matchedBy: 'session_model' },
      windows: [],
      balance: { display: '¥256.16' },
      checkedAt: now
    })).toBe('Magpie · DeepSeek · 余额 ¥256.16');
    expect(summarizeQuotaTooltip({
      status: 'unavailable',
      unavailableCode: 'provider_no_quota',
      sourceMeta: { service: 'magpie', providerName: 'CPA Singapore', matchedBy: 'session_model' },
      windows: [],
      checkedAt: now
    })).toBe('Magpie · CPA Singapore（无上游额度）');

    const sec = Math.floor(now / 1000);
    expect(formatQuotaRunsOutCountdown(sec - 5, now)).toBe('即将耗尽');
    expect(formatQuotaRunsOutCountdown(sec + 45 * 60, now)).toBe('预计 45 分钟后耗尽');
    expect(formatQuotaRunsOutCountdown(sec + 8 * 3600, now)).toBe('预计 8 小时后耗尽');
    expect(formatQuotaRunsOutCountdown(sec + 5 * 86400, now)).toBe('预计 5 天后耗尽');
  });
});

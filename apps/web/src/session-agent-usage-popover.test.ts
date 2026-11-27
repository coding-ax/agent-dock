import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AgentUsage, SessionUsageDetail } from './api';
import { TooltipProvider } from './HoverTooltip';
import { AgentQuotaView } from './AgentUsagePanel';
import { SessionAgentUsagePopover, SessionUsagePopoverBody } from './SessionAgentUsagePopover';

const noop = () => undefined;

const now = new Date(2026, 10, 27, 2, 0, 0).getTime();

const sampleQuota: AgentUsage = {
  status: 'available',
  plan: 'Max',
  source: 'Antigravity CLI',
  checkedAt: now - 2 * 60_000,
  windows: [
    { label: 'Gemini · 5 小时', usedPercent: 32, resetsAt: Math.floor(now / 1000) + 3 * 3600 + 25 * 60 },
    { label: 'Claude / GPT · 7 天', usedPercent: 86, resetsAt: Math.floor(now / 1000) + 2 * 86400 + 5 * 3600 }
  ]
};

const sampleSessionUsage: SessionUsageDetail = {
  sessionId: 'ses_demo',
  agentId: 'antigravity',
  totals: {
    inputTokens: 48_000,
    outputTokens: 12_500,
    cacheReadTokens: 32_000,
    cacheWriteTokens: 0,
    thoughtTokens: 4_200,
    totalTokens: 96_700,
    costUsd: 0.342,
    turnCount: 6,
    sessionCount: 1,
    totalGenerationMs: 282_000,
    totalDurationMs: 310_000,
    avgTps: 44.2,
    lastTps: 51.8
  },
  turns: []
};

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

describe('顶栏 Agent「Token 用量 + 账号额度」聚合面板与设置额度卡片', () => {
  it('AgentQuotaView（设置卡片 & 顶栏嵌入）统一采用卡片 + 细进度条 + 重置倒计时 + 5 分钟缓存，彻底无丑表格', () => {
    for (const variant of ['card', 'embedded'] as const) {
      const html = renderWithProviders(
        createElement(AgentQuotaView, {
          agentId: 'antigravity',
          variant,
          data: sampleQuota,
          updatedAt: now - 2 * 60_000,
          now,
          onRefresh: noop
        })
      );

      expect(html).not.toContain('<table');
      expect(html).not.toContain('<thead');
      expect(html).not.toContain('<tr');
      expect(html).not.toContain('title="');
      expect(html).toContain('Max');
      expect(html).toContain('Gemini · 5 小时');
      expect(html).toContain('剩余 68%');
      expect(html).toContain('已用 32%');
      expect(html).toContain('3 小时 25 分后重置');
      expect(html).toContain('Claude / GPT · 7 天');
      expect(html).toContain('剩余 14%');
      expect(html).toContain('bg-amber-500');
      expect(html).toContain('2 天 5 小时后重置');
      expect(html).toContain('2 分钟前 · 01:58');
      expect(html).toContain('自动缓存 5 分钟');
      expect(html).toContain('aria-label="刷新 Antigravity 额度"');
    }
  });

  it('支持额度查询的 Agent：弹出小面板清晰分层展示本会话上下文/Token 与账号额度', () => {
    const html = renderWithProviders(
      createElement(SessionUsagePopoverBody, {
        agentId: 'antigravity',
        agentName: 'Google Antigravity',
        currentModel: 'gemini-4-neon',
        context: { used: 180_000, size: 1_000_000, compacted: 42_000, percentage: 18 },
        sessionUsage: sampleSessionUsage,
        quotaAgentId: 'antigravity',
        quotaSlot: createElement(AgentQuotaView, {
          agentId: 'antigravity',
          variant: 'embedded',
          data: sampleQuota,
          updatedAt: now - 2 * 60_000,
          now,
          onRefresh: noop
        }),
        onOpenDashboard: noop
      })
    );

    expect(html).not.toContain('<table');
    expect(html).toContain('Google Antigravity');
    expect(html).toContain('gemini-4-neon');
    // 第一层：本会话 Token / 上下文
    expect(html).toContain('本会话用量');
    expect(html).toContain('6 轮统计');
    expect(html).toContain('上下文窗口');
    expect(html).toContain('180k / 1.0m · 18%');
    expect(html).toContain('已累计压缩回收 42k tokens');
    expect(html).toContain('累计 Token');
    expect(html).toContain('97k');
    expect(html).toContain('$0.3420');
    expect(html).toContain('51.8 t/s');
    // 第二层：账号额度
    expect(html).toContain('账号额度');
    expect(html).toContain('剩余 68%');
    expect(html).toContain('消耗看板');
  });

  it('不支持额度查询的 Agent：仍优雅呈现本会话 Token 用量，不留空也不渲染突兀额度块', () => {
    const html = renderWithProviders(
      createElement(SessionUsagePopoverBody, {
        agentId: 'gemini',
        agentName: 'Gemini CLI',
        currentModel: 'gemini-2.5-pro',
        context: { used: 35_000, size: 200_000, percentage: 17.5 },
        sessionUsage: sampleSessionUsage,
        quotaAgentId: undefined,
        onOpenDashboard: noop
      })
    );

    expect(html).toContain('Gemini CLI');
    expect(html).toContain('本会话用量');
    expect(html).toContain('上下文窗口');
    expect(html).toContain('累计 Token');
    expect(html).toContain('当前 Agent 暂不支持账号额度查询');
    expect(html).toContain('消耗看板');
    expect(html).not.toContain('自动缓存 5 分钟');
  });

  it('顶栏轻巧触发入口展示 Agent 图标、名称、紧凑上下文环/Token 与无障碍 dialog 属性', () => {
    const html = renderWithProviders(
      createElement(SessionAgentUsagePopover, {
        sessionId: 'ses_demo',
        agentId: 'codex',
        agentName: 'Codex',
        currentModel: 'gpt-5',
        context: { used: 50_000, size: 200_000, percentage: 25 },
        sessionUsage: sampleSessionUsage
      })
    );

    expect(html).toContain('data-agent-usage-trigger=""');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Codex');
    expect(html).toContain('97k');
    expect(html).toContain('<svg width="12" height="12"');
    expect(html).not.toContain('title="');
  });
});

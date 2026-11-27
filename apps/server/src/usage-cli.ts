import type { SessionUsageDetail, UsageBreakdown, UsageBreakdownGroup, UsageSummary } from '@agent-dock/agent-dock-shared';
import { callDaemon, requireDaemon, sourceSessionId } from './session-cli.js';

export interface UsageFilterCliOptions {
  from?: string;
  to?: string;
  agent?: string;
  project?: string;
  session?: string;
  model?: string;
  json?: boolean;
  /** 测试时指定独立 daemon 目录；CLI 不暴露。 */
  daemonDir?: string;
}

export interface UsageBreakdownCliOptions extends UsageFilterCliOptions {
  by?: string;
  limit?: string;
}

export interface UsageSessionCliOptions {
  json?: boolean;
  daemonDir?: string;
}

export interface UsageQuotaCliOptions {
  refresh?: boolean;
  json?: boolean;
  daemonDir?: string;
}

function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 支持快捷时间参数：today / 7d / 30d / YYYY-MM-DD / ISO 时间。 */
export function resolveUsageFromOption(raw: string | undefined, now = new Date()): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === 'today') return localDateString(now);
  const rel = /^(\d+)d$/.exec(lower);
  if (rel) {
    const days = Math.max(1, Number(rel[1]));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    return localDateString(start);
  }
  return trimmed;
}

function buildUsageSearchParams(options: UsageFilterCliOptions, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  const from = resolveUsageFromOption(options.from);
  if (from) params.set('from', from);
  if (options.to?.trim()) params.set('to', options.to.trim());
  if (options.agent?.trim()) params.set('agentId', options.agent.trim());
  if (options.project?.trim()) params.set('project', options.project.trim());
  if (options.session?.trim()) params.set('sessionId', options.session.trim());
  if (options.model?.trim()) params.set('model', options.model.trim());
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value?.trim()) params.set(key, value.trim());
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtTps(tps: number | null | undefined): string {
  return tps !== null && tps !== undefined ? `${tps.toFixed(1)} tok/s` : '—';
}

function fmtCost(costUsd: number | null | undefined): string {
  if (!costUsd || costUsd <= 0) return '—';
  return `$${costUsd.toFixed(costUsd >= 1 ? 2 : 4)}`;
}

export async function runUsageSummary(options: UsageFilterCliOptions = {}): Promise<string> {
  const state = requireDaemon(options.daemonDir);
  const qs = buildUsageSearchParams(options);
  const data = await callDaemon<UsageSummary>(state, `/api/usage/summary${qs}`, 'GET');
  if (options.json) return `${JSON.stringify(data, null, 2)}\n`;
  const t = data.totals;
  const lines = [
    `总消耗: ${fmtTokens(t.totalTokens)} tokens（输入 ${fmtTokens(t.inputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens)} · 输出 ${fmtTokens(t.outputTokens)}${t.thoughtTokens > 0 ? ` · 思考 ${fmtTokens(t.thoughtTokens)}` : ''}）`,
    `速度/费用: 平均 ${fmtTps(t.avgTps)} · 费用 ${fmtCost(t.costUsd)} · ${t.turnCount} 轮 / ${t.sessionCount} 个会话`
  ];
  if (data.daily.length) {
    lines.push('按日明细:');
    for (const day of data.daily) {
      lines.push(`  ${day.date}  ${fmtTokens(day.totalTokens)} tok  (${day.turnCount} 轮 · ${fmtTps(day.avgTps)}${day.costUsd > 0 ? ` · ${fmtCost(day.costUsd)}` : ''})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runUsageBreakdown(options: UsageBreakdownCliOptions = {}): Promise<string> {
  const by = (options.by?.trim() || 'project') as UsageBreakdownGroup;
  if (!['project', 'agent', 'session', 'model'].includes(by)) {
    throw new Error('--by 必须是 project、agent、session 或 model。');
  }
  const state = requireDaemon(options.daemonDir);
  const qs = buildUsageSearchParams(options, { groupBy: by, limit: options.limit });
  const data = await callDaemon<UsageBreakdown>(state, `/api/usage/breakdown${qs}`, 'GET');
  if (options.json) return `${JSON.stringify(data, null, 2)}\n`;
  if (!data.items.length) return '当前筛选范围内没有真实消耗记录。\n';
  const lines = data.items.map((item, idx) => {
    const t = item.totals;
    return `${idx + 1}. ${item.label}${item.sublabel && item.sublabel !== item.label ? ` (${item.sublabel})` : ''}\n   ${fmtTokens(t.totalTokens)} tok（输入 ${fmtTokens(t.inputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens)} · 输出 ${fmtTokens(t.outputTokens)}）· ${fmtTps(t.avgTps)} · ${t.turnCount} 轮${t.costUsd > 0 ? ` · ${fmtCost(t.costUsd)}` : ''}`;
  });
  return `${lines.join('\n')}\n`;
}

export async function runUsageSession(sessionId?: string, options: UsageSessionCliOptions = {}): Promise<string> {
  const targetId = sessionId?.trim() || sourceSessionId(undefined);
  const state = requireDaemon(options.daemonDir);
  const data = await callDaemon<SessionUsageDetail>(state, `/api/sessions/${encodeURIComponent(targetId)}/usage`, 'GET');
  if (options.json) return `${JSON.stringify(data, null, 2)}\n`;
  const t = data.totals;
  const lines = [
    `会话 ${data.sessionId}${data.agentId ? ` (${data.agentId})` : ''}`,
    `累计消耗: ${fmtTokens(t.totalTokens)} tokens（输入 ${fmtTokens(t.inputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens)} · 输出 ${fmtTokens(t.outputTokens)}${t.thoughtTokens > 0 ? ` · 思考 ${fmtTokens(t.thoughtTokens)}` : ''}）`,
    `速度/费用: 最近 ${fmtTps(t.lastTps)} · 平均 ${fmtTps(t.avgTps)} · 费用 ${fmtCost(t.costUsd)} · ${t.turnCount} 轮`
  ];
  return `${lines.join('\n')}\n`;
}

interface QuotaProviderEntry {
  id: string;
  name: string;
  usage: {
    status: 'available' | 'unavailable';
    plan?: string;
    reason?: string;
    source?: string;
    windows: Array<{ label: string; usedPercent: number; resetsAt?: number }>;
    checkedAt: number;
  };
}

function fmtResetCountdown(resetsAt?: number): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return '';
  const diffMin = Math.ceil((resetsAt * 1000 - Date.now()) / 60_000);
  if (diffMin <= 0) return '即将重置';
  if (diffMin < 60) return `${diffMin}m 后重置`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return h < 24 ? `${h}h${m ? `${m}m` : ''} 后重置` : `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''} 后重置`;
}

export async function runUsageQuota(agent?: string, options: UsageQuotaCliOptions = {}): Promise<string> {
  const params = new URLSearchParams();
  if (agent?.trim()) params.set('agent', agent.trim());
  if (options.refresh) params.set('refresh', '1');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const data = await callDaemon<{ checkedAt: number; providers: QuotaProviderEntry[] }>(
    requireDaemon(options.daemonDir),
    `/api/usage/quotas${qs}`,
    'GET'
  );
  if (options.json) return `${JSON.stringify({ ok: true, ...data }, null, 2)}\n`;
  const lines: string[] = [];
  for (const entry of data.providers) {
    const u = entry.usage;
    const plan = u.plan ? ` (${u.plan})` : '';
    if (u.status !== 'available' || !u.windows.length) {
      lines.push(`○ ${entry.name}${plan}：暂不可用${u.reason ? ` — ${u.reason}` : ''}`);
      continue;
    }
    lines.push(`● ${entry.name}${plan}${u.source ? ` [${u.source}]` : ''}`);
    for (const w of u.windows) {
      const remaining = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
      const filled = Math.round((w.usedPercent / 100) * 12);
      const bar = '█'.repeat(Math.max(0, Math.min(12, filled))) + '░'.repeat(Math.max(0, 12 - filled));
      const reset = fmtResetCountdown(w.resetsAt);
      lines.push(`    ${w.label.padEnd(18, ' ')} [${bar}] 剩余 ${remaining}%${reset ? ` · ${reset}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
